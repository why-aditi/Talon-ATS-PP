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

**In (now):** `infra/terraform/stacks/iam` — the GitHub Actions OIDC provider, the CI plan and deploy roles, the ECS execution and task roles, and the Cognito pre-token Lambda role. `.gitignore` rules for Terraform artifacts.

**In (later, not yet built):** `stacks/persistent` (ECR, Cognito, S3, KMS), `stacks/ephemeral` (VPC, Aurora, Redis, ECS, ALB), `global/state` bootstrap, `scripts/up.sh` / `down.sh`, CI `fmt`/`tflint`/`checkov` and the plan-on-PR workflow.

**Out:** anything in spec 001. Multi-account or AWS Organizations — ARCHITECTURE §9.5 settles on **one account** with environments separated by name prefix and tag. A custom domain.

## 3. Conventions

- Every resource is named `${var.name_prefix}-${var.env}-*` — `talon-dev-*` by default. ARCHITECTURE §9.5 warns the company IAM grant may be scoped to a name prefix; every name in the stack derives from `local.name` so satisfying such a grant is a one-variable change.
- Tags `Project=talon, Env=${var.env}, ManagedBy=terraform` are applied as provider `default_tags`, so a new resource cannot forget them.
- ARNs are built from `data.aws_partition.current`, never a hardcoded `aws` partition.

## 4. The IAM stack

### 4.1 Why IAM is its own stack

ARCHITECTURE §9.5: role definitions change rarely, are the highest-privilege code in the repo, and a small isolated stack is reviewable in a way a role buried among sixty resources is not. **No `aws_iam_role` may exist outside this stack.** Every other stack takes role ARNs as input variables, which keeps the `TALON_ROLE_ARNS` path in §9.5a working for anyone cloning this without the IAM grant.

### 4.2 Two CI roles, not one — the decision `locals.tf` cites

**Rejected:** a single role trusted on `repo:OWNER/REPO:*`. That is one role for both CI jobs, and it means any workflow on any branch — including a branch a first-time contributor pushed to a fork's PR — can run `terraform apply`. The wildcard is only tempting because plan and apply present different `sub` claim shapes; splitting the roles removes the reason to want it.

**Chosen:** two roles, two subject sets.

| Role | Permissions | Trusted `sub` claims |
|---|---|---|
| `${name}-github-plan` | `ReadOnlyAccess` + state bucket read, minus candidate-file object reads | `repo:OWNER/REPO:pull_request`, `repo:OWNER/REPO:ref:refs/heads/<default>` |
| `${name}-github-deploy` | `PowerUserAccess` + a scoped IAM addendum, minus explicit deny guardrails | `repo:OWNER/REPO:ref:refs/heads/<default>`, `repo:OWNER/REPO:environment:*` |

PR-triggered jobs present `pull_request`, never a `ref:` claim, which is why the plan role needs it and the deploy role must not have it. `environment:*` is the one wildcard that earns its keep: environment names are created in GitHub over time and each is already gated by GitHub's own approval rules.

### 4.3 The `sub` condition is the whole security boundary

The Federated principal is GitHub's public OIDC issuer, and **every** GitHub Actions workflow on github.com gets a token from it. A trust policy that names the provider and checks only `aud` therefore says "any workflow in any repository in the world may assume this role." It is the most common critical misconfiguration in this pattern, and its plan output looks completely ordinary.

- `aud` is `StringEquals` — there is exactly one correct audience, `sts.amazonaws.com`.
- `sub` is `StringLike` only because the deploy set contains `environment:*`; entries without a wildcard still match exactly under `StringLike`.
- `var.github_repo` has **no default** and is validated against `^OWNER/REPO$` — a wrong value here is a security bug, not an inconvenience.
- Never `*`, `repo:*`, or `repo:OWNER/*`.

**Reviewing this in a plan is not possible when the provider is created in the same apply** — the trust policy renders as "known after apply". Read `oidc.tf` and `locals.tf` instead. This is a permanent property of the stack, not a one-off.

### 4.4 The OIDC provider

Account-global: AWS permits one provider per issuer URL per account, and this is a shared company account. If something else already registered `token.actions.githubusercontent.com`, creating it fails with `EntityAlreadyExists` — set `var.github_oidc_provider_arn` to reuse it rather than importing.

`thumbprint_list` is empty by design. AWS no longer verifies the thumbprint for this issuer, and pinning a stale one is worse than pinning none: it breaks silently on CA rotation.

### 4.5 ECS roles — two, not one

