# ---------------------------------------------------------------------------
# The plan role. Assumed by the PR job that posts `terraform plan` as a comment
# (ARCHITECTURE §9.5). It exists so that the apply role never has to trust a
# pull-request subject claim — which is what forces the `repo:OWNER/REPO:*`
# wildcard when there is only one role.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "github_plan" {
  name                 = "${local.name}-github-plan"
  description          = "GitHub Actions terraform plan (read-only) role for ${local.name}. Trusted only from ${var.github_repo}."
  assume_role_policy   = data.aws_iam_policy_document.github_plan_trust.json
  max_session_duration = 3600
}

# `terraform plan` refreshes every resource in the graph, so it needs Describe/
# Get across the same service surface the apply role writes to. ReadOnlyAccess
# is exactly that and nothing more — no create, no delete, no state mutation.
resource "aws_iam_role_policy_attachment" "github_plan_read_only" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/ReadOnlyAccess"
}

data "aws_iam_policy_document" "github_plan_state" {
  statement {
    sid    = "AcquireStateLock"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
    ]
    # The only write this role gets, and only to the lock table. `plan` takes a
    # state lock by default; running the PR job with -lock=false instead would
    # let a plan read state while a merge apply is writing it.
    resources = [local.state_lock_arn]
  }
}

resource "aws_iam_role_policy" "github_plan_state" {
  name   = "${local.name}-github-plan-state"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_state.json
}

data "aws_iam_policy_document" "github_plan_guardrails" {
  statement {
    sid    = "DenyReadingCandidateData"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    # ReadOnlyAccess includes s3:GetObject on every bucket in the account, which
    # would let a workflow run read candidate resumes and exports (§9.10) out of
    # a CI log. `terraform plan` never needs an object body from these buckets;
    # it needs bucket metadata, which this does not touch.
    resources = local.data_bucket_object_arns
  }
}

resource "aws_iam_role_policy" "github_plan_guardrails" {
  name   = "${local.name}-github-plan-guardrails"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_guardrails.json
}
