# ---------------------------------------------------------------------------
# The apply role. Assumed by GitHub Actions on merge to the default branch
# (ARCHITECTURE §9.5) to run `terraform apply` over stacks/iam, persistent and
# ephemeral.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.name}-github-deploy"
  description          = "GitHub Actions terraform apply role for ${local.name}. Trusted only from ${var.github_repo}."
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_trust.json
  max_session_duration = var.deploy_role_max_session_seconds
}

# Broad on purpose, and this is the honest reason: this role runs
# `terraform apply` over the whole architecture — VPC, NAT, RDS, ElastiCache,
# ECS, ALB, CloudFront, WAF, S3, ECR, KMS, SQS, EventBridge, SES, Lambda,
# CloudWatch, Budgets. An enumerated allow-list for that surface is a policy
# larger than the stacks it protects, it drifts every time a resource is added,
# and it fails as a mid-apply AccessDenied that leaves half a stack standing.
# PowerUserAccess is the same shape as the human deploy identity described in
# §9.5, so CI cannot do anything the operator running scripts/up.sh cannot.
# What it deliberately is NOT is AdministratorAccess: PowerUserAccess excludes
# iam:*, organizations:* and account:*, and the IAM the stacks actually need is
# added back below, name-scoped.
resource "aws_iam_role_policy_attachment" "github_deploy_power_user" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/PowerUserAccess"
}

# ---------------------------------------------------------------------------
# The IAM addendum — §9.5's granted list, narrowed to this project's names.
#
# Inline rather than a customer-managed policy on purpose: an inline policy has
# no ARN of its own, so it does not need a second name-prefix surface to satisfy
# a prefix-scoped iam:CreatePolicy grant, and it cannot be attached to some
# other principal later.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy_iam_addendum" {
  statement {
    sid    = "ManageProjectRoles"
    effect = "Allow"
    actions = [
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
      "iam:PassRole",
    ]
    # Name-scoped, both because §9.5 warns the company grant may itself be
    # prefix-scoped and because it keeps a compromised CI run away from every
    # role in the account that is not ours.
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.name}-*"]
  }

  statement {
    sid    = "ManageProjectCustomerManagedPolicies"
    effect = "Allow"
    actions = [
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:policy/${local.name}-*"]
  }

  statement {
    sid    = "ManageProjectInstanceProfiles"
    effect = "Allow"
    actions = [
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
    ]
    # The dev cost profile (§9.6) replaces the NAT Gateway with a t4g.nano NAT
    # instance, and that instance needs an instance profile for SSM access.
    resources = ["arn:${local.partition}:iam::${local.account_id}:instance-profile/${local.name}-*"]
  }

  statement {
    sid    = "ManageGitHubOidcProvider"
    effect = "Allow"
    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    # The one IAM resource in this stack that cannot carry the project prefix —
    # its ARN is derived from the issuer URL and there is exactly one per
    # account. Scoped to that single ARN instead.
    resources = ["arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.oidc_host}"]
  }

  statement {
    sid    = "ReadIamForRefresh"
    effect = "Allow"
    actions = [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:GetInstanceProfile",
      "iam:GetOpenIDConnectProvider",
      "iam:ListRoles",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfiles",
      "iam:ListInstanceProfilesForRole",
      "iam:ListPolicies",
      "iam:ListPolicyVersions",
      "iam:ListOpenIDConnectProviders",
      "iam:ListRoleTags",
    ]
    # Read-only, and unscoped because `terraform plan` refreshes attachments
    # whose policy ARNs are AWS-managed (arn:aws:iam::aws:policy/*) and so can
    # never match a project prefix.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy_iam_addendum" {
  name   = "${local.name}-github-deploy-iam"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_iam_addendum.json
}

# ---------------------------------------------------------------------------
# Guardrails. Explicit Deny beats every Allow above, including PowerUserAccess.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy_guardrails" {
  statement {
    sid    = "ProtectTerraformState"
    effect = "Deny"
    actions = [
      "s3:DeleteBucket",
      "s3:PutBucketVersioning",
      "s3:DeleteObjectVersion",
    ]
    # §9.5: the state bucket is bootstrapped once and never destroyed, and its
    # versioning IS the recovery path for a corrupted state file. Nothing CI
    # does should be able to remove either.
    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]
  }

  statement {
    sid    = "ProtectStateLockTable"
    effect = "Deny"
    actions = [
      "dynamodb:DeleteTable",
      "dynamodb:DeleteBackup",
    ]
    resources = [local.state_lock_arn]
  }

  statement {
    sid    = "DenyAttachingAdministratorAccess"
    effect = "Deny"
    actions = [
      "iam:AttachRolePolicy",
      "iam:AttachUserPolicy",
      "iam:AttachGroupPolicy",
    ]
    resources = ["*"]

    # Partial mitigation, stated plainly: CreateRole + PutRolePolicy + PassRole
    # is inherently escalatable, and the complete answer is a permissions
    # boundary required on every role this identity creates (open question in
    # docs/specs/002-infrastructure.md). This blocks the laziest path.
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:${local.partition}:iam::aws:policy/AdministratorAccess"]
    }
  }

  statement {
    sid    = "DenyAccountAndOrganizationChanges"
    effect = "Deny"
    actions = [
      "organizations:*",
      "controltower:*",
      "account:CloseAccount",
      "account:PutAlternateContact",
    ]
    # This is a shared company account and joining an Organization or standing
    # up Control Tower is explicitly out of scope (§9.5). PowerUserAccess
    # already excludes most of this; the Deny makes it non-negotiable.
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.restrict_deploy_regions ? [1] : []

    content {
      sid    = "DenyOutsideAllowedRegions"
      effect = "Deny"
      # Global and global-endpoint services are excluded because they either
      # ignore aws:RequestedRegion or are only addressable from us-east-1.
      # If an apply fails with AccessDenied on a service that belongs on this
      # list, add it here in the same PR rather than disabling the guard.
      not_actions = [
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
      resources = ["*"]

      condition {
        test     = "StringNotEquals"
        variable = "aws:RequestedRegion"
        values   = local.allowed_regions
      }
    }
  }
}

resource "aws_iam_role_policy" "github_deploy_guardrails" {
  name   = "${local.name}-github-deploy-guardrails"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy_guardrails.json
}
