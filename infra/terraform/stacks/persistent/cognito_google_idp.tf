# ---------------------------------------------------------------------------
# The Google identity provider (spec 004 §10).
#
# Everything else this flow needs already exists in cognito.tf and is
# parameterised — the domain, the OAuth flows, the callback list,
# `supported_identity_providers`. This file adds the one resource that was
# missing, so enabling Google is a tfvars change plus this provider.
#
# Created with `count` for the same reason the domain is: the pre-SSO status quo
# must stay reachable. With no secret configured there is no provider, and the
# password flow the API uses today is untouched.
# ---------------------------------------------------------------------------

variable "google_sso_secret_id" {
  description = "Secrets Manager id holding {client_id, client_secret} for the Google OAuth client. Empty disables Google federation entirely. The secret is READ, never declared — a client secret in a .tf is a client secret in git history, and rotating it would mean a commit."
  type        = string
  default     = ""
}

data "aws_secretsmanager_secret_version" "google_sso" {
  count     = var.google_sso_secret_id == "" ? 0 : 1
  secret_id = var.google_sso_secret_id
}

resource "aws_cognito_identity_provider" "google" {
  count = var.google_sso_secret_id == "" ? 0 : 1

  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id     = jsondecode(data.aws_secretsmanager_secret_version.google_sso[0].secret_string).client_id
    client_secret = jsondecode(data.aws_secretsmanager_secret_version.google_sso[0].secret_string).client_secret
    # `openid` is what makes Google return an id token at all — the thing this whole
    # flow exchanges for a Talon session. `email` is what the mapping below reads, and
    # without it the mapping silently yields nothing rather than failing.
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email = "email"
    name  = "name"
    # Google's subject becomes Cognito's username for the federated identity. Cognito
    # then allocates its OWN sub, and THAT is what `users.external_id` points at —
    # the provisioning order from spec 002, unchanged by federation.
    username = "sub"
  }
}

# ---------------------------------------------------------------------------
# The one thing Terraform cannot do, and the mistake it is easy to make.
#
# There are two different redirect URIs in this flow and they live in different
# places. Google redirects to COGNITO, never to the app:
#
#   Google  ──▶ https://<domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse
#   Cognito ──▶ ${var.oauth_callback_urls}   (the app's /api/auth/sso/callback)
#
# The first belongs in the Google Cloud OAuth client's "Authorized redirect URIs";
# the second is `oauth_callback_urls` above. Putting the app URL into Google —
# the natural guess — fails with `Error 400: redirect_uri_mismatch`, because
# Google is being asked to redirect somewhere it was never going to.
#
# No AWS credential can set this: it is a Google Cloud project setting. The
# client id and secret in Secrets Manager grant USE of the OAuth client, not
# administration of it.
# ---------------------------------------------------------------------------
output "google_authorized_redirect_uri" {
  description = "Add this to the Google Cloud OAuth client's Authorized redirect URIs. Null until a domain exists."
  value = var.user_pool_domain_prefix == "" ? null : (
    "https://${var.user_pool_domain_prefix}.auth.${var.aws_region}.amazoncognito.com/oauth2/idpresponse"
  )
}
