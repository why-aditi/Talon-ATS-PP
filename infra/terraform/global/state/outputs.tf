output "state_bucket_name" {
  value       = aws_s3_bucket.state.id
  description = "S3 backend bucket for all non-bootstrap Terraform stacks."
}

output "state_lock_table_name" {
  value       = aws_dynamodb_table.locks.name
  description = "DynamoDB table used by Terraform state locking."
}

output "aws_region" {
  value       = var.aws_region
  description = "Region to pass to partial S3 backend configuration."
}
