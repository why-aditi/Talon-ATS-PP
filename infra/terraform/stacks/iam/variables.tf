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

variable "github_default_branch" {
  description = "Branch that is allowed to run terraform apply. ARCHITECTURE §9.5: plan on every PR, apply on merge."
  type        = string
  default     = "main"
}

variable "github_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider. The provider is account-global and there can only be one per account; set this when a company account already has it and this stack should reuse rather than create it. Empty means create it here."
  type        = string
  default     = ""
}

variable "github_oidc_thumbprints" {
  description = "Optional CA thumbprints for the GitHub OIDC provider. Empty is correct today: since 2023 AWS validates token.actions.githubusercontent.com against its own trusted root CAs and ignores this list. Kept as a variable so a future API change is a tfvars fix."
  type        = list(string)
  default     = []
}

variable "github_deploy_subject_claims" {
  description = "Override for the `sub` claims allowed to assume the APPLY role. Empty means the computed default in locals.tf (default branch + any GitHub Environment)."
  type        = list(string)
  default     = []

  validation {
    # Every entry must name this repository literally. Without this, a typo or a
    # copy-paste from another project can widen the trust policy to a repo we do
    # not control, and nothing about the plan output would look wrong.
    condition = alltrue([
      for s in var.github_deploy_subject_claims : startswith(s, "repo:${var.github_repo}:")
    ])
    error_message = "Every deploy subject claim must start with \"repo:<github_repo>:\". A claim naming a different repository, or a bare wildcard, lets other repositories assume this role."
  }
}

variable "github_plan_subject_claims" {
  description = "Override for the `sub` claims allowed to assume the read-only PLAN role. Empty means the computed default in locals.tf (pull_request + default branch)."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for s in var.github_plan_subject_claims : startswith(s, "repo:${var.github_repo}:")
    ])
    error_message = "Every plan subject claim must start with \"repo:<github_repo>:\". A claim naming a different repository, or a bare wildcard, lets other repositories assume this role."
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
  description = "Deny the apply role in every region except aws_region and us-east-1 (global services live there). Cost control per §9.6: a resource created in a region nobody watches is a bill nobody sees. Set false if an apply fails with AccessDenied on a global service that is not in the exclusion list in iam_deploy.tf, and add that service in the same PR."
  type        = bool
  default     = true
}

variable "data_bucket_suffixes" {
  description = "Suffixes of the application's S3 data buckets (§9.3: <name_prefix>-<env>-uploads | exports | inbound-mail). Used twice: the ECS task role is allowed object access to exactly these, and the read-only plan role is explicitly denied it, because they hold candidate resumes (§9.10) and terraform plan never needs an object body."
  type        = list(string)
  default     = ["uploads", "exports", "inbound-mail"]
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
  description = "Cognito user pool ARNs the API manages at runtime (per-tenant SAML IdPs are created through the API, not Terraform — §9.4). Empty falls back to userpool/* in this account, because pool ids are generated at create time and cannot be predicted here."
  type        = list(string)
  default     = []
}
