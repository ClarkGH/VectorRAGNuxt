# Measuring search quality

**In one sentence:** to know whether a change makes search better, we score it against a fixed list of searches with known good answers, using rules we write down before looking at the results.

**Status (2026-11-12):** built and run. `pnpm eval` scores search against [eval/golden.json](../eval/golden.json), and the first comparison says **descriptions are a narrow win** ([first results](#first-results-2026-11-12)). Those numbers are **provisional**: the golden set's labels are AI-drafted and haven't been reviewed by a person yet, and the review is already known to need more right answers. Its pass/fail half, the relevance check (`pnpm test:relevance`), is built and passing; see the [runbook](runbook.md#check-search-quality).

## Why bother

Today, "is search good?" is answered by trying a few searches and squinting. That can't tell you whether a change helped. The automated tests don't either: they use stand-in vectors that match on spelling, so they prove the pipeline works, not that results are good ([how it works](rag.md#appendix-the-technical-detail)).

The questions this answers:

| Change | Question |
|---|---|
| Names only vs names plus AI descriptions | Do the descriptions earn their cost? |
| Description prompt v2 vs v3 | Did a prompt edit help or hurt? |
| `text-embedding-3-small` vs `-large` | Is the bigger embedding model worth paying for? |
| `numCandidates` 10× vs 20× vs 50× the limit | Is the fast, approximate search missing good results? |
| Year window ±1 vs ±2 | Is the year filter too loose or too strict? |

*Measuring a search engine by feel is like judging a car by the color of its seats. Nice seats, though.*

## How it works

### 1. A "golden set" of labeled searches

About 20 searches, each with the cars that count as right answers, graded: **2** = exactly right, **1** = acceptable. Everything else counts as 0.

```json
{ "query": "small reliable sedan", "relevant": { "448-2208": 2, "474-1863": 2, "448-2464": 1 } }
```

It covers every kind of request the app handles:

| Kind | Example | What "good" means |
|---|---|---|
| Exact name | "honda civic" | Civic is first |
| Trim | "civic type r" | Type R above plain Civic |
| Year filter | "2018 accord" | Accord first; everything sold 2016–2020 |
| Concept | "cheap reliable car", "luxury coupe" | The graded list |
| Out of catalog | "pickup truck" | Low scores; nothing relevant exists |
| Nonsense | "asdf qwerty" | Scores near the floor |

**A person writes the labels, not the AI.** If the same model that writes the car descriptions also decides what's relevant, it's grading its own homework. An AI can draft candidates for a person to correct, but the final call is human. This is the slow part (about an hour) and where the value comes from.

### 2. The scores

All of them look at the top 5 results:

| Metric | Plain meaning | Example |
|---|---|---|
| **Hit@1** | Is the first result right? | Yes = 1, no = 0, averaged over the searches |
| **Recall@5** | What share of the right answers made the top 5? | 2 of 3 found = 0.67 |
| **MRR** | How high is the first right answer? Scores 1 ÷ its position | 1st = 1.0, 3rd = 0.33 |
| **nDCG@5** | The headline number: rewards better answers higher up, using the 2/1 grades, scaled so a perfect top 5 is 1.0 | See the appendix |

Out-of-catalog and nonsense searches have no right answers, so they're checked differently: their **top score** should sit clearly below a real search's. If "asdf qwerty" scores 0.75 and "honda civic" 0.80, the scores can't tell a good match from noise, even if the order looks fine.

### 3. Win, loss or inconclusive: decided before running

Write these down first, so the goalposts can't move after seeing the numbers:

| Call | Rule |
|---|---|
| **Win** | Average nDCG@5 improves by **at least 0.05**, *and* the 95% confidence interval for that gain stays above zero, *and* no guardrail breaks |
| **Loss** | The confidence interval is entirely below zero, *or* a guardrail breaks |
| **Inconclusive** | Anything else: the gain is too small to matter, or there aren't enough searches to tell |

**Guardrail:** exact-name searches ("honda civic") can't lose more than 0.1 of their Hit@1. This exists because one change can help concept searches while quietly hurting name searches, and the average alone would hide it. We've seen a real hint of this: in an early "2018 acura" search, the one Acura with a description scored 80% while the bare-name Acuras scored 84–85%.

**The confidence interval** comes from a *paired bootstrap*: both versions run the same searches, then we re-sample those searches thousands of times and see how much the average gain moves. Search is deterministic, so running it again changes nothing; the only uncertainty is *which searches we happened to write*, and that's exactly what this measures.

**0.05 is a judgment call**, not statistics: it's the smallest gain we'd consider worth the cost and complexity of a change. Change it before running if that's wrong, never after.

## Checking the method with a simulation

Before trusting rules on real data, we tested them on made-up results where the right answer is known in advance. System A is names only, system B adds descriptions, and we set how good each is per kind of search. No API calls, no database: just the scoring and the rules.

### The rules gave the right answer in each case

| Scenario | What happened | ΔnDCG@5 (95% interval) | Call |
|---|---|---|---|
| Descriptions help concept searches | Concept nDCG 0.46 → 0.70; everything else unchanged | +0.092 (+0.032 to +0.165) | **Win** |
| Concepts up, names diluted | Same concept gain, but exact-name Hit@1 fell 0.83 → 0.33 | +0.034 (−0.082 to +0.156) | **Loss**, from the guardrail |
| Tiny real gain | Concept nDCG 0.46 → 0.50 | +0.017 (0.000 to +0.046) | **Inconclusive** |

The second row is the one to remember: the overall average *went up*, so without the guardrail it would have been called a win.

### About 20 searches is enough

Repeating each scenario on 200 freshly made-up sets of searches, at different sizes, shows how often the rules call a win:

| Searches in the set | Big real gain | Small real gain | No change |
|---|---|---|---|
| 11 | 80% | 2% | 0% |
| **21** | **100%** | 18% | 0% |
| 42 | 100% | 17% | 0% |
| 84 | 100% | 11% | 0% |

- **21 searches reliably catch a gain the size descriptions should give.** With 11, a real win is missed 1 time in 5.
- **No false wins:** when nothing changed, the rules never called a win.
- **Small gains stay inconclusive by design:** under the 0.05 bar they don't count, however many searches are added.

**What the simulation can't tell us:** whether descriptions actually help. The quality levels were made up, so it proves the *method*, not the result. The real answer needs the labeled searches and a real run.

## Running it

Steps are in the [runbook](runbook.md#score-search-quality). In short:

1. **Two databases from the same data:** `pnpm ingest` (with descriptions) and `pnpm ingest --db vector_rag_names --names-only` (the baseline).
2. **Score each:** `pnpm eval run --label names-only --db vector_rag_names` and `pnpm eval run --label described`. Each run is saved to `data/eval/<label>.json` (not committed).
3. **Compare, baseline first:** `pnpm eval compare names-only described` prints both tables and the win/loss/inconclusive call.

**Cost:** one embeddings call per search, 24 per run, a fraction of a cent. It doesn't use the gpt-5-mini daily limit at all.

The golden set is [eval/golden.json](../eval/golden.json). Each entry has `reviewed: false` until a person has checked it, and every run reminds you how many are still drafts. The code is [scripts/eval.ts](../scripts/eval.ts) (the command) and [scripts/lib/eval.ts](../scripts/lib/eval.ts) (the metrics and rules, unit-tested against the worked example in the appendix).

## First results (2026-11-12)

**Provisional:** the labels are AI-drafted and not yet reviewed (see "what the results showed" below). All 673 cars described; 21 labeled searches plus 3 floor searches; `text-embedding-3-small`.

| Kind | n | nDCG@5, names only → described | Hit@1 | MRR | Recall@5 |
|---|---|---|---|---|---|
| Exact name | 6 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 |
| Trim | 3 | 0.99 → 0.94 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 0.83 |
| Year filter | 4 | 0.94 → 0.99 | 1.00 → 1.00 | 1.00 → 1.00 | 1.00 → 1.00 |
| Concept | 8 | **0.27 → 0.44** | 0.38 → 0.50 | 0.45 → 0.68 | 0.23 → 0.43 |
| **All** | 21 | **0.71 → 0.78** | 0.76 → 0.81 | 0.79 → 0.88 | 0.71 → 0.76 |

**The call: WIN, narrowly.** nDCG@5 +0.068, 95% interval +0.005 to +0.137; the exact-name guardrail held (no drop). The interval's lower end is close to zero, so this is the "probably real, size uncertain" kind of win.

**What the results showed, beyond the score:**

- **The gain is all in concept searches, as expected.** "hot hatch" 0.49 → 0.85, "cheap reliable car" 0.00 → 0.48, "fuel efficient hybrid" 0.23 → 0.53. Name, trim and year searches were already near perfect.
- **The draft labels miss right answers, which understates concept scores.** Described search returned sensible cars the labels don't list: Hyundai Accent and Chevy Sonic for "cheap reliable car", Prius C and Prius Prime for "fuel efficient hybrid", Scion FR-S (the same car as the Toyota 86) for "small sports car", Ford Fusion for "midsize family sedan", Lincoln Continental and Toyota Crown for "luxury sedan". "Luxury sedan" (0.68 → 0.58) and "electric car" (0.16 → 0.05) look worse mostly for this reason. **The label review should add these variants, then re-run** (48 embeddings calls).
- **The predicted name trade-off is real, but small.** "civic type r" now shows two RUF "CTR" cars at #3 and #4 (trim nDCG 0.96 → 0.83 for that search), and "golf r" picks up a Nissan GT-R. The descriptions dilute the name. Exact-name searches didn't suffer, so the guardrail held.
- **Niche makers whose names contain the search words get in the way**, with or without descriptions: "ELECTRIC MOBILE CARS Electric Mobile Cars" is #1 for "electric car", and "MK SPORTSCARS" and "CLASSIC SPORTS CARS" lead "small sports car". This is the trigger for the spec's decision 3 ("hide niche manufacturers only if they get in the way").
- **Scores can't flag a non-match.** Out-of-catalog and nonsense searches score close to real ones: with descriptions, "pickup truck" 0.76 and "family suv" 0.75, against 0.81 for the first result of a labeled search ("asdf qwerty" 0.61). The gap is even smaller than names-only (0.86 vs 0.78). A "no good match" cutoff on the score wouldn't work; rank order is what's meaningful.

This extends the relevance check (`pnpm test:relevance`, built 2026-11-11, see the [runbook](runbook.md#check-search-quality)): it has pass/fail checks for known cases; this adds scores that can be compared across changes.

---

## Appendix: the math

<details>
<summary>nDCG@5, worked through</summary>

For the top 5 results with grades $g_1 \dots g_5$ (2, 1 or 0):

$$
\text{DCG@5} = \sum_{i=1}^{5} \frac{2^{g_i} - 1}{\log_2(i + 1)}
$$

A grade-2 answer is worth 3, a grade-1 answer is worth 1, and lower positions are discounted. **nDCG** divides by the DCG of the best possible ordering (IDCG), so a perfect top 5 scores 1.0.

Example: the right answers are one grade-2 car and one grade-1 car. The search returns them 2nd and 4th:

$$
\text{DCG} = \frac{3}{\log_2 3} + \frac{1}{\log_2 5} = 1.89 + 0.43 = 2.32
\qquad
\text{IDCG} = \frac{3}{1} + \frac{1}{\log_2 3} = 3 + 0.63 = 3.63
$$

$$
\text{nDCG@5} = 2.32 / 3.63 = 0.64
$$

Moving the grade-2 car to 1st would score 0.94.

</details>

<details>
<summary>The paired bootstrap, step by step</summary>

1. Run both versions on the same $n$ searches. For each search, take the difference $d_i = \text{nDCG}_B - \text{nDCG}_A$.
2. 10,000 times: pick $n$ searches *with replacement* (some twice, some not at all) and average their $d_i$.
3. Sort the 10,000 averages. The 2.5th and 97.5th percentiles are the 95% interval.

If the interval excludes zero, the gain holds up across reasonable variations of the search list. "Paired" matters: each search is compared with itself, so hard and easy searches don't add noise to the comparison.

</details>

<details>
<summary>How the simulation generated results</summary>

Each kind of search got a "skill" per version: the chance that each top-5 slot holds the next-best right answer. Names only: exact 0.95, trim 0.85, year 0.85, concept 0.30. The scenarios changed those numbers (for example concept 0.30 → 0.70) and generated results with a seeded random number generator, so every run gives the same numbers. The simulation was a one-off script run during planning; it isn't in the repo.

</details>
