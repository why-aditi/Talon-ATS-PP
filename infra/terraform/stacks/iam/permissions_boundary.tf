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
# boundary, minus the account/organization and Terraform-state denials that the
# deploy role already carries. Note what it is NOT: it is not an attempt to
# re-derive PowerUserAccess by hand. A boundary that enumerates services drifts
# every time a stack adds one and fails as a mid-apply AccessDenied — the same
# argument role_github_deploy.tf makes for not hand-rolling the allow-list.
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

  # Mirrors of the two guardrails in role_github_deploy.tf that must also hold
  # for anything the deploy role creates, not just for the deploy role itself.
  statement {
    sid    = "DenyAccountAndOrganizationChanges"
    effect = "Deny"
    actions = [
      "organizations:*",
      "controltower:*",
      "account:CloseAccount",
      "account:PutAlternateContact",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ProtectTerraformState"
    effect = "Deny"
    actions = [
      "s3:DeleteBucket",
      "s3:PutBucketVersioning",
      "s3:DeleteObjectVersion",
    ]
    resources = [
      local.state_bucket_arn,
      "${local.state_bucket_arn}/*",
    ]
  }
}

resource "aws_iam_policy" "permissions_boundary" {
  name        = local.permissions_boundary_name
  description = "Ceiling on every role in ${local.name}. Required by name on iam:CreateRole and iam:PutRolePolicy in the deploy role's addendum."
  policy      = data.aws_iam_policy_document.permissions_boundary.json
}
