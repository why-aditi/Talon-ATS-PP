provider "aws" {
  region = var.aws_region
  default_tags { tags = local.tags }
}

data "aws_availability_zones" "available" { state = "available" }
data "aws_ssm_parameter" "nat_ami" { name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64" }
data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}
