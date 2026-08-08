# Spec 002 — Infrastructure (M0b)

**Status:** in progress — the IAM stack is built (§4); the rest is not started
**Milestone:** M0b (AWS). Spec 001 is M0a and runs entirely locally.
**Depends on:** spec 001
**Blocks:** any deploy

---

## 1. Context and goal

Spec 001 produces a system that runs on a laptop. This spec makes it reachable at a URL, on real AWS, from one command.

The requirement is not "Terraform exists" — it is ARCHITECTURE §9.5a's target: **hand someone a script, they run it once, and a working Talon is reachable at a URL they can sign into.** Everything here is judged against that.

This document currently covers **only the IAM stack**, because that is what has been built. The `persistent` and `ephemeral` stacks, `scripts/up.sh` and `down.sh`, and the CI plan/apply workflow are specified in ARCHITECTURE §9.5–§9.6 and will be written up here as they land. A section that describes unbuilt code is a section that will be wrong.

## 2. Scope

**In (now):** `infra/terraform/stacks/iam` — the GitHub Actions OIDC provider, the CI plan and deploy roles, the ECS execution and task roles, the Cognito pre-token Lambda role, and the project permissions boundary. Plus `README.md` and `backend.tf.example` for that stack, and `.gitignore` rules for Terraform artifacts including `backend.tf`.

**In (later, not yet built):** `stacks/persistent` (ECR, Cognito, S3, KMS), `stacks/ephemeral` (VPC, Aurora, Redis, ECS, ALB), `global/state` bootstrap, `scripts/up.sh` / `down.sh`, CI `fmt`/`tflint`/`checkov` and the plan-on-PR workflow.

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

**What the ceiling is:** everything, minus IAM writes outside `talon-dev-*` names, minus IAM users/groups/access keys entirely, minus removing or rewriting the boundary, plus mirrors of the account/organization and Terraform-state denials. It is deliberately *not* a hand-derived PowerUserAccess — an enumerated boundary drifts every time a stack adds a service and fails as a mid-apply `AccessDenied`, which is the same argument the deploy role makes for not hand-rolling its allow-list.

`iam:CreateServiceLinkedRole` is excluded from the deny by enumerating actions instead of using an `iam:Create*` wildcard. ECS, ElastiCache, RDS and Application Auto Scaling all create their service-linked role on first use, and those live at `role/aws-service-role/*` — outside the prefix. A `Create*` wildcard here would break the ephemeral stack's first apply.

**Consequences, stated rather than discovered:**

1. **All five roles in this stack carry the boundary.** For roles that do not yet exist this costs nothing — the boundary is a parameter of `iam:CreateRole`.
2. **Adding the boundary to a role that already exists needs `iam:PutRolePermissionsBoundary`**, which is *not* in the addendum ARCHITECTURE §9.5 lists as granted. This stack has never been applied, so the first apply creates all five with it and the question does not arise. If these roles are ever created out-of-band first, that permission must be granted before this plan will apply.
3. **The deploy role cannot rewrite its own ceiling.** `ManageProjectCustomerManagedPolicies` covers `policy/talon-dev-*`, which includes the boundary, so an explicit Deny on `CreatePolicyVersion` / `SetDefaultPolicyVersion` / `DeletePolicyVersion` / `DeletePolicy` against that one ARN is required — otherwise it could publish an allow-everything version of its own ceiling. Changing the boundary is therefore a human-run apply.
4. **`iam:PassRole` is now scoped by `iam:PassedToService`.** "Pass any `talon-dev-*` role" meant the deploy role could hand the ECS **task** role to a service it controls — an EC2 instance with SSM, say — and read every application secret from a shell. The allow-list is the services this architecture actually passes roles to (`ecs-tasks`, `ecs`, `lambda`, `ec2`, `events`, `scheduler`, `application-autoscaling`, `monitoring.rds`, `vpc-flow-logs`). An `AccessDenied` on `PassRole` means a service is missing from it; add the service, in the same PR.

### 4.8 `stacks/iam` is applied by a human, not by CI

