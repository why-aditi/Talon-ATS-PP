# Spec 002 — Infrastructure (M0b)

**Status:** in progress — the IAM stack is built (§4), the persistent stack holds Cognito (§4a), the CI workflow is wired (§4b); `ephemeral`, `global/state` and the provisioning scripts are not started
**Milestone:** M0b (AWS). Spec 001 is M0a and runs entirely locally.
**Depends on:** spec 001
**Blocks:** any deploy

---

## 1. Context and goal

Spec 001 produces a system that runs on a laptop. This spec makes it reachable at a URL, on real AWS, from one command.

The requirement is not "Terraform exists" — it is ARCHITECTURE §9.5a's target: **hand someone a script, they run it once, and a working Talon is reachable at a URL they can sign into.** Everything here is judged against that.

This document currently covers **only the IAM stack**, because that is what has been built. The `persistent` and `ephemeral` stacks, `scripts/up.sh` and `down.sh`, and the CI plan/apply workflow are specified in ARCHITECTURE §9.5–§9.6 and will be written up here as they land. A section that describes unbuilt code is a section that will be wrong.

## 2. Scope

**In (now):**

- `infra/terraform/stacks/iam` — the GitHub Actions OIDC provider, the CI plan and deploy roles, the ECS execution and task roles, the Cognito pre-token Lambda role, and the project permissions boundary.
- `infra/terraform/stacks/persistent` — the Cognito user pool, its app client, and the hosted auth domain (§4a). Named `persistent` because ARCHITECTURE §9.6 splits stacks by **lifetime**, not by service: this half survives the teardown that destroys the NAT gateway.
- `.github/workflows/terraform.yml` — `fmt`, `tflint`, `checkov`, `validate`, plan-on-PR as a comment, apply on merge, and the **protected-resource plan check** (§4b).
- `infra/terraform/scripts/check-plan.py` — the check itself.
- Plus `README.md` and `backend.tf.example` per stack, and `.gitignore` rules for Terraform artifacts including `backend.tf`.

**In (later, not yet built):** ECR, S3 and KMS inside `stacks/persistent`; `stacks/ephemeral` (VPC, Aurora, Redis, ECS, ALB); `global/state` bootstrap; `scripts/up.sh` / `down.sh`.

**Out:** anything in spec 001. Multi-account or AWS Organizations — ARCHITECTURE §9.5 settles on **one account** with environments separated by name prefix and tag. A custom domain.

### 2.1 Divergence from the ARCHITECTURE §9.5 layout tree

§9.5's tree used to show `envs/{dev,staging,prod}/main.tf` plus `global/oidc/`. This stack is at `stacks/iam/` and there is no `envs/` directory and no `main.tf` anywhere in the repository — searched across all history, not just the working tree.

That is a deliberate divergence and §9.5 has been updated in the same PR to record it rather than leaving the tree lying. Two reasons:

1. **Lifetime beats environment as the split axis.** §9.6 requires that the Cognito pool survive a teardown that destroys the NAT gateway. A single `envs/dev/` root module holds both, so the split §9.6 asks for cannot be expressed in it. `stacks/{persistent,ephemeral}` can.
2. **`global/oidc/` was a stack with one resource in it.** There is exactly one OIDC provider per account and it is the trust anchor for the CI roles; keeping them apart meant reading two directories to answer one question.

Environments are still separated by name prefix and tag inside one account — `-var env=staging` against the same stacks, with its own state key. That is what `envs/` was providing and it is preserved.

## 3. Conventions

- Every resource is named `${var.name_prefix}-${var.env}-*` — `talon-dev-*` by default. ARCHITECTURE §9.5 warns the company IAM grant may be scoped to a name prefix; every name in the stack derives from `local.name` so satisfying such a grant is a one-variable change.
- Tags `Project=talon, Env=${var.env}, ManagedBy=terraform` are applied as provider `default_tags`, so a new resource cannot forget them.
- ARNs are built from `data.aws_partition.current`, never a hardcoded `aws` partition.

## 4. The IAM stack

### 4.1 Why IAM is its own stack

ARCHITECTURE §9.5: role definitions change rarely, are the highest-privilege code in the repo, and a small isolated stack is reviewable in a way a role buried among sixty resources is not. **No `aws_iam_role` may exist outside this stack.** Every other stack takes role ARNs as input variables, which keeps the `TALON_ROLE_ARNS` path in §9.5a working for anyone cloning this without the IAM grant.

### 4.1a Resource inventory

Recorded so that any claim about what this stack does or does not create is checkable against a list rather than against someone's memory. **18 resources**, all of them IAM, from `terraform plan -var github_repo=…` on an empty account:

| Resource | Name | File |
|---|---|---|
| `aws_iam_openid_connect_provider.github[0]` | `token.actions.githubusercontent.com` | `oidc.tf` |
| `aws_iam_policy.permissions_boundary` | `talon-dev-permissions-boundary` | `permissions_boundary.tf` |
| `aws_iam_role.github_deploy` | `talon-dev-github-deploy` | `role_github_deploy.tf` |
| `aws_iam_role_policy.github_deploy_iam_addendum` | `talon-dev-github-deploy-iam` | `role_github_deploy.tf` |
| `aws_iam_role_policy.github_deploy_guardrails` | `talon-dev-github-deploy-guardrails` | `role_github_deploy.tf` |
| `aws_iam_role_policy_attachment.github_deploy_power_user` | `PowerUserAccess` | `role_github_deploy.tf` |
| `aws_iam_role.github_plan` | `talon-dev-github-plan` | `role_github_plan.tf` |
| `aws_iam_role_policy.github_plan_state` | `talon-dev-github-plan-state` | `role_github_plan.tf` |
| `aws_iam_role_policy.github_plan_guardrails` | `talon-dev-github-plan-guardrails` | `role_github_plan.tf` |
| `aws_iam_role_policy_attachment.github_plan_read_only` | `ReadOnlyAccess` | `role_github_plan.tf` |
| `aws_iam_role.ecs_task_execution` | `talon-dev-ecs-task-execution` | `roles_ecs.tf` |
| `aws_iam_role_policy.ecs_task_execution_secrets` | `talon-dev-ecs-task-execution-secrets` | `roles_ecs.tf` |
| `aws_iam_role_policy_attachment.ecs_task_execution_managed` | `AmazonECSTaskExecutionRolePolicy` | `roles_ecs.tf` |
| `aws_iam_role.ecs_task` | `talon-dev-ecs-task` | `roles_ecs.tf` |
| `aws_iam_role_policy.ecs_task` | `talon-dev-ecs-task` | `roles_ecs.tf` |
| `aws_iam_role.lambda_pretoken` | `talon-dev-lambda-pretoken` | `roles_lambda.tf` |
| `aws_iam_role_policy.lambda_pretoken` | `talon-dev-lambda-pretoken` | `roles_lambda.tf` |
| `aws_iam_role_policy_attachment.lambda_pretoken_vpc` | `AWSLambdaVPCAccessExecutionRole` | `roles_lambda.tf` |

Five roles. Nothing that costs money — IAM is free — and nothing stateful, which is why this stack is safe to re-apply and why the two late-bound variables in §4.5 are resolved by a second apply rather than by a data source.

### 4.2 Two CI roles, not one — the decision `locals.tf` cites

**Rejected:** a single role trusted on `repo:OWNER/REPO:*`. That is one role for both CI jobs, and it means any workflow on any branch — including a branch a first-time contributor pushed to a fork's PR — can run `terraform apply`. The wildcard is only tempting because plan and apply present different `sub` claim shapes; splitting the roles removes the reason to want it.

**Chosen:** two roles, two subject sets.

| Role | Permissions | Trusted `sub` claims |
|---|---|---|
| `${name}-github-plan` | `ReadOnlyAccess` + state lock write, minus **all** S3 object-body reads except the state file | `repo:OWNER/REPO:pull_request`, `repo:OWNER/REPO:ref:refs/heads/<default>` |
| `${name}-github-deploy` | `PowerUserAccess` + a boundary-conditioned IAM addendum, minus explicit deny guardrails | `repo:OWNER/REPO:ref:refs/heads/<default>` — **that is the whole list** |

