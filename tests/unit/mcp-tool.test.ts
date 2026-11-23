// The search_cars tool's logic: docs/specs/mcp-server.md, S19–S22 and
// decisions A–C. A stub stands in for the search, so nothing here touches
// Mongo or OpenAI; tests/integration covers the real search path.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../../shared/types/car.ts";
import type { ParsedQuery } from "../../server/utils/search.ts";
import { SEARCH_MAX_QUERY_LENGTH } from "../../server/utils/search.ts";
import {
    CALLS_PER_MINUTE,
    createSessionLimiter,
    DESCRIPTION_NOTE,
    runSearchTool,
    SEARCH_UNAVAILABLE,
    TOOL_MAX_LIMIT,
    type SessionLimiter,
} from "../../mcp/search-tool.ts";

const car = (overrides: Partial<SearchResult> = {}): SearchResult => ({
    _id: "474-2127",
    make: "HONDA",
    makeId: 474,
    model: "Fit",
    modelId: 2127,
    years: [2016, 2017, 2018, 2019, 2020],
    description: "Subcompact hatchback in the economy segment.",
    embeddingText: "HONDA Fit. Subcompact hatchback in the economy segment.",
    score: 0.86,
    ...overrides,
});

// A search stub that records what it was asked.
function stubSearch(results: SearchResult[] = [car()]) {
    const calls: { query: ParsedQuery; limit: number }[] = [];
    const search = async (query: ParsedQuery, limit: number) => {
        calls.push({ query, limit });
        return results;
    };
    return { search, calls };
}

const unlimited = (): SessionLimiter => ({ take: () => ({ ok: true }) });

afterEach(() => {
    vi.restoreAllMocks();
});

describe("runSearchTool: output (S21, decision B)", () => {
    it("returns only the allow-listed fields, with the match in words", async () => {
        const { search } = stubSearch();
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "small honda hatchback" });

        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(Object.keys(out.result).sort()).toEqual(["note", "nothingClose", "results", "years"]);
        expect(out.result.note).toBe(DESCRIPTION_NOTE);
        expect(out.result.results).toEqual([
            {
                id: "474-2127",
                make: "Honda",
                model: "Fit",
                years: [2016, 2017, 2018, 2019, 2020],
                description: "Subcompact hatchback in the economy segment.",
                match: "strong",
            },
        ]);
    });

    it("never passes on the score, vector or embedded text, even if the search returns them", async () => {
        const leaky = { ...car(), embedding: [0.1, 0.2], embeddingModel: "text-embedding-3-small" } as SearchResult;
        const { search } = stubSearch([leaky]);
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "fit" });

        if (!out.ok) throw new Error(out.message);
        const keys = Object.keys(out.result.results[0]!).sort();
        expect(keys).toEqual(["description", "id", "make", "match", "model", "years"]);
        expect(JSON.stringify(out.result)).not.toMatch(/score|embedding|0\.86/);
    });

    it("maps scores to strong, possible and weak", async () => {
        const { search } = stubSearch([
            car({ _id: "1-1", score: 0.8 }),
            car({ _id: "1-2", score: 0.7 }),
            car({ _id: "1-3", score: 0.6 }),
        ]);
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "car" });

        if (!out.ok) throw new Error(out.message);
        expect(out.result.results.map((r) => r.match)).toEqual(["strong", "possible", "weak"]);
    });

    it("cleans descriptions (S15), and gives null for a missing or emptied one", async () => {
        const hidden = String.fromCodePoint(0x202e) + "evil" + String.fromCodePoint(0x202c) + String.fromCodePoint(0x200b);
        const { search } = stubSearch([
            car({ _id: "1-1", description: `A  small\ncar.${hidden}` }),
            car({ _id: "1-2", description: undefined }),
            car({ _id: "1-3", description: String.fromCodePoint(0x200d) }),
        ]);
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "car" });

        if (!out.ok) throw new Error(out.message);
        expect(out.result.results.map((r) => r.description)).toEqual(["A small car.evil", null, null]);
    });

    it("flags nothingClose when no result reaches the gate, and for no results at all", async () => {
        for (const results of [[car({ score: 0.6 }), car({ _id: "1-2", score: 0.64 })], []]) {
            const { search } = stubSearch(results);
            const out = await runSearchTool({ search, limiter: unlimited() }, { query: "pickup truck" });
            if (!out.ok) throw new Error(out.message);
            expect(out.result.nothingClose).toBe(true);
        }
        const { search } = stubSearch([car({ score: 0.65 })]);
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "fit" });
        if (!out.ok) throw new Error(out.message);
        expect(out.result.nothingClose).toBe(false);
    });
});

