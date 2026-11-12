// Search logic without h3/Nuxt imports, so it's unit- and integration-testable.
// Security requirements (S1, S2) are in docs/specs/ingest-search.md.
import type { Db } from "mongodb";
import type OpenAI from "openai";
import type { CarDoc, SearchResult, YearRange } from "../../shared/types/car.ts";
import { CARS_COLLECTION, CARS_VECTOR_INDEX, embedTexts } from "../../shared/utils/embedding.ts";

export const SEARCH_MAX_QUERY_LENGTH = 500;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;

// Thrown for bad client input; the handler turns it into a 400.
export class SearchInputError extends Error {}

// S1: only JSON. Browsers can send form-encoded or text/plain POSTs cross-site
// without a CORS preflight, and h3 would parse form bodies into an object.
export function isJsonContentType(header: string | undefined) {
    return header?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

// S2: strict types. Anything that isn't exactly a string query and an integer
// limit is rejected, so request data can never become a Mongo operator.
export function parseSearchBody(body: unknown): { query: string; limit: number } {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new SearchInputError("Body must be a JSON object");
    }
    const { query, limit = SEARCH_DEFAULT_LIMIT } = body as Record<string, unknown>;

    if (typeof query !== "string") throw new SearchInputError("query must be a string");
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > SEARCH_MAX_QUERY_LENGTH) {
        throw new SearchInputError(`query must be 1-${SEARCH_MAX_QUERY_LENGTH} characters`);
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
        throw new SearchInputError(`limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
    }
    return { query: trimmed, limit };
}

// --- Model years in the query -----------------------------------------------

// A single typed year matches models sold within this many years of it.
export const YEAR_WINDOW = 2;

// Only 1980-2099 count as model years, so "1965 mustang" or a name like
// "1955 Custom Belair" is searched by meaning, not filtered to nothing.
const YEAR = String.raw`(?:19[89]\d|20\d\d)`;
const YEAR_RE = new RegExp(String.raw`\b${YEAR}\b`, "g");
// What to strip from the text we embed: a range ("2016-2019", "from 2016 to
// 2019", "between 2016 and 2019") or a single year ("in 2018").
const RANGE_PHRASE = new RegExp(
    String.raw`\b(?:(?:between|from)\s+)?${YEAR}\s*(?:-|–|—|to|through|thru|and)\s*${YEAR}\b`,
    "gi",
);
const YEAR_PHRASE = new RegExp(String.raw`\b(?:(?:in|from)\s+)?${YEAR}\b`, "gi");

export type ParsedQuery = { text: string; years: YearRange | null };

// "2018 accord" -> { text: "accord", years: [2016, 2020] }
// "2016-2019 accord" -> { text: "accord", years: [2016, 2019] }
// Two or more years make an exact range from the earliest to the latest.
// Known limit: only the range words above are stripped, so connectors we don't
// know stay in the text ("civic 2019 or 2021" embeds "civic or"). Harmless for
// ranking; extend RANGE_PHRASE if a phrasing matters.
export function parseYearFilter(query: string): ParsedQuery {
    const found = (query.match(YEAR_RE) ?? []).map(Number);
    if (!found.length) return { text: query, years: null };

    const from = Math.min(...found);
    const to = Math.max(...found);
    const years: YearRange = from === to ? [from - YEAR_WINDOW, to + YEAR_WINDOW] : [from, to];

    // Embed the rest of the request; years carry little meaning to the model.
    // A query that was only a year keeps its text, since something has to be embedded.
    const text = query.replace(RANGE_PHRASE, " ").replace(YEAR_PHRASE, " ").replace(/\s+/g, " ").trim();
    return { text: text || query, years };
}

// --- Search -----------------------------------------------------------------

export async function searchCars(db: Db, openai: OpenAI, query: ParsedQuery, limit: number): Promise<SearchResult[]> {
    const [queryVector] = await embedTexts(openai, [query.text]);
    if (!queryVector) throw new Error("Embedding API returned no vector");

    // `years` is an array per model, so $in means "sold in any year of the range".
    // (Separate $gte/$lte could each match a *different* year and let gaps through.)
    let filter: { years: { $in: number[] } } | undefined;
    if (query.years) {
        const [from, to] = query.years;
        filter = { years: { $in: Array.from({ length: to - from + 1 }, (_, i) => from + i) } };
    }

    return db
        .collection<CarDoc>(CARS_COLLECTION)
        .aggregate<SearchResult>([
            {
                $vectorSearch: {
                    index: CARS_VECTOR_INDEX,
                    path: "embedding",
                    queryVector,
                    numCandidates: limit * 20,
                    limit,
                    ...(filter && { filter }),
                },
            },
            { $set: { score: { $meta: "vectorSearchScore" } } },
            // Server-only fields never reach the client.
            { $unset: ["embedding", "embeddingModel"] },
        ])
        .toArray();
}
