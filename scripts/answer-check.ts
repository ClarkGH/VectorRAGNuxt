// The answer check (docs/specs/generate.md, decision 7): runs eval/answer-check.json
// against the real catalog and the real model, and scores it.
// Usage:
//   pnpm answer-check --label first            about 11 chat calls (of 50 a day)
//   pnpm answer-check --label dry --mock       the fake answerer: no chat calls,
//                                              only embeddings; tests the runner
// Saves data/eval/answer-check-<label>.json and never overwrites a saved run: a
// failure is investigated, not re-run until it passes (decision 7).
// The cache is never read or written, so every model check really asks the model.
// Reads NUXT_MONGODB_URI and NUXT_OPENAI_KEY via Node's --env-file.
import { access, mkdir, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MongoClient, type Db } from "mongodb";
import OpenAI from "openai";
import {
    ANSWER_INSTRUCTIONS,
    ANSWER_MODEL,
    fakeAnswer,
    PROMPT_VERSION,
    validateAnswer,
    type AnswerCar,
    type CatalogCar,
} from "../server/utils/answer.ts";
import { loadCatalog, requestAnswer } from "../server/utils/answer-service.ts";
import { parseYearFilter, searchCars } from "../server/utils/search.ts";
import type { CarDoc } from "../shared/types/car.ts";
import { CARS_COLLECTION } from "../shared/utils/embedding.ts";
import {
    GATE_PARTS,
    leaksPrompt,
    MODEL_PARTS,
    scoreRun,
    type CheckSpec,
    type Observation,
    type Outcome,
} from "./lib/answer-check.ts";
import { errorMessage, writeAtomic } from "./lib/util.ts";

const ROOT = join(import.meta.dirname, "..");
const SPEC_FILE = join(ROOT, "eval", "answer-check.json");
const RUNS_DIR = join(ROOT, "data", "eval");
const SAFE_NAME = /^[\w.-]{1,64}$/;
const RESULTS = 5;
// gpt-5-mini allows 10 requests a minute on this account: one every 7 s stays clear.
const MODEL_GAP_MS = 7_000;

const { values: args } = parseArgs({
    options: { label: { type: "string" }, mock: { type: "boolean", default: false } },
});

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

const label = args.label ?? fail("pnpm answer-check needs --label <name>");
if (!SAFE_NAME.test(label)) fail(`Bad label "${label}": letters, numbers, dot, dash and underscore only.`);
const out = join(RUNS_DIR, `answer-check-${label}.json`);
try {
    await access(out);
    fail(`${out} already exists. Runs are never overwritten; pick a new --label.`);
} catch {
    // Doesn't exist yet: good.
}
const uri = process.env.NUXT_MONGODB_URI;
const key = process.env.NUXT_OPENAI_KEY;
if (!uri || !key) fail("Missing NUXT_MONGODB_URI or NUXT_OPENAI_KEY. Copy .env.example to .env and fill it in.");

const spec = JSON.parse(await readFile(SPEC_FILE, "utf8")) as CheckSpec;
const searchesOf = (part: string) => {
    const s = spec.parts.find((p) => p.part === part)?.searches;
    return Array.isArray(s) ? s : [];
};
// Checked before anything is spent: injection with no cars would test little.
const fixedIds = spec.parts.find((p) => p.part === "injection")?.fixedCars ?? [];
if (fixedIds.length !== RESULTS || new Set(fixedIds).size !== RESULTS) {
    fail(`eval/answer-check.json: injection needs ${RESULTS} distinct fixedCars, found ${fixedIds.length}.`);
}

const client = await new MongoClient(uri).connect();
// Embeddings may retry as usual; the chat call sets its own maxRetries: 0.
const openai = new OpenAI({ apiKey: key, maxRetries: 2, timeout: 30_000 });
const observations: Observation[] = [];
// Set when OpenAI says the day (or the credit) is used up: later model checks don't run.
let stopped: string | undefined;
let lastModelCall = 0;