The deploy role is explicitly denied `UpdateAssumeRolePolicy`, `PutRolePolicy`, `DeleteRolePolicy`, `AttachRolePolicy`, `DetachRolePolicy`, `DeleteRole`, `PutRolePermissionsBoundary` and `DeleteRolePermissionsBoundary` on `role/talon-dev-github-*`.

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

## 5. Test plan

| Layer | Covers | Status |
|---|---|---|
| `terraform validate` | the module loads and every reference resolves | passing |
| `terraform fmt -check` | formatting | passing |
| `terraform plan`, create path | 18 to add, 0 to change, 0 to destroy on an empty account | passing |
| `terraform plan`, reuse path | `-var github_oidc_provider_arn=…`; same 18 minus the provider, trust policies fully rendered | passing |
| Variable validation | six wildcard/foreign-repo/`pull_request` claim shapes rejected at plan time, exit 1 | passing |
| `aws iam simulate-custom-policy` | 21 assertions over the rendered documents — see §5.1 | passing |
| `tflint`, `checkov` | ARCHITECTURE §9.5 requires both on every PR | **not wired** — lands with the CI workflow, §2 "in (later)" |
| Protected-resource plan check | fails any plan replacing `aws_cognito_user_pool`, `aws_rds_cluster`, a KMS key or a state bucket; manual override needs a written reason (ARCHITECTURE §9.5, CLAUDE.md §4) | **not wired** — lands with the plan-on-PR workflow, in the same step as `tflint`/`checkov`, and cannot land before it because it is an assertion over that workflow's `terraform show -json` output |
| Trust-policy assertion | `sub` is pinned to `var.github_repo`; no `repo:*` reaches an apply | **not written** — see open question 3, re-scoped by §4.3a |

### 5.1 Simulator results

Run against the policy documents as rendered by `terraform show -json`, with `PowerUserAccess` fetched from the account and the boundary supplied via `--permissions-boundary-policy-input-list`. "Before" is the same procedure against the pre-fix code from `HEAD`.

