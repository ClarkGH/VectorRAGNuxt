// /api/answer's flow (server/utils/answer-service.ts) against a real Mongo and
// the fake OpenAI server: no key, no network, zero chat calls.
// Needs `docker compose up -d`. Uses a throwaway database, dropped afterwards.
// Override the server with TEST_MONGODB_URI.
import { MongoClient, type Db } from "mongodb";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { groupModels, ingestModels } from "../../scripts/lib/ingest.ts";
import { ANSWERS_COLLECTION } from "../../server/utils/answer-cache.ts";
import {
    answerSearch,
    createMinuteLimiter,
    createRejectionMemory,
    REJECTION_MEMORY_MS,
    type AnswerDeps,
    type AnswerRequest,
} from "../../server/utils/answer-service.ts";
import type { Car, CarDoc } from "../../shared/types/car.ts";
import { CARS_COLLECTION } from "../../shared/utils/embedding.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai.ts";

const uri = process.env.TEST_MONGODB_URI ?? "mongodb://localhost:27017/?directConnection=true";

const row = (make: string, makeId: number, model: string, modelId: number, year: number): Car => ({
    make,
    makeId,
    model,
    modelId,
    year,
});
const rows: Car[] = [
    row("HONDA", 474, "Civic", 1863, 2020),
    row("HONDA", 474, "Accord", 1861, 2020),
    row("TOYOTA", 448, "Corolla", 2208, 2020),
    row("FORD", 460, "Mustang", 1781, 2020),
];
const CIVIC = "474-1863";
const ACCORD = "474-1861";
const COROLLA = "448-2208";

