// The MCP server end to end over real stdio: docs/specs/mcp-server.md, build
// step 2. Starts mcp/server.ts as a child process against a stand-in OpenAI
// and a throwaway database (dropped afterwards). Needs `docker compose up -d`;
// override the server with TEST_MONGODB_URI.
//
// S18 is checked by every test: the SDK's client parses each stdout line as a
// protocol message, and reports anything else through `onerror`.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MongoClient, type Db } from "mongodb";
import OpenAI from "openai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureVectorIndex, groupModels, ingestModels } from "../../scripts/lib/ingest.ts";
import { parseYearFilter, searchCars } from "../../server/utils/search.ts";
import type { Car, CarDoc } from "../../shared/types/car.ts";
import { CARS_COLLECTION } from "../../shared/utils/embedding.ts";
import { DESCRIPTION_NOTE, SEARCH_UNAVAILABLE, type ToolResult } from "../../mcp/search-tool.ts";
import { startFakeOpenAI, type FakeOpenAI } from "../fixtures/fake-openai.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SERVER = join(ROOT, "mcp", "server.ts");
const baseUri = process.env.TEST_MONGODB_URI ?? "mongodb://localhost:27017/?directConnection=true";

// The same URI with a database name, which the server reads with mongo.db().
function uriFor(dbName: string, base = baseUri) {
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    return url.toString();
}

const row = (make: string, makeId: number, model: string, modelId: number, year: number): Car => ({
    make,
    makeId,
    model,
    modelId,
    year,
});
const rows: Car[] = [
    row("HONDA", 474, "Civic", 1863, 2019),
    row("HONDA", 474, "Civic", 1863, 2020),
    row("HONDA", 474, "Accord", 1861, 2020),
    row("BMW", 452, "M3", 2084, 2020),
    row("TOYOTA", 448, "Corolla", 2208, 2020),
];

type Session = { client: Client; errors: Error[]; stderr: () => string };

