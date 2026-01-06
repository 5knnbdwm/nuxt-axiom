import { createSpanFromRequest, createSpan, SpanKind } from "../utils/otel";

export default defineEventHandler(async (event) => {
  return await createSpanFromRequest(
    event,
    "test-error-handler",
    async (span) => {
      span.setAttribute("request.path", "/api/test-error");

      // Simulate some work before the error
      await createSpan(
        "pre-error-work",
        async (innerSpan) => {
          innerSpan.setAttribute("work.type", "setup");
          await new Promise((resolve) => setTimeout(resolve, 20));
        },
        { kind: SpanKind.INTERNAL }
      );

      // Simulate an error
      throw createError({
        statusCode: 400,
        message: "Something went wrong during processing",
      });
    },
    { kind: SpanKind.SERVER }
  );
});
