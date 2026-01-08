/**
 * OpenTelemetry Server Utilities for Nuxt/Nitro
 *
 * Provides distributed tracing with automatic trace propagation from frontend.
 * Traces are exported directly to Axiom.
 *
 * Usage:
 *   // In API handlers, use defineTracedHandler for automatic tracing
 *   export default defineTracedHandler("get-user", async (event, span) => {
 *     const user = await fetchUser(123);
 *     return ok(user);
 *   });
 *
 *   // Or use createSpan for internal operations
 *   const result = await createSpan("db-query", async (span) => {
 *     span.setAttribute("db.table", "users");
 *     return ok(await db.query("SELECT * FROM users"));
 *   });
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { NodeSDK as NodeSDKType } from "@opentelemetry/sdk-node";
import type { H3Event } from "h3";
import { Result, err, ok } from "neverthrow";

// ============================================================================
// Types
// ============================================================================

/** Error type that includes trace context for client responses */
export interface TracedErr {
  message: string;
  traceId: string;
  spanId: string;
  statusCode: number;
  cause?: unknown;
}

/** Base error type for traced handlers */
export interface HandlerError {
  message: string;
  statusCode: number;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
}

/** Key for storing trace context in H3 event */
const TRACE_CONTEXT_KEY = "__otel_trace_context__";

// ============================================================================
// State
// ============================================================================

let sdk: NodeSDKType | null = null;
let initialized = false;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize OpenTelemetry SDK.
 * Called automatically by the server plugin.
 */
export async function initOtel() {
  if (initialized) return sdk;
  initialized = true;

  const config = useRuntimeConfig();
  const axiomToken = config.axiomToken as string;
  const axiomDataset = config.axiomDataset as string;
  const serviceName = config.public.otelServiceName as string;

  if (!axiomToken || !axiomDataset) {
    console.warn(
      "[OTEL] Missing AXIOM_TOKEN or AXIOM_DATASET. Tracing disabled."
    );
    return null;
  }

  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
    { W3CTraceContextPropagator },
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-proto"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/core"),
  ]);

  // Set up W3C Trace Context propagation before starting SDK
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({
      url: "https://eu-central-1.aws.edge.axiom.co/v1/traces",
      headers: {
        Authorization: `Bearer ${axiomToken}`,
        "X-Axiom-Dataset": axiomDataset,
      },
    }),
  });

  sdk.start();
  console.log(`[OTEL] Initialized for service: ${serviceName}`);

  process.on("SIGTERM", () => {
    sdk?.shutdown().finally(() => process.exit(0));
  });

  return sdk;
}

// ============================================================================
// Core Functions
// ============================================================================

/** Get the tracer instance */
export function getTracer() {
  const config = useRuntimeConfig();
  return trace.getTracer(config.public.otelServiceName as string, "1.0.0");
}

/**
 * Extract trace context from incoming request headers.
 * This allows continuing a trace started on the frontend.
 */
export function extractTraceContext(event: H3Event) {
  const headers = getHeaders(event);
  const carrier: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value) carrier[key] = value;
  }

  return propagation.extract(ROOT_CONTEXT, carrier);
}

/**
 * Store trace context in the event for downstream handlers/middleware.
 */
function setEventTraceContext(
  event: H3Event,
  ctx: ReturnType<typeof context.active>
) {
  (event as unknown as Record<string, unknown>)[TRACE_CONTEXT_KEY] = ctx;
}

/**
 * Get stored trace context from the event, or extract from headers if not set.
 */
function getEventTraceContext(event: H3Event) {
  const stored = (event as unknown as Record<string, unknown>)[
    TRACE_CONTEXT_KEY
  ];
  if (stored) return stored as ReturnType<typeof context.active>;
  return extractTraceContext(event);
}

/**
 * Create a TracedErr from any error within a span context.
 */
export function toTracedErr(
  error: unknown,
  span: Span,
  statusCode = 500
): TracedErr {
  const { traceId, spanId } = span.spanContext();
  const message = error instanceof Error ? error.message : String(error);
  return { message, traceId, spanId, statusCode, cause: error };
}

// ============================================================================
// Span Creation
// ============================================================================

/**
 * Create a span that continues from the trace context (either from middleware or frontend headers).
 * Automatically adds X-Trace-Id and X-Span-Id response headers.
 */
