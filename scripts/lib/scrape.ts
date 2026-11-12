// Pure helpers for the vPIC scraper (no I/O), so they can be unit tested.
import type { Car } from "../../shared/types/car.ts";

// --- vPIC response shapes ---------------------------------------------------

export type VpicResponse<T> = { Count: number; Message: string; Results: T[] };
export type Make = { MakeId: number; MakeName: string };
export type Model = { Make_ID: number; Make_Name: string; Model_ID: number; Model_Name: string };

// Cache files are named `${makeId}-${year}.json`; anything else (makes.json,
// temp files) isn't a model list.
const MODEL_CACHE_NAME = /^(\d+)-(\d{4})\.json$/;

export function modelCacheName(makeId: number, year: number) {
    // MakeId comes from the API and ends up in a file path, so don't trust it (S8).
    if (!Number.isInteger(makeId) || !Number.isInteger(year)) {
        throw new Error(`Refusing cache name for makeId=${makeId} year=${year}`);
    }
    return `${makeId}-${year}`;
}

export function parseModelCacheName(fileName: string): { makeId: number; year: number } | undefined {
    const match = MODEL_CACHE_NAME.exec(fileName);
    if (!match) return undefined;
    return { makeId: Number(match[1]), year: Number(match[2]) };
}

// Flattens cached model lists into sorted, de-duplicated car rows, leaving out
// the makers in `excludeMakeIds` (see niche-makes.ts).
export function carsFromModelLists(
    lists: { year: number; models: Model[] }[],
    excludeMakeIds: { has(makeId: number): boolean } = new Set<number>(),
): Car[] {
    const cars = new Map<string, Car>();
    for (const { year, models } of lists) {
        for (const m of models) {
            if (excludeMakeIds.has(m.Make_ID)) continue;
            cars.set(`${m.Make_ID}-${m.Model_ID}-${year}`, {
                make: m.Make_Name.trim(),
                makeId: m.Make_ID,
                model: m.Model_Name.trim(),
                modelId: m.Model_ID,
                year,
            });
        }
    }
    return [...cars.values()].sort(
        (a, b) => a.make.localeCompare(b.make) || a.model.localeCompare(b.model) || a.year - b.year,
    );
}
