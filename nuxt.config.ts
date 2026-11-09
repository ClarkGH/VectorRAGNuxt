export default defineNuxtConfig({
  devtools: { enabled: true },

  modules: ['@nuxt/eslint'],

  runtimeConfig: {
    mongodbUri: process.env.MONGODB_URI,
    openaiKey: process.env.OPENAI_KEY,

    public: {}
  }
})
