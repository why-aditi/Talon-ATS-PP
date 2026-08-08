# ---------------------------------------------------------------------------
# Google SSO — the hosted UI and the Google IdP (spec 004 §10).
#
# APPLIED BY HAND FIRST, then written down. On 2026-08-08 the domain, the Google
# identity provider and the app client's OAuth configuration were created with the
# AWS CLI against the throwaway pool `talon-throwaway-spec002`, because that is the
# pool the dev app is pointed at and the alternative — standing up a properly named
# pool per §10.1 — means re-provisioning every seeded user's `external_id` before
# anyone can sign in at all.
#
# That is drift, and this file exists so it is recorded drift rather than a surprise.
# §10.1 still holds: the throwaway must not become the permanent identity store. When
# the real pool lands, these three resources move onto it unchanged — only the
# `user_pool_id` reference changes.
# ---------------------------------------------------------------------------

variable "user_pool_id" {
  description = "The pool these attach to. Today the spec-002 throwaway; the permanent pool when it exists."
  type        = string
}

variable "app_client_id" {
  description = "The public (PKCE, no secret) app client the web app uses."
  type        = string
}

variable "sso_domain_prefix" {
  description = "Cognito hosted-UI subdomain. Globally unique across AWS, hence the account suffix."
  type        = string
}

variable "app_origin" {
  description = "Where the browser comes back to. The callback path is fixed by apps/web/src/lib/sso.ts."
  type        = string
}

variable "google_secret_id" {
  description = "Secrets Manager id holding { client_id, client_secret } for the Google OAuth client."
  type        = string
  default     = "talon-dev/sso/google"
}

# The credentials are READ, never declared. A client secret in a .tf file is a client
# secret in git history, and rotating it would mean a commit.
data "aws_secretsmanager_secret_version" "google" {
  secret_id = var.google_secret_id
}

locals {
  google = jsondecode(data.aws_secretsmanager_secret_version.google.secret_string)
}

resource "aws_cognito_user_pool_domain" "sso" {
  domain       = var.sso_domain_prefix
  user_pool_id = var.user_pool_id
}

resource "aws_cognito_identity_provider" "google" {
  user_pool_id  = var.user_pool_id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id = local.google.client_id
    # Marked sensitive by the provider; it never reaches the plan output.
    client_secret = local.google.client_secret
    # `openid` is what makes Cognito issue an id token at all — the one this whole
    # flow exchanges for a Talon session. `email` is what the attribute mapping below
    # needs, and without it the mapping silently yields nothing.
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email = "email"
    name  = "name"
    # Google's `sub`, which becomes Cognito's username for the federated identity.
    # Cognito then allocates its OWN sub, and that is what `users.external_id` points
    # at — provisioning order per spec 002, unchanged by federation.
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "web" {
  # Managed here only to add the OAuth half; the auth flows are the pool client's
  # existing ones and are repeated so an apply does not silently drop them.
  name         = "talon-throwaway-api"
  user_pool_id = var.user_pool_id

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  # No `generate_secret`. The app client is public and the flow is PKCE-protected
  # (spec 002 open question 3) — a secret in a browser-initiated flow is not a secret.
  supported_identity_providers = ["COGNITO", "Google"]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  allowed_oauth_flows_user_pool_client = true

  # Exact-matched by Cognito. Derived from configuration and never from a request
  # Host, so a spoofed header cannot redirect an authorization code elsewhere.
  callback_urls = ["${var.app_origin}/api/auth/sso/callback"]
  logout_urls   = ["${var.app_origin}/sign-in"]

  depends_on = [aws_cognito_identity_provider.google]
}

# ---------------------------------------------------------------------------
# The one thing Terraform cannot do.
#
# Google will refuse the flow with `redirect_uri_mismatch` until this exact URI is
# an Authorized redirect URI on the Google Cloud OAuth client:
#
#   https://${var.sso_domain_prefix}.auth.<region>.amazoncognito.com/oauth2/idpresponse
#
# That is a setting in a Google Cloud project, not an AWS resource, and no AWS
# credential can reach it. Verified failing on 2026-08-08 — Cognito redirects to
# Google correctly and Google rejects the callback.
# ---------------------------------------------------------------------------
output "google_authorized_redirect_uri" {
  description = "Paste this into the Google Cloud OAuth client's Authorized redirect URIs."
  value       = "https://${aws_cognito_user_pool_domain.sso.domain}.auth.us-east-1.amazoncognito.com/oauth2/idpresponse"
}

output "cognito_domain" {
  description = "COGNITO_DOMAIN for apps/web."
  value       = "https://${aws_cognito_user_pool_domain.sso.domain}.auth.us-east-1.amazoncognito.com"
}
