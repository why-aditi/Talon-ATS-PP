# Spec 005 — Job creation, job editing, and candidate intake

**Status:** specified, not started
**Milestone:** M0c. Follows spec 001 (jobs list) and spec 003 (pipeline board).
**Depends on:** spec 001 §6 (auth, tenancy, comp scope), spec 003 §4 (board contract)
**Blocks:** the review inbox (nothing to review until candidates can be added), offers

Three buttons are disabled today and this makes them work:

| Button | Where | Today |
|---|---|---|
| **+ New job** ×2 | sidebar, jobs header | Opens the JD template modal, which says "Nothing is saved and no job is created" |
| **Edit job** | `pipeline-board.tsx:127` | `<Button disabled>` |
| **+ Add candidate** | `pipeline-board.tsx:128` | `<Button disabled>` |

**Why now:** every screen after this one needs data a user created. The review
inbox reviews candidates somebody added; offers are made to applications somebody
created. Until then the product only ever shows seeded rows, and every flow past
the jobs list is demonstrable but not usable.

**The one-sentence job:** a recruiter can create a job through the four-step
wizard, change it afterwards, and add a candidate to its pipeline with a resume.

---

## 1. The starting position, stated plainly

The API has **no write endpoints at all**. Verified 2026-08-08:

```
apps/api   GET /v1/auth/… (sign-in, refresh)   GET /v1/jobs   GET /v1/jobs/:id
           GET /healthz  /readyz
           applicationsRoutes = async (_app) => {};      <- empty plugin
```

`packages/contracts` exports read schemas only. There is no `CreateJobRequest`,
no `UpdateJobRequest`, no `CreateApplicationRequest`. So this spec is mostly a
description of things that do not exist yet, and §12 sequences them.

`docs/reference/09-new-job-wizard@2x.png` shows **step 1 only**. Steps 2, 3 and 4
are named on the chips and drawn nowhere. §6.3–§6.5 specify them from the data
model and the PRD; they are the parts of this spec most likely to be wrong, and
they are marked as such rather than presented as measured.

---

## 2. Scope

**In**

- `POST /v1/jobs` — create, with its `job_stages` copied from a stage template
- `PATCH /v1/jobs/:id` — edit, with optimistic concurrency on a new `jobs.version`
- `POST /v1/candidates` and `POST /v1/applications` — candidate intake
- Resume upload end to end: presigned PUT → quarantine → scan → clean, and
  attachment-only presigned GET from a separate subdomain
- `/jobs/new` — the four-step wizard
- Edit job — a modal reusing the wizard's field components
- Add candidate — a modal on the pipeline board
- `jobs.version` and `candidate_files` migrations

**Out**

- **The JD template modal stays exactly as it is.** It is a copy-to-clipboard
  tool, not a creation path. Wiring a Create button into it would put two
  different intents in one dialog and give "+ New job" two destinations —
  non-negotiable #5 in the form it actually shows up in practice.
- Bulk candidate import (CSV, ATS migration)
- Candidate dedup and merge. Two applications for the same human are two rows;
  §10.9 says what happens on a repeat email and it is deliberately permissive.
- Editing a job's stages after creation. The wizard picks a template; changing
  the pipeline afterwards moves live applications between stages and is its own
  spec.
- Job deletion or archiving. `status: 'closed'` is the terminal state.
- Offer fields on the application
- Resume parsing / auto-fill

---

## 3. Data model changes

### 3.1 `0006_jobs_version` — optimistic concurrency for job edit

> Numbered 0006, not 0005: `0005_audit_authentication` landed on main on
> 2026-08-08 with the Cognito-only refactor. Check `packages/db/migrations/`
> before writing these — the numbers move under you when streams run in parallel.

`applications` has a `version` column and `jobs` does not, so two recruiters
editing the same job today would silently overwrite each other. The board already
has the 409 pattern; this gives job edit the same one.

```sql
-- 0006_jobs_version.up.sql
ALTER TABLE jobs ADD COLUMN version integer NOT NULL DEFAULT 1;

-- Every existing row starts at 1, which is what the DEFAULT does. No backfill
-- pass is needed: the column is NOT NULL with a constant default, so Postgres 11+
-- rewrites nothing and the table is not locked for the duration.
COMMENT ON COLUMN jobs.version IS
  'Optimistic concurrency. Bumped by any PATCH that changes a persisted field. See spec 005 §4.3.';
```

```sql
-- 0006_jobs_version.down.sql
ALTER TABLE jobs DROP COLUMN version;
```

**Backfill:** none. The default covers every existing row.

**Note for the schema stream:** unlike `applications`, `jobs` has no rank-only
write, so non-negotiable #18 has no analogue here — every `PATCH /v1/jobs/:id`
that changes anything bumps the version. Say so in the migration comment so
nobody later adds a "reorder" that quietly bumps it.

### 3.2 `0007_candidate_files` — resumes