The execution role is used by the ECS agent **before** the container starts (image pull, log stream, secret resolution). The task role is used by application code **inside** it. Merging them would hand the application the ability to read every secret referenced by any task definition.

KMS grants use `kms:ViaService` conditions with `resources = ["*"]` rather than a key ARN, because the customer-managed key is created by `stacks/persistent`, which consumes this stack's outputs — referencing the key here inverts that dependency into a cycle. The condition means the grant is usable only through Secrets Manager and SSM; it cannot decrypt an S3 object or a database snapshot. Setting `var.app_kms_key_arns` after `persistent` runs narrows it further on a second apply.

The direct-KMS statement for column-level PII envelope encryption (§9.9) exists **only** when a real key ARN is supplied. There is deliberately no wildcard fallback: `kms:GenerateDataKey` on `*` would let the application decrypt anything in the account, including state and backups — the one wildcard that undoes the encryption it is meant to enable.

### 4.6 Pre-token Lambda role

CLAUDE.md and ARCHITECTURE §9.4: `tenant_id`, role and job membership live in our `users` table keyed by `sub`, never as Cognito custom attributes. The pre-token-generation Lambda injects them at sign-in, so it must reach Aurora in isolated subnets — hence VPC attachment and the ENI permissions from `AWSLambdaVPCAccessExecutionRole`.

Its secret read is scoped to `${name}/db/*`, not the whole `${name}/` namespace, because it only needs Postgres credentials. The trust policy carries an `aws:SourceAccount` confused-deputy guard but **not** `aws:SourceArn`: the function is created by `stacks/persistent`, which already depends on this stack's outputs, so naming its ARN here would be a cycle.

## 5. Test plan

| Layer | Covers | Status |
|---|---|---|
| `terraform validate` | the module loads and every reference resolves | passing |
| `terraform fmt -check` | formatting | passing |
| `terraform plan` | 17 to add, 0 to change, 0 to destroy on an empty account | passing |
| `tflint`, `checkov` | ARCHITECTURE §9.5 requires both on every PR | **not wired** |
| Trust-policy assertion | `sub` is pinned to `var.github_repo`; no `repo:*` reaches an apply | **not written** — see open question 3 |

## 6. Edge cases

1. **The OIDC provider already exists in the account** — `var.github_oidc_provider_arn` reuses it; creating it would fail with `EntityAlreadyExists`.
2. **The company IAM grant is prefix-scoped** — every name derives from `local.name`, so one variable satisfies it. A role named outside the prefix fails at apply with an error that looks nothing like a permissions problem (§9.5).
3. **`github_repo` set to a wildcard** — rejected at plan time by the variable's validation, not at review time.
4. **A second environment** — `-var env=staging` produces a disjoint set of role names in the same account. No account boundary is involved.
5. **State bucket does not exist yet** — this stack uses local state deliberately, so `terraform init` works before §9.5a's bootstrap stage. It moves to the S3 backend once `global/state` exists.

## 7. Open questions

1. **Should the deploy role be scoped below `PowerUserAccess`?** It currently carries `PowerUserAccess` plus a prefix-scoped IAM addendum, minus explicit denies. A hand-written allow-list would be tighter but breaks every time a stack adds a service. Owner: Aditi.
2. **One ECS task role or one per service?** ARCHITECTURE §9.9 wants per-service roles (the calendar worker cannot read the uploads bucket). It is deliberately one role for now — web, api and workers ship from the same image and only the api makes AWS calls in M0. Splitting it is a copy of the block per service once the worker entrypoints exist. Owner: Aditi.
3. **How is the `sub` condition regression-tested?** The trust policy is invisible in a plan when the provider is created in the same apply (§4.3), so a human reading `oidc.tf` is currently the only control. A `terraform plan -json` assertion or a `checkov` custom policy would make it a gate. Owner: Aditi.
4. **Does the company account already have a GitHub OIDC provider?** Unverified. If it does, `terraform apply` fails on first run and `var.github_oidc_provider_arn` is the fix. Owner: Aditi.

## 8. Definition of done — IAM stack only

- [x] `terraform validate` and `fmt -check` pass
- [x] `terraform plan` is clean and creates no resource outside the name prefix
- [x] `sub` claims pinned to a single repository, no wildcard repo
- [x] No `aws_iam_role` anywhere else in the repo
- [ ] `terraform apply` run against the account — **not done; needs a human (CLAUDE.md §4)**
- [ ] `tflint` + `checkov` wired into CI
- [ ] Open questions 1–4 answered
