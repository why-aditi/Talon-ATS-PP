variable "aws_region" {
  type        = string
  description = "AWS region for the state lock table and API calls."
  default     = "us-east-1"
}

variable "name_prefix" {
  type        = string
  description = "Project resource-name prefix."
  default     = "talon"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must be 3-32 lowercase letters, digits, or hyphens."
  }
}

variable "state_bucket_name" {
  type        = string
  description = "Override for the globally unique state bucket. Empty uses <name_prefix>-tfstate-<account-id>."
  default     = ""
}

variable "state_lock_table_name" {
  type        = string
  description = "Override for the DynamoDB lock table. Empty uses <name-prefix>-tfstate-lock."
  default     = ""
}

variable "adopt_state_bucket" {
  type        = bool
  description = "Import the named bucket and its settings before applying. Set by the provisioning script after a successful HeadBucket."
  default     = false
}

variable "adopt_state_lock_table" {
  type        = bool
  description = "Import the named DynamoDB table before applying. Set by the provisioning script after DescribeTable succeeds."
  default     = false
}

variable "tags" {
  type        = map(string)
  description = "Additional tags. Required project tags cannot be overridden."
  default     = {}
}
