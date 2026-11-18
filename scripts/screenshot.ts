// Screenshots the search page in headless Chromium: light, dark and phone width.
// Usage: pnpm screenshot [--query "2018 corolla"] [--real] [--url http://localhost:3000]
//   default  /api/search is answered with made-up results, so it costs nothing,
//            and the answer panel is shot in every state with made-up answers
//            (answer-*.png); /api/answer is never really called
//   --real   uses the real search API (one OpenAI embeddings call per screenshot);
//            skips the answer panel states
// Needs `pnpm dev` running, and the browser downloaded once: pnpm browser:install
// Writes to screenshots/ (not committed). Exits 1 if the page logs console errors.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import type { AnswerLimitReason, AnswerResponse, SearchResponse } from "../shared/types/car.ts";

const OUT_DIR = join(import.meta.dirname, "..", "screenshots");

const { values: args } = parseArgs({
    options: {
        query: { type: "string", default: "2018 corolla" },
        real: { type: "boolean", default: false },
        url: { type: "string", default: "http://localhost:3000" },
    },
});

// Covers every part of a result row: description or not, long and short year spans.
// Written as tuples for brevity, hence the `as` casts below; it's fixture data
// for a dev script, so a typed object list wasn't worth the extra lines.
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const mock: SearchResponse = {
    years: [2016, 2020],
    nothingClose: false,
    results: [
        ["2208", "TOYOTA", "Corolla", span(2016, 2026), 0.853, "Compact sedan/hatchback in the mainstream price segment, known for fuel efficiency, reliability, and strong resale value."],
        ["40428", "TOYOTA", "GR Corolla", span(2023, 2026), 0.842, "Performance hot hatch known for its turbocharged three-cylinder engine and all-wheel drive."],
        ["13385", "TOYOTA", "Corolla iM", span(2017, 2018), 0.811, undefined],
        ["2209", "TOYOTA", "Camry", span(2016, 2026), 0.802, "Midsize sedan known for comfort, reliability, and a spacious interior."],
        ["2229", "TOYOTA", "Yaris", span(2016, 2020), 0.798, "Lesser-known model from TOYOTA."],
    ].map(([modelId, make, model, years, score, description]) => ({
        _id: `448-${modelId}`,
        make: make as string,
        makeId: 448,
        model: model as string,
        modelId: Number(modelId),
        years: years as number[],
        score: score as number,
        ...(description ? { description: description as string } : {}),
        embeddingText: `${make} ${model}${description ? `. ${description}` : ""}`,
    })),
};

// The answer panel's states (docs/specs/generate.md, step 5). Each mocks
// /api/answer's reply (`null` never replies, to catch loading) and names the
// panel's `data-state` to wait for. `page: true` shoots the whole page, since
// picks also mark the result cards; the rest shoot just the panel.
const answer = (body: AnswerResponse) => ({ status: 200, json: body });
const limited = (reason: AnswerLimitReason) => ({ status: 429, json: { statusCode: 429, data: { reason } } });
type PanelState = {
    name: string;
    reply: { status: number; json: unknown } | null;
    expect: "loading" | "answer" | "problem";
    page?: boolean;
};
const panelStates: PanelState[] = [
    {
        name: "picks",
        expect: "answer",
        page: true,
        reply: answer({
            source: "model",
            answer: {
                noneFit: false,
                picks: [
                    { carId: "448-2208", reason: "A compact sedan known for reliability and fuel efficiency, sold across 2016–2020." },
                    { carId: "448-13385", reason: "The Corolla hatchback version, sold in 2017 and 2018." },
                ],
            },
        }),
    },
    { name: "refusal", expect: "answer", reply: answer({ source: "model", answer: { noneFit: true, picks: [] } }) },
    { name: "minute", expect: "problem", reply: limited("try-again-in-a-minute") },
    { name: "paused", expect: "problem", reply: limited("paused-for-today") },
    { name: "quota", expect: "problem", reply: limited("out-of-quota") },
    { name: "failed", expect: "problem", reply: { status: 502, json: { statusCode: 502 } } },
    { name: "stale", expect: "problem", reply: { status: 400, json: { statusCode: 400 } } },
    { name: "loading", expect: "loading", reply: null },
];

