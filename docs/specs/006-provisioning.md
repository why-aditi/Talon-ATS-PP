# Spec 006 — Single-command provisioning (`up.sh` / `down.sh`)

**Status:** not started — written from the approved plan of 2026-08-08.

## 1. Context and goal

ARCHITECTURE §9.5a states the deliverable: **hand someone a script, they run it
once, and a working Talon is reachable at a URL they can sign into.** Spec 002
built `stacks/iam` and the Cognito half of `stacks/persistent` and stopped there,
recording `ephemeral`, `global/state` and the scripts as "not started".

As of 2026-08-08 `stacks/iam` is applied (17 resources), the state bucket and
`talon-tfstate-lock` exist, and `vars.AWS_PLAN_ROLE_ARN` is set, so the CI plan
job runs for real. Everything below is what still stands between that and a URL.

Against §9.5a's ten stages, stages 0, 1, 4, 5, 6, 8 and 9 have no implementation
and stage 3 is one third built.

## 2. Scope

**In:** the Cognito cutover; ECR + S3 + KMS in `stacks/persistent`; one
Dockerfile; `stacks/ephemeral`; `scripts/up.sh`; `scripts/down.sh`; adding
`ephemeral` to the CI plan matrix.

**Out:** custom domain and ACM; multi-account or Organizations; staging and prod
environments; CloudFront and WAF (§9.4's edge design — addable later without
changing origins); a CI *apply* of `ephemeral`.

## 3. Decisions taken

These were delegated with "make the simplest and easy to scale thing". Each is
recorded with what it rules out.

### 3.1 Database: Aurora Serverless v2, minimum capacity 0 ACU

Auto-pause is the platform's own answer to idle cost, so nothing in `down.sh`
has to be a cost-control discipline someone remembers to run. It scales up on
demand with no capacity planning.

The cost is a cold start of roughly fifteen seconds on the first request after a
pause, which is acceptable for a dev and demo environment and is not acceptable
for prod — a genuine prod stack sets a non-zero floor.

**Verify at build time:** `min_capacity = 0` requires a recent AWS provider and
engine version. The stacks pin provider 5.100.0. If it is rejected, fall back to
`0.5` and say so here rather than silently — 0.5 ACU idles at roughly $45/month
and that changes the answer to "does `down.sh` need to run nightly".

Rules out: a plain `db.t4g.micro` instance, which is cheaper at idle but is a
different engine shape from the Aurora the architecture specifies (§2), and
re-litigating the stack is out of bounds.

### 3.2 Web and API served same-origin behind one ALB

One ALB, one listener: `/v1/*` to the api target group, everything else to the
web target group.

This is not only fewer moving parts — it is what keeps the web image portable.
`NEXT_PUBLIC_API_URL` defaults to `''` in every consumer
(`apps/web/src/lib/board-query.ts:12`, `jobs-query.ts:10`,
`job-wizard-query.ts:32`), and `''` means same-origin. `APP_ORIGIN` is read
server-side at runtime (`same-origin.ts:30`, `sso.ts:13`).

So the only build-time-inlined value left is `NEXT_PUBLIC_SSO_GOOGLE`, a static
on/off. **This dissolves the §9.5a ordering problem** where stage 4 builds the
image before stage 5 knows the app URL: with same-origin, the image does not
depend on the URL at all.

Rules out: CloudFront + S3 static export, which would reintroduce a build-time
API base and an origin split. CloudFront can be added later purely as a cache in
front of this ALB without changing any of it.

### 3.3 Cognito cutover happens first, on its own

Not folded into the first `up.sh` run. It is a migration off an unmanaged pool,
`up.sh` is a first-time bootstrap, and mixing the two makes a failure in either
look like a failure in the other.

## 4. Step 1 — Cognito cutover

### 4.1 The problem

`stacks/persistent` has empty state, so `terraform plan` today is **"2 to add"**
— a new `aws_cognito_user_pool` and client. The pool the running app actually
uses, `talon-throwaway-spec002`, was made by hand and is unmanaged: no
`ignore_changes = [schema]`, no deletion protection, and nothing for
`check-plan.py` to protect.

If `vars.AWS_DEPLOY_ROLE_ARN` were set before this is resolved, the next infra
merge to `main` would silently mint a second pool while the app kept pointing at
the old one. `check-plan.py` would not catch it — it blocks deletes and
replaces, not creates.

### 4.2 Why create fresh rather than adopt

`import.tf:4` already decided this: **"THE DECISION IS: CREATE FRESH. DO NOT
ADOPT."** Cognito pool names are immutable and `ForceNew`, so adoption pins the
name `talon-throwaway-spec002` permanently, and any later plan run without
`-var adopt_user_pool` proposes destroying the pool and every user in it.
Adoption also breaks §9.5a's acceptance test, which is "tear down and run again
from nothing" — a stack whose default path imports something that must already
exist cannot pass it.

