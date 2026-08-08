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
  permissions_boundary = aws_iam_policy.permissions_boundary.arn
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
  # The four actions that can manufacture privilege, and the condition that stops
  # them doing it. iam:PermissionsBoundary is the boundary attached to the TARGET
  # role, so this reads: you may create a role or give a role a policy only if
  # that role's ceiling is permissions_boundary.tf. See that file for the
  # escalation this closes and why an identity-policy Allow-with-condition is not
  # enough on its own (the matching explicit Deny is in the guardrails below).
  statement {
    sid    = "ManageProjectRolesUnderTheBoundary"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ]
    # Name-scoped, both because §9.5 warns the company grant may itself be
    # prefix-scoped and because it keeps a compromised CI run away from every
    # role in the account that is not ours.
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.name}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.permissions_boundary_arn]
    }
  }

  # The rest of the role lifecycle. None of these can widen a role's effective
  # permissions on their own — the boundary is already attached and cannot be
  # detached (see DenyRemovingTheBoundary in the guardrails) — so they carry no
  # condition and terraform can still tag, retitle, retrust and delete.
  statement {
    sid    = "ManageProjectRoles"
    effect = "Allow"
    actions = [
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.name}-*"]
  }

  # PassRole separated out and scoped by destination service. Without
  # iam:PassedToService, "pass any talon-dev-* role" means the deploy role can
  # hand a role to a service that was never meant to hold it. The list is what
  # this architecture actually passes a role to (§9.1, §9.2, §9.6's NAT
  # instance). An apply failing with AccessDenied on PassRole means a service is
  # missing from it: add the service to local.pass_role_services, in the same PR,
  # which moves this statement and the boundary's mirror together.
  #
  # THIS CONDITION IS NOT SUFFICIENT ON ITS OWN, and the comment that used to sit
  # here said it was. It named "an EC2 instance it controls" as the thing the
  # condition prevents — but ec2.amazonaws.com is ON the list, for the NAT
  # instance. The destination-role pin that actually closes that case is
  # DenyPassRoleToEc2ExceptEc2Roles in the guardrails below.
  statement {
    sid       = "PassProjectRolesToProjectServices"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.name}-*"]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = local.pass_role_services
    }
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
  # Each Deny below is paired with an identical statement in
  # permissions_boundary.tf, over the shared action lists in locals.tf. That
  # pairing is the point: a guardrail the deploy role carries but the boundary
  # does not is a guardrail the deploy role can create a child to walk around.
  statement {
    sid     = "ProtectTerraformState"
    effect  = "Deny"
    actions = local.state_bucket_protection_actions
    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]
  }

  statement {
    sid       = "ProtectStateLockTable"
    effect    = "Deny"
    actions   = local.state_lock_protection_actions
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

    # Narrow by construction — iam:PolicyARN only exists for MANAGED policies, so
    # this statement cannot see an inline document at all. It is the cheap half
    # of the answer; the expensive half is DenyCreatingRolesOutsideTheBoundary
    # below plus permissions_boundary.tf, which is what actually closes
    # CreateRole + PutRolePolicy + AssumeRole.
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:${local.partition}:iam::aws:policy/AdministratorAccess"]
    }
  }

  # The explicit half of the boundary requirement. The Allow above is already
  # conditioned, so an unconditioned CreateRole would fall through to an implicit
  # deny — but implicit denials are invisible in `aws iam simulate-custom-policy`
  # output and in a policy review, and they evaporate the moment someone adds a
  # broader Allow. This makes it explicitDeny, which nothing can override.
  statement {
    sid    = "DenyCreatingRolesOutsideTheBoundary"
    effect = "Deny"
    actions = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.permissions_boundary_arn]
    }
  }

  statement {
    sid    = "DenyRemovingOrRewritingTheBoundary"
    effect = "Deny"
    actions = [
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteUserPermissionsBoundary",
    ]
    resources = ["*"]
  }

  # ManageProjectCustomerManagedPolicies covers policy/talon-dev-*, and the
  # boundary is policy/talon-dev-permissions-boundary. Without this the deploy
  # role could publish a new default version of its own ceiling that allows
  # everything, and the boundary would be a formality.
  statement {
    sid    = "DenyRewritingTheBoundaryPolicy"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicy",
    ]
    resources = [local.permissions_boundary_arn]
  }

  # ---------------------------------------------------------------------------
  # This role cannot modify itself or the plan role. That is the decision that
  # makes the `sub` pin in oidc.tf a real boundary rather than a comment: without
  # it, one workflow run on the default branch could call UpdateAssumeRolePolicy
  # and add a subject claim for any repository on github.com, permanently, and
  # the next run would already be somebody else's.
  #
  # The consequence is deliberate and load-bearing: **stacks/iam cannot be
  # applied by CI.** It is applied by a human or admin identity — which is what
  # ARCHITECTURE §9.5 describes anyway, and what scripts/up.sh stage 2 does. CI
  # takes the TALON_ROLE_ARNS skip path in §9.5a, where every other stack
  # receives role ARNs as input variables and stage 2 is skipped entirely. A
  # workflow that tries to apply this stack fails on the first IAM write, loudly,
  # with the reason in the AccessDenied message.
  #
  # Scoped to github-* rather than the whole prefix on purpose: the deploy role
  # legitimately manages the application roles, and a CI apply of a future stack
  # that adds one should keep working.
  #
  # The action list is local.ci_role_write_actions and it is shared with the
  # matching statement in permissions_boundary.tf. It is wider than the eight
  # actions this statement used to name: iam:UpdateRole (raises the role's own
  # MaxSessionDuration), iam:TagRole / iam:UntagRole (load-bearing under ABAC),
  # iam:CreateRole (reserves the `-github-` namespace instead of only making a
  # squatted name unusable) and iam:PassRole (AddRoleToInstanceProfile is
  # authorized against the profile ARN, so only the PassRole deny stops an EC2
  # instance being launched wearing this role). See locals.tf for each.
  # ---------------------------------------------------------------------------
  statement {
    sid       = "DenySelfModificationOfCiRoles"
    effect    = "Deny"
    actions   = local.ci_role_write_actions
    resources = [local.ci_role_arn_pattern]
  }

  # ---------------------------------------------------------------------------
  # Stateful resources. CLAUDE.md §4: replacement of a stateful resource is never
  # routine, and ARCHITECTURE §9.5a rules out prevent_destroy because it would
  # block scripts/down.sh. This is the middle path — the resource stays
  # destroyable by the human running down.sh --all, and is not destroyable by an
  # automated apply. A plan that needs one of these replaced (an engine-version
  # change that forces new, say) fails at apply against CI and gets the human
  # §9.5's CI rule asks for.
  #
  # Not listed: rds:DeleteDBInstance. The dev cost profile (§9.6) uses a plain
  # db.t4g.micro instance, not a cluster, and tearing the ephemeral stack down
  # between work sessions is routine by design. Denying it here would fight the
  # teardown it is meant to protect — the same mistake as prevent_destroy.
  # ---------------------------------------------------------------------------
  # The hole iam:PassedToService alone does not close. `ec2.amazonaws.com` is on
  # the allow-list for §9.6's NAT instance, so "pass any talon-dev-* role to any
  # allowed service" still permits handing the ECS TASK role to an EC2 instance —
  # which is a shell with every application secret in it, and is the exact attack
  # the addendum's comment claims to prevent. Measured before this statement
  # existed: `iam:PassRole talon-dev-ecs-task` with
  # `iam:PassedToService=ec2.amazonaws.com` simulated **allowed**.
  #
  # NotResource, so only role names reserved for EC2 principals may reach EC2.
  # Mirrored in permissions_boundary.tf. See local.ec2_pass_role_arn_pattern for
  # the naming contract this places on stacks/ephemeral.
  statement {
    sid           = "DenyPassRoleToEc2ExceptEc2Roles"
    effect        = "Deny"
    actions       = ["iam:PassRole"]
    not_resources = [local.ec2_pass_role_arn_pattern]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  statement {
    sid       = "DenyDestroyingStatefulResources"
    effect    = "Deny"
    actions   = local.stateful_delete_actions
    resources = ["*"]
  }

  statement {
    sid    = "DenyAccountAndOrganizationChanges"
    effect = "Deny"
    # This is a shared company account and joining an Organization or standing
    # up Control Tower is explicitly out of scope (§9.5). PowerUserAccess
    # already excludes most of this; the Deny makes it non-negotiable.
    actions   = local.account_org_actions
    resources = ["*"]
  }

  dynamic "statement" {
    for_each = var.restrict_deploy_regions ? [1] : []

    content {
      sid         = "DenyOutsideAllowedRegions"
      effect      = "Deny"
      not_actions = local.region_exempt_actions
      resources   = ["*"]

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
