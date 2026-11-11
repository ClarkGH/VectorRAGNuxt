# Spec: "Find the closest car" search

**Status:** draft, 2026-11-10 · **Background:** [How VectorRAGNuxt works](../rag.md)

## Summary

A user types what they're looking for in plain language, such as "civic type r" or "small honda", and the app shows the car models that best match, ranked, with a match score. This is the first working version of the app's core promise.

## Why

We've collected a list of 673 car models, but nothing uses it yet. This slice turns that list into something a person can search by meaning, which proves out the core technique (vector search) before we invest in AI-written answers. *Consider it a test drive.*

## User stories

**Happy path:** As a user, when I type a request, I see the car models closest to what I asked for, best match first.

**Known gap:** As a user, when I ask for a van, SUV or truck, I only see cars, because those vehicle types aren't in our data yet.

## What's included

1. **Loading the cars:** a one-command setup step that places every car model on the "map of meaning" and stores it. Running it again is safe and costs nothing if the car list hasn't changed.
2. **Search:** the app takes a typed request and returns up to 5 best-matching car models (up to 20 if asked), each with a match score.
3. **Search page:** a text box and button on the home page, showing results as cards with manufacturer, model, years sold and match score. It also shows clear states for loading, errors and "no results".

## What's not included (yet)

| Not included | Why / when |
|---|---|
| AI-written answers ("the Civic suits you because…") | Next slice, once search results are trustworthy |
| SUVs, vans, trucks | Needs more data collection; tracked as the known gap above. *We're keeping this release compact.* |
| Car descriptions, prices, specs | Open question 1 below |
| Login or usage limits | Required before going public, because every search costs a little money. Local-only until then |

## How we'll know it works

- [ ] Setting up from scratch loads all 673 car models; running setup again changes nothing and costs nothing.
- [ ] Searching "honda civic" shows the Honda Civic first.
- [ ] Searching "civic type r" ranks the Civic Type R above the plain Civic.
- [ ] An empty search, or asking for an absurd number of results, gets a clear error instead of a crash.
- [ ] The search page shows results for a typed request, and a friendly error if the server is down.
- [ ] Nothing the app sends to the browser exposes internal data or our AI key.

## Risks

| Risk | Impact | How we handle it |
|---|---|---|
| Setup and search use different AI settings | Results become random, with no error to warn us | One shared settings file used by both |
| Someone searches while setup is still finishing | Empty results that look like "no matches" | Setup waits until search is ready before reporting done |
| Our AI key leaks to the browser | Anyone could spend our AI budget | The key stays on the server only |
| Name-only data gives weak matches for descriptive requests | "Cheap sporty car" results feel random | Set expectations (see [what to expect](../rag.md#what-to-expect-from-results)); decide on open question 1 |

## Cost

Setup costs well under one cent for the whole catalogue. Each search costs a fraction of a cent. Hosting is a local database for now, so it's free.

## Open questions

1. **Should we write a short description for each car?** Today the AI only sees names like "HONDA Civic", so descriptive requests ("cheap sporty car") match poorly. A small AI model could write a sentence or two per car during setup: 673 calls, costing cents. The trade-off is that those descriptions are AI-generated, not verified facts. **Proposal: decide after trying this slice with real searches.**
2. **Should "2018 Accord" filter by year?** Possible, but working out which part of a request is a year is the hard part. **Proposal: later.**
3. **Should we hide niche manufacturers?** Limo and kit-car builders appear in results. A list of mainstream makes would remove them. **Proposal: only if they get in the way.**

---

## Appendix: engineering details

<details>
<summary>Decisions</summary>

| Decision | Choice | Why |
|---|---|---|
| Document grain | One doc per make+model, with a `years` array | Per-year rows embed to identical vectors and flood the results. 4,414 rows become 673 docs |
| Embedding model | OpenAI `text-embedding-3-small`, 1,536 dimensions | Cheap; the whole dataset is about 4k tokens |
| Embedding text | `"{make} {model}"` | It's all the data has |
| Similarity | Cosine | OpenAI vectors are unit length, so cosine and dot product rank identically |
| Database | `mongodb/mongodb-atlas-local` (Docker) or an Atlas free cluster | Both support `$vectorSearch` |
| Shared settings | `shared/utils/embedding.ts` holds the model, dimensions and text builder | Ingest and search must embed identically |

</details>

<details>
<summary>Data shape and index</summary>

`cars` collection:

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

Shared types in `shared/types/car.ts`: `CarModel` (everything except `embedding`) and `SearchResult = CarModel & { score: number }`. The `embedding` field never leaves the server.

Vector index `cars_embedding`:

```json
{ "fields": [{ "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" }] }
```

</details>

<details>
<summary><code>scripts/ingest-cars.ts</code> (<code>pnpm ingest</code>)</summary>

Runs with `node --env-file-if-exists=.env`, so Node loads the env file and no tool reads it. Requires `NUXT_MONGODB_URI` and `NUXT_OPENAI_KEY` and fails fast if either is missing.

1. Read `data/cars.json` and group rows into `CarModel`s.
2. Load the existing `_id → embeddingText` pairs and only embed models that are new or changed. An unchanged re-run makes zero OpenAI calls.
3. Embed in batches of ≤ 500, with the scraper's retry approach.
4. `bulkWrite` upserts by `_id`.
5. Create the index if it's missing (`createSearchIndex`), then poll `listSearchIndexes` until it reports `queryable: true`.
6. Print a summary: total, embedded, unchanged.

</details>

<details>
<summary><code>POST /api/search</code></summary>

- Body `{ query: string, limit?: number }`. `query` is trimmed and must be 1–500 characters. `limit` defaults to 5, maximum 20. Invalid input gets a 400.
- Embed `query` with the shared settings. `server/utils/openai.ts` holds a lazily created client, cached the same way as `getDb`.
- Pipeline:

  ```ts
  [
    { $vectorSearch: { index: "cars_embedding", path: "embedding", queryVector, numCandidates: limit * 20, limit } },
    { $project: { embedding: 0, score: { $meta: "vectorSearchScore" } } },
  ]
  ```
- Returns `{ results: SearchResult[] }`. Mongo or OpenAI failures return a 502 with a generic message; the details go to the server log only.

</details>

<details>
<summary>UI</summary>

`app/pages/index.vue`: a `UInput` with a submit `UButton`, and `UCard` results showing make, model, year range and score as a percentage. States: empty, loading (button spinner), error (`UAlert`), no results.

</details>

<details>
<summary>Technical acceptance checks</summary>

- `pnpm ingest` on an empty DB gives 673 docs and a queryable index; a second run reports 0 embedded.
- `{"query":""}` → 400; `{"query":"x","limit":999}` → 400.
- No response contains an `embedding` field.
- `pnpm lint` and `pnpm typecheck:scripts` pass.

</details>
