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
  vite: {
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          // Suppress "this is undefined" warnings from @opentelemetry packages
          if (
            warning.code === "THIS_IS_UNDEFINED" &&
            warning.id?.includes("@opentelemetry")
          ) {
            return;
          }
          warn(warning);
        },
      },
    },
  },
  nitro: {
    rollupConfig: {
      onwarn(warning, warn) {
        // Suppress "this is undefined" warnings from @opentelemetry packages
        if (
          warning.code === "THIS_IS_UNDEFINED" &&
          warning.id?.includes("@opentelemetry")
        ) {
          return;
        }
        // Suppress circular dependency warnings from node_modules (internal framework deps)
        if (
          warning.code === "CIRCULAR_DEPENDENCY" &&
          warning.message?.includes("node_modules")
        ) {
          return;
        }
        warn(warning);
      },
    },
  },
});
