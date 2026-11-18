import { describe, expect, it } from "vitest";
import { displayMake } from "../../shared/utils/make-name.ts";

describe("displayMake", () => {
    it.each([
        ["TOYOTA", "Toyota"],
        ["MERCEDES-BENZ", "Mercedes-Benz"],
        ["ROLLS-ROYCE", "Rolls-Royce"],
        ["ALFA ROMEO", "Alfa Romeo"],
        ["BMW", "BMW"],
        ["BYD", "BYD"],
        ["MINI", "MINI"],
        ["AC PROPULSION", "AC Propulsion"],
        ["SSC NORTH AMERICA", "SSC North America"],
        ["SCUDERIA CAMERON GLICKENHAUS (SCG)", "Scuderia Cameron Glickenhaus (SCG)"],
        ["MCLAREN", "McLaren"],
        ["KIA", "Kia"],
    ])("%s -> %s", (make, shown) => {
        expect(displayMake(make)).toBe(shown);
    });
});
