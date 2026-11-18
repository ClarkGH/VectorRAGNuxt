// POST /api/answer { query: string, resultIds: string[] } -> AnswerResponse
// The work lives in server/utils/answer-service.ts; this file maps it onto HTTP.
// Rules: docs/specs/generate.md (decisions 1–6, S11–S16).

// One limiter and one memory of rejected answers for the whole server (S14).
const limiter = createMinuteLimiter();
const rejections = createRejectionMemory();

const limited = (reason: AnswerLimitReason, message: string) =>
    createError({ statusCode: 429, statusMessage: message, data: { reason } });

export default defineEventHandler(async (event): Promise<AnswerResponse> => {
    // S1: JSON only, as for /api/search.
    if (!isJsonContentType(getRequestHeader(event, "content-type"))) {
        throw createError({ statusCode: 415, statusMessage: "Content-Type must be application/json" });
    }

    let input: AnswerRequest;
    try {
        input = parseAnswerBody(await readBody(event));
    } catch (err) {
        if (err instanceof AnswerInputError) throw createError({ statusCode: 400, statusMessage: err.message });
        throw err;
    }

    let outcome: AnswerOutcome;
    try {
        outcome = await answerSearch(
            { db: await getDb(), openai: getOpenAI(), mock: useRuntimeConfig().answerMock, limiter, rejections },
            input,
        );
    } catch (err) {
        // S6: details stay in the server log; the client gets a generic message.
        console.error("answer failed:", err instanceof Error ? err.message : err);
        throw createError({ statusCode: 502, statusMessage: "Answers are unavailable right now" });
    }

    switch (outcome.kind) {
        case "answer":
            return { answer: outcome.answer, source: outcome.source };
        case "unknown-ids":
            throw createError({ statusCode: 400, statusMessage: "resultIds must be cars from the catalog" });
        case "busy":
        case "minute-limit":
            throw limited("try-again-in-a-minute", "Too many answers this minute; try again in a minute");
        case "daily-limit":
            throw limited("paused-for-today", "Answers are paused for today");
        case "out-of-quota":
            console.error("answer failed: the OpenAI account is out of quota");
            throw limited("out-of-quota", "Answers are unavailable: the OpenAI account is out of credit");
        case "bad-answer":
            // S6: the reason code only, never the answer text.
            console.error(outcome.repeat ? "answer refused, rejected recently:" : "answer dropped:", outcome.reason);
            throw createError({ statusCode: 502, statusMessage: "Couldn't write a reliable answer this time" });
    }
});
