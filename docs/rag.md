# How VectorRAGNuxt works

**In one sentence:** you type what you're looking for in your own words, and the app finds the cars whose names are closest in *meaning*, not just in spelling.

The plan for building the search part is in [the spec](specs/ingest-search.md).

## The idea, without the jargon

Ordinary search matches words. Type "civic" and it finds text containing "civic". It can't tell that "small Honda" and "Civic" are related.

This app uses an AI model to place every car on a **map of meaning**. Cars that are similar end up near each other, the way a library shelves books about the same topic together. When you type a request, the same model places it on the map, and we show you the cars closest to it.

*It's a lot like a library, except nobody shushes you and half the books are Hondas.*

That technique is called **vector search**. It's the first half of **RAG** (retrieval-augmented generation), the pattern most "chat with your data" products use:

1. **Retrieve:** find the most relevant items (this app, today).
2. **Generate:** hand those items to a chat AI and let it write a helpful answer (a later step).

## How it works, step by step

```mermaid
flowchart LR
  a[Government car database] -->|1. Collect| b[Our car list]
  b -->|2. Place on the map| c[(Database)]
  d[You type a request] -->|3. Place on the map| e[Search]
  c --> e -->|4. Closest cars| f[Results page]
```

**Done once, ahead of time:**
1. **Collect:** download every passenger car model sold in the US from 2016 to 2026 from a free government database.
2. **Describe:** a writing AI adds a sentence or two per car ("Compact sedan known for reliability…"), so the map knows more than the name.
3. **Place on the map:** send each car's name and description to an AI model, which turns it into a map position, and save the positions in our database.

**Every time someone searches:**

4. **Place the request on the map:** the same AI model turns the request into a position. If the request has a year in it ("2018 accord"), the year is set aside as a filter.
5. **Find the neighbors:** the database returns the cars closest to that position, best match first, skipping any not sold in the requested years (two years either side of a single year).

## What's in the data

