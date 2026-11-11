// Loads data/cars.json into Mongo: one doc per make+model, with an embedding,
// plus the vector search index. Safe to re-run: unchanged models aren't re-embedded.
// Usage: pnpm ingest (reads NUXT_MONGODB_URI and NUXT_OPENAI_KEY via Node's --env-file)
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import type { CarDoc, CarsFile } from "../shared/types/car.ts";
import { CARS_COLLECTION, CARS_VECTOR_INDEX } from "../shared/utils/embedding.ts";
import { descriptionMap, type DescriptionsFile } from "./lib/describe.ts";
import { ensureVectorIndex, groupModels, ingestModels } from "./lib/ingest.ts";

const CARS_FILE = join(import.meta.dirname, "..", "data", "cars.json");
const DESCRIPTIONS_FILE = join(import.meta.dirname, "..", "data", "descriptions.json");

const mongoUri = process.env.NUXT_MONGODB_URI;
const openaiKey = process.env.NUXT_OPENAI_KEY;
const missing = [!mongoUri && "NUXT_MONGODB_URI", !openaiKey && "NUXT_OPENAI_KEY"].filter(Boolean);
if (!mongoUri || !openaiKey) {
    console.error(`Missing ${missing.join(" and ")}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
}

const file = JSON.parse(await readFile(CARS_FILE, "utf8")) as CarsFile;

let descriptionsFile: DescriptionsFile | undefined;
try {
    descriptionsFile = JSON.parse(await readFile(DESCRIPTIONS_FILE, "utf8")) as DescriptionsFile;
} catch {
    // Optional: without it, models are embedded by name only.
}
const models = groupModels(file.cars, descriptionMap(descriptionsFile));
const described = models.filter((m) => m.description).length;
console.log(`${file.cars.length} rows -> ${models.length} models, ${described} with descriptions`);
if (described < models.length) console.log("  (pnpm describe writes the missing descriptions)");

const client = new MongoClient(mongoUri);
const openai = new OpenAI({ apiKey: openaiKey, maxRetries: 4, timeout: 60_000 });

try {
    await client.connect();
    const cars = client.db().collection<CarDoc>(CARS_COLLECTION);
    const summary = await ingestModels(cars, openai, models);
    await ensureVectorIndex(cars);
    console.log(
        `Models: ${summary.models}, embedded: ${summary.embedded}, unchanged: ${summary.unchanged}, `
        + `removed: ${summary.removed}. Index ${CARS_VECTOR_INDEX} is queryable.`,
    );
} finally {
    await client.close();
}
