// /api/answer's request checks (S2, S13) and per-minute limit (S14):
// docs/specs/generate.md. The flow itself is in tests/integration/answer.test.ts.
import { describe, expect, it } from "vitest";
import {
    ANSWER_LIMIT_PER_MINUTE,
    AnswerInputError,
    createMinuteLimiter,
    createRejectionMemory,
    parseAnswerBody,
} from "../../server/utils/answer-service.ts";
import { SEARCH_MAX_QUERY_LENGTH } from "../../server/utils/search.ts";

describe("parseAnswerBody (S13)", () => {
    it("accepts a query and 1-5 unique car ids, trimming the query", () => {
        expect(parseAnswerBody({ query: "  cheap car ", resultIds: ["474-1863", "448-2208"] })).toEqual({
            query: "cheap car",
            resultIds: ["474-1863", "448-2208"],
        });
    });

    it.each([
        ["no body", null],
        ["an array", []],
        ["a missing query", { resultIds: ["474-1863"] }],
        ["an object query", { query: { $gt: "" }, resultIds: ["474-1863"] }],
        ["an empty query", { query: "   ", resultIds: ["474-1863"] }],
        ["a long query", { query: "a".repeat(SEARCH_MAX_QUERY_LENGTH + 1), resultIds: ["474-1863"] }],
        ["missing ids", { query: "car" }],
        ["ids as a string", { query: "car", resultIds: "474-1863" }],
        ["no ids", { query: "car", resultIds: [] }],
        ["6 ids", { query: "car", resultIds: ["1-1", "1-2", "1-3", "1-4", "1-5", "1-6"] }],
        ["a duplicate id", { query: "car", resultIds: ["474-1863", "474-1863"] }],
        ["an object id", { query: "car", resultIds: [{ $ne: null }] }],
        ["a numeric id", { query: "car", resultIds: [474] }],
        ["a malformed id", { query: "car", resultIds: ["474-1863x"] }],
        ["an id with a regex", { query: "car", resultIds: [".*"] }],
    ])("rejects %s", (_, body) => {
        expect(() => parseAnswerBody(body)).toThrow(AnswerInputError);
    });
});

describe("createMinuteLimiter (S14)", () => {
    it(`allows ${ANSWER_LIMIT_PER_MINUTE} a minute, then refuses until the oldest is a minute old`, () => {
        let t = 0;
        const limiter = createMinuteLimiter(ANSWER_LIMIT_PER_MINUTE, 60_000, () => t);
        for (let i = 0; i < ANSWER_LIMIT_PER_MINUTE; i++) {
            expect(limiter.take()).toBe(true);
            t += 1_000;
        }
        expect(limiter.take()).toBe(false);

        t = 59_999;
        expect(limiter.take()).toBe(false);
        t = 60_000; // the first one, taken at 0, has left the window
        expect(limiter.take()).toBe(true);
        expect(limiter.take()).toBe(false);
    });

    it("allows none when the limit is 0", () => {
        expect(createMinuteLimiter(0).take()).toBe(false);
    });

    it("doesn't count refused requests", () => {
        let t = 0;
        const limiter = createMinuteLimiter(1, 60_000, () => t);
        expect(limiter.take()).toBe(true);
        for (let i = 0; i < 10; i++) expect(limiter.take()).toBe(false);
        t = 60_000;
        expect(limiter.take()).toBe(true);
    });
});

describe("createRejectionMemory (S14)", () => {
    it("remembers a rejected key and its reason until the time runs out", () => {
        let t = 0;
        const memory = createRejectionMemory(1_000, () => t);
        expect(memory.get("k")).toBeUndefined();

        memory.remember("k", "names-unretrieved-car");
        t = 999;
        expect(memory.get("k")).toBe("names-unretrieved-car");
        expect(memory.get("other")).toBeUndefined();

        t = 1_000;
        expect(memory.get("k")).toBeUndefined();
    });

    it("re-remembering a key restarts its time", () => {
        let t = 0;
        const memory = createRejectionMemory(1_000, () => t);
        memory.remember("k", "incomplete");
        t = 900;
        memory.remember("k", "unknown-id");
        t = 1_500;
        expect(memory.get("k")).toBe("unknown-id");
    });
});
