export default defineNuxtConfig({

    modules: ["@nuxt/eslint", "@nuxt/ui"],

    devtools: { enabled: true },

    // Page language and title for screen readers, tabs and search engines
    // (Lighthouse / axe: html-has-lang, document-title, meta-description).
    app: {
        head: {
            htmlAttrs: { lang: "en" },
            title: "Find the closest car",
            meta: [
                {
                    name: "description",
                    content: "Describe a car in your own words and see the closest US passenger car models.",
                },
            ],
        },
    },

    css: ["~/assets/css/main.css"],

    // Empty defaults, filled at runtime from NUXT_MONGODB_URI / NUXT_OPENAI_KEY.
    runtimeConfig: {
        mongodbUri: "",
        openaiKey: "",

        public: {},
    },
    compatibilityDate: "2026-11-09",

    // Ship gzip and brotli copies of built assets; the Node server picks one per request.
    // Without this the 210 KiB stylesheet goes out uncompressed and blocks first paint.
    nitro: {
        compressPublicAssets: true,
    },

    // ESLint also formats (no Prettier): `pnpm lint:fix` applies this style.
    eslint: {
        config: {
            stylistic: {
                indent: 4,
                quotes: "double",
                semi: true,
                braceStyle: "1tbs",
                arrowParens: true,
            },
        },
    },
});
