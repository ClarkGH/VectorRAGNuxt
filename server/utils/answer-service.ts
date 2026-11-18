// POST /api/answer's work, in the spec's order (docs/specs/generate.md, appendix):
// validate (S1–S3, S13) → re-fetch cars → cache lookup (S11) → per-minute
// limit (S14) → embed and gate (decision 1) → chat call, no retries → clean and
// validate (S15, decision 4) → cache (S12) → respond.
// No h3/Nuxt imports, so it's integration-testable; answer.post.ts maps the
// outcome onto HTTP.
import type { Db } from "mongodb";
import OpenAI from "openai";
import type { Answer, CarDoc, YearRange } from "../../shared/types/car.ts";
import { CARS_COLLECTION, embedTexts } from "../../shared/utils/embedding.ts";
import {
    ANSWER_INSTRUCTIONS,
    ANSWER_MAX_OUTPUT_TOKENS,
    ANSWER_MAX_PICKS,
    ANSWER_MODEL,
    answerCacheKey,
    answerSchema,
    buildAnswerInput,
    fakeAnswer,
    GATE_THRESHOLD,
    gateScore,
    validateAnswer,
    type AnswerCar,
    type AnswerRejection,
    type AnswerReply,
    type CatalogCar,
} from "./answer.ts";
import { cacheAnswer, getCachedAnswer } from "./answer-cache.ts";
import { parseYearFilter, SEARCH_MAX_QUERY_LENGTH } from "./search.ts";

// The chat call's own timeout. The shared client's 15 s suits embeddings, but a
// slow gpt-5-mini reply that times out has probably already been counted
// against the 50 a day, so it gets room to finish.
export const ANSWER_TIMEOUT_MS = 45_000;

// --- Request (S2, S13) ------------------------------------------------------

export class AnswerInputError extends Error {}

export type AnswerRequest = { query: string; resultIds: string[] };

// A car's _id: `${makeId}-${modelId}`.
const CAR_ID = /^\d+-\d+$/;

// S13: an array of 1–5 unique ids in the car-id format; the query follows the
// search rules (S2). Anything else is rejected, so request data can never
// become a Mongo operator or an invented car.
export function parseAnswerBody(body: unknown): AnswerRequest {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new AnswerInputError("Body must be a JSON object");
    }
    const { query, resultIds } = body as Record<string, unknown>;

    if (typeof query !== "string") throw new AnswerInputError("query must be a string");
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > SEARCH_MAX_QUERY_LENGTH) {
        throw new AnswerInputError(`query must be 1-${SEARCH_MAX_QUERY_LENGTH} characters`);
    }

    const idsError = `resultIds must be 1-${ANSWER_MAX_PICKS} unique car ids`;
    if (!Array.isArray(resultIds) || resultIds.length < 1 || resultIds.length > ANSWER_MAX_PICKS) {
        throw new AnswerInputError(idsError);
    }
    if (!resultIds.every((id): id is string => typeof id === "string" && CAR_ID.test(id))) {
        throw new AnswerInputError(idsError);
    }
    if (new Set(resultIds).size !== resultIds.length) throw new AnswerInputError(idsError);

    return { query: trimmed, resultIds };
}

// --- Per-minute limit (S14) -------------------------------------------------

export const ANSWER_LIMIT_PER_MINUTE = 5;

export type MinuteLimiter = { take: () => boolean };

// A sliding window over the last minute, for the whole server: one local user,
// so there's no per-visitor split (that's in "Before going public").
export function createMinuteLimiter(
    limit = ANSWER_LIMIT_PER_MINUTE,
    windowMs = 60_000,
    now: () => number = Date.now,
): MinuteLimiter {
    const taken: number[] = [];
    return {
        take() {
            const cutoff = now() - windowMs;
            while (taken.length && taken[0]! <= cutoff) taken.shift();
            if (taken.length >= limit) return false;
            taken.push(now());
            return true;
        },
    };
}

// --- Recently rejected (S14) ------------------------------------------------

// How long a dropped answer's key is remembered.
export const REJECTION_MEMORY_MS = 10 * 60_000;

// Bad answers are never cached (S12), so a search the model keeps getting wrong
// would spend a call on every click. This remembers, in memory, which keys were
// just rejected and why, and refuses them for a while without calling the
// model. It holds hashed keys and reason codes only, never answer text, and a
// restart clears it.
export type RejectionMemory = {
    get: (key: string) => AnswerRejection | undefined;
    remember: (key: string, reason: AnswerRejection) => void;
};

export function createRejectionMemory(
    ttlMs = REJECTION_MEMORY_MS,
    now: () => number = Date.now,
): RejectionMemory {
    const rejected = new Map<string, { reason: AnswerRejection; until: number }>();
    return {
        get(key) {
            const entry = rejected.get(key);
            if (!entry) return undefined;
            if (entry.until <= now()) {
                rejected.delete(key);
                return undefined;
            }
            return entry.reason;
        },
        remember(key, reason) {
            // Drop expired entries as new ones arrive, so the map can't grow unbounded.
            for (const [k, entry] of rejected) if (entry.until <= now()) rejected.delete(k);
            rejected.set(key, { reason, until: now() + ttlMs });
        },
    };
}

// --- The work ---------------------------------------------------------------

