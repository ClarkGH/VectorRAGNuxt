# Runbook

Step-by-step procedures for keeping the car data and search working. For first-time setup, see the [README](../README.md#how-to-run). For error messages, see [Troubleshooting](../README.md#troubleshooting).

**Before any of these:** Node 26 (`nvm use`), `docker compose up -d`, and a `.env` with `NUXT_MONGODB_URI` and `NUXT_OPENAI_KEY` (copy `.env.example`).

**The pipeline, for reference.** Each step reads the previous step's file, and each one is safe to re-run:

```
pnpm scrape   → data/cars.json          (free; government API)
pnpm describe → data/descriptions.json  (a few cents; gpt-5-mini, rate limited)
pnpm ingest   → Mongo + vector index    (a fraction of a cent; embeddings)
```

`data/` isn't committed. Mongo's data lives in a Docker volume.

---

## Add a new model year

**When:** a new year's cars are out (the scraper defaults to the last ten years).

1. `pnpm scrape --from 2027 --to 2027`. Only that year is fetched; `cars.json` is rebuilt from everything cached, so nothing is lost.
2. `pnpm describe`. Only new car models get descriptions.
3. `pnpm ingest`. Only new or changed models are embedded. Models that vanished from the data are removed.

**Check:** ingest prints `Models: N, embedded: …`, and a search for a new model finds it.

**New makers:** a new year can bring new limo or kit-car builders. If one shows up in the results where it shouldn't, add its make id to [`scripts/lib/niche-makes.ts`](../scripts/lib/niche-makes.ts) and run all three steps again. To bring a left-out maker back, delete its line and do the same.

## Fix a wrong description

**When:** a description in the results is wrong, misleading, or odd.

1. Open `data/descriptions.json` and find the car (search for its model name).
2. Choose one:
   - **Edit the text by hand.** `pnpm describe` won't overwrite it, because it only rewrites missing descriptions or ones from an older model or prompt.
   - **Have the AI write it again:** delete the whole entry (`"474-1863": { … },`), then run `pnpm describe`.
3. `pnpm ingest`. The changed text means that car is re-embedded.

## Change the description instructions

**When:** descriptions need a different style or content for every car.

1. Copy the current file, so you can roll back: `cp data/descriptions.json data/descriptions.backup.json`
2. Edit `DESCRIBE_INSTRUCTIONS` in [`scripts/lib/describe.ts`](../scripts/lib/describe.ts) **and bump `DESCRIBE_PROMPT_VERSION`**. Without the bump, existing descriptions are kept and only new cars get the new style.
3. Try a few first: `pnpm describe --limit 40` (one request), and read the results.
4. `pnpm describe` for the rest. That's 17 requests for the whole catalog. A free-tier OpenAI account allows 50 a day, so a full rewrite fits once a day. If the run stops on the daily limit, re-run it after the reset; it continues where it left off.
5. `pnpm ingest`

**Roll back:** `cp data/descriptions.backup.json data/descriptions.json`, put the old instructions and version number back, then `pnpm ingest`.

## Change the embedding model

**When:** switching to a different OpenAI embedding model or vector size.

1. Edit `EMBEDDING_MODEL` and, if it changed, `EMBEDDING_DIMENSIONS` in [`shared/utils/embedding.ts`](../shared/utils/embedding.ts). Ingest and search both read them from there, so they can't drift apart.
2. `pnpm ingest`. Every car is re-embedded, because each stored vector records which model made it. If the size changed, the index is rebuilt.
3. Restart `pnpm dev` so search uses the new model.

**Expect:** searches fail or return nonsense between steps 2 and 3, because old and new vectors aren't comparable. Locally that's a minute; it would need care in production.

## Start the database over

**When:** Mongo is in a confusing state, or to check that a fresh setup works.

```bash
docker compose down -v   # -v deletes Mongo's data volume
docker compose up -d
pnpm ingest              # re-embeds every car: a fraction of a cent
```

Descriptions are safe: they're in `data/descriptions.json`, not in Mongo, so this doesn't cost any gpt-5-mini requests.

## Check search quality

**When:** before and after changing anything that affects ranking: `embeddingText`, the describe instructions, the embedding model, or the descriptions themselves.

1. Make sure the database is current: `pnpm ingest`.
2. `pnpm test:relevance`. It runs 8 real searches (8 embeddings calls, a tiny fraction of a cent) and prints the top 5 for each, with scores.
3. Save the table, make the change, re-ingest, run it again, and compare.

**Checks** fail the run: exact names, trims, the year filter, a year inside a car's name, and make-plus-size. **Watches** only print: "medium sedan", "pickup truck" and nonsense. They're known weak spots, so they can be seen improving without blocking anything. The queries are in [tests/relevance/search.test.ts](../tests/relevance/search.test.ts).

For scores that can be compared across changes (nDCG, Hit@1), see the next section.

## Score search quality

**When:** deciding whether a change to ranking is a win: descriptions on or off, a new describe prompt, another embedding model. What the scores mean and how the call is made: [Measuring search quality](evaluation.md).

1. Have both versions in their own database. For descriptions vs names only:
   ```bash
   pnpm ingest                                         # with descriptions, the app's database
   pnpm ingest --db vector_rag_names --names-only      # baseline: names only
   ```
2. Score each one (24 embeddings calls per run, a fraction of a cent):
   ```bash
   pnpm eval run --label names-only --db vector_rag_names
   pnpm eval run --label described
   ```
   Each run prints a table by kind of search and saves `data/eval/<label>.json`.
3. Compare, baseline first: `pnpm eval compare names-only described`. It prints both tables, the nDCG change with its 95% interval, the exact-name guardrail, and **WIN**, **LOSS** or **INCONCLUSIVE**.

**Editing the golden set:** [eval/golden.json](../eval/golden.json). Car ids are `makeId-modelId` (look them up in `data/cars.json`). Set `reviewed: true` on entries a person has checked. After editing it, re-run *both* labels before comparing: a comparison only pairs searches present in both runs. For a full review, see the next section.

## Review the golden set

**When:** the labels are AI-drafted, or the catalog changed a lot. The scores are only as good as the labels: a right car that isn't labeled counts as a miss, so an incomplete label makes good search look bad. On 2026-11-12, described "electric car" scored 0.05 with five real EVs in its top 5, because only one of them was labeled.

**What a label is:** for each search, the cars a shopper who typed it would be happy to see.

| Grade | Means | Example for "electric car" |
|---|---|---|
| **2** | Exactly what they asked for | Tesla Model 3, Nissan Leaf |
| **1** | Acceptable; they wouldn't mind | A plug-in hybrid, or a pricey EV like the Taycan |
| (not listed) | Wrong | A gas car, a limousine |

The grade is about the car and the words typed, never about where search put it.

**About an hour, at no cost.** You don't need any API calls until step 6.

1. **Start over honestly.** In `eval/golden.json`, set every `"reviewed": true` back to `false`. The flag means "a person has checked this", so it should only be true once you have.
2. **Print the labels with names.** The file holds only ids, which is why it's hard to review raw. Run this from the project root (it reads `data/` only, free):
   ```bash
   node -e '
   const g = require("./eval/golden.json"), cars = require("./data/cars.json").cars;
   const runs = process.argv.slice(1).map((l) => require(`./data/eval/${l}.json`));
   const name = Object.fromEntries(cars.map((c) => [`${c.makeId}-${c.modelId}`, `${c.make} ${c.model}`]));
   for (const q of g.queries.filter((q) => q.relevant)) {
     console.log(`\n${q.query}  (${q.kind}, reviewed: ${q.reviewed})`);
     for (const [id, grade] of Object.entries(q.relevant)) console.log(`  ${grade}  ${id.padEnd(12)} ${name[id] ?? "NOT IN DATASET"}`);
     const found = new Set(runs.flatMap((r) => r.queries.find((x) => x.query === q.query)?.ids ?? []));
     for (const id of found) if (!(id in q.relevant)) console.log(`  ?  ${id.padEnd(12)} ${name[id]}`);
   }' names-only-no-niche-2 described-no-niche-2
   ```
   For each search it lists the labeled cars with their grades, then marks with `?` every car that either run returned in its top 5 but isn't labeled. The last two arguments are the runs to take those cars from. Use the latest run of *each* version, so neither one's results set the labels on its own.
3. **First pass: check what's listed,** before looking at the `?` lines. Read the search and ask what a shopper means by it. Is every listed car right, and is its grade right? Remove wrong ones; fix grades. `NOT IN DATASET` means the car was removed (for example a niche maker) and the label should go.
4. **Second pass: grade the `?` cars.** For each one, ask the same question as if you'd thought of it yourself: would this shopper be happy to see it? Add it with a 2 or 1 if so; leave it out if not. Then think of right cars that *neither* run found, and add those too. Look up their ids in `data/cars.json`. Known gaps from the first run: Hyundai Accent `498-2773` and Chevy Sonic `467-1835` (cheap reliable car); Prius C `448-13823` and Prius Prime `448-21950` (fuel efficient hybrid); Scion FR-S `448-2315` (small sports car); Ford Fusion `460-1780` (midsize family sedan); Lincoln Continental `464-5192` and Toyota Crown `448-31077` (luxury sedan); Chevy Bolt EUV `467-30005` (electric car).
5. **Mark it.** Set `"reviewed": true` on each search once both passes are done. Leave the three floor searches alone; they have no labels.
6. **Re-score both versions** under new labels, so the old runs stay for comparison (48 embeddings calls, a fraction of a cent):
   ```bash
   pnpm eval run --label names-only-reviewed --db vector_rag_names
   pnpm eval run --label described-reviewed
   pnpm eval compare names-only-reviewed described-reviewed
   ```
   No run says "draft labels" any more once all 21 are reviewed.

**Keep it fair:**
- **Grade before you look at scores.** Labels set while watching nDCG move turn into labels that make your favorite version win. That's why step 3 comes before the `?` lines, and why step 2 pools both runs.
- **Be consistent across searches.** If the Prius C is a 2 for "fuel efficient hybrid", the Prius Prime probably is too. If a plug-in counts for "electric car", say so once and apply it everywhere.
- **The more specific the search, the narrower the label** (Clark's rule, 2026-11-12). A general search accepts variants: for "honda civic" the Civic is a 2 and the Civic Si and Type R are 1s. A specific search doesn't: "civic type r" lists only the Type R. RUF "CTR" stays out of both.
- **Add, don't replace, and there's no limit of five.** A label is every car a shopper would accept, even if that's twelve. The top 5 is how search is scored, not how many right answers exist.
- **Never copy a run's top 5 into the labels.** It looks right because it mostly *is* right, but then that run scores near 1.0 by definition. Check afterwards: if a search's labels are exactly one run's top 5, regrade it.
- **Don't touch the rules** (`minGain`, the guardrail) in the same sitting. The labels are the thing being fixed; the rules were set before any results.

**Clean up** the baseline database when done: `docker compose exec mongo mongosh vector_rag_names --quiet --eval "db.dropDatabase()"`.

## Check the search page in a browser

**When:** after changing the page, to see it without clicking around.

1. Download headless Chromium once per computer: `pnpm browser:install` (about 100 MB, into `~/.cache/ms-playwright`).
2. Start the app: `pnpm dev`
3. `pnpm screenshot`. This writes `screenshots/search-desktop.png`, `search-dark.png` and `search-phone.png`.

By default the search results are made up (`page.route` answers `/api/search`), so it costs nothing and shows every kind of result row: with and without a description, long and short year spans, and a year filter. Options:

| Flag | Does |
|---|---|
| `--query "small honda"` | Types something else (default `2018 corolla`) |
| `--real` | Uses the real search API: one OpenAI embeddings call per screenshot |
| `--url http://localhost:3100` | Points at another running server |

It exits with an error, and lists them, if the page logs any console errors. `screenshots/` isn't committed.
