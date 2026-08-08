terraform {
  # 1.7 is the floor for `import` blocks with `for_each` (import.tf), which is
  # what makes the adoption path in README.md optional rather than permanent.
  # stacks/iam already requires 1.9 and ARCHITECTURE §9.5a's preflight requires
  # >= 1.9, so this costs nothing and is written as 1.9 for consistency.
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }

  # No `backend` block, for the same reason as stacks/iam: ARCHITECTURE §9.5a
  # stage 1 bootstraps the state bucket, and on a clean clone it does not exist
  # yet. `cp backend.tf.example backend.tf` to opt in; see README.md.
}
