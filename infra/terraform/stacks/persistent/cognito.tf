# ---------------------------------------------------------------------------
# The user pool.
#
# READ THIS BEFORE CHANGING ANY ATTRIBUTE BELOW.
#
# Cognito schema attributes are immutable after pool creation. CLAUDE.md §4 and
# ARCHITECTURE §9.4 both describe the consequence as a forced REPLACEMENT of the
# pool, which destroys every user in it.
#
# WHAT THE PROVIDER ACTUALLY DOES, MEASURED ON 5.100.0 — because this comment
# used to assert something a reader could disprove in five minutes, and a comment
# that fails its own test gets deleted along with the line it protects:
#
#   - `schema` is Optional and is NOT ForceNew, and there is no CustomizeDiff on
#     it. The read path filters what AWS returns down to what the configuration
#     declares, so a pool under management with NO schema block shows no schema
#     diff at all. Verified against the live pool with `ignore_changes = []`:
#     `2 to import, 0 to add, 1 to change, 0 to destroy`, and the only changes
#     were deletion_protection and tags. There is no "permanent replacement".
#   - ADDING an attribute plans an in-place update (`1 to change, 0 to destroy`)
#     and applies as AddCustomAttributes.
#   - REMOVING or MODIFYING one is neither a diff nor a replacement: the provider
#     refuses at APPLY time with "cannot modify or remove schema items". That
#     string is in the 5.100.0 binary this stack is pinned to.
#
# So on this provider version the failure mode is a failed apply, not a silent
# user-destroying `-/+`. That is a narrower hazard than the one CLAUDE.md
# describes, and it is not a reason to drop the guard — recorded as a finding for
# a human in spec 002 §4a.2 rather than acted on here.
#
# Three defences, and they are deliberately not the obvious one:
#
#   1. `ignore_changes = [schema]` below. It keeps the attribute out of the diff
#      entirely, whatever the provider decides to do with it — including across a
#      major-version bump, where ForceNew on this attribute would be a one-line
#      change upstream and would arrive as a `-/+` in a plan nobody re-read. Its
#      concrete value today is for a pool THIS configuration created, whose
#      schema is in state as configured; see the `lifecycle` block below.
#
#   2. NO CUSTOM ATTRIBUTES, ever. tenant_id, roles and job membership live in
#      the `users` table keyed by `sub`; the pre-token-generation Lambda injects
#      them as claims at sign-in. If you think you need a custom attribute, you
#      need a database column. This is what makes defence 1 sufficient rather
#      than merely helpful — with no custom attributes there is no legitimate
#      reason for the schema to ever change.
#
#   3. The CI check in .github/workflows/terraform.yml, which fails any plan
#      showing this resource being replaced. Defences 1 and 2 are properties of
#      this file; defence 3 is what catches someone editing this file.
#
# Deliberately NOT `prevent_destroy`. ARCHITECTURE §9.5a rules it out: it cannot
# be parameterized, so it blocks `scripts/down.sh`, and one-command teardown is a
# requirement. Protection comes from this resource living in the `persistent`
# stack (which is not torn down between work sessions), from `down.sh --all`
# needing an explicit confirmation, and from `deletion_protection` — which,
# unlike prevent_destroy, IS a variable and can be flipped for a real teardown.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool" "main" {
  name = local.user_pool_name

  deletion_protection = var.deletion_protection

  # Sign-in is by email address. ForceNew in the provider and immutable in
  # Cognito — changing it destroys every user.
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  mfa_configuration = var.mfa_configuration

  # Required whenever mfa_configuration is not OFF. TOTP only: SMS needs an SNS
  # role and a phone number per user, and §9.4 specifies TOTP.
  dynamic "software_token_mfa_configuration" {
    for_each = var.mfa_configuration == "OFF" ? [] : [1]
    content {
      enabled = true
    }
  }

  password_policy {
    minimum_length                   = var.password_minimum_length
    require_lowercase                = true
    require_uppercase                = false
    require_numbers                  = false
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }

    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 2
    }
  }

  admin_create_user_config {
    # False: users sign themselves up. The demo users §9.5a's up.sh creates are
    # made with AdminCreateUser regardless, which this does not block.
    allow_admin_create_user_only = false
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
  }

  # The pre-token-generation Lambda (§9.4) is what puts tenant_id and roles into
  # the token. The function is deployed outside this stack and its role lives in
  # stacks/iam, so this block only appears once the ARN is supplied — the same
  # late-binding pattern stacks/iam uses for the Cognito and KMS ARNs, and for
  # the same reason: the dependency would otherwise be a cycle.
  #
  # Until then the pool issues tokens WITHOUT tenant claims. That is a working
  # sign-in and a broken authorization story, which is why it is a variable
  # rather than something to be forgotten about.
  dynamic "lambda_config" {
    for_each = var.pretoken_lambda_arn == "" ? [] : [1]
    content {
      pre_token_generation_config {
        lambda_arn     = var.pretoken_lambda_arn
        lambda_version = "V2_0"
      }
    }
  }

  lifecycle {
    # THE LINE. See the header comment for what the provider measurably does.
    # Never remove this, and never add a `schema` block to this resource: with
    # both, an attribute that is later edited or dropped from that block is an
    # apply that fails on this provider version and a plan that could replace the
    # pool on another. Neither is a thing to discover on a Friday.
    ignore_changes = [schema]
  }
}

