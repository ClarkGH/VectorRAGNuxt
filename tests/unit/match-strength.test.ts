// The match words the page shows (docs/evaluation.md, "The match display").
import { describe, expect, it } from "vitest";
import { GATE_THRESHOLD } from "../../server/utils/answer.ts";
import { MATCH_POSSIBLE, MATCH_STRONG, matchStrength } from "../../shared/utils/match-strength.ts";

describe("matchStrength", () => {
    it.each([
        [0.98, "strong"],
        [MATCH_STRONG, "strong"],
        [0.779, "possible"],
        [0.758, "possible"], // the Prius C for "gas efficient car"
        [MATCH_POSSIBLE, "possible"],
        [0.649, "weak"],
        [0.6, "weak"], // "asdf qwerty"
    ] as const)("%s is %s", (score, strength) => {
        expect(matchStrength(score)).toBe(strength);
    });

    // "Possible" starts where the page says "Nothing close" and the AI answer's gate
    // stops: if one moved without the other, a result could be "possible" yet gated.
    it("starts 'possible' at the answer gate", () => {
        expect(MATCH_POSSIBLE).toBe(GATE_THRESHOLD);
    });
});