describe("runSearchTool: the same request handling as the web (S19, decision A)", () => {
    it("parses years out of the query the way the page does, and reports the range", async () => {
        const { search, calls } = stubSearch();
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "2018 accord" });

        expect(calls).toEqual([{ query: { text: "accord", years: [2016, 2020] }, limit: 5 }]);
        if (!out.ok) throw new Error(out.message);
        expect(out.result.years).toEqual([2016, 2020]);
    });

    it("reports no year range for a query without years", async () => {
        const { search } = stubSearch();
        const out = await runSearchTool({ search, limiter: unlimited() }, { query: "small car" });
        if (!out.ok) throw new Error(out.message);
        expect(out.result.years).toBeNull();
    });

    it("passes a limit up to the tool's cap through", async () => {
        const { search, calls } = stubSearch();
        await runSearchTool({ search, limiter: unlimited() }, { query: "car", limit: TOOL_MAX_LIMIT });
        expect(calls[0]!.limit).toBe(TOOL_MAX_LIMIT);
    });

    it("reads only query and limit: other fields change nothing", async () => {
        const { search, calls } = stubSearch();
        await runSearchTool(
            { search, limiter: unlimited() },
            { query: "accord", year: 2020, filter: { $where: "1" }, limit: 3 },
        );
        expect(calls).toEqual([{ query: { text: "accord", years: null }, limit: 3 }]);
    });

    it.each([
        ["no input", undefined],
        ["an array", ["fit"]],
        ["a missing query", { limit: 5 }],
        ["an object query", { query: { $gt: "" } }],
        ["an empty query", { query: "   " }],
        ["a too-long query", { query: "a".repeat(SEARCH_MAX_QUERY_LENGTH + 1) }],
        ["a limit over the tool's cap", { query: "fit", limit: TOOL_MAX_LIMIT + 1 }],
        ["a zero limit", { query: "fit", limit: 0 }],
        ["a fractional limit", { query: "fit", limit: 2.5 }],
        ["a string limit", { query: "fit", limit: "5" }],
    ])("refuses %s without searching or using up the session", async (_name, input) => {
        const { search, calls } = stubSearch();
        const limiter = createSessionLimiter({ perSession: 1 });

        const out = await runSearchTool({ search, limiter }, input);

        expect(out.ok).toBe(false);
        expect(calls).toHaveLength(0);
        // The one allowed call is still there: the refusal didn't count.
        expect(limiter.take()).toEqual({ ok: true });
    });
});

describe("createSessionLimiter (S20, decision C)", () => {
    it(`allows ${CALLS_PER_MINUTE} calls a minute, then says how long to wait`, () => {
        let t = 0;
        const limiter = createSessionLimiter({ now: () => t });
        for (let i = 0; i < CALLS_PER_MINUTE; i++) {
            expect(limiter.take()).toEqual({ ok: true });
            t += 1000;
        }
        // 10 s after the first call: 50 s until it leaves the window.
        expect(limiter.take()).toEqual({
            ok: false,
            message: `Limit reached: ${CALLS_PER_MINUTE} searches a minute. Try again in 50 seconds.`,
        });
        t = 60_000;
        expect(limiter.take()).toEqual({ ok: true });
    });

    it("stops for good at the session limit, and says how to reset it", () => {
        let t = 0;
        const limiter = createSessionLimiter({ perMinute: 100, perSession: 3, now: () => t });
        for (let i = 0; i < 3; i++) expect(limiter.take().ok).toBe(true);
        t += 10 * 60_000;
        expect(limiter.take()).toEqual({
            ok: false,
            message: "Limit reached: 3 searches this session. Restart the server to search again.",
        });
    });

    it("refused calls don't count toward the session", () => {
        let t = 0;
        const limiter = createSessionLimiter({ perMinute: 1, perSession: 2, now: () => t });
        expect(limiter.take().ok).toBe(true);
        expect(limiter.take().ok).toBe(false);
        t = 60_000;
        expect(limiter.take().ok).toBe(true);
    });

    it("never searches once a limit is reached", async () => {
        const { search, calls } = stubSearch();
        const limiter = createSessionLimiter({ perSession: 1 });
        await runSearchTool({ search, limiter }, { query: "fit" });
        const out = await runSearchTool({ search, limiter }, { query: "fit" });

        expect(out).toEqual({
            ok: false,
            message: "Limit reached: 1 searches this session. Restart the server to search again.",
        });
        expect(calls).toHaveLength(1);
    });
});

describe("runSearchTool: failures (S18, S22)", () => {
    it("gives the client a generic message and logs only the error's message", async () => {
        const logged: string[] = [];
        const search = async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:27017");
        };
        const out = await runSearchTool({ search, limiter: unlimited(), log: (m) => logged.push(m) }, { query: "fit" });

        expect(out).toEqual({ ok: false, message: SEARCH_UNAVAILABLE });
        expect(logged).toEqual(["search_cars failed: connect ECONNREFUSED 127.0.0.1:27017"]);
    });

    it("logs to stderr by default, never stdout", async () => {
        const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
        const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
        const search = async () => {
            throw new Error("boom");
        };
        await runSearchTool({ search, limiter: unlimited() }, { query: "fit" });

        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledWith("search_cars failed: boom");
    });
});
