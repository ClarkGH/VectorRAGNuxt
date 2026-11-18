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
  "years": [2016, 2020],
  "nothingClose": false
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
| `nothingClose` | `true` when no result scores at least **0.65**, including when there are no results. The results are still the nearest cars, but none is a real match ("pickup truck", "asdf"). Same threshold as the AI answer's gate ([G spec, decision 1](specs/generate.md#decisions-clarks-calls)), so the page can say "nothing close" without spending an AI call |

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

## `POST /api/answer`

Asks an AI which of a search's results fit, and why. The page calls it from "Explain these results". How it works, step by step: [rag.md §9](rag.md#9-how-the-g-works). The rules behind it: the [G spec](specs/generate.md).

```bash
curl -s http://localhost:3000/api/answer \
  -H 'content-type: application/json' \
  -d '{"query": "electric car", "resultIds": ["452-32328", "467-30005"]}'
```

### Request

JSON, sent with `Content-Type: application/json`, the same as search.

| Field | Type | Required | Rules |
|---|---|---|---|
| `query` | string | yes | 1–500 characters after trimming: the search, as typed |
| `resultIds` | string[] | yes | 1–5 unique car ids (`makeId-modelId`, like `474-1863`), in the order search returned them. The server re-fetches these cars itself; car data from the browser is never used |

### Response: 200

```json
{
  "answer": {
    "noneFit": false,
    "picks": [
      { "carId": "452-32328", "reason": "Midsize luxury electric sedan offering advanced EV tech, comfort and refined performance." }
    ]
  },
  "source": "model"
}
```

| Field | Meaning |
|---|---|
| `answer.noneFit` | `true` when none of the cars fit. Then `picks` is empty, and the page shows fixed text rather than anything the model wrote |
| `answer.picks` | 1–5 picks, best first, only from `resultIds`. Each `reason` is one plain-text sentence, at most 200 characters. **AI-written, not verified fact**: show it labeled as such |
| `source` | `model` (just written), `cache` (a repeat: no AI call), `gate` (nothing scored 0.65, so the AI wasn't asked; always `noneFit: true`), or `mock` (the development stand-in, see [mock mode](runbook.md#use-real-ai-answers)) |

The types are `AnswerResponse` and `Answer` in [`shared/types/car.ts`](../shared/types/car.ts).

### Errors

| Status | When | `statusMessage` | `data.reason` |
|---|---|---|---|
| 415 | The body isn't sent as JSON | `Content-Type must be application/json` | |
| 400 | Bad `query`, or `resultIds` isn't 1–5 unique car ids | describes the problem | |
| 400 | A `resultIds` entry isn't in the catalog | `resultIds must be cars from the catalog` | |
| 429 | More than 5 new answers this minute, or OpenAI's per-minute limit | `Too many answers this minute; try again in a minute` | `try-again-in-a-minute` |
| 429 | OpenAI's daily limit is used up (50 a day on the free tier) | `Answers are paused for today` | `paused-for-today` |
| 429 | The OpenAI account has no credit left | `Answers are unavailable: the OpenAI account is out of credit` | `out-of-quota` |
| 502 | The AI's reply failed a check (wrong shape, an id it wasn't given, naming a car that wasn't retrieved, too long, markup), or was rejected in the last 10 minutes | `Couldn't write a reliable answer this time` | |
| 502 | Mongo or OpenAI failed some other way | `Answers are unavailable right now` | |

The page words each 429 from `data.reason`, so it never has to parse the message. As with search, the server log gets the details (a rejection's reason code, never the answer text) and the client gets a generic message.

### Cost and limits

- **One chat call per new answer**, on the free tier's 50 a day. Repeats come from a 30-day cache and cost nothing. A search with nothing close never reaches the AI.
- **One embeddings call** per uncached request, for the gate.
- **At most 5 uncached requests a minute**, for the whole server, gated ones included. A dropped answer's search is refused for 10 minutes, so a search the AI keeps getting wrong can't drain the day.
- **The chat call is never retried**, and has a 45-second timeout.

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
