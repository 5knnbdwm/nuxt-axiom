/**
 * Example traced middleware demonstrating OpenTelemetry integration.
 *
 * This middleware runs before API handlers and creates a span that
 * becomes the parent for all subsequent handler spans in the trace.
 *
 * In a real app, you might use this pattern for:
 * - Authentication/authorization
 * - Rate limiting
 * - Request logging
 * - Feature flag evaluation
 */

import { defineTracedMiddleware, ok } from "../utils/otel";

// Create the traced middleware handler
const tracedMiddleware = defineTracedMiddleware(
  "example-middleware",
  async (event, span) => {
    // Add useful attributes to the span
    span.setAttribute("http.method", event.method);
    span.setAttribute("http.url", event.path);

    // Example: Check for a required header
    const apiVersion = getHeader(event, "x-api-version");
    if (apiVersion) {
      span.setAttribute("api.version", apiVersion);
    }

    // Example: Add request timing
    const startTime = Date.now();
    event.context.requestStartTime = startTime;
    span.addEvent("middleware-start", { timestamp: startTime });

    // Example: Simulate some middleware work (auth check, rate limit, etc.)
    // In a real app, you might validate tokens, check permissions, etc.
    // const authResult = await validateAuth(event);
    // if (authResult.isErr()) {
    //   return err({ message: "Unauthorized", statusCode: 401 });
    // }
    // event.context.user = authResult.value;

    // Store something in context for downstream handlers
    event.context.traced = true;

    return ok(undefined);
  }
);

// Only trace API routes - skip page loads, assets, otel-proxy, etc.
export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/") || event.path === "/api/otel-proxy") {
    return; // Skip non-API routes and internal endpoints
  }
  return tracedMiddleware(event);
});
