// How strong a search result's match is, in words, from Mongo's score
// ((1 + cos) / 2, where 0.5 is unrelated). The page shows these instead of a
// percentage: a mid score can't tell a right answer from a wrong one, so a
// precise-looking number misleads. Cut-offs set from the golden set's scores,
// before the change: docs/evaluation.md, "The match display".

// At or above: 93% of results were right, and no junk or out-of-catalog result.
export const MATCH_STRONG = 0.78;
// At or above: a coin toss weighted toward right (63%). Must equal the answer
// gate's GATE_THRESHOLD (server/utils/answer.ts); a unit test checks it.
export const MATCH_POSSIBLE = 0.65;

export type MatchStrength = "strong" | "possible" | "weak";

export function matchStrength(score: number): MatchStrength {
    if (score >= MATCH_STRONG) return "strong";
    if (score >= MATCH_POSSIBLE) return "possible";
    return "weak";
}

export const MATCH_LABEL: Record<MatchStrength, string> = {
    strong: "Strong match",
    possible: "Possible match",
    weak: "Weak match",
};
