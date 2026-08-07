locals {
  # talon-dev-*  — §9.5. Every name in this stack is built from this and nothing
  # else, so a prefix-scoped IAM grant is satisfied by changing one variable.
  name = "${var.name_prefix}-${var.env}"

  tags = merge(
    {
      Project   = "talon"
      Env       = var.env
      ManagedBy = "terraform"
      Stack     = "iam"
    },
    var.tags,
  )

  partition  = data.aws_partition.current.partition
  account_id = data.aws_caller_identity.current.account_id

  # The permissions boundary (permissions_boundary.tf). Its ARN is written out
  # by hand rather than read from the resource because the boundary document has
  # to name itself — a policy that forbids its own modification cannot reference
  # `aws_iam_policy.permissions_boundary.arn` without a self-referential cycle.
  # The name is deterministic, so the constructed ARN is exact, and it has the
  # side benefit of rendering as a literal string in `terraform plan` instead of
  # "(known after apply)".
  permissions_boundary_name = "${local.name}-permissions-boundary"
  permissions_boundary_arn  = "arn:${local.partition}:iam::${local.account_id}:policy/${local.name}-permissions-boundary"

  oidc_provider_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn

  # The OIDC issuer host, used verbatim as the condition-key namespace. AWS
  # derives the condition key prefix from the provider URL, so this string is
  # load-bearing in two places and is written once here.
  oidc_host = "token.actions.githubusercontent.com"

  # -------------------------------------------------------------------------
  # Subject claims — the decision recorded in docs/specs/002-infrastructure.md.
  #
  # Rejected: a single role trusted on `repo:OWNER/REPO:*`. That is one role for
  # both jobs, and it means any workflow on any branch of a PR — including a
  # branch a first-time contributor pushed — can run `terraform apply`. The
  # wildcard is only tempting because plan and apply have different ref shapes;
  # splitting the roles removes the reason to want it.
  #
  # Also rejected, and this one read as safe: `repo:OWNER/REPO:environment:*` on
  # the deploy role. GitHub does NOT append the environment to the `sub` claim —
  # it *replaces* the `ref:` segment with it. So the entry was not an extra
  # condition on top of the branch pin, it was an alternative to it. And an
  # environment named by a workflow for the first time is auto-created with no
  # protection rules, so any branch could mint a matching claim by declaring
  # `environment: whatever`. This repository has zero environments configured,
  # so the entry protected nothing and bypassed everything.
  #
  # Chosen: two roles, two subject sets, and no wildcard in either.
  #   plan  (read-only) : pull_request + the default branch, because §9.5 runs a
  #                       plan on every PR and PR-triggered jobs present
  #                       `repo:OWNER/REPO:pull_request`, never a ref: claim.
  #   apply (power)     : the default branch, and nothing else.
  #
  # A literal environment can be added later through
  # var.github_deploy_subject_claims — the validation there rejects wildcards —
  # but only once that environment has a deployment-branch policy configured in
  # GitHub. Without one, adding it re-opens exactly the hole described above.
  # -------------------------------------------------------------------------
  deploy_subject_claims = length(var.github_deploy_subject_claims) > 0 ? var.github_deploy_subject_claims : [
    "repo:${var.github_repo}:ref:refs/heads/${var.github_default_branch}",
  ]

  plan_subject_claims = length(var.github_plan_subject_claims) > 0 ? var.github_plan_subject_claims : [
    "repo:${var.github_repo}:pull_request",
    "repo:${var.github_repo}:ref:refs/heads/${var.github_default_branch}",
  ]

  state_bucket_name     = var.state_bucket_name != "" ? var.state_bucket_name : "${var.name_prefix}-tfstate-${local.account_id}"
  state_lock_table_name = var.state_lock_table_name != "" ? var.state_lock_table_name : "${var.name_prefix}-tfstate-lock"

  state_bucket_arn = "arn:${local.partition}:s3:::${local.state_bucket_name}"
  state_lock_arn   = "arn:${local.partition}:dynamodb:${var.aws_region}:${local.account_id}:table/${local.state_lock_table_name}"

  # us-east-1 is always allowed: Budgets, CloudFront and the WAF web ACL that
  # fronts it are only addressable there (§9.4, §9.6).
  allowed_regions = distinct([var.aws_region, "us-east-1"])

  data_bucket_arns = [
    for suffix in var.data_bucket_suffixes :
    "arn:${local.partition}:s3:::${local.name}-${suffix}"
  ]

  data_bucket_object_arns = [
    for suffix in var.data_bucket_suffixes :
    "arn:${local.partition}:s3:::${local.name}-${suffix}/*"
  ]
}