PR-triggered jobs present `pull_request`, never a `ref:` claim, which is why the plan role needs it and the deploy role must not have it. `var.github_deploy_subject_claims` now rejects `pull_request` outright with its own validation, so the split cannot be undone by a tfvars edit.

**`repo:OWNER/REPO:environment:*` was removed from the deploy role, and the argument that justified it was wrong.** It read as a safe wildcard because "each environment is already gated by GitHub's own approval rules." Three things are wrong with that:

1. GitHub does not *append* the environment to `sub` — it **replaces** the `ref:` segment. So the entry was never an additional condition on top of the branch pin; it was an alternative to it.
2. An environment named by a workflow for the first time is **auto-created with no protection rules**. Any branch could therefore mint a matching claim by adding `environment: anything` to a job.
3. This repository has **zero** environments configured, so the entry gated nothing and bypassed everything.

A literal environment can still be added through `var.github_deploy_subject_claims` — the validation rejects wildcards, so it must be named exactly. It must have a **deployment-branch policy configured in GitHub first**; without one, adding it re-opens exactly the hole above.

With no wildcard reachable in either claim list, `oidc.tf` now asserts `sub` with **`StringEquals`** rather than `StringLike`. This changes no behaviour today — `StringLike` on a wildcard-free value is already an exact match — but it means reintroducing a wildcard requires widening `variables.tf` *and* changing the operator, in two files, which is a shape a reviewer notices.

### 4.3 The `sub` condition is the whole security boundary

The Federated principal is GitHub's public OIDC issuer, and **every** GitHub Actions workflow on github.com gets a token from it. A trust policy that names the provider and checks only `aud` therefore says "any workflow in any repository in the world may assume this role." It is the most common critical misconfiguration in this pattern, and its plan output looks completely ordinary.

- `aud` is `StringEquals` — there is exactly one correct audience, `sts.amazonaws.com`.
- `sub` is `StringLike` only because the deploy set contains `environment:*`; entries without a wildcard still match exactly under `StringLike`.
- `var.github_repo` has **no default** and is validated against `^OWNER/REPO$` — a wrong value here is a security bug, not an inconvenience.
- Never `*`, `repo:*`, or `repo:OWNER/*`.

**The claim shape is enforced, not merely conventional.** The previous validation was `startswith(s, "repo:<repo>:")`, which accepts `repo:OWNER/REPO:*` — the exact wildcard this design exists to reject — and renders it straight into the trust policy. Verified: on the pre-fix code, `terraform plan -var 'github_deploy_subject_claims=["repo:why-aditi/Talon-ATS-PP:*"]'` exits 0 with "17 to add" and the wildcard visible in the diff. Both variables now validate against

```
^repo:<github_repo>:(pull_request|ref:refs/(heads|tags)/[^*]+|environment:[^*]+)$
```

which requires a trailing segment and forbids `*` anywhere. The repository name is escaped before interpolation, because `.` is legal in a GitHub repository name and is a regex metacharacter — unescaped, a repo called `a.b` would also match `aXb`.

### 4.3a Plan visibility of the trust policy — corrected

An earlier version of this document said the trust policy is invisible in a plan and called that "a permanent property of the stack." **That is wrong on both counts**, and it matters because it was the stated reason open question 3 had no answer.

Measured, on this stack, at Terraform 1.15.8:

| Path | `assume_role_policy` in `terraform show -json` |
|---|---|
| Create the provider (`github_oidc_provider_arn = ""`) | `after_unknown: true` — the ARN is not known until apply, so the whole document is unknown |
| Reuse an existing provider (`-var github_oidc_provider_arn=arn:…`) | **Renders in full**, `sub` value included |
| Any plan after the first apply | **Renders in full** — the provider ARN is in state, so it is a known value |

So the unknown document is a property of *one* plan on *one* path — the very first apply on an account that has no GitHub OIDC provider — and not of the stack. Every subsequent plan, and every plan on the reuse path, shows the `sub` values as literal strings.

That makes a `terraform plan -json` assertion worth writing rather than pointless: it will have something to assert on in the case CI actually runs, which is a plan against existing state. Open question 3 is re-scoped accordingly.

### 4.4 The OIDC provider

Account-global: AWS permits one provider per issuer URL per account, and this is a shared company account. If something else already registered `token.actions.githubusercontent.com`, creating it fails with `EntityAlreadyExists` — set `var.github_oidc_provider_arn` to reuse it rather than importing.

`thumbprint_list` is empty by design. AWS no longer verifies the thumbprint for this issuer, and pinning a stale one is worse than pinning none: it breaks silently on CA rotation.

### 4.5 ECS roles — two, not one

The execution role is used by the ECS agent **before** the container starts (image pull, log stream, secret resolution). The task role is used by application code **inside** it. Merging them would hand the application the ability to read every secret referenced by any task definition.

KMS grants use `kms:ViaService` conditions with `resources = ["*"]` rather than a key ARN, because the customer-managed key is created by `stacks/persistent`, which consumes this stack's outputs — referencing the key here inverts that dependency into a cycle. The condition means the grant is usable only through Secrets Manager and SSM; it cannot decrypt an S3 object or a database snapshot. Setting `var.app_kms_key_arns` after `persistent` runs narrows it further on a second apply.

The direct-KMS statement for column-level PII envelope encryption (§9.9) exists **only** when a real key ARN is supplied. There is deliberately no wildcard fallback: `kms:GenerateDataKey` on `*` would let the application decrypt anything in the account, including state and backups — the one wildcard that undoes the encryption it is meant to enable.

**The Cognito statement now follows the same rule, and it is the stronger case.** It used to fall back to `arn:aws:cognito-idp:<region>:<acct>:userpool/*`. In a single shared company account (§9.5) that is not "the pool we will create shortly" — it is *every pool in the account, including other teams'*, with `CreateIdentityProvider` on it. An identity provider added to somebody else's pool is an authentication bypass for their application, and `AdminDisableUser` on it is a denial of service. The statement is now generated by a `dynamic` block gated on `length(var.cognito_user_pool_arns) > 0`, matching the KMS block directly above it, and the fallback is deleted. Until the ARN is supplied, tenant SSO setup fails with a clear `AccessDenied` rather than reaching into a pool it does not own.

Both late-bound variables are resolved the same way: `stacks/persistent` runs, then `stacks/iam` is applied a second time with `-var cognito_user_pool_arns=…` and `-var app_kms_key_arns=…`. This stack contains nothing stateful and nothing billable (see §4.1a), so a second apply is cheap and safe.

### 4.5a The `events:PutEvents` bus name — a naming contract

The task role's `DomainEvents` statement targeted the exact bus ARN `event-bus/talon-dev` while every other late-bound ARN in the same file used `${local.name}-*`. That inconsistency has no safe failure mode: whichever name `stacks/ephemeral` picks, one of the two is wrong, and the symptom is an `AccessDenied` inside the **outbox relay** (§6.1) — a consumer whose entire job is at-least-once delivery — at runtime, not at plan time.

Resolved to `event-bus/${local.name}-*`, consistent with SQS, SES and Secrets Manager in the same document. **Naming contract for `stacks/ephemeral`: the EventBridge bus must carry the `talon-<env>-` prefix**, e.g. `talon-dev-events`. A bus named bare `talon-dev` will not be writable.

### 4.6 Pre-token Lambda role

CLAUDE.md and ARCHITECTURE §9.4: `tenant_id`, role and job membership live in our `users` table keyed by `sub`, never as Cognito custom attributes. The pre-token-generation Lambda injects them at sign-in, so it must reach Aurora in isolated subnets — hence VPC attachment and the ENI permissions from `AWSLambdaVPCAccessExecutionRole`.

Its secret read is scoped to `${name}/db/*`, not the whole `${name}/` namespace, because it only needs Postgres credentials.

The trust policy carries an `aws:SourceAccount` confused-deputy guard but **not** `aws:SourceArn`. The comment in the code used to justify that with a dependency cycle. **That justification was false** and has been corrected: the function ARN is constructible from the naming convention alone — `arn:aws:lambda:<region>:<acct>:function:talon-dev-*` — exactly as the Secrets Manager and SSM ARNs in the same file are, with no reference to `stacks/persistent` and therefore no cycle.

