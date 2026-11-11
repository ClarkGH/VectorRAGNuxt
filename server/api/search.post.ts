// POST /api/search { query: string, limit?: number } -> SearchResponse
// The logic lives in server/utils/search.ts; this file maps it onto HTTP.
export default defineEventHandler(async (event): Promise<SearchResponse> => {
    if (!isJsonContentType(getRequestHeader(event, "content-type"))) {
        throw createError({ statusCode: 415, statusMessage: "Content-Type must be application/json" });
    }

    let input: { query: string; limit: number };
    try {
        input = parseSearchBody(await readBody(event));
    } catch (err) {
        if (err instanceof SearchInputError) throw createError({ statusCode: 400, statusMessage: err.message });
        throw err;
    }

    const parsed = parseYearFilter(input.query);
    try {
        const results = await searchCars(await getDb(), getOpenAI(), parsed, input.limit);
        return { results, years: parsed.years };
    } catch (err) {
        // S6: details stay in the server log; the client gets a generic message.
        console.error("search failed:", err instanceof Error ? err.message : err);
        throw createError({ statusCode: 502, statusMessage: "Search is unavailable right now" });
    }
});
