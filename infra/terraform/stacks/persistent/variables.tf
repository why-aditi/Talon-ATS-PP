# ---------------------------------------------------------------------------
# Identity / naming — same contract as stacks/iam.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  description = "First segment of every resource name. Must match stacks/iam, because that stack's IAM policies are scoped to this prefix."
  type        = string
  default     = "talon"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric with hyphens, 2-21 characters, starting with a letter."
  }
}

variable "env" {
  description = "Environment name. One AWS account holds all environments; this is the second segment of every resource name and the Env tag."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.env)
    error_message = "env must be one of: dev, staging, prod."
  }
}

variable "aws_region" {
  description = "Region for this stack. Cognito is regional and the pool id embeds the region, so changing this after the first apply means a new pool and no users."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags merged over the mandatory Project/Env/ManagedBy set."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Role ARNs from stacks/iam.
#
# ARCHITECTURE §9.5: no `aws_iam_role` may exist outside stacks/iam, and every
# other stack takes role ARNs as INPUT VARIABLES. That is what keeps the
# TALON_ROLE_ARNS path in §9.5a working for anyone cloning this without the IAM
# grant — they set these by hand and this stack applies unchanged.
#
# Empty defaults on purpose. stacks/iam has not been applied yet, and a required
# variable here would make this stack un-plannable until it has been. Empty means
# the dependent wiring is simply not created, exactly as the late-bound variables
# in stacks/iam do it.
# ---------------------------------------------------------------------------

variable "lambda_pretoken_role_arn" {
  description = "ARN of the pre-token-generation Lambda's execution role, output by stacks/iam as `lambda_pretoken_role_arn`. Empty means no Lambda trigger is wired to the pool — the pool works for password sign-in, and tenant claims are absent until it is supplied. The Lambda FUNCTION itself is not created here; this variable exists so the trigger can be attached without this stack creating a role."
  type        = string
  default     = ""
}

variable "pretoken_lambda_arn" {
  description = "ARN of the deployed pre-token-generation Lambda function. Empty means no `lambda_config` block is written at all. Kept separate from the role ARN because the function is deployed by a later stage and the role exists before it."
  type        = string
  default     = ""

  validation {
    condition     = var.pretoken_lambda_arn == "" || can(regex("^arn:aws[a-z-]*:lambda:", var.pretoken_lambda_arn))
    error_message = "pretoken_lambda_arn must be empty or a lambda function ARN."
  }
}

# ---------------------------------------------------------------------------
# The user pool
# ---------------------------------------------------------------------------

variable "user_pool_name" {
  description = "Overrides the computed pool name. THIS FIELD IS IMMUTABLE IN COGNITO and `aws_cognito_user_pool` forces replacement when it changes — a replacement destroys every user (CLAUDE.md §4). Do not set this to rename a pool that exists; it is here only so `var.adopt_user_pool` can match a pool created outside Terraform. Empty means `<name_prefix>-<env>`, per ARCHITECTURE §9.4."
  type        = string
  default     = ""
}

variable "deletion_protection" {
  description = "Cognito's own deletion protection. ACTIVE by default: this stack is the `persistent` half of the §9.6 lifetime split and nothing in it is torn down between work sessions. Deliberately NOT `prevent_destroy` — §9.5a rules that out because it cannot be parameterized and blocks scripts/down.sh. This can be flipped to INACTIVE by `down.sh --all` before a genuine teardown, which is the property prevent_destroy does not have."
  type        = string
  default     = "ACTIVE"

  validation {
    condition     = contains(["ACTIVE", "INACTIVE"], var.deletion_protection)
    error_message = "deletion_protection must be ACTIVE or INACTIVE."
  }
}

variable "mfa_configuration" {
  description = "Pool-level MFA. OPTIONAL per ARCHITECTURE §9.4: TOTP is available and the actual policy (required for admins, tenant-configurable otherwise) is enforced in the application layer, because Cognito cannot express a per-tenant rule."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "ON", "OPTIONAL"], var.mfa_configuration)
    error_message = "mfa_configuration must be OFF, ON or OPTIONAL."
  }
}

variable "password_minimum_length" {
  description = "Minimum password length. 12 matches the live pool."
  type        = number
  default     = 12

  validation {
    condition     = var.password_minimum_length >= 8 && var.password_minimum_length <= 99
    error_message = "password_minimum_length must be between 8 and 99."
  }
}

# ---------------------------------------------------------------------------
# The app client
# ---------------------------------------------------------------------------

variable "user_pool_client_name" {
  description = "Overrides the computed app client name. Unlike the pool name this is mutable in place. Empty means `<name_prefix>-<env>-api`."
  type        = string
  default     = ""
}

variable "access_token_validity_minutes" {
  description = "Access and id token lifetime in minutes. 60 matches the live client and spec 001 open question 2."
  type        = number
  default     = 60
}

