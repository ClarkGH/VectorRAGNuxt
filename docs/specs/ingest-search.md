# Spec: Ingest + vector search ("closest car")

Status: draft, 2026-11-09 · How the pieces work: [docs/rag.md](../rag.md)

## Problem

We have 4,414 scraped cars in `data/cars.json` and nothing that uses them. The README's happy path is: a user types a prompt and sees the closest car. This slice builds that path end to end: get the cars into Mongo with embeddings, search them by meaning, and show the results on the index page.

## Goals

1. `pnpm ingest` loads every car model into Mongo with an embedding and creates the vector index. Re-running it is safe and cheap.
2. `POST /api/search` takes a free-text prompt and returns the closest car models, ranked, with scores.
3. The index page has a prompt box that calls the endpoint and lists the results.

## Non-goals (this slice)

- **The "G" in RAG.** No chat model writes an answer from the results yet. Retrieval comes first and gets its own slice.
- **SUVs, vans, trucks.** The data has cars only (the README's sad path).
- **Richer car descriptions.** See open question 1.
- **Auth and rate limiting.** The endpoint spends OpenAI credit on every call, so this stays a local-only app until those exist.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Document grain | **One doc per make+model**, with a `years` array | Per-year rows embed to near-identical vectors, so the top 5 for "Civic" would be Civic 2016, 2017, 2018… Grouping turns 4,414 rows into 673 distinct models. |
| Embedding model | OpenAI `text-embedding-3-small`, 1536 dimensions | Cheap and good enough. The whole dataset is about 4k tokens, a fraction of a cent. |
| Embedding text | `"{make} {model}"`, e.g. `"HONDA Civic"` | It's all the data has. Its limits are explained in [rag.md § Why bare names are weak](../rag.md#why-bare-names-are-weak). |
| Similarity | Cosine | OpenAI embeddings have length 1, so cosine and dot product rank identically. Cosine is the conventional choice. |
| Mongo | `mongodb/mongodb-atlas-local` in Docker, or an Atlas free cluster | Both support `$vectorSearch`. Plain community Mongo isn't a safe bet. |
| Shared constants | Model name, dimensions and the text builder live in `shared/utils/embedding.ts` | Ingest and search **must** embed the same way (see failure modes). |

## Design

### Data shape (`cars` collection)

```ts
{
  _id: "474-1863",            // `${makeId}-${modelId}`: stable, so re-ingest upserts
  make: "HONDA", makeId: 474,
  model: "Civic", modelId: 1863,
  years: [2016, 2017, /* … */ 2026],
  embeddingText: "HONDA Civic",
  embedding: [/* 1536 numbers */],
}
```

New shared types in `shared/types/car.ts`: `CarModel` (everything except `embedding`) and `SearchResult = CarModel & { score: number }`. The `embedding` field never leaves the server.

### Vector index

Name `cars_embedding`, on `cars`:

```json
{ "fields": [{ "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" }] }
```

Created by the ingest script with `createSearchIndex` if it doesn't exist. Index builds are asynchronous, so the script polls `listSearchIndexes` until the index reports `queryable: true`.

### `scripts/ingest-cars.ts` (`pnpm ingest`)

Runs with `node --env-file-if-exists=.env`, so Node loads the env file itself and no tool needs to read it. Reads `NUXT_MONGODB_URI` and `NUXT_OPENAI_KEY` and fails fast with a clear message if either is missing.

1. Read `data/cars.json` (`CarsFile`) and group rows into `CarModel`s.
2. Load the existing `_id → embeddingText` pairs from Mongo. Only embed models that are new or whose text changed. A re-run with no changes calls OpenAI zero times.
3. Embed in batches (≤ 500 inputs per request), reusing the scraper's retry approach.
4. `bulkWrite` upserts by `_id`.
5. Ensure the index exists and wait until it's queryable.
6. Print a summary: models total, embedded, unchanged.

### `server/api/search.post.ts`

- Body `{ query: string, limit?: number }`. Trim `query` and require 1–500 characters. `limit` defaults to 5, maximum 20. Bad input gets a 400.
- Embed `query` with the shared settings (`server/utils/openai.ts` holds a lazily created client, cached the same way as `getDb`).
- Aggregate on `cars`:

  ```ts
  [
    { $vectorSearch: { index: "cars_embedding", path: "embedding", queryVector, numCandidates: limit * 20, limit } },
    { $project: { embedding: 0, score: { $meta: "vectorSearchScore" } } },
  ]
  ```
- Returns `{ results: SearchResult[] }`. Mongo or OpenAI failures return a 502 with a generic message; the details go to the server log only.

### UI (`app/pages/index.vue`)

A `UInput` with a submit `UButton`, then a list of `UCard`s showing make, model, year range and score (as a percentage). States to handle: empty, loading (button spinner), error (`UAlert`), and no results.

## Failure modes to design against

| If… | Then… | Guarded by |
|---|---|---|
| Search embeds with a different model or text format than ingest | Scores are meaningless: the vectors live in unrelated spaces | Shared `embedding.ts` |
| A query arrives while the index is still building | Empty results, no error | Ingest waits for `queryable` |
| Ingest crashes halfway | Some models missing | Upsert by stable `_id`; just re-run |
| The OpenAI key is exposed to the client | Anyone can spend your credit | Key only in server `runtimeConfig`, never `public` |

## Acceptance criteria

- [ ] `pnpm ingest` on an empty DB → 673 docs, index queryable. A second run reports 0 embedded.
- [ ] `POST /api/search {"query":"honda civic"}` → the top result is HONDA Civic.
- [ ] `{"query":"civic type r"}` ranks Civic Type R above Civic.
- [ ] `{"query":""}` → 400. `{"query":"x","limit":999}` → 400.
- [ ] No response contains an `embedding` field.
- [ ] The index page shows results for a typed prompt, and an error state when the server is down.
- [ ] `pnpm lint` and `pnpm typecheck:scripts` pass.

## Open questions

1. **Enrichment.** Bare names match name-like queries well and concept queries ("cheap sporty car") poorly. One option is to have a small chat model write a 1–2 sentence description per model at ingest time. That's 673 calls and cents in cost, but it's text we generated, not facts we scraped. Decide after seeing slice results.
2. **Year filtering.** "2018 Accord" could pre-filter on `years` if it's added to the index as a `filter` field. Parsing the year out of the prompt is the hard part. Later.
3. **Noise makes.** Limo and kit-car builders (ARMBRUSTER STAGEWAY has 176 rows) will appear in results. We said simple for now. An allowlist of makes would remove them if they get annoying.
