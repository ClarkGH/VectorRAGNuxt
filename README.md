# VectorRAGNuxt

Playing with Vector DBs / RAG / NUXT for a work skill pivot. Might throw this away and never touch again

> [!WARNING]
> **Local use only. Don't deploy this as-is.** It's built to run on your own computer, and it isn't safe on the public internet:
> - **The search page's error message names the server's configuration** ("check that Mongo is running and `NUXT_OPENAI_KEY` is set"). That's helpful locally, but on a public site it tells visitors which secrets the server uses and that its database might be down.
> - **No login or rate limiting.** Every search spends money on your OpenAI key, so anyone who finds the URL can run up your bill.
>
> The fixes are written up in the [spec's security section](docs/specs/ingest-search.md#before-going-public).

## How to Run
Assuming you have Node 26 (`nvm use`), pnpm, Docker and an OpenAI API key

1. Install the necessary packages `$ pnpm install`
2. Scrape the cars `$ pnpm scrape [--from 2016] [--to 2026] [--makes honda,toyota] [--fresh]`
   - The flags choose what to fetch; `data/cars.json` is always rebuilt from everything cached in `data/.cache`, so partial runs add data instead of replacing it. Delete `data/.cache` to start over.
3. Start MongoDB with vector search `$ docker compose up -d` (local only; see [Troubleshooting](#troubleshooting) for what the compose file works around)
4. Copy `.env.example` to `.env` and fill in `NUXT_OPENAI_KEY` (a project key with a budget cap)
5. Write a short AI description per car `$ pnpm describe [--limit 20] [--fresh]` (optional but much better matches; a few cents; saved to `data/descriptions.json`, which is worth a skim. Re-runs only fill in what's missing)
6. Load the cars into Mongo `$ pnpm ingest` (safe to re-run; only new or changed cars, or cars embedded by a different model, are re-embedded. Also adds the year filter to an older index)
7. Run the webapp `$ pnpm dev` and search at http://localhost:3000. Put a year in the search ("2018 accord") to filter by model year

Stop Mongo with `docker compose down` (data is kept in a Docker volume; `down -v` wipes it).

## Checks and tests

| Command | What it runs |
|---|---|
| `pnpm check` | Lint, typecheck and unit tests (not screenshots or integration tests) |
| `pnpm lint` | ESLint (Nuxt config, plus `vue/no-v-html` as an error) |
| `pnpm typecheck` | `nuxt typecheck` (app, server, shared) + `tsc -p scripts` (scripts and tests) |
| `pnpm test` | Unit tests: input validation (S1/S2), year parsing, description checks (P2/P3), grouping, re-embed rules, cache names, eval metrics and win/loss rules |
| `pnpm screenshot` | Headless-Chromium screenshots of the search page (light, dark, phone) with made-up results; needs `pnpm dev` running and `pnpm browser:install` once. See the [runbook](docs/runbook.md#check-the-search-page-in-a-browser) |
| `pnpm test:integration` | Ingest + vector search + year filter + index upgrade against real Mongo with a stand-in OpenAI (needs `docker compose up -d`; no OpenAI key) |
| `pnpm test:relevance` | Real searches against the real database and embeddings: 5 pass/fail checks plus 3 known weak spots, with a top-5 table to compare before and after a change. Run by hand; needs `pnpm ingest` done and the key. See the [runbook](docs/runbook.md#check-search-quality) |
| `pnpm eval run` / `compare` | Scores search against the labeled searches in `eval/golden.json` (nDCG, Hit@1, MRR, Recall) and calls a change a win, loss or inconclusive. Run by hand; about 24 embeddings calls per run. See [Measuring search quality](docs/evaluation.md) and the [runbook](docs/runbook.md#score-search-quality) |

A CI workflow that runs all of them (`.github/workflows/ci.yml`) exists locally but isn't pushed or enabled yet; for now, run `pnpm check` before you push.

## Troubleshooting

**`docker compose up` fails with "port is already allocated".** A Mongo container from before the compose file is still running: `docker rm -f vectorrag-mongo`, then retry.

**`pnpm ingest` says the index isn't queryable / container logs say "Initial syncs are paused".**
Mongo's search engine (mongot) stops building indexes when its disk is over **85%** full, and only starts again below **80%**. `docker-compose.yml` keeps mongot's index in memory (`tmpfs`) instead, where that check passes. That's safe because mongot rebuilds its index from Mongo's data whenever the container starts (a few seconds for our 673 cars). If you see this with the compose file, check the container is the compose one (`docker compose ps`).

**`pnpm describe` reports failures with "429" or "Rate limit reached".** Free-tier OpenAI accounts get 10 requests a minute and 50 a day on gpt-5-mini. The script sends 40 cars per request (17 for the whole catalog) and stops when the daily limit is hit. Re-run it later; it only does the missing ones. Adding billing to the OpenAI account raises the limits.

**Search returns "Search is unavailable right now".** The real error is in the `pnpm dev` terminal (we never send it to the browser). Usually Mongo isn't running, the index is still building, or the OpenAI key is missing or wrong.

## Why?

"Don't worry about it, bro."

## What?

### Happy Path
As a User
When I submit a prompt
I want to see the closest car related to what was prompted

### Sad Path
As a User
When I submit a prompt for a van
I only see cars, vans and SUVs are not scraped

## Tech Stack

- Nuxt 4 with Nuxt UI
- Node 26
- MongoDB for a vectorDB (Atlas Local in Docker)
- OpenAI's API: embeddings for search, gpt-5-mini for car descriptions (env key not included)
- Vitest for tests, Playwright (headless Chromium) for checking the page

## Cool Credits

- Car data scraped from the [NHTSA vPIC API](https://vpic.nhtsa.dot.gov/api/)

## Docs

- [How it works](docs/rag.md): the pipeline, what we're seeding, and the vector math behind RAG
- [API reference](docs/api.md): `POST /api/search`, `GET /api/catalog` and `GET /api/health`, with real examples and every error
- [Runbook](docs/runbook.md): adding a model year, fixing or rewriting descriptions, changing the embedding model, starting the database over
- [Measuring search quality](docs/evaluation.md): how we'll tell whether a change makes search better or worse (labeled searches, scores, win/loss rules), checked with a simulation
- [Spec: Ingest + vector search](docs/specs/ingest-search.md): the plan for the "closest car" slice, including security, and where verification stands
