// Ingest and search must embed the same way, or every score is meaningless:
// vectors from different models (or text formats) don't share a space.
// Both sides import these; nothing else should hard-code them.
import type OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export const CARS_COLLECTION = "cars";
export const CARS_VECTOR_INDEX = "cars_embedding";

// The name, plus the AI-written description when there is one: the description
// carries meaning ("compact sedan, affordable") that a bare name can't.
export function embeddingText(car: { make: string; model: string; description?: string }) {
    const name = `${car.make} ${car.model}`;
    return car.description ? `${name}. ${car.description}` : name;
}

// Returns one vector per input, in input order.
export async function embedTexts(openai: OpenAI, texts: string[]): Promise<number[][]> {
    const res = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