describe("answerSearch", () => {
    let client: MongoClient;
    let db: Db;
    let fake: FakeOpenAI;
    let openai: OpenAI;
    let deps: AnswerDeps;
    // The fake embeds by spelling, so a car's own name clears the 0.65 gate
    // and gibberish doesn't. Each test uses its own wording, so caches don't collide.
    const ask = (query: string, resultIds = [CIVIC, ACCORD, COROLLA], over: Partial<AnswerDeps> = {}) =>
        answerSearch({ ...deps, ...over }, { query, resultIds } satisfies AnswerRequest);
    const chatCalls = () => fake.responseRequests.length;
    const cached = () => db.collection(ANSWERS_COLLECTION).countDocuments();

    beforeAll(async () => {
        fake = await startFakeOpenAI();
        openai = new OpenAI({ apiKey: "test", baseURL: fake.baseURL, maxRetries: 2 });
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
        await client.connect();
        db = client.db(`vectorrag_test_answer_${Date.now()}`);
        await ingestModels(db.collection<CarDoc>(CARS_COLLECTION), openai, groupModels(rows), () => {});
    });

    beforeEach(() => {
        // The shared client retries twice, like the app's; a roomy limiter per test.
        deps = { db, openai, mock: false, limiter: createMinuteLimiter(100), rejections: createRejectionMemory() };
        fake.setAnswer((input) => ({
            text: JSON.stringify({ noneFit: false, picks: [{ carId: input.cars[0]?.id, reason: "Fits the search." }] }),
        }));
    });

    afterAll(async () => {
        await db?.dropDatabase();
        await client?.close();
        await fake?.close();
    });

    it("answers from the model, then serves a repeat from the cache with zero OpenAI calls", async () => {
        const first = await ask("honda civic");
        expect(first).toEqual({
            kind: "answer",
            source: "model",
            answer: { noneFit: false, picks: [{ carId: CIVIC, reason: "Fits the search." }] },
        });

        const calls = fake.calls();
        const repeat = await ask("  HONDA   civic ");
        expect(repeat).toMatchObject({ kind: "answer", source: "cache", answer: first.kind === "answer" && first.answer });
        expect(fake.calls()).toBe(calls);
    });

    it("sends cars in the order given, without scores, and with no retries", async () => {
        await ask("honda civic accord", [COROLLA, CIVIC]);
        const request = fake.responseRequests.at(-1)!;
        const input = JSON.parse(String(request.input)) as { cars: { id: string }[] };
        expect(input.cars.map((c) => c.id)).toEqual([COROLLA, CIVIC]);
        expect(String(request.input)).not.toContain("score");
    });

    it("gates a search with nothing close: no chat call, and nothing cached", async () => {
        const [calls, stored] = [chatCalls(), await cached()];
        const first = await ask("qxzv wjkp");
        expect(first).toEqual({ kind: "answer", source: "gate", answer: { noneFit: true, picks: [] } });
        expect(chatCalls()).toBe(calls);
        expect(await cached()).toBe(stored);

        // Each refusal is a fresh object: changing one can't leak into the next.
        if (first.kind === "answer") first.answer.picks.push({ carId: CIVIC, reason: "x" });
        expect(await ask("qxzv wjkp")).toMatchObject({ answer: { picks: [] } });
    });

    it("returns unknown-ids for an id that isn't in the catalog, before spending anything", async () => {
        const calls = fake.calls();
        expect(await ask("honda civic", [CIVIC, "1-1"])).toEqual({ kind: "unknown-ids" });
        expect(fake.calls()).toBe(calls);
    });

    it("drops a bad answer and never caches it", async () => {
        const stored = await cached();
        fake.setAnswer(() => ({
            text: JSON.stringify({ noneFit: false, picks: [{ carId: "460-1781", reason: "Try the Mustang." }] }),
        }));
        expect(await ask("honda civic unknown")).toEqual({ kind: "bad-answer", reason: "unknown-id", repeat: false });

        fake.setAnswer((input) => ({
            text: JSON.stringify({ noneFit: false, picks: [{ carId: input.cars[0]?.id, reason: "Unlike a Ford Mustang." }] }),
        }));
        expect(await ask("honda civic named")).toEqual({
            kind: "bad-answer",
            reason: "names-unretrieved-car",
            repeat: false,
        });

        fake.setAnswer(() => ({ text: "{\"noneFit\": fal", incomplete: true }));
        expect(await ask("honda civic cut")).toEqual({ kind: "bad-answer", reason: "incomplete", repeat: false });

        expect(await cached()).toBe(stored);
    });

    it("refuses a just-rejected search without calling the model, until the memory expires", async () => {
        let t = 0;
        const rejections = createRejectionMemory(REJECTION_MEMORY_MS, () => t);
        fake.setAnswer((input) => ({
            text: JSON.stringify({ noneFit: false, picks: [{ carId: input.cars[0]?.id, reason: "Unlike a Ford Mustang." }] }),
        }));
        expect(await ask("honda civic again", undefined, { rejections })).toMatchObject({ repeat: false });

        // Clicking again costs nothing: no chat call, and no limiter slot.
        const calls = chatCalls();
        const limiter = createMinuteLimiter(0);
        expect(await ask("honda civic again", undefined, { rejections, limiter })).toEqual({
            kind: "bad-answer",
            reason: "names-unretrieved-car",
            repeat: true,
        });
        expect(chatCalls()).toBe(calls);

        // Once the memory expires, the model is asked again; a good answer is cached.
        t = REJECTION_MEMORY_MS;
        fake.setAnswer((input) => ({ text: JSON.stringify({ noneFit: false, picks: [{ carId: input.cars[0]?.id, reason: "Fits." }] }) }));
        expect(await ask("honda civic again", undefined, { rejections })).toMatchObject({ kind: "answer", source: "model" });
        expect(await ask("honda civic again", undefined, { rejections })).toMatchObject({ source: "cache" });
    });

    it("caches a refusal", async () => {
        fake.setAnswer(() => ({ text: JSON.stringify({ noneFit: true, picks: [] }) }));
        expect(await ask("honda civic truck")).toMatchObject({ kind: "answer", source: "model", answer: { noneFit: true } });
        expect(await ask("honda civic truck")).toMatchObject({ kind: "answer", source: "cache", answer: { noneFit: true } });
    });

    it("turns a 'per day' 429 into daily-limit, with one request and no retry", async () => {
        fake.setAnswer(() => ({
            error: 429,
            message: "Rate limit reached for gpt-5-mini on requests per day (RPD): Limit 50, Used 50, Requested 1.",
        }));
        const calls = chatCalls();
        expect(await ask("honda civic daily")).toEqual({ kind: "daily-limit" });
        expect(chatCalls()).toBe(calls + 1);
    });

    it("turns a per-minute 429 into minute-limit", async () => {
        fake.setAnswer(() => ({
            error: 429,
            message: "Rate limit reached for gpt-5-mini on requests per min (RPM): Limit 10, Used 10, Requested 1.",
        }));
        expect(await ask("honda civic minute")).toEqual({ kind: "minute-limit" });
    });

    it("turns an insufficient_quota 429 into out-of-quota, not 'try again in a minute'", async () => {
        fake.setAnswer(() => ({
            error: 429,
            code: "insufficient_quota",
            message: "You exceeded your current quota, please check your plan and billing details.",
        }));
        expect(await ask("honda civic quota")).toEqual({ kind: "out-of-quota" });
    });

    it("never retries the chat call, even on a server error", async () => {
        fake.setAnswer(() => ({ error: 500, message: "boom" }));
        const calls = chatCalls();
        await expect(ask("honda civic error")).rejects.toThrow();
        expect(chatCalls()).toBe(calls + 1);
    });

    it("refuses the 6th uncached request in a minute, gated ones included (S14)", async () => {
        const limiter = createMinuteLimiter(5);
        const queries = ["honda civic one", "qxzv one", "honda civic two", "qxzv two", "honda civic three"];
        for (const q of queries) expect((await ask(q, undefined, { limiter })).kind).toBe("answer");
        expect(await ask("honda civic four", undefined, { limiter })).toEqual({ kind: "busy" });
        // A cached repeat still works: it costs nothing.
        expect(await ask("honda civic one", undefined, { limiter })).toMatchObject({ source: "cache" });
    });

    it("in mock mode, uses the fake answerer and never reads or writes the cache", async () => {
        // A real answer is cached for this search first.
        await ask("honda civic mock");
        const [calls, stored] = [chatCalls(), await cached()];

        const result = await ask("honda civic mock", undefined, { mock: true });
        expect(result).toMatchObject({ kind: "answer", source: "mock" });
        expect(result.kind === "answer" && result.answer.picks[0]?.reason).toMatch(/^Mock answer/);
        expect(chatCalls()).toBe(calls);
        expect(await cached()).toBe(stored);
    });
});
