import {
  createSpanFromRequest,
  createSpan,
  fireAndForget,
  SpanKind,
} from "../utils/otel";
import { fetchUser, validateUser } from "../utils/user-service";
import { findOne } from "../utils/db-service";

export default defineEventHandler(async (event) => {
  // Use createSpanFromRequest to continue the trace from the frontend
  return await createSpanFromRequest(
    event,
    "test-trace-handler",
    async (span) => {
      span.setAttribute("request.path", "/api/test-trace");

      // Call functions from different files - they automatically inherit the trace
      const user = await fetchUser(123);
      span.addEvent("user-fetched", { "user.id": user.id });

      // Nested call to another service
      const validation = await validateUser(user);
      span.addEvent("user-validated", { valid: validation.valid });

      // Database operations (also traced)
      const dbRecord = await findOne("users", user.id);

      // Fire and forget: This runs in the background, doesn't block the response
      // The span will still appear in the same trace in Axiom
      fireAndForget(
        "send-notification",
        async (bgSpan) => {
          bgSpan.setAttribute("notification.type", "user-activity");
          bgSpan.setAttribute("user.id", user.id);
          // Simulate sending notification (e.g., email, webhook, etc.)
          await new Promise((resolve) => setTimeout(resolve, 500));
          bgSpan.addEvent("notification-sent");
        },
        { attributes: { "background.task": true } }
      );

      // You can also create inline spans for specific operations
      const processed = await createSpan(
        "process-results",
        async (innerSpan) => {
          innerSpan.setAttribute("processing.type", "aggregation");
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { user, validation, dbRecord };
        },
        { kind: SpanKind.INTERNAL }
      );

      return {
        success: true,
        timestamp: new Date().toISOString(),
        message: "Trace created! Check Axiom for the distributed trace.",
        data: processed,
      };
    },
    { kind: SpanKind.SERVER }
  );
});