The real reason it is absent is that it is **unverified**, and that is a judgement call recorded as open question 5. AWS documents `aws:SourceArn` for the ECS task trust policy (which this stack does use, above), and documents confused-deputy prevention for Lambda on the *function's resource policy*; it does not document that Lambda populates `aws:SourceArn` when assuming an **execution** role. If it does not, the condition never matches, the function cannot assume its role, and the symptom is that sign-in stops issuing claims — a broken login discovered in production, not in a plan. It cannot be tested without an apply, and this stack has not been applied.

The marginal gain is small, which is what tips the decision: `aws:SourceAccount` already blocks the cross-account case the term "confused deputy" names, and reaching this role from inside the account requires `iam:PassRole` on `talon-dev-*`, which only the deploy role holds and which is now itself constrained by `iam:PassedToService` (§4.7).

### 4.7 The permissions boundary

**The escalation.** The deploy role holds `PowerUserAccess` plus, from its IAM addendum, `iam:CreateRole` + `iam:PutRolePolicy` + `iam:PassRole` over `role/talon-dev-*`. Those three compose into full administrator:

1. `CreateRole` `talon-dev-anything`, trust policy naming the deploy role itself
2. `PutRolePolicy` an inline `{"Effect":"Allow","Action":"*","Resource":"*"}` — the existing `DenyAttachingAdministratorAccess` guardrail matches on `iam:PolicyARN`, a key that only exists for **managed** policies, so an inline document is invisible to it
3. `AssumeRole`, and the session is an administrator, including `iam:*`

Every step is individually inside the role's documented job and none of it looks unusual in CloudTrail. This was previously acknowledged in a code comment as "partial mitigation" and deferred to an open question; it is now closed.

**The fix.** `permissions_boundary.tf` creates `talon-dev-permissions-boundary`. A boundary is a ceiling: a role's effective permissions are the intersection of its policies and its boundary, so the `*:*` inline policy in step 2 buys nothing above the ceiling. Two things make it mandatory rather than decorative:

- The addendum's `CreateRole` / `PutRolePolicy` / `AttachRolePolicy` / `PutRolePermissionsBoundary` **Allow** is conditioned on `iam:PermissionsBoundary` equalling that ARN, and a matching explicit **Deny** sits in the guardrails. The Deny is not redundant: an unmatched conditional Allow produces an *implicit* deny, which is invisible in `simulate-custom-policy` output and evaporates the moment someone adds a broader Allow.
- The boundary document **re-states the same requirement**, so a role created under the boundary cannot create a boundary-less child. Without that the ceiling would last exactly one generation.

**What the ceiling is:** everything, minus IAM writes outside `talon-dev-*` names, minus IAM users/groups/access keys entirely, minus removing or rewriting the boundary, plus a mirror of **every** guardrail the deploy role carries (§4.7a). It is deliberately *not* a hand-derived PowerUserAccess — an enumerated boundary drifts every time a stack adds a service and fails as a mid-apply `AccessDenied`, which is the same argument the deploy role makes for not hand-rolling its allow-list.

`iam:CreateServiceLinkedRole` is excluded from the deny by enumerating actions instead of using an `iam:Create*` wildcard. ECS, ElastiCache, RDS and Application Auto Scaling all create their service-linked role on first use, and those live at `role/aws-service-role/*` — outside the prefix. A `Create*` wildcard here would break the ephemeral stack's first apply.

**Consequences, stated rather than discovered:**

1. **All five roles in this stack carry the boundary.** For roles that do not yet exist this costs nothing — the boundary is a parameter of `iam:CreateRole`.
2. **Adding the boundary to a role that already exists needs `iam:PutRolePermissionsBoundary`**, which is *not* in the addendum ARCHITECTURE §9.5 lists as granted. This stack has never been applied, so the first apply creates all five with it and the question does not arise. If these roles are ever created out-of-band first, that permission must be granted before this plan will apply.
3. **The deploy role cannot rewrite its own ceiling.** `ManageProjectCustomerManagedPolicies` covers `policy/talon-dev-*`, which includes the boundary, so an explicit Deny on `CreatePolicyVersion` / `SetDefaultPolicyVersion` / `DeletePolicyVersion` / `DeletePolicy` against that one ARN is required — otherwise it could publish an allow-everything version of its own ceiling. Changing the boundary is therefore a human-run apply.
4. **`iam:PassRole` is now scoped by `iam:PassedToService`.** "Pass any `talon-dev-*` role" meant the deploy role could hand the ECS **task** role to a service it controls — an EC2 instance with SSM, say — and read every application secret from a shell. The allow-list is the services this architecture actually passes roles to (`ecs-tasks`, `ecs`, `lambda`, `ec2`, `events`, `scheduler`, `application-autoscaling`, `monitoring.rds`, `vpc-flow-logs`). An `AccessDenied` on `PassRole` means a service is missing from it; add the service, in the same PR.

### 4.7a The boundary has to be a *mirror*, not just a ceiling — BL-1

The first version of the boundary stopped a child role reaching full administrator, and stopped there. It mirrored **two** of the deploy role's six guardrails — `DenyAccountAndOrganizationChanges` and `ProtectTerraformState`. The other four were not mirrored, and nothing made their absence visible: there were two hand-copied statements and no third thing to diff them against.

The gap was a working escalation, not a theoretical one. Every step below simulated `allowed` against the shipped documents:

1. `iam:CreateRole talon-dev-x` **with** the boundary — permitted, and deliberately so; this is the fixed point the ceiling is supposed to make harmless
2. `iam:PutRolePolicy` on it, inline `{"Action":"*","Resource":"*"}` — permitted, and harmless *if* the ceiling is complete
3. `sts:AssumeRole` into it

From that session, all `allowed`: `iam:UpdateAssumeRolePolicy` / `PutRolePolicy` / `DetachRolePolicy` on `talon-dev-github-deploy`, `cognito-idp:DeleteUserPool`, `rds:DeleteDBCluster`, `iam:PassRole talon-dev-ecs-task → ec2.amazonaws.com`, `dynamodb:DeleteTable` on `talon-tfstate-lock`, `ec2:RunInstances` in `ap-south-1`.

The first of those is the one that matters most. §4.3 says the `sub` condition "is the whole security boundary," and §4.8 pays a real price for that claim — CI cannot apply this stack. As shipped, the price bought nothing: rewriting the deploy role's trust policy took three API calls instead of one, and §4.3 was still advisory.

**Compounding it,** `DenyIamWritesOutsideProjectNames` uses `NotResource = [role/talon-dev-*, …]`. `role/talon-dev-github-deploy` matches `role/talon-dev-*`, so the CI roles sat *inside* the exception and were writable under the boundary. A `NotResource` list cannot subtract from itself, so the exception is narrowed the only way IAM permits: a second, explicit `Deny` (`DenyWritingCiRoles`) naming the ARNs that should never have been excepted. Explicit `Deny` beats every `Allow`, so the effect is exact.

**The fix, and why it is structural.** All six guardrails are now mirrored, and both copies read their action lists from `locals.tf`:

| Shared local | Deploy-role statement | Boundary statement |
|---|---|---|
| `account_org_actions` | `DenyAccountAndOrganizationChanges` | same sid |
| `state_bucket_protection_actions` | `ProtectTerraformState` | same sid |
| `state_lock_protection_actions` | `ProtectStateLockTable` | same sid |
| `stateful_delete_actions` | `DenyDestroyingStatefulResources` | same sid |
| `ci_role_write_actions` + `ci_role_arn_pattern` | `DenySelfModificationOfCiRoles` | `DenyWritingCiRoles` |
| `pass_role_services` | `PassProjectRolesToProjectServices` (Allow, `StringEquals`) | `DenyPassRoleOutsideProjectServices` (Deny, `StringNotEquals`) |
| `ec2_pass_role_arn_pattern` | `DenyPassRoleToEc2ExceptEc2Roles` | same sid |
| `region_exempt_actions` | `DenyOutsideAllowedRegions` | same sid |

Hand-copying was the bug. A shared local is not a style preference here — it is the only shape in which "the boundary mirrors the guardrails" is a property of the code rather than a claim in a comment. Adding a service to `pass_role_services` now lands in both documents or in neither.

Two shapes are deliberately *not* identical between the copies:

