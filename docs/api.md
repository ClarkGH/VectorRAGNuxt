# API reference

The app's server has three endpoints. The search page uses `POST /api/search` and `GET /api/catalog`, and you can call them directly with `curl` while `pnpm dev` is running.

There's no authentication: the app is meant to run on your own computer only (see [security](specs/ingest-search.md#security-and-safety)). Don't expose it publicly until it has login or rate limits, because every search costs a little OpenAI money.

## `POST /api/search`

Finds the car models closest in meaning to a request.

```bash
curl -s http://localhost:3000/api/search \
  -H 'content-type: application/json' \
  -d '{"query": "2018 accord", "limit": 2}'
```

### Request

The body must be JSON, sent with `Content-Type: application/json`.

| Field | Type | Required | Rules |
|---|---|---|---|
| `query` | string | yes | 1–500 characters after trimming. May contain model years (see below) |
| `limit` | integer | no | 1–20. Defaults to 5 |

**Years in the query.** Four-digit years from 1980 to 2099 become a filter, and the rest of the text is what gets searched:

| Query | Searches for | Years filter |
|---|---|---|
| `2018 accord` | `accord` | 2016–2020 (one year means two either side) |
| `2016-2019 accord`, `accord from 2016 to 2019`, `between 2016 and 2019 accord` | `accord` | 2016–2019 |
| `1955 Custom Belair` | the whole query | none (1955 is outside 1980–2099, so it's treated as part of the name) |
| `accord` | `accord` | none |

A car matches the filter if it was sold in **any** year of the range.

### Response: 200

A real response, from the example request above:

```json
{
  "results": [
    {
      "_id": "474-1861",
      "make": "HONDA",
      "makeId": 474,
      "model": "Accord",
      "modelId": 1861,
      "years": [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
      "embeddingText": "HONDA Accord",
      "score": 0.8025525212287903
    },
    {
      "_id": "475-5354",
      "make": "ACURA",
      "makeId": 475,
      "model": "TLX",
      "modelId": 5354,
      "years": [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
      "embeddingText": "ACURA TLX",
      "score": 0.7000885605812073
    }
  ],
  "years": [2016, 2020]
}
```

| Field | Meaning |
|---|---|
| `results` | Best match first. Can be empty, for example when no car was sold in the requested years |
| `results[].years` | Every model year the car was sold, sorted |
| `results[].description` | Present only once `pnpm describe` has run for that car. **AI-written, not verified fact**: show it labeled as such |
| `results[].embeddingText` | The exact text that was turned into the car's vector, useful for debugging matches |
| `results[].score` | 0 to 1. **0.5 means unrelated**, so read it as a ranking rather than a percentage (see [the math](rag.md#5-what-mongos-score-means)) |
| `years` | The year filter that was applied, `[from, to]`, or `null` if the query had no year |

The TypeScript types are `SearchResponse` and `SearchResult` in [`shared/types/car.ts`](../shared/types/car.ts). Inside the Nuxt app, `$fetch("/api/search", …)` infers them automatically.

### Errors

| Status | When | `statusMessage` |
|---|---|---|
| 415 | The body isn't sent as JSON (for example a form post) | `Content-Type must be application/json` |
| 400 | The body isn't a JSON object | `Body must be a JSON object` |
| 400 | `query` isn't a string, for example `{"query": {"$gt": ""}}` | `query must be a string` |
| 400 | `query` is empty or longer than 500 characters | `query must be 1-500 characters` |
| 400 | `limit` isn't a whole number from 1 to 20 | `limit must be an integer from 1 to 20` |
| 502 | Mongo or OpenAI failed (not running, index still building, bad key, rate limit) | `Search is unavailable right now` |

Error bodies look like this:

```json
{ "error": true, "statusCode": 400, "statusMessage": "query must be 1-500 characters", "message": "query must be 1-500 characters" }
```

The 502 never says what actually went wrong. The details go to the server log, in the `pnpm dev` terminal, prefixed with `search failed:`. In development, Nuxt also adds `url` and a `stack` trace to every error body; production builds (`pnpm build`) leave them out.

**Why so strict?** Rejecting non-JSON bodies stops other websites from quietly using your running app, because browsers can send form posts across sites without asking. Exact types mean request data can never turn into a database operator. Both are covered by tests (S1 and S2 in the [spec](specs/ingest-search.md)).

### Cost and limits

Each search makes one OpenAI embeddings call, costing a tiny fraction of a cent. It counts against the OpenAI account's rate limits for `text-embedding-3-small`, so very heavy use returns 502s until the limit resets. The app itself has no rate limiting.

## `GET /api/catalog`

Says what's loaded: how many car models, and the span of their model years. The page uses it for its footer and "no results" text, so those never hard-code years. It reads Mongo only, with no OpenAI call.

```bash
curl -s http://localhost:3000/api/catalog
```

```json
{ "models": 475, "years": [2016, 2026] }
```

`years` is `null` when the collection is empty. If Mongo is unreachable it returns a 502 with `Catalog is unavailable right now`, and the page falls back to wording without numbers. The type is `CatalogSummary` in [`shared/types/car.ts`](../shared/types/car.ts).

## `GET /api/health`

Says the server is up and can reach Mongo. It doesn't check OpenAI, since that would spend a request on every check.

```bash
curl -s http://localhost:3000/api/health
```

```json
{ "status": "ok" }
```

If Mongo is unreachable it returns a **503** with `Database is unavailable right now`, and the reason goes to the server log only (S6).
