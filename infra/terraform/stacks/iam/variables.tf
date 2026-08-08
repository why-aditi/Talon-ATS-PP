# ---------------------------------------------------------------------------
# Identity / naming
#
# ARCHITECTURE §9.5: one AWS account, environments separated by NAME PREFIX and
# tag, not by account boundary. §9.5 also warns that the company IAM grant this
# stack depends on may be scoped to a name prefix — so the prefix is a variable.
# If the grant turns out to be `talon-*` or `talonats-*` or anything else, that
# is a tfvars change, not a rewrite. A role named `ecs-task-execution` failing
# at apply reads as a mystery, not as a permissions problem.
# ---------------------------------------------------------------------------

variable "name_prefix" {
  description = "First segment of every resource name. Must match the name prefix the company IAM grant is scoped to, if it is scoped at all."
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
  description = "Region for regional ARNs in the generated policies. Matches AWS_REGION in .env.example."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags merged over the mandatory Project/Env/ManagedBy set."
  type        = map(string)
  default     = {}
}

variable "create_service_linked_roles" {
  description = "Create the ECS, RDS, and ElastiCache account-level service-linked roles. True for a clean account; false when a shared account already owns them."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# GitHub OIDC
# ---------------------------------------------------------------------------

variable "github_repo" {
  description = "The repository allowed to assume the CI roles, as OWNER/REPO. No default on purpose: a wrong value here is a security bug, not an inconvenience."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "github_repo must be exactly OWNER/REPO with no wildcards, no scheme, and no trailing path."
  }
}

variable "github_owner_id" {
  description = "Numeric GitHub owner id, used to build the id-qualified OIDC subject prefix (locals.tf). CI passes github.repository_owner_id, so a fork gets its own. The default is this repository's; empty disables the id-qualified claim entirely."
  type        = string
  default     = "130339327"

  validation {
    condition     = var.github_owner_id == "" || can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id must be numeric — it is an id, not a login. A login here silently produces a subject claim nothing matches."
  }
}

variable "github_repository_id" {
  description = "Numeric GitHub repository id, used to build the id-qualified OIDC subject prefix (locals.tf). CI passes github.repository_id. The default is this repository's; empty disables the id-qualified claim entirely."
  type        = string
  default     = "1326442505"

  validation {
    condition     = var.github_repository_id == "" || can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id must be numeric — it is an id, not a name."
  }
}

variable "github_default_branch" {
  description = "Branch that is allowed to run terraform apply. ARCHITECTURE §9.5: plan on every PR, apply on merge."
  type        = string
  default     = "main"
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider, when it lives in a different account or under a non-default URL. Empty is normal: the ARN for this account is then constructed in locals.tf, because the issuer URL is fixed and the ARN is therefore deterministic. See create_github_oidc_provider for the create-it-here case."
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC provider instead of reusing the account's. False because the provider is account-global — one per issuer URL — and 762079300828 is shared, so it already exists. Set true when standing this up in a fresh account that has never run a GitHub Actions workflow; leaving it false there fails the PLAN with 'no matching OpenID Connect Provider found', which names the fix."
  type        = bool
  default     = false
}

variable "github_oidc_thumbprints" {
  description = "Optional CA thumbprints for the GitHub OIDC provider. Empty is correct today: since 2023 AWS validates token.actions.githubusercontent.com against its own trusted root CAs and ignores this list. Kept as a variable so a future API change is a tfvars fix."
  type        = list(string)
  default     = []
}

# The shape every accepted `sub` claim must have. Two things it enforces that a
# `startswith("repo:<repo>:")` prefix check did not:
#
#   1. A TRAILING SEGMENT IS MANDATORY. `repo:OWNER/REPO:*` starts with the right
#      prefix, so the old check accepted the exact wildcard the split-role design
#      exists to reject, and rendered it straight into the trust policy.
#   2. NO WILDCARD ANYWHERE. `[^*]+` in the ref and environment branches means a
#      claim can name one branch, one tag, or one environment, never a set. This
#      is what lets oidc.tf use StringEquals instead of StringLike.
#
# The repository name is escaped before interpolation because `.` is legal in a
# GitHub repository name and is a metacharacter here — unescaped, a repo called
# `a.b` would also match `aXb`. locals cannot be referenced from a validation
# block, so the escape is inline in both copies.

variable "github_deploy_subject_claims" {
  description = "Override for the `sub` claims allowed to assume the APPLY role. Empty means the computed default in locals.tf (the default branch, and nothing else). A literal GitHub environment may be added here, but only after that environment has a deployment-branch policy configured in GitHub — without one, GitHub auto-creates it unprotected on first use and the claim bypasses the branch pin."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for s in var.github_deploy_subject_claims :
      can(regex("^repo:${replace(var.github_repo, ".", "\\.")}:(pull_request|ref:refs/(heads|tags)/[^*]+|environment:[^*]+)$", s))
    ])
    error_message = "Every deploy subject claim must be exactly \"repo:<github_repo>:\" followed by one of: pull_request, ref:refs/heads/<branch>, ref:refs/tags/<tag>, environment:<name> — with no \"*\" anywhere. A bare wildcard, or a claim naming a different repository, lets other repositories assume this role."
  }

  validation {
    # The whole reason there are two roles: PR-triggered jobs present
    # `repo:OWNER/REPO:pull_request`, and a pull request is code nobody has
    # merged. It belongs on the read-only plan role and never on this one.
    condition = alltrue([
      for s in var.github_deploy_subject_claims : !endswith(s, ":pull_request")
    ])
    error_message = "The deploy role must not trust the pull_request subject claim — that would let an unmerged pull request run terraform apply. Use github_plan_subject_claims for pull_request."
  }
}

