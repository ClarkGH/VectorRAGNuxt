// One scraped car, as stored in data/cars.json.
export type Car = { make: string; makeId: number; model: string; modelId: number; year: number };

export type CarsFile = {
    source: string;
    scrapedAt: string;
    years: [from: number, to: number];
    cars: Car[];
};

// One make+model, grouped across years: what the client sees.
export type CarModel = {
    _id: string; // `${makeId}-${modelId}`
    make: string;
    makeId: number;
    model: string;
    modelId: number;
    years: number[];
    // AI-written by `pnpm describe` (data/descriptions.json). Not verified fact.
    description?: string;
    embeddingText: string;
};

// The Mongo document. Server and ingest only: never send `embedding` to the client.
// `embeddingModel` records which model made the vector, so a model change re-embeds.
export type CarDoc = CarModel & { embedding: number[]; embeddingModel: string };

export type SearchResult = CarModel & { score: number };

// Inclusive model-year range, [from, to].
export type YearRange = [from: number, to: number];

// `nothingClose`: no result reached the answer gate's threshold (docs/specs/generate.md,
// decision 1), so the page says so instead of implying a match.
export type SearchResponse = { results: SearchResult[]; years: YearRange | null; nothingClose: boolean };

// What's loaded, for the page's "model years …" text. `years` is null when empty.
export type CatalogSummary = { models: number; years: YearRange | null };

// An AI-written answer about a search's results (docs/specs/generate.md,
// decision 4). `noneFit: true` has no picks, and the page shows fixed refusal
// text instead of anything the model wrote. Not verified fact.
export type AnswerPick = { carId: string; reason: string };
export type Answer = { noneFit: boolean; picks: AnswerPick[] };

// POST /api/answer. `source` says where the answer came from: the model, the
// cache, the gate (nothing scored 0.65, so the model was never asked), or the
// mock answerer used in development.
export type AnswerResponse = { answer: Answer; source: "model" | "cache" | "gate" | "mock" };

// The `data.reason` on a 429 from /api/answer, so the page can word it.
// "out-of-quota": the OpenAI account has no usable credit, so waiting won't help.
export type AnswerLimitReason = "try-again-in-a-minute" | "paused-for-today" | "out-of-quota";