- **PassRole.** On the deploy role the scoping is a *condition on an Allow*, so an unmatched pass is an **implicit** deny. A child role's own `*:*` overrides an implicit deny trivially, and under a boundary there is no such thing as "no Allow" — the ceiling is `*` by construction. The boundary therefore needs an explicit `Deny` with `StringNotEquals`. A side effect, recorded because §5.1 asserts on it: `iam:PassRole → glue.amazonaws.com` on the deploy role moves from `implicitDeny` to `explicitDeny`, since the deploy role also carries the boundary. Strictly stronger.
- **Region.** The boundary's copy binds all five roles, not just the deploy role. That is intended and costs nothing: every regional call the ECS, execution and Lambda roles make (SQS, SES, SSM, Secrets Manager, Cognito, ECR, CloudWatch) is in `var.aws_region`, and the global services are in `local.region_exempt_actions`. Both copies are gated on `var.restrict_deploy_regions` so they switch together.

**What the boundary still does not do.** It closes privilege *escalation*; it does not narrow *blast radius*, and it is not an SCP. A child role under it can still read any S3 object and any Secrets Manager secret the ceiling does not name — see §4.10 and open question 6.

### 4.7b `iam:PassedToService` does not close the EC2 case on its own

The addendum's comment claimed `iam:PassedToService` prevents the deploy role "handing the ECS task role to an EC2 instance it controls and reading every application secret from a shell." **That was measurably false.** `ec2.amazonaws.com` is *on* the allow-list, because §9.6's dev cost profile replaces the NAT Gateway with a `t4g.nano` NAT instance that needs an instance profile. Measured on the pre-fix deploy role: `iam:PassRole` on `role/talon-dev-ecs-task` with `iam:PassedToService = ec2.amazonaws.com` returned **`allowed`**.

So mirroring the service scoping into the boundary — which is what the review asked for — would *not* have closed that escalation. It needs the destination **role** pinned as well as the destination **service**:

```hcl
Deny iam:PassRole
  NotResource: role/talon-dev-ec2-*
  Condition:   StringEquals iam:PassedToService = ec2.amazonaws.com
```

EC2 is the only entry on the list that turns a passed role into an interactive shell, so it is the only one worth a statement rather than a note; everything else is a trust policy away from being unusable anyway. The statement is in **both** documents.

**Naming contract for `stacks/ephemeral`:** the NAT instance's role must be named `talon-<env>-ec2-*`, e.g. `talon-dev-ec2-nat`. Anything else fails with `AccessDenied` on `PassRole` at apply time — which is the loud failure. The quiet one is the version of this file without the pin. This is the second naming contract in the stack, alongside the EventBridge bus in §4.5a.

### 4.8 `stacks/iam` is applied by a human, not by CI

The deploy role is explicitly denied every role-write action in `local.ci_role_write_actions` on `role/talon-dev-github-*`: `CreateRole`, `DeleteRole`, `UpdateRole`, `UpdateRoleDescription`, `UpdateAssumeRolePolicy`, `TagRole`, `UntagRole`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `PutRolePermissionsBoundary`, `DeleteRolePermissionsBoundary`, `PassRole`.

Four of those were missing from the first version and each has a distinct reason for being there:

- **`iam:UpdateRole`** sets `MaxSessionDuration`. Without the deny, a CI run raises its own session lifetime from one hour to twelve — `var.deploy_role_max_session_seconds` is a value the role could edit.
- **`iam:TagRole` / `iam:UntagRole`** are inert today and load-bearing the moment any policy in the account conditions on a tag. Open question 6 proposes exactly such a condition (`aws:ResourceTag/Project = talon`), so this is a deny that has to exist *before* the thing it protects.
- **`iam:CreateRole`** actually reserves the `-github-` namespace. Squatting `talon-dev-github-anything` is inert on its own — the squatter cannot then attach a policy to it, because `PutRolePolicy` and `AttachRolePolicy` are denied on the same pattern — but this section reads as though the namespace is reserved, and a name a CI run can take is a name a later human apply collides with.
- **`iam:PassRole`** closes a gap resource-scoping cannot see: `iam:AddRoleToInstanceProfile` is authorized against the **instance profile's** ARN, not the role's, so a deny scoped to role ARNs never matches it. Adding the deploy role to a profile therefore stays possible; launching an instance that wears it does not.

**Why this and not "let CI apply the stack":** without it, a single workflow run on the default branch can call `UpdateAssumeRolePolicy` on the deploy role and add a subject claim for any repository on github.com — permanently, and the next run is already somebody else's. §4.3 asserts that the `sub` condition "is the whole security boundary." A role that can rewrite its own trust policy has no such boundary, and the alternative to this denial is to demote §4.3's claim to advisory, which contradicts the entire reason there are two roles.

**The consequence is that CI cannot apply this stack**, and that is consistent with what ARCHITECTURE §9.5/§9.5a already describe: `scripts/up.sh` stage 2 runs as the operator, and CI takes the `TALON_ROLE_ARNS` skip path in which every other stack receives role ARNs as input variables and stage 2 is skipped entirely. A workflow that tries anyway fails on its first IAM write with the reason in the `AccessDenied`.

Scoped to `github-*` rather than the whole prefix on purpose: the deploy role legitimately manages the application roles, so a future CI apply of a stack that adds one keeps working.

### 4.9 Stateful-resource denials on the deploy role

`cognito-idp:DeleteUserPool` and `rds:DeleteDBCluster` are explicitly denied to the deploy role. This is the middle path between `prevent_destroy` — which ARCHITECTURE §9.5a rules out because it blocks `scripts/down.sh` — and nothing: the resource stays destroyable by the human running `down.sh --all`, and is not destroyable by an automated apply. A plan that needs one replaced (an engine-version change forcing new, say) fails at apply against CI and gets the human CLAUDE.md §4 asks for.

**Not denied: `rds:DeleteDBInstance`.** The dev cost profile (§9.6) uses a plain `db.t4g.micro` instance rather than a cluster, and tearing the ephemeral stack down between work sessions is routine by design. Denying it would fight the teardown it is meant to protect — the same mistake as `prevent_destroy`. This means the §9.6 dev profile's database is *not* covered by this denial; the protection there is the persistent/ephemeral split and the CI plan check in §5.

### 4.10 The plan role's S3 deny is now an inversion

The read-only plan role carries `ReadOnlyAccess`, which includes `s3:GetObject` on every bucket in the account — so a pull-request workflow, running code nobody has merged, could print candidate resumes into a CI log.

The deny that covered this named three bucket ARNs. That is an allow-list written as a deny-list, and it **fails open for every bucket added later**. It had already failed open once: the quarantine bucket from ARCHITECTURE §9.10 was not in the list, so CI could read an **unscanned** resume — the highest-risk object in the system, before the scanner has cleared it.

Inverted: `Deny s3:GetObject / GetObjectVersion / GetObjectTorrent` on everything, with `NotResource` naming the one prefix `terraform plan` genuinely needs an object body from — the state file. A new bucket is now denied by default and has to be added deliberately. `var.data_bucket_suffixes` gains `quarantine` as well, since it still drives the **ECS task role's** allow-list.

`uploads` is treated as §9.10's "served bucket": §9.3 enumerates exactly three application buckets, and the separation §9.10 asks for on serve is a separate CloudFront distribution and subdomain, not a fourth bucket. If that stops being true, add the suffix.

#### 4.10a Object bodies were denied; object *names* were not

The inversion above covers `GetObject` / `GetObjectVersion` / `GetObjectTorrent`. `ReadOnlyAccess` also grants `s3:ListBucket`, which was left in place — and for candidate files the **name is most of the disclosure**. Resume keys are routinely `firstname-lastname-resume.pdf`, so `aws s3 ls s3://talon-dev-quarantine/` from a pull-request workflow reads out a list of who has applied to this company without fetching a single byte the deny covers. Measured on the pre-fix plan role: `s3:ListBucket` on `talon-dev-quarantine` returned **`allowed`**.

Fixed with the same inversion: `Deny s3:ListBucket / ListBucketVersions / ListBucketMultipartUploads` on everything, `NotResource` the state bucket, which the S3 backend genuinely lists to find the state object. The exception is the **bucket ARN**, not `${bucket}/*` — `ListBucket` is authorized against the bucket, and an exception written with a trailing `/*` would match nothing and take `terraform plan`'s state reads down with it.

