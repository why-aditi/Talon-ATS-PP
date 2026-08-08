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

  # Three sources, in order: an ARN handed in, the provider this stack created,
  # or the one already in the account. The last is the normal case and is READ
  # rather than constructed — the ARN is derivable (fixed URL, so
  # `oidc-provider/${local.oidc_host}` under this account), but a constructed
  # ARN for a provider that does not exist is accepted by Terraform and rejected
  # by IAM later, while the data source says "no matching provider" at plan time.
  oidc_provider_arn = coalesce(
    var.github_oidc_provider_arn,
    one(aws_iam_openid_connect_provider.github[*].arn),
    one(data.aws_iam_openid_connect_provider.github[*].arn),
  )

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
  # -------------------------------------------------------------------------
  # The ID-QUALIFIED subject prefix, and why both forms are trusted.
  #
  # `repo:OWNER/REPO` is the documented sub prefix and it is NOT what every
  # repository issues. GitHub can issue an immutable, id-qualified prefix
  # instead — `repo:OWNER@<owner_id>/REPO@<repo_id>` — and this repository does:
  #
  #   GET /repos/why-aditi/Talon-ATS-PP/actions/oidc/customization/sub
  #   { "use_default": true,
  #     "sub_claim_prefix": "repo:why-aditi@130339327/Talon-ATS-PP@1326442505" }
  #
  # Note `use_default` is TRUE while the prefix is still id-qualified, so there
  # is nothing to "turn off" and no customization to notice. A trust policy
  # holding only the plain form is silently unmatchable, and the failure gives
  # you nothing to work with: STS answers `Not authorized to perform
  # sts:AssumeRoleWithWebIdentity` without ever saying which claim missed.
  # That cost a red CI run on the first PR after the roles were applied.
  #
  # BOTH forms are trusted, deliberately. The ids are stable for the life of the
  # repository, but a transfer changes the owner id and a delete-and-recreate
  # changes the repo id — and if GitHub ever serves the plain prefix, the plain
  # entry is what keeps CI working. Neither entry widens the other: both are
  # exact strings, no wildcard, and the `:pull_request` / `:ref:` suffixes stay
  # exactly as reasoned above.
  #
  # The ids come from the workflow context (`github.repository_owner_id`,
  # `github.repository_id`), so a fork gets its own without editing this file.
  # The defaults are this repository's, so a human-run plan matches CI's.
  # -------------------------------------------------------------------------
  sub_prefixes = compact([
    "repo:${var.github_repo}",
    var.github_owner_id != "" && var.github_repository_id != "" ? format(
      "repo:%s@%s/%s@%s",
      split("/", var.github_repo)[0], var.github_owner_id,
      split("/", var.github_repo)[1], var.github_repository_id,
    ) : "",
  ])

  deploy_subject_claims = length(var.github_deploy_subject_claims) > 0 ? var.github_deploy_subject_claims : [
    for prefix in local.sub_prefixes : "${prefix}:ref:refs/heads/${var.github_default_branch}"
  ]

  plan_subject_claims = length(var.github_plan_subject_claims) > 0 ? var.github_plan_subject_claims : flatten([
    for prefix in local.sub_prefixes : [
      "${prefix}:pull_request",
      "${prefix}:ref:refs/heads/${var.github_default_branch}",
    ]
  ])

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

  # -------------------------------------------------------------------------
  # Guardrail vocabulary, written ONCE and referenced from both the deploy
  # role's identity policy and the permissions boundary.
  #
  # WHY THIS EXISTS. The boundary's job is to be a mirror of the deploy role's
  # guardrails, so that a role the deploy role creates cannot do what the deploy
  # role itself is denied. The first version of it mirrored two statements out of
  # six by hand-copying them, and the four that were not copied were not visible
  # as missing — there was nothing to diff against. A child role created under the
  # boundary with an inline `*:*` could therefore rewrite the deploy role's own
  # trust policy, delete the Cognito pool, delete the state lock table, pass the
  # ECS task role to EC2, and run instances in an unwatched region: three API
  # calls instead of one, and §4.3's "the `sub` condition is the whole security
  # boundary" was still advisory.
  #
  # Hand-copying is the bug. A shared local is not a style preference here — it is
  # the only shape in which "the boundary mirrors the guardrails" is a property of
  # the code rather than a claim in a comment. Adding a service to
  # pass_role_services, or an action to stateful_delete_actions, now lands in both
  # documents or in neither.
  # -------------------------------------------------------------------------

  ci_role_arn_pattern = "arn:${local.partition}:iam::${local.account_id}:role/${local.name}-github-*"

  # Every IAM action that can change what a role is, what it trusts, or who may
  # wear it. Applied to `role/${local.name}-github-*` in two places.
  #
  # iam:PassRole is in the list and it is not decoration: iam:AddRoleToInstanceProfile
  # is authorized against the INSTANCE PROFILE's ARN, not the role's, so a
  # resource-scoped deny on role ARNs cannot see it. Adding the deploy role to a
  # profile therefore stays possible; launching an instance that wears it does not.
  #
  # iam:CreateRole is in the list so the `-github-` namespace is actually reserved
  # rather than merely uncreatable-and-then-unusable. Squatting the name is inert
  # today — the squatter cannot then attach a policy to it — but §4.8 reads as
  # though the namespace is reserved, and a name that can be taken by a CI run is a
  # name a later human apply collides with.
  #
  # iam:UpdateRole matters for a reason that is easy to miss: it sets
  # MaxSessionDuration. Without the deny, a CI run can raise its own session
  # lifetime from one hour to twelve. iam:TagRole/UntagRole matter the moment any
  # policy in the account conditions on a tag.
  ci_role_write_actions = [
    "iam:CreateRole",
    "iam:DeleteRole",
    "iam:UpdateRole",
    "iam:UpdateRoleDescription",
    "iam:UpdateAssumeRolePolicy",
    "iam:TagRole",
    "iam:UntagRole",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PassRole",
  ]

  # The services this architecture actually hands a role to (§9.1, §9.2, and
  # §9.6's NAT instance). An apply failing with AccessDenied on PassRole means a
  # service is missing here: add it, in the same PR, and both documents move.
  pass_role_services = [
    "ecs-tasks.amazonaws.com",
    "ecs.amazonaws.com",
    "lambda.amazonaws.com",
    "ec2.amazonaws.com",
    "events.amazonaws.com",
    "scheduler.amazonaws.com",
    "application-autoscaling.amazonaws.com",
    "monitoring.rds.amazonaws.com",
    "vpc-flow-logs.amazonaws.com",
  ]

  # THE ONE SERVICE THE LIST ABOVE CANNOT SAFELY SCOPE ON ITS OWN.
  #
  # role_github_deploy.tf's comment says iam:PassedToService stops the deploy role
  # "handing the ECS task role to a service that was never meant to hold it — an
  # EC2 instance it controls, say — and reading every application secret from a
  # shell." That was measurably untrue: `ec2.amazonaws.com` is IN the list,
  # because §9.6's dev cost profile replaces the NAT Gateway with a t4g.nano NAT
  # instance and that instance needs an instance profile. Simulated on the deploy
  # role before this local existed, `iam:PassRole talon-dev-ecs-task` with
  # `iam:PassedToService = ec2.amazonaws.com` returned **allowed**.
  #
  # EC2 is the only entry on the list that turns a passed role into an interactive
  # shell, so it is the only one where the destination ROLE has to be pinned as
  # well as the destination SERVICE. Everything else in this stack is a trust
  # policy away from being unusable anyway; EC2 is the one where the gap is worth
  # a statement rather than a note.
  #
  # NAMING CONTRACT for stacks/ephemeral: the NAT instance's role must be named
  # `${local.name}-ec2-*`, e.g. `talon-dev-ec2-nat`. Anything else fails with
  # AccessDenied on PassRole at apply time, which is the loud failure — the quiet
  # one is the version of this file without the pin.
  ec2_pass_role_arn_pattern = "arn:${local.partition}:iam::${local.account_id}:role/${local.name}-ec2-*"

  # §4.9: destroyable by the human running down.sh --all, not by an automated
  # apply and not by anything an automated apply can create.
  #
  # The two CLIENT-level Cognito deletes are here for the reason check-plan.py
  # already covers `aws_cognito_user_pool_client` by its prefix rule: deleting
  # the app client mints nothing back, and every running API instance's
  # COGNITO_CLIENT_ID stops resolving. Both were measured `allowed` for the
  # deploy role AND for a boundary-carrying child while only the plan route was
  # gated — the CLI route to the same outage was wide open.
  # DeleteUserPoolDomain is the same shape one level up: it takes
  # /oauth2/authorize and /oauth2/token away from every tenant at once.
  #
  # NOT here, deliberately: cognito-idp:AdminDeleteUser. The ECS task role needs
  # it for offboarding, the boundary binds that role too, and a deny would break
  # the feature rather than protect anything stateful — the same mistake as
  # denying rds:DeleteDBInstance (see the comment in role_github_deploy.tf).
  stateful_delete_actions = [
    "cognito-idp:DeleteUserPool",
    "cognito-idp:DeleteUserPoolClient",
    "cognito-idp:DeleteUserPoolDomain",
    "rds:DeleteDBCluster",
  ]

  account_org_actions = [
    "organizations:*",
    "controltower:*",
    "account:CloseAccount",
    "account:PutAlternateContact",
  ]

  # §9.5: the state bucket is bootstrapped once and never destroyed, and its
  # versioning IS the recovery path for a corrupted state file.
  #
  # Which is why the list cannot stop at "can you delete the bucket, and can you
  # switch versioning off". Two actions destroy that recovery path without
  # touching either, and both were measured `allowed` on the state bucket for the
  # deploy role and for a boundary-carrying child:
  #
  #   s3:PutLifecycleConfiguration — one rule expiring noncurrent versions after
  #     N days deletes every historical state file on S3's schedule. Versioning
  #     stays "Enabled" the whole time, so the guard that names it still reads as
  #     satisfied and nothing is denied at the moment the history goes.
  #   s3:PutBucketPolicy — a resource policy Deny is evaluated before any
  #     identity policy, so the bucket can be made unreadable to the very roles
  #     that need it (or readable to a principal outside the account) without a
  #     single denied API call.
  #
  # The state bucket is created once by §9.5a stage 1 and never reconfigured by
  # an apply, so denying these costs nothing an automated run legitimately does.
  state_bucket_protection_actions = [
    "s3:DeleteBucket",
    "s3:PutBucketVersioning",
    "s3:DeleteObjectVersion",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketPolicy",
  ]

  state_lock_protection_actions = [
    "dynamodb:DeleteTable",
    "dynamodb:DeleteBackup",
  ]

  # Global and global-endpoint services, excluded from the region restriction
  # because they either ignore aws:RequestedRegion or are only addressable from
  # us-east-1. If an apply fails with AccessDenied on a service that belongs on
  # this list, add it here rather than disabling the guard.
  region_exempt_actions = [
    "iam:*",
    "sts:*",
    "organizations:*",
    "account:*",
    "cloudfront:*",
    "route53:*",
    "route53domains:*",
    "acm:*",
    "waf:*",
    "wafv2:*",
    "shield:*",
    "budgets:*",
    "ce:*",
    "cur:*",
    "pricing:*",
    "support:*",
    "trustedadvisor:*",
    "health:*",
    "globalaccelerator:*",
    "ecr-public:*",
    "s3:ListAllMyBuckets",
    "s3:GetAccountPublicAccessBlock",
    "s3:PutAccountPublicAccessBlock",
  ]
}
