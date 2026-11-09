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

type Make = { MakeId: number; MakeName: string };
type Model = { Make_ID: number; Make_Name: string; Model_ID: number; Model_Name: string };
type Car = { make: string; makeId: number; model: string; modelId: number; year: number };

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

const stats = { fetched: 0, cached: 0, failed: [] as string[] };

async function writeAtomic(path: string, data: string) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
}

async function fetchJson(url: string) {
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url);
            if (res.ok) return await res.json();
            // 4xx other than rate limiting won't get better on retry.
            if (res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
            throw new Error(`HTTP ${res.status}`);
        } catch (err: any) {
            if (err.fatal || attempt >= MAX_ATTEMPTS) throw err;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
    }
}

// Returns the vPIC Results array, from cache if present.
async function cachedResults<T>(cacheName: string, url: string): Promise<T[]> {
    const cacheFile = join(CACHE_DIR, `${cacheName}.json`);
    if (!args.fresh) {
        try {
            const results = JSON.parse(await readFile(cacheFile, "utf8"));
            stats.cached++;
            return results;
        } catch {
            // Missing or corrupt cache entry: fall through and fetch.
        }
    }
    const body = await fetchJson(url);
    await writeAtomic(cacheFile, JSON.stringify(body.Results));
    stats.fetched++;
    return body.Results;
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>) {
    let next = 0;
    let done = 0;
    const runners = Array.from({ length: CONCURRENCY }, async () => {
        while (next < items.length) {
            await worker(items[next++]);
            done++;
            if (done % 100 === 0 || done === items.length) {
                process.stdout.write(`\r  ${done}/${items.length} requests`);
            }
        }
    });
    await Promise.all(runners);
    process.stdout.write("\n");
}

await mkdir(CACHE_DIR, { recursive: true });

let makes = await cachedResults<Make>("makes", `${API}/GetMakesForVehicleType/car?format=json`);
if (args.makes) {
    const wanted = new Set(args.makes.split(",").map((m) => m.trim().toLowerCase()));
    makes = makes.filter((m) => wanted.has(m.MakeName.toLowerCase()));
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
    } catch (err: any) {
        stats.failed.push(`${make.MakeName} ${year}: ${err.message}`);
    }
});

const sorted = [...cars.values()].sort(
    (a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model) || a.year - b.year,
);

await writeAtomic(
    OUT_FILE,
    JSON.stringify({ source: "NHTSA vPIC", scrapedAt: new Date().toISOString(), years: [fromYear, toYear], cars: sorted }, null, 2),
);

const makesKept = new Set(sorted.map((c) => c.makeId)).size;
console.log(`Makes queried: ${makes.length}, makes kept: ${makesKept}, cars: ${sorted.length}`);
console.log(`Requests fetched: ${stats.fetched}, from cache: ${stats.cached}`);
if (stats.failed.length) {
    console.error(`${stats.failed.length} requests failed:\n  ${stats.failed.join("\n  ")}`);
    process.exit(1);
}
