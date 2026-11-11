# Tech Debt

What's owed, scored, with a plan to pay it down alongside feature work. Reviewed 2026-11-11, decisions updated the same day.

The code itself is in good shape: logic lives in testable modules, the security spec (S1–S10, P1–P7) is enforced by tests and lint, and the scripts are resumable. The debt is mostly around the code: CI that isn't enabled yet, and results nobody measures.

This is a portfolio project, run locally. There's no public deployment planned, and the plan below is sized for that.

## Table of Contents

- [Scoring](#scoring)
- [The list](#the-list)
- [Clark's TODOs](#clarks-todos)
- [When CI goes on GitHub](#when-ci-goes-on-github)
- [Phase 2: before tuning search](#phase-2-before-tuning-search)
- [Phase 3: when the code is next touched](#phase-3-when-the-code-is-next-touched)
- [Parked](#parked)
- [Done](#done)
- [Every slice](#every-slice)

## Scoring

Each item gets Impact (how much it slows work), Risk (what happens if it's left) and Effort, all 1–5.
**Priority = (Impact + Risk) × (6 − Effort).** Higher goes first.

## The list

| # | Item | Type | I | R | E | Score |
| --- | --- | --- | --- | --- | --- | --- |
| 3 | No relevance check with real embeddings | Test | 4 | 3 | 2 | **28** |
| 7 | `/api/health` says "ok" with Mongo down | Code | 1 | 2 | 1 | **15** |
| 9 | Stale `vue-router@4` dependency warns during typecheck | Dependency | 1 | 1 | 1 | **10** |
| 1 | CI has never run on GitHub | Infrastructure | | | | parked: CI not pushed |
| 4 | No Dependabot; workflow permissions not set | Dependency | | | | parked: CI not pushed |
| 5 | Before-public hardening | Security | | | | parked, fixes in the spec |
| 6 | Two TypeScript aliases | Dependency | | | | done |
| 8 | Year-range formatting written three times | Code | | | | done |
| 2 | AI descriptions aren't backed up | Data | | | | won't do |

### 1. CI has never run on GitHub (parked)

`.github/workflows/ci.yml` sets up Node with `node-version-file: .nvmrc`, and there was no `.nvmrc`, so both jobs would have failed before anything was checked. **`.nvmrc` now says `26`.** The workflow is **kept locally but not pushed** (decided 2026-11-11): it's untracked and listed in `.gitignore`, because GitHub runs any workflow file it receives. Until it's enabled, `pnpm check` before pushing does the same job. Steps to turn it on are in [When CI goes on GitHub](#when-ci-goes-on-github).

`engines` stays at `>=22.18.0`: that's the real floor (Node's built-in type stripping, which the scripts rely on). `.nvmrc` is what we develop and test on.

### 3. No relevance check with real embeddings (28)

The integration tests use stand-in vectors, which prove the plumbing but say nothing about result quality. Results are known to be rough ("medium sedan" returns an SL-Class), and without a repeatable check, every change to `embeddingText`, the describe prompt or the model is judged by eye.

**Method designed (2026-11-11):** [Measuring search quality](evaluation.md) covers the labeled searches, the scores (nDCG@5, Hit@1, MRR), and win/loss rules with a guardrail for exact-name searches, all checked with a simulation (about 20 searches is enough). The relevance check below is its pass/fail half; the scored `pnpm eval` is the other.

### 4. Dependabot and workflow permissions (parked with #1)

`pnpm audit` has 4 known findings waiting on upstream fixes (S9), and nothing will say when the fixes land.

**On pinning Actions to commit SHAs:** a tag like `actions/checkout@v4` can be moved to different code by whoever controls that repo. If an action's repo is hijacked, the attacker moves the tag, and every workflow using it runs their code with that workflow's token. This happened in March 2025 (`tj-actions/changed-files`), leaking secrets from thousands of repos. Pinning to a SHA means a moved tag changes nothing.

**For this repo it's not worth it:** the workflow has no secrets (the relevance check runs by hand), only official GitHub and pnpm actions, and pinning adds update churn. The cheap part of the same protection is limiting the token: `permissions: contents: read` at the top of the workflow, so a bad action couldn't push or change anything even if it ran.

### 7. Health check doesn't check health (15)

[health.get.ts](../server/api/health.get.ts) always returns `ok`. A Mongo ping would make it useful in the runbook.

### 9. Stale vue-router (10)

`package.json` lists `vue-router@^4.6.4`, but Nuxt 4.6 brings `vue-router@5.4.0`, and nothing imports vue-router directly. Vue's type tooling resolves a plugin against the old copy and prints `Resolve plugin path failed: vue-router/volar/sfc-route-blocks` during `pnpm typecheck`. The check still passes; the warning is noise that hides real ones.

## Clark's TODOs

- [ ] **Commit the slice** (everything staged, minus the CI workflow, which stays local).
- [ ] **#3** Look over the [query set](#3-relevance-check) and add or drop cases.

Decided 2026-11-11: Node 26; the relevance check runs by hand; no public demo; the TypeScript aliases go; descriptions stay uncommitted (#2); no SHA pinning (#4); the CI workflow stays out of the repo for now (#1); manual testing is enough until this becomes something to run with.

## When CI goes on GitHub

**#1 CI**
- Remove the `.github/workflows/ci.yml` line from `.gitignore`, add `permissions: contents: read` to the workflow (below), and commit it.
- Push, and fix whatever the first run finds. The integration job's `docker compose up -d --wait` has never run on a GitHub runner, so check that mongot comes up there.
- Verify: both jobs green.

**#4 Dependabot and permissions**
- `.github/dependabot.yml`: npm weekly, grouped into one PR for `nuxt*` + `@nuxt/*` and one for dev tooling. GitHub Actions monthly.
- `ci.yml`: `permissions: contents: read` at the top.
- Spec S9: note that Dependabot now watches for the upstream fixes.

## Phase 2: before tuning search

### #3 Relevance check

- `tests/relevance/search.test.ts`, run by hand with `pnpm test:relevance` against the real ingested database and real embeddings. It skips with a clear message if `NUXT_OPENAI_KEY` isn't set, and isn't part of `pnpm check` or CI. A run is 8 embedding calls, a tiny fraction of a cent.
- It prints the top 5 for every query with scores, so a change can be compared before and after.
- Two kinds of case: **checks** fail the run; **watches** only print, for known weak spots, so they can be seen improving without blocking anything.

| Query | Edge case | Kind | Expect |
| --- | --- | --- | --- |
| "honda civic" | Exact name | Check | Honda Civic is first |
| "civic type r" | A trim that's a separate model | Check | Civic Type R ranks above Civic |
| "2018 accord" | Single-year filter | Check | Accord is first, and every result is sold in 2016–2020 |
| "1955 Custom Belair" | A year that's part of a name | Check | No year filter applied, and the kit car is in the top 5 |
| "small honda" | Make plus a vague size | Check | At least 4 of the top 5 are Hondas |
| "medium sedan" | Body style only, no make | Watch | Today: an SL-Class roadster ranks second |
| "pickup truck" | Outside the catalog (cars only) | Watch | Scores stay low; nothing claims to be a truck |
| "asdf qwerty" | Nonsense | Watch | Scores near the bottom of the range |

- Spec: tick the acceptance boxes this covers, and link the test.
- This is the tool for fixing "medium sedan", so it lands before any tuning.

## Phase 3: when the code is next touched

- **#7** `health.get.ts`: `await (await getDb()).command({ ping: 1 })`, and a 503 with a generic message on failure (S6). Check it in the runbook; a unit test isn't worth it.
- **#9** Remove `vue-router` from `dependencies` and run `pnpm typecheck`: the warning should be gone.

## Parked

| # | Item | Revisit when |
| --- | --- | --- |
| 5 | Rate limiting, `nuxt-security` (CSP and headers), OpenAI budget alerts, error text written for visitors instead of developers. The README warns about it, and each fix is written up in the spec's [Before going public](specs/ingest-search.md#before-going-public) | If a public demo is ever planned. Today it isn't: the project runs locally and is shown through the repo and screenshots |
| 1, 4 | CI on GitHub, Dependabot, workflow permissions | When CI is wanted; see [When CI goes on GitHub](#when-ci-goes-on-github) |

## Done

- **#6 TypeScript aliases (2026-11-11).** `typescript` pointed at the TS 6 package (`@typescript/typescript6`) so vue-tsc could use its JavaScript API, and `@typescript/native` pointed at TS 7 (Go) for a faster `tsc -p scripts`. That speed doesn't matter at this size, so both are replaced by plain `typescript@^6.0.3`. `pnpm check` is green: lint, typecheck, 67 unit tests. Move to TS 7 when vue-tsc supports it.
- **#1, first half (2026-11-11).** `.nvmrc` added with `26`.
- **#8 Year-range formatting (2026-11-11).** One `formatYears(years, dash)` in [shared/utils/years.ts](../shared/utils/years.ts), used by the page and the describe prompt (with `"-"`, so the prompt text is unchanged). The page's catalog years now come from `GET /api/catalog` instead of being hard-coded. (`span` in `screenshot.ts` builds year lists for fixture data rather than formatting them, so it stays.)
- **Also 2026-11-11:** ESLint's style rules turned on as the formatter (double quotes, semicolons, 4-space indent) and applied once; the empty `server/db/` leftover removed.

- **#2 Descriptions: won't do (2026-11-11).** `data/descriptions.json` stays gitignored. This is a proof of concept, so losing the file or getting different descriptions after a rerun doesn't matter.

## Every slice

1. `pnpm check` is green (lint, typecheck, unit tests).
2. `pnpm test:integration` with `docker compose up -d`, if the slice touches ingest or search.
3. Docs change with the code: the spec, runbook or API doc that covers it.
4. Clark reviews the diff and commits.
