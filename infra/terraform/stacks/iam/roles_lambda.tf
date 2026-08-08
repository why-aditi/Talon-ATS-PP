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

    # Confused-deputy guard, aws:SourceAccount only.
    #
    # This used to claim aws:SourceArn was omitted because naming the function
    # would create a dependency cycle. That was wrong and is corrected here: the
    # function ARN is constructible from the naming convention without referring
    # to stacks/persistent at all —
    # `arn:aws:lambda:<region>:<account>:function:talon-dev-*` — exactly as the
    # Secrets Manager and SSM ARNs below are constructed. There is no cycle.
    #
    # The real reason it is absent is that it is unverified. AWS documents
    # aws:SourceArn for the ECS task trust policy above, and documents
    # confused-deputy prevention for Lambda on the FUNCTION's resource policy;
    # it does not document that Lambda populates aws:SourceArn when it assumes an
    # EXECUTION role. If it does not, this condition never matches, the function
    # cannot assume its role, and the symptom is that sign-in stops issuing
    # claims — a broken login with an error message about the token generator,
    # discovered in production rather than in a plan.
    #
    # The marginal gain is small: aws:SourceAccount already blocks the
    # cross-account case that "confused deputy" names, and reaching this role
    # in-account requires iam:PassRole on `talon-dev-*`, which only the deploy
    # role has and which is now itself scoped by iam:PassedToService. Add the
    # ArnLike condition once the first apply proves Lambda sets the key —
    # tracked as open question 5 in docs/specs/002-infrastructure.md.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "lambda_pretoken" {
  name                 = "${local.name}-lambda-pretoken"
  description          = "Cognito pre-token-generation Lambda for ${local.name}: reads claims from the users table."
  assume_role_policy   = data.aws_iam_policy_document.lambda_trust.json
  permissions_boundary = aws_iam_policy.permissions_boundary.arn
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