| | |
|---|---|
| **Source** | The US government's free vehicle database ([NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/)) |
| **Covers** | Passenger cars, model years 2016–2026 |
| **Size** | 475 car models from 66 manufacturers (2,617 model-year combinations). vPIC lists 673 models from 149; 83 niche makers (limo, kit-car and replica builders) are left out, see [tech-debt #10](tech-debt.md#10-remove-niche-makers-from-the-dataset) |
| **Each car has** | Manufacturer, model name, the years it was sold, and a short **AI-written** description. 425 have a real one; for the other 50 the model didn't know the car and wrote "Lesser-known model from MAKE." instead of guessing |

**What's missing, and why it matters:**
- **Almost no SUVs or vans, and no pickups.** The government database files most of them separately, so searching for "family SUV" won't find a Honda CR-V. A few slip in as passenger cars: 27 of the 475 models are described as crossovers, SUVs or vans (the Tesla Model X, Volvo XC90 and Nissan Kicks among them). There are no pickups at all. *Vans in particular have pulled quite the van-ishing act.*
- **No verified facts, prices or specs.** The descriptions come from an AI's general knowledge, not a spec sheet, so they can be wrong. The page says so. Cars the AI doesn't recognize are described as "Lesser-known model from MAKE" rather than guessed at. *We asked it not to make things up, and unlike a used-car salesman, it mostly listens.*
- **Light curation.** 83 niche makers (limo builders, kit cars and replicas) crowded out real answers, so they were removed ([tech-debt #10](tech-debt.md#10-remove-niche-makers-from-the-dataset)). Everything else NHTSA lists as a passenger car is in, including the few SUVs.

## What to expect from results

| Request | Expected quality | Why |
|---|---|---|
| "honda civic", "civic type r" | **Good** | Close to the names we have |
| "2018 accord" | **Good** | Matches by name, filtered to models sold 2016–2020 |
| "small honda", "cheap reliable car" | **Fair to good** | The descriptions now carry words like "compact" and "affordable" for well-known models |
| "something like a Kandi K27" | **Poor** | Obscure models only get "Lesser-known model", so there's little to match |
| "family SUV" | **Poor** | Only the few crossovers and SUVs that NHTSA lists as passenger cars |
| "pickup truck" | **None** | Pickups aren't in the data |

These are expectations, not measurements yet; the table gets real scores once we've run each request. How we'll measure them, and decide whether a change is a win, is in [Measuring search quality](evaluation.md).

### When nothing is close

Search always returns the nearest cars, even for nonsense. So when no result scores at least 0.65, the page says **"Nothing close to that in the catalog"** above them (the `nothingClose` flag in the [API](api.md#response-200)).

| Gibberish: flagged | A near miss: not flagged |
|---|---|
| ![Search for "wakka wakka huba dooba": a "Nothing close to that in the catalog" notice above results marked "Weak match"](images/nothing-close-flagged.png) | ![Search for "donkey shaped car": no notice, results marked "Possible match"](images/nothing-close-near-miss.png) |
| Top score 0.60, under the line: "Weak match" | Top score 0.70, just over it: "Possible match", though nothing really fits |

Each result is marked **Strong match** (0.78 and up), **Possible match** (0.65 to 0.78) or **Weak match** (under 0.65), not a percentage. A mid score can't tell a right answer from a wrong one: out-of-catalog searches like "pickup truck" score in the same range as correct results. So the page says "possible" rather than a precise-looking number, and "Explain these results" can say which possible matches fit. The data and the decision: [evaluation.md](evaluation.md#the-match-display-why-words-not-percentages-2026-11-19).

The right-hand case is why a score threshold alone can't say "we don't carry that": real near misses ("pickup truck" scores 0.75) land above it too. Those are left to the AI answer, which can say none of the cars fit ([G spec, decision 1](specs/generate.md#decisions-clarks-calls)).

### Asking the AI which results fit

Under the results heading, **Explain these results** asks the AI which of the cars fit the search. It reads only the descriptions shown and may pick only those cars. It marks each pick on its result card with the reason, and the summary links to them. When none fit, it says so with fixed page text instead of making something up.

![Search for "small honda hatchback": the summary says "5 of 5 fit: Fit (#1), Hardtop (#2), Mirage (#3), Fiesta (#4), and Lancer SportBack (#5)", labeled as AI-written, and the Honda Fit card, marked "Strong match", has a blue edge and an "AI pick" note saying it's a subcompact hatchback matching the search](images/ai-answer-small-honda-hatchback.png)

A real answer from gpt-5-mini, and an imperfect one, kept on purpose. It picked all five: the Honda Fit, but also a MINI, a Mitsubishi and a Ford, which aren't Hondas. Under the earlier prompt, the same search picked only the Fit. The likely cause is that the descriptions leave out the make, and the current prompt says to judge each car only by its description ([evaluation.md](evaluation.md#answer-check-second-run-2026-11-18)). Cars it doesn't pick are left as they are, since not picking a car isn't a verdict on it. Each answer costs one of the free tier's 50 chat calls a day, so answers only run on request and repeats come from a cache ([G spec](specs/generate.md)).

## Cost

- **Writing descriptions:** a few cents for the whole catalog, once. Only new cars are described on later runs.
- **Setting up the map:** a fraction of a cent for the whole catalog, plus again whenever the car list or descriptions change. *Cheaper than a car wash, and you don't even have to vacuum the seats.*
- **Each search:** one tiny AI call, a fraction of a cent.
- **Risk:** each search costs a little money, so the app must not be public until it has login or rate limits. For now it runs locally only.

## Using AI safely

Three rules sit under every AI piece of this project. They're the bread and butter, not extras:

1. **Least privilege.** The model gets only what it needs for one job. Writing descriptions, it sees a list of car names. Answering a search (the G step), it sees the five retrieved cars and nothing else in the catalog.
2. **Read-only by default.** The model never acts. It can't write to the database, call other services or follow links. Code decides what happens with its answer.
3. **Never combine untrusted input with tools that can act.** Anything the model reads might contain instructions: a visitor's search, or a description another model wrote. So its output is treated as data, not commands. It's checked against a strict shape, cleaned, and thrown away if it names a car it wasn't given.

The detailed rules are P1–P7 and S1–S17 in the specs ([ingest and search](specs/ingest-search.md), [generation](specs/generate.md)). A future [MCP](https://modelcontextprotocol.io) server would follow the same three: one read-only search tool, run locally, with the server, not the model, deciding what's allowed.

## Glossary

- **Embedding / vector:** a car's (or request's) position on the map of meaning, stored as a long list of numbers.
- **Vector search:** finding the stored positions closest to a new one.
- **RAG:** retrieval-augmented generation. Find relevant data first, then let an AI write an answer using it.
- **Score:** how close a result is, from 0 to 1. **0.5 means "unrelated"**, not "half a match". *It's the search engine's way of saying "it's not you, it's me."*

---

## Appendix: the technical detail

The sections below are for engineers and the curious. Click to expand.

<details>
<summary>Architecture and data notes</summary>

- Pipeline: `pnpm scrape` (vPIC → `data/cars.json`) → `pnpm describe` (`gpt-5-mini` → `data/descriptions.json`) → `pnpm ingest` (group, embed, upsert into Mongo) → `POST /api/search` (pull out years, embed the rest, `$vectorSearch` with a `years` pre-filter).
- Embedding model: OpenAI `text-embedding-3-small`, 1,536 dimensions. The text embedded per model is `"{make} {model}. {description}"`, e.g. `"HONDA Civic. Compact sedan/hatchback known for reliability…"` (about 40 tokens), or just the name if there's no description.
- **One doc per make+model, not per year.** `"HONDA Civic"` is identical text in 2016 and 2024, so per-year docs would produce 11 identical vectors and flood the results. Grouping turns 2,617 rows into 475 docs (4,414 into 673 before niche makers were left out), each with a `years` array.
- vPIC files SUVs and vans as "multipurpose passenger vehicle" and pickups as "truck"; we scrape type "car" only.
- Largest makes by row count: BMW 302, Audi 201, Scuderia Cameron Glickenhaus 140. (Before niche makers were left out, a limo builder, ARMBRUSTER STAGEWAY, was third with 176.)

</details>

<details>
<summary>Code map</summary>

| File | What it does |
|---|---|
| `scripts/scrape-cars.ts` | `pnpm scrape` CLI: fetches from vPIC into a resumable cache (`data/.cache/`), then rebuilds `data/cars.json` from the whole cache |
| `scripts/lib/scrape.ts` | Pure scraper helpers: vPIC types, safe cache names (S8), rows from cached model lists |
| `scripts/lib/niche-makes.ts` | The 83 makers left out of the dataset (spec decision 3), by vPIC make id |
| `scripts/describe-cars.ts` | `pnpm describe` CLI: batches of 40, resumable, saves after every batch, stops on the daily limit |
| `scripts/lib/describe.ts` | Description prompt, schema and checks (`cleanDescription`, P1–P6); `describeCars()` keeps only valid answers for cars it asked about |
| `scripts/screenshot.ts` | `pnpm screenshot`: headless-Chromium screenshots of the search page, with `/api/search` mocked unless `--real` |
| `scripts/eval.ts` | `pnpm eval run` / `compare`: scores search against `eval/golden.json` and makes the win/loss call |
| `scripts/lib/eval.ts` | Metrics (nDCG@5, Hit@1, MRR, Recall@5), paired bootstrap, and the win/loss rules from [evaluation.md](evaluation.md) |
| `eval/golden.json` | The labeled searches; `reviewed: false` until a person has checked each |
| `scripts/lib/util.ts` | Shared CLI helpers: atomic writes, the worker pool |
| `scripts/ingest-cars.ts` | `pnpm ingest` CLI: reads env and descriptions, connects, calls the ingest library |
| `scripts/lib/ingest.ts` | Groups rows into models (with descriptions); embeds only new, changed, or other-model ones (`needsEmbedding`); upserts; removes stale models; creates or upgrades the vector index and waits until it's ready |
| `shared/utils/embedding.ts` | **The one place** that defines the embedding model, dimensions, text format, collection and index names, and `embedTexts()`. Ingest and search both use it |
| `shared/types/car.ts` | `Car` (scraped row), `CarModel` (client), `CarDoc` (Mongo, server only), `SearchResult` (API) |
| `server/utils/search.ts` | Framework-free search logic: JSON check (S1), body validation (S2), `parseYearFilter()`, `searchCars()` |
| `server/utils/catalog.ts` | `getCatalogSummary()`: model count and year span, for `GET /api/catalog` |
| `shared/utils/years.ts` | `formatYears()`: the one year-range formatter, used by the page and the describe prompt |
| `server/utils/db.ts` | `getDb()`: one shared Mongo connection; a failed connect is retried on the next call |
| `server/utils/openai.ts` | `getOpenAI()`: one shared OpenAI client, created on first use |
| `server/api/search.post.ts` | `POST /api/search`: maps the search logic onto HTTP (415 / 400 / 502 with generic messages, S6) |
| `app/pages/index.vue` | Search box and result cards (Nuxt UI) |
| `docker-compose.yml` | Local Mongo + mongot: loopback only (S5), mongot index in RAM (disk-threshold workaround) |
| `tests/unit/` | Validation, year parsing, description checks, grouping, re-embed rules, cache-name safety |
| `tests/integration/` | Real Mongo + mongot with a stand-in OpenAI: ingest, index (and upgrade), ranking, year filter, descriptions, no leaked fields, stale removal |
| `tests/fixtures/fake-openai.ts` | Stand-in `/v1/embeddings` (trigram vectors) and `/v1/responses` (scripted descriptions, including misbehaving ones) |

**Testing without an OpenAI key:** the SDK accepts a `baseURL` (or the `OPENAI_BASE_URL` environment variable), so the tests point it at `tests/fixtures/fake-openai.ts`. That exercises everything except real match quality.

</details>

<details>
<summary>The vector math</summary>

### 1. An embedding is a point in space

An embedding model is a function from text to a list of numbers:

$$
E(\text{"HONDA Civic"}) = \mathbf{v} = (v_1, v_2, \dots, v_{1536}) \in \mathbb{R}^{1536}
$$

No single dimension means "is a sedan"; meaning is spread across all 1,536 numbers. What we can rely on is the geometry: **closeness in space ≈ closeness in meaning.**

### 2. Dot product, length and angle

For $\mathbf{a}, \mathbf{b} \in \mathbb{R}^n$:

$$
\mathbf{a} \cdot \mathbf{b} = \sum_{i=1}^{n} a_i b_i
\qquad
\|\mathbf{a}\| = \sqrt{\mathbf{a} \cdot \mathbf{a}}
\qquad
\mathbf{a} \cdot \mathbf{b} = \|\mathbf{a}\|\,\|\mathbf{b}\| \cos\theta
$$

Rearranged, that's **cosine similarity**, the measure our index uses:

$$
\cos\theta = \frac{\mathbf{a} \cdot \mathbf{b}}{\|\mathbf{a}\|\,\|\mathbf{b}\|}
$$

A value of 1 means the same direction (same meaning) and 0 means perpendicular (unrelated). Cosine compares direction and ignores length.

*I'd tell you a joke about perpendicular vectors, but they have nothing in common.*

### 3. Why cosine, dot product and distance all agree here

OpenAI's embeddings are normalized ($\|\mathbf{a}\| = 1$), so $\cos\theta = \mathbf{a}\cdot\mathbf{b}$ and

$$
\|\mathbf{a} - \mathbf{b}\|^2 = \mathbf{a}\cdot\mathbf{a} - 2\,\mathbf{a}\cdot\mathbf{b} + \mathbf{b}\cdot\mathbf{b} = 2 - 2\cos\theta
$$

Higher cosine ⇔ higher dot product ⇔ smaller distance: all three rank results identically. We use `cosine` because it stays correct even with a model that doesn't normalize.

### 4. Worked example (3 dimensions instead of 1,536)

| Text | Vector |
|---|---|
| prompt: "small honda" | $\mathbf{q} = (0.8,\ 0.6,\ 0)$ |
| "HONDA Civic" | $\mathbf{a} = (0.6,\ 0.8,\ 0)$ |
| "BMW M8" | $\mathbf{b} = (0,\ 0.6,\ 0.8)$ |

$$
\mathbf{q}\cdot\mathbf{a} = 0.48 + 0.48 = 0.96 \ (\theta \approx 16^\circ)
\qquad
\mathbf{q}\cdot\mathbf{b} = 0.36 \ (\theta \approx 69^\circ)
$$

The Civic wins. Distance agrees: $\|\mathbf{q}-\mathbf{a}\|^2 = 0.2^2 + 0.2^2 = 0.08 = 2 - 2(0.96)$.

### 5. What Mongo's score means

`$vectorSearch` rescales cosine from $[-1, 1]$ to $[0, 1]$:

$$
\text{score} = \frac{1 + \cos\theta}{2}
$$

The Civic scores 0.98 and the BMW 0.68. A score of 0.5 means unrelated. Real scores bunch up, so rank matters more than the absolute number, and you shouldn't hard-code a threshold without looking at real scores first.

The page doesn't show this score directly. Until 2026-11-19 it showed a rescaled percentage, $(\text{score} - 0.5) / 0.5$, since 0.5 already means unrelated. That was correct but misleading: real searches land at 0.75–0.85, so a right answer showed as about 52%, and a mid score turned out to be ambiguous anyway (right and wrong answers both land there). The page now shows a word instead: **Strong match** from 0.78, **Possible match** from 0.65, **Weak match** below ([evaluation.md](evaluation.md#the-match-display-why-words-not-percentages-2026-11-19)). The cut-offs live in `shared/utils/match-strength.ts`. Thresholds in code and docs (like the G step's 0.65) stay on Mongo's scale.

### 6. Exact vs approximate search

Brute force means computing the dot product with every stored vector: $475 \times 1536 \approx 0.7$ million multiplications, about a millisecond. At millions of vectors that's too slow, so Mongo's index uses **HNSW**, a layered graph that a search walks greedily toward the query. It only visits a fraction of the vectors, at the cost of being *approximate*. `numCandidates` is the dial: explore more candidates for better recall but a slower query. Mongo suggests 10–20× `limit`.

### 7. Why bare names are weak, and what descriptions change

The vector for `"HONDA Civic"` carries whatever the model learned about Civics (compact, affordable, reliable), so concept queries can work for famous models. Obscure names carry little. Adding a description puts those concepts into the text itself: `"HONDA Civic. Compact sedan/hatchback known for reliability, fuel efficiency…"` lands much nearer "cheap reliable car" than the name alone does.

The trade-off is that the name is now a smaller share of the text, so pure name searches ("civic") score a little lower than before, and a confidently wrong description pulls a car toward the wrong neighbors. That's why unknown cars get a deliberately bland "Lesser-known model from MAKE."

### 8. Filtering by year

A year isn't meaning, it's a fact, so it doesn't go into the vector. `"2018 accord"` embeds as `"accord"` and adds a pre-filter: only docs whose `years` array contains any of 2016–2020 are searched at all. Pre-filtering happens inside the HNSW walk, so you still get `limit` results (when that many exist) rather than five results minus whatever a later filter throws away.

### 9. How the "G" works

Generation hands the top results to a chat model and lets it write the answer. Retrieval decides which facts the model sees, so it had to be right first ([evaluation](evaluation.md)). The full design and its reasons are in the [G spec](specs/generate.md); this is the short version.

**What happens when you click "Explain these results"** (`POST /api/answer`, [api.md](api.md#post-apianswer)):

1. **Check the request.** JSON only, a query, and 1–5 car ids in the right format. The server fetches those cars itself and never trusts car data sent by the browser.
2. **Look in the cache.** A repeat of the same search, with the same cars, prompt and descriptions, costs nothing. The cache stores a hash of the search, never the text.
3. **Count it.** At most 5 uncached answers a minute, since the free tier allows 50 chat calls a day.
4. **The gate.** Re-embed the search and score it against those cars. Under 0.65 on Mongo's scale ([§5](#5-what-mongos-score-means)), nothing is close and the model is never asked.
5. **Ask the model once.** gpt-5-mini gets the rules as instructions and the search and cars as data, never as instructions. It must reply in a fixed JSON shape: either "none fit", or up to 5 picks, each a car id and a one-sentence reason. The call is never retried, since each retry could spend another of the 50.
6. **Check the reply in code.** It's dropped if it's cut short, has the wrong shape, picks an id it wasn't given, names a catalog car that wasn't retrieved, is too long, or contains markup or links. Invisible and text-direction characters are removed first.
7. **Cache it and show it.** Only a reply that passed every check is cached. The page marks each pick on its result card and labels the answer AI-written. "None fit" is shown as fixed page text, never as model text.

**Why step 6 matters:** the [answer check](evaluation.md#answer-check-second-run-2026-11-18) found that, when a search asks to compare against a car that isn't in the results ("is the Ford Mustang a better choice?"), the model names it anyway, even when the prompt says never to. Only the check in code catches that. The model's output is treated as untrusted input, the same as anything a user types.

**In development,** answers are mocked by default, with a fake answerer and no cache, so building the page costs nothing. Set `NUXT_ANSWER_MOCK=false` for real answers ([runbook](runbook.md#use-real-ai-answers)).

</details>
