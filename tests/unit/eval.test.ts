// Metric math and win/loss rules for pnpm eval (docs/evaluation.md).
import { describe, expect, it } from "vitest";
import {
    compareRuns,
    gradesOf,
    hitAt1,
    ndcgAtK,
    recallAtK,
    reciprocalRank,
    type EvalRun,
    type LabeledScore,
} from "../../scripts/lib/eval.ts";

describe("metrics", () => {
    // The worked example in docs/evaluation.md: one grade-2 and one grade-1 answer.
    const relevant = { a: 2, b: 1 };

    it("nDCG@5 matches the doc's worked example", () => {
        expect(ndcgAtK(gradesOf(["x", "a", "y", "b", "z"], relevant), relevant)).toBeCloseTo(0.64, 2);
        expect(ndcgAtK(gradesOf(["a", "x", "y", "b", "z"], relevant), relevant)).toBeCloseTo(0.94, 2);
        expect(ndcgAtK(gradesOf(["a", "b"], relevant), relevant)).toBe(1);
        expect(ndcgAtK(gradesOf(["x", "y"], relevant), relevant)).toBe(0);
    });

    it("Hit@1 and reciprocal rank look at the first right answer", () => {
        expect(hitAt1([0, 2])).toBe(0);
        expect(hitAt1([1, 0])).toBe(1);
        expect(reciprocalRank([0, 0, 2])).toBeCloseTo(1 / 3);
        expect(reciprocalRank([0, 0, 0])).toBe(0);
    });

    it("recall is capped at 5, so many right answers can still score 1.0", () => {
        const many = Object.fromEntries(["a", "b", "c", "d", "e", "f", "g"].map((id) => [id, 1]));
        expect(recallAtK(gradesOf(["a", "b", "c", "d", "e"], many), many)).toBe(1);
        expect(recallAtK(gradesOf(["a", "x"], relevant), relevant)).toBe(0.5);
    });

    it("only the top 5 results count", () => {
        expect(gradesOf(["x", "x", "x", "x", "x", "a"], relevant)).toEqual([0, 0, 0, 0, 0]);
    });
});

describe("compareRuns", () => {
    const score = (query: string, kind: LabeledScore["kind"], ndcg: number, hit1 = 1): LabeledScore => ({
        kind,
        query,
        ids: [],
        hit1,
        rr: hit1,
        recall: hit1,
        ndcg,
    });
    const run = (queries: LabeledScore[]): EvalRun => ({
        label: "t",
        db: "t",
        ranAt: "",
        embeddingModel: "",
        unreviewed: 0,
        labeledTopScores: [],
        queries,
    });
    const exact = Array.from({ length: 6 }, (_, i) => `exact ${i}`);
    const concept = Array.from({ length: 12 }, (_, i) => `concept ${i}`);
    // Baseline: names fine, concepts weak.
    const base = run([...exact.map((q) => score(q, "exact", 1)), ...concept.map((q) => score(q, "concept", 0.4))]);

    it("WIN: a clear, consistent gain with names unharmed", () => {
        const better = run([...exact.map((q) => score(q, "exact", 1)), ...concept.map((q) => score(q, "concept", 0.6))]);
        expect(compareRuns(base, better).call).toBe("WIN");
    });

    it("LOSS by guardrail: concepts improve but exact names lose their top spot", () => {
        const diluted = run([
            ...exact.map((q, i) => score(q, "exact", i < 3 ? 0.5 : 1, i < 3 ? 0 : 1)),
            ...concept.map((q) => score(q, "concept", 0.7)),
        ]);
        const c = compareRuns(base, diluted);
        expect(c.delta).toBeGreaterThan(0); // the average went up...
        expect(c.call).toBe("LOSS"); // ...and it's still a loss
    });

    it("LOSS by guardrail: a variant (grade 1) takes the exact car's #1 spot", () => {
        // Hit@1 still says 1 (a labeled car is first), but it's the Civic Si, not the Civic.
        const graded = (q: string, top1Grade: number) => ({ ...score(q, "exact", 1), top1Grade });
        const before = run([...exact.map((q) => graded(q, 2)), ...concept.map((q) => score(q, "concept", 0.4))]);
        const variantFirst = run([
            ...exact.map((q, i) => graded(q, i < 3 ? 1 : 2)),
            ...concept.map((q) => score(q, "concept", 0.7)),
        ]);
        const c = compareRuns(before, variantFirst);
        expect(c.guardrailDrop).toBeCloseTo(0.5);
        expect(c.call).toBe("LOSS");
    });

    it("LOSS: reliably worse", () => {
        const worse = run([...exact.map((q) => score(q, "exact", 0.9)), ...concept.map((q) => score(q, "concept", 0.2))]);
        expect(compareRuns(base, worse).call).toBe("LOSS");
    });

    it("INCONCLUSIVE: a gain below the 0.05 bar", () => {
        const tiny = run([...exact.map((q) => score(q, "exact", 1)), ...concept.map((q) => score(q, "concept", 0.43))]);
        expect(compareRuns(base, tiny).call).toBe("INCONCLUSIVE");
    });

    it("pairs searches by text, ignoring ones only one run has", () => {
        const extra = run([...base.queries as LabeledScore[], score("new search", "concept", 1)]);
        expect(compareRuns(base, extra).paired).toBe(18);
    });
});
