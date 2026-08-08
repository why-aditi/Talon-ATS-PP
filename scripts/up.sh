#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWS="${TALON_AWS_BIN:-aws}"
TF="${TALON_TERRAFORM_BIN:-terraform}"
DOCKER="${TALON_DOCKER_BIN:-docker}"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="${TALON_NAME_PREFIX:-talon}"
ENVIRONMENT="${TALON_ENV:-dev}"
PROFILE="${TALON_PROFILE:-dev}"
BOOTSTRAP_ONLY=false
RESET_DEMO=false

while (($#)); do
  case "$1" in
    --bootstrap-only) BOOTSTRAP_ONLY=true ;;
    --reset-demo) RESET_DEMO=true ;;
    *) echo "Usage: scripts/up.sh [--bootstrap-only] [--reset-demo]" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n==> %s\n' "$1"; }
fail() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"; }
tfout() { "$TF" -chdir="$1" output -raw "$2"; }

step "0/9 Preflight"
for command in "$AWS" "$TF" "$DOCKER" python3 git curl; do need "$command"; done
TF_VERSION="$($TF version -json | python3 -c 'import json,sys; print(json.load(sys.stdin)["terraform_version"])')"
python3 - "$TF_VERSION" <<'PY' || fail "Terraform >= 1.9.0 is required; found $TF_VERSION."
import sys
v=tuple(map(int,sys.argv[1].split('-',1)[0].split('.')[:3]))
raise SystemExit(0 if v >= (1,9,0) else 1)
PY
ACCOUNT_ID="$($AWS sts get-caller-identity --query Account --output text)" || fail "AWS credentials are missing or invalid."
$DOCKER info >/dev/null 2>&1 || fail "Docker daemon is not running."
[[ "$PROFILE" == dev ]] || fail "Only TALON_PROFILE=dev is currently safe and implemented."
echo "AWS account: $ACCOUNT_ID | region: $REGION | environment: $ENVIRONMENT | Terraform: $TF_VERSION"

STATE_BUCKET="${TF_STATE_BUCKET:-${PREFIX}-tfstate-${ACCOUNT_ID}}"
LOCK_TABLE="${TF_STATE_LOCK_TABLE:-${PREFIX}-tfstate-lock}"
ADOPT_BUCKET=false; ADOPT_TABLE=false
$AWS s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null 2>&1 && ADOPT_BUCKET=true
$AWS dynamodb describe-table --region "$REGION" --table-name "$LOCK_TABLE" >/dev/null 2>&1 && ADOPT_TABLE=true

step "1/9 Bootstrap remote state"
STATE="$ROOT_DIR/infra/terraform/global/state"
$TF -chdir="$STATE" init -input=false -backend=false
$TF -chdir="$STATE" apply -input=false -auto-approve \
  -var="aws_region=$REGION" -var="name_prefix=$PREFIX" \
  -var="state_bucket_name=$STATE_BUCKET" -var="state_lock_table_name=$LOCK_TABLE" \
  -var="adopt_state_bucket=$ADOPT_BUCKET" -var="adopt_state_lock_table=$ADOPT_TABLE"

for stack_name in iam persistent ephemeral; do
  stack="$ROOT_DIR/infra/terraform/stacks/$stack_name"
  [[ -f "$stack/backend.tf" ]] || cp "$stack/backend.tf.example" "$stack/backend.tf"
  $TF -chdir="$stack" init -input=false -migrate-state -force-copy \
    -backend-config="bucket=$STATE_BUCKET" -backend-config="key=$stack_name/terraform.tfstate" \
    -backend-config="region=$REGION" -backend-config="dynamodb_table=$LOCK_TABLE" -backend-config="encrypt=true"
  python3 "$ROOT_DIR/infra/terraform/scripts/check-backend.py" "$stack" "$stack_name/terraform.tfstate"
done
$BOOTSTRAP_ONLY && { echo "Terraform bootstrap complete. No application resources were deployed."; exit 0; }

IAM="$ROOT_DIR/infra/terraform/stacks/iam"
PERSISTENT="$ROOT_DIR/infra/terraform/stacks/persistent"
EPHEMERAL="$ROOT_DIR/infra/terraform/stacks/ephemeral"

