// The answer cache (docs/specs/generate.md, decision 5, S11, S12): a repeated
// search costs nothing, which matters at 50 chat calls a day.
// No h3/Nuxt imports, so it's integration-testable like search.ts.
import type { Db } from "mongodb";
import type { Answer } from "../../shared/types/car.ts";
import type { AnswerCheck } from "./answer.ts";

export const ANSWERS_COLLECTION = "answers";
// Only stops the collection growing forever. Freshness comes from the key,
// which changes with the prompt, the model, and each car's years and description.
export const ANSWER_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// S11: `_id` is the hashed key from answerCacheKey(); the shopper's text is never stored.
export type AnswerCacheDoc = { _id: string; answer: Answer; createdAt: Date };

// The TTL index is created on first write, once per database per process.
// Cached as a promise so concurrent first writes share one createIndex call.
const ttlIndexes = new WeakMap<Db, Promise<string>>();

function ensureTtlIndex(db: Db) {
    let pending = ttlIndexes.get(db);
    if (!pending) {
        pending = db
            .collection<AnswerCacheDoc>(ANSWERS_COLLECTION)
            // Three-argument form: index options, then command options (none).
            // The two-argument form mixes them and is deprecated in driver 7.
            .createIndex(
                { createdAt: 1 },
                { name: "answers_ttl", expireAfterSeconds: ANSWER_CACHE_TTL_SECONDS },
                undefined,
            );
        // Let the next write retry instead of caching a failure.
        pending.catch(() => ttlIndexes.delete(db));
        ttlIndexes.set(db, pending);
    }
    return pending;
}

export async function getCachedAnswer(db: Db, key: string): Promise<Answer | null> {
    const doc = await db.collection<AnswerCacheDoc>(ANSWERS_COLLECTION).findOne({ _id: key });
    return doc?.answer ?? null;
}

// S12: only an answer that passed validateAnswer() is stored; anything else is
// refused here too, so no caller can cache a bad answer by mistake. Returns
// whether it was stored. Refusals (noneFit) are valid answers and are cached.
export async function cacheAnswer(db: Db, key: string, check: AnswerCheck): Promise<boolean> {
    if (!check.ok) return false;
    await ensureTtlIndex(db);
    await db
        .collection<AnswerCacheDoc>(ANSWERS_COLLECTION)
        .replaceOne({ _id: key }, { answer: check.answer, createdAt: new Date() }, { upsert: true });
    return true;
}
