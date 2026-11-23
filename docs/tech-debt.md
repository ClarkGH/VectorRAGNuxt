# Tech Debt

What's owed, scored, with a plan to pay it down alongside feature work. Reviewed 2026-11-11, decisions updated the same day; brought up to date 2026-11-17.

The code itself is in good shape: logic lives in testable modules, the security spec (S1–S10, S17, P1–P7) is enforced by tests and lint, and the scripts are resumable. The debt was mostly around the code, and the actionable part is paid off. Only before-public hardening is left, and it's parked.

This is a learning project, run locally and set aside once the analysis is done. There's no public deployment planned, and the plan below is sized for that.

## Table of Contents

- [Scoring](#scoring)
- [The list](#the-list)
- [Clark's TODOs](#clarks-todos)
- [Parked](#parked)
- [Done](#done)
- [Every slice](#every-slice)

## Scoring

Each item gets Impact (how much it slows work), Risk (what happens if it's left) and Effort, all 1–5.
**Priority = (Impact + Risk) × (6 − Effort).** Higher goes first.

## The list

| # | Item | Type | I | R | E | Score |
| --- | --- | --- | --- | --- | --- | --- |
| 15 | Yellow accents, direction C (Search button, band stripe, AI pick notes) | Design | 1 | 1 | 2 | 8, next (the MCP server is built) |
| 11 | Stack review before the G slice (2026-11-17) | Security, Code, Spec | | | | done |
| 5 | Before-public hardening | Security | | | | parked, fixes in the spec |
| 12 | Answer cache in Redis instead of Mongo | Architecture | 1 | 1 | 3 | 6, stretch |
| 13 | Searches that name a car outside the results get no answer | Code, UX | 2 | 1 | 2 | 12, stretch |
| 14 | Search quality on everyday wording ("gas efficient car"); the display half is done (words, not percentages) | Search | 2 | 1 | 3 | 9 |
| 10 | Niche makers crowd out real answers: remove them from the dataset | Data | 4 | 3 | 2 | done (83 makers) |
| 4 | No Dependabot | Dependency | | | | done |
| 3 | No relevance check with real embeddings | Test | 4 | 3 | 2 | done |
| 7 | `/api/health` says "ok" with Mongo down | Code | 1 | 2 | 1 | done |
| 9 | Stale `vue-router@4` dependency warns during typecheck | Dependency | 1 | 1 | 1 | done |
| 6 | Two TypeScript aliases | Dependency | | | | done |
| 8 | Year-range formatting written three times | Code | | | | done |
| 2 | AI descriptions aren't backed up | Data | | | | won't do |

### 15. Yellow accents, direction C

**Chosen 2026-11-20 (Clark); build after the [MCP server](specs/mcp-server.md).** Bring in some of the car-pricing-site yellow, close to Kelley Blue Book's feel without copying it. Three directions were mocked up in light and dark next to today's page; Clark picked **C, mixed**: yellow for the brand and the AI, blue for search data. The mock-ups are on a private design canvas (Clark's claude.ai artifacts, "Closest Car — yellow accents").

**What changes:**

| Element | Light | Dark |
|---|---|---|
| Search button | `#F6C445` background, navy text `#0b2343`, bold (about 9:1) | Same |
| Navy band | A 6 px yellow stripe along its bottom edge | Same; it also separates the band from the dark page, which sit close in color |
| "AI pick" notes on result cards | Background `#FFF4D1`, label `#6B4E00` | Background `#3A3115`, label in the yellow |

**What stays blue:** match strength and its meter, rank numbers, the cards' inset edge, links, and the answer panel. Yellow is never used for text on white, where it fails contrast.

**How:** new tokens in [main.css](../app/assets/css/main.css), in both `:root` and `.dark` (for example `--brand`, `--brand-ink`, `--pick-bg`, `--pick-label`), and the Search button gets its own class instead of the shared `.action-button`. Then re-check contrast and focus rings in both themes, and refresh the screenshots (`docs/images/` and the portfolio).

**Decide when building:** the "Explain these results" button. It's an AI action, which argues for yellow, but in C only Search is yellow and the mock-up shows the answered state, where the button is gone. Also check that the yellow's focus ring is visible on the white search box.

### 14. Search quality on everyday wording

**Found by hand, 2026-11-18** ([evaluation](evaluation.md#seen-by-hand-gas-efficient-car-2026-11-18)). "gas efficient car" tops out at 52% and misses the regular Prius, while "fuel efficient hybrid" finds the hybrids. Two problems:

- **Ranking:** the descriptions never say "gas", and the embedding doesn't bridge "gas" and "fuel" well. Options, cheapest first: add searches like this to the golden set so it's measured; have descriptions mention common shopper words (a `pnpm describe` prompt change plus re-ingest, about 12 calls); or hybrid search, keyword plus vector, so exact words count too.
- **Display:** real results land at 50–70% on the 0.5-is-unrelated scale, which reads as weak. Options: show a label instead of a number ("strong match", "close", "loose"), or scale against what real searches score rather than against 0.5 to 1. Either is a UX call, and Clark's.

Measure first: no fix until the golden set has searches like this and a before score.

**Measured 2026-11-19** ([before](evaluation.md#measured-the-before-2026-11-19)): "gas efficient car" 0.73, "good on gas" 1.00, "cheap to run" 0.91, and Hit@1 is 1.00 on all three. The ranking issue is one phrasing, not everyday wording in general. **The bigger visible problem is the display:** the right top car shows as 52%. The ranking fix (shopper words in descriptions, or hybrid keyword-plus-vector search) can wait for a second failing search.

**Display: done 2026-11-19 (Clark chose words).** Results show "Strong match", "Possible match" or "Weak match", with cut-offs set from every top-5 score of the golden set ([evaluation](evaluation.md#the-match-display-why-words-not-percentages-2026-11-19)). That measurement also found the deeper problem: a mid score can't tell a right answer from a wrong one, whatever the scale. So #14 stays open for the ranking half only.

### 13. Searches that name a car outside the results

**Stretch (Clark, 2026-11-18).** Found by the answer check ([second run](evaluation.md#answer-check-second-run-2026-11-18)). Asked "is the Ford Mustang a better choice than these?", the model compares against the Mustang even when told never to name a car outside the list (3 of 5 reasons in run 2). The text check drops the answer, so it's safe, but the shopper only sees "Couldn't write a reliable answer".

**The fix, in code rather than the prompt:** before calling the model, run the text check's matcher (`findMentions` in `server/utils/answer.ts`) on the search itself. If it names a catalog car that isn't in the results, skip the model and show fixed text, such as "The Ford Mustang isn't in these results. Search for it to see it." That's deterministic, costs no chat call, and gives the shopper a next step. Prompt rules can't be relied on for this (two runs showed it); a check in code can.

**The catch:** the answer check's injection searches call the model directly, so this fix doesn't change their result. Testing it there means rules v3 routing those searches through the app's flow, written up as a change made after seeing a failure, and committed before its run.

### 11. Stack review before the G slice (2026-11-17)

**Done 2026-11-17; Clark reviewed and kept all of it the same day.** Why each fix was needed: [G spec](specs/generate.md#why-the-stack-review-changed-this-spec-2026-11-17). A code review of the whole stack (server, scripts, page) and the freshly settled [G spec](specs/generate.md), before building G. The code had no bugs in the request path; four hardening fixes went into the code, and seven gaps were fixed in the G spec while it's still cheap to change. `pnpm check` passes (lint, typecheck, 96 unit tests, 18 of them new).

**Code**

| # | What | Why | How |
|---|---|---|---|
| 1 | Production builds listen on localhost only (S10 extended) | Nitro's production server listens on **every** network interface unless `NITRO_HOST`/`HOST` is set (checked in its source). S10 only covered `pnpm dev`, so a production build, as used for Lighthouse, put a server holding the OpenAI key on the local network | `package.json`: `pnpm preview` sets `NITRO_HOST=127.0.0.1`; new `pnpm start` runs the build on 127.0.0.1 with `.env` loaded. Runbook: [Run a production build](runbook.md#run-a-production-build). Verified: the built server listened on `127.0.0.1:3999` only |
| 2 | New rule S17: refuse requests not addressed to localhost | DNS rebinding: a website points its own domain at 127.0.0.1, and the browser then treats the API as same-origin, so S1's JSON-only rule stops nothing. Today that spends embedding calls; once G lands, the 50 daily chat calls | `server/utils/host.ts` (`isLocalHost`, testable) and `server/middleware/local-only.ts` (403 for any other `Host`). Allows `localhost`, `127.0.0.1`, `[::1]` on any port. 17 unit tests in `tests/unit/host.test.ts`. Verified on the built server: `Host: localhost` → through, `Host: evil.example` → 403 |
| 3 | One text cleaner for S15, used by descriptions now | Descriptions stripped control characters but not invisible ones (zero-width, text-direction overrides). They're shown on the page and, with G, go into the prompt | `shared/utils/clean-text.ts` (`cleanText`: Cc → space, Cf removed; widened after the code review below); `cleanDescription` uses it; new test. None of the 673 stored descriptions contained such characters, so nothing needs re-describing or re-embedding |
| 4 | "% match" shows the rescaled score | It showed Mongo's raw score, where 0.5 already means unrelated, so "asdf qwerty" read as a 60% match. The bar was already rescaled; the number wasn't | `app/pages/index.vue` shows `(score − 0.5) / 0.5`, the same as the bar: "asdf qwerty" now 20%. Explained in [rag.md §5](rag.md#5-what-mongos-score-means). Thresholds stay on Mongo's scale |

**G spec** ([generate.md](specs/generate.md); P3 and S10/S17 in [ingest-search.md](specs/ingest-search.md))

| # | What | Why | How |
|---|---|---|---|
| 5 | The gate uses Mongo's score scale | The 0.65 threshold was measured on `(1 + cos) / 2`. Computed as raw cosine in code, "accord" is about 0.41, so every search would be blocked | Decision 1 says to convert, and takes the highest score across the ids |
| 6 | The gate embeds the same text as search | Search embeds "accord" for "2018 accord"; embedding the raw query gives a different score near 0.65 | Decision 1: embed `parseYearFilter(query).text`; new success check |
| 7 | `picks` is 0–5 | "1–5" plus "refusals have no picks" made every refusal invalid | Decision 4: none when `noneFit`, 1–5 otherwise |
| 8 | An unknown id drops the whole answer | The spec said both "drop the answer" and "drop the id". Filtering first can leave an empty answer and makes the Grounded check unable to fail | Decision 4, P3, security table, answer check |
| 9 | The text check ignores everyday words | Fit, Focus, Roadster, Spark, Legacy, Insight… are model names, so "a good fit for commuters" would drop a valid answer | Decision 4: make + model, or the model alone unless it's on a reviewed everyday-word list |
| 10 | The cache comes first; key and retries fixed | Cached repeats still spent an embedding; gated requests weren't rate-limited; sorted ids didn't match the ranked prompt; a hand-bumped prompt version is easy to forget and missed new descriptions; the shared client's 2 retries could spend 3 chat calls on one click | S11: ids in order sent, a computed prompt version (hash of prompt + schema + model), descriptions in the key. Decision 5: lookup before embedding. S14: every uncached request counts; chat call has `maxRetries: 0`. Appendix lists the order of work per request |
| 11 | P3 matches the decisions | P3 is the rule the G spec applies "as written", and it lacked the text check and the drop-the-answer rule | P3 amended |

**Code review of the fixes (2026-11-17)**

A `/code-review` of the changes above found 8 issues, all fixed the same day (`pnpm check`: 98 unit tests). For a local-only proof of concept, most of this is over-engineering: the realistic attacker is another website, and the worst case is lost quota. The fixes stay because a production app would need the same ones, and they're cheap now.

| Fix | Needed here? | In production |
|---|---|---|
| S17 lets requests with no `Host` through. Nitro's own prerender and server-side `$fetch` calls have none; browsers always send one, and Node answers 400 to outside requests without it | Yes: S17 would otherwise break `pnpm generate` and G | Same rule, with the real domain in the allowlist and usually a reverse proxy enforcing it too. It also blocks Host-header injection (poisoned caches, reset links pointing at an attacker's domain). A security check that breaks your own app tends to get switched off, which is worse than not having one |
| `cleanText` turns zero-width spaces into spaces and also removes Unicode's default-ignorable characters (variation selectors, Hangul fillers) | No: the only person typing prompts is the developer | Yes. With real users, prompt injection can make the model write text that looks like one thing and is another: `Cor\uFE0Folla` displays as "Corolla" but fails a string match. Every check on model output should run on cleaned text |
| The S15 test writes invisible characters as `\u` escapes | Yes | Yes: an editor could strip raw characters and the test would pass while testing nothing. A security test has to fail when the protection is gone |
| Runbook: running `.output/server/index.mjs` by hand skips the localhost bind; `[::1]` only reaches `pnpm dev` | Barely: S17 still blocks rebinding requests | Exposure is set by the infrastructure (proxy, container, firewall), not an npm script |
| The % and the bar share `matchPercent()`; new-test count corrected to 18 | Housekeeping | Housekeeping |

**Test today (all free):**
1. `pnpm check`: lint, typecheck, unit tests.
2. `pnpm dev`, search "asdf qwerty": the top result shows about 20% match, "honda civic" about 90%+.
3. `pnpm build && pnpm start`, then `ss -ltnp | grep 3000`: listening on `127.0.0.1` only.
4. With it running: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health -H 'Host: evil.example'` → 403; the same with `-H 'Host: localhost:3000'` → 200 (503 if Mongo isn't running; anything but 403 means it got through).
5. Read the decision 1, 4 and 5 changes in the G spec: they add detail but don't reverse any decision.

### 10. Remove niche makers from the dataset

**Done (2026-11-12).** Kept in full because the eval docs link here.

**Found 2026-11-12 by the first eval run** ([first results](evaluation.md#first-results-2026-11-12)). Limo, kit-car and replica builders whose names contain the search words outranked real cars: "ELECTRIC MOBILE CARS Electric Mobile Cars" was #1 for "electric car", and "MK SPORTSCARS" and "CLASSIC SPORTS CARS" led "small sports car". This happened with or without descriptions, because the match is on the maker's name. Spec decision 3 said to hide them "only if they get in the way". They did, so **Clark decided to remove them** (2026-11-12).

**Done (2026-11-12):**
- **Rule:** drop every maker for which gpt-5-mini couldn't describe *any* model (all of its descriptions were "Lesser-known model from …"). That's **79 makers and 176 of the 673 models**, leaving 497 models from 70 makers (the second pass below took it to 475). Makers with only a few unknown models (BMW 3/64, Ferrari 3/25) stay whole.
- **Where:** the list is committed as [scripts/lib/niche-makes.ts](../scripts/lib/niche-makes.ts), by vPIC make id. `pnpm scrape` skips those makers and leaves them out of `cars.json`, so `describe` and `ingest` follow on their own; ingest deleted the 176 from both databases (nothing re-embedded). Unit test added (77 pass).
- **Relevance check:** "1955 Custom Belair" relied on a removed kit car, so it became "1965 mustang": 1965 is outside 1980–2099, so it's searched as text, and the Ford Mustang must be in the top 3. 8/8 pass.
- **Eval re-run** as its own labels (`names-only-no-niche`, `described-no-niche`). The descriptions WIN became **INCONCLUSIVE** (+0.056, −0.016 to +0.132): removal lifted the names-only baseline more. Details in [evaluation.md](evaluation.md#after-removing-niche-makers-2026-11-12).

**Second pass (2026-11-12):** four makers the rule missed, because gpt-5-mini could describe them (their models have real-car names), were added to the list by hand: **HERITAGE** (Mustang and Camaro replicas: #1 for "1965 mustang", #3 and #4 for "muscle car"), **ARMBRUSTER STAGEWAY** (16 limousines), **EMA** (a limousine) and **COBRA CARS** (replicas). **83 makers, 198 models left out; 475 models from 66 makers remain.** "muscle car" rose 0.72 → 0.89; the descriptions call is still INCONCLUSIVE (+0.064, −0.008 to +0.139).

**Not fixed by this:** name dilution. RUF (the "CTR" cars under "civic type r") is a real maker with described models, so it stays. Logged in [evaluation.md](evaluation.md#first-results-2026-11-12), including why a bigger catalog will dilute names further.

### 4. Dependabot (done)

**Dependabot is on (2026-11-16):** [.github/dependabot.yml](../.github/dependabot.yml) checks npm weekly, puts every minor and patch update in one PR (majors get their own) and waits 3 days before suggesting a release (7 for majors), so a hijacked release is usually pulled before it reaches us. Its first PR (#8, two minor and patch bumps) was merged 2026-11-16.

`pnpm audit` on 2026-11-17: **5 findings (1 low, 2 moderate, 2 high)**, up from 4 on 2026-11-11. The deepmerge one is gone; new is **picomatch** (high, ReDoS from crafted glob patterns), with no patched version yet. All are in build, lint and font tooling (esbuild, glob, minimatch, picomatch), none in the request path, and none take patterns from visitors. Dependabot picks up the fixes once they're released.

## Clark's TODOs

- [x] **Review the stack review fixes** ([#11](#11-stack-review-before-the-g-slice-2026-11-17)): 4 code fixes, 7 G spec fixes, and test steps. Mark done if satisfactory.
  - Claude (2026-11-17): **done.** Clark reviewed and kept all 11. Why each one was needed, ranked by what breaks without it: [G spec](specs/generate.md#why-the-stack-review-changed-this-spec-2026-11-17). Next is the [build plan](specs/generate.md#build-plan-from-2026-11-18).

- [x] **Decide the G spec's open questions** ([docs/specs/generate.md](specs/generate.md#decisions-clarks-calls)): gate, on-demand vs automatic, prompt fields, answer shape, cache, model, answer check. The first is how to say "we don't carry that", now that the floor gap is about 0.06 ([results](evaluation.md#results-on-reviewed-labels-2026-11-16)).
  - Claude (2026-11-17): **done.** All seven settled in review. Gate: a 0.65 score threshold for junk plus a prompt that allows "none fit" (per-search scores overlap, so only the model catches near misses); answers on a button, with a free "nothing close" flag on search; picks with a reason each; cached; gpt-5-mini; an 11-call answer check with a 100% pass bar.
- [x] **Review the golden set** ([eval/golden.json](../eval/golden.json)): check each AI-drafted label and set `reviewed: true`. The first run showed right answers the drafts miss (Hyundai Accent, Chevy Sonic, Prius C, Prius Prime, Scion FR-S, Ford Fusion, Lincoln Continental, Toyota Crown, Chevy Bolt EUV); add them, then re-run both labels and compare ([runbook](runbook.md#score-search-quality)). Clark: check if all are reviewed and mark done if satisfactory
  - Claude (2026-11-17): **done.** All 24 searches reviewed, concept labels redone from a catalog candidate list (2026-11-16). Descriptions **WIN**, nDCG@5 0.82 → 0.99. How the labels got there: [evaluation.md](evaluation.md#golden-set-review-2026-11-12).
- [x] **Decide before the re-run: tighten the exact-name guardrail?** Exact searches now grade variants as 1 (Civic Si for "honda civic"), so Hit@1 would count a variant at #1 as a hit. Proposed: for exact searches, Hit@1 needs a grade-2 car. Rules are set before results, so decide this before running `*-reviewed`.
  - Clark (2026-11-13): yes. Claude: done in `RULES.guardrail` ([scripts/lib/eval.ts](../scripts/lib/eval.ts)), with a unit test; old runs compare as before.
- [x] **Decide on niche makers (spec decision 3):** decided 2026-11-12, remove them. Now [#10](#10-remove-niche-makers-from-the-dataset).
- [x] **Approve the removal rule for #10** ("every maker with no described models", 79 makers) and what to do about the "1955 Custom Belair" relevance check. Clark: Remove niche makers, they've now become a problem and log as needed.
  - Claude (2026-11-12): done, see [#10](#10-remove-niche-makers-from-the-dataset).
- [x] **Decide on the four makers #10's rule missed:** HERITAGE, ARMBRUSTER STAGEWAY, EMA, COBRA CARS (replicas and limousines). Remove them too?
  - Clark (2026-11-12): yes. Claude: done, see [#10](#10-remove-niche-makers-from-the-dataset).

Decided 2026-11-11: Node 26; the relevance check runs by hand; no public demo; the TypeScript aliases go; descriptions stay uncommitted (#2); manual testing is enough until this becomes something to run with. Decided 2026-11-17: **no CI for this project.** It's a local learning experiment; `pnpm check` before committing does that job.

## Parked

| # | Item | Revisit when |
| --- | --- | --- |
| 5 | Rate limiting, `nuxt-security` (CSP and headers), OpenAI budget alerts, error text written for visitors instead of developers; since 2026-11-16 also deploying only a production build and per-visitor limits on AI answers. The README warns about it, and each fix is written up in the spec's [Before going public](specs/ingest-search.md#before-going-public) | If a public demo is ever planned. Today it isn't: the project runs locally and is shown through the repo and screenshots |
| 12 | **Stretch: move the answer cache to Redis.** Mongo is the right cache today ([answer-cache.ts](../server/utils/answer-cache.ts)): a model answer takes seconds and one of 50 daily calls, against a millisecond or two for a lookup by `_id`; entries survive restarts, so an answer is never paid for twice; every app instance would share it; and Mongo is already running, while Redis is one more service to deploy, secure and watch. Redis wins on sub-millisecond reads and on capping the cache by memory with least-used eviction, where Mongo only expires entries by age, so the collection grows with distinct searches (about 1 KB per answer). Related gap either way: two identical uncached requests at the same moment both call the model (a cache stampede); a pending marker or per-key lock would fix it | Cache reads become a large share of traffic and need sub-millisecond replies, or the collection grows past what's comfortable to keep on disk. Neither happens with one local user |

## Done

- **#3 Relevance check (2026-11-11).** `pnpm test:relevance` ([tests/relevance/search.test.ts](../tests/relevance/search.test.ts)) runs 8 real searches against the ingested database with real embeddings, by hand only. Five checks fail the run: "honda civic" puts the Civic first, "civic type r" ranks the Type R above the Civic, "2018 accord" puts the Accord first with everything sold in 2016–2020, "1955 Custom Belair" isn't year-filtered and finds the kit car (now "1965 mustang", see #10), and "small honda" returns at least 4 Hondas. Three watches only print: "medium sedan" (the SL-Class is still second), "pickup truck" (finds the few "car" listings named Truck or Pickup) and "asdf qwerty" (tops out around 64%, against 80–94% for real searches). All checks passed on the first run. It prints the top 5 per query, to compare before and after a change; see the [runbook](runbook.md#check-search-quality). The scored half is [Measuring search quality](evaluation.md).
- **#3, scored half (2026-11-12, reviewed 2026-11-16).** `pnpm eval run` / `compare` ([scripts/eval.ts](../scripts/eval.ts), golden set in [eval/golden.json](../eval/golden.json)) with the win/loss rules from [evaluation.md](evaluation.md). On reviewed labels, with niche makers removed, descriptions are a clear **WIN**: nDCG@5 0.82 → 0.99, guardrail held. The catch is that the floor gap halved (about 0.12 → 0.06), which the G slice has to handle. See [evaluation.md](evaluation.md#results-on-reviewed-labels-2026-11-16).
- **#10 Niche makers (2026-11-12).** 83 makers removed, 475 models left. See [#10](#10-remove-niche-makers-from-the-dataset).
- **#4 Dependabot (2026-11-16).** Weekly npm updates, grouped minor and patch, with a cooldown. First PR merged 2026-11-16.
- **#7 Health check (2026-11-11).** `/api/health` pings Mongo: 200 `ok` when it answers, 503 `Database is unavailable right now` when it doesn't, with the reason in the server log only (S6). Checked both against a dev server. OpenAI isn't checked, since that would spend a request each time.
- **#9 Stale vue-router (2026-11-11).** Removed `vue-router@^4` from `dependencies` (Nuxt brings its own, 5.x). The typecheck warning is gone.
- **#6 TypeScript aliases (2026-11-11).** `typescript` pointed at the TS 6 package (`@typescript/typescript6`) so vue-tsc could use its JavaScript API, and `@typescript/native` pointed at TS 7 (Go) for a faster `tsc -p scripts`. That speed doesn't matter at this size, so both are replaced by plain `typescript@^6.0.3`. `pnpm check` is green: lint, typecheck, 67 unit tests. Move to TS 7 when vue-tsc supports it.
- **Node version (2026-11-11).** `.nvmrc` says `26`, what we develop and test on. `engines` stays at `>=22.18.0`: that's the real floor (Node's built-in type stripping, which the scripts rely on).
- **#8 Year-range formatting (2026-11-11).** One `formatYears(years, dash)` in [shared/utils/years.ts](../shared/utils/years.ts), used by the page and the describe prompt (with `"-"`, so the prompt text is unchanged). The page's catalog years now come from `GET /api/catalog` instead of being hard-coded. (`span` in `screenshot.ts` builds year lists for fixture data rather than formatting them, so it stays.)
- **Also 2026-11-11:** ESLint's style rules turned on as the formatter (double quotes, semicolons, 4-space indent) and applied once; the empty `server/db/` leftover removed.

- **#2 Descriptions: won't do (2026-11-11).** `data/descriptions.json` stays gitignored. This is a proof of concept, so losing the file or getting different descriptions after a rerun doesn't matter.

## Every slice

1. `pnpm check` is green (lint, typecheck, unit tests).
2. `pnpm test:integration` with `docker compose up -d`, if the slice touches ingest or search.
3. Docs change with the code: the spec, runbook or API doc that covers it.
4. Clark reviews the diff and commits.