declare -A ROLES
if [[ -n "${TALON_ROLE_ARNS:-}" ]]; then
  step "2/9 Use supplied IAM roles"
  IFS=',' read -ra pairs <<< "$TALON_ROLE_ARNS"
  for pair in "${pairs[@]}"; do ROLES["${pair%%=*}"]="${pair#*=}"; done
  for key in ecs_task_execution ecs_task lambda_pretoken nat_instance_profile; do
    [[ -n "${ROLES[$key]:-}" ]] || fail "TALON_ROLE_ARNS is missing $key"
  done
  for key in ecs_task_execution ecs_task lambda_pretoken; do
    [[ "${ROLES[$key]}" =~ ^arn:[^:]+:iam::${ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]] \
      || fail "TALON_ROLE_ARNS value for $key is not an IAM role ARN"
  done
  [[ "${ROLES[nat_instance_profile]}" =~ ^${PREFIX}-${ENVIRONMENT}-ec2-[A-Za-z0-9+=,.@_-]+$ ]] \
    || fail "nat_instance_profile must start with ${PREFIX}-${ENVIRONMENT}-ec2-"
else
  step "2/9 Apply IAM"
  REPO="${TALON_GITHUB_REPO:-${GITHUB_REPOSITORY:-}}"
  if [[ -z "$REPO" ]]; then
    remote="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
    REPO="$(printf '%s' "$remote" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')"
  fi
  [[ "$REPO" == */* ]] || fail "Set TALON_GITHUB_REPO=OWNER/REPO for the IAM trust policy."
  $TF -chdir="$IAM" apply -input=false -auto-approve -var="github_repo=$REPO" -var="aws_region=$REGION" -var="env=$ENVIRONMENT"
  ROLES[ecs_task_execution]="$(tfout "$IAM" ecs_task_execution_role_arn)"
  ROLES[ecs_task]="$(tfout "$IAM" ecs_task_role_arn)"
  ROLES[lambda_pretoken]="$(tfout "$IAM" lambda_pretoken_role_arn)"
  ROLES[nat_instance_profile]="$(tfout "$IAM" nat_instance_profile_name)"
fi

step "3/9 Apply persistent resources"
$TF -chdir="$PERSISTENT" apply -input=false -auto-approve \
  -var="aws_region=$REGION" -var="env=$ENVIRONMENT" \
  -var="lambda_pretoken_role_arn=${ROLES[lambda_pretoken]}" \
  -var="user_pool_domain_prefix=${PREFIX}-${ENVIRONMENT}-auth-${ACCOUNT_ID}"
POOL_ID="$(tfout "$PERSISTENT" user_pool_id)"
POOL_ARN="$(tfout "$PERSISTENT" user_pool_arn)"
CLIENT_ID="$(tfout "$PERSISTENT" user_pool_client_id)"
KMS_ARN="$(tfout "$PERSISTENT" kms_key_arn)"
ECR_NAME="$(tfout "$PERSISTENT" ecr_repository_name)"
ECR_URL="$(tfout "$PERSISTENT" ecr_repository_url)"
UPLOADS_BUCKET="$($TF -chdir="$PERSISTENT" output -json data_bucket_names | python3 -c 'import json,sys; print(json.load(sys.stdin)["uploads"])')"
if [[ -z "${TALON_ROLE_ARNS:-}" ]]; then
  $TF -chdir="$IAM" apply -input=false -auto-approve -var="github_repo=$REPO" \
    -var="aws_region=$REGION" -var="env=$ENVIRONMENT" \
    -var="app_kms_key_arns=[\"$KMS_ARN\"]" -var="cognito_user_pool_arns=[\"$POOL_ARN\"]"
fi

step "4/9 Build and push immutable images"
git -C "$ROOT_DIR" diff --quiet && git -C "$ROOT_DIR" diff --cached --quiet \
  || fail "Refusing to tag uncommitted content with a Git SHA. Commit or stash changes first."
SHA="$(git -C "$ROOT_DIR" rev-parse HEAD)"
$AWS ecr get-login-password --region "$REGION" | $DOCKER login --username AWS --password-stdin "${ECR_URL%%/*}" >/dev/null
for target in api web jobs; do
  tag="$SHA-$target"
  if ! $AWS ecr describe-images --repository-name "$ECR_NAME" --image-ids "imageTag=$tag" --region "$REGION" >/dev/null 2>&1; then
    $DOCKER build --target "$target" -t "$ECR_URL:$tag" "$ROOT_DIR"
    $DOCKER push "$ECR_URL:$tag"
  else
    echo "Image already exists: $ECR_URL:$tag"
  fi
done

step "5/9 Apply ephemeral dev infrastructure"
$TF -chdir="$EPHEMERAL" apply -input=false -auto-approve \
  -var="aws_region=$REGION" -var="env=$ENVIRONMENT" -var="profile=$PROFILE" \
  -var="ecs_task_execution_role_arn=${ROLES[ecs_task_execution]}" \
  -var="ecs_task_role_arn=${ROLES[ecs_task]}" \
  -var="nat_instance_profile_name=${ROLES[nat_instance_profile]}" \
  -var="api_image=$ECR_URL:$SHA-api" -var="web_image=$ECR_URL:$SHA-web" \
  -var="jobs_image=$ECR_URL:$SHA-jobs" -var="uploads_bucket_name=$UPLOADS_BUCKET" \
  -var="cognito_user_pool_id=$POOL_ID" -var="cognito_client_id=$CLIENT_ID"

CLUSTER="$(tfout "$EPHEMERAL" cluster_arn)"
TASK_DEF="$(tfout "$EPHEMERAL" oneoff_task_definition_arn)"
SUBNETS="$($TF -chdir="$EPHEMERAL" output -json private_subnet_ids | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)))')"
TASK_SG="$(tfout "$EPHEMERAL" task_security_group_id)"
APP_URL="$(tfout "$EPHEMERAL" app_url)"

run_oneoff() {
  local label="$1"; shift
  local command_json task_arn exit_code reason
  command_json="$(python3 -c 'import json,sys; print(json.dumps({"containerOverrides":[{"name":"oneoff","command":sys.argv[1:]}]}))' "$@")"
  task_arn="$($AWS ecs run-task --region "$REGION" --cluster "$CLUSTER" --task-definition "$TASK_DEF" \
    --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$TASK_SG],assignPublicIp=DISABLED}" \
    --overrides "$command_json" --query 'tasks[0].taskArn' --output text)"
  [[ "$task_arn" != None && -n "$task_arn" ]] || fail "$label task did not start."
  $AWS ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn"
  exit_code="$($AWS ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].containers[?name==`oneoff`].exitCode | [0]' --output text)"
  reason="$($AWS ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$task_arn" --query 'tasks[0].stoppedReason' --output text)"
  [[ "$exit_code" == 0 ]] || fail "$label task failed (exit=$exit_code, reason=$reason)."
}

step "6/9 Run database migrations"
run_oneoff migration node packages/db/dist/migrate.js up

step "7/9 Seed demo data safely"
if $RESET_DEMO; then
  run_oneoff seed node packages/db/dist/seed.js
else
  run_oneoff seed node packages/db/dist/seed.js --if-empty
fi

step "8/9 Provision and bind Cognito identities"
run_oneoff identities node apps/api/dist/scripts/seed-identities.js

step "9/9 Verify readiness"
ready=false
for attempt in $(seq 1 60); do
  if curl --fail --silent --max-time 5 "$APP_URL/v1/readyz" | python3 -c 'import json,sys; raise SystemExit(0 if json.load(sys.stdin).get("ok") is True else 1)' 2>/dev/null; then
    ready=true; break
  fi
  sleep 5
done
$ready || fail "Application did not become ready at $APP_URL/v1/readyz within five minutes."
DEMO_SECRET_ARN="$(tfout "$EPHEMERAL" demo_password_secret_arn)"
DEMO_PASSWORD="$($AWS secretsmanager get-secret-value --region "$REGION" --secret-id "$DEMO_SECRET_ARN" --query SecretString --output text)"
echo
echo "Talon is ready: $APP_URL"
echo "Demo login: maya@taloninc.com"
echo "Demo password: $DEMO_PASSWORD"
