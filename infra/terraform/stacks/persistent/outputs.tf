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
