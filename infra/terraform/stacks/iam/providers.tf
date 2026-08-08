provider "aws" {
  region = var.aws_region

  # ARCHITECTURE §9.5: every resource is tagged Project/Env/ManagedBy. Applying
  # them as provider default_tags means a new resource cannot forget them.
  default_tags {
    tags = local.tags
  }
}

# Neither of these calls AWS at validate time; aws_caller_identity does at plan
# time, which is why `terraform plan` needs credentials and `validate` does not.
data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}
