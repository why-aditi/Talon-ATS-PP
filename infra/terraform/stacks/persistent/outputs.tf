output "user_pool_id" {
  value       = aws_cognito_user_pool.main.id
  description = "COGNITO_USER_POOL_ID for the API."
}

output "user_pool_arn" {
  value       = aws_cognito_user_pool.main.arn
  description = "Feed back into stacks/iam as -var cognito_user_pool_arns='[\"...\"]' on its second apply, so the ECS task role can manage per-tenant SAML IdPs at runtime (§9.4). That stack has no wildcard fallback on purpose."
}

output "user_pool_endpoint" {
  value       = aws_cognito_user_pool.main.endpoint
  description = "Issuer host for JWT verification, i.e. the `iss` claim minus the scheme."
}

output "user_pool_client_id" {
  value       = aws_cognito_user_pool_client.api.id
  description = "COGNITO_CLIENT_ID for the API. Not a secret — the client has no secret and this value ships to the browser."
}

output "auth_domain" {
  description = "Hosted auth domain, or empty when no domain is configured. Empty means /oauth2/authorize and /oauth2/token do not exist, so social and SAML sign-in are unreachable and refresh is absolute rather than sliding."
  value = length(aws_cognito_user_pool_domain.main) > 0 ? (
    "https://${aws_cognito_user_pool_domain.main[0].domain}.auth.${var.aws_region}.amazoncognito.com"
  ) : ""
}

output "cognito_env" {
  description = "Paste into .env for the API. Matches the variable names in .env.example."
  value = join("\n", compact([
    "COGNITO_USER_POOL_ID=${aws_cognito_user_pool.main.id}",
    "COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.api.id}",
    "AWS_REGION=${var.aws_region}",
    length(aws_cognito_user_pool_domain.main) > 0 ? "COGNITO_AUTH_DOMAIN=https://${aws_cognito_user_pool_domain.main[0].domain}.auth.${var.aws_region}.amazoncognito.com" : "",
  ]))
}

output "kms_key_id" {
  value       = aws_kms_key.application.key_id
  description = "Application KMS key id."
}

output "kms_key_arn" {
  value       = aws_kms_key.application.arn
  description = "Feed back into stacks/iam as app_kms_key_arns so the task role can perform direct envelope encryption."
}

output "kms_alias_name" {
  value       = aws_kms_alias.application.name
  description = "Stable alias for the application KMS key."
}

output "data_bucket_names" {
  value       = { for name, bucket in aws_s3_bucket.data : name => bucket.id }
  description = "Application data bucket names keyed by uploads, exports, inbound-mail, and quarantine."
}

output "data_bucket_arns" {
  value       = { for name, bucket in aws_s3_bucket.data : name => bucket.arn }
  description = "Application data bucket ARNs keyed by purpose."
}

output "imports_env" {
  value       = "TALON_UPLOADS_BUCKET=${aws_s3_bucket.data["quarantine"].id}"
  description = "Runtime configuration for direct candidate CSV uploads."
}

output "ecr_repository_name" {
  value       = aws_ecr_repository.application.name
  description = "Repository name used by the image build and push stage."
}

output "ecr_repository_arn" {
  value       = aws_ecr_repository.application.arn
  description = "Application ECR repository ARN."
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.application.repository_url
  description = "Repository URL consumed by stages 4 and 5."
}
