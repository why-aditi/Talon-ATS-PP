#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF="${TALON_TERRAFORM_BIN:-terraform}"
ENVIRONMENT="${TALON_ENV:-dev}"
REGION="${AWS_REGION:-us-east-1}"
ALL=false
[[ "${1:-}" == "--all" ]] && { ALL=true; shift; }
[[ $# -eq 0 ]] || { echo "Usage: scripts/down.sh [--all]" >&2; exit 2; }

EPHEMERAL="$ROOT_DIR/infra/terraform/stacks/ephemeral"
PERSISTENT="$ROOT_DIR/infra/terraform/stacks/persistent"
[[ -f "$EPHEMERAL/backend.tf" ]] || { echo "ERROR: run scripts/up.sh --bootstrap-only first." >&2; exit 1; }
python3 "$ROOT_DIR/infra/terraform/scripts/check-backend.py" "$EPHEMERAL" "ephemeral/terraform.tfstate"

echo "==> Destroy ephemeral resources for talon-$ENVIRONMENT"
$TF -chdir="$EPHEMERAL" destroy -input=false -auto-approve -var="aws_region=$REGION" -var="env=$ENVIRONMENT" \
  -var="profile=dev" -var="ecs_task_execution_role_arn=arn:aws:iam::000000000000:role/unused" \
  -var="ecs_task_role_arn=arn:aws:iam::000000000000:role/unused" -var="nat_instance_profile_name=unused" \
  -var="api_image=unused" -var="web_image=unused" -var="jobs_image=unused" -var="uploads_bucket_name=unused" \
  -var="cognito_user_pool_id=unused" -var="cognito_client_id=unused"

if $ALL; then
  expected="destroy talon-$ENVIRONMENT persistent"
  printf 'Type `%s` to delete Cognito, buckets, KMS, and ECR: ' "$expected"
  read -r confirmation
  [[ "$confirmation" == "$expected" ]] || { echo "Confirmation did not match; persistent resources preserved." >&2; exit 1; }
  python3 "$ROOT_DIR/infra/terraform/scripts/check-backend.py" "$PERSISTENT" "persistent/terraform.tfstate"
  $TF -chdir="$PERSISTENT" apply -input=false -auto-approve -var="deletion_protection=INACTIVE" -var="force_destroy_persistent_data=true"
  if ! $TF -chdir="$PERSISTENT" destroy -input=false -auto-approve -var="deletion_protection=INACTIVE" -var="force_destroy_persistent_data=true"; then
    echo "ERROR: persistent destroy failed after deletion protection was relaxed; rerun down.sh --all or restore protection with terraform apply." >&2
    exit 1
  fi
fi

echo "Teardown complete. IAM and global Terraform state were preserved."