variable "github_plan_subject_claims" {
  description = "Override for the `sub` claims allowed to assume the read-only PLAN role. Empty means the computed default in locals.tf (pull_request + default branch)."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for s in var.github_plan_subject_claims :
      can(regex("^repo:${replace(var.github_repo, ".", "\\.")}:(pull_request|ref:refs/(heads|tags)/[^*]+|environment:[^*]+)$", s))
    ])
    error_message = "Every plan subject claim must be exactly \"repo:<github_repo>:\" followed by one of: pull_request, ref:refs/heads/<branch>, ref:refs/tags/<tag>, environment:<name> — with no \"*\" anywhere. A bare wildcard, or a claim naming a different repository, lets other repositories assume this role."
  }
}

variable "deploy_role_max_session_seconds" {
  description = "Max STS session length for the apply role. An ephemeral-stack apply (RDS + CloudFront) can approach an hour; raise this before splitting the workflow."
  type        = number
  default     = 3600

  validation {
    condition     = var.deploy_role_max_session_seconds >= 900 && var.deploy_role_max_session_seconds <= 14400
    error_message = "deploy_role_max_session_seconds must be between 900 and 14400."
  }
}

# ---------------------------------------------------------------------------
# Guardrails on the apply role
# ---------------------------------------------------------------------------

variable "state_bucket_name" {
  description = "S3 state bucket name, used only to write an explicit Deny on deleting it. Empty means <name_prefix>-tfstate-<account_id>. ARCHITECTURE §9.5: the state bucket is created once and never destroyed. Stage 1 of up.sh must create this exact name or this variable must be set to match."
  type        = string
  default     = ""
}

variable "state_lock_table_name" {
  description = "DynamoDB state lock table name, used for the same Deny and for the plan role's lock permissions. Empty means <name_prefix>-tfstate-lock."
  type        = string
  default     = ""
}

variable "restrict_deploy_regions" {
  description = "Deny every region except aws_region and us-east-1 (global services live there), on the apply role AND in the permissions boundary — so a role the apply role creates cannot go region-shopping either. Cost control per §9.6: a resource created in a region nobody watches is a bill nobody sees. Set false if an apply fails with AccessDenied on a global service that is not in local.region_exempt_actions, and add that service there in the same PR instead if you can."
  type        = bool
  default     = true
}

variable "data_bucket_suffixes" {
  description = "Suffixes of the application's S3 data buckets. §9.3 names uploads | exports | inbound-mail; §9.10 adds the quarantine bucket that resumes land in before the scanner clears them. This list is the ECS task role's object-access allow-list — the plan role's deny is now an inversion (see role_github_plan.tf), so a bucket missing from this list is no longer a bucket CI can read. §9.10's \"served bucket\" is `uploads`: §9.3 enumerates exactly three application buckets and the separation §9.10 asks for on serve is a separate CloudFront distribution and subdomain, not a fourth bucket. Add a suffix here if that stops being true."
  type        = list(string)
  default     = ["uploads", "exports", "inbound-mail", "quarantine"]
}

# ---------------------------------------------------------------------------
# Late-bound ARNs
#
# stacks/persistent creates the KMS key and the Cognito pool, and it consumes
# role ARNs from THIS stack (§9.5). So this stack must not depend on it, or the
# dependency is a cycle. Both of these default to a safe fallback and are
# narrowed by re-applying stacks/iam once persistent has run.
# ---------------------------------------------------------------------------

variable "app_kms_key_arns" {
  description = "Customer-managed KMS key ARNs the application calls directly for envelope encryption of PII columns (§9.9). Empty means no direct KMS statement is created at all — deliberately not a wildcard, because kms:Decrypt on \"*\" is the one wildcard that undoes the encryption it is meant to enable. Populate after stacks/persistent creates the key."
  type        = list(string)
  default     = []
}

variable "cognito_user_pool_arns" {
  description = "Cognito user pool ARNs the API manages at runtime (per-tenant SAML IdPs are created through the API, not Terraform — §9.4). Empty means NO Cognito statement is created at all, exactly like app_kms_key_arns. There is deliberately no userpool/* fallback: pool ids are unpredictable here, but this is a shared company account and userpool/* would let the application create identity providers and disable users in another team's pool. Populate after stacks/persistent creates the pool and re-apply this stack."
  type        = list(string)
  default     = []
}
