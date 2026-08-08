# `stacks/persistent`

The half of the infrastructure that **survives a teardown**. ARCHITECTURE §9.6
splits the stacks by lifetime rather than by service: `persistent` is applied
once and rarely destroyed, `ephemeral` (VPC, NAT, RDS, Redis, ECS, ALB) is torn
down between work sessions to control cost. A resource in the wrong half is
either an unexpected bill or a lost user.

Today this stack holds the Cognito user pool, its app client, and the hosted
auth domain. ECR, S3 and KMS land here as they are built.

It creates **no IAM role** — ARCHITECTURE §9.5 allows those only in
`stacks/iam`, and this stack takes their ARNs as input variables. That is what
keeps the `TALON_ROLE_ARNS` path in §9.5a working for anyone cloning this
without the IAM grant.

## Applying it

```bash
terraform -chdir=infra/terraform/stacks/persistent init
terraform -chdir=infra/terraform/stacks/persistent plan
```

No required variables: on a clean account this plans a fresh pool named
`talon-dev` (ARCHITECTURE §9.4) and a client named `talon-dev-api`. That is the
path §9.5a's acceptance test exercises — *tear everything down, run it again
from nothing, sign in* — so it has to work with no arguments.

Once the pool exists, feed its ARN back into `stacks/iam`, which has no
wildcard fallback for it on purpose:

```bash
terraform -chdir=infra/terraform/stacks/iam apply \
  -var 'github_repo=OWNER/REPO' \
  -var "cognito_user_pool_arns=[\"$(terraform -chdir=infra/terraform/stacks/persistent output -raw user_pool_arn)\"]"
```

## The user pool — read before editing `cognito.tf`

Cognito schema attributes are **immutable**, and `aws_cognito_user_pool` forces
replacement on a schema diff. **A replacement destroys every user.** Three
defences, in order of how much they actually do:

1. **No custom attributes, ever.** `tenant_id`, roles and job membership live in
   the `users` table keyed by `sub`; the pre-token-generation Lambda injects them
   as claims. If you think you need a custom attribute, you need a database
   column. With no custom attributes there is no legitimate reason for the schema
   to change at all.
2. **`lifecycle { ignore_changes = [schema] }`** on the pool. The provider
   populates `schema` from the twenty-odd standard OIDC attributes AWS creates
   automatically, so without this line an imported pool shows a permanent schema
   diff — and therefore a permanent replacement.
3. **The CI gate** in `.github/workflows/terraform.yml`, which runs
   `infra/terraform/scripts/check-plan.py` over `terraform show -json` and fails
   any plan replacing the pool. Defences 1 and 2 are properties of this file;
   defence 3 is what catches someone editing this file.

Deliberately **not** `prevent_destroy`: §9.5a rules it out because it cannot be
parameterized and blocks `scripts/down.sh`. `deletion_protection` is the
parameterizable equivalent and defaults to `ACTIVE`.

## The auth domain — what unblocks SSO

Without a domain there is no `/oauth2/authorize` and no `/oauth2/token`, so
Google and per-tenant SAML sign-in are unreachable and the refresh window is
**absolute rather than sliding**. Set the prefix to create one:

```bash
terraform -chdir=infra/terraform/stacks/persistent apply -var 'user_pool_domain_prefix=talon-dev-auth'
```

The prefix is **globally unique across every AWS account** in the region, and a
collision fails at apply, not at plan. Check first — an empty `DomainDescription`
means it is free:

```bash
aws cognito-idp describe-user-pool-domain --domain talon-dev-auth
```

No custom domain: §9.4 rules out a Route 53 zone and an ACM cert, and Google
OAuth callbacks work against the `*.amazoncognito.com` name.

The OAuth settings (`oauth_callback_urls`, `oauth_flows`, `oauth_scopes`,
`supported_identity_providers`) all default to empty/off, so adding the domain
changes nothing for the password flow the API uses today. Spec 003 sets them.
Per-tenant SAML IdPs are created at **runtime through the API** (§9.4) and must
never appear in `supported_identity_providers` — managing them as infrastructure
would make customer onboarding a deploy.

## Adopting a pool that already exists

A user pool was created by hand with the AWS CLI before this stack existed. It
holds real sign-ins, so it is adopted rather than replaced:

```bash
terraform -chdir=infra/terraform/stacks/persistent plan \
  -var 'adopt_user_pool={id="us-east-1_XXXXXXXX",name="<exact live name>",client_id="XXXX",client_name="<exact live name>"}'
```

`import` blocks, not `terraform import`. The difference matters: an `import`
block is visible in `terraform plan` **before** anything is written, so "no
replacement" is a claim a reviewer can check rather than something discovered
after the state file has already changed.

### The hazard, stated plainly

Adoption pins the pool's name to the live value **forever**. The name is
immutable in Cognito and ForceNew in the provider, so the day someone runs a
plan without `var.adopt_user_pool`, Terraform proposes to destroy that pool and
every user in it.

Two things reduce that risk and neither eliminates it:

- `adopt_user_pool` is a single **object**, so the id cannot be supplied without
  the name. The specific mistake of importing a pool while leaving the name at
  its default — which plans a replacement — is unrepresentable.
- The CI gate catches the resulting plan. Verified: with a deliberately
  mismatched name the check fails with
  `REPLACE aws_cognito_user_pool.main ... forced by: name`.

**Put the value in `terraform.tfvars`, not on the command line.** A value that
must be remembered on every invocation is a value that will be forgotten once,
and once is enough.

## Checking a plan by hand

```bash
terraform -chdir=infra/terraform/stacks/persistent plan -out=tf.plan
terraform -chdir=infra/terraform/stacks/persistent show -json tf.plan > plan.json
python infra/terraform/scripts/check-plan.py plan.json
```

Exits non-zero if any `aws_cognito_user_pool`, `aws_rds_cluster`,
`aws_db_instance`, KMS key, S3 bucket or DynamoDB table would be replaced or
destroyed. Override with a written reason of at least 20 characters in
`TALON_ALLOW_STATEFUL_REPLACE`; the reason is printed into the log.

## State backend

Same as `stacks/iam`: no backend block is checked in, so `terraform init` works
on a clean clone before the state bucket exists (§9.5a stage 1).

```bash
cp backend.tf.example backend.tf     # backend.tf is gitignored
terraform init -migrate-state \
  -backend-config="bucket=talon-tfstate-$(aws sts get-caller-identity --query Account --output text)" \
  -backend-config="key=persistent/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="dynamodb_table=talon-tfstate-lock" \
  -backend-config="encrypt=true"
```

`key=persistent/terraform.tfstate` — a **different** key from `stacks/iam`, or
the two stacks share state and the lifetime split stops meaning anything.

## Files

| File | Contents |
|---|---|
| `cognito.tf` | User pool, app client, hosted domain |
| `import.tf` | Gated `import` blocks for adopting a pre-existing pool |
| `variables.tf` | Inputs and their validations |
| `locals.tf` | Names and the OAuth on/off derivation |
| `outputs.tf` | Pool id/ARN/endpoint, client id, auth domain, `cognito_env` |