variable "refresh_token_rotation" {
  description = "Whether Cognito rotates the refresh token on each use. DISABLED matches the live client, and it cannot usefully be ENABLED until the hosted domain exists — rotation happens at /oauth2/token, which does not exist without one. Spec 003."
  type        = string
  default     = "DISABLED"

  validation {
    condition     = contains(["ENABLED", "DISABLED"], var.refresh_token_rotation)
    error_message = "refresh_token_rotation must be ENABLED or DISABLED."
  }
}

variable "refresh_token_validity_days" {
  description = "Refresh token lifetime in days. 30 matches the live client. Note this window is ABSOLUTE, not sliding: rotation needs the hosted /oauth2/token endpoint, which needs the domain below."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------
# The hosted domain — what unblocks SSO
# ---------------------------------------------------------------------------

variable "user_pool_domain_prefix" {
  description = "Prefix for the Cognito-hosted auth domain, i.e. https://<prefix>.auth.<region>.amazoncognito.com. ARCHITECTURE §9.4 rules out a custom domain (no Route 53 zone, no ACM cert), so this is the prefix form. Must be globally unique across ALL AWS accounts in the region — a taken prefix fails the apply with InvalidParameterException. Empty means no domain is created, which is the pre-SSO status quo: /oauth2/authorize and /oauth2/token do not exist without it."
  type        = string
  default     = ""

  validation {
    condition     = var.user_pool_domain_prefix == "" || can(regex("^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$", var.user_pool_domain_prefix))
    error_message = "user_pool_domain_prefix must be lowercase alphanumeric with hyphens, not starting or ending with a hyphen, and 63 characters or fewer. It must not contain the reserved word `aws`, `amazon` or `cognito` — Cognito rejects those at apply."
  }
}

# ---------------------------------------------------------------------------
# OAuth — empty defaults on purpose.
#
# Spec 003 owns the real values. Adding the domain must not change behaviour for
# the password flow the API uses today: `allowed_oauth_flows_user_pool_client` is
# false while these are empty, which is exactly what the live client has.
# ---------------------------------------------------------------------------

variable "oauth_callback_urls" {
  description = "Allowed redirect targets after a hosted-UI or social sign-in. Empty means OAuth is not enabled on the client at all, and the client keeps the ADMIN_USER_PASSWORD/SRP behaviour it has now. Spec 003 sets these."
  type        = list(string)
  default     = []
}

variable "oauth_logout_urls" {
  description = "Allowed redirect targets after sign-out. Only meaningful when oauth_callback_urls is non-empty."
  type        = list(string)
  default     = []
}

variable "oauth_flows" {
  description = "OAuth 2.0 flows. `code` only by default when OAuth is enabled: the implicit flow returns tokens in the URL fragment, where they land in browser history and referrer headers."
  type        = list(string)
  default     = ["code"]

  validation {
    condition     = alltrue([for f in var.oauth_flows : contains(["code", "implicit", "client_credentials"], f)])
    error_message = "oauth_flows entries must be one of: code, implicit, client_credentials."
  }
}

variable "oauth_scopes" {
  description = "OAuth scopes the client may request."
  type        = list(string)
  default     = ["openid", "email", "profile"]
}

variable "supported_identity_providers" {
  description = "Identity providers the client may use. COGNITO is the local user directory. Google is added by spec 003 once the OAuth client exists; per-tenant SAML IdPs are created at RUNTIME through the API (§9.4) and must never appear here — managing them as infrastructure would make customer onboarding a deploy."
  type        = list(string)
  default     = ["COGNITO"]
}

# ---------------------------------------------------------------------------
# Adoption of a pool created outside Terraform
# ---------------------------------------------------------------------------

# A single OBJECT rather than four scalars, and that is load-bearing rather than
# stylistic. The pool's `name` is immutable in Cognito and ForceNew in the
# provider, so importing a pool while leaving `user_pool_name` at its default
# produces a plan that DESTROYS every user in it. As one object, the id and the
# name cannot be supplied separately, so that combination is unrepresentable.
#
# See README.md for the full path. In short: this exists because a pool was
# created by hand with the AWS CLI before this stack was written, and deleting it
# would take real sign-ins with it.
variable "adopt_user_pool" {
  description = "Adopt a pre-existing user pool and app client instead of creating them. `name` and `client_name` MUST equal the live values exactly — the pool name is immutable and a mismatch plans a replacement that destroys every user. Null means create fresh, which is the correct behaviour on a clean account and the path ARCHITECTURE §9.5a's from-zero acceptance test exercises."
  type = object({
    id          = string
    name        = string
    client_id   = string
    client_name = string
  })
  default = null

  validation {
    condition     = var.adopt_user_pool == null || can(regex("^[a-z]{2}-[a-z]+-[0-9]_[A-Za-z0-9]+$", var.adopt_user_pool.id))
    error_message = "adopt_user_pool.id must be a Cognito user pool id, e.g. us-east-1_abcdEFGHI."
  }
}
