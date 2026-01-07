import { defineTracedHandler, createSpan, ok } from "../utils/otel";

export default defineTracedHandler("test-slow-handler", async (event, span) => {
  span.setAttribute("request.path", "/api/test-slow");

  // Simulate slow database query
  await createSpan("slow-db-query", async (dbSpan) => {
    dbSpan.setAttribute("db.operation", "SELECT");
    dbSpan.setAttribute("db.table", "large_table");
    await new Promise((resolve) => setTimeout(resolve, 800));
    dbSpan.addEvent("query-complete", { "rows.count": 10000 });
    return ok({ rows: 10000 });
  });

  // Simulate slow external API call
  await createSpan("slow-external-api", async (apiSpan) => {
    apiSpan.setAttribute("http.url", "https://slow-api.example.com");
    apiSpan.setAttribute("http.method", "GET");
    await new Promise((resolve) => setTimeout(resolve, 500));
    apiSpan.addEvent("api-response-received");
    return ok({ status: "ok" });
  });

  // Simulate CPU-intensive processing
  await createSpan("heavy-processing", async (procSpan) => {
    procSpan.setAttribute("processing.type", "data-transformation");
    await new Promise((resolve) => setTimeout(resolve, 300));
    procSpan.addEvent("processing-complete");
    return ok(undefined);
  });

  return ok({
    success: true,
    timestamp: new Date().toISOString(),
    message: "Slow endpoint completed!",
    totalDelayMs: 1600,
  });
});
