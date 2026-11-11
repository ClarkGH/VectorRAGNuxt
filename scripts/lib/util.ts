// Small helpers shared by the CLI scripts.
import { rename, writeFile } from "node:fs/promises";

export function errorMessage(err: unknown) {
    return err instanceof Error ? err.message : String(err);
}

// Write to a temp file, then rename: a crash mid-write never leaves a half file.
export async function writeAtomic(path: string, data: string) {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
}

// Runs worker over items with `concurrency` in flight. The workers share one
// iterator, so each item is taken exactly once. onProgress gets the done count.
export async function pool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
    onProgress?: (done: number) => void,
) {
    const queue = items.values();
    let done = 0;
    const runners = Array.from({ length: concurrency }, async () => {
        for (const item of queue) {
            await worker(item);
            done++;
            onProgress?.(done);
        }
    });
    await Promise.all(runners);
}