`s3:ListAllMyBuckets` is deliberately *not* denied: it returns bucket names only, `terraform plan` uses it, and every bucket name in this account is already written into a policy document in this stack.

#### 4.10b Residual: the ECS task role's quarantine access is not IAM-enforced

`var.data_bucket_suffixes` includes `quarantine`, and it drives the ECS **task** role's object allow-list. There is one task role (§4.5, open question 2), so the presign path and the scanner path hold **identical S3 rights**: the same role that scans an object can hand out a presigned GET for one the scanner has not cleared.

CLAUDE.md §4's "scanned before they leave quarantine" is therefore enforced by application code alone. IAM does not back it up.

This is **not fixable by the permissions boundary** — the boundary binds the task role too, so a quarantine deny there would deny the scanner as well. It is also why the ninth item in the BL-1 escalation list (`s3:GetObject` on `talon-dev-quarantine` as a boundary-carrying child) stays `allowed` in §5.1 while the other eight become `explicitDeny`: the ceiling cannot be lower than the legitimate floor of a role it binds.

The fix is the per-service task-role split ARCHITECTURE §9.9 asks for — a scanner role with `GetObject` on quarantine and an api role without it — which is **open question 2** and needs the worker entrypoints to exist first. Recorded here so it is a decision rather than an oversight.

## 4a The persistent stack — Cognito

### 4a.1 Why this stack exists now

The pool the API currently signs users into was created by an agent running the
AWS CLI. It works, and **none of the protections CLAUDE.md §4 requires applied
to it**: no `ignore_changes = [schema]`, no deletion protection, and nothing for
a CI plan check to check. A pool Terraform does not know about cannot be
protected by a rule about Terraform plans.

### 4a.2 The pool

Written to match the live configuration exactly, so adoption plans no
replacement (§4a.4). MFA `OPTIONAL` with software tokens, `email` as both the
username attribute and the auto-verified attribute, minimum password length 12
with lowercase required only, recovery by verified email then phone.

Three defences against the replacement hazard, in order of how much they do:

1. **No custom attributes, ever.** With none, the schema has no legitimate reason
   to change at all. `tenant_id`, roles and job membership live in `users` keyed
   by `sub`, injected as claims by the pre-token Lambda. Confirmed against the
   live pool: 21 schema attributes, all standard OIDC, zero `custom:`.
2. **`lifecycle { ignore_changes = [schema] }`.** Not optional even with rule 1:
   the provider populates `schema` from the standard attributes AWS creates
   automatically, so an imported pool without this line shows a permanent schema
   diff and therefore a permanent replacement.
3. **The CI gate**, §4b. Rules 1 and 2 are properties of `cognito.tf`; the gate
   is what catches someone editing `cognito.tf`.

`deletion_protection` defaults to `ACTIVE`. Deliberately **not**
`prevent_destroy` — §9.5a rules it out because it cannot be parameterized and
blocks `scripts/down.sh`. `deletion_protection` is the parameterizable
equivalent: `down.sh --all` can flip it, `prevent_destroy` cannot be flipped at
all.

`lambda_config` is written only when `var.pretoken_lambda_arn` is supplied, the
same late-binding pattern `stacks/iam` uses for its Cognito and KMS ARNs, and
for the same reason — the function is deployed by a later stage and referencing
it here would invert the dependency. **Until it is supplied the pool issues
tokens with no tenant claims**: a working sign-in and a broken authorization
story, which is why it is a variable rather than something to be forgotten.

### 4a.3 The domain, and what it unblocks

There is no domain today, and that is the thing actually blocking SSO:
`/oauth2/authorize` and `/oauth2/token` **do not exist** without one. Two
consequences follow, and neither is obvious from the pool's configuration:

- Google and per-tenant SAML sign-in are unreachable, because a federated
  sign-in *is* a redirect to `/oauth2/authorize`.
- The 30-day refresh window is **absolute, not sliding**, because rotation
  happens at `/oauth2/token`. `refresh_token_rotation` is written explicitly as
  `DISABLED` to record that rather than leave it to a default.

A prefix domain, not a custom one — §9.4 rules out a Route 53 zone and an ACM
cert, and Google OAuth callbacks work against `*.amazoncognito.com`.

**The prefix is globally unique across every AWS account in the region**, and a
collision fails at *apply*, not at plan. Check with
`aws cognito-idp describe-user-pool-domain --domain <prefix>` first; an empty
`DomainDescription` means it is free. Verified free for `talon-dev-auth` at the
time of writing.

Every OAuth setting defaults to empty or off, so **adding the domain changes
nothing for the password flow the API uses today**. `allowed_oauth_flows_user_pool_client`
is derived from whether callback URLs were supplied, which matches the live
client's `false`. Spec 003 owns the real values.

### 4a.4 Adoption — measured, not asserted

`import` blocks gated on `var.adopt_user_pool`, **not** `terraform import`. An
`import` block is visible in `terraform plan` before anything is written, so
"no replacement" is reviewable rather than discovered after the state file has
moved.

Three plans, all run against the live account:

| Path | Result |
|---|---|
| From zero (no variables) | `2 to add, 0 to change, 0 to destroy` |
| From zero with a domain | `3 to add, 0 to change, 0 to destroy` |
| **Adopt the live pool** | **`2 to import, 0 to add, 1 to change, 0 to destroy`** |

**Zero to destroy, and no replacement** — that is the requirement that matters.
"0 to change" is *not* achievable and asking for it would be asking for the
wrong thing: the one change is the pool moving `deletion_protection`
`INACTIVE → ACTIVE` and its tags `ManagedBy: manual-cli → terraform`, which is
the entire point of bringing it under management. Both are in-place.

Two findings from doing it, both of which would have destroyed something:

1. **`generate_secret` forces replacement on an imported client.** The Cognito
   API returns no `ClientSecret` field at all for a client that has none, so an
   imported client carries `null` — and an explicit `generate_secret = false`,
   which is *also the provider default*, reads as a change from null and plans
   `-/+ ... # forces replacement`. That would mint a new client id and break
   every running API instance's `COGNITO_CLIENT_ID`. The attribute is now
   omitted, and its absence is load-bearing.
2. **`refresh_token_rotation` is planned for removal** on an imported client that
   has it. Harmless, but it made the client's plan non-empty; writing the block
   explicitly makes the client's diff exactly zero and records that rotation is
   off.

### 4a.5 The adoption hazard, and why the variable is an object

Adoption pins the pool's name to the live value **forever**. The name is
immutable in Cognito and ForceNew in the provider, so the day someone runs a
plan without `var.adopt_user_pool` set, Terraform proposes to destroy that pool
and every user in it.

`adopt_user_pool` is therefore a single **object** — `{id, name, client_id,
client_name}` — not four scalars. The specific mistake of supplying the id while
leaving the name at its default is *unrepresentable*, and that mistake is
precisely the one that plans a replacement. Verified: with a deliberately
mismatched name, the plan becomes `2 to import, 2 to add, 0 to change, 2 to
destroy` and §4b's check fails with
`REPLACE aws_cognito_user_pool.main ... forced by: name`.

The residual risk is that the variable is simply not supplied on a later run.
Mitigation is documentation — put it in `terraform.tfvars`, not on the command
line — plus the §4b gate. A value that must be remembered on every invocation is
a value that will be forgotten once, and once is enough.

### 4a.6 Open decision: the adopted pool is named `talon-throwaway-spec002`

**This needs a human and is deliberately not decided here.** The live pool is
named `talon-throwaway-spec002` and tagged `Environment=throwaway`,
`ManagedBy=manual-cli`. Adopting it makes that name permanent — Cognito pool
names cannot be changed, so the only way to a `talon-dev` pool is a new pool.

| | Adopt (`-var adopt_user_pool=...`) | Create fresh (the default) |
|---|---|---|
| The 6 existing users | preserved | gone; re-seeded by `up.sh`'s demo-user stage, which §9.5a puts outside Terraform anyway |
| Pool name | `talon-throwaway-spec002`, forever | `talon-dev`, per §9.4 |
| Naming convention (§9.5) | broken for this one resource | intact |
| Prefix-scoped IAM grant | unaffected — pool ARNs embed the pool **id**, not the name | unaffected |