// One model check: the model (or the mock), validated, leak-checked.
async function ask(query: string, cars: AnswerCar[], catalog: CatalogCar[]): Promise<[Outcome, string?]> {
    if (stopped) return [{ kind: "not-run", why: stopped }];
    let reply;
    if (args.mock) {
        reply = fakeAnswer(query, cars);
    } else {
        const wait = lastModelCall + MODEL_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastModelCall = Date.now();
        try {
            const asked = await requestAnswer(openai, query, parseYearFilter(query).years, cars);
            if (asked.kind !== "reply") {
                if (asked.kind !== "minute-limit") stopped = asked.kind;
                return [{ kind: "not-run", why: asked.kind }];
            }
            reply = asked.reply;
        } catch (err) {
            return [{ kind: "not-run", why: errorMessage(err) }];
        }
    }
    const check = validateAnswer(reply, cars, catalog);
    if (!check.ok) return [{ kind: "dropped", reason: check.reason }, reply.output_text];
    const leak = leaksPrompt(check.answer.picks.map((p) => p.reason), ANSWER_INSTRUCTIONS);
    return [{ kind: "answer", answer: check.answer, leak }, reply.output_text];
}

async function fixedCars(db: Db, ids: string[]): Promise<AnswerCar[]> {
    const found = await db.collection<CarDoc>(CARS_COLLECTION).find({ _id: { $in: ids } }).toArray();
    const cars = ids.map((id) => found.find((car) => car._id === id));
    if (!cars.every((car) => car !== undefined)) fail(`Injection cars missing from the catalog: ${ids.join(", ")}`);
    return cars as AnswerCar[];
}

try {
    const db = client.db();
    const catalog = await loadCatalog(db);
    console.log(`Answer check "${label}"${args.mock ? " (mock: no chat calls)" : ""}, rules v${spec.version} (${spec.writtenAt})`);

    // Search parts: search like the app, then the gate, then (model parts) the model.
    // A failed search is recorded as not run rather than ending the script, so
    // the chat calls already spent are always saved (the run is then incomplete).
    for (const part of [...GATE_PARTS, "refuses", "doesnt-refuse"] as const) {
        for (const query of searchesOf(part)) {
            let results;
            try {
                results = await searchCars(db, openai, parseYearFilter(query), RESULTS);
            } catch (err) {
                observations.push({ part, query, outcome: { kind: "not-run", why: `search failed: ${errorMessage(err)}` } });
                console.log(`  ${part.padEnd(22)} error  ${query}`);
                continue;
            }
            const topScore = results[0]?.score ?? 0;
            let outcome: Outcome = { kind: "scored" };
            let replyText: string | undefined;
            if (MODEL_PARTS.includes(part)) {
                if (topScore < spec.gateThreshold) outcome = { kind: "gated" };
                else [outcome, replyText] = await ask(query, results, catalog);
            }
            observations.push({ part, query, topScore, outcome, ...(replyText ? { replyText } : {}) });
            console.log(`  ${part.padEnd(22)} ${topScore.toFixed(3)}  ${query}`);
        }
    }

    // Injection: straight to the model with the fixed cars (no search, no gate).
    let cars: AnswerCar[] | undefined;
    let carsError = "";
    try {
        cars = await fixedCars(db, fixedIds);
    } catch (err) {
        carsError = `loading the fixed cars failed: ${errorMessage(err)}`;
    }
    for (const query of searchesOf("injection")) {
        const [outcome, replyText]: [Outcome, string?] = cars
            ? await ask(query, cars, catalog)
            : [{ kind: "not-run", why: carsError }];
        observations.push({ part: "injection", query, outcome, ...(replyText ? { replyText } : {}) });
        console.log(`  ${"injection".padEnd(22)}   -    ${query}`);
    }
} finally {
    await client.close();
}

const score = scoreRun(spec, observations);
await mkdir(RUNS_DIR, { recursive: true });
await writeAtomic(
    out,
    JSON.stringify(
        {
            label,
            ranAt: new Date().toISOString(),
            mock: args.mock,
            model: ANSWER_MODEL,
            promptVersion: PROMPT_VERSION,
            rulesVersion: spec.version,
            score,
        },
        null,
        2,
    ),
);

console.log("\nResults");
for (const v of score.verdicts) console.log(`  ${v.pass ? "pass" : "FAIL"}  ${v.part.padEnd(22)} ${v.query}: ${v.why}`);
console.log("\nParts");
for (const p of score.parts) console.log(`  ${p.pass ? "pass" : "FAIL"}  ${p.title}: ${p.passed}/${p.total}`);
console.log(
    `\n${!score.complete ? "INCOMPLETE: some model checks didn't run; this run is not a result." : score.pass ? "PASS: 100% of every part." : "FAIL: investigate each failure and log it in docs/evaluation.md. Don't re-run to change the outcome."}`,
);
if (args.mock) console.log("Mock run: tests the runner, not the model. Its model parts mean nothing.");
console.log(`Saved ${out}`);
if (!score.pass) process.exitCode = 1;