# ---------------------------------------------------------------------------
# The app client.
#
# No client secret: the API authenticates users, it does not act as a
# confidential client, and the adapter does not implement SECRET_HASH. Adding a
# secret without implementing SECRET_HASH breaks every sign-in with
# NotAuthorizedException, which reads as a credentials bug.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "api" {
  name         = local.user_pool_client_name
  user_pool_id = aws_cognito_user_pool.main.id

  # `generate_secret` is deliberately NOT written here even though the intended
  # value is false, which is also the provider's default.
  #
  # It is ForceNew, and the Cognito API does not return a ClientSecret field at
  # all for a client that has none — so an imported client carries `null`, not
  # `false`, and an explicit `false` in the configuration reads as a change from
  # null and plans a REPLACEMENT. Measured: with `generate_secret = false`
  # present, adopting the live client produced `-/+ ... # forces replacement`,
  # which would mint a new client id and break every running API instance's
  # COGNITO_CLIENT_ID. Omitting it plans nothing.
  #
  # The absence is therefore load-bearing. If a secret is ever genuinely wanted,
  # that is a new client resource, not an edit to this one.

  explicit_auth_flows = [
    "ALLOW_ADMIN_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
  ]

  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.access_token_validity_minutes
  refresh_token_validity = var.refresh_token_validity_days

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  # Stated explicitly rather than left to the default, for two reasons. The
  # provider plans to REMOVE this block from an imported client that has it, so
  # writing it is what makes the adoption plan clean for the client. And it
  # records the actual state of refresh handling: rotation is off, so the
  # 30-day window is ABSOLUTE, not sliding. Turning it on needs the hosted
  # /oauth2/token endpoint, which needs the domain below — spec 003.
  refresh_token_rotation {
    feature                    = var.refresh_token_rotation
    retry_grace_period_seconds = 0
  }

  enable_token_revocation = true

  # ENABLED, and it is not cosmetic: without it Cognito returns
  # UserNotFoundException for an unknown address and NotAuthorizedException for a
  # bad password, which is a user-enumeration oracle on a login form.
  prevent_user_existence_errors = "ENABLED"

  # OAuth stays off until callbacks are supplied (spec 003). Turning it on with
  # an empty callback list is rejected by Cognito, and turning it on at all
  # changes behaviour for the password flow the API uses today.
  allowed_oauth_flows_user_pool_client = local.oauth_enabled
  allowed_oauth_flows                  = local.oauth_enabled ? var.oauth_flows : []
  allowed_oauth_scopes                 = local.oauth_enabled ? var.oauth_scopes : []
  callback_urls                        = var.oauth_callback_urls
  logout_urls                          = var.oauth_logout_urls
  supported_identity_providers         = local.oauth_enabled ? var.supported_identity_providers : []
}

# ---------------------------------------------------------------------------
# The hosted domain — this is what unblocks SSO.
#
# Without a domain there is no `/oauth2/authorize` and no `/oauth2/token`, so:
#   - Google and per-tenant SAML sign-in are unreachable, because a federated
#     sign-in IS a redirect to /oauth2/authorize;
#   - refresh is absolute rather than sliding, because rotation happens at
#     /oauth2/token.
#
# A prefix domain, not a custom one: ARCHITECTURE §9.4 rules out a Route 53 zone
# and an ACM cert, and Google OAuth callbacks work fine against the
# *.amazoncognito.com name.
#
# THE PREFIX IS GLOBALLY UNIQUE ACROSS ALL AWS ACCOUNTS in the region, not just
# ours. `talon-dev` is the kind of name somebody else has already taken, and the
# failure is an apply-time InvalidParameterException, not a plan error. Check
# with `aws cognito-idp describe-user-pool-domain --domain <prefix>` before
# applying: an empty `DomainDescription` means it is free.
# ---------------------------------------------------------------------------

resource "aws_cognito_user_pool_domain" "main" {
  count = var.user_pool_domain_prefix == "" ? 0 : 1

  domain       = var.user_pool_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}