const shots = [
    { name: "desktop", viewport: { width: 1280, height: 900 }, colorScheme: "light" },
    { name: "dark", viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
    { name: "phone", viewport: { width: 390, height: 844 }, colorScheme: "light" },
] as const;

try {
    await fetch(args.url, { signal: AbortSignal.timeout(5000) });
} catch {
    console.error(`Nothing answering at ${args.url}. Start the app with pnpm dev first.`);
    process.exit(1);
}

let browser: Browser;
try {
    browser = await chromium.launch();
} catch (err) {
    console.error("Couldn't start headless Chromium. Download it once with: pnpm browser:install");
    console.error(err instanceof Error ? err.message.split("\n")[0] : err);
    process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
const errors: string[] = [];

// Opens the page and runs the search. `allowHttpErrors`: the panel states fail
// requests on purpose, and Chromium logs each failed response as a console error.
async function openSearch(shot: (typeof shots)[number], allowHttpErrors = false): Promise<Page> {
    const page = await browser.newPage({
        viewport: shot.viewport,
        colorScheme: shot.colorScheme,
        // Skip the bar animation so screenshots show final widths.
        reducedMotion: "reduce",
    });
    page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        if (allowHttpErrors && msg.text().startsWith("Failed to load resource")) return;
        errors.push(`${shot.name}: ${msg.text()}`);
    });
    if (!args.real) await page.route("**/api/search", (route) => route.fulfill({ json: mock }));

    await page.goto(args.url, { waitUntil: "networkidle" });
    // The Nuxt devtools button floats over the page in dev; it isn't part of the design.
    await page.addStyleTag({ content: "#nuxt-devtools-container { display: none !important; }" });
    await page.getByRole("textbox").fill(args.query);
    await page.getByRole("button", { name: "Search" }).click();
    // Results heading, "no results" notice, or error: whichever the search produced.
    await page.locator("#results-title, .notice").first().waitFor({ timeout: 30_000 });
    return page;
}

try {
    for (const shot of shots) {
        const page = await openSearch(shot);
        const path = join(OUT_DIR, `search-${shot.name}.png`);
        await page.screenshot({ path, fullPage: true });
        console.log(`  ${path}`);
        await page.close();
    }

    // The answer panel in each state, with /api/answer mocked (mocked runs only).
    if (!args.real) {
        for (const state of panelStates) {
            // Picks are also shot in dark mode and at phone width, to check the marked cards.
            const variants = state.page ? shots : [shots[0]];
            for (const shot of variants) {
                const page = await openSearch(shot, true);
                await page.route("**/api/answer", (route) => (state.reply ? route.fulfill(state.reply) : undefined));
                await page.getByRole("button", { name: "Explain these results" }).click();
                const panel = page.locator(`.answer-panel[data-state="${state.expect}"]`);
                await panel.waitFor({ timeout: 10_000 });

                const suffix = shot === shots[0] ? "" : `-${shot.name}`;
                const path = join(OUT_DIR, `answer-${state.name}${suffix}.png`);
                // Frozen animations, so the loading spinner is shot in a fixed position.
                const options = { path, animations: "disabled" } as const;
                await (state.page ? page.screenshot({ ...options, fullPage: true }) : panel.screenshot(options));
                console.log(`  ${path}`);
                await page.close();
            }
        }
    }
} finally {
    await browser.close();
}

console.log(`${args.real ? "Real" : "Mocked"} search for "${args.query}".`);
if (errors.length) {
    console.error(`Console errors:\n  ${errors.join("\n  ")}`);
    process.exitCode = 1;
}
