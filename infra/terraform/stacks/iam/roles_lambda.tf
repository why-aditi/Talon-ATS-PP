# ---------------------------------------------------------------------------
# Pre-token-generation Lambda role.
#
# CLAUDE.md §4 and ARCHITECTURE §9.4: tenant_id, role and job membership live in
# our `users` table keyed by `sub`, never as Cognito custom attributes, and this
# Lambda is what injects them into the token at sign-in. It therefore needs to
# reach Aurora, which lives in isolated subnets — hence VPC attachment, hence
# the ENI permissions below.
#
# The function itself is created by stacks/persistent, which consumes this ARN
# as an input variable (§9.5): no aws_iam_role exists outside this stack.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    sid     = "LambdaAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    # Confused-deputy guard. Only aws:SourceAccount, not aws:SourceArn: the
    # function ARN is created by stacks/persistent, which already depends on this
    # stack's outputs, so naming it here would invert that into a cycle.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "lambda_pretoken" {
  name               = "${local.name}-lambda-pretoken"
  description        = "Cognito pre-token-generation Lambda for ${local.name}: reads claims from the users table."
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

# The ENI create/describe/delete set a VPC-attached Lambda needs. AWS maintains
# it; hand-rolling it means rediscovering the list from a function that times out
# at init with no useful error.
resource "aws_iam_role_policy_attachment" "lambda_pretoken_vpc" {
  role       = aws_iam_role.lambda_pretoken.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_pretoken" {
  statement {
    sid       = "ReadDatabaseCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.aws_region}:${local.account_id}:secret:${local.name}/db/*"]
  }

  # Scoped to the db/ prefix rather than the whole ${local.name}/ namespace: this
  # function only needs to connect to Postgres, and the same namespace holds the
  # application's other secrets.
  statement {
    sid    = "DecryptDatabaseCredentials"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.aws_region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "lambda_pretoken" {
  name   = "${local.name}-lambda-pretoken"
  role   = aws_iam_role.lambda_pretoken.id
  policy = data.aws_iam_policy_document.lambda_pretoken.json
}