The default in the code is **create fresh**, because §9.5a's acceptance test is
"tear everything down, run it again from nothing, sign in" and a stack whose
default path requires something to already exist fails it. Adoption is one
variable away and is proven clean above.

The argument for creating fresh is that the 6 users are seeded demo users whose
creation is already a scripted stage of `up.sh`; the argument for adopting is
that they are real sign-ins today and losing them is a self-inflicted outage.
Owner: Aditi.

## 4b The protected-resource plan check

`infra/terraform/scripts/check-plan.py`, run from
`.github/workflows/terraform.yml` on **both** the plan-on-PR path and the
apply-on-merge path. CLAUDE.md §4 and ARCHITECTURE §9.5 both require it; spec
§5 previously listed it as "not wired", and until it existed the Cognito rule
was advisory.

It reads `terraform show -json` and fails on any `delete` action against
`aws_cognito_user_pool`, `aws_rds_cluster`, `aws_db_instance`, `aws_kms_key`,
`aws_kms_replica_key`, `aws_s3_bucket` or `aws_dynamodb_table`, or any resource
type prefixed by one of those.

Three decisions worth stating:

- **A bare destroy is flagged, not just a replacement.** A `delete` without a
  matching `create` loses every user just as completely.
- **`aws_cognito_user_pool_client` is included** via the prefix rule. Replacing
  the client mints a new client id and breaks every running API instance. Not as
  bad as losing the pool, still not routine.
- **The override is awkward on purpose.** `TALON_ALLOW_STATEFUL_REPLACE` must
  contain a reason of at least 20 characters, which is printed into the log;
  `TALON_ALLOW_STATEFUL_REPLACE=true` is rejected. A flag that can be flipped
  with `true` gets flipped with `true`.

Verified both directions against real plans: the adoption plan passes, a plan
with a mismatched pool name fails and names `forced by: name`, a weak override
still fails, and a written reason passes with the reason on the record.

The `plan` and `apply` jobs are gated on `vars.AWS_PLAN_ROLE_ARN` /
`vars.AWS_DEPLOY_ROLE_ARN` being set, and are skipped until then. `stacks/iam`
has not been applied, so those roles do not exist; a job that is always red is a
job people learn to ignore. `static` (fmt, tflint, checkov, validate) needs no
credentials and runs on every PR immediately.

**`stacks/iam` is not in the apply matrix and cannot be** — the deploy role is
explicitly denied writing `role/talon-<env>-github-*`, so a CI apply of it fails
on its first IAM write. That is §4.8's deliberate consequence, not an oversight.

## 5. Test plan

| Layer | Covers | Status |
|---|---|---|
| `terraform validate` | the module loads and every reference resolves | passing |
| `terraform fmt -check` | formatting | passing |
| `terraform plan`, create path | 18 to add, 0 to change, 0 to destroy on an empty account | passing |
| `terraform plan`, reuse path | `-var github_oidc_provider_arn=…`; same 18 minus the provider, trust policies fully rendered | passing |
| Variable validation | six wildcard/foreign-repo/`pull_request` claim shapes rejected at plan time, exit 1 | passing |
| `aws iam simulate-custom-policy` | 58 assertions over the rendered documents, across **four** simulated principals — see §5.1. Runnable: `python infra/terraform/stacks/iam/simulate/simulate.py plan.json` | passing |
| `terraform plan`, persistent from zero | `2 to add, 0 to change, 0 to destroy`; `3 to add` with a domain | passing |
| `terraform plan`, persistent adoption | `2 to import, 0 to add, 1 to change, 0 to destroy` — **no replacement**; §4a.4 | passing |
| Protected-resource plan check | fails any plan replacing `aws_cognito_user_pool`, `aws_rds_cluster`, a KMS key or a state bucket; manual override needs a written reason (ARCHITECTURE §9.5, CLAUDE.md §4) | **wired** — `infra/terraform/scripts/check-plan.py`, run on the plan and apply paths of `.github/workflows/terraform.yml`. Verified in both directions against real plans, §4b |
| `tflint`, `checkov` | ARCHITECTURE §9.5 requires both on every PR | **wired but unproven locally** — steps exist in `.github/workflows/terraform.yml`'s `static` job, which needs no credentials and runs on every PR. Neither tool is installed on the authoring machine, so **no claim is made here that they pass**; the first PR run is the proof |
| Plan posted as a PR comment | ARCHITECTURE §9.5 | **wired, unproven** — needs `vars.AWS_PLAN_ROLE_ARN`, which needs `stacks/iam` applied |
| Trust-policy assertion | `sub` is pinned to `var.github_repo`; no `repo:*` reaches an apply | **not written** — see open question 3, re-scoped by §4.3a |

### 5.1 Simulator results

Run against the policy documents as rendered by `terraform show -json`, with the AWS-managed policies fetched from the live account and the boundary supplied via `PermissionsBoundaryPolicyInputList`. "Before" is the same procedure against `git archive HEAD`, planned and rendered separately — quoted numbers are not carried over from a previous run.

The assertions are **checked in** at `infra/terraform/stacks/iam/simulate/simulate.py`, so this section is reproducible rather than quoted:

```bash
terraform -chdir=infra/terraform/stacks/iam plan -var 'github_repo=OWNER/REPO' -out=tf.plan
terraform -chdir=infra/terraform/stacks/iam show -json tf.plan > plan.json
python infra/terraform/stacks/iam/simulate/simulate.py plan.json    # 58 assertions, 0 failures
```

**Four simulated principals**, and the fourth is the fix for the blind spot that let BL-1 ship:

| Principal | Identity policies | Boundary |
|---|---|---|
| `deploy` | `PowerUserAccess` + IAM addendum + guardrails | yes |
| `plan` | `ReadOnlyAccess` + state lock + guardrails | yes |
| **`child`** | **inline `{"Action":"*","Resource":"*"}` — nothing else** | **yes** |
| `admin` | `PowerUserAccess` + `IAMFullAccess`, read from the live SSO permission set | **no** |

Every assertion in the previous version of this section evaluated the **deploy role's own** permissions. A boundary that is a ceiling but not a mirror is indistinguishable from a correct one under that test, because the deploy role's *identity* policy denies the things the boundary forgot. The `child` rows are what tell the two apart: they hold `*:*` and nothing else, so the **only** thing that can deny them is the boundary. Any future guardrail added to the deploy role needs a `child` row in the same PR, or it is unmirrored and untested for exactly the same reason.

`aws:RequestedRegion` is supplied on every call. AWS populates it on every real request, but `simulate-custom-policy` leaves it absent unless told — and an absent key makes `StringNotEquals` true, which would deny everything and read as a pass.

#### The BL-1 escalation, as a boundary-carrying `child`

| # | Action | Resource / context | Before | After |
|---|---|---|---|---|
| E1 | `iam:UpdateAssumeRolePolicy` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** |
| E2 | `iam:PutRolePolicy` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** |
| E3 | `iam:DetachRolePolicy` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** |
| E4 | `cognito-idp:DeleteUserPool` | any pool | allowed | **explicitDeny** |
| E5 | `rds:DeleteDBCluster` | `cluster:talon-dev-pg` | allowed | **explicitDeny** |
| E6 | `iam:PassRole` | `role/talon-dev-ecs-task` → `ec2.amazonaws.com` | allowed | **explicitDeny** |
| E7 | `dynamodb:DeleteTable` | `table/talon-tfstate-lock` | allowed | **explicitDeny** |
| E8 | `ec2:RunInstances` | `ap-south-1` | allowed | **explicitDeny** |
| E9 | `s3:GetObject` | `talon-dev-quarantine/resumes/x.pdf` | allowed | allowed — **residual, §4.10b** |

E9 is not a miss. The ECS task role carries the same right and the boundary binds it too, so denying it in the ceiling would deny it to the scanner. It is closed by the per-service task-role split, open question 2.

E6 required more than the review asked for: `ec2.amazonaws.com` is *on* the `PassedToService` allow-list for §9.6's NAT instance, so mirroring the service scoping alone left it `allowed`. See §4.7b.

