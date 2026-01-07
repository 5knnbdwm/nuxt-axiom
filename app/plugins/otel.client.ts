/**
 * OpenTelemetry Client Plugin for Nuxt
 *
 * Provides distributed tracing from the browser to the backend.
 * Traces are exported to the server via /api/otel-proxy.
 *
 * Usage:
 *   const { $otel } = useNuxtApp();
 *
 *   // Create a traced operation with automatic trace propagation
 *   await $otel.createSpan("my-operation", async (span, { $fetch, childSpan }) => {
 *     span.setAttribute("user.id", 123);
 *
 *     // $fetch automatically propagates trace context to the backend
 *     const data = await $fetch("/api/endpoint");
 *
 *     // Create nested child spans
 *     await childSpan("process-data", async (cs) => {
 *       cs.setAttribute("data.count", data.length);
 *     });
 *
 *     return data;
 *   });
 */

import {
  trace,
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Enable auto-instrumentation of all fetch calls (outside of createSpan).
 * When enabled, standalone fetch() calls will automatically create spans.
 * These spans will have names like "HTTP GET /path" with http.* attributes.
 */
const ENABLE_FETCH_AUTO_INSTRUMENTATION = true;

/**
 * Enable child HTTP spans for fetch calls made within createSpan().
 * When enabled, each $fetch/fetch call inside a manual span will create
 * a child span named "HTTP GET /path" with http.* attributes.
 */
const ENABLE_MANUAL_SPAN_HTTP_TRACING = true;

// ============================================================================
// State
// ============================================================================

let initialized = false;
let initPromise: Promise<void> | null = null;
let tracer: ReturnType<typeof trace.getTracer> | null = null;

// ============================================================================
// Types
// ============================================================================

export interface SpanHelpers {
  /** Fetch with automatic trace context propagation */
  $fetch: <R = unknown>(
    url: string,
    options?: Parameters<typeof $fetch>[1]
  ) => Promise<R>;
  /** Native fetch with automatic trace context propagation */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Create a child span */
  childSpan: <T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions
  ) => Promise<T>;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Generate a span name from HTTP method and URL.
 */
function getHttpSpanName(method: string, url: string): string {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    return `HTTP ${method.toUpperCase()} ${pathname}`;
  } catch {
    return `HTTP ${method.toUpperCase()}`;
  }
}

/**
 * Create an XMLHttpRequest-based fetch that bypasses FetchInstrumentation.
 * This ensures our traceparent header is sent exactly as specified.
 * Optionally creates a child span for the HTTP request.
 */
