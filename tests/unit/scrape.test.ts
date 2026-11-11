import { describe, expect, it } from "vitest";
import { carsFromModelLists, modelCacheName, parseModelCacheName, type Model } from "../../scripts/lib/scrape.ts";

describe("model cache names (S8)", () => {
    it("round-trips", () => {
        expect(parseModelCacheName(`${modelCacheName(474, 2019)}.json`)).toEqual({ makeId: 474, year: 2019 });
    });

    it("refuses non-integer ids from the API", () => {
        expect(() => modelCacheName("../../etc" as unknown as number, 2019)).toThrow();
        expect(() => modelCacheName(1.5, 2019)).toThrow();
    });

    it.each(["makes.json", "474-2019.json.tmp", "../474-2019.json", "474-19.json", "abc-2019.json"])(
        "ignores %s",
        (name) => {
            expect(parseModelCacheName(name)).toBeUndefined();
        },
    );
});

describe("carsFromModelLists", () => {
    const m = (model: string, id: number): Model => ({ Make_ID: 474, Make_Name: " HONDA ", Model_ID: id, Model_Name: model });

    it("flattens, trims, de-duplicates and sorts", () => {
        const cars = carsFromModelLists([
            { year: 2020, models: [m("Civic", 1863), m("Accord", 1861)] },
            { year: 2019, models: [m("Civic", 1863)] },
            { year: 2020, models: [m("Civic", 1863)] }, // duplicate
        ]);
        expect(cars.map((c) => `${c.make} ${c.model} ${c.year}`)).toEqual([
            "HONDA Accord 2020",
            "HONDA Civic 2019",
            "HONDA Civic 2020",
        ]);
    });
});
