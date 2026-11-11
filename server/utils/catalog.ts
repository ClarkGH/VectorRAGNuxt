// What's in the cars collection, so the page never hard-codes the model years.
// No h3/Nuxt imports, so it's integration-testable like search.ts.
import type { Db } from "mongodb";
import type { CarDoc, CatalogSummary } from "../../shared/types/car";
import { CARS_COLLECTION } from "../../shared/utils/embedding";

export async function getCatalogSummary(db: Db): Promise<CatalogSummary> {
    const cars = db.collection<CarDoc>(CARS_COLLECTION);
    const [models, [range]] = await Promise.all([
        cars.countDocuments(),
        cars
            .aggregate<{ from: number; to: number }>([
                { $unwind: "$years" },
                { $group: { _id: null, from: { $min: "$years" }, to: { $max: "$years" } } },
            ])
            .toArray(),
    ]);
    return { models, years: range ? [range.from, range.to] : null };
}
