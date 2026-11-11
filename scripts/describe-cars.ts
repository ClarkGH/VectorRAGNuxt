// Writes a short AI description per car model into data/descriptions.json, so
// `pnpm ingest` can embed meaning ("compact sedan, affordable") along with the name.
// Usage: pnpm describe [--limit 20] [--fresh]
//   --limit N  only describe N more models (to try it out cheaply)
//   --fresh    rewrite every description
// Resumable: only missing descriptions (or ones from another model) are written,
// and progress is saved as it goes. Reads NUXT_OPENAI_KEY via Node's --env-file.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import type { CarsFile } from "../shared/types/car.ts";
import {
    DESCRIBE_MODEL,
    DESCRIBED_BY,
    DESCRIBE_BATCH_SIZE,
    describeCars,
    needsDescription,
    type DescriptionsFile,
} from "./lib/describe.ts";
import { groupModels } from "./lib/ingest.ts";
import { errorMessage, pool, writeAtomic } from "./lib/util.ts";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const CARS_FILE = join(DATA_DIR, "cars.json");
const DESCRIPTIONS_FILE = join(DATA_DIR, "descriptions.json");
// Two batches in flight: the SDK waits out 429s (rate limits) between retries.
const CONCURRENCY = 2;

const { values: args } = parseArgs({
    options: {
        limit: { type: "string" },
        fresh: { type: "boolean", default: false },
    },
});
const limit = args.limit === undefined ? Infinity : Number(args.limit);
if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) {
    console.error(`Bad --limit: ${args.limit}`);
    process.exit(1);
}

const openaiKey = process.env.NUXT_OPENAI_KEY;
if (!openaiKey) {
    console.error("Missing NUXT_OPENAI_KEY. Copy .env.example to .env and fill it in.");
    process.exit(1);
}

const cars = JSON.parse(await readFile(CARS_FILE, "utf8")) as CarsFile;
const models = groupModels(cars.cars);

let file: DescriptionsFile = { generatedAt: "", descriptions: {} };
if (!args.fresh) {
    try {
        file = JSON.parse(await readFile(DESCRIPTIONS_FILE, "utf8")) as DescriptionsFile;
    } catch {
        // No file yet: start empty.
    }
}

const todo = models.filter((m) => args.fresh || needsDescription(file.descriptions[m._id])).slice(0, limit);
console.log(`${models.length} models, ${todo.length} to describe with ${DESCRIBE_MODEL}`);

// Saves are chained so two workers never write the same temp file at once.
let saving = Promise.resolve();
function save() {
    saving = saving.then(() => {
        file.generatedAt = new Date().toISOString();
        return writeAtomic(DESCRIPTIONS_FILE, JSON.stringify(file, null, 2));
    });
    return saving;
}

const openai = new OpenAI({ apiKey: openaiKey, maxRetries: 3, timeout: 120_000 });
const failed: string[] = [];
// Set when OpenAI says the daily request quota is used up: retrying can't
// help until it resets, and every attempt counts against it.
let dailyLimitHit: string | undefined;

const batches: (typeof todo)[] = [];
for (let i = 0; i < todo.length; i += DESCRIBE_BATCH_SIZE) batches.push(todo.slice(i, i + DESCRIBE_BATCH_SIZE));

await pool(
    batches,
    CONCURRENCY,
    async (batch) => {
        if (dailyLimitHit) {
            failed.push(`${batch.length} cars from ${batch[0]?.make} ${batch[0]?.model}: skipped (daily limit)`);
            return;
        }
        try {
            const descriptions = await describeCars(openai, batch);
            for (const m of batch) {
                const description = descriptions.get(m._id);
                if (description) {
                    file.descriptions[m._id] = { make: m.make, model: m.model, description, describedBy: DESCRIBED_BY };
                } else {
                    failed.push(`${m.make} ${m.model}: missing or failed the description checks`);
                }
            }
        } catch (err) {
            if (err instanceof OpenAI.RateLimitError && /per day/i.test(err.message)) dailyLimitHit = err.message;
            failed.push(`${batch.length} cars from ${batch[0]?.make} ${batch[0]?.model}: ${errorMessage(err)}`);
        }
        // Save after every batch, so an interrupted run loses at most one batch per worker.
        void save();
    },
    (done) => process.stdout.write(`\r  ${done}/${batches.length} batches`),
);
process.stdout.write("\n");
await save();

const total = Object.keys(file.descriptions).length;
console.log(`data/descriptions.json: ${total}/${models.length} models described. Run pnpm ingest to use them.`);
if (dailyLimitHit) {
    console.error(
        `Stopped: the OpenAI account's daily request limit for ${DESCRIBE_MODEL} is used up. `
        + `Re-run once it resets; finished descriptions are saved.\n  ${dailyLimitHit}`,
    );
    process.exitCode = 1;
} else if (failed.length) {
    console.error(`${failed.length} failed (re-run to retry):\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
}
