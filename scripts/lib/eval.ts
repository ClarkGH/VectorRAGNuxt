// Search-quality metrics and the win/loss rules from docs/evaluation.md.
// Pure functions, so the math is unit-tested; scripts/eval.ts does the I/O.

export const K = 5; // every metric looks at the top 5 results

// --- The golden set (eval/golden.json) ---------------------------------------

export type LabeledKind = "exact" | "trim" | "year" | "concept";
export type LabeledQuery = { kind: LabeledKind; query: string; relevant: Record<string, number>; reviewed: boolean };
// No right answer exists: only the top score is recorded.
export type FloorQuery = { kind: "floor"; query: string; reviewed: boolean; note?: string };
export type GoldenSet = { version: 1; queries: (LabeledQuery | FloorQuery)[] };

// --- Metrics -----------------------------------------------------------------

// Grades of the returned cars, in result order (unlisted cars are 0).
export function gradesOf(ids: string[], relevant: Record<string, number>) {
    return ids.slice(0, K).map((id) => relevant[id] ?? 0);
}

export const hitAt1 = (grades: number[]) => ((grades[0] ?? 0) > 0 ? 1 : 0);

// 1 / position of the first right answer; 0 if none in the top K.
export function reciprocalRank(grades: number[]) {
    const i = grades.findIndex((g) => g > 0);
    return i < 0 ? 0 : 1 / (i + 1);
}

// Share of the right answers found in the top K. Capped at K, so a search with
// 9 right answers can still score 1.0 by filling the top 5 with them.
export function recallAtK(grades: number[], relevant: Record<string, number>) {
    const possible = Math.min(Object.keys(relevant).length, K);
    return possible ? grades.filter((g) => g > 0).length / possible : 0;
}

const dcg = (grades: number[]) => grades.slice(0, K).reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);

// DCG divided by the best possible DCG for this search's labels.
export function ndcgAtK(grades: number[], relevant: Record<string, number>) {
    const ideal = dcg(Object.values(relevant).sort((a, b) => b - a));
    return ideal ? dcg(grades) / ideal : 0;
}

// --- One run ------------------------------------------------------------------

export type LabeledScore = {
    kind: LabeledKind;
    query: string;
    ids: string[];
    hit1: number;
    rr: number;
    recall: number;
    ndcg: number;
    // Grade of the #1 result (0 if unlisted), for the guardrail. Missing from runs saved before 2026-11-13.
    top1Grade?: number;
};
export type FloorScore = { kind: "floor"; query: string; ids: string[]; topScore: number };
export type QueryScore = LabeledScore | FloorScore;

export function scoreQuery(q: LabeledQuery | FloorQuery, ids: string[], scores: number[]): QueryScore {
    if (q.kind === "floor") return { kind: "floor", query: q.query, ids, topScore: scores[0] ?? 0 };
    const grades = gradesOf(ids, q.relevant);
    return {
        kind: q.kind,
        query: q.query,
        ids,
        hit1: hitAt1(grades),
        rr: reciprocalRank(grades),
        recall: recallAtK(grades, q.relevant),
        ndcg: ndcgAtK(grades, q.relevant),
        top1Grade: grades[0] ?? 0,
    };
}

export type EvalRun = {
    label: string;
    db: string;
    ranAt: string;
    embeddingModel: string;
    unreviewed: number;
    // Top score of each labeled search's first result, for the floor comparison.
    labeledTopScores: number[];
    queries: QueryScore[];
};

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const isLabeled = (s: QueryScore): s is LabeledScore => s.kind !== "floor";

// --- Comparing two runs: the pre-registered rules ----------------------------

export const RULES = {
    minGain: 0.05, // smallest nDCG@5 gain worth the cost of a change
    // Exact names mustn't get worse. Only the exact car counts at #1 (grade 2): exact
    // searches grade variants as 1 (Civic Si for "honda civic"), and a variant on
    // top is the failure this guards against. Decided 2026-11-13, before the reviewed re-run.
    guardrail: { kind: "exact" as const, top1Grade: 2, maxHit1Drop: 0.1 },
    bootstrapIters: 10_000,
};

// Seeded, so a comparison prints the same interval every time.
function seeded(seed: number) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Paired bootstrap: resample the *searches* (the only source of uncertainty,
// since search is deterministic) and take the middle 95% of the mean difference.
export function bootstrapCI(diffs: number[], iters = RULES.bootstrapIters, seed = 7): [number, number] {
    if (!diffs.length) return [0, 0];
    const rand = seeded(seed);
    const means: number[] = [];
    for (let i = 0; i < iters; i++) {
        let sum = 0;
        for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(rand() * diffs.length)]!;
        means.push(sum / diffs.length);
    }
    means.sort((a, b) => a - b);
    return [means[Math.floor(iters * 0.025)]!, means[Math.floor(iters * 0.975)]!];
}

export type Comparison = {
    paired: number;
    delta: number;
    ci: [number, number];
    guardrailDrop: number;
    call: "WIN" | "LOSS" | "INCONCLUSIVE";
    reason: string;
};

// 1 if the exact car (grade 2) is #1. Runs saved before top1Grade existed only had
// grade-2 labels on exact searches, so their Hit@1 means the same thing.
export const exactAt1 = (s: LabeledScore) =>
    ((s.top1Grade ?? (s.hit1 ? RULES.guardrail.top1Grade : 0)) >= RULES.guardrail.top1Grade ? 1 : 0);

// B against A (A is the baseline). Only searches present in both runs count.
export function compareRuns(a: EvalRun, b: EvalRun): Comparison {
    const byQuery = new Map(a.queries.filter(isLabeled).map((s) => [s.query, s]));
    const pairs = b.queries
        .filter(isLabeled)
        .flatMap((sb) => (byQuery.has(sb.query) ? [[byQuery.get(sb.query)!, sb] as const] : []));

    const diffs = pairs.map(([sa, sb]) => sb.ndcg - sa.ndcg);
    const delta = mean(diffs);
    const ci = bootstrapCI(diffs);
    const guard = pairs.filter(([sa]) => sa.kind === RULES.guardrail.kind);
    const guardrailDrop = mean(guard.map(([sa]) => exactAt1(sa))) - mean(guard.map(([, sb]) => exactAt1(sb)));

    let call: Comparison["call"] = "INCONCLUSIVE";
    let reason = delta < RULES.minGain
        ? `gain below the ${RULES.minGain} bar`
        : "interval includes zero: could be which searches we picked";
    if (guardrailDrop > RULES.guardrail.maxHit1Drop) {
        call = "LOSS";
        reason = `guardrail: exact car at #1 fell ${guardrailDrop.toFixed(2)}`;
    } else if (ci[1] < 0) {
        call = "LOSS";
        reason = "reliably worse (whole interval below zero)";
    } else if (ci[0] > 0 && delta >= RULES.minGain) {
        call = "WIN";
        reason = `at least ${RULES.minGain} better, interval above zero, guardrail held`;
    }
    return { paired: pairs.length, delta, ci, guardrailDrop, call, reason };
}
