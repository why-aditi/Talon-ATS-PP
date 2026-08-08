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
  permissions_boundary = aws_iam_policy.permissions_boundary.arn
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
  # ReadOnlyAccess includes s3:GetObject on every bucket in the account, which
  # would let a pull-request workflow — code nobody has merged — print candidate
  # resumes (§9.10) into a CI log.
  #
  # This is an allow-list expressed as a Deny, and the inversion is the point.
  # The previous version named the three application buckets and denied those,
  # which meant every bucket added afterwards was readable until someone
  # remembered to extend the list. The quarantine bucket from §9.10 was already
  # missing, so an UNSCANNED resume was readable by CI. Deny everything, except
  # the one prefix `terraform plan` genuinely needs an object body from — the
  # state file. A new bucket is now denied by default and a reviewer has to add
  # it here deliberately.
  #
  # NotResource, so the exception is exact: it is the state bucket's objects, not
  # the state bucket's name as a prefix of some other bucket.
  statement {
    sid    = "DenyReadingObjectBodiesExceptTerraformState"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:GetObjectTorrent",
    ]
    not_resources = [
      "${local.state_bucket_arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "github_plan_guardrails" {
  name   = "${local.name}-github-plan-guardrails"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_guardrails.json
}