```sql
-- 0007_candidate_files.up.sql
CREATE TABLE candidate_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  candidate_id  uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('resume', 'cover_letter', 'other')),

  -- What the user called it. NEVER used to build a path, and never echoed into a
  -- response header without re-encoding: it is attacker-controlled (#17).
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),

  -- S3 object key. Generated server-side from ids, never from `filename`.
  storage_key   text NOT NULL,

  -- quarantined -> clean | infected. A file is downloadable in exactly one state.
  scan_status   text NOT NULL DEFAULT 'quarantined'
                  CHECK (scan_status IN ('quarantined', 'clean', 'infected')),
  scanned_at    timestamptz,
  scanner_verdict text,

  uploaded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Cross-tenant references are prevented structurally, not by convention (#10).
  CONSTRAINT candidate_files_candidate_fk
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates (tenant_id, id),
  CONSTRAINT candidate_files_uploader_fk
    FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users (tenant_id, id),

  -- A scan verdict without a scan time is a row that lies about being checked.
  CONSTRAINT candidate_files_scanned_ck
    CHECK ((scan_status = 'quarantined') = (scanned_at IS NULL))
);

CREATE INDEX candidate_files_candidate_idx ON candidate_files (tenant_id, candidate_id);
-- Supports the sweeper in §5.5: find everything still quarantined and too old.
CREATE INDEX candidate_files_quarantined_idx ON candidate_files (scan_status, created_at)
  WHERE scan_status = 'quarantined';

ALTER TABLE candidate_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidate_files FORCE ROW LEVEL SECURITY;
CREATE POLICY candidate_files_tenant_isolation ON candidate_files
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

```sql
-- 0007_candidate_files.down.sql
DROP TABLE candidate_files;
```

**Backfill:** none — new table.

**Rollback safety:** dropping the table orphans objects in S3. The down migration
does not delete them and must not: a migration that deletes customer data on
rollback turns a recoverable mistake into an unrecoverable one. Orphans are
handled by the lifecycle rule in §5.5.

### 3.3 Composite unique for the composite FKs

`candidate_files_candidate_fk` needs `candidates (tenant_id, id)` to be unique.
If migration 0001 did not already add that (it did for the tables it references),
this migration adds it:

```sql
ALTER TABLE candidates ADD CONSTRAINT candidates_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE users      ADD CONSTRAINT users_tenant_id_key      UNIQUE (tenant_id, id);
```

Schema stream: check first, and drop this section from the migration if they
exist. A duplicate constraint is an apply failure, not a no-op.

---

## 4. API contract

All three endpoints are inside the authenticated scope. **None of them attaches
its own auth hook** — they inherit it from plugin scope, and the route-manifest
test fails CI if one escapes (§4.1).

All accept `Idempotency-Key` (§9). All write `audit_log` (#13).

### 4.1 Money, once, in one place

The wizard says "Band min (k)" and shows `180`. The column is `bigint` cents with
no default currency (#9). The conversion is therefore

```
cents = k × 100_000        (180 → 18_000_000)
k     = cents ÷ 100_000
```

and it lives in **`packages/domain`**, not in the client and not in the service:

```ts
/** Thousands-of-major-units (what the wizard shows) <-> minor units (what we store). */
export const kToCents = (k: number): bigint => BigInt(Math.round(k * 100_000));
export const centsToK = (cents: bigint): number => Number(cents) / 100_000;
```

`Math.round` before `BigInt`, because `BigInt(180.5 * 100_000)` on a
non-integer throws rather than rounding, and a half-thousand band (`180.5k`) is a
thing a recruiter will type.

The **contract carries cents**, not k. The `k` unit is a display affordance and
must not reach the wire, or two clients will disagree about what `180` means.

### 4.2 `POST /v1/jobs`

```ts
export const CreateJobRequestSchema = z.object({
  title: z.string().min(1).max(200),
  department: z.string().min(1).max(100),
  location: z.string().min(1).max(100),
  employmentType: z.string().max(50).optional(),

  /**
   * Required together or omitted together, and the currency is REQUIRED whenever
   * either amount is present. #9: a currency defaulting to 'USD' is an assumption
   * wearing a constraint, so omission is a validation error and never a guess.
   */
  bandMinCents: z.coerce.bigint().positive().optional(),
  bandMaxCents: z.coerce.bigint().positive().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).optional(),

  recruiterId: z.string().uuid().nullable().optional(),
  hiringManagerId: z.string().uuid().nullable().optional(),
  openings: z.number().int().min(1).max(999).default(1),
  stageTemplateId: z.string().uuid(),

  /** The wizard's Review step creates a draft; `active` is a deliberate choice. */
  status: z.enum(['draft', 'active']).default('draft'),
})
  .strict()
  .refine((v) => (v.bandMinCents === undefined) === (v.bandMaxCents === undefined), {
    message: 'Band minimum and maximum must be provided together',
    path: ['bandMaxCents'],
  })
  .refine((v) => v.bandMinCents === undefined || v.currency !== undefined, {
    message: 'A currency is required when a band is set',
    path: ['currency'],
  })
  .refine((v) => v.bandMinCents === undefined || v.bandMaxCents === undefined
    || v.bandMaxCents >= v.bandMinCents, {
    message: 'Band maximum must be at least the minimum',
    path: ['bandMaxCents'],
  });
