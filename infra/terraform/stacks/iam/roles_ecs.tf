# ---------------------------------------------------------------------------
# ECS roles.
#
# These live here, not in stacks/persistent or stacks/ephemeral, because no
# aws_iam_role may exist outside this stack (§9.5) — the highest-privilege code
# stays in one small reviewable place, and every other stack takes these ARNs as
# input variables so the TALON_ROLE_ARNS path in §9.5a keeps working for anyone
# cloning this without the IAM grant.
#
# Two roles, because they are two different trust levels wearing one name:
#   execution role — used by the ECS agent BEFORE the container starts, to pull
#                    the image and resolve secrets into the environment.
#   task role      — used by the application code INSIDE the container.
# Merging them would hand the application the ability to read every secret
# referenced by any task definition.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    sid     = "EcsTasksAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Confused-deputy guard: without these, any AWS account that can convince
    # the ECS service to act on its behalf could have it assume this role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${var.aws_region}:${local.account_id}:*"]
    }
  }
}

# ---------------------------------------------------------------------------
# Execution role
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${local.name}-ecs-task-execution"
  description        = "ECS agent role for ${local.name}: image pull, log stream creation, secret resolution."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# ECR pull + CreateLogStream/PutLogEvents. AWS maintains it; hand-rolling it
# means re-discovering the ecr:GetAuthorizationToken/BatchGetImage split by
# reading a task that failed to start.
resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid       = "ResolveTaskDefinitionSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.name}/*"]
  }

  statement {
    sid    = "ResolveTaskDefinitionParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
    ]
    resources = ["arn:${local.partition}:ssm:${var.aws_region}:${local.account_id}:parameter/${local.name}/*"]
  }

  statement {
    sid    = "DecryptSecretsForInjection"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    # Resource is "*" and the scoping is the condition, not the ARN: the
    # customer-managed key is created by stacks/persistent, which consumes role
    # ARNs from this stack. Referencing the key here would invert that
    # dependency into a cycle. kms:ViaService means this grant is only usable
    # through Secrets Manager and SSM — it cannot decrypt an S3 object or a
    # database snapshot. Set var.app_kms_key_arns and this can be narrowed
    # further on a second apply.
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "secretsmanager.${var.aws_region}.amazonaws.com",
        "ssm.${var.aws_region}.amazonaws.com",
      ]
    }
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "${local.name}-ecs-task-execution-secrets"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

# ---------------------------------------------------------------------------
# Task role — what the application itself may do.
#
# §9.9 wants per-service task roles (the calendar worker cannot read the uploads
# bucket). This is deliberately ONE role for now: web, api and workers all ship
# from the same image and only the api makes AWS calls in M0. Splitting it is a
# copy of this block per service once the worker entrypoints exist, and is
# tracked as an open question in docs/specs/002-infrastructure.md rather than
# guessed at here.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task" {
  name               = "${local.name}-ecs-task"
  description        = "Application runtime role for ${local.name} ECS tasks."
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

data "aws_iam_policy_document" "ecs_task" {
  statement {
    sid    = "CandidateFileObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = local.data_bucket_object_arns
  }

  statement {
    sid    = "CandidateFileBuckets"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = local.data_bucket_arns
  }

  statement {
    sid    = "Queues"
    effect = "Allow"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    # Queue names are not known here (stacks/ephemeral owns them) but their
    # prefix is, which is the whole point of the naming convention in §9.5.
    resources = ["arn:${local.partition}:sqs:${var.aws_region}:${local.account_id}:${local.name}-*"]
  }

  statement {
    sid       = "DomainEvents"
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = ["arn:${local.partition}:events:${var.aws_region}:${local.account_id}:event-bus/${local.name}"]
  }

  statement {
    sid    = "TransactionalEmail"
    effect = "Allow"
    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]
    # The verified identity is created outside this stack and its ARN embeds a
    # domain we do not have yet (§9.4: no custom domain), so the identity is
    # wildcarded and the configuration set — which carries the suppression and
    # event-destination rules — is prefix-scoped.
    resources = [
      "arn:${local.partition}:ses:${var.aws_region}:${local.account_id}:identity/*",
      "arn:${local.partition}:ses:${var.aws_region}:${local.account_id}:configuration-set/${local.name}-*",
    ]
  }

  statement {
    sid       = "RuntimeSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.name}/*"]
  }

  statement {
    sid    = "RuntimeParameters"
    effect = "Allow"
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath",
    ]
    resources = ["arn:${local.partition}:ssm:${var.aws_region}:${local.account_id}:parameter/${local.name}/*"]
  }

  statement {
    sid    = "TenantIdentityProviders"
    effect = "Allow"
    actions = [
      # §9.4: per-tenant SAML IdPs are created through the API at runtime, not
      # in Terraform, so this permission belongs to the application.
      "cognito-idp:CreateIdentityProvider",
      "cognito-idp:UpdateIdentityProvider",
      "cognito-idp:DeleteIdentityProvider",
      "cognito-idp:DescribeIdentityProvider",
      "cognito-idp:ListIdentityProviders",
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:AdminUpdateUserAttributes",
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
      "cognito-idp:AdminUserGlobalSignOut",
      "cognito-idp:ListUsers",
    ]
    # Pool ids are generated at create time and cannot be predicted here; set
    # var.cognito_user_pool_arns after stacks/persistent runs to pin this to the
    # one pool. Note the absence of AdminDeleteUser and of any schema action:
    # nothing the application does should be able to mutate pool schema (§9.4).
    resources = local.cognito_user_pool_arns
  }

  statement {
    sid    = "ServiceScopedEncryption"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "s3.${var.aws_region}.amazonaws.com",
        "secretsmanager.${var.aws_region}.amazonaws.com",
        "sqs.${var.aws_region}.amazonaws.com",
      ]
    }
  }

  # Direct KMS access for the column-level envelope encryption of candidate PII
  # (§9.9). No ViaService condition is possible — the app calls KMS itself — so
  # this statement only exists once a real key ARN has been supplied. There is
  # no wildcard fallback on purpose: kms:GenerateDataKey on "*" would let the
  # application decrypt anything in the account, including state and backups.
  dynamic "statement" {
    for_each = length(var.app_kms_key_arns) > 0 ? [1] : []

    content {
      sid    = "ColumnEnvelopeEncryption"
      effect = "Allow"
      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey",
      ]
      resources = var.app_kms_key_arns
    }
  }
}

resource "aws_iam_role_policy" "ecs_task" {
  name   = "${local.name}-ecs-task"
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.ecs_task.json
}
