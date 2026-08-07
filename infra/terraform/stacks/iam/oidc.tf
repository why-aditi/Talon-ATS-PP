# ---------------------------------------------------------------------------
# GitHub Actions OIDC provider.
#
# Account-global: AWS allows exactly one provider per issuer URL per account,
# and this is a shared company account. If something else already registered
# token.actions.githubusercontent.com, creating it here fails with
# EntityAlreadyExists — set var.github_oidc_provider_arn instead of importing.
# ---------------------------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_provider_arn == "" ? 1 : 0

  url = "https://${local.oidc_host}"

  # The audience GitHub mints when a workflow requests AWS credentials. It is
  # also asserted again as a StringEquals condition on every trust policy below,
  # because client_id_list alone is not a per-role control.
  client_id_list = ["sts.amazonaws.com"]

  # Empty by design — see var.github_oidc_thumbprints. Pinning a stale
  # thumbprint is worse than pinning none: it breaks silently on CA rotation.
  thumbprint_list = var.github_oidc_thumbprints
}

# ---------------------------------------------------------------------------
# Trust policies.
#
# THE `sub` CONDITION IS THE WHOLE SECURITY BOUNDARY. Read this before editing.
#
# The Federated principal below is GitHub's public OIDC issuer. Every GitHub
# Actions workflow on github.com — every repository owned by anyone — gets a
# token from that same issuer. So a trust policy that names the provider and
# checks only `aud` says, in effect: "any workflow in any repository in the
# world may assume this role." That is the single most common critical
# misconfiguration in this exact pattern, and the plan output for it looks
# completely ordinary.
#
# `aud` is StringEquals: there is exactly one correct audience.
# `sub` is StringEquals too. It used to be StringLike, for the sake of a
#   `repo:OWNER/REPO:environment:*` entry that has since been removed (see the
#   comment in locals.tf). With that gone, no reachable claim contains a
#   wildcard: both variables' validations reject `*` anywhere in the string.
#   StringEquals therefore changes no behaviour today and removes the operator
#   that would have silently honoured a wildcard if one were ever introduced.
#
# Never replace the sub values with "*", "repo:*", or "repo:OWNER/*". Switching
# this operator back to StringLike and adding a wildcard is a two-file change on
# purpose — variables.tf has to be widened as well.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy_trust" {
  statement {
    sid     = "GitHubActionsApply"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.deploy_subject_claims
    }
  }
}

data "aws_iam_policy_document" "github_plan_trust" {
  statement {
    sid     = "GitHubActionsPlan"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = local.plan_subject_claims
    }
  }
}
