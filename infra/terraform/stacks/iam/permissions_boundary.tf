# ---------------------------------------------------------------------------
# The permissions boundary.
#
# THE ESCALATION THIS CLOSES. The deploy role holds PowerUserAccess plus, from
# role_github_deploy.tf, iam:CreateRole + iam:PutRolePolicy + iam:PassRole over
# `role/talon-dev-*`. Those three together are full administrator, by this path:
#
#   1. iam:CreateRole  talon-dev-anything, with a trust policy naming the deploy
#                      role itself as principal
#   2. iam:PutRolePolicy  an inline {"Effect":"Allow","Action":"*","Resource":"*"}
#                      — the DenyAttachingAdministratorAccess guardrail matches
#                      on iam:PolicyARN and so only sees MANAGED policies; an
#                      inline document has no ARN and slips straight past it
#   3. sts:AssumeRole  and the session is an administrator
#
# Nothing about that sequence looks unusual in CloudTrail, and every step is
# individually within the role's documented job.
#
# THE FIX. A permissions boundary is a ceiling: a role's effective permissions
# are the INTERSECTION of its policies and its boundary. Attach this boundary to
# the role in step 1 and the *:* inline policy from step 2 buys nothing outside
# the ceiling. Two identity-policy conditions in role_github_deploy.tf make the
# boundary mandatory rather than optional, and this document re-states them so a
# role created under the boundary cannot create a boundary-less child either.
# The escalation is then a fixed point instead of a ladder.
#
# WHAT THE CEILING ACTUALLY IS: everything, minus IAM writes outside this
# project's names, minus IAM users and groups, minus removing or rewriting this
# boundary, minus **every** guardrail the deploy role itself carries — account
# and organization changes, the state bucket, the state lock table, writes to the
# CI roles, unscoped PassRole, and regions nobody watches. Note what it is NOT:
# it is not an attempt to re-derive PowerUserAccess by hand. A boundary that
# enumerates services drifts every time a stack adds one and fails as a mid-apply
# AccessDenied — the same argument role_github_deploy.tf makes for not
# hand-rolling the allow-list.
#
# "EVERY guardrail" is doing work in that sentence. This document previously
# mirrored two of the deploy role's six guardrails, and the gap was a real
# escalation rather than a theoretical one: create a child role WITH the boundary
# (permitted, and deliberately so), give it an inline `*:*` (permitted), assume
# it (permitted) — and from that session rewrite the deploy role's trust policy,
# delete the Cognito pool, delete the state lock table, pass the ECS task role to
# EC2, or run instances in ap-south-1. Three calls instead of one is not a
# boundary. The mirrored statements now share their action lists with
# role_github_deploy.tf through locals.tf so the omission cannot recur silently.
#
# WHAT THE CEILING STILL DOES NOT DO: it does not narrow blast radius. A child
# role under this boundary can still read any S3 object and any Secrets Manager
# secret in the account that the ceiling does not name — including the quarantine
# bucket, which the ECS task role legitimately needs and which therefore cannot
# be denied here. The boundary closes privilege ESCALATION; it is not an SCP.
# Recorded as spec 002 §4.10 and open question 6.
#
# CONSEQUENCE, STATED PLAINLY: all five roles in this stack carry the boundary.
# For a role that does not yet exist that costs nothing — the boundary is a
# parameter of iam:CreateRole. Adding it to a role that ALREADY exists requires
# iam:PutRolePermissionsBoundary, which is not in the granted IAM addendum in
# ARCHITECTURE §9.5. This stack has never been applied, so the first apply
# creates all five with the boundary in place and the question does not arise;
# if it ever does, that permission has to be granted before the plan will apply.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "permissions_boundary" {
  # A boundary is a ceiling, not a grant: nothing is permitted by this statement
  # that an attached policy does not also permit. Starting from "*" and carving
  # out is the only shape that does not silently break the next stack.
  statement {
    sid       = "PermissionCeiling"
    effect    = "Allow"
    actions   = ["*"]
    resources = ["*"]
  }

  # IAM writes are confined to this project's own names. NotResource rather than
  # Resource so it fails closed: a role, policy or instance profile outside the
  # prefix is denied without anyone having had to think of it.
  #
  # Enumerated actions rather than iam:Create*/Update*/Delete* wildcards for one
  # specific reason: iam:CreateServiceLinkedRole targets role/aws-service-role/*,
  # which is outside the prefix, and ECS, ElastiCache, RDS and autoscaling all
  # create their service-linked role on first use. A Create* wildcard here breaks
  # the ephemeral stack's first apply.
  #
  # Read actions are absent on purpose. `terraform plan` refreshes policy
  # attachments whose ARNs are AWS-managed (arn:aws:iam::aws:policy/*) and lists
  # roles it does not own; denying reads breaks refresh and secures nothing.
  #
  # THE EXCEPTION BELOW IS WIDER THAN IT LOOKS. `role/${local.name}-*` matches
  # `role/${local.name}-github-deploy`, so the CI roles sit inside the NotResource
  # exception and are NOT denied by this statement. That is corrected by the
  # explicit DenyWritingCiRoles statement further down, because a NotResource list
  # has no way to subtract from itself. Do not read this statement alone.
  statement {
    sid    = "DenyIamWritesOutsideProjectNames"
    effect = "Deny"
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
      "iam:PutRolePermissionsBoundary",
      "iam:PassRole",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
    ]
    not_resources = [
      "arn:${local.partition}:iam::${local.account_id}:role/${local.name}-*",
      "arn:${local.partition}:iam::${local.account_id}:policy/${local.name}-*",
      "arn:${local.partition}:iam::${local.account_id}:instance-profile/${local.name}-*",
    ]
  }

  # Nothing in this project uses IAM users or groups — every principal is a role
  # assumed through OIDC or by an AWS service. So a long-lived access key being
  # created is never a legitimate action here, and it is the first thing an
  # escalation reaches for because it survives the session that created it.
  statement {
    sid    = "DenyIamUsersAndGroups"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:DeleteUser",
      "iam:UpdateUser",
      "iam:PutUserPolicy",
      "iam:AttachUserPolicy",
      "iam:PutUserPermissionsBoundary",
      "iam:CreateAccessKey",
      "iam:UpdateAccessKey",
      "iam:CreateLoginProfile",
      "iam:UpdateLoginProfile",
      "iam:CreateServiceSpecificCredential",
      "iam:CreateGroup",
      "iam:PutGroupPolicy",
      "iam:AttachGroupPolicy",
      "iam:AddUserToGroup",
    ]
    resources = ["*"]
  }

  # The ceiling has to be un-liftable or it is decoration. Two ways off it:
  # detach it, or rewrite the policy it points at. Both are denied here and again
  # on the deploy role itself, so changing this boundary is a human-run apply of
  # stacks/iam and nothing else.
  statement {
    sid    = "DenyRemovingTheBoundary"
    effect = "Deny"
    actions = [
      "iam:DeleteRolePermissionsBoundary",
      "iam:DeleteUserPermissionsBoundary",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyRewritingTheBoundary"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:DeletePolicy",
    ]
    resources = [local.permissions_boundary_arn]
  }

  # The fixed point. Without this, a role created under the boundary could create
  # a child role with no boundary and the ceiling would last exactly one
  # generation. StringNotEquals on a condition key that is absent evaluates true,
  # which is the behaviour we want: no boundary declared means denied.
  statement {
    sid    = "RequireThisBoundaryOnRolesAndPolicies"
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

  # -------------------------------------------------------------------------
  # MIRRORS of role_github_deploy.tf's guardrails.
  #
  # A ceiling that stops a child reaching *administrator* but not the specific
  # things the parent is denied is only a partial mirror, and a partial mirror is
  # a three-call escalation instead of a one-call one. This block used to mirror
  # two guardrails out of six; the other four were reachable by creating a child
  # role WITH the boundary, giving it an inline `*:*`, and assuming it —
  # every step of which the boundary permits by design, because that is the fixed
  # point the ceiling is supposed to make harmless.
  #
  # Each statement below shares its action list with the deploy role's copy via
  # locals.tf, so the two cannot drift apart again by omission.
  # -------------------------------------------------------------------------

  statement {
    sid       = "DenyAccountAndOrganizationChanges"
    effect    = "Deny"
    actions   = local.account_org_actions
    resources = ["*"]
  }

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

  # The CI roles are not writable under the boundary either.
  #
  # THIS IS ALSO THE CARVE-OUT FOR DenyIamWritesOutsideProjectNames ABOVE. That
  # statement's NotResource exception is `role/${local.name}-*`, which matches
  # `role/${local.name}-github-deploy` — so the CI roles fell inside the
  # exception and were writable under the boundary. A NotResource list cannot
  # subtract from itself, so the exception is narrowed the only way IAM allows:
  # a second, explicit Deny naming the ARNs that must not have been excepted.
  # Explicit Deny beats every Allow, so the effect is exact.
  #
  # Without it: create `talon-dev-x` with the boundary, PutRolePolicy `*:*`,
  # assume it, then UpdateAssumeRolePolicy on `talon-dev-github-deploy` and add a
  # subject claim for any repository on github.com. §4.3 says the `sub` pin is
  # the whole security boundary and §4.8 pays for that claim by giving up CI
  # applies of this stack; without this statement that price bought nothing.
  statement {
    sid       = "DenyWritingCiRoles"
    effect    = "Deny"
    actions   = local.ci_role_write_actions
    resources = [local.ci_role_arn_pattern]
  }

  statement {
    sid       = "DenyDestroyingStatefulResources"
    effect    = "Deny"
    actions   = local.stateful_delete_actions
    resources = ["*"]
  }

  # PassRole is scoped by destination service here as well as in the addendum.
  # In the addendum the scoping is a *condition on an Allow*, so an unmatched
  # pass is an IMPLICIT deny — which a child role's own `*:*` Allow overrides
  # trivially. Under a boundary there is no such thing as "no Allow": the ceiling
  # is `*` by construction, so the only way to express the same rule is an
  # explicit Deny.
  #
  # StringNotEquals on an absent key evaluates true, so a PassRole request that
  # carries no iam:PassedToService is denied. That is the same failure mode the
  # addendum's StringEquals already has for the deploy role, so this adds no new
  # class of breakage — if a service does not populate the key, the deploy role
  # could not pass to it before this change either.
  statement {
    sid       = "DenyPassRoleOutsideProjectServices"
    effect    = "Deny"
    actions   = ["iam:PassRole"]
    resources = ["*"]

    condition {
      test     = "StringNotEquals"
      variable = "iam:PassedToService"
      values   = local.pass_role_services
    }
  }

  # And the destination-role pin the service list cannot express. EC2 is on the
  # allow-list above for §9.6's NAT instance, so scoping by service alone still
  # permits passing the ECS TASK role to an instance and reading every
  # application secret from a shell. Mirror of the same statement in
  # role_github_deploy.tf.
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

  # Region restriction, gated on the same variable as the deploy role's copy so
  # they are switched together. This one binds all five roles, not just the
  # deploy role — that is intended and costs nothing: every regional call any of
  # them makes (SQS, SES, SSM, Secrets Manager, Cognito, ECR, CloudWatch) is in
  # var.aws_region, and the global services are in local.region_exempt_actions.
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

resource "aws_iam_policy" "permissions_boundary" {
  name        = local.permissions_boundary_name
  description = "Ceiling on every role in ${local.name}. Required by name on iam:CreateRole and iam:PutRolePolicy in the deploy role's addendum."
  policy      = data.aws_iam_policy_document.permissions_boundary.json
}
