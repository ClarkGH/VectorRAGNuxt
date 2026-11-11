import { describe, expect, it } from "vitest";
import { groupModels, needsEmbedding } from "../../scripts/lib/ingest.ts";
import type { Car } from "../../shared/types/car.ts";
import { EMBEDDING_MODEL } from "../../shared/utils/embedding.ts";

const civic = (year: number): Car => ({ make: "HONDA", makeId: 474, model: "Civic", modelId: 1863, year });

describe("groupModels", () => {
    it("groups per-year rows into one model with sorted, unique years", () => {
        const models = groupModels([civic(2020), civic(2018), civic(2020), civic(2019)]);
        expect(models).toEqual([
            {
                _id: "474-1863",
                make: "HONDA",
                makeId: 474,
                model: "Civic",
                modelId: 1863,
                years: [2018, 2019, 2020],
                embeddingText: "HONDA Civic",
            },
        ]);
    });

    it("attaches a description and folds it into the embedding text", () => {
        const [model] = groupModels([civic(2020)], new Map([["474-1863", "A compact sedan."]]));
        expect(model?.description).toBe("A compact sedan.");
        expect(model?.embeddingText).toBe("HONDA Civic. A compact sedan.");
    });

    it("keeps different models apart", () => {
        const accord: Car = { make: "HONDA", makeId: 474, model: "Accord", modelId: 1861, year: 2020 };
        expect(groupModels([civic(2020), accord]).map((m) => m._id)).toEqual(["474-1863", "474-1861"]);
    });
});

describe("needsEmbedding", () => {
    const [model] = groupModels([civic(2020)]);
    if (!model) throw new Error("fixture");

    it("embeds new models", () => {
        expect(needsEmbedding(model, undefined)).toBe(true);
    });

    it("skips unchanged models", () => {
        expect(needsEmbedding(model, { embeddingText: "HONDA Civic", embeddingModel: EMBEDDING_MODEL })).toBe(false);
    });

    it("re-embeds when the text changed", () => {
        expect(needsEmbedding(model, { embeddingText: "HONDA Civic Old", embeddingModel: EMBEDDING_MODEL })).toBe(true);
    });

    // Vectors from different models don't share a space (tech debt #2).
    it("re-embeds when the stored vector came from another model", () => {
        expect(needsEmbedding(model, { embeddingText: "HONDA Civic", embeddingModel: "some-old-model" })).toBe(true);
        expect(needsEmbedding(model, { embeddingText: "HONDA Civic" })).toBe(true);
    });
});
