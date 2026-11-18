// A stand-in for the two OpenAI endpoints we use, so tests run without a key or network:
//   /v1/embeddings: hashed character trigrams, normalized. Similar *spellings*
//     land close together. That exercises the whole pipeline; it says nothing
//     about real-world match quality.
//   /v1/responses: returns `describe(car)` as the structured description reply.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { EMBEDDING_DIMENSIONS } from "../../shared/utils/embedding.ts";

export function fakeVector(text: string): number[] {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const padded = `  ${text.toLowerCase()}  `;
    for (let i = 0; i < padded.length - 2; i++) {
        let h = 2166136261;
        for (const c of padded.slice(i, i + 3)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
        const slot = (h >>> 0) % EMBEDDING_DIMENSIONS;
        v[slot] = (v[slot] ?? 0) + 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
}

type DescribeInput = { id: string; make: string; model: string; modelYears: string };
type DescribeEntry = { id: string; description: string };

// What the answer prompt sends (server/utils/answer.ts, buildAnswerInput).
export type AnswerInput = { search: string; modelYears: string | null; cars: { id: string }[] };
// How the fake replies to an answer request: reply text (optionally cut short,
// as when the model runs out of tokens), or an HTTP error such as a 429.
// `code` is OpenAI's error code, such as "insufficient_quota".
export type AnswerReplyPlan
    = | { text: string; incomplete?: boolean }
        | { error: number; message: string; code?: string };

// Default: pick the top car, a valid answer.
const pickTopCar = (input: AnswerInput): AnswerReplyPlan => ({
    text: JSON.stringify({ noneFit: false, picks: [{ carId: input.cars[0]?.id, reason: "Fits the search." }] }),
});

export type FakeOpenAI = {
    baseURL: string;
    // Every request: embeddings and responses.
    calls: () => number;
    // Bodies sent to /v1/responses, for checking what the model would see.
    responseRequests: Record<string, unknown>[];
    // Changes how later answer requests are replied to.
    setAnswer: (plan: (input: AnswerInput) => AnswerReplyPlan) => void;
    close: () => Promise<void>;
};

// Starts on a random free port. Point the OpenAI client at `baseURL`.
// `describe` decides each car's reply text (null leaves the car out);
// `extra` entries are appended to every reply, to play a misbehaving model.
export async function startFakeOpenAI({
    describe = (car: DescribeInput): string | null => `${car.make} ${car.model} is a test car.`,
    extra = [] as DescribeEntry[],
} = {}): Promise<FakeOpenAI> {
    let calls = 0;
    let answer = pickTopCar;
    const responseRequests: Record<string, unknown>[] = [];
    const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
    };
    const reply = (res: import("node:http").ServerResponse, model: unknown, text: string, status = "completed") => {
        json(res, {
            id: `resp_${calls}`,
            object: "response",
            status,
            model,
            output: [
                {
                    type: "message",
                    id: `msg_${calls}`,
                    role: "assistant",
                    status,
                    content: [{ type: "output_text", text, annotations: [] }],
                },
            ],
        });
    };

    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk));
        req.on("end", () => {
            if (req.method !== "POST") {
                res.writeHead(404).end();
                return;
            }
            if (req.url?.endsWith("/embeddings")) {
                calls++;
                const { input, model } = JSON.parse(body) as { input: string | string[]; model: string };
                const inputs = Array.isArray(input) ? input : [input];
                json(res, {
                    object: "list",
                    model,
                    data: inputs.map((text, index) => ({ object: "embedding", index, embedding: fakeVector(text) })),
                    usage: { prompt_tokens: 0, total_tokens: 0 },
                });
                return;
            }
            if (req.url?.endsWith("/responses")) {
                calls++;
                const request = JSON.parse(body) as Record<string, unknown>;
                responseRequests.push(request);
                const format = (request.text as { format?: { name?: string } } | undefined)?.format?.name;

                // An answer request (its schema is named "car_answer").
                if (format === "car_answer") {
                    const plan = answer(JSON.parse(String(request.input)) as AnswerInput);
                    if ("error" in plan) {
                        const error = { message: plan.message, type: "requests", code: plan.code ?? null };
                        json(res, { error }, plan.error);
                    } else {
                        reply(res, request.model, plan.text, plan.incomplete ? "incomplete" : "completed");
                    }
                    return;
                }

                // A describe request.
                const { cars } = JSON.parse(String(request.input)) as { cars: DescribeInput[] };
                const entries: DescribeEntry[] = [];
                for (const car of cars) {
                    const description = describe(car);
                    if (description !== null) entries.push({ id: car.id, description });
                }
                reply(res, request.model, JSON.stringify({ cars: [...entries, ...extra] }));
                return;
            }
            res.writeHead(404).end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        baseURL: `http://127.0.0.1:${port}/v1`,
        calls: () => calls,
        responseRequests,
        setAnswer: (plan) => {
            answer = plan;
        },
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}
