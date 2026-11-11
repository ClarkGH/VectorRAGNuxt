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
2. **Place on the map:** send each car's name to an AI model, which turns it into a map position, and save the positions in our database.

**Every time someone searches:**

3. **Place the request on the map:** the same AI model turns the request into a position.
4. **Find the neighbors:** the database returns the cars closest to that position, best match first.

## What's in the data

| | |
|---|---|
| **Source** | The US government's free vehicle database ([NHTSA vPIC](https://vpic.nhtsa.dot.gov/api/)) |
| **Covers** | Passenger cars, model years 2016–2026 |
| **Size** | 673 car models from 149 manufacturers (4,414 model-year combinations) |
| **Each car has** | Manufacturer, model name and the years it was sold. **Nothing else.** |

**What's missing, and why it matters:**
- **No SUVs, vans or pickups.** The government database files them separately. Searching for "family SUV" won't find a Honda CR-V, because it isn't in the data. *Vans in particular have pulled quite the van-ishing act.*
- **No descriptions, prices or specs.** We only have names, so the AI has to rely on what it already knows about, say, a Civic.
- **No curation.** Limo builders and kit-car makers are included alongside Toyota and BMW, and they can show up in results.

## What to expect from results

| Request | Expected quality | Why |
|---|---|---|
| "honda civic", "civic type r" | **Good** | Close to the names we have |
| "small honda", "cheap reliable car" | **Fair** | Works for famous models the AI already knows about |
| "something like a Kandi K27" | **Poor** | Obscure names carry little meaning to the AI |
| "family SUV", "pickup truck" | **None** | Those vehicles aren't in the data |

The biggest single improvement would be giving each car a short written description before placing it on the map. That's an open decision in the [spec](specs/ingest-search.md#open-questions).

## Cost

- **Setting up the map:** about 4,000 words' worth of AI processing for the whole catalog. That costs **well under one cent** and only happens once, plus again whenever the car list changes. *Cheaper than a car wash, and you don't even have to vacuum the seats.*
- **Each search:** one tiny AI call, a fraction of a cent.
- **Risk:** each search costs a little money, so the app must not be public until it has login or rate limits. For now it runs locally only.

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

- Pipeline: `pnpm scrape` (vPIC → `data/cars.json`) → `pnpm ingest` (group, embed, upsert into Mongo) → `POST /api/search` (embed the prompt, `$vectorSearch`).
- Embedding model: OpenAI `text-embedding-3-small`, 1,536 dimensions. The text embedded per model is `"{make} {model}"`, e.g. `"HONDA Civic"` (about 6 tokens).
- **One doc per make+model, not per year.** `"HONDA Civic"` is identical text in 2016 and 2024, so per-year docs would produce 11 identical vectors and flood the results. Grouping turns 4,414 rows into 673 docs, each with a `years` array.
- vPIC files SUVs and vans as "multipurpose passenger vehicle" and pickups as "truck"; we scrape type "car" only.
- Largest makes by row count: BMW 302, Audi 201, ARMBRUSTER STAGEWAY 176 (a limo builder).

</details>

<details>
<summary>Code map</summary>

| File | What it does |
|---|---|
| `scripts/scrape-cars.ts` | `pnpm scrape`: vPIC → `data/cars.json`, with a resumable response cache in `data/.cache/` |
| `scripts/ingest-cars.ts` | `pnpm ingest`: groups rows into models, embeds only new or changed ones, upserts, ensures the vector index and waits until it's queryable |
| `shared/utils/embedding.ts` | **The one place** that defines the embedding model, dimensions, text format, collection and index names, and `embedTexts()`. Ingest and search both use it |
| `shared/types/car.ts` | `Car` (scraped row), `CarModel` / `CarDoc` (Mongo), `SearchResult` (API) |
| `server/utils/db.ts` | `getDb()`: one shared Mongo connection; a failed connect is retried on the next call |
| `server/utils/openai.ts` | `getOpenAI()`: one shared OpenAI client, created on first use |
| `server/api/search.post.ts` | `POST /api/search`: JSON-only (S1), strict validation (S2), embed + `$vectorSearch`, generic errors (S6) |
| `app/pages/index.vue` | Search box and result cards (Nuxt UI) |

**Testing without an OpenAI key:** the SDK honors `OPENAI_BASE_URL`, so pointing it at a local stand-in `/v1/embeddings` server exercises everything except real match quality. That's how this slice was verified.

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

### 6. Exact vs approximate search

Brute force means computing the dot product with every stored vector: $673 \times 1536 \approx 1$ million multiplications, about a millisecond. At millions of vectors that's too slow, so Mongo's index uses **HNSW**, a layered graph that a search walks greedily toward the query. It only visits a fraction of the vectors, at the cost of being *approximate*. `numCandidates` is the dial: explore more candidates for better recall but a slower query. Mongo suggests 10–20× `limit`.

### 7. Why bare names are weak

The vector for `"HONDA Civic"` carries whatever the model learned about Civics (compact, affordable, reliable), so concept queries can work for famous models. Obscure names carry little, and no facts beyond the name are in our text. Generating a short description per model before embedding it is the obvious fix.

### 8. Where the "G" fits later

Generation pastes the top results into a chat prompt and lets the model write the answer. Retrieval decides which facts the model sees, so it has to be right first.

</details>
