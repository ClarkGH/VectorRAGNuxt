// Relevance check: real searches against the real ingested database and real embeddings.
// Run by hand with `pnpm test:relevance` (needs `docker compose up -d`, `pnpm ingest`, and the key in .env).
// Not part of `pnpm check` or CI. One embeddings call per query, 8 in all.
//
// Checks fail the run. Watches only print, for known weak spots, so they can be seen
// improving without blocking anything. Plan and query choices: docs/tech-debt.md (#3).
import { MongoClient, type Db } from "mongodb";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseYearFilter, searchCars } from "../../server/utils/search.ts";
import type { SearchResult } from "../../shared/types/car.ts";
import { formatYears } from "../../shared/utils/years.ts";

const uri = process.env.NUXT_MONGODB_URI;
const key = process.env.NUXT_OPENAI_KEY;
const ready = Boolean(uri && key);
if (!ready) console.warn("Skipping the relevance check: NUXT_MONGODB_URI and NUXT_OPENAI_KEY must be set (.env).");

const TOP = 5;
const name = (car: SearchResult) => `${car.make} ${car.model}`;
const rank = (results: SearchResult[], make: string, model: string) =>
    results.findIndex((car) => car.make === make && car.model === model);

describe.skipIf(!ready)("relevance (real embeddings)", () => {
    let client: MongoClient;
    let db: Db;
    let openai: OpenAI;
    const report: string[] = [];

    // Searches, and records the top results for the printout.
    async function search(query: string, kind: "check" | "watch") {
        const results = await searchCars(db, openai, parseYearFilter(query), TOP);
        report.push(
            `${kind === "check" ? "CHECK" : "WATCH"}  "${query}"`,
            ...results.map(
                (car, i) =>
                    `  ${i + 1}. ${(car.score * 100).toFixed(1)}%  ${name(car)}  (${formatYears(car.years)})`,
            ),
            ...(results.length ? [] : ["  (no results)"]),
        );
        return results;
    }

    beforeAll(async () => {
        client = await new MongoClient(uri!).connect();
        db = client.db();
        openai = new OpenAI({ apiKey: key, maxRetries: 2, timeout: 15_000 });
    });

    afterAll(async () => {
        await client?.close();
        // The table is the point: compare it before and after a change to the embedding text or model.
        console.log(`\nTop ${TOP} per query\n\n${report.join("\n")}\n`);
    });

    describe("checks", () => {
        it("exact name: \"honda civic\" puts the Civic first", async () => {
            const results = await search("honda civic", "check");
            expect(results[0] && name(results[0])).toBe("HONDA Civic");
        });

        it("a trim that's its own model: \"civic type r\" ranks the Type R above the Civic", async () => {
            const results = await search("civic type r", "check");
            const typeR = rank(results, "HONDA", "Civic Type R");
            const civic = rank(results, "HONDA", "Civic");
            expect(typeR).toBeGreaterThanOrEqual(0);
            if (civic >= 0) expect(typeR).toBeLessThan(civic);
        });

        it("single-year filter: \"2018 accord\" puts the Accord first, all sold in 2016-2020", async () => {
            const results = await search("2018 accord", "check");
            expect(results[0] && name(results[0])).toBe("HONDA Accord");
            for (const car of results) {
                expect(car.years.some((year) => year >= 2016 && year <= 2020), name(car)).toBe(true);
            }
        });

        it("a year inside a name: \"1955 Custom Belair\" isn't filtered, and the kit car is found", async () => {
            expect(parseYearFilter("1955 Custom Belair").years).toBeNull();
            const results = await search("1955 Custom Belair", "check");
            expect(results.map((car) => car.model)).toContain("1955 Custom Belair");
        });

        it("make plus a vague size: \"small honda\" returns mostly Hondas", async () => {
            const results = await search("small honda", "check");
            expect(results.filter((car) => car.make === "HONDA").length).toBeGreaterThanOrEqual(4);
        });
    });

    // Known weak spots: printed, never failed.
    describe("watches", () => {
        it.each([
            "medium sedan", // body style only, no make (an SL-Class roadster ranked second on 2026-11-11)
            "pickup truck", // outside the catalog: passenger cars only
            "asdf qwerty", // nonsense
        ])("%s", async (query) => {
            await search(query, "watch");
        });
    });
}, 30_000);
