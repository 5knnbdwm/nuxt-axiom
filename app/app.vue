<script setup lang="ts">
import { SpanKind } from "@opentelemetry/api";

const { $otel } = useNuxtApp();

async function testTrace() {
  const response = await fetch("/api/test-trace");
  const data = await response.json();
  console.log("Trace response:", data);
}

async function testManualSpan() {
  await $otel.createSpan(
    "user-interaction",
    async () => {
      const response = await fetch("/api/test-trace");
      return await response.json();
    },
    { kind: SpanKind.CLIENT, attributes: { "ui.action": "button-click" } }
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
