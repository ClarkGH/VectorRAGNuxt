import { MongoClient, type Db } from "mongodb";

// Cache the connect promise, not the client: concurrent first requests all
// await the same connection instead of each opening their own.
let db: Promise<Db> | undefined;

export function getDb() {
    db ??= new MongoClient(useRuntimeConfig().mongodbUri)
        .connect()
        .then((client) => client.db())
        .catch((err: unknown) => {
            db = undefined; // let the next call retry instead of caching the failure
            throw err;
        });
    return db;
}
