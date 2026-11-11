// Scrapes car makes/models/years from the NHTSA vPIC API into data/cars.json.
// Usage: pnpm scrape [--from 2016] [--to 2026] [--makes honda,toyota] [--fresh]
//
// The flags choose what to *fetch*. cars.json is always rebuilt from everything
// in data/.cache, so a partial run adds to the data instead of replacing it.
// Delete data/.cache to start over.
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CarsFile } from "../shared/types/car.ts";
import {
    carsFromModelLists,
    modelCacheName,
    parseModelCacheName,
    type Make,
    type Model,
    type VpicResponse,
} from "./lib/scrape.ts";
import { errorMessage, pool, writeAtomic } from "./lib/util.ts";

const API = "https://vpic.nhtsa.dot.gov/api/vehicles";
const DATA_DIR = join(import.meta.dirname, "..", "data");
const CACHE_DIR = join(DATA_DIR, ".cache");
const OUT_FILE = join(DATA_DIR, "cars.json");
const CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;
const FETCH_TIMEOUT_MS = 15_000;

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

async function fetchJson<T>(url: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            // A stalled request throws a TimeoutError, which retries like a network error.
            const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

// --- Scrape ---------------------------------------------------------------

await mkdir(CACHE_DIR, { recursive: true });

let makes = await cachedResults<Make>("makes", `${API}/GetMakesForVehicleType/car?format=json`);
// MakeId ends up in cache file paths, so don't trust it to be a number (S8;
// modelCacheName also refuses non-integers).
makes = makes.filter((m) => Number.isInteger(m.MakeId));
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

await pool(
    jobs,
    CONCURRENCY,
    async ({ make, year }) => {
        const url = `${API}/GetModelsForMakeIdYear/makeId/${make.MakeId}/modelyear/${year}/vehicletype/car?format=json`;
        try {
            await cachedResults<Model>(modelCacheName(make.MakeId, year), url);
        } catch (err) {
            failed.push(`${make.MakeName} ${year}: ${errorMessage(err)}`);
        }
    },
    (done) => {
        if (done % 100 === 0 || done === jobs.length) process.stdout.write(`\r  ${done}/${jobs.length} requests`);
    },
);
process.stdout.write("\n");

// --- Output: rebuild cars.json from the whole cache -------------------------

const lists: { year: number; models: Model[] }[] = [];
for (const fileName of await readdir(CACHE_DIR)) {
    const parsed = parseModelCacheName(fileName);
    if (!parsed) continue;
    try {
        lists.push({ year: parsed.year, models: JSON.parse(await readFile(join(CACHE_DIR, fileName), "utf8")) as Model[] });
    } catch {
        console.warn(`Skipping unreadable cache file ${fileName}`);
    }
}
const sorted = carsFromModelLists(lists);
const years = sorted.map((c) => c.year);

const output: CarsFile = {
    source: "NHTSA vPIC",
    scrapedAt: new Date().toISOString(),
    years: years.length ? [Math.min(...years), Math.max(...years)] : [fromYear, toYear],
    cars: sorted,
};
await writeAtomic(OUT_FILE, JSON.stringify(output, null, 2));

const makesKept = new Set(sorted.map((c) => c.makeId)).size;
console.log(`Makes queried: ${makes.length}. cars.json (whole cache): ${makesKept} makes, ${sorted.length} cars`);
console.log(`Requests fetched: ${stats.fetched}, from cache: ${stats.cached}`);
if (failed.length) {
    console.error(`${failed.length} requests failed:\n  ${failed.join("\n  ")}`);
    process.exitCode = 1;
}
