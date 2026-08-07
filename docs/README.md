# Talon ATS — Documentation

A multi-tenant applicant tracking system, built from nine reference screens. Full stack, AWS infrastructure as code, real calendar sync, Playwright end to end.

## The docs

**Repo layout**

```
CLAUDE.md          ← repo root, read first
docs/
  README.md        ← you are here
  PRD.md  ARCHITECTURE.md  DESIGN_SYSTEM.md  design-tokens.json
  reference/       ← the nine screens at 2x
```

| File | What it answers | Read it when |
|---|---|---|
| **[CLAUDE.md](../CLAUDE.md)** | How we work, non-negotiables, repo layout, sub-agents, commands | First. Lives at the repo root (one level up) so Claude Code picks it up automatically |
| **[PRD.md](./PRD.md)** | What we're building and why — scope per screen, acceptance criteria, permissions, milestones, risks | Before planning any feature |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Stack and rationale, module boundaries, full data model, the three hard subsystems, AWS topology, testing | Before writing code or infra |
| **[design-tokens.json](./design-tokens.json)** | Every color, type ramp, spacing, radius, shadow, motion value | Building any UI |
| **[DESIGN_SYSTEM.md](./DESIGN_SYSTEM.md)** | How tokens become components, screen by screen; a11y contract; copy rules | Building any UI |
| **[reference/](./reference/)** | The nine screens at 2x, extracted losslessly from the source PDF | Whenever a doc is ambiguous |

Reference screens live in `docs/reference/` as `NN-name@2x.png`, extracted losslessly from the source PDF at 2880×1800. **The design is 1440×900 CSS at 2x.** When a doc and a screen disagree, ask — don't pick one.

**Token verification status:** colors and layout in `design-tokens.json` were measured pixel-wise off those originals and are authoritative. Typography sizes are still provisional — font metrics can't be recovered reliably from raster. Shadows are estimated; motion values are conventions, not observations. See `_meta.confidence`.

## Start here

```
1. Read CLAUDE.md end to end (10 min). It governs how every task runs.
2. Skim PRD.md §5 for the screen you're about to touch.
3. Auth and IaC are decided (below). Don't reopen them mid-build.
4. Build the M0 boundary scaffolding (ARCHITECTURE §4.1) FIRST — it is a
   prerequisite for parallel work, not cleanup.
5. Then: spec → review → build.
```

## Decisions already made

- **Fastify 5 on Node 22**, not NestJS — the Zod contract chain stays single-source. The structure Nest would have enforced is replaced by ARCHITECTURE §4.1, which is a **prerequisite for feature work**, not cleanup.
- **The application is the pipeline entity**, not the candidate. Same person, two roles, two independent journeys.
- **`stage_transitions` is append-only** and every metric on every screen derives from it. Nothing is a stored counter.
- **Modular monolith**, deliberately. No microservices, no Kafka, no EKS at v1.
- **Cognito + Terraform** — see below.

## Decisions closed

| Decision | Choice | Why |
|---|---|---|
| Auth provider | **Cognito** | The only option that lives inside the Terraform stack, so `terraform apply` yields a system you can log into. Behind an `IdentityProvider` interface — write against the interface, not the SDK |
| IaC tool | **Terraform** | **One** AWS account, environments separated by name prefix and tag. Root module per env, S3 + DynamoDB state. Layout in ARCHITECTURE §9.5, cost profiles in §9.6, rough edges in §9.7 |

Rejected alternatives and the reasoning are in ARCHITECTURE §2 so nobody reopens them by accident.

**The one hazard that follows from Cognito + Terraform:** pool schema attributes are immutable, and a schema diff force-replaces the pool, destroying every user. Tenancy and roles therefore live in the `users` table keyed by `sub`, with claims injected by a pre-token-generation Lambda — never as Cognito custom attributes. See ARCHITECTURE §9.4.

## The five expensive areas

Bugs here cost more than bugs elsewhere. Any change touching them gets extra scrutiny and its own tests:

1. **Tenancy** — `tenant_id` on every row, RLS as the backstop, hostile-tenant suite in CI
2. **Comp visibility** — scope-gated at the API layer; hiding a field in the UI is not access control
3. **Scorecard blindness** — enforced in the query, not the component
4. **Calendar writes** — failure mode is "no slot offered," never "double-booked"
5. **Candidate file handling** — resumes are attacker-controlled files opened by your recruiters. Scan on ingest, serve as attachment from a separate origin, never render inline (ARCHITECTURE §9.10)

## Working loop

Listen → ask → identify problems → plan → **review gate** → detailed spec → build with sub-agents → test, including a real pass in Claude in Chrome.

Full version in CLAUDE.md §1. Phase 5 is a hard stop: the plan gets reviewed before implementation starts.