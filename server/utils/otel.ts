import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  propagation,
  ROOT_CONTEXT,
} from "@opentelemetry/api";
import type { NodeSDK as NodeSDKType } from "@opentelemetry/sdk-node";
import type { H3Event } from "h3";

/**
 * Custom error class that includes trace context for client responses.
 */
export class TracedError extends Error {
  public readonly traceId: string;
  public readonly spanId: string;
  public readonly statusCode: number;

  constructor(
    message: string,
    options: { traceId: string; spanId: string; statusCode?: number }
  ) {
    super(message);
    this.name = "TracedError";
    this.traceId = options.traceId;
    this.spanId = options.spanId;
    this.statusCode = options.statusCode ?? 500;
  }

  toJSON() {
    return {
      error: this.message,
      traceId: this.traceId,
      spanId: this.spanId,
    };
  }
}

let sdk: NodeSDKType | null = null;
let initialized = false;

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

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import(
    "@opentelemetry/exporter-trace-otlp-proto"
  );
  const { Resource } = await import("@opentelemetry/resources");
  const { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION } =
    await import("@opentelemetry/semantic-conventions");
  const { W3CTraceContextPropagator } = await import("@opentelemetry/core");

  // Set up W3C Trace Context propagation BEFORE starting SDK
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  const traceExporter = new OTLPTraceExporter({
    url: "https://eu-central-1.aws.edge.axiom.co/v1/traces",
    headers: {
      Authorization: `Bearer ${axiomToken}`,
      "X-Axiom-Dataset": axiomDataset,
    },
  });

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
  });

  // Don't use HttpInstrumentation - Nitro/h3 doesn't use Node's http module
  sdk = new NodeSDK({
    resource,
    traceExporter,
  });

  sdk.start();
  console.log(`[OTEL] Initialized for service: ${serviceName}`);

  process.on("SIGTERM", () => {
    sdk?.shutdown().finally(() => process.exit(0));
  });

  return sdk;
}

export function getTracer() {
  const config = useRuntimeConfig();
  return trace.getTracer(config.public.otelServiceName as string, "1.0.0");
}

/**
 * Extract trace context from incoming H3 request headers.
 * This allows continuing a trace started on the frontend.
 */
export function extractTraceContext(event: H3Event) {
  const headers = getHeaders(event);
  // Create a carrier object from the headers
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) carrier[key] = value;
  }
  // Extract the context from the traceparent header
  return propagation.extract(ROOT_CONTEXT, carrier);
}

/**
 * Create a span that continues from the frontend trace context.
 * Use this in API handlers to link frontend and backend traces.
 * Automatically adds X-Trace-Id and X-Span-Id response headers.
 *
 * On error, throws a TracedError with trace context for the client.
 */
export function createSpanFromRequest<T>(
  event: H3Event,
  name: string,
  fn: (span: any) => Promise<T> | T,
  options?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }
): Promise<T> {
  const parentContext = extractTraceContext(event);
  const tracer = getTracer();

  return context.with(parentContext, () => {
    return tracer.startActiveSpan(
      name,
      {
        kind: options?.kind ?? SpanKind.SERVER,
        attributes: options?.attributes,
      },
      async (span: any): Promise<T> => {
        // Add trace ID to response headers for debugging/Postman
        const spanContext = span.spanContext();
        const traceId = spanContext.traceId;
        const spanId = spanContext.spanId;

        setHeader(event, "X-Trace-Id", traceId);
        setHeader(event, "X-Span-Id", spanId);

        try {
          const result = await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          return result;
        } catch (error) {
          const err = error as Error;

          // Record exception and set error status on span
          span.recordException(err);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });
          span.setAttribute("error", true);
          span.setAttribute("error.message", err.message);
          span.end();

          // Throw a TracedError so the client gets the trace ID
          throw createError({
            statusCode: (err as any).statusCode ?? 500,
            statusMessage: err.message,
            data: {
              error: err.message,
              traceId,
              spanId,
            },
          });
        }
      }
    );
  });
}

/**
 * Create a span without request context (for internal operations).
 */
export function createSpan<T>(
  name: string,
  fn: (span: any) => Promise<T> | T,
  options?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    { kind: options?.kind, attributes: options?.attributes },
    async (span: any): Promise<T> => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        return result;
      } catch (error) {
        const err = error as Error;
        span.recordException(err);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err.message,
        });
        span.setAttribute("error", true);
        span.end();
        throw error;
      }
    }
  );
}

/**
 * Fire and forget: Run an async function in the background with its own span.
 * The span is linked to the current trace but doesn't block the response.
 *
 * @example
 * await createSpanFromRequest(event, "api-handler", async (span) => {
 *   // Fire off background task - doesn't block response
 *   fireAndForget("send-welcome-email", async (bgSpan) => {
 *     await sendEmail(user.email, "Welcome!");
 *   });
 *
 *   return { success: true }; // Returns immediately
 * });
 */
export function fireAndForget(
  name: string,
  fn: (span: any) => Promise<void>,
  options?: {
    kind?: SpanKind;
    attributes?: Record<string, string | number | boolean>;
  }
): void {
  // Capture the current context so the background span is linked to the trace
  const currentContext = context.active();
  const tracer = getTracer();

  // Start the background work without awaiting
  context.with(currentContext, () => {
    tracer.startActiveSpan(
      name,
      {
        kind: options?.kind ?? SpanKind.INTERNAL,
        attributes: {
          "span.type": "fire-and-forget",
          ...options?.attributes,
        },
      },
      async (span: any) => {
        try {
          await fn(span);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const err = error as Error;
          console.error(`[fireAndForget] ${name} failed:`, err.message);
          span.recordException(err);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });
        } finally {
          span.end();
        }
      }
    );
  });
}

export { trace, context, SpanKind, SpanStatusCode };
