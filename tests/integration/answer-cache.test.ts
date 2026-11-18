// The answer cache (docs/specs/generate.md, decision 5, S11, S12) against a real
// Mongo. Needs `docker compose up -d`. Uses a throwaway database, dropped afterwards.
// Override the server with TEST_MONGODB_URI.
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    ANSWER_CACHE_TTL_SECONDS,
    ANSWERS_COLLECTION,
    cacheAnswer,
    getCachedAnswer,
    type AnswerCacheDoc,
} from "../../server/utils/answer-cache.ts";
import { answerCacheKey, fakeAnswer, validateAnswer, type CatalogCar } from "../../server/utils/answer.ts";

const uri = process.env.TEST_MONGODB_URI ?? "mongodb://localhost:27017/?directConnection=true";

const cars: (CatalogCar & { years: number[]; description: string })[] = [
    { _id: "474-1863", make: "HONDA", model: "Civic", years: [2019, 2020], description: "Compact sedan." },
    { _id: "448-2208", make: "TOYOTA", model: "Corolla", years: [2020], description: "Compact sedan, reliable." },
];
const check = (query: string) => validateAnswer(fakeAnswer(query, cars), cars, cars);

describe("answer cache", () => {
    let client: MongoClient;
    let db: Db;
    const answers = () => db.collection<AnswerCacheDoc>(ANSWERS_COLLECTION);

    beforeAll(async () => {
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        db = client.db(`vectorrag_test_answers_${Date.now()}`);
    });

    afterAll(async () => {
        await db?.dropDatabase();
        await client?.close();
    });

    it("misses, then hits after a valid answer is stored", async () => {
        const key = answerCacheKey("cheap commuter", cars);
        expect(await getCachedAnswer(db, key)).toBeNull();

        const valid = check("cheap commuter");
        expect(valid.ok).toBe(true);
        expect(await cacheAnswer(db, key, valid)).toBe(true);
        expect(await getCachedAnswer(db, key)).toEqual(valid.ok && valid.answer);
    });

    it("caches a refusal too", async () => {
        const key = answerCacheKey("pickup truck", cars);
        expect(await cacheAnswer(db, key, check("pickup truck"))).toBe(true);
        expect(await getCachedAnswer(db, key)).toEqual({ noneFit: true, picks: [] });
    });

    it("never stores an invalid answer", async () => {
        const key = answerCacheKey("bad answer", cars);
        const bad = validateAnswer({ status: "incomplete", output_text: "" }, cars, cars);
        expect(bad.ok).toBe(false);
        expect(await cacheAnswer(db, key, bad)).toBe(false);
        expect(await answers().countDocuments({ _id: key })).toBe(0);
    });

    it("stores only the hashed key, the answer and a timestamp (S11)", async () => {
        const docs = await answers().find().toArray();
        expect(docs.length).toBeGreaterThan(0);
        for (const doc of docs) {
            expect(Object.keys(doc).sort()).toEqual(["_id", "answer", "createdAt"]);
            expect(doc._id).toMatch(/^[0-9a-f]{64}$/);
            expect(JSON.stringify(doc)).not.toMatch(/commuter|pickup|truck/);
        }
    });

    it("creates the 30-day TTL index on first write", async () => {
        const indexes = await answers().indexes();
        const ttl = indexes.find((i) => i.name === "answers_ttl");
        expect(ttl).toMatchObject({ key: { createdAt: 1 }, expireAfterSeconds: ANSWER_CACHE_TTL_SECONDS });
    });

    it("overwrites rather than duplicates a key written twice", async () => {
        const key = answerCacheKey("cheap commuter", cars);
        await cacheAnswer(db, key, check("cheap commuter"));
        expect(await answers().countDocuments({ _id: key })).toBe(1);
    });
});
