// The `search_cars` tool's logic, without the MCP SDK, so it's unit-testable:
// docs/specs/mcp-server.md (build step 1). mcp/server.ts (step 2) registers it.
// Rules: S19 (validate like the web), S20 (limits), S21 (allow-listed, cleaned
// output), S22 (generic errors, details to stderr).
//
// S18: with stdio, stdout is the protocol stream. Nothing here writes to it;
// the default logger is console.error (stderr).
import type { SearchResult, YearRange } from "../shared/types/car.ts";
import { cleanText } from "../shared/utils/clean-text.ts";
import { displayMake } from "../shared/utils/make-name.ts";
import { matchStrength, type MatchStrength } from "../shared/utils/match-strength.ts";
import {
    isNothingClose,
    parseSearchBody,
    parseYearFilter,
    SearchInputError,
    type ParsedQuery,
} from "../server/utils/search.ts";

// Decision A: lower than the web's 20, since every result lands in the
// assistant's context and results below the top 10 are rarely strong.
export const TOOL_MAX_LIMIT = 10;

// Decision C.
export const CALLS_PER_MINUTE = 10;
export const CALLS_PER_SESSION = 100;

// S21: one note for the whole search, in the page's wording.
export const DESCRIPTION_NOTE = "Descriptions are AI-written and can be wrong.";

// S22: what the client sees when the search itself fails. Same text as the web's 502.
export const SEARCH_UNAVAILABLE = "Search is unavailable right now";

// --- Output (S21, decision B) -----------------------------------------------

// Only these fields leave the server. Never the vector, the embedded text or
// the raw score (decision B: a model repeats numbers back as facts).
export type ToolCar = {
    id: string;
    make: string;
    model: string;
    years: number[];
    description: string | null;
    match: MatchStrength;
};

export type ToolResult = {
    results: ToolCar[];
    nothingClose: boolean;
    years: YearRange | null;
    note: string;
};

// Built field by field rather than by removing fields, so a field added to the
// car documents later stays private unless it's added here on purpose.
export function toToolCar(car: SearchResult): ToolCar {
    const description = car.description ? cleanText(car.description) : "";
    return {
        id: car._id,
        make: displayMake(car.make),
        model: car.model,
        years: [...car.years],
        description: description || null,
        match: matchStrength(car.score),
    };
}

export function toToolResult(results: readonly SearchResult[], years: YearRange | null): ToolResult {
    return {
        results: results.map(toToolCar),
        nothingClose: isNothingClose(results),
        years,
        note: DESCRIPTION_NOTE,
    };
}

// --- Limits (S20, decision C) -----------------------------------------------

export type LimitCheck = { ok: true } | { ok: false; message: string };
export type SessionLimiter = { take: () => LimitCheck };

// A session is one server process, so the counts live in memory and a
// restart clears them. Over a limit, the message names it and when it resets,
// so the assistant can tell the user instead of retrying blindly.
export function createSessionLimiter({
    perMinute = CALLS_PER_MINUTE,
    perSession = CALLS_PER_SESSION,
    windowMs = 60_000,
    now = Date.now,
}: { perMinute?: number; perSession?: number; windowMs?: number; now?: () => number } = {}): SessionLimiter {
    const recent: number[] = [];
    let total = 0;
    return {
        take() {
            if (total >= perSession) {
                return {
                    ok: false,
                    message: `Limit reached: ${perSession} searches this session. Restart the server to search again.`,
                };
            }
            const t = now();
            while (recent.length && recent[0]! <= t - windowMs) recent.shift();
            if (recent.length >= perMinute) {
                const seconds = Math.max(1, Math.ceil((recent[0]! + windowMs - t) / 1000));
                return {
                    ok: false,
                    message: `Limit reached: ${perMinute} searches a minute. Try again in ${seconds} seconds.`,
                };
            }
            recent.push(t);
            total += 1;
            return { ok: true };
        },
    };
}

// --- The tool ---------------------------------------------------------------

export type ToolOutcome = { ok: true; result: ToolResult } | { ok: false; message: string };

export type SearchToolDeps = {
    // The web's search, already bound to its Mongo and OpenAI clients:
    // (query, limit) => searchCars(db, openai, query, limit) in mcp/server.ts.
    search: (query: ParsedQuery, limit: number) => Promise<SearchResult[]>;
    limiter: SessionLimiter;
    // S18/S22: stderr only.
    log?: (message: string) => void;
};

// Order: validate (free) → limit → search. Invalid input never reaches the
// limiter or the search, so it costs nothing and doesn't use up the session.
export async function runSearchTool(deps: SearchToolDeps, input: unknown): Promise<ToolOutcome> {
    const { search, limiter, log = (message) => console.error(message) } = deps;

    // S19: the web's own checks (1–500 characters, integer limit, no objects),
    // then the tool's lower cap. Only `query` and `limit` are read.
    let request: { query: string; limit: number };
    try {
        request = parseSearchBody(input);
    } catch (err) {
        if (err instanceof SearchInputError) return { ok: false, message: err.message };
        throw err;
    }
    if (request.limit > TOOL_MAX_LIMIT) {
        return { ok: false, message: `limit must be an integer from 1 to ${TOOL_MAX_LIMIT}` };
    }

    const allowed = limiter.take();
    if (!allowed.ok) return allowed;

    // The same chain as server/api/search.post.ts, so the tool and the page
    // can't disagree about the same request.
    const parsed = parseYearFilter(request.query);
    try {
        const results = await search(parsed, request.limit);
        return { ok: true, result: toToolResult(results, parsed.years) };
    } catch (err) {
        // S22: the details stay on stderr; never the request, key or Mongo URI.
        log(`search_cars failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, message: SEARCH_UNAVAILABLE };
    }
}