The six demo users in the throwaway pool are disposable by design; `up.sh`
stage 7 recreates them.

### 4.3 Procedure

Ordered, and the deletion is deliberately last:

1. Human-run `terraform apply stacks/persistent` with `user_pool_domain_prefix`
   and `google_sso_secret_id` set, so the hosted domain and the Google IdP come
   up under Terraform rather than by hand.
2. Add the new pool's `https://<domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse`
   to the Google OAuth client's authorized redirect URIs. **Google redirects to
   Cognito, never to the app** — the app callback belongs in
   `oauth_callback_urls`, not in Google.
3. Repoint `apps/api` (`COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`) and
   `apps/web` (`COGNITO_DOMAIN`, `COGNITO_CLIENT_ID`) at the new pool.
4. Re-seed identities: `pnpm --filter api seed:identities`.
5. Verify a password sign-in and a Google sign-in end to end.
6. Only then delete `talon-throwaway-spec002`.
7. Only then set `vars.AWS_DEPLOY_ROLE_ARN`.

### 4.4 Why the dev OAuth values are checked-in defaults

The cutover was applied with `-var` flags. Terraform does not persist those, so
the very next plan — including every CI plan — proposed
`0 to add, 1 to change, 2 to destroy`: destroying the Google IdP and the hosted
domain that apply had just created, and stripping the client's OAuth settings.

`check-plan.py` would have caught the domain (`PROTECTED` matches
`aws_cognito_user_pool` and its `_`-prefixed children), so CI would have gone red
on every infra PR. It would **not** have caught the Google IdP:
`aws_cognito_identity_provider` is not in `PROTECTED`.

`*.tfvars` is gitignored (`.gitignore:25`), so a vars file cannot reach CI
either. A variable default is the only place both CI and `up.sh` read, so that
is where these live:

| Variable | Default |
|---|---|
| `user_pool_domain_prefix` | `talon-dev-auth-762079300828` |
| `oauth_callback_urls` | `["http://localhost:3000/api/auth/sso/callback"]` |
| `oauth_logout_urls` | `["http://localhost:3000/sign-in"]` |
| `supported_identity_providers` | `["COGNITO", "Google"]` |
| `google_sso_secret_id` | `talon-dev/sso/google` (a secret NAME, not a secret) |

**Known cost, stated rather than hidden:** the domain prefix embeds an account id
because Cognito prefixes are globally unique per region. A clone in another
account must override `user_pool_domain_prefix`, or the apply fails
`InvalidParameterException`. The alternative — deriving it in `locals.tf` from
`account_id` — is the better long-term answer but changes the documented meaning
of "empty means no domain is created", so it is deliberately not done as part of
a cutover.