```

`.strict()` for the reason `ListJobsQuerySchema` is: an unexpected key is a
client that thinks it is sending something, and silently dropping it is worse
than a 400.

**`reqCode` is not in the request.** It is generated server-side — see §4.6.

**Response:** `201` with the full `Job` (§9: writes return the full resource,
including its new `version`), plus `Location: /v1/jobs/{id}`.

**Transaction.** All of this or none of it:

1. Generate `reqCode` (§4.6)
2. `INSERT INTO jobs`
3. Read `stage_templates.stages` for `stageTemplateId`; `INSERT INTO job_stages`
   one row per entry, preserving `position`
4. `INSERT INTO audit_log` (`action: 'job.created'`)
5. Emit `job.created` (§9)

A job with no `job_stages` is a job whose board cannot render, so step 3 is not
optional and not deferred to first board load.

**Failures**

| Cause | Status | `type` |
|---|---|---|
| Body fails the schema | 400 | `…:validation-failed` |
| `stageTemplateId` is not this tenant's | 404 | `…:not-found` |
| `recruiterId` / `hiringManagerId` not in this tenant | 404 | `…:not-found` |
| Caller lacks `comp:read` and sent a band | 403 | `…:forbidden` (new — §4.7) |
| `reqCode` collision after retries | 500 | `…:internal` |

`stageTemplateId` from another tenant returns **404, never 403** — spec 001 §6.4:
a wrong-tenant id must be indistinguishable from a nonexistent one, or the API
becomes an existence oracle.

### 4.3 `PATCH /v1/jobs/:id`

```ts
export const UpdateJobRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  department: z.string().min(1).max(100).optional(),
  location: z.string().min(1).max(100).optional(),
  employmentType: z.string().max(50).nullable().optional(),

  bandMinCents: z.coerce.bigint().positive().nullable().optional(),
  bandMaxCents: z.coerce.bigint().positive().nullable().optional(),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable().optional(),

  recruiterId: z.string().uuid().nullable().optional(),
  hiringManagerId: z.string().uuid().nullable().optional(),
  openings: z.number().int().min(1).max(999).optional(),
  status: z.enum(['draft', 'active', 'on_hold', 'closing', 'closed']).optional(),

  /** Required. The version the client last read. */
  version: z.number().int().positive(),
}).strict();
```

**Absent and null are different, and this is the security-relevant part.**

- key **absent** → leave the column alone
- key present and **`null`** → clear the column

This is not style. Band is scope-gated (#2), so a recruiter without `comp:read`
receives a job object with `band` **omitted entirely**. If they open Edit job and
save, their client cannot send a band it never saw — and if PATCH treated absent
as "clear", saving a title would destroy a salary band the editor was never
allowed to see. Absent-means-untouched is what makes that impossible.

The API enforces the other half: **a caller without `comp:read` sending any of
`bandMinCents`, `bandMaxCents` or `currency` gets 403**, even to write `null`.
Read-gating a field while leaving it writable is not access control.

**Concurrency**

```sql
UPDATE jobs SET …, version = version + 1
 WHERE tenant_id = $tenant AND id = $id AND version = $expected
RETURNING *;
```

Zero rows → the row exists but the version moved, or it does not exist. Look it
up: exists → `409` with the current resource in the body so the client can show
what changed; does not exist → `404`.

```ts
export const JobConflictProblemSchema = ProblemSchema.extend({
  type: z.literal(ERROR_TYPES.JOB_VERSION_CONFLICT),
  status: z.literal(409),
  current: JobSchema,
});
```

Returning `current` matters: "someone else changed this" with no indication of
what they changed forces the user to discard their edit blind.

**A no-op PATCH still bumps `version`.** Comparing before and after to skip the
bump would make two concurrent identical edits both succeed, which is the same
lost-update the version exists to prevent, arrived at more expensively.

**Response:** `200` with the full `Job` including the new `version`.

### 4.4 `POST /v1/candidates`

```ts
export const CreateCandidateRequestSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(50).optional(),
  location: z.string().max(100).optional(),
  currentTitle: z.string().max(200).optional(),
  currentCompany: z.string().max(200).optional(),
  links: z.record(z.string().url()).default({}),
}).strict();
```

`email` is optional because `candidates.email` is nullable and sourcing a name
before an address is normal. `links` values are validated as URLs so a
`javascript:` string cannot be stored and later rendered as an anchor.

**Response:** `201` with the `Candidate`.

### 4.5 `POST /v1/applications`

```ts
export const CreateApplicationRequestSchema = z.object({
  jobId: z.string().uuid(),

  /** Exactly one: attach an existing candidate, or create one inline. */
  candidateId: z.string().uuid().optional(),
  candidate: CreateCandidateRequestSchema.optional(),

  /** Omitted means the job's first stage by position. */
  stageId: z.string().uuid().optional(),
  source: z.enum(['careers_page', 'outbound', 'referral', 'agency', 'import']),
  referredById: z.string().uuid().nullable().optional(),

  compExpectationMinCents: z.coerce.bigint().positive().nullable().optional(),
  compExpectationMaxCents: z.coerce.bigint().positive().nullable().optional(),
  compExpectationCurrency: z.string().length(3).regex(/^[A-Z]{3}$/).nullable().optional(),
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),

  /** Files already uploaded via §5. Must be this tenant's and still `clean`. */
  fileIds: z.array(z.string().uuid()).max(5).default([]),
})
  .strict()
  .refine((v) => (v.candidateId === undefined) !== (v.candidate === undefined), {
    message: 'Provide either candidateId or candidate, not both',
  })
  .refine((v) => v.compExpectationMinCents == null || v.compExpectationCurrency != null, {
    message: 'A currency is required when a comp expectation is set',
    path: ['compExpectationCurrency'],
  });
