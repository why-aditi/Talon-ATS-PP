variable "name_prefix" {
  type    = string
  default = "talon"
}
variable "env" {
  type    = string
  default = "dev"
}
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "profile" {
  type    = string
  default = "dev"
  validation {
    condition     = var.profile == "dev"
    error_message = "The ephemeral stack currently implements only profile=dev; profile=spec is intentionally rejected."
  }
}
variable "tags" {
  type    = map(string)
  default = {}
}
variable "ecs_task_execution_role_arn" { type = string }
variable "ecs_task_role_arn" { type = string }
variable "nat_instance_profile_name" { type = string }
variable "api_image" { type = string }
variable "web_image" { type = string }
variable "jobs_image" { type = string }
variable "uploads_bucket_name" { type = string }
variable "cognito_user_pool_id" { type = string }
variable "cognito_client_id" { type = string }
variable "database_name" {
  type    = string
  default = "talon"
}

locals {
  name = "${var.name_prefix}-${var.env}"
  tags = merge({ Project = "talon", Env = var.env, ManagedBy = "terraform", Stack = "ephemeral" }, var.tags)
  azs  = slice(data.aws_availability_zones.available.names, 0, 3)
}
