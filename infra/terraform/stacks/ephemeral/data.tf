resource "random_password" "db_owner" {
  length  = 32
  special = false
}
resource "random_password" "db_app" {
  length  = 32
  special = false
}
resource "random_password" "jwt" {
  length  = 64
  special = false
}
resource "random_password" "demo" {
  length  = 32
  special = false
}
resource "random_id" "final_snapshot" {
  byte_length = 4
}

resource "aws_security_group" "tasks" {
  name   = "${local.name}-tasks"
  vpc_id = aws_vpc.main.id
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "data" {
  name   = "${local.name}-data"
  vpc_id = aws_vpc.main.id
  ingress {
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.tasks.id]
  }
  ingress {
    protocol        = "tcp"
    from_port       = 6379
    to_port         = 6379
    security_groups = [aws_security_group.tasks.id]
  }
}
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = values(aws_subnet.private)[*].id
}
resource "aws_db_instance" "main" {
  identifier                = "${local.name}-postgres"
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = "db.t4g.micro"
  allocated_storage         = 20
  max_allocated_storage     = 100
  storage_encrypted         = true
  db_name                   = var.database_name
  username                  = "talon"
  password                  = random_password.db_owner.result
  db_subnet_group_name      = aws_db_subnet_group.main.name
  vpc_security_group_ids    = [aws_security_group.data.id]
  publicly_accessible       = false
  multi_az                  = false
  deletion_protection       = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final-${random_id.final_snapshot.hex}"
  backup_retention_period   = 1
  apply_immediately         = true
}
resource "aws_elasticache_subnet_group" "main" {
  name       = local.name
  subnet_ids = values(aws_subnet.private)[*].id
}
resource "aws_elasticache_cluster" "main" {
  cluster_id           = "${local.name}-redis"
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.data.id]
}

locals {
  owner_url = "postgres://talon:${random_password.db_owner.result}@${aws_db_instance.main.address}:5432/${var.database_name}"
  app_url   = "postgres://talon_app:${random_password.db_app.result}@${aws_db_instance.main.address}:5432/${var.database_name}"
}
resource "aws_secretsmanager_secret" "owner_url" {
  name = "${local.name}/database-owner-url"
}
resource "aws_secretsmanager_secret_version" "owner_url" {
  secret_id     = aws_secretsmanager_secret.owner_url.id
  secret_string = local.owner_url
}
resource "aws_secretsmanager_secret" "app_url" {
  name = "${local.name}/database-app-url"
}
resource "aws_secretsmanager_secret_version" "app_url" {
  secret_id     = aws_secretsmanager_secret.app_url.id
  secret_string = local.app_url
}
resource "aws_secretsmanager_secret" "app_password" {
  name = "${local.name}/database-app-password"
}
resource "aws_secretsmanager_secret_version" "app_password" {
  secret_id     = aws_secretsmanager_secret.app_password.id
  secret_string = random_password.db_app.result
}
resource "aws_secretsmanager_secret" "jwt" {
  name = "${local.name}/jwt-secret"
}
resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}
resource "aws_secretsmanager_secret" "demo_password" {
  name = "${local.name}/demo-password"
}
resource "aws_secretsmanager_secret_version" "demo_password" {
  secret_id     = aws_secretsmanager_secret.demo_password.id
  secret_string = random_password.demo.result
}
