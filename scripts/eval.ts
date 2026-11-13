// Scores search quality against eval/golden.json, and compares runs (docs/evaluation.md).
// Usage:
//   pnpm eval run --label described [--db vector_rag_names]
//   pnpm eval compare names-only described      (baseline first)
// A run makes one embeddings call per search (~24, a fraction of a cent) and saves
// data/eval/<label>.json. Reads NUXT_MONGODB_URI and NUXT_OPENAI_KEY via Node's --env-file.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MongoClient } from "mongodb";
import OpenAI from "openai";
import { parseYearFilter, searchCars } from "../server/utils/search.ts";
import { EMBEDDING_MODEL } from "../shared/utils/embedding.ts";
import {
    compareRuns,
    isLabeled,
    K,
    mean,
    RULES,
    scoreQuery,
    type EvalRun,
    type GoldenSet,
    type QueryScore,
} from "./lib/eval.ts";
import { writeAtomic } from "./lib/util.ts";

const ROOT = join(import.meta.dirname, "..");
const GOLDEN_FILE = join(ROOT, "eval", "golden.json");
const RUNS_DIR = join(ROOT, "data", "eval");
// Labels and database names become file paths and DB names: keep them plain (like S8).
const SAFE_NAME = /^[\w.-]{1,64}$/;

const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: { label: { type: "string" }, db: { type: "string" } },
});
const [command, ...rest] = positionals;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

const runPath = (label: string) => {
    if (!SAFE_NAME.test(label)) fail(`Bad label "${label}": letters, numbers, dot, dash and underscore only.`);
    return join(RUNS_DIR, `${label}.json`);
};

const KINDS = ["exact", "trim", "year", "concept"] as const;
const pct = (x: number) => x.toFixed(2);

function printRun(run: EvalRun) {
    const labeled = run.queries.filter(isLabeled);
    console.log(`\n${run.label} (db ${run.db}, ${run.embeddingModel}, ${run.ranAt})`);
    console.log("kind       n   nDCG@5  Hit@1   MRR   Recall@5");
    for (const kind of [...KINDS, "all"] as const) {
        const rows = kind === "all" ? labeled : labeled.filter((s) => s.kind === kind);
        if (!rows.length) continue;
        const m = (f: (s: (typeof rows)[number]) => number) => pct(mean(rows.map(f)));
        console.log(
            `${kind.padEnd(9)} ${String(rows.length).padStart(2)}   ${m((s) => s.ndcg)}    ${m((s) => s.hit1)}    ${m((s) => s.rr)}   ${m((s) => s.recall)}`,
        );
    }
    // Floor check: nonsense and out-of-catalog searches should score clearly lower.
    const floors = run.queries.filter((s) => s.kind === "floor");
    if (floors.length) {
        console.log(`\nTop score of the first result: labeled searches average ${pct(mean(run.labeledTopScores))}`);
        for (const s of floors) console.log(`  "${s.query}": ${pct(s.topScore)}`);
    }
    if (run.unreviewed) console.log(`\nNote: ${run.unreviewed} golden-set entries are still drafts (reviewed: false).`);
}

async function run() {
    const label = args.label ?? fail("pnpm eval run needs --label <name>");
    const out = runPath(label);
    if (args.db && !SAFE_NAME.test(args.db)) fail(`Bad --db "${args.db}"`);
    const uri = process.env.NUXT_MONGODB_URI;
    const key = process.env.NUXT_OPENAI_KEY;
    if (!uri || !key) fail("Missing NUXT_MONGODB_URI or NUXT_OPENAI_KEY. Copy .env.example to .env and fill it in.");

    const golden = JSON.parse(await readFile(GOLDEN_FILE, "utf8")) as GoldenSet;
    const client = await new MongoClient(uri).connect();
    const openai = new OpenAI({ apiKey: key, maxRetries: 3, timeout: 30_000 });
    try {
        const db = args.db ? client.db(args.db) : client.db();
        const queries: QueryScore[] = [];
        const labeledTopScores: number[] = [];
        for (const q of golden.queries) {
            const results = await searchCars(db, openai, parseYearFilter(q.query), K);
            const score = scoreQuery(q, results.map((r) => r._id), results.map((r) => r.score));
            queries.push(score);
            if (isLabeled(score)) labeledTopScores.push(results[0]?.score ?? 0);
        }
        const result: EvalRun = {
            label,
            db: db.databaseName,
            ranAt: new Date().toISOString(),
            embeddingModel: EMBEDDING_MODEL,
            unreviewed: golden.queries.filter((q) => !q.reviewed).length,
            labeledTopScores,
            queries,
        };
        await mkdir(RUNS_DIR, { recursive: true });
        await writeAtomic(out, JSON.stringify(result, null, 2));
        printRun(result);
        console.log(`\nSaved ${out}`);
    } finally {
        await client.close();
    }
}

async function compare() {
    const [baseLabel, newLabel] = rest;
    if (!baseLabel || !newLabel) fail("pnpm eval compare <baseline-label> <new-label>");
    const load = async (label: string) => {
        try {
            return JSON.parse(await readFile(runPath(label), "utf8")) as EvalRun;
        } catch {
            return fail(`No saved run "${label}". Run: pnpm eval run --label ${label}`);
        }
    };
    const a = await load(baseLabel);
    const b = await load(newLabel);
    printRun(a);
    printRun(b);

    const c = compareRuns(a, b);
    const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
    console.log(`\n${newLabel} vs ${baseLabel}, ${c.paired} searches in both`);
    console.log(`  nDCG@5 change: ${sign(c.delta)}, 95% interval ${sign(c.ci[0])} to ${sign(c.ci[1])}`);
    console.log(`  Guardrail (exact car at #1 on exact searches, drop max ${RULES.guardrail.maxHit1Drop}): ${pct(c.guardrailDrop)}`);
    console.log(`  ${c.call}: ${c.reason}`);
}

if (command === "run") await run();
else if (command === "compare") await compare();
else fail("Usage: pnpm eval run --label <name> [--db <database>] | pnpm eval compare <baseline> <new>");
