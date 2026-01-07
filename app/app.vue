<script setup lang="ts">
const { $otel } = useNuxtApp();

const { refresh } = useLazyFetch("/api/test-trace", {
  immediate: false,
});

async function testTrace() {
  const response = await $fetch("/api/test-trace");
  // const data = await response.json();
  console.log("Trace response:", response);
}

async function testError() {
  const response = await $fetch("/api/test-error");
  console.log("Error response:", response);
}

async function testSlow() {
  const response = await $fetch("/api/test-slow");
  console.log("Slow response:", response);
}

async function testManualSpan() {
  await $otel.createSpan(
    "user-interaction",
    async (span, { $fetch, childSpan }) => {
      span.setAttribute("ui.action", "button-click");
      span.setAttribute("ui.component", "app.vue");

      // Child span for validation
      await childSpan("validate-input", async (cs) => {
        cs.setAttribute("validation.type", "pre-request");
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      // Use the provided $fetch - it automatically includes trace headers
      const data = await $fetch("/api/test-trace");

      // Child span for processing the response
      await childSpan("process-response", async (cs) => {
        cs.setAttribute("data.received", true);
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log("Processed response:", data);
      });

      return data;
    },
    { attributes: { "ui.flow": "manual-test" } }
  );
}
</script>

<template>
  <div class="container">
    <h1>OpenTelemetry + Axiom Demo</h1>
    <p>Click the buttons below to generate distributed traces.</p>
    <div class="buttons">
      <button @click="testTrace">Test Auto-Instrumented Trace</button>
      <button @click="testManualSpan">Test Manual Span</button>
      <button @click="refresh()">Test UseFetch</button>
    </div>
    <div class="buttons">
      <button @click="testError">Test Error</button>
      <button @click="testSlow">Test Slow</button>
    </div>
    <p class="hint">
      Check your Axiom dashboard to see the traces.
      <br />
      Frontend and backend spans share the same trace_id!
    </p>
  </div>
</template>

<style scoped>
.container {
  max-width: 600px;
  margin: 2rem auto;
  padding: 2rem;
  font-family: system-ui, sans-serif;
}
h1 {
  color: #333;
}
.buttons {
  display: flex;
  gap: 1rem;
  margin: 1.5rem 0;
}
button {
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
}
button:hover {
  background: #4f46e5;
}
.hint {
  color: #666;
  font-size: 0.9rem;
  line-height: 1.6;
}
</style>
