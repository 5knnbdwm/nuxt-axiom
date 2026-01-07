import {
  defineTracedHandler,
  createSpan,
  createSpanInBackground,
  ok,
  err,
} from "../utils/otel";
import { fetchUser, validateUser } from "../utils/user-service";
import { findOne } from "../utils/db-service";

export default defineTracedHandler(
  "test-trace-handler",
  async (event, span) => {
    span.setAttribute("request.path", "/api/test-trace");

    // Call functions from different files - they automatically inherit the trace
    const userResult = await fetchUser(123);
    if (userResult.isErr()) {
      return err({ message: userResult.error.message, statusCode: 404 });
    }
    const user = userResult.value;
    span.addEvent("user-fetched", { "user.id": user.id });

    // Nested call to another service
    const validationResult = await validateUser(user);
    if (validationResult.isErr()) {
      return err({ message: validationResult.error.message, statusCode: 400 });
    }
    const validation = validationResult.value;
    span.addEvent("user-validated", { valid: validation.valid });

    // Database operations (also traced)
    const dbResult = await findOne("users", user.id);
    if (dbResult.isErr()) {
      return err({ message: dbResult.error.message, statusCode: 500 });
    }
    const dbRecord = dbResult.value;

    // Fire and forget: This runs in the background, doesn't block the response
    // The span will still appear in the same trace in Axiom
    createSpanInBackground(
      "send-notification",
      async (bgSpan) => {
        bgSpan.setAttribute("notification.type", "user-activity");
        bgSpan.setAttribute("user.id", user.id);
        // Simulate sending notification (e.g., email, webhook, etc.)
        await new Promise((resolve) => setTimeout(resolve, 500));
        bgSpan.addEvent("notification-sent");
        return ok(undefined);
      },
      { attributes: { "background.task": true } }
    );

    // You can also create inline spans for specific operations
    const processedResult = await createSpan(
      "process-results",
      async (innerSpan) => {
        innerSpan.setAttribute("processing.type", "aggregation");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return ok({ user, validation, dbRecord });
      }
    );
    if (processedResult.isErr()) {
      return err({ message: "Processing failed", statusCode: 500 });
    }

    return ok({
      success: true,
      timestamp: new Date().toISOString(),
      message: "Trace created! Check Axiom for the distributed trace.",
      data: processedResult.value,
    });
  }
);
