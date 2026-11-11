// GET /api/catalog -> CatalogSummary: how many models are loaded, and their year range.
export default defineEventHandler(async (): Promise<CatalogSummary> => {
    try {
        return await getCatalogSummary(await getDb());
    } catch (err) {
        // S6: details stay in the server log; the client gets a generic message.
        console.error("catalog failed:", err instanceof Error ? err.message : err);
        throw createError({ statusCode: 502, statusMessage: "Catalog is unavailable right now" });
    }
});
