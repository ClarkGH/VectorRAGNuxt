export default defineNuxtConfig({
  compatibilityDate: '2026-11-09',

  devtools: { enabled: true },

  modules: ['@nuxt/eslint', '@nuxt/ui'],

  css: ['~/assets/css/main.css'],

  // Empty defaults, filled at runtime from NUXT_MONGODB_URI / NUXT_OPENAI_KEY.
  runtimeConfig: {
    mongodbUri: '',
    openaiKey: '',

    public: {}
  }
})