Separately, `provider_details` on the Google IdP now declares the six endpoint
keys Cognito fills in itself. Without them every plan proposes removing them,
and a plan that is never clean is a plan people stop reading — which is the only
protection this stack has (CLAUDE.md #17).

## 5. Step 2 — Finish `stacks/persistent`

Add ECR, S3 and KMS, which spec 002 §2 already scopes to this stack.

- **ECR** repository plus a lifecycle policy. Must output `repository_url` —
  stage 4 has nothing to push to without it, and there is no such output today.
- **S3** the four buckets `var.data_bucket_suffixes` already names in
  `stacks/iam`: `uploads`, `exports`, `inbound-mail`, `quarantine`. The
  quarantine bucket is where CLAUDE.md #17's attacker-controlled resumes land.
- **KMS** the application key, fed back to `stacks/iam -var app_kms_key_arns`.

All three are in `check-plan.py`'s `PROTECTED` list, so a replacement fails CI.

## 6. Step 3 — Dockerfile and entrypoints

One image, three commands, selected by task-definition override. This is the
pattern CLAUDE.md §3 already uses for workers ("same image, different
entrypoint") and it means one build and one push per run.

| Command | Purpose |
|---|---|
| `node dist/server.js` | the api service |
| `node dist/migrate.js up` | stage 6, run once |
| the seed entrypoint | stage 8, run once |

`packages/db` already exports `./migrate` → `dist/migrate.js` and `./seed` →
`dist/seed.js`, and `migrate.ts` has a direct-invocation guard and reads
`argv[2]`, so no new application code is needed — this is a Dockerfile plus
command overrides.

**Two remote guards the task definitions must satisfy**, both of which refuse
published local-dev credentials against a non-loopback host:

- migrate needs `DATABASE_URL` (owner role) **and** `TALON_APP_PASSWORD`
- seed needs `SEED_PASSWORD`, and `seed-identities.ts` calls `loadConfig()`, so
  it needs the api's full config surface

## 7. Step 4 — `stacks/ephemeral`

VPC, Aurora Serverless v2, Redis, ECS, ALB.

**Two naming contracts, pre-recorded in spec 002 and ARCHITECTURE §9.6, that
fail at *runtime* rather than at apply if broken:**

1. The EventBridge bus must be `talon-<env>-*` (e.g. `talon-dev-events`), not
   bare `talon-dev`, or the outbox relay gets `AccessDenied` in production
   traffic.
2. The NAT instance role must be `talon-<env>-ec2-*` (e.g. `talon-dev-ec2-nat`)
   or apply fails on `PassRole`.

Add `ephemeral` to the **plan** matrix in `.github/workflows/terraform.yml`
(line 110). Do **not** add it to the apply matrix yet: a CI apply needs
`-var image_tag=$SHA` and the current apply step has no mechanism to supply one.
The `static` job needs no change — it globs `stacks/*/`.

## 8. Step 5 — `up.sh` and `down.sh`

The ten stages of ARCHITECTURE §9.5a, meeting its four testable requirements:
**idempotent** (running twice is a no-op), **resumable** (a failure at stage 6
is fixed and re-run from the top), **loud** (every stage prints what it did),
and **ends with a URL and credentials printed** — not "apply complete".

`TALON_ROLE_ARNS` parsing lives here. `stacks/iam`'s `role_arns_env` output is
the only definition of the format — comma-separated `key=arn` with keys
`ecs_task_execution`, `ecs_task`, `lambda_pretoken` — and nothing consumes it
today. Stage 2 is skipped entirely when it is set, which is the path CI takes,
because the deploy role is explicitly denied writing `role/talon-<env>-github-*`
and a CI apply of `stacks/iam` fails on its first IAM write (spec 002 §4.8).

`down.sh` destroys `ephemeral` by default; `--all` additionally destroys
`persistent` after a typed confirmation, because that deletes the Cognito pool
and every user in it. It flips `deletion_protection` to do so — which is why no
stack in this project uses `prevent_destroy`, since that cannot be flipped at
all.

## 9. Edge cases

1. **State bucket name drift.** `stacks/iam` locals and both CI jobs assume
   `talon-tfstate-<account>` and `talon-tfstate-lock`. Spec 002 edge case 6
   records that this coupling has no runtime check. `up.sh` stage 1 must create
   exactly those names or set `var.state_bucket_name` / `var.state_lock_table_name`.
2. **Shared AWS account.** Account 762079300828 also hosts unrelated projects
   (`talon-prod-*`, `manav-*`, `playpower-*`), and `talon/terraform.tfstate` in
   the state bucket belongs to one of them. Every operation must be scoped to
   `talon-dev-*`. `down.sh` must never sweep by prefix `talon-`.
3. **One OIDC provider per account.** It already exists, so creating it fails
   with `EntityAlreadyExists`. Handled in the config rather than by the caller:
   `stacks/iam` reads the existing provider through a data source by default and
   creates one only under `create_github_oidc_provider = true`. `up.sh` stage 2
   passes nothing — the earlier plan, to detect the ARN and pass
   `TF_VAR_github_oidc_provider_arn`, was the bug it was meant to avoid. A `-var`
   does not persist, so the next plan proposed creating the provider all over
   again; that is what turned CI's iam plan red, and it is the same defect as
   `user_pool_domain_prefix` in §4.4.
4. **Aurora cold start.** The first request after auto-pause may exceed the
   ALB health-check timeout. Stage 9 must poll `/v1/readyz` with a generous
   deadline rather than failing on the first non-200.
5. **`/v1/readyz` proves nothing today.** It returns `{ok:true}`
   unconditionally with no dependency probing, so stage 9 polling it does not
   prove the database is reachable. Either deepen the probe or have stage 9
   assert on a real authenticated request.
6. **`AWS_ENDPOINT_URL` must not be set on the task.** It is the SDK's global
   override and would point Cognito at LocalStack.

## 10. Test plan

The acceptance test is behavioural, per ARCHITECTURE §9.5a: **on a clean machine
with only AWS credentials, `./scripts/up.sh` completes and prints a URL that
signs in — verified by tearing down completely and running it again from
nothing.** A config that has never been applied from zero is a config that does
not work from zero.

- `terraform fmt`, `tflint`, `checkov`, `validate` — the existing `static` job
  covers the new stack automatically.
- `check-plan.py` must pass on the `ephemeral` plan.
- `up.sh` run twice in a row: the second run changes nothing.
- `down.sh` then `up.sh`: sign-in works again.

## 11. Open questions

None outstanding. The three from the plan were answered in §3.
