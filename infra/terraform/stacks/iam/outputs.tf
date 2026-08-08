# Every other stack consumes these as input variables. Nothing else in the
# project may create an IAM role — see ARCHITECTURE §9.5.

output "ecs_task_execution_role_arn" {
  value       = aws_iam_role.ecs_task_execution.arn
  description = "Fargate agent: ECR pull, logs, secret resolution."
}

output "ecs_task_role_arn" {
  value       = aws_iam_role.ecs_task.arn
  description = "Application runtime permissions."
}

output "lambda_pretoken_role_arn" {
  value       = aws_iam_role.lambda_pretoken.arn
  description = "Pre-token-generation Lambda, VPC-attached."
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "CI role for terraform apply on the default branch and approved environments."
}

output "github_plan_role_arn" {
  value       = aws_iam_role.github_plan.arn
  description = "CI role for terraform plan on pull requests. Read-only."
}

output "permissions_boundary_arn" {
  value       = aws_iam_policy.permissions_boundary.arn
  description = "Ceiling carried by every role in this stack, and required by name on any role the deploy role creates. Changing it is a human-run apply of this stack — the deploy role is explicitly denied rewriting it."
}

output "nat_instance_profile_name" {
  value       = aws_iam_instance_profile.ec2_nat.name
  description = "Instance profile for the dev NAT instance."
}

output "nat_role_arn" {
  value       = aws_iam_role.ec2_nat.arn
  description = "EC2-only role for the dev NAT instance."
}

output "oidc_provider_arn" {
  value       = local.oidc_provider_arn
  description = "The GitHub OIDC provider this stack created, or the pre-existing one it was told to reuse."
}

output "role_arns_env" {
  description = "Paste into TALON_ROLE_ARNS for the up.sh path that skips this stack (§9.5a)."
  value = join(",", [
    "ecs_task_execution=${aws_iam_role.ecs_task_execution.arn}",
    "ecs_task=${aws_iam_role.ecs_task.arn}",
    "lambda_pretoken=${aws_iam_role.lambda_pretoken.arn}",
    "nat_instance_profile=${aws_iam_instance_profile.ec2_nat.name}",
  ])
}
