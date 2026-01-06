import { createSpan, SpanKind } from "./otel";

/**
 * Example service demonstrating traced functions.
 * These functions automatically inherit the parent trace context
 * when called from within a traced handler.
 */

export async function fetchUser(userId: number) {
  // This span automatically becomes a child of whatever span is active
  return createSpan(
    "user-service.fetchUser",
    async (span) => {
      span.setAttribute("user.id", userId);

      // Simulate database lookup
      await new Promise((resolve) => setTimeout(resolve, 20));

      return {
        id: userId,
        name: "John Doe",
        email: "john@example.com",
      };
    },
    { kind: SpanKind.INTERNAL }
  );
}

export async function validateUser(user: { id: number; email: string }) {
  return createSpan(
    "user-service.validateUser",
    async (span) => {
      span.setAttribute("user.id", user.id);
      span.setAttribute("user.email", user.email);

      // Simulate validation
      await new Promise((resolve) => setTimeout(resolve, 10));

      return { valid: true };
    },
    { kind: SpanKind.INTERNAL }
  );
}

