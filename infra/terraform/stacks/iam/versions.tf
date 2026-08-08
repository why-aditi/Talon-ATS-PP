terraform {
  # 1.9 is the floor because the subject-claim validations in variables.tf
  # reference another variable (`github_repo`) from inside a `validation` block,
  # which only became legal in Terraform 1.9. ARCHITECTURE §9.5a's preflight
  # already requires >= 1.9, so this costs nothing.
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # There is deliberately NO `backend` block here.
  #
  # ARCHITECTURE §9.5a orders provisioning as: stage 1 bootstraps the S3 state
  # bucket + DynamoDB lock table, stage 2 applies this stack. So on a clean
  # clone the bucket does not exist yet, and a declared S3 backend would make
  # `terraform init` either fail or prompt interactively for bucket/key/region.
  # Omitting the backend means `terraform init` succeeds with zero AWS
  # credentials and zero pre-existing infrastructure, which is the property the
  # single-command deliverable depends on.
  #
  # Migration to the shared backend, once stage 1 has run — the exact command,
  # with every -backend-config flag, is in README.md in this directory.
  #
  #   cp backend.tf.example backend.tf
  #   terraform init -migrate-state -backend-config="bucket=..." ...
  #
  # `backend.tf` is gitignored (see /.gitignore) so the local-state default stays
  # the checked-in behaviour and an operator opts in explicitly. The block in
  # backend.tf.example is empty because a backend block cannot interpolate
  # variables and the bucket name embeds the account id.
}
