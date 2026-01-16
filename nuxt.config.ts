export default defineNuxtConfig({
  devtools: { enabled: true },

  runtimeConfig: {
    mongodbUri: process.env.MONGODB_URI,
    openaiKey: process.env.OPENAI_KEY,

    public: {}
  }
})