export type AnswerOutcome
    = | { kind: "answer"; answer: Answer; source: "model" | "cache" | "gate" | "mock" }
        | { kind: "unknown-ids" } // a resultId isn't in the catalog
        | { kind: "busy" } // our per-minute limit (S14)
        | { kind: "minute-limit" } // OpenAI's per-minute limit
        | { kind: "daily-limit" } // OpenAI's daily limit: "paused for today"
        | { kind: "out-of-quota" } // the OpenAI account has no usable credit: retrying won't help
        | { kind: "bad-answer"; reason: AnswerRejection; repeat: boolean }; // dropped, or rejected recently

export type AnswerDeps = {
    db: Db;
    openai: OpenAI;
    // Mock mode: the fake answerer replaces the model, and the cache is neither
    // read nor written, so a mock answer can never be served later (decision 5).
    mock: boolean;
    limiter: MinuteLimiter;
    rejections: RejectionMemory;
};

// The re-fetched car, without its vector: that's only needed on a cache miss.
type AnswerCarDoc = Omit<CarDoc, "embedding" | "embeddingModel">;

// --- The model call (shared with the answer check, scripts/answer-check.ts) --

export type ModelOutcome
    = | { kind: "reply"; reply: AnswerReply }
        | { kind: "minute-limit" }
        | { kind: "daily-limit" }
        | { kind: "out-of-quota" };

// One chat call, never retried. Limits come back as outcomes; anything else throws.
export async function requestAnswer(
    openai: OpenAI,
    query: string,
    years: YearRange | null,
    cars: readonly AnswerCar[],
): Promise<ModelOutcome> {
    try {
        const reply = await openai.responses.create(
            {
                model: ANSWER_MODEL,
                instructions: ANSWER_INSTRUCTIONS,
                input: buildAnswerInput(query, years, cars),
                reasoning: { effort: "minimal" },
                max_output_tokens: ANSWER_MAX_OUTPUT_TOKENS,
                text: { format: { type: "json_schema", name: "car_answer", strict: true, schema: answerSchema } },
            },
            // S14: never retried; each retry could spend one of the 50 a day.
            { maxRetries: 0, timeout: ANSWER_TIMEOUT_MS },
        );
        return { kind: "reply", reply };
    } catch (err) {
        if (err instanceof OpenAI.RateLimitError) {
            // No credit left on the account: also a 429, but no "per day" in it.
            if (err.code === "insufficient_quota") return { kind: "out-of-quota" };
            // Same check as scripts/describe-cars.ts.
            return /per day/i.test(err.message) ? { kind: "daily-limit" } : { kind: "minute-limit" };
        }
        throw err;
    }
}

// The text check needs every catalog name: 475 short rows, read fresh so a
// re-ingest is picked up without a restart.
export function loadCatalog(db: Db) {
    return db
        .collection<CarDoc>(CARS_COLLECTION)
        .find<CatalogCar>({}, { projection: { _id: 1, make: 1, model: 1 } })
        .toArray();
}

export async function answerSearch(deps: AnswerDeps, req: AnswerRequest): Promise<AnswerOutcome> {
    const { db, openai, mock, limiter, rejections } = deps;
    const collection = db.collection<CarDoc>(CARS_COLLECTION);

    // Re-fetch the cars (P4): never trust car data from the browser. Kept in
    // the order sent, which is search's rank order and the prompt's order.
    const found = await collection
        .find<AnswerCarDoc>({ _id: { $in: req.resultIds } }, { projection: { embedding: 0, embeddingModel: 0 } })
        .toArray();
    const byId = new Map(found.map((car) => [car._id, car]));
    const cars = req.resultIds.map((id) => byId.get(id));
    if (!cars.every((car): car is AnswerCarDoc => car !== undefined)) return { kind: "unknown-ids" };

    // Cache first: a cached answer costs nothing, not even an embedding.
    const key = answerCacheKey(req.query, cars);
    if (!mock) {
        const cached = await getCachedAnswer(db, key);
        if (cached) return { kind: "answer", answer: cached, source: "cache" };
        const recent = rejections.get(key);
        if (recent) return { kind: "bad-answer", reason: recent, repeat: true };
    }

    // Every uncached request counts, gated or not: each spends an embedding.
    if (!limiter.take()) return { kind: "busy" };

    // Gate (decision 1): embed the text search embedded, score it ourselves
    // against the stored vectors, fetched only now that they're needed.
    const parsed = parseYearFilter(req.query);
    const [[queryVector], vectors] = await Promise.all([
        embedTexts(openai, [parsed.text]),
        collection
            .find<{ embedding: number[] }>({ _id: { $in: req.resultIds } }, { projection: { _id: 0, embedding: 1 } })
            .toArray(),
    ]);
    if (!queryVector) throw new Error("Embedding API returned no vector");
    if (gateScore(queryVector, vectors.map((v) => v.embedding)) < GATE_THRESHOLD) {
        return { kind: "answer", answer: { noneFit: true, picks: [] }, source: "gate" };
    }

    const asked = mock
        ? ({ kind: "reply", reply: fakeAnswer(req.query, cars) } as const)
        : await requestAnswer(openai, req.query, parsed.years, cars);
    if (asked.kind !== "reply") return asked;

    const check = validateAnswer(asked.reply, cars, await loadCatalog(db));
    if (!check.ok) {
        if (!mock) rejections.remember(key, check.reason);
        return { kind: "bad-answer", reason: check.reason, repeat: false };
    }

    if (!mock) await cacheAnswer(db, key, check);
    return { kind: "answer", answer: check.answer, source: mock ? "mock" : "model" };
}
