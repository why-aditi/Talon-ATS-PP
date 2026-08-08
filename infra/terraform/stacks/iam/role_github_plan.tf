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

  # AWS's ReadOnlyAccess deliberately excludes secretsmanager:GetSecretValue —
  # reading a secret's METADATA and reading its VALUE are separate powers, and
  # that separation is correct. This adds the value read back for exactly one
  # path and no more.
  #
  # It is needed because stacks/persistent reads the Google OAuth credentials
  # through `data.aws_secretsmanager_secret_version` to configure the Cognito
  # identity provider, and a data source is read during PLAN. Without this the
  # persistent plan fails on every PR with AccessDeniedException, and the fix is
  # not to stop managing the IdP: unmanaged, it drifts and nothing checks it.
  #
  # Scoped to `<name>/sso/*`, NOT `<name>/*`. The ECS task roles read
  # `<name>/*` because they legitimately need the database URL and the JWT
  # signing key at runtime. A pull-request plan needs neither, and this role is
  # assumable by any branch pushed to this repository.
  #
  # On the plan comment: `secret_string` is marked sensitive by the AWS provider
  # and Terraform propagates that mark through `jsondecode`, so the client secret
  # renders as `(sensitive value)` rather than in cleartext. That is a property of
  # Terraform's output, not a guarantee about the role — anything this role can
  # read, a workflow step in an unmerged PR can also print. That is the reason for
  # the narrow scope rather than a broader one.
  statement {
    sid       = "ReadFederationSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.name}/sso/*"]
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

  # Object BODIES were denied above; object NAMES were not, and for candidate
  # files the name is most of the disclosure. Resumes land in the quarantine
  # bucket (§9.10) under keys that are routinely
  # `firstname-lastname-resume.pdf`, so `aws s3 ls` from a pull-request workflow
  # reads out a list of who has applied to this company — without ever fetching
  # a byte the statement above covers.
  #
  # Same inversion, same reason: deny bucket listing everywhere, except the state
  # bucket, which the S3 backend genuinely lists to find the state object. The
  # exception is the BUCKET ARN, not `${bucket}/*` — ListBucket is authorized
  # against the bucket, and an exception written with a trailing `/*` would match
  # nothing and take state reads down with it.
  #
  # s3:ListAllMyBuckets is deliberately not here: it returns bucket names only,
  # `terraform plan` uses it, and bucket names in this account are already public
  # knowledge from every other policy document in this stack.
  statement {
    sid    = "DenyListingBucketContentsExceptTerraformState"
    effect = "Deny"
    actions = [
      "s3:ListBucket",
      "s3:ListBucketVersions",
      "s3:ListBucketMultipartUploads",
    ]
    not_resources = [
      local.state_bucket_arn,
    ]
  }
}

resource "aws_iam_role_policy" "github_plan_guardrails" {
  name   = "${local.name}-github-plan-guardrails"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_guardrails.json
}