#### Must keep holding for a `child` (unchanged by the fix)

| # | Action | Resource / context | Before | After |
|---|---|---|---|---|
| F1 | `iam:CreateAccessKey` | any user | explicitDeny | explicitDeny |
| F2 | `iam:CreateRole` | no boundary declared | explicitDeny | explicitDeny |
| F3 | `iam:CreateRole` | `role/someone-else`, with the boundary | explicitDeny | explicitDeny |
| F4 | `iam:CreatePolicyVersion` | `policy/talon-dev-permissions-boundary` | explicitDeny | explicitDeny |
| F5 | `iam:DeleteRolePermissionsBoundary` | `role/talon-dev-x` | explicitDeny | explicitDeny |

#### Deploy-role guardrails

| # | Action | Resource / context | Before | After |
|---|---|---|---|---|
| G1 | `iam:UpdateAssumeRolePolicy` | `role/talon-dev-github-deploy` | explicitDeny | explicitDeny |
| G2 | `iam:PutRolePolicy` | `role/talon-dev-anything`, no boundary | explicitDeny | explicitDeny |
| G3 | `iam:CreateRole` | no boundary | explicitDeny | explicitDeny |
| G4 | `iam:CreateRole` | someone else's boundary | explicitDeny | explicitDeny |
| G5 | `iam:DeleteRole` | `role/talon-dev-github-plan` | explicitDeny | explicitDeny |
| G6 | `iam:DeleteRolePermissionsBoundary` | `role/talon-dev-github-deploy` | explicitDeny | explicitDeny |
| G7 | `iam:CreatePolicyVersion` | `policy/talon-dev-permissions-boundary` | explicitDeny | explicitDeny |
| G8 | `iam:PassRole` | `role/talon-dev-ecs-task` → `glue` | implicitDeny | **explicitDeny** |
| G9 | `cognito-idp:DeleteUserPool` | any pool | explicitDeny | explicitDeny |
| G10 | `rds:DeleteDBCluster` | `cluster:talon-dev-pg` | explicitDeny | explicitDeny |
| G11 | `iam:UpdateRole` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** (SF-2) |
| G12 | `iam:TagRole` | `role/talon-dev-github-plan` | allowed | **explicitDeny** (SF-2) |
| G13 | `iam:CreateRole` | `role/talon-dev-github-evil`, with boundary | allowed | **explicitDeny** (SF-3) |
| G14 | `iam:PassRole` | `role/talon-dev-ecs-task` → `ec2` | allowed | **explicitDeny** (§4.7b) |
| G15 | `ec2:RunInstances` | `ap-south-1` | explicitDeny | explicitDeny |
| G16 | `dynamodb:DeleteTable` | `table/talon-tfstate-lock` | explicitDeny | explicitDeny |

G8 moves from implicit to explicit because the deploy role now also inherits the boundary's `DenyPassRoleOutsideProjectServices`. Strictly stronger; the row is corrected rather than removed.

#### Plan role

| # | Action | Resource | Before | After |
|---|---|---|---|---|
| S1 | `s3:GetObject` | `talon-dev-quarantine/resumes/x.pdf` | explicitDeny | explicitDeny |
| S2 | `s3:GetObject` | `talon-dev-uploads/resumes/x.pdf` | explicitDeny | explicitDeny |
| S3 | `s3:GetObject` | `talon-dev-some-future-bucket/o` | explicitDeny | explicitDeny |
| S4 | `s3:ListBucket` | `talon-dev-quarantine` | allowed | **explicitDeny** (SF-4) |
| S5 | `s3:ListBucket` | `talon-dev-uploads` | allowed | **explicitDeny** (SF-4) |

#### A guardrail that blocks the deploy is not a fix

| # | Principal | Action | Resource / context | Result |
|---|---|---|---|---|
| D1 | deploy | `ecs:UpdateService` | `service/talon-dev/api` | allowed |
| D2 | deploy | `s3:PutObject` | `talon-tfstate-<acct>/iam/terraform.tfstate` | allowed |
| D3 | deploy | `iam:CreateRole` | `role/talon-dev-future` **with** the boundary | allowed |
| D4 | deploy | `iam:PutRolePolicy` | a role that **has** the boundary | allowed |
| D5 | deploy | `iam:PassRole` | `role/talon-dev-ecs-task` → `ecs-tasks` | allowed |
| D6 | deploy | `iam:PassRole` | `role/talon-dev-ec2-nat` → `ec2` | allowed |
| D7 | deploy | `iam:CreateServiceLinkedRole` | `role/aws-service-role/ecs.amazonaws.com/…` | allowed |
| D8 | deploy | `secretsmanager:GetSecretValue` | `secret:talon-dev/db-*` | allowed |
| D9 | deploy | `ec2:CreateVpc` | in `var.aws_region` | allowed |
| P1 | plan | `s3:GetObject` | state object | allowed |
| P2 | plan | `s3:ListBucket` | the state bucket | allowed |
| P3 | plan | `dynamodb:PutItem` | `table/talon-tfstate-lock` | allowed |
| P4 | plan | `ec2:DescribeVpcs` | `*` | allowed |

All thirteen are `allowed` both before and after. D6 is the row that proves §4.7b's naming contract works: the NAT instance role still reaches EC2, the ECS task role (G14) does not.

#### The operator can still apply this stack

A boundary that locked the stack out of its own next apply would be a worse bug than the one being fixed. Simulated against the live SSO permission set (`AWSReservedSSO_PowerUserAccess_*`: `PowerUserAccess` + `IAMFullAccess`, `PermissionsBoundary: null` — a boundary constrains only the principal it is attached to, and this one has none).

| # | Action | Resource | Result |
|---|---|---|---|
| A1 | `iam:CreateRole` | `role/talon-dev-github-deploy` with the boundary | allowed |
| A2 | `iam:CreatePolicy` | `policy/talon-dev-permissions-boundary` | allowed |
| A3 | `iam:PutRolePolicy` | the guardrails | allowed |
| A4 | `iam:AttachRolePolicy` | `PowerUserAccess` | allowed |
| A5 | `iam:TagRole` | provider `default_tags` | allowed |
| A6 | `iam:CreatePolicyVersion` | the boundary — **the next apply** | allowed |
| A7 | `iam:UpdateAssumeRolePolicy` | `role/talon-dev-github-deploy` | allowed |
| A8 | `iam:PassRole` | `role/talon-dev-ecs-task` → `ec2` | allowed |
| A9 | `iam:CreateOpenIDConnectProvider` | — | allowed |
| A10 | `iam:DeleteRole` | `role/talon-dev-github-deploy` — `down.sh` | allowed |

A6 and A7 are the load-bearing rows: the new mirrors do **not** prevent the human operator from changing the boundary or the CI roles on a subsequent apply. A8 is `allowed` for the operator and `explicitDeny` for the deploy role and for a `child` — which is the intended asymmetry, not an inconsistency.

## 6. Edge cases

