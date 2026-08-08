# `stacks/iam`

Every IAM role, policy and instance-profile-bearing principal in Talon. Nothing
else in the repository may declare an `aws_iam_role` — ARCHITECTURE §9.5. Other
stacks take role ARNs as **input variables**, which is what keeps the
`TALON_ROLE_ARNS` skip path in §9.5a working for anyone cloning this without the
IAM grant.

## Who applies this stack

**A human or admin identity — not CI.**

The deploy role this stack creates is explicitly denied every role-write action
in `local.ci_role_write_actions` on `role/talon-<env>-github-*`, so it cannot
modify itself or the plan role. That denial is what makes the `sub` pin in
`oidc.tf` a real boundary rather than a comment: without it, one workflow run on
the default branch could add a subject claim for any repository on github.com,
permanently.

**The same denial is in the permissions boundary**, and it has to be. Denying it
only on the deploy role leaves a three-call path around it: create a child role
*with* the boundary, give it an inline `*:*`, assume it. Every step of that is
permitted by design — the ceiling is supposed to make it harmless — and it is
harmless only if the ceiling denies what the deploy role denies. It did not, for
four of six guardrails, and rewriting the deploy role's trust policy was
reachable. See spec 002 §4.7a.

The consequence is that a CI job cannot apply this stack. That matches
ARCHITECTURE §9.5a: `scripts/up.sh` stage 2 runs as the operator, and CI sets
`TALON_ROLE_ARNS` and skips stage 2 entirely. A workflow that tries anyway fails
on its first IAM write, loudly, with the reason in the `AccessDenied` message.

## Applying it

```bash
terraform -chdir=infra/terraform/stacks/iam init
terraform -chdir=infra/terraform/stacks/iam plan -var 'github_repo=OWNER/REPO'
```

`github_repo` has no default on purpose — a wrong value there is a security bug,
not an inconvenience.

Two arguments are supplied on a **second** apply, once `stacks/persistent` has
run and its ARNs exist. Neither can be referenced from here directly: persistent
consumes this stack's role ARNs, so pointing at it would invert the dependency
into a cycle.

```bash
terraform -chdir=infra/terraform/stacks/iam apply \
  -var 'github_repo=OWNER/REPO' \
  -var 'cognito_user_pool_arns=["arn:aws:cognito-idp:us-east-1:<acct>:userpool/<id>"]' \
  -var 'app_kms_key_arns=["arn:aws:kms:us-east-1:<acct>:key/<id>"]'
```

Until they are supplied, the corresponding statements are **not created at all**.
There is no wildcard fallback for either: `userpool/*` in a shared single account
grants the ability to create identity providers in another team's pool, and
`kms:GenerateDataKey` on `*` undoes the encryption it exists to enable.

## State backend

The stack ships with **no backend block**, so `terraform init` succeeds with zero
credentials and zero pre-existing infrastructure. That property is what §9.5a
stage 1 needs: the state bucket does not exist yet on a clean clone.

To move to the shared backend once `global/state` has been bootstrapped:

```bash
cp backend.tf.example backend.tf     # backend.tf is gitignored
terraform init -migrate-state \
  -backend-config="bucket=talon-tfstate-$(aws sts get-caller-identity --query Account --output text)" \
  -backend-config="key=iam/terraform.tfstate" \
  -backend-config="region=us-east-1" \
  -backend-config="dynamodb_table=talon-tfstate-lock" \
  -backend-config="encrypt=true"
```

The bucket and table names must match `var.state_bucket_name` /
`var.state_lock_table_name`, because this stack writes explicit `Deny`
statements against those exact ARNs. A mismatch is silent: the deny protects a
bucket nobody uses, and the real state bucket is unprotected.

## The permissions boundary

`permissions_boundary.tf` creates `talon-<env>-permissions-boundary` and every
role here carries it. The deploy role may only call `iam:CreateRole`,
`iam:PutRolePolicy`, `iam:AttachRolePolicy` and `iam:PutRolePermissionsBoundary`
when `iam:PermissionsBoundary` equals that ARN, and is denied rewriting or
detaching it. Read the header comment in that file for the escalation it closes
before changing anything in it.

**If you add a guardrail to the deploy role, add it to the boundary too**, and
put its action list in `locals.tf` so the two statements read the same value.
That is not tidiness: a guardrail the deploy role carries and the boundary does
not is a guardrail the deploy role can create a child role to walk around. The
shared locals are `ci_role_write_actions`, `pass_role_services`,
`ec2_pass_role_arn_pattern`, `stateful_delete_actions`, `account_org_actions`,
`state_bucket_protection_actions`, `state_lock_protection_actions` and
`region_exempt_actions`. Spec 002 §5.1 has a `child` principal — a role holding
inline `*:*` and nothing else, so only the boundary can deny it — and a new
guardrail needs a row there in the same PR.

Two naming contracts this stack places on later stacks, both of which fail as an
`AccessDenied` at apply rather than at plan:

| Contract | Why |
|---|---|
| EventBridge bus is `talon-<env>-*` | the task role's `events:PutEvents` (§4.5a) |
| NAT / EC2 instance role is `talon-<env>-ec2-*` | `iam:PassRole` to `ec2.amazonaws.com` is denied for every other name, so the ECS task role cannot be handed to an instance (§4.7b) |

Adding the boundary to a role that **already exists** needs
`iam:PutRolePermissionsBoundary`, which is not in the granted addendum listed in
ARCHITECTURE §9.5. Creating a role with one does not — it is a parameter of
`iam:CreateRole`. This stack has never been applied, so the first apply creates
all five roles with the boundary and the question does not arise.

## Files

| File | Contents |
|---|---|
| `oidc.tf` | GitHub OIDC provider (optional) and both CI trust policies |
| `permissions_boundary.tf` | The ceiling every role in the project carries |
| `role_github_deploy.tf` | Apply role: PowerUserAccess, IAM addendum, guardrails |
| `role_github_plan.tf` | Plan role: ReadOnlyAccess, state lock, object-body deny |
| `roles_ecs.tf` | ECS execution and task roles |
| `roles_lambda.tf` | Cognito pre-token-generation Lambda role |
| `locals.tf` | Names, ARNs, subject claims |
| `variables.tf` | Inputs and their validations |
| `outputs.tf` | Role ARNs, and `role_arns_env` for `TALON_ROLE_ARNS` |
| `simulate/simulate.py` | The §5.1 assertions, runnable against a plan |

## Checking the policies

```bash
terraform -chdir=infra/terraform/stacks/iam plan \
  -var 'github_repo=OWNER/REPO' -out=tf.plan
terraform -chdir=infra/terraform/stacks/iam show -json tf.plan > plan.json
python infra/terraform/stacks/iam/simulate/simulate.py plan.json
```

Runs `aws iam simulate-custom-policy` over the documents as Terraform renders
them, for four principals: the deploy role, the plan role, the operator (no
boundary), and a **`child`** — a hypothetical role holding inline `*:*` and
carrying the boundary, which is what the deploy role can actually build. The
`child` rows are the ones with teeth: because the child's own policy allows
everything, the only thing that can deny it is the boundary.
