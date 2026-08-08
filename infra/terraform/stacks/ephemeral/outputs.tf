output "app_url" { value = "https://${aws_cloudfront_distribution.main.domain_name}" }
output "cluster_arn" { value = aws_ecs_cluster.main.arn }
output "private_subnet_ids" { value = values(aws_subnet.private)[*].id }
output "task_security_group_id" { value = aws_security_group.tasks.id }
output "oneoff_task_definition_arn" { value = aws_ecs_task_definition.oneoff.arn }
output "oneoff_container_name" { value = "oneoff" }
output "database_owner_secret_arn" { value = aws_secretsmanager_secret.owner_url.arn }
output "demo_password_secret_arn" { value = aws_secretsmanager_secret.demo_password.arn }
