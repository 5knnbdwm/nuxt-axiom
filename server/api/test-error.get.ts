import { defineTracedHandler, createSpan, ok, err } from "../utils/otel";

export default defineTracedHandler(
  "test-error-handler",
  async (_event, span) => {
    span.setAttribute("request.path", "/api/test-error");

    // Simulate some work before the error
    const workResult = await createSpan("pre-error-work", async (innerSpan) => {
      innerSpan.setAttribute("work.type", "setup");
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok(undefined);
    });

    if (workResult.isErr()) {
      return err({ message: "Pre-work failed", statusCode: 500 });
    }

    // Simulate an error - return err instead of throwing
    return err({
      message: "Something went wrong during processing",
      statusCode: 400,
    });
  }
);