export function createSpanFromRequest<T, E>(
  event: H3Event,
  name: string,
  fn: (span: Span) => Promise<Result<T, E>>,
  options?: SpanOptions
): Promise<Result<T, E & { traceId: string; spanId: string }>> {
  // Use stored context from middleware if available, otherwise extract from headers
  const parentContext = getEventTraceContext(event);
  const tracer = getTracer();

  return context.with(parentContext, () => {
    return tracer.startActiveSpan(
      name,
      {
        kind: options?.kind ?? SpanKind.SERVER,
        attributes: options?.attributes,
      },
      parentContext,
      async (
        span
      ): Promise<Result<T, E & { traceId: string; spanId: string }>> => {
        const { traceId, spanId } = span.spanContext();

        // Add trace IDs to response headers for debugging
        setHeader(event, "X-Trace-Id", traceId);
        setHeader(event, "X-Span-Id", spanId);

        // Store context for any nested handlers
        setEventTraceContext(event, trace.setSpan(parentContext, span));

        const result = await fn(span);

        if (result.isErr()) {
          const error = result.error;
          const message = getErrorMessage(error);

          span.recordException(
            error instanceof Error ? error : new Error(message)
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          span.setAttribute("error", true);
          span.setAttribute("error.message", message);
          span.end();

          return err({ ...error, traceId, spanId });
        }

        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return ok(result.value);
      }
    );
  });
}

/**
 * Create a span for internal operations.
 * Automatically becomes a child of the current active span.
 */
export function createSpan<T, E>(
  name: string,
  fn: (span: Span) => Promise<Result<T, E>>,
  options?: SpanOptions
): Promise<Result<T, E>> {
  return getTracer().startActiveSpan(
    name,
    {
      kind: options?.kind ?? SpanKind.INTERNAL,
      attributes: options?.attributes,
    },
    async (span): Promise<Result<T, E>> => {
      const result = await fn(span);

      if (result.isErr()) {
        const message = getErrorMessage(result.error);
        span.recordException(
          result.error instanceof Error ? result.error : new Error(message)
        );
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        span.setAttribute("error", true);
        span.end();
        return result;
      }

      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return result;
    }
  );
}

/**
 * Run an async function in the background with its own span.
 * Linked to the current trace but doesn't block the response.
 */
export function createSpanInBackground<E>(
  name: string,
  fn: (span: Span) => Promise<Result<void, E>>,
  options?: SpanOptions
): void {
  const currentContext = context.active();
  const tracer = getTracer();

  context.with(currentContext, () => {
    tracer.startActiveSpan(
      name,
      {
        kind: options?.kind ?? SpanKind.INTERNAL,
        attributes: {
          "span.type": "background",
          ...options?.attributes,
        },
      },
      async (span) => {
        const result = await fn(span);

        if (result.isErr()) {
          const message = getErrorMessage(result.error);
          console.error(`[OTEL] Background task "${name}" failed:`, message);
          span.recordException(
            result.error instanceof Error ? result.error : new Error(message)
          );
          span.setStatus({ code: SpanStatusCode.ERROR, message });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }

        span.end();
      }
    );
  });
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Define a traced middleware with automatic span creation.
 * The trace context is passed to downstream handlers, making them siblings in the same trace.
 *
 * @example
 * // server/middleware/auth.ts
 * export default defineTracedMiddleware("auth-middleware", async (event, span) => {
 *   const token = getHeader(event, "authorization");
 *   if (!token) {
 *     return err({ message: "Unauthorized", statusCode: 401 });
 *   }
 *
 *   span.setAttribute("auth.method", "bearer");
 *   const user = await validateToken(token);
 *   event.context.user = user;
 *   return ok(undefined);
 * });
 */
export function defineTracedMiddleware<E extends HandlerError>(
  name: string,
  fn: (event: H3Event, span: Span) => Promise<Result<void, E>>,
  options?: SpanOptions
) {
  return defineEventHandler(async (event: H3Event) => {
    // Extract trace context from headers (frontend propagation)
    const parentContext = getEventTraceContext(event);
    const tracer = getTracer();

    return context.with(parentContext, () => {
      return tracer.startActiveSpan(
        name,
        {
          kind: options?.kind ?? SpanKind.SERVER,
          attributes: {
            "middleware.name": name,
            ...options?.attributes,
          },
        },
        parentContext,
        async (span) => {
          const { traceId, spanId } = span.spanContext();

          // Store context with this span for downstream handlers
          const newContext = trace.setSpan(parentContext, span);
          setEventTraceContext(event, newContext);

          // Set trace headers early so they're available even if middleware fails
          setHeader(event, "X-Trace-Id", traceId);
          setHeader(event, "X-Span-Id", spanId);

          const result = await fn(event, span);

          if (result.isErr()) {
            const error = result.error;
            const message = getErrorMessage(error);

            span.recordException(new Error(message));
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            span.setAttribute("error", true);
            span.setAttribute("error.message", message);
            span.end();

            throw createError({
              statusCode: error.statusCode,
              statusMessage: message,
              data: { error: message, traceId, spanId },
            });
          }

          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
        }
      );
    });
  });
}

// ============================================================================
// Handler Factory
// ============================================================================

/**
 * Define a traced event handler with automatic error handling.
 * If preceded by traced middleware, becomes a child span of the middleware.
 *
 * @example
 * export default defineTracedHandler("get-user", async (event, span) => {
 *   const user = await fetchUser(123);
 *   if (!user) {
 *     return err({ message: "User not found", statusCode: 404 });
 *   }
 *   return ok(user);
 * });
 */
export function defineTracedHandler<T, E extends HandlerError>(
  name: string,
  fn: (event: H3Event, span: Span) => Promise<Result<T, E>>,
  options?: SpanOptions
) {
  return defineEventHandler(async (event: H3Event) => {
    const result = await createSpanFromRequest(
      event,
      name,
      (span) => fn(event, span),
      {
        kind: options?.kind ?? SpanKind.SERVER,
        attributes: options?.attributes,
      }
    );

    if (result.isErr()) {
      throw createError({
        statusCode: result.error.statusCode,
        statusMessage: result.error.message,
        data: {
          error: result.error.message,
          traceId: result.error.traceId,
          spanId: result.error.spanId,
        },
      });
    }

    return result.value;
  });
}

// ============================================================================
// Helpers
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// ============================================================================
// Exports
// ============================================================================

export { trace, context, SpanKind, SpanStatusCode };
export { ok, err, Result } from "neverthrow";
export type { Span };