// Starts the server through the SDK's client, collecting protocol errors and stderr.
async function startServer(env: Record<string, string>): Promise<Session> {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        cwd: ROOT,
        env,
        stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    const client = new Client({ name: "mcp-server-test", version: "1.0.0" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);
    await client.connect(transport);
    return { client, errors, stderr: () => stderr };
}

describe("MCP server over stdio", () => {
    let mongo: MongoClient;
    let db: Db;
    let fake: FakeOpenAI;
    let openai: OpenAI;
    let session: Session;
    const dbName = `vectorrag_mcp_test_${Date.now()}`;

    beforeAll(async () => {
        fake = await startFakeOpenAI();
        openai = new OpenAI({ apiKey: "test", baseURL: fake.baseURL, maxRetries: 0 });
        mongo = new MongoClient(baseUri, { serverSelectionTimeoutMS: 5000 });
        await mongo.connect();
        db = mongo.db(dbName);
        const cars = db.collection<CarDoc>(CARS_COLLECTION);
        await ingestModels(cars, openai, groupModels(rows), () => {});
        await ensureVectorIndex(cars, { waitMs: 60_000, log: () => {} });

        session = await startServer({
            NUXT_MONGODB_URI: uriFor(dbName),
            NUXT_OPENAI_KEY: "test",
            OPENAI_BASE_URL: fake.baseURL,
        });
    }, 90_000);

    afterAll(async () => {
        await session?.client.close();
        await db?.dropDatabase();
        await mongo?.close();
        await fake?.close();
    });

    afterEach(() => {
        // S18: nothing but protocol messages reached stdout.
        expect(session.errors).toEqual([]);
    });

    it("lists one read-only tool with its input schema and description", async () => {
        const { tools } = await session.client.listTools();

        expect(tools.map((t) => t.name)).toEqual(["search_cars"]);
        const tool = tools[0]!;
        expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(["limit", "query"]);
        expect(tool.inputSchema.required).toEqual(["query"]);
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
        expect(tool.description).toContain("nothingClose");
        expect(tool.outputSchema).toBeDefined();
    });

    it("returns the same cars, in the same order, as the web's search", async () => {
        const res = await session.client.callTool({ name: "search_cars", arguments: { query: "civic", limit: 3 } });

        expect(res.isError).toBeFalsy();
        const result = res.structuredContent as ToolResult;
        const direct = await searchCars(db, openai, parseYearFilter("civic"), 3);
        expect(result.results.map((r) => r.id)).toEqual(direct.map((r) => r._id));
        expect(result.results[0]).toMatchObject({ make: "Honda", model: "Civic" });
        expect(result.note).toBe(DESCRIPTION_NOTE);
        // The text block carries the same data, for clients that only read text.
        const [block] = res.content as { type: string; text: string }[];
        expect(JSON.parse(block!.text)).toEqual(result);
    });

    it("filters by a year in the query and reports the range", async () => {
        const res = await session.client.callTool({ name: "search_cars", arguments: { query: "2020 civic" } });

        const result = res.structuredContent as ToolResult;
        expect(result.years).toEqual([2018, 2022]);
        expect(result.results.every((r) => r.years.some((y) => y >= 2018 && y <= 2022))).toBe(true);
    });

    it("never sends scores, vectors or embedded text", async () => {
        const res = await session.client.callTool({ name: "search_cars", arguments: { query: "bmw m3" } });

        const text = JSON.stringify(res);
        expect(text).not.toMatch(/"score"|embedding/);
    });

    it.each([
        ["an empty query", { query: "" }],
        ["a limit over 10", { query: "civic", limit: 11 }],
        ["a string limit", { query: "civic", limit: "5" }],
        ["no query", {}],
    ])("refuses %s as a tool error, without searching", async (_name, args) => {
        const before = fake.calls();
        const res = await session.client.callTool({ name: "search_cars", arguments: args });

        expect(res.isError).toBe(true);
        expect(fake.calls()).toBe(before);
    });

    it("ignores fields that aren't in the schema", async () => {
        const plain = await session.client.callTool({ name: "search_cars", arguments: { query: "accord" } });
        const extra = await session.client.callTool({
            name: "search_cars",
            arguments: { query: "accord", year: 1990, filter: { $where: "1" } },
        });

        expect(extra.isError).toBeFalsy();
        expect(extra.structuredContent).toEqual(plain.structuredContent);
    });
});

describe("MCP server failures", () => {
    let fake: FakeOpenAI;

    beforeAll(async () => {
        fake = await startFakeOpenAI();
    });

    afterAll(async () => {
        await fake?.close();
    });

    it("with Mongo unreachable: a generic tool error, details on stderr only, protocol intact (S18, S22)", async () => {
        // Nothing listens on port 9; the short timeout keeps the test fast.
        const session = await startServer({
            NUXT_MONGODB_URI: "mongodb://127.0.0.1:9/cars?directConnection=true&serverSelectionTimeoutMS=500",
            NUXT_OPENAI_KEY: "test",
            OPENAI_BASE_URL: fake.baseURL,
        });
        try {
            const res = await session.client.callTool({ name: "search_cars", arguments: { query: "civic" } });

            // S18 first: a log line on stdout shows up here as a protocol error.
            expect(session.errors).toEqual([]);
            expect(res.isError).toBe(true);
            expect(res.content).toEqual([{ type: "text", text: SEARCH_UNAVAILABLE }]);
            expect(session.stderr()).toContain("search_cars failed:");
            expect(session.stderr()).not.toContain("NUXT_OPENAI_KEY");
        } finally {
            await session.client.close();
        }
    }, 20_000);

    it("exits with a message on stderr, and nothing on stdout, when settings are missing", () => {
        const run = spawnSync(process.execPath, [SERVER], {
            cwd: ROOT,
            env: { PATH: process.env.PATH ?? "" },
            encoding: "utf8",
            timeout: 10_000,
        });

        expect(run.status).toBe(1);
        expect(run.stdout).toBe("");
        expect(run.stderr).toContain("missing NUXT_MONGODB_URI and NUXT_OPENAI_KEY");
    });
});
