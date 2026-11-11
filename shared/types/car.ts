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

export type SearchResponse = { results: SearchResult[]; years: YearRange | null };

// What's loaded, for the page's "model years …" text. `years` is null when empty.
export type CatalogSummary = { models: number; years: YearRange | null };
