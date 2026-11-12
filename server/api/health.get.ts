// GET /api/health -> { status: "ok" } when the server can reach Mongo, 503 when it can't.
// OpenAI isn't checked: that would spend a request on every health check.
export default defineEventHandler(async () => {
    try {
        await (await getDb()).command({ ping: 1 });
        return { status: "ok" };
    } catch (err) {
        // S6: details stay in the server log; the client gets a generic message.
        console.error("health check failed:", err instanceof Error ? err.message : err);
        throw createError({ statusCode: 503, statusMessage: "Database is unavailable right now" });
    }
});