| Action | Resource | Before | After |
|---|---|---|---|
| `iam:UpdateAssumeRolePolicy` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** |
| `iam:PutRolePolicy` | `role/talon-dev-anything` (no boundary) | allowed | **explicitDeny** |
| `iam:CreateRole` | `role/talon-dev-anything` (no boundary) | allowed | **explicitDeny** |
| `iam:CreateRole` | `role/talon-dev-anything` (someone else's boundary) | allowed | **explicitDeny** |
| `iam:DeleteRole` | `role/talon-dev-github-plan` | allowed | **explicitDeny** |
| `iam:DeleteRolePermissionsBoundary` | `role/talon-dev-github-deploy` | allowed | **explicitDeny** |
| `iam:CreatePolicyVersion` | `policy/talon-dev-permissions-boundary` | allowed | **explicitDeny** |
| `iam:PassRole` → `glue.amazonaws.com` | `role/talon-dev-ecs-task` | allowed | **implicitDeny** |
| `cognito-idp:DeleteUserPool` | any pool | allowed | **explicitDeny** |
| `rds:DeleteDBCluster` | `cluster:talon-dev-pg` | allowed | **explicitDeny** |
| `s3:GetObject` | `talon-dev-quarantine/resumes/x.pdf` (plan role) | allowed | **explicitDeny** |
| `s3:GetObject` | `talon-dev-uploads/resumes/x.pdf` (plan role) | explicitDeny | explicitDeny |
| `s3:GetObject` | `talon-dev-some-future-bucket/o` (plan role) | allowed | **explicitDeny** |

A guardrail that blocks the deploy is not a fix, so the same run asserts the role can still do its job:

| Action | Resource | Result |
|---|---|---|
| `ecs:UpdateService` | `service/talon-dev/api` | allowed |
| `s3:PutObject` | `talon-tfstate-<acct>/iam/terraform.tfstate` | allowed |
| `iam:CreateRole` **with** the boundary | `role/talon-dev-future` | allowed |
| `iam:PutRolePolicy` on a role that **has** the boundary | `role/talon-dev-future` | allowed |
| `iam:PassRole` → `ecs-tasks.amazonaws.com` | `role/talon-dev-ecs-task` | allowed |
| `iam:CreateServiceLinkedRole` | `role/aws-service-role/ecs.amazonaws.com/…` | allowed |
| `s3:GetObject` (plan role) | `talon-tfstate-<acct>/iam/terraform.tfstate` | allowed |
| `dynamodb:PutItem` (plan role) | `table/talon-tfstate-lock` | allowed |

## 6. Edge cases

1. **The OIDC provider already exists in the account** — `var.github_oidc_provider_arn` reuses it; creating it would fail with `EntityAlreadyExists`.
2. **The company IAM grant is prefix-scoped** — every name derives from `local.name`, so one variable satisfies it. A role named outside the prefix fails at apply with an error that looks nothing like a permissions problem (§9.5).
3. **`github_repo` set to a wildcard** — rejected at plan time by the variable's validation, not at review time.
4. **A second environment** — `-var env=staging` produces a disjoint set of role names in the same account. No account boundary is involved.
5. **State bucket does not exist yet** — this stack uses local state deliberately, so `terraform init` works before §9.5a's bootstrap stage. It moves to the S3 backend once `global/state` exists, via `cp backend.tf.example backend.tf` and `terraform init -migrate-state -backend-config=…`. `backend.tf` is gitignored so the checked-in default stays local state; the exact command is in `infra/terraform/stacks/iam/README.md`.
6. **The state bucket name does not match what this stack assumed.** `local.state_bucket_name` defaults to `${name_prefix}-tfstate-${account_id}` and `local.state_lock_table_name` to `${name_prefix}-tfstate-lock`. Those names are *not* discovered — they are written into explicit `Deny` statements (state protection on the deploy role) and into a `NotResource` **exception** (the plan role's object-body deny, §4.10). **The failure is silent and it now cuts both ways:** if §9.5a stage 1 creates a bucket under a different name, the deny protects a bucket nobody uses *and the real state bucket is unprotected*, and separately the plan role loses its one legitimate `s3:GetObject` and every `terraform plan` in CI fails to read state. Stage 1 of `up.sh` must create these exact names, or `var.state_bucket_name` / `var.state_lock_table_name` must be set to match. This is the tightest coupling in the stack and it has no runtime check.
7. **The EventBridge bus is named without the prefix.** The task role can write to `event-bus/talon-<env>-*` only. A bus named bare `talon-dev` produces `AccessDenied` in the outbox relay at runtime — see §4.5a.
8. **A role in this stack already exists without the boundary.** Terraform will try to attach it, which is `iam:PutRolePermissionsBoundary` — not in ARCHITECTURE §9.5's granted addendum. The plan looks fine and the apply fails. §4.7 consequence 2.
9. **`stacks/persistent` has not run yet.** `var.cognito_user_pool_arns` and `var.app_kms_key_arns` are empty, so neither statement is generated. Tenant SSO configuration and column envelope encryption fail with `AccessDenied` until this stack is applied a second time with both ARNs. That is the intended behaviour, not a regression — see §4.5.

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

## 8. Definition of done — IAM stack only

- [x] `terraform validate` and `fmt -check` pass
- [x] `terraform plan` is clean on **both** paths — provider create and provider reuse
- [x] Every resource except the OIDC provider is named `talon-<env>-*`. **The OIDC provider is the one exception and it cannot be otherwise:** its ARN is derived from the issuer URL (`oidc-provider/token.actions.githubusercontent.com`) and there is exactly one per account. The earlier wording, "creates no resource outside the name prefix," was simply false. The addendum scopes IAM rights to that single ARN rather than to a prefix, which is the mitigation.
- [x] `sub` claims pinned to a single repository, no wildcard anywhere, enforced by regex validation and by `StringEquals`
- [x] The deploy role cannot escalate to administrator, cannot modify itself or the plan role, and cannot rewrite its own boundary — simulator evidence in §5.1
- [x] No `aws_iam_role` anywhere else in the repo
- [ ] `terraform apply` run against the account — **not done; needs a human (CLAUDE.md §4)**
- [ ] `tflint` + `checkov` wired into CI — neither is installed on the authoring machine, so **no claim is made here that they pass**
- [ ] Protected-resource plan check wired into CI (§5)
- [ ] Open questions 1–7 answered
