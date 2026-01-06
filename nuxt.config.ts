// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  devtools: { enabled: true },
  modules: ["@nuxt/eslint", "@nuxt/fonts", "@nuxt/hints"],
  runtimeConfig: {
    axiomToken: process.env.AXIOM_TOKEN,
    axiomDataset: process.env.AXIOM_DATASET,
    public: {
      otelServiceName: process.env.OTEL_SERVICE_NAME || "personal-otel-axiom",
    },
  },
});
