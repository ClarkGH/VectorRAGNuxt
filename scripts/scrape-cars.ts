// Scrapes car makes/models/years from the NHTSA vPIC API into data/cars.json.
// Usage: pnpm scrape [--from 2016] [--to 2026] [--makes honda,toyota] [--fresh]
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const API = "https://vpic.nhtsa.dot.gov/api/vehicles";
const DATA_DIR = join(import.meta.dirname, "..", "data");
const CACHE_DIR = join(DATA_DIR, ".cache");
const OUT_FILE = join(DATA_DIR, "cars.json");
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;

// --- vPIC response shapes -------------------------------------------------

type VpicResponse<T> = { Count: number; Message: string; Results: T[] };
type Make = { MakeId: number; MakeName: string };
type Model = { Make_ID: number; Make_Name: string; Model_ID: number; Model_Name: string };

export type Car = { make: string; makeId: number; model: string; modelId: number; year: number };

export type CarsFile = {
    source: string;
    scrapedAt: string;
    years: [from: number, to: number];
    cars: Car[];
};

// --- Args -----------------------------------------------------------------

const thisYear = new Date().getFullYear();
const { values: args } = parseArgs({
    options: {
        from: { type: "string", default: String(thisYear - 10) },
        to: { type: "string", default: String(thisYear) },
        makes: { type: "string" },
        fresh: { type: "boolean", default: false },
    },
});

const fromYear = Number(args.from);
const toYear = Number(args.to);
if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    console.error(`Bad year range: --from ${args.from} --to ${args.to}`);
    process.exit(1);
}

// --- Fetching and caching -------------------------------------------------

class HttpError extends Error {
    status: number;

    constructor(status: number) {
        super(`HTTP ${status}`);
        this.status = status;
    }

    // Server errors and rate limiting can clear up; other 4xx won't.
    get retryable() {
        return this.status >= 500 || this.status === 429;
    }
}

const stats = { fetched: 0, cached: 0 };
const failed: string[] = [];

function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
}

async function writeAtomic(path: string, data: string) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
}

async function fetchJson<T>(url: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new HttpError(res.status);
            return (await res.json()) as T;
        } catch (err) {
            const retryable = !(err instanceof HttpError) || err.retryable;
            if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
    }
}

// Returns the vPIC Results array, from cache if present.
async function cachedResults<T>(cacheName: string, url: string): Promise<T[]> {
    const cacheFile = join(CACHE_DIR, `${cacheName}.json`);
    if (!args.fresh) {
        try {
            const results = JSON.parse(await readFile(cacheFile, "utf8")) as T[];
            stats.cached++;
            return results;
        } catch {
            // Missing or corrupt cache entry: fall through and fetch.
        }
    }
    const body = await fetchJson<VpicResponse<T>>(url);
    await writeAtomic(cacheFile, JSON.stringify(body.Results));
    stats.fetched++;
    return body.Results;
}

// Runs worker over items with CONCURRENCY in flight. The workers share one
// iterator, so each item is taken exactly once.
async function pool<T>(items: T[], worker: (item: T) => Promise<void>) {
    const queue = items.values();
    let done = 0;
    const runners = Array.from({ length: CONCURRENCY }, async () => {
        for (const item of queue) {
            await worker(item);
            done++;
            if (done % 100 === 0 || done === items.length) {
                process.stdout.write(`\r  ${done}/${items.length} requests`);
            }
        }
    });
    await Promise.all(runners);
    process.stdout.write("\n");
}

// --- Scrape ---------------------------------------------------------------

await mkdir(CACHE_DIR, { recursive: true });

let makes = await cachedResults<Make>("makes", `${API}/GetMakesForVehicleType/car?format=json`);
if (args.makes) {
    const wanted = new Set(args.makes.split(",").map((m) => m.trim().toLowerCase()));
    makes = makes.filter((m) => wanted.has(m.MakeName.toLowerCase()));
    const found = new Set(makes.map((m) => m.MakeName.toLowerCase()));
    const missing = [...wanted].filter((m) => !found.has(m));
    if (missing.length) console.warn(`Warning: no vPIC car make named ${missing.join(", ")}`);
}
console.log(`${makes.length} makes, years ${fromYear}-${toYear}`);

const jobs: { make: Make; year: number }[] = [];
for (const make of makes) {
    for (let year = fromYear; year <= toYear; year++) jobs.push({ make, year });
}

const cars = new Map<string, Car>();
await pool(jobs, async ({ make, year }) => {
    const url = `${API}/GetModelsForMakeIdYear/makeId/${make.MakeId}/modelyear/${year}/vehicletype/car?format=json`;
    try {
        const models = await cachedResults<Model>(`${make.MakeId}-${year}`, url);
        for (const m of models) {
            cars.set(`${m.Make_ID}-${m.Model_ID}-${year}`, {
                make: m.Make_Name.trim(),
                makeId: m.Make_ID,
                model: m.Model_Name.trim(),
                modelId: m.Model_ID,
                year,
            });
        }
    } catch (err) {
        failed.push(`${make.MakeName} ${year}: ${errorMessage(err)}`);
    }
});

// --- Output ---------------------------------------------------------------

const sorted = [...cars.values()].sort(
    (a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model) || a.year - b.year,
);

const output: CarsFile = {
    source: "NHTSA vPIC",
    scrapedAt: new Date().toISOString(),
    years: [fromYear, toYear],
    cars: sorted,
};
await writeAtomic(OUT_FILE, JSON.stringify(output, null, 2));

const makesKept = new Set(sorted.map((c) => c.makeId)).size;
console.log(`Makes queried: ${makes.length}, makes kept: ${makesKept}, cars: ${sorted.length}`);
console.log(`Requests fetched: ${stats.fetched}, from cache: ${stats.cached}`);
if (failed.length) {
    console.error(`${failed.length} requests failed:\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
}
