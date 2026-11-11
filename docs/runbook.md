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