1. **The OIDC provider already exists in the account** — `var.github_oidc_provider_arn` reuses it; creating it would fail with `EntityAlreadyExists`.
2. **The company IAM grant is prefix-scoped** — every name derives from `local.name`, so one variable satisfies it. A role named outside the prefix fails at apply with an error that looks nothing like a permissions problem (§9.5).
3. **`github_repo` set to a wildcard** — rejected at plan time by the variable's validation, not at review time.
4. **A second environment** — `-var env=staging` produces a disjoint set of role names in the same account. No account boundary is involved.
5. **State bucket does not exist yet** — this stack uses local state deliberately, so `terraform init` works before §9.5a's bootstrap stage. It moves to the S3 backend once `global/state` exists, via `cp backend.tf.example backend.tf` and `terraform init -migrate-state -backend-config=…`. `backend.tf` is gitignored so the checked-in default stays local state; the exact command is in `infra/terraform/stacks/iam/README.md`.
6. **The state bucket name does not match what this stack assumed.** `local.state_bucket_name` defaults to `${name_prefix}-tfstate-${account_id}` and `local.state_lock_table_name` to `${name_prefix}-tfstate-lock`. Those names are *not* discovered — they are written into explicit `Deny` statements (state protection on the deploy role) and into a `NotResource` **exception** (the plan role's object-body deny, §4.10). **The failure is silent and it now cuts both ways:** if §9.5a stage 1 creates a bucket under a different name, the deny protects a bucket nobody uses *and the real state bucket is unprotected*, and separately the plan role loses its one legitimate `s3:GetObject` and every `terraform plan` in CI fails to read state. Stage 1 of `up.sh` must create these exact names, or `var.state_bucket_name` / `var.state_lock_table_name` must be set to match. This is the tightest coupling in the stack and it has no runtime check.
7. **The EventBridge bus is named without the prefix.** The task role can write to `event-bus/talon-<env>-*` only. A bus named bare `talon-dev` produces `AccessDenied` in the outbox relay at runtime — see §4.5a.
8. **A role in this stack already exists without the boundary.** Terraform will try to attach it, which is `iam:PutRolePermissionsBoundary` — not in ARCHITECTURE §9.5's granted addendum. The plan looks fine and the apply fails. §4.7 consequence 2.
9. **The NAT instance's role is not named `talon-<env>-ec2-*`.** `iam:PassRole` to `ec2.amazonaws.com` is denied for every other role name, on the deploy role and under the boundary (§4.7b). The failure is an `AccessDenied` on `PassRole` at apply time — loud, and naming the role. The alternative was leaving the ECS task role passable to EC2.
10. **A new guardrail is added to the deploy role and not to the boundary.** Nothing in Terraform catches this; the guard is the shared action lists in `locals.tf` plus the `child` rows in §5.1, which fail if the boundary does not deny what the deploy role denies. A guardrail written with a literal action list instead of a shared local re-opens BL-1 in exactly its original form.
11. **`stacks/persistent` has not run yet.** `var.cognito_user_pool_arns` and `var.app_kms_key_arns` are empty, so neither statement is generated. Tenant SSO configuration and column envelope encryption fail with `AccessDenied` until this stack is applied a second time with both ARNs. That is the intended behaviour, not a regression — see §4.5.

## 7. Open questions

1. **Should the deploy role be scoped below `PowerUserAccess`?** It currently carries `PowerUserAccess` plus a prefix-scoped IAM addendum, minus explicit denies. A hand-written allow-list would be tighter but breaks every time a stack adds a service. Owner: Aditi.
2. **One ECS task role or one per service?** ARCHITECTURE §9.9 wants per-service roles (the calendar worker cannot read the uploads bucket). It is deliberately one role for now — web, api and workers ship from the same image and only the api makes AWS calls in M0. Splitting it is a copy of the block per service once the worker entrypoints exist. Owner: Aditi.
3. **How is the `sub` condition regression-tested?** Re-scoped by §4.3a. The trust policy renders in full on the reuse path and on every plan after the first apply, so a `terraform plan -json` assertion **does** have something to assert on and should be written: fail the build if any `token.actions.githubusercontent.com:sub` value contains `*` or does not start with `repo:${var.github_repo}:`. The variable validations now catch the tfvars route; this catches the code route. Lands with the CI workflow (§5). Owner: Aditi.
4. **Does the company account already have a GitHub OIDC provider?** Unverified. If it does, `terraform apply` fails on first run and `var.github_oidc_provider_arn` is the fix. Note that the reuse path is *better* for review than the create path — §4.3a — so this is worth checking before the first apply rather than after it. Owner: Aditi.
5. **Does Lambda populate `aws:SourceArn` when assuming an execution role?** §4.6. The comment claiming a dependency cycle was false and is corrected; the condition is still absent because the behaviour is undocumented and cannot be tested without an apply, and a wrong guess breaks sign-in rather than failing a plan. Verify at the first apply of `stacks/persistent`, then add `ArnLike aws:SourceArn = arn:aws:lambda:<region>:<acct>:function:talon-<env>-*`. Owner: Aditi.
6. **Is the residual escalation surface on the deploy role acceptable?** Previously acknowledged only in a code comment. The `CreateRole` + `PutRolePolicy` + `AssumeRole` path is closed by §4.7's boundary, but the honest remaining statement is: **the deploy role is still `PowerUserAccess` on a shared company account.** It can read every Secrets Manager secret and every S3 object in the account outside the state bucket, it can delete another team's resources, and the boundary does not narrow any of that — the boundary closes *privilege escalation*, not *blast radius*. Two follow-ups worth deciding on: whether to add a `aws:ResourceTag/Project = talon` condition to the non-IAM surface, and whether the account should carry an SCP-equivalent at all given §9.5 rules out joining an Organization. Related to open question 1, which asks the narrower version of this. Owner: Aditi.
7. **CLAUDE.md §4 is internally inconsistent and two of its claims are stale.** Not fixed here — a sub-agent editing project memory on its own initiative is exactly the change that should not be made silently. Recorded so it is decided rather than absorbed:
   - The list is **duplicated**: items 15-19 reappear as 20, 15, 16, 17. So "non-negotiable #16" is ambiguous — it is both *"Never change the Cognito pool schema"* and *"Every outbox consumer is idempotent"*, and this spec and the code comments cite it by number.
   - Item 16 (the Cognito one) says the pool "carries `prevent_destroy`". ARCHITECTURE §9.4 and §9.5a both supersede that: §9.5a states plainly that `prevent_destroy` cannot be parameterized, blocks `scripts/down.sh`, and is used **nowhere** in this project. `ignore_changes = [schema]` stays; `prevent_destroy` does not.
   Owner: Aditi.
8. **Is the adopted pool's name acceptable, or should a `talon-dev` pool be created instead?** §4a.6, with the trade-off table. The code defaults to creating fresh; adoption is one variable and is proven not to replace anything. This is the only decision in this spec that is irreversible in the wrong direction — a Cognito pool name cannot be changed, so a pool adopted today is named `talon-throwaway-spec002` for as long as it has users. Owner: Aditi.
9. **A pool created by an agent running the AWS CLI is how this started.** It predates the Terraform that now manages it, and the only reason that was recoverable is that Cognito pools can be imported and this one's configuration happened to be reproducible. Worth deciding whether "no AWS resource is created outside Terraform" becomes an explicit rule — noting it cannot be absolute, because §9.5a deliberately puts image build/push, in-VPC migration and demo-user creation outside Terraform's graph. The rule needs a stated boundary, not a slogan. Owner: Aditi.

## 8. Definition of done — the IAM stack, the persistent stack, and CI

- [x] `terraform validate` and `fmt -check` pass
- [x] `terraform plan` is clean on **both** paths — provider create and provider reuse
- [x] Every resource except the OIDC provider is named `talon-<env>-*`. **The OIDC provider is the one exception and it cannot be otherwise:** its ARN is derived from the issuer URL (`oidc-provider/token.actions.githubusercontent.com`) and there is exactly one per account. The earlier wording, "creates no resource outside the name prefix," was simply false. The addendum scopes IAM rights to that single ARN rather than to a prefix, which is the mitigation.
- [x] `sub` claims pinned to a single repository, no wildcard anywhere, enforced by regex validation and by `StringEquals`
- [x] The deploy role cannot escalate to administrator, cannot modify itself or the plan role, and cannot rewrite its own boundary — simulator evidence in §5.1
- [x] **A role the deploy role creates cannot do any of those things either** — the boundary mirrors all six guardrails, verified by the `child` principal in §5.1 (§4.7a, BL-1)
- [x] The operator identity is not locked out of the next apply by the new mirrors — §5.1, rows A1–A10
- [x] No `aws_iam_role` anywhere else in the repo — including `stacks/persistent`, which takes role ARNs as input variables
- [x] `tflint` + `checkov` wired into CI — steps exist and need no credentials. Neither is installed on the authoring machine, so **no claim is made that they pass**; the first PR run is the proof
- [x] Protected-resource plan check wired into CI (§4b), verified in both directions against real plans
- [x] Cognito user pool under Terraform with `ignore_changes = [schema]`, deletion protection, and an adoption path proven not to replace it (§4a)
- [x] A hosted auth domain is one variable away, with every OAuth setting defaulted off so it changes nothing for today's password flow (§4a.3)
- [ ] The `talon-throwaway-spec002` naming decision (§4a.6) — **needs a human**
- [ ] `terraform apply` run against the account — **not done; needs a human (CLAUDE.md §4)**
- [ ] Open questions 1–7 answered
