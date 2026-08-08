data "aws_iam_policy_document" "ec2_nat_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_nat" {
  name                 = "${local.name}-ec2-nat"
  assume_role_policy   = data.aws_iam_policy_document.ec2_nat_assume.json
  permissions_boundary = local.permissions_boundary_arn
  tags                 = local.tags
}

resource "aws_iam_instance_profile" "ec2_nat" {
  name = "${local.name}-ec2-nat"
  role = aws_iam_role.ec2_nat.name
  tags = local.tags
}

# These account-level roles are prerequisites on a genuinely clean account.
# Set create_service_linked_roles=false when the shared account already has them.
resource "aws_iam_service_linked_role" "ecs" {
  count            = var.create_service_linked_roles ? 1 : 0
  aws_service_name = "ecs.amazonaws.com"
  description      = "Service-linked role for Talon ECS services"
}

resource "aws_iam_service_linked_role" "rds" {
  count            = var.create_service_linked_roles ? 1 : 0
  aws_service_name = "rds.amazonaws.com"
  description      = "Service-linked role for Talon RDS"
}

resource "aws_iam_service_linked_role" "elasticache" {
  count            = var.create_service_linked_roles ? 1 : 0
  aws_service_name = "elasticache.amazonaws.com"
  description      = "Service-linked role for Talon ElastiCache"
}
