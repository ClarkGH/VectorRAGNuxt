// End to end against a real Mongo + mongot, with a stand-in OpenAI (no key).
// Needs `docker compose up -d`. Uses a throwaway database, dropped afterwards.
// Override the server with TEST_MONGODB_URI.
import { MongoClient, type Collection, type Db } from "mongodb";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureVectorIndex, groupModels, ingestModels } from "../../scripts/lib/ingest.ts";
import { parseYearFilter, searchCars } from "../../server/utils/search.ts";
import type { Car, CarDoc } from "../../shared/types/car.ts";
import { CARS_COLLECTION, CARS_VECTOR_INDEX, EMBEDDING_DIMENSIONS } from "../../shared/utils/embedding.ts";
import { fakeVector, startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai.ts";

const uri = process.env.TEST_MONGODB_URI ?? "mongodb://localhost:27017/?directConnection=true";

const row = (make: string, makeId: number, model: string, modelId: number, year: number): Car => ({
    make,
    makeId,
    model,
    modelId,
    year,
});
const rows: Car[] = [
    row("HONDA", 474, "Civic", 1863, 2019),
    row("HONDA", 474, "Civic", 1863, 2020),
    row("HONDA", 474, "Civic Type R", 31535, 2020),
    row("HONDA", 474, "Accord", 1861, 2020),
    row("HONDA", 474, "Prelude", 1870, 2001),
    row("BMW", 452, "M3", 2084, 2020),
    row("BMW", 452, "M8", 25916, 2020),
    row("TOYOTA", 448, "Corolla", 2208, 2020),
];

describe("ingest + vector search", () => {
    let client: MongoClient;
    let db: Db;
    let cars: Collection<CarDoc>;
    let fake: FakeOpenAI;
    let openai: OpenAI;
    const quiet = () => {};
    const search = (query: string, limit: number) => searchCars(db, openai, parseYearFilter(query), limit);

    beforeAll(async () => {
        fake = await startFakeOpenAI();
        openai = new OpenAI({ apiKey: "test", baseURL: fake.baseURL, maxRetries: 0 });
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        db = client.db(`vectorrag_test_${Date.now()}`);
        cars = db.collection<CarDoc>(CARS_COLLECTION);
    });

    afterAll(async () => {
        await db?.dropDatabase();
        await client?.close();
        await fake?.close();
    });

    it("ingests one doc per model and builds a queryable index", async () => {
        const summary = await ingestModels(cars, openai, groupModels(rows), quiet);
        expect(summary).toEqual({ models: 7, embedded: 7, unchanged: 0, removed: 0 });
        await ensureVectorIndex(cars, { waitMs: 60_000, log: quiet });

        const civic = await cars.findOne({ _id: "474-1863" });
        expect(civic?.years).toEqual([2019, 2020]);
        expect(civic?.embedding).toHaveLength(1536);
    }, 90_000);

    it("re-running embeds nothing new", async () => {
        const callsBefore = fake.calls();
        const summary = await ingestModels(cars, openai, groupModels(rows), quiet);
        expect(summary).toMatchObject({ embedded: 0, unchanged: 7 });
        expect(fake.calls()).toBe(callsBefore);
    });

    it("ranks the closest car first", async () => {
        const [first] = await search("honda civic", 3);
        expect(`${first?.make} ${first?.model}`).toBe("HONDA Civic");

        const typeR = await search("civic type r", 3);
        expect(typeR.map((r) => r.model).slice(0, 2)).toEqual(["Civic Type R", "Civic"]);
    });

    it("never returns server-only fields, and scores are in [0, 1]", async () => {
        const results = await search("bmw", 5);
        expect(results.length).toBeGreaterThan(0);
        for (const r of results) {
            expect(r).not.toHaveProperty("embedding");
            expect(r).not.toHaveProperty("embeddingModel");
            expect(r.score).toBeGreaterThanOrEqual(0);
            expect(r.score).toBeLessThanOrEqual(1);
        }
    });

    it("filters by model year", async () => {
        // 2001 ± 2: only the Prelude was sold then.
        const old = await search("2001 honda", 5);
        expect(old.map((r) => r.model)).toEqual(["Prelude"]);

        // 2020 ± 2 excludes it, even when asked for by name.
        const recent = await search("2020 prelude", 10);
        expect(recent.length).toBeGreaterThan(0);
        expect(recent.map((r) => r.model)).not.toContain("Prelude");

        // Outside every model's years: nothing, rather than an unfiltered guess.
        expect(await search("1990 civic", 5)).toEqual([]);
    });

    it("re-embeds a model when its description is added, and unsets it when removed", async () => {
        const described = groupModels(rows, new Map([["474-1863", "A compact sedan."]]));
        expect(await ingestModels(cars, openai, described, quiet)).toMatchObject({ embedded: 1, unchanged: 6 });
        const civic = await cars.findOne({ _id: "474-1863" });
        expect(civic?.description).toBe("A compact sedan.");
        expect(civic?.embeddingText).toBe("HONDA Civic. A compact sedan.");

        expect(await ingestModels(cars, openai, groupModels(rows), quiet)).toMatchObject({ embedded: 1 });
        expect(await cars.findOne({ _id: "474-1863" })).not.toHaveProperty("description");
    });

    it("removes models that left the data", async () => {
        const summary = await ingestModels(cars, openai, groupModels(rows.filter((r) => r.make !== "TOYOTA")), quiet);
        expect(summary.removed).toBe(1);
        expect(await cars.countDocuments()).toBe(6);
    });

    it("upgrades an index made before the year filter existed", async () => {
        const legacy = db.collection<CarDoc>("legacy_cars");
        const [civic] = groupModels(rows);
        await legacy.insertOne({ ...civic!, embedding: fakeVector("HONDA Civic"), embeddingModel: "test" });
        await legacy.createSearchIndex({
            name: CARS_VECTOR_INDEX,
            type: "vectorSearch",
            definition: {
                fields: [
                    { type: "vector", path: "embedding", numDimensions: EMBEDDING_DIMENSIONS, similarity: "cosine" },
                ],
            },
        });

        const logs: string[] = [];
        await ensureVectorIndex(legacy, { waitMs: 60_000, log: (m) => logs.push(m) });
        expect(logs.join("\n")).toMatch(/Updated vector index/);

        // A year-filtered search errors unless `years` is a filter field.
        const results = await legacy
            .aggregate<CarDoc>([
                {
                    $vectorSearch: {
                        index: CARS_VECTOR_INDEX,
                        path: "embedding",
                        queryVector: fakeVector("civic"),
                        numCandidates: 10,
                        limit: 1,
                        filter: { years: { $in: [2019] } },
                    },
                },
            ])
            .toArray();
        expect(results.map((r) => r.model)).toEqual(["Civic"]);
    }, 120_000);
});
