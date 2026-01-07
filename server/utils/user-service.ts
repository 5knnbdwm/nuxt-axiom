import { createSpan, ok, err, type Result } from "./otel";

/**
 * Example service demonstrating traced functions.
 * These functions automatically inherit the parent trace context
 * when called from within a traced handler.
 */

export type UserError = {
  code: "NOT_FOUND" | "VALIDATION_FAILED" | "FETCH_ERROR";
  message: string;
};

export type User = {
  id: number;
  name: string;
  email: string;
};

export async function fetchUser(
  userId: number
): Promise<Result<User, UserError>> {
  // This span automatically becomes a child of whatever span is active
  return createSpan("user-service.fetchUser", async (span) => {
    span.setAttribute("user.id", userId);

    // Simulate database lookup
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Example: return error for user ID 0
    if (userId === 0) {
      return err({ code: "NOT_FOUND" as const, message: "User not found" });
    }

    return ok({
      id: userId,
      name: "John Doe",
      email: "john@example.com",
    });
  });
}

export async function validateUser(user: {
  id: number;
  email: string;
}): Promise<Result<{ valid: true }, UserError>> {
  return createSpan("user-service.validateUser", async (span) => {
    span.setAttribute("user.id", user.id);
    span.setAttribute("user.email", user.email);

    // Simulate validation
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Example: fail validation for empty emails
    if (!user.email) {
      return err({
        code: "VALIDATION_FAILED" as const,
        message: "Email is required",
      });
    }

    return ok({ valid: true as const });
  });
}
