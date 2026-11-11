// Ingest logic, separate from the CLI so it can be tested against a real Mongo.
import type { AnyBulkWriteOperation, Collection } from "mongodb";
import type OpenAI from "openai";
import type { Car, CarDoc, CarModel } from "../../shared/types/car.ts";
import {
    CARS_VECTOR_INDEX,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    embeddingText,
    embedTexts,
} from "../../shared/utils/embedding.ts";

const BATCH_SIZE = 500;

// --- Grouping ---------------------------------------------------------------

// Per-year rows -> one model each, with sorted unique years. Descriptions
// (from `pnpm describe`, keyed by _id) are attached and folded into the
// embedding text when present.
export function groupModels(cars: Car[], descriptions: Map<string, string> = new Map()): CarModel[] {
    const models = new Map<string, CarModel>();
    for (const car of cars) {
        const id = `${car.makeId}-${car.modelId}`;
        let model = models.get(id);
        if (!model) {
            const description = descriptions.get(id);
            model = {
                _id: id,
                make: car.make,
                makeId: car.makeId,
                model: car.model,
                modelId: car.modelId,
                years: [],
                ...(description && { description }),
                embeddingText: embeddingText({ make: car.make, model: car.model, description }),
            };
            models.set(id, model);
        }
        if (!model.years.includes(car.year)) model.years.push(car.year);
    }
    for (const model of models.values()) model.years.sort((a, b) => a - b);
    return [...models.values()];
}

// Re-embed when the text changed *or* the stored vector came from a different
// model: vectors from different models don't share a space.
export function needsEmbedding(model: CarModel, stored?: { embeddingText: string; embeddingModel?: string }) {
    return stored?.embeddingText !== model.embeddingText || stored.embeddingModel !== EMBEDDING_MODEL;
}

// --- Ingest -----------------------------------------------------------------

export type IngestSummary = { models: number; embedded: number; unchanged: number; removed: number };

export async function ingestModels(
    cars: Collection<CarDoc>,
    openai: OpenAI,
    models: CarModel[],
    log: (message: string) => void = console.log,
): Promise<IngestSummary> {
    const stored = new Map<string, { embeddingText: string; embeddingModel?: string }>();
    const existing = cars.find(
        { embedding: { $exists: true } },
        { projection: { embeddingText: 1, embeddingModel: 1 } },
    );
    for await (const doc of existing) stored.set(doc._id, doc);
    const toEmbed = models.filter((m) => needsEmbedding(m, stored.get(m._id)));

    const vectors = new Map<string, number[]>();
    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
        const batch = toEmbed.slice(i, i + BATCH_SIZE);
        const batchVectors = await embedTexts(openai, batch.map((m) => m.embeddingText));
        batch.forEach((m, j) => {
            const vector = batchVectors[j];
            if (vector?.length !== EMBEDDING_DIMENSIONS) throw new Error(`Bad embedding for ${m._id}`);
            vectors.set(m._id, vector);
        });
        log(`  embedded ${Math.min(i + BATCH_SIZE, toEmbed.length)}/${toEmbed.length}`);
    }

    // Upsert every model so metadata (e.g. new years) stays current; only
    // newly embedded ones get their vector replaced.
    const ops: AnyBulkWriteOperation<CarDoc>[] = models.map((m) => {
        const vector = vectors.get(m._id);
        return {
            updateOne: {
                filter: { _id: m._id },
                update: {
                    $set: vector ? { ...m, embedding: vector, embeddingModel: EMBEDDING_MODEL } : m,
                    // $set never removes fields, so a dropped description is unset explicitly.
                    ...(!m.description && { $unset: { description: "" } }),
                },
                upsert: true,
            },
        };
    });
    if (ops.length) await cars.bulkWrite(ops);

    // Drop models that are no longer in the data.
    const removed = await cars.deleteMany({ _id: { $nin: models.map((m) => m._id) } });

    return {
        models: models.length,
        embedded: toEmbed.length,
        unchanged: models.length - toEmbed.length,
        removed: removed.deletedCount,
    };
}

// --- Vector index -----------------------------------------------------------

// `years` is a filter field so searches can pre-filter by model year.
export const indexDefinition = {
    fields: [
        { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
        { type: "filter", path: "years" },
    ],
};

// The driver types listSearchIndexes as `{ name }`; these are the fields we read.
type IndexField = { type?: string; path?: string; numDimensions?: number };
type SearchIndexInfo = {
    name: string;
    status?: string;
    queryable?: boolean;
    latestDefinition?: { fields?: IndexField[] };
};

async function getVectorIndex(cars: Collection<CarDoc>) {
    const [index] = (await cars.listSearchIndexes(CARS_VECTOR_INDEX).toArray()) as SearchIndexInfo[];
    return index;
}

// Does a stored definition have what we need? Compared field by field, since
// Mongo may add defaults to what it stores.
function isCurrent(fields: IndexField[] = []) {
    const vector = fields.find((f) => f.type === "vector" && f.path === "embedding");
    const years = fields.some((f) => f.type === "filter" && f.path === "years");
    return vector?.numDimensions === EMBEDDING_DIMENSIONS && years;
}

// Creates the index if missing, updates it if its definition is out of date,
// then waits until searches can use the current definition.
export async function ensureVectorIndex(cars: Collection<CarDoc>, { waitMs = 120_000, log = console.log } = {}) {
    const existing = await getVectorIndex(cars);
    if (!existing) {
        await cars.createSearchIndex({ name: CARS_VECTOR_INDEX, type: "vectorSearch", definition: indexDefinition });
        log(`Created vector index ${CARS_VECTOR_INDEX}`);
    } else if (!isCurrent(existing.latestDefinition?.fields)) {
        await cars.updateSearchIndex(CARS_VECTOR_INDEX, indexDefinition);
        log(`Updated vector index ${CARS_VECTOR_INDEX} (rebuilding)`);
    }

    // Index builds are async; searches fail (or use the old definition) until
    // the new one is ready.
    const deadline = Date.now() + waitMs;
    for (;;) {
        const index = await getVectorIndex(cars);
        if (index?.queryable && index.status === "READY" && isCurrent(index.latestDefinition?.fields)) return;
        if (Date.now() > deadline) {
            // Seen in practice: mongot (the search engine) pauses index builds when its
            // disk is over 85% full and only resumes below 80%.
            throw new Error(
                `Index ${CARS_VECTOR_INDEX} not queryable after ${waitMs / 1000}s (status: ${index?.status ?? "missing"}). `
                + `If the container logs say "Initial syncs are paused", mongot's disk is over 85% full; `
                + `use docker-compose.yml (it keeps mongot's index in RAM). See README troubleshooting.`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
