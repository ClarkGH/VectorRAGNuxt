import OpenAI from "openai";

let client: OpenAI | undefined;

// Created on first use so a missing key only fails the requests that need it.
export function getOpenAI() {
    client ??= new OpenAI({ apiKey: useRuntimeConfig().openaiKey, maxRetries: 2, timeout: 15_000 });
    return client;
}