```

The one-or-the-other refinement is `!==` on two `undefined` checks — an
exclusive or. Both provided is as wrong as neither.

**Comp expectation is scope-gated exactly as the band is.** A caller without
`comp:read` sending any `compExpectation*` field gets 403.

**Transaction.** All of it or none:

1. Resolve or insert the candidate
2. Resolve `stageId`: given → must belong to `jobId`; omitted → lowest `position`
3. Compute `boardRank` — lexorank, at the **top** of the target column, so a new
   candidate is visible without scrolling
4. `INSERT INTO applications` with `stage_entered_at = now()`, `version = 1`
5. `INSERT INTO stage_transitions` — `from_stage_id = NULL`, `to_stage_id = stageId`,
   actor, `occurred_at = now()`. **Append-only (#4).** Every pipeline metric
   derives from this table, so an application created without its first
   transition is invisible to time-in-stage and conversion for its whole life.
6. Attach `fileIds`: verify each is this tenant's, belongs to this candidate, and
   `scan_status = 'clean'`. Anything else → 400.
7. `audit_log` (`action: 'application.created'`)
8. Emit `application.created`

Step 2's check is not belt-and-braces: `job_stages` carries a composite FK on
`(job_id, id)` (#10) so the database refuses a stage from another job, but the
API should answer 404 rather than let a constraint violation become a 500.

**Response:** `201` with the `ApplicationCard` shape spec 003 §4 already defines,
so the board can insert it without a refetch.

### 4.6 `reqCode` generation

The wizard has no req-code field, and `jobs.req_code` is `NOT NULL`. Seeded codes
are `ENG-204`, `DES-114`, `PPL-031`, `SAL-076` — a department prefix and a number.

```
prefix  = first 3 letters of department, uppercased, non-alpha stripped
          Engineering -> ENG   Design -> DES   People -> PPL(*)   Sales -> SAL
number  = max(existing number for this tenant+prefix) + 1, starting at 101
```

(*) "People" → "PEO" by that rule, but the seed says `PPL`. **This is open
question 3.** Until it is answered, use a table of known prefixes with the
first-3-letters rule as the fallback, so the seeded departments keep their codes.

Uniqueness is `(tenant_id, req_code)` and must be enforced by a **unique index**,
not by the read-then-write above — two concurrent creates in the same department
will otherwise pick the same number. On a collision, retry up to 3 times, then
500. Add in the same migration as §3.1:

```sql
CREATE UNIQUE INDEX jobs_tenant_req_code_key ON jobs (tenant_id, req_code);
```

### 4.7 A new error type

```ts
FORBIDDEN: 'urn:talon:error:forbidden',
JOB_VERSION_CONFLICT: 'urn:talon:error:job-version-conflict',
```

`FORBIDDEN` is genuinely new: every existing failure is 401 or 404, because until
now "you may not see this" was always answerable as "this does not exist". Comp
is different — the *job* is visible, the *field* is not — so 404 would be a lie
about the resource. It is only ever used for a field-level scope failure on a
resource the caller can otherwise see, and never as a stand-in for 404 on a
cross-tenant id.

---

## 5. Resume upload

Non-negotiables #17 and #20: candidate files are attacker-controlled, are never
rendered inline, are served from a separate subdomain with
`ResponseContentDisposition=attachment`, and are scanned before they leave
quarantine. An inline-rendered HTML or SVG resume runs script in a recruiter's
session with access to every candidate in the tenant.

### 5.1 Shape of the flow

```
browser  POST /v1/candidate-files/presign   { filename, contentType, sizeBytes }
  api    201 { fileId, uploadUrl, expiresIn }      row: scan_status='quarantined'
browser  PUT  {uploadUrl}                          -> s3://talon-{env}-quarantine
  s3     ObjectCreated -> SQS -> scanner worker
scanner  clean    -> copy to s3://talon-{env}-candidate-files, delete quarantine
                     object, UPDATE scan_status='clean'
         infected -> delete object, UPDATE scan_status='infected'
browser  POST /v1/applications { …, fileIds: [fileId] }
later    GET  /v1/candidate-files/:id/download -> 302 presigned GET on the
                                                   files subdomain, attachment
```

The client polls `GET /v1/candidate-files/:id` (or the endpoint returns
`scan_status`) until it leaves `quarantined`. Polling rather than a socket
because the wait is seconds and the board has no realtime channel yet.

### 5.2 Presign request

```ts
export const PresignUploadRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
  kind: z.enum(['resume', 'cover_letter', 'other']).default('resume'),
  candidateId: z.string().uuid().optional(),
}).strict();
```

An allow-list of three types, not a deny-list. `text/html` and `image/svg+xml`
are the exact payloads #17 exists for, and a deny-list is a list of the attacks
somebody thought of.

**`contentType` is a claim, not a fact.** The browser sends it and the scanner
re-derives the real type from the bytes; a mismatch is `infected`. The presigned
PUT is issued with a `Content-Type` condition and a `content-length-range`
condition, so S3 rejects an upload that does not match what was presigned —
otherwise the size limit above is advice.

**`storage_key` is `{tenant_id}/{file_id}{ext}`** where `ext` is derived from the
allow-listed `contentType`, never from `filename`. A filename of
`../../../etc/passwd` or `x.pdf\0.html` (a null-byte truncation) then cannot influence where the object
lands or what it is called.

### 5.3 Download

```
GET /v1/candidate-files/:id/download
  -> 404 unless the row is this tenant's AND scan_status = 'clean'
  -> 302 to a presigned GET, expiry 60s, with
       ResponseContentDisposition = attachment; filename="<sanitised>"
       ResponseContentType        = application/octet-stream
