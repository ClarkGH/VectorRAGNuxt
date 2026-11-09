// One scraped car, as stored in data/cars.json and (later) Mongo.
export type Car = { make: string; makeId: number; model: string; modelId: number; year: number };

export type CarsFile = {
    source: string;
    scrapedAt: string;
    years: [from: number, to: number];
    cars: Car[];
};
