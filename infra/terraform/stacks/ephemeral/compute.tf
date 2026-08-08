resource "aws_ecs_cluster" "main" {
  name = local.name
}
resource "aws_cloudwatch_log_group" "api" {
  name              = "/talon/${var.env}/api"
  retention_in_days = 14
}
resource "aws_cloudwatch_log_group" "web" {
  name              = "/talon/${var.env}/web"
  retention_in_days = 14
}

locals {
  common_environment = [
    {
      name = "AWS_REGION"
    value = var.aws_region },
    {
      name = "COGNITO_REGION"
    value = var.aws_region },
    {
      name = "COGNITO_USER_POOL_ID"
    value = var.cognito_user_pool_id },
    {
      name = "COGNITO_CLIENT_ID"
    value = var.cognito_client_id },
    {
      name = "REDIS_URL"
    value = "redis://${aws_elasticache_cluster.main.cache_nodes[0].address}:6379" },
    {
      name = "TALON_UPLOADS_BUCKET"
    value = var.uploads_bucket_name },
  ]
  api_secrets = [
    {
      name = "API_DATABASE_URL"
    valueFrom = aws_secretsmanager_secret.app_url.arn },
    {
      name = "TALON_JWT_SECRET"
    valueFrom = aws_secretsmanager_secret.jwt.arn },
  ]
  log_options = {
    awslogs-region = var.aws_region, awslogs-stream-prefix = "ecs"
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.ecs_task_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn
  container_definitions    = jsonencode([{ name = "api", image = var.api_image, essential = true, portMappings = [{ containerPort = 3001 }], environment = local.common_environment, secrets = local.api_secrets, logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = aws_cloudwatch_log_group.api.name }) } }])
}
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.ecs_task_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn
  container_definitions = jsonencode([{ name = "web", image = var.web_image, essential = true, portMappings = [{ containerPort = 3000 }], environment = [
    { name = "PORT", value = "3000" },
    { name = "TALON_API_URL", value = "http://${aws_lb.main.dns_name}" },
    { name = "APP_ORIGIN", value = "https://${aws_cloudfront_distribution.main.domain_name}" },
    { name = "COGNITO_CLIENT_ID", value = var.cognito_client_id },
  ], logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = aws_cloudwatch_log_group.web.name }) } }])
}
resource "aws_ecs_task_definition" "oneoff" {
  family                   = "${local.name}-oneoff"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.ecs_task_execution_role_arn
  task_role_arn            = var.ecs_task_role_arn
  container_definitions    = jsonencode([{ name = "oneoff", image = var.jobs_image, essential = true, command = ["pnpm", "db:migrate"], environment = local.common_environment, secrets = concat(local.api_secrets, [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.owner_url.arn }, { name = "TALON_APP_PASSWORD", valueFrom = aws_secretsmanager_secret.app_password.arn }, { name = "SEED_PASSWORD", valueFrom = aws_secretsmanager_secret.demo_password.arn }]), logConfiguration = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-group = aws_cloudwatch_log_group.api.name }) } }])
}

resource "aws_lb" "main" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = values(aws_subnet.public)[*].id
}
resource "aws_security_group" "alb" {
  name   = "${local.name}-alb"
  vpc_id = aws_vpc.main.id
  ingress {
    protocol        = "tcp"
    from_port       = 80
    to_port         = 80
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront_origin.id]
  }
  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group_rule" "tasks_to_alb" {
  type                     = "ingress"
  security_group_id        = aws_security_group.alb.id
  source_security_group_id = aws_security_group.tasks.id
  protocol                 = "tcp"
  from_port                = 80
  to_port                  = 80
}
resource "aws_security_group_rule" "alb_to_api" {
  type                     = "ingress"
  security_group_id        = aws_security_group.tasks.id
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 3001
  to_port                  = 3001
}
resource "aws_security_group_rule" "alb_to_web" {
  type                     = "ingress"
  security_group_id        = aws_security_group.tasks.id
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 3000
  to_port                  = 3000
}
resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path = "/v1/readyz"
  }
}
resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"
  health_check {
    path = "/"
  }
}
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
  condition {
    path_pattern { values = ["/v1", "/v1/*"] }
  }
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }
  depends_on = [aws_lb_listener_rule.api]
}
resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
  depends_on = [aws_lb_listener.http]
}