```

`ResponseContentType: application/octet-stream` regardless of the stored type:
even a genuine PDF is a download, never a render. The filename in the header is
re-encoded (RFC 6266 `filename*`), because it is user-supplied and a `"` or a
newline in it is a header-injection primitive.

A `quarantined` or `infected` file returns **404, not 403** — the same reasoning
as a cross-tenant id. "This exists but you cannot have it" tells an attacker
their upload landed.

### 5.4 Infra required (infra stream)

None of this exists — `infra/terraform` contains one stack (`iam`).

| Resource | Notes |
|---|---|
| `s3 talon-{env}-quarantine` | Block all public access. SSE-KMS. **Lifecycle: expire after 1 day** — nothing legitimate stays here. Event notification → SQS |
| `s3 talon-{env}-candidate-files` | Block all public access. SSE-KMS. Versioning on |
| SQS scan queue + DLQ | At-least-once, so the scan consumer is idempotent (#19), keyed on the object key |
| Scanner | ClamAV on Fargate, or an equivalent. Must also verify the magic bytes match the declared `contentType` |
| `files.{domain}` | **Separate subdomain** (#17). Not a convenience — a presigned URL on the app's own origin puts attacker-controlled bytes inside the app's cookie scope |
| IAM | Task role: PUT on quarantine, GET/PUT on candidate-files, KMS use. Scanner role: GET+DELETE quarantine, PUT candidate-files |
| CORS on quarantine | Only the app origin, only PUT, so a presigned URL cannot be driven from another site |

### 5.5 Sweeper

Anything still `quarantined` after 24h is a browser that requested a presign and
never uploaded, or a scan that was lost. A daily job marks those rows `infected`
with `scanner_verdict = 'expired-unscanned'` — fail closed, since a file that was
never scanned is not a file we can say is safe. The bucket's own lifecycle rule
deletes the object.

---

## 6. UI spec — the wizard

Route `/jobs/new`, inside the `(app)` group, so `RequireSession` already gates it.

Measured off `09-new-job-wizard@2x.png` by scanning the 2880px original for ink
extents and halving. **The design is 1440×900 CSS at 2×.**

### 6.1 Geometry

| Element | Measured (CSS @ 1440) |
|---|---|
| Card | x 517..1155 → **638 wide**; y 160..440 → 280 tall on step 1 |
| Card centring | content area is x 254..1416, centre 835; card centre 836 — **the card is centred**, not left-aligned |
| Card padding | 22.5 measured ≈ **24** (`--space-lg`) |
| Field width | 593 (card width − 2×24, less borders) |
| Band fields | 286 each, **21px gutter** |
| Input height | **34** (borders at y=198 and y=232) |
| Chip height | ~25 (borders at y=327 and y=352) |
| Step chip row | y 113..142 |
| Header row | y ≈ 84 ("New job", "Step 1 of 4", "Cancel") |
| Button row | y ≈ 472 |

`638px` is a new layout token — add `layout.wizardCardWidth` to
`design-tokens.json`. **Do not hardcode it**; the token guard
(`token-usage.test.ts`) matches arbitrary-value utilities and will fail on
`w-[638px]`.

### 6.2 Step 1 — Role basics *(measured; this is the reference screen)*

| Field | Control | Notes |
|---|---|---|
| Job title | text input, full width | placeholder `e.g. Senior Backend Engineer` |
| Department | chip group: Engineering, Design, People, Sales | single-select |
| Location | chip group: Remote (US), Remote (EU), SF / Hybrid, New York, London | single-select |
| Band min (k) / Band max (k) | two numeric inputs, 286 each | **k**, converted per §4.1 |
| **Currency** | **select, beside the band** | **Not on the reference.** Added under §11 open question 1 |

The chip groups are `role="radiogroup"` with `role="radio"` children, not
buttons: they are single-select, arrow keys must move between them, and a button
group announces four independent controls where there is one choice.

**Department and Location are free text in the database** but a fixed chip set in
the UI. The chips are the seeded values exactly. Treat them as **suggestions
backed by an "Other…" chip** that reveals a text input — a hard enum in the UI
over a text column is a constraint the database does not have and will be wrong
for the first customer with a "Customer Success" department.

**Currency** has **no default** and Continue is blocked until it is chosen *if a
band was entered*. With no band, currency is not required and not shown as an
error. This is the #9 rule expressed in the UI: the currency is never guessed.

### 6.3 Step 2 — Pipeline *(no reference — specified from the data model)*

Picks the `stageTemplateId` that §4.2 requires.

- A radio list of the tenant's `stage_templates`, each showing its stage names in
  order as read-only chips, so the choice is legible without opening anything
- Selecting one reveals per-stage **SLA (days)** number inputs, prefilled from
  the template's `sla_days`, editable
- Exactly one template must be selected to continue

**SLA overrides are held in wizard state and applied to the created `job_stages`
rows.** That means `POST /v1/jobs` needs one more optional field:

```ts
stageOverrides: z.array(z.object({
  position: z.number().int().min(0),
  slaDays: z.number().int().min(1).max(365).nullable(),
})).max(20).default([]),
```

Keyed by `position` rather than by a stage id, because the `job_stages` rows do
not exist until the transaction that reads this.

### 6.4 Step 3 — Hiring team *(no reference)*

- **Recruiter** — combobox over the tenant's users with role `recruiter` or
  `admin`; defaults to the signed-in user if they qualify
- **Hiring manager** — combobox over `hiring_manager` or `admin`
- **Openings** — number input, default 1

Both are optional: `jobs.recruiter_id` and `hiring_manager_id` are nullable, and
the jobs list already renders "Unassigned".

Needs an endpoint that does not exist: `GET /v1/users?role=recruiter`. Listed in
§12 and called out as a dependency rather than assumed.

### 6.5 Step 4 — Review *(no reference)*

Read-only summary of steps 1–3, each section with an **Edit** link that returns
to that step with state intact.

Two actions:

- **Create job** (primary) → `status: 'draft'`
- **Create and open** (secondary) → `status: 'draft'`, then navigate to the new
  job's board

**Both create a draft**, per the approved plan. A job goes `active` from the Edit
job dialog once its description is written — creating an active job straight from
a wizard publishes a req the moment somebody mistypes.

Band is shown here **only if the caller has `comp:read`**. A user without it
cannot have entered one (§6.2 hides the fields), so the section is absent rather
than empty.

### 6.6 States

| State | Trigger | Screen |
|---|---|---|
| Default | — | Step 1, Back disabled (nothing to go back to) |
| Step invalid | Continue with an invalid field | Inline errors under each field; focus moves to the first invalid control; Continue stays enabled so the second press is not a dead click |
| Submitting | Create pressed | Both buttons disabled, primary reads "Creating…"; wizard is not dismissable |
| Created | 201 | Navigate to `/jobs` (or the board), toast "ENG-205 created" |
| Error | 4xx/5xx | Non-blocking banner above the buttons, entered data preserved, "Try again". **Never** a full-page error — the user has typed four steps of data |
| Permission denied | `member` role | The route redirects to `/jobs` with a toast. Members cannot create jobs (§7) |
| Loading templates | step 2 | Skeleton rows at the real height, `aria-busy` |
| No templates | tenant has none | "No stage templates yet." Continue disabled — a job cannot be created without one, and pretending otherwise fails at submit |

### 6.7 Cancel and data loss

"Cancel" and browser-back with dirty state both open a confirm dialog: *"Discard
this job? Your answers will be lost."* Wizard state lives in a React reducer,
**not** in the URL and not in `localStorage`:

- the URL would put a half-written salary band in browser history
- `localStorage` would leave one on a shared machine after sign-out

Step position **is** in the URL (`/jobs/new?step=2`) so back and forward move
between steps, which is what the browser buttons are expected to do. On a hard
reload the state is gone and the wizard restarts at step 1 — stated here so it is
a decision, not a surprise.

---

## 7. UI spec — Edit job

A modal on the board (`pipeline-board.tsx`), not a route: it is a small
correction to an object already on screen, and a navigation would lose board
state. Fields are the **same components as wizard steps 1 and 3**, plus `status`.

- Prefilled from the `Job` already in the query cache — no fetch, no loading state
- `version` from that same object goes into the PATCH
- Sends **only changed fields**, which is what makes §4.3's absent-means-untouched
  work end to end
- **Band fields render only with `comp:read`.** Without it the section is absent,
  and the PATCH cannot carry band keys — so a hiring-adjacent user editing a
  title cannot destroy a band
- Not editable here: stages (out of scope), `reqCode` (immutable — it is on
  offer letters and in people's email)

**409 handling.** The board's existing conflict pattern: keep the user's edits,
show *"Someone else changed this job."* with what differs, and offer **Reload
theirs** (discard mine) or **Overwrite** (re-PATCH with the new version). Never
silently apply either — non-negotiable #14's rule, applied to a form instead of a
drag.

---

## 8. UI spec — Add candidate

Modal on the board, opened by `+ Add candidate`.

**Fields:** Name (required), Email, Current title, Current company, Location,
Source (required — the six `source` values), Stage (defaults to the first
column), Resume (file input), Comp expectation min/max + currency (**`comp:read`
only**), Notice period (days).

**Upload states** — the file input has five, and each one is visible:

| State | Screen |
|---|---|
| Empty | "Attach a resume — PDF or Word, up to 10 MB" |
| Uploading | Filename + determinate progress bar from the PUT's progress events |
| Scanning | "Checking this file…" with an indeterminate indicator; **Add candidate stays enabled** — §8.1 |
| Clean | Filename, size, and a Remove button |
| Infected / rejected | "This file couldn't be accepted." Row is removed, the rest of the form is untouched. **Never** "a virus was found" — that is the scanner's inference reported as fact to someone who will forward it to the candidate |

### 8.1 Submitting while a scan is pending

The candidate is created **without** the file, and the file attaches when the
scan finishes. Blocking submit on an antivirus round-trip makes intake feel
broken for the common case where nothing is wrong.

Consequence to design for, not hide: an application can briefly exist with no
resume, and if the scan comes back `infected` it stays that way. The card shows
"Resume rejected" rather than nothing, so the gap has a reason on screen.

---

## 9. Events

**Prerequisite: there is no `outbox` table.** `packages/db/src/schema.ts` has no
outbox and nothing emits events today. This section defines what these features
emit; the table itself belongs to whichever spec lands the outbox first, and this
one blocks on it.

| Event | Emitted by | Payload | Consumers |
|---|---|---|---|
| `job.created` | `POST /v1/jobs` | `{ jobId, tenantId, reqCode, status, actorId }` | search index (M1), notifications (M1) |
| `job.updated` | `PATCH /v1/jobs/:id` | `{ jobId, tenantId, changed: string[], version, actorId }` | search index, board invalidation |
| `application.created` | `POST /v1/applications` | `{ applicationId, candidateId, jobId, tenantId, stageId, source, actorId }` | review inbox (M1), notifications, analytics |
| `candidate_file.scanned` | scanner | `{ fileId, tenantId, candidateId, status }` | UI polling fallback, alerting on `infected` |

`job.updated` carries **`changed: string[]`, not the new values** — a payload
carrying `bandMinCents` would put comp data into every consumer's queue, and the
scope gate stops at the HTTP boundary if the event does not respect it.

All consumers are idempotent on `outbox.id` (#19).

---

## 10. Edge cases

1. **Two recruiters create a job in the same department at once.** Both compute
   the same `reqCode`. The unique index (§4.6) fails one; it retries and gets the
   next number. Never two `ENG-205`.
2. **Band max < band min.** 400 from the schema refinement, and the wizard blocks
   Continue with an inline message on the max field.
3. **Band entered, currency not chosen.** Continue blocked (§6.2). If it reaches
   the API anyway, 400 — the client is not the enforcement point.
4. **Band cleared on edit.** `bandMinCents: null, bandMaxCents: null,
   currency: null` — all three, or a currency is left on a job with no band.
5. **User without `comp:read` edits a job that has a band.** They never receive
   the band, their PATCH omits the keys, the columns are untouched. If they forge
   a band key, 403.
6. **Stage template deleted between step 2 and submit.** 404 on submit; the
   wizard returns to step 2 with "That pipeline is no longer available" and
   refetches.
7. **Job created with a template that has zero stages.** Refused at 400. A job
   with no stages renders an empty board and cannot accept an application.
8. **Candidate added to a job whose stages were changed underneath.** `stageId`
   no longer belongs to `jobId` → 404, modal refetches the board.
9. **Same email added twice to the same job.** Allowed, and creates a second
   application. Dedup is out of scope, and refusing it would block the real case
   of a candidate re-applying to a role they were rejected from. The modal warns
   ("A candidate with this email already exists") and offers to attach the
   existing candidate instead of creating a new one.
10. **Resume upload aborted mid-PUT.** The row stays `quarantined`; the sweeper
    (§5.5) marks it `infected/expired-unscanned` after 24h and the lifecycle rule
    deletes the object.
11. **File declared `application/pdf`, bytes are HTML.** The scanner's magic-byte
    check fails → `infected`. This is the #17 case, and it is why the declared
    content type is never trusted.
12. **`fileIds` references another tenant's file.** 400 — and RLS means the
    lookup returns nothing, so it cannot become a cross-tenant attachment even if
    the check were forgotten.
13. **Application created while the board is open in another tab.** The other tab
    sees it on next refetch. No realtime yet (spec 001 §11 OQ3).
14. **`openings` set to 0.** 400 — schema minimum is 1. A job with no openings is
    a closed job, expressed by `status`.
15. **Job set to `closed` while applications are active.** Allowed. Closing a req
    does not reject its candidates, and auto-rejecting them would write
    `stage_transitions` rows nobody asked for on an append-only table.
16. **Wizard reloaded at step 3.** State is gone (§6.7); restarts at step 1.
17. **Two tabs editing the same job.** Second save gets 409 with `current`, and
    §7's reload-or-overwrite choice.
18. **Idempotency-Key replayed on `POST /v1/jobs`.** Returns the original 201 and
    the same `reqCode`. Without this, a double-click on a slow network creates two
    reqs.

---

## 11. Permissions

| Action | admin | recruiter | hiring_manager | member |
|---|---|---|---|---|
| `POST /v1/jobs` | ✅ | ✅ | ❌ | ❌ |
| `PATCH /v1/jobs/:id` | ✅ | ✅ | ❌ *(§11 OQ4)* | ❌ |
| `POST /v1/applications` | ✅ | ✅ | ❌ | ❌ |
| Write band / comp expectation | ✅ | ✅ | ✅ | ❌ |
| Read band | ✅ | ✅ | ✅ | ❌ |
| Upload / download a resume | ✅ | ✅ | ✅ | ❌ |

Enforced in `service.ts`, **not in the route and not in the component** (#2).
The UI hides what a user may not do so the screen is honest; the API refuses it
so the screen is not the control.

---

## 12. Sequencing

§5's contracts must land before any UI is written (§5 of CLAUDE.md, contracts
first), and the three features are otherwise independent.

| # | Step | Owner | Blocks |
|---|---|---|---|
| 1 | `0006_jobs_version` (+ the req-code unique index) | schema | 3 |
| 2 | `0007_candidate_files` | schema | 5 |
| 3 | Contracts: create/update job, candidate, application, presign | api | 4, 6, 7, 8 |
| 4 | `POST /v1/jobs`, `PATCH /v1/jobs/:id`, `GET /v1/users?role=` | api | 6, 7 |
| 5 | S3 buckets, SQS, scanner, `files.` subdomain, IAM | infra | 8 |
| 6 | Wizard `/jobs/new` | web | — |
| 7 | Edit job modal | web | — |
| 8 | Add candidate modal + upload | web | — |

**Steps 6–8 enable their buttons only when the endpoint exists.** The pipeline
board is the cautionary case: it navigates cleanly and then shows an error,
because its data source was a mock that is now test-only (spec 003 §1 amendment).
A button that opens a form that cannot submit is the same mistake with more
typing in between.

---

## 13. Test plan

Keyed to the acceptance criteria in §14.

**Unit**

- `kToCents` / `centsToK` round-trip, including `180.5` and the `Math.round`
  boundary — the conversion is the one piece of arithmetic in this spec and it is
  off by 10⁵ if wrong
- `CreateJobRequestSchema` refinements: band without currency, max < min, one
  band bound alone
- `UpdateJobRequestSchema`: absent vs `null` produce different patch objects
- Req-code prefix derivation, including the `People → PPL` special case
- Wizard reducer: step navigation, per-step validation, Edit-from-review returns
  with state intact

**Integration (Testcontainers)**

- `POST /v1/jobs` creates the job *and* its `job_stages` in one transaction;
  forcing a failure at step 3 leaves **no** job row
- Concurrent creates in one department produce distinct req codes (run 10 in
  parallel against the unique index)
- `PATCH` with a stale `version` → 409 carrying `current`
- `PATCH` from a caller without `comp:read` carrying a band → 403, **and the
  column is unchanged**
- `PATCH` from a caller without `comp:read` omitting the band → 200, **and the
  band is still there**. This is the silent-wipe regression test and it is the
  single most important test in this spec
- `POST /v1/applications` writes exactly one `stage_transitions` row with
  `from_stage_id IS NULL`
- `stageId` from another job → 404
- Attaching a `quarantined` file → 400
- **Tenant isolation:** every one of these endpoints run as a hostile tenant —
  404 across the board, no exceptions

**E2E (Playwright)**

- Sign in → + New job → four steps → Create → the new job appears in the list
  with its generated req code
- Keyboard only, mouse untouched, through all four steps, including arrow-key
  movement within the chip groups
- Edit job → change the title → the board header updates
- Add candidate → the card appears at the top of the first column
- `axe` on every step and both modals — AA violations fail CI

**Not covered, and why**

- A real virus. The scanner is stubbed at the network layer; the `infected` path
  is driven by the stub, and the actual ClamAV integration is verified once by
  hand against EICAR. Said here rather than left implied.
- Two-tab concurrency on Edit job is covered by the 409 integration test, not by
  a real second browser — same limitation spec 003 §11.6 records.

---

## 14. Acceptance criteria

1. A recruiter can create a job through four steps; it appears in the jobs list
   with a generated req code and a full set of `job_stages`.
2. A job created with a band and a currency stores `bigint` cents, and the
   wizard's `180` round-trips as `180`.
3. Creating a job with a band but no currency is refused by both the wizard and
   the API.
4. Editing a job from a stale copy returns 409 with the current resource, and the
   user is offered reload-or-overwrite.
5. A user without `comp:read` can edit a job's title without altering its band.
6. Adding a candidate creates candidate + application + exactly one
   `stage_transitions` row, and the card appears at the top of its column.
7. A resume uploads, is scanned, and is downloadable only as an attachment from
   the files subdomain; an unscanned or infected file 404s.
8. Every endpoint returns 404 to a hostile tenant.
9. All four wizard steps and both modals are operable by keyboard alone and clean
   under `axe`.

---

## 15. Open questions

1. **Currency on step 1 — approved, but where exactly?** Adding a control the
   reference does not show changes measured geometry: the card grows and the band
   row becomes three fields, not two. Options: a third field on the band row
   (287 + 21 + 143 + 21 + 143), or a currency prefix inside the min field.
   **Owner: Aditi.** Needs answering before the wizard is built, not before the
   API is.
2. **Steps 2–4 have no reference design.** §6.3–§6.5 are specified from the data
   model and are the most likely part of this spec to be wrong. Worth a design
   pass before build. **Owner: Aditi.**
3. **`People → PPL`, not `PEO`.** The seed uses `PPL`. Is the prefix a lookup
   table, a per-department stored field, or a rule with exceptions? A stored
   `jobs.req_prefix` on a departments table is the honest answer if departments
   ever become first-class. **Owner: api.**
4. **May a hiring manager edit their own job?** §11 says no, which is the safe
   default and probably wrong for the product — an HM changing the location of a
   req they own is normal. Needs a per-job membership check, which does not exist
   yet. **Owner: Aditi.**
5. **The outbox does not exist** (§9). Which spec lands it? This one blocks on it
   for events, though the endpoints work without it. **Owner: api.**
6. **Draft-vs-active on creation.** §6.5 creates drafts. Nothing currently moves a
   job to `active` except the Edit modal's status field — is that the intended
   publish flow, or should there be a distinct "Publish" action with its own
   permission? **Owner: Aditi.**
7. **`GET /v1/users?role=` does not exist** and step 3 needs it. Small, but it is
   a fourth endpoint nobody has counted. **Owner: api.**