function createXhrFetch(
  traceParent: string,
  parentCtx: ReturnType<typeof context.active>
) {
  return <R = unknown>(
    url: string,
    options?: Parameters<typeof $fetch>[1]
  ): Promise<R> => {
    const method = (options?.method as string) || "GET";

    // Optionally create a child span for this HTTP request
    const httpSpan =
      ENABLE_MANUAL_SPAN_HTTP_TRACING && tracer
        ? tracer.startSpan(
            getHttpSpanName(method, url),
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "http.method": method.toUpperCase(),
                "http.url": new URL(url, window.location.origin).href,
              },
            },
            parentCtx
          )
        : null;

    // Use the HTTP span's context for traceparent if it exists, otherwise use parent's
    let effectiveTraceParent = traceParent;
    if (httpSpan) {
      const { traceId, spanId } = httpSpan.spanContext();
      effectiveTraceParent = `00-${traceId}-${spanId}-01`;
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);

      // Set trace header first
      xhr.setRequestHeader("traceparent", effectiveTraceParent);
      xhr.setRequestHeader("Content-Type", "application/json");

      // Set additional headers
      if (options?.headers) {
        const headers = options.headers as Record<string, string>;
        Object.entries(headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== "traceparent") {
            xhr.setRequestHeader(key, value);
          }
        });
      }

      xhr.onload = () => {
        httpSpan?.setAttribute("http.status_code", xhr.status);

        if (xhr.status >= 200 && xhr.status < 300) {
          httpSpan?.setStatus({ code: SpanStatusCode.OK });
          httpSpan?.end();
          try {
            resolve(JSON.parse(xhr.responseText) as R);
          } catch {
            resolve(xhr.responseText as unknown as R);
          }
        } else {
          httpSpan?.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${xhr.status}: ${xhr.statusText}`,
          });
          httpSpan?.end();
          reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
        }
      };

      xhr.onerror = () => {
        httpSpan?.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Network error",
        });
        httpSpan?.end();
        reject(new Error("Network error"));
      };

      if (options?.body) {
        xhr.send(
          typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
        );
      } else {
        xhr.send();
      }
    });
  };
}

/**
 * Create an XMLHttpRequest-based native fetch replacement.
 * Optionally creates a child span for the HTTP request.
 */
function createXhrNativeFetch(
  traceParent: string,
  parentCtx: ReturnType<typeof context.active>
) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";

    // Optionally create a child span for this HTTP request
    const httpSpan =
      ENABLE_MANUAL_SPAN_HTTP_TRACING && tracer
        ? tracer.startSpan(
            getHttpSpanName(method, url),
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "http.method": method.toUpperCase(),
                "http.url": new URL(url, window.location.origin).href,
              },
            },
            parentCtx
          )
        : null;

    // Use the HTTP span's context for traceparent if it exists, otherwise use parent's
    let effectiveTraceParent = traceParent;
    if (httpSpan) {
      const { traceId, spanId } = httpSpan.spanContext();
      effectiveTraceParent = `00-${traceId}-${spanId}-01`;
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);

      xhr.setRequestHeader("traceparent", effectiveTraceParent);

      if (init?.headers) {
        const headers = init.headers as Record<string, string>;
        Object.entries(headers).forEach(([key, value]) => {
          if (key.toLowerCase() !== "traceparent") {
            xhr.setRequestHeader(key, value);
          }
        });
      }

      xhr.onload = () => {
        httpSpan?.setAttribute("http.status_code", xhr.status);

        if (xhr.status >= 200 && xhr.status < 300) {
          httpSpan?.setStatus({ code: SpanStatusCode.OK });
          httpSpan?.end();
        } else {
          httpSpan?.setStatus({
            code: SpanStatusCode.ERROR,
            message: `HTTP ${xhr.status}: ${xhr.statusText}`,
          });
          httpSpan?.end();
        }

        resolve(
          new Response(xhr.responseText, {
            status: xhr.status,
            statusText: xhr.statusText,
          })
        );
      };

      xhr.onerror = () => {
        httpSpan?.setStatus({
          code: SpanStatusCode.ERROR,
          message: "Network error",
        });
        httpSpan?.end();
        reject(new Error("Network error"));
      };

      if (init?.body) {
        xhr.send(init.body as XMLHttpRequestBodyInit);
      } else {
        xhr.send();
      }
    });
  };
}

/**
 * Create a child span factory for a given parent context.
 */
function createChildSpanFactory(parentCtx: ReturnType<typeof context.active>) {
  return <T>(
    name: string,
    fn: (span: Span) => T | Promise<T>,
    options?: SpanOptions
  ): Promise<T> => {
    if (!tracer) {
      return Promise.resolve(fn(null as unknown as Span));
    }

    const childSpan = tracer.startSpan(
      name,
      {
        kind: options?.kind ?? SpanKind.INTERNAL,
        attributes: options?.attributes,
      },
      parentCtx
    );

    return (async () => {
      try {
        const result = await fn(childSpan);
        childSpan.setStatus({ code: SpanStatusCode.OK });
        childSpan.end();
        return result;
      } catch (error) {
        childSpan.recordException(error as Error);
        childSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: (error as Error).message,
        });
        childSpan.end();
        throw error;
      }
    })();
  };
}

// ============================================================================
// Initialization
// ============================================================================

async function initOtelClient(serviceName: string) {
  if (initialized || initPromise) return initPromise;

  initPromise = (async () => {
    try {
      // Dynamic imports for code splitting
      const [
        { WebTracerProvider },
        { SimpleSpanProcessor },
        { OTLPTraceExporter },
        { resourceFromAttributes },
        { ATTR_SERVICE_NAME },
        { ZoneContextManager },
        { W3CTraceContextPropagator },
      ] = await Promise.all([
        import("@opentelemetry/sdk-trace-web"),
        import("@opentelemetry/sdk-trace-base"),
        import("@opentelemetry/exporter-trace-otlp-http"),
        import("@opentelemetry/resources"),
        import("@opentelemetry/semantic-conventions"),
        import("@opentelemetry/context-zone"),
        import("@opentelemetry/core"),
      ]);

      const provider = new WebTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
        spanProcessors: [
          new SimpleSpanProcessor(
            new OTLPTraceExporter({ url: "/api/otel-proxy" })
          ),
        ],
      });

      // Set propagator before registering provider
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());

      // Register with ZoneContextManager for async context propagation
      provider.register({ contextManager: new ZoneContextManager() });

      // Optionally auto-instrument standalone fetch calls
      if (ENABLE_FETCH_AUTO_INSTRUMENTATION) {
        const [{ FetchInstrumentation }, { registerInstrumentations }] =
          await Promise.all([
            import("@opentelemetry/instrumentation-fetch"),
            import("@opentelemetry/instrumentation"),
          ]);

        registerInstrumentations({
          tracerProvider: provider,
          instrumentations: [
            new FetchInstrumentation({
              propagateTraceHeaderCorsUrls: [/.*/],
              ignoreUrls: [/\/api\/otel-proxy/],
              applyCustomAttributesOnSpan: (span) => {
                if (
                  "attributes" in span &&
                  "http.method" in
                    (span.attributes as Record<string, string>) &&
                  "http.url" in (span.attributes as Record<string, string>)
                ) {
                  const attributes = (
                    span as { attributes: Record<string, string> }
                  ).attributes;
                  const pathname = new URL(attributes["http.url"] as string)
                    .pathname;
                  const method = attributes["http.method"] as string;
                  span.updateName(`HTTP ${method.toUpperCase()} ${pathname}`);
                  // attributes are already set by the instrumentation
                }
              },
            }),
          ],
        });
      }

      tracer = provider.getTracer(serviceName, "1.0.0");
      initialized = true;
    } catch (error) {
      console.error("[OTEL] Failed to initialize client tracing:", error);
      initialized = true;
    }
  })();

  return initPromise;
}

// ============================================================================
// Plugin Export
// ============================================================================

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const serviceName = `${config.public.otelServiceName}-client`;

  initOtelClient(serviceName);

  return {
    provide: {
      otel: {
        /** Wait for OTEL to be initialized */
        ready: () => initPromise,

        /** SpanKind enum for span options */
        SpanKind,

        /** SpanStatusCode enum for manual status setting */
        SpanStatusCode,

        /**
         * Create a traced span with automatic trace propagation.
         *
         * The callback receives the span and helpers for making traced requests.
         * Use the provided `$fetch` and `fetch` helpers to ensure trace context
         * is propagated to the backend.
         *
         * @example
         * await $otel.createSpan("checkout", async (span, { $fetch, childSpan }) => {
         *   span.setAttribute("cart.items", 3);
         *
         *   const order = await $fetch("/api/orders", {
         *     method: "POST",
         *     body: { items: cart.items }
         *   });
         *
         *   await childSpan("send-confirmation", async (cs) => {
         *     cs.setAttribute("order.id", order.id);
         *     await sendEmail(order.email);
         *   });
         *
         *   return order;
         * });
         */
        createSpan: async <T>(
          name: string,
          fn: (span: Span, helpers: SpanHelpers) => T | Promise<T>,
          options?: SpanOptions
        ): Promise<T> => {
          await initPromise;

          // Fallback if tracer not initialized
          if (!tracer) {
            const noopHelpers: SpanHelpers = {
              $fetch: $fetch as any,
              fetch: fetch,
              childSpan: async (_, childFn) => childFn(null as unknown as Span),
            };
            return await fn(null as unknown as Span, noopHelpers);
          }

          // Create the span
          const span = tracer.startSpan(name, {
            kind: options?.kind ?? SpanKind.CLIENT,
            attributes: options?.attributes,
          });

          // Build traceparent header from span context
          const { traceId, spanId } = span.spanContext();
          const traceParent = `00-${traceId}-${spanId}-01`;

          // Create context with this span active
          const spanCtx = trace.setSpan(context.active(), span);

          // Build helpers with trace propagation
          const helpers: SpanHelpers = {
            $fetch: createXhrFetch(traceParent, spanCtx),
            fetch: createXhrNativeFetch(traceParent, spanCtx),
            childSpan: createChildSpanFactory(spanCtx),
          };

          try {
            const result = await context.with(spanCtx, () => fn(span, helpers));
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            return result;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: (error as Error).message,
            });
            span.end();
            throw error;
          }
        },
      },
    },
  };
});
