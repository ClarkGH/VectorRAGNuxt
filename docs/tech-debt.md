# Tech Debt

What's owed, scored, with a plan to pay it down alongside feature work. Reviewed 2026-11-11, decisions updated the same day.

The code itself is in good shape: logic lives in testable modules, the security spec (S1–S10, P1–P7) is enforced by tests and lint, and the scripts are resumable. The debt was mostly around the code. What's left is CI, which isn't enabled yet.

This is a portfolio project, run locally. There's no public deployment planned, and the plan below is sized for that.

## Table of Contents

- [Scoring](#scoring)
- [The list](#the-list)
- [Clark's TODOs](#clarks-todos)
- [When CI goes on GitHub](#when-ci-goes-on-github)
- [Parked](#parked)
- [Done](#done)
- [Every slice](#every-slice)

## Scoring

Each item gets Impact (how much it slows work), Risk (what happens if it's left) and Effort, all 1–5.
**Priority = (Impact + Risk) × (6 − Effort).** Higher goes first.

## The list

| # | Item | Type | I | R | E | Score |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | CI has never run on GitHub | Infrastructure | | | | parked: CI not pushed |
| 4 | No Dependabot; workflow permissions not set | Dependency | | | | parked: CI not pushed |
| 5 | Before-public hardening | Security | | | | parked, fixes in the spec |
| 3 | No relevance check with real embeddings | Test | 4 | 3 | 2 | done |
| 7 | `/api/health` says "ok" with Mongo down | Code | 1 | 2 | 1 | done |
| 9 | Stale `vue-router@4` dependency warns during typecheck | Dependency | 1 | 1 | 1 | done |
| 6 | Two TypeScript aliases | Dependency | | | | done |
| 8 | Year-range formatting written three times | Code | | | | done |
| 2 | AI descriptions aren't backed up | Data | | | | won't do |

### 1. CI has never run on GitHub (parked)

`.github/workflows/ci.yml` sets up Node with `node-version-file: .nvmrc`, and there was no `.nvmrc`, so both jobs would have failed before anything was checked. **`.nvmrc` now says `26`.** The workflow is **kept locally but not pushed** (decided 2026-11-11): it's untracked and listed in `.gitignore`, because GitHub runs any workflow file it receives. Until it's enabled, `pnpm check` before pushing does the same job. Steps to turn it on are in [When CI goes on GitHub](#when-ci-goes-on-github).

`engines` stays at `>=22.18.0`: that's the real floor (Node's built-in type stripping, which the scripts rely on). `.nvmrc` is what we develop and test on.

### 4. Dependabot and workflow permissions (parked with #1)

`pnpm audit` has 4 known findings waiting on upstream fixes (S9), and nothing will say when the fixes land.

**On pinning Actions to commit SHAs:** a tag like `actions/checkout@v4` can be moved to different code by whoever controls that repo. If an action's repo is hijacked, the attacker moves the tag, and every workflow using it runs their code with that workflow's token. This happened in March 2025 (`tj-actions/changed-files`), leaking secrets from thousands of repos. Pinning to a SHA means a moved tag changes nothing.

**For this repo it's not worth it:** the workflow has no secrets (the relevance check runs by hand), only official GitHub and pnpm actions, and pinning adds update churn. The cheap part of the same protection is limiting the token: `permissions: contents: read` at the top of the workflow, so a bad action couldn't push or change anything even if it ran.

## Clark's TODOs

- [ ] **Commit the slice** (everything staged, minus the CI workflow, which stays local). Clark: Forget about this one, delete TODO when no other TODOs are here.
- [ ] **Review the golden set** ([eval/golden.json](../eval/golden.json)): check each AI-drafted label and set `reviewed: true`. The first run showed right answers the drafts miss (Hyundai Accent, Chevy Sonic, Prius C, Prius Prime, Scion FR-S, Ford Fusion, Lincoln Continental, Toyota Crown, Chevy Bolt EUV); add them, then re-run both labels and compare ([runbook](runbook.md#score-search-quality)). Clark: check if all are reviewed and mark done if satisfactory
- [ ] **Decide on niche makers (spec decision 3):** they now get in the way. "ELECTRIC MOBILE CARS Electric Mobile Cars" is #1 for "electric car", and "MK SPORTSCARS" / "CLASSIC SPORTS CARS" lead "small sports car" ([first results](evaluation.md#first-results-2026-11-12)). Clark: Remove niche makers, they've now become a problem and log as needed.

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

## Parked

| # | Item | Revisit when |
| --- | --- | --- |
| 5 | Rate limiting, `nuxt-security` (CSP and headers), OpenAI budget alerts, error text written for visitors instead of developers. The README warns about it, and each fix is written up in the spec's [Before going public](specs/ingest-search.md#before-going-public) | If a public demo is ever planned. Today it isn't: the project runs locally and is shown through the repo and screenshots |
| 1, 4 | CI on GitHub, Dependabot, workflow permissions | When CI is wanted; see [When CI goes on GitHub](#when-ci-goes-on-github) |

## Done

- **#3 Relevance check (2026-11-11).** `pnpm test:relevance` ([tests/relevance/search.test.ts](../tests/relevance/search.test.ts)) runs 8 real searches against the ingested database with real embeddings, by hand only. Five checks fail the run: "honda civic" puts the Civic first, "civic type r" ranks the Type R above the Civic, "2018 accord" puts the Accord first with everything sold in 2016–2020, "1955 Custom Belair" isn't year-filtered and finds the kit car, and "small honda" returns at least 4 Hondas. Three watches only print: "medium sedan" (the SL-Class is still second), "pickup truck" (finds the few "car" listings named Truck or Pickup) and "asdf qwerty" (tops out around 64%, against 80–94% for real searches). All checks passed on the first run. It prints the top 5 per query, to compare before and after a change; see the [runbook](runbook.md#check-search-quality). The scored half is [Measuring search quality](evaluation.md).
- **#3, scored half (2026-11-12).** `pnpm eval run` / `compare` ([scripts/eval.ts](../scripts/eval.ts), golden set in [eval/golden.json](../eval/golden.json)) with the win/loss rules from [evaluation.md](evaluation.md). First comparison, with AI-drafted labels: descriptions are a narrow **WIN** (nDCG@5 0.71 → 0.78). Provisional until the labels are reviewed; see the TODOs.
- **#7 Health check (2026-11-11).** `/api/health` pings Mongo: 200 `ok` when it answers, 503 `Database is unavailable right now` when it doesn't, with the reason in the server log only (S6). Checked both against a dev server. OpenAI isn't checked, since that would spend a request each time.
- **#9 Stale vue-router (2026-11-11).** Removed `vue-router@^4` from `dependencies` (Nuxt brings its own, 5.x). The typecheck warning is gone.
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
