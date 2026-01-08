# OpenTelemetry + Axiom Implementation Guide

A complete distributed tracing setup for Nuxt 4 applications with automatic trace propagation between browser and server, exporting to Axiom.

## Overview

This implementation provides:

- **Server-side tracing** with Node.js OpenTelemetry SDK
- **Client-side tracing** with Web Tracer Provider
- **Distributed trace propagation** via W3C Trace Context headers
- **OTEL Proxy endpoint** to securely forward browser traces to Axiom
- **Type-safe error handling** with neverthrow Result types
- **Helper utilities** for creating spans, traced handlers, and background tasks

---

## Dependencies

Add these to your `package.json`:

```json
{
  "dependencies": {
    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/context-zone": "2.2.0",
    "@opentelemetry/core": "2.2.0",
    "@opentelemetry/exporter-trace-otlp-http": "0.208.0",
    "@opentelemetry/exporter-trace-otlp-proto": "0.208.0",
    "@opentelemetry/instrumentation": "0.208.0",
    "@opentelemetry/instrumentation-fetch": "0.208.0",
    "@opentelemetry/resources": "2.2.0",
    "@opentelemetry/sdk-node": "0.208.0",
    "@opentelemetry/sdk-trace-base": "2.2.0",
    "@opentelemetry/sdk-trace-web": "2.2.0",
    "@opentelemetry/semantic-conventions": "1.34.0",
    "neverthrow": "^8.2.0"
  }
}
```

---

## Environment Variables

Create a `.env` file:

```env
AXIOM_TOKEN=your-axiom-api-token
AXIOM_DATASET=your-axiom-dataset-name
OTEL_SERVICE_NAME=your-service-name
```

---

## Nuxt Configuration

Add to `nuxt.config.ts`:

```typescript
export default defineNuxtConfig({
  runtimeConfig: {
    // Server-only (private)
    axiomToken: process.env.AXIOM_TOKEN,
    axiomDataset: process.env.AXIOM_DATASET,
    // Client-accessible (public)
    public: {
      otelServiceName: process.env.OTEL_SERVICE_NAME || "my-app",
    },
  },
  // Suppress OpenTelemetry build warnings
  vite: {
    build: {
      rollupOptions: {
        onwarn(warning, warn) {
          if (
            warning.code === "THIS_IS_UNDEFINED" &&
            warning.id?.includes("@opentelemetry")
          ) {
            return;
          }
          warn(warning);
        },
      },
    },
  },
  nitro: {
    rollupConfig: {
      onwarn(warning, warn) {
        if (
          warning.code === "THIS_IS_UNDEFINED" &&
          warning.id?.includes("@opentelemetry")
        ) {
          return;
        }
        if (
          warning.code === "CIRCULAR_DEPENDENCY" &&
          warning.message?.includes("node_modules")
        ) {
          return;
        }
        warn(warning);
      },
    },
  },
});
```

---

## File Structure

```
your-nuxt-project/
├── app/
│   └── plugins/
│       └── otel.client.ts      # Client-side OTEL initialization
├── server/
│   ├── api/
│   │   └── otel-proxy.post.ts  # Proxy for browser → Axiom
│   ├── middleware/
│   │   └── auth.ts             # Example traced middleware
│   ├── plugins/
│   │   └── otel.ts             # Server-side OTEL initialization
│   └── utils/
│       └── otel.ts             # Server tracing utilities
└── nuxt.config.ts
```

---

## Server-Side Implementation

### 1. Server Plugin (`server/plugins/otel.ts`)

Initializes OpenTelemetry as early as possible in the server lifecycle:

```typescript
import { initOtel } from "../utils/otel";

export default defineNitroPlugin(async () => {
  await initOtel();
});
```

### 2. Server Utilities (`server/utils/otel.ts`)

```typescript
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

export interface TracedErr {
  message: string;
  traceId: string;
  spanId: string;
  statusCode: number;
  cause?: unknown;
}

export interface HandlerError {
  message: string;
  statusCode: number;
}

export interface SpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
}

// ============================================================================
// State
// ============================================================================

let sdk: NodeSDKType | null = null;
let initialized = false;

// ============================================================================
// Initialization
// ============================================================================

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

  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({
      // Change region as needed: us, eu-central-1, etc.
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

export function getTracer() {
  const config = useRuntimeConfig();
  return trace.getTracer(config.public.otelServiceName as string, "1.0.0");
}

export function extractTraceContext(event: H3Event) {
  const headers = getHeaders(event);
  const carrier: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value) carrier[key] = value;
  }
  return propagation.extract(ROOT_CONTEXT, carrier);
}

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
 * Create a span that continues from frontend trace context.
 * Adds X-Trace-Id and X-Span-Id response headers.
 */
export function createSpanFromRequest<T, E>(
  event: H3Event,
  name: string,
  fn: (span: Span) => Promise<Result<T, E>>,
  options?: SpanOptions
): Promise<Result<T, E & { traceId: string; spanId: string }>> {
  const parentContext = extractTraceContext(event);
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

        setHeader(event, "X-Trace-Id", traceId);
        setHeader(event, "X-Span-Id", spanId);

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
// Handler Factory
// ============================================================================

/**
 * Define a traced event handler with automatic error handling.
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
```

### 3. OTEL Proxy Endpoint (`server/api/otel-proxy.post.ts`)

This proxies browser traces to Axiom (avoiding CORS and hiding API keys):

```typescript
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig();
  const axiomToken = config.axiomToken as string;
  const axiomDataset = config.axiomDataset as string;

  if (!axiomToken || !axiomDataset) {
    throw createError({
      statusCode: 500,
      statusMessage: "OTEL proxy not configured",
    });
  }

  const body = await readRawBody(event);
  if (!body) {
    throw createError({
      statusCode: 400,
      statusMessage: "No trace data provided",
    });
  }

  const contentType = getHeader(event, "content-type") || "application/json";

  const response = await fetch(
    "https://eu-central-1.aws.edge.axiom.co/v1/traces",
    {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        Authorization: `Bearer ${axiomToken}`,
        "X-Axiom-Dataset": axiomDataset,
      },
      body,
    }
  );

  if (!response.ok) {
    console.error("[OTEL Proxy] Failed:", await response.text());
    throw createError({
      statusCode: response.status,
      statusMessage: "Failed to forward traces",
    });
  }

  return { success: true };
});
```

---

## Client-Side Implementation

### Client Plugin (`app/plugins/otel.client.ts`)

```typescript
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

/** Enable auto-instrumentation of all fetch calls outside of createSpan */
const ENABLE_FETCH_AUTO_INSTRUMENTATION = true;

/** Enable child HTTP spans for fetch calls made within createSpan() */
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
  $fetch: <R = unknown>(
    url: string,
    options?: Parameters<typeof $fetch>[1]
  ) => Promise<R>;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
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

function getHttpSpanName(method: string, url: string): string {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    return `HTTP ${method.toUpperCase()} ${pathname}`;
  } catch {
    return `HTTP ${method.toUpperCase()}`;
  }
}

function createXhrFetch(
  traceParent: string,
  parentCtx: ReturnType<typeof context.active>
) {
  return <R = unknown>(
    url: string,
    options?: Parameters<typeof $fetch>[1]
  ): Promise<R> => {
    const method = (options?.method as string) || "GET";

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

    let effectiveTraceParent = traceParent;
    if (httpSpan) {
      const { traceId, spanId } = httpSpan.spanContext();
      effectiveTraceParent = `00-${traceId}-${spanId}-01`;
    }

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);

      xhr.setRequestHeader("traceparent", effectiveTraceParent);
      xhr.setRequestHeader("Content-Type", "application/json");

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

function createXhrNativeFetch(
  traceParent: string,
  parentCtx: ReturnType<typeof context.active>
) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method || "GET";

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

      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      provider.register({ contextManager: new ZoneContextManager() });

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
        ready: () => initPromise,
        SpanKind,
        SpanStatusCode,

        createSpan: async <T>(
          name: string,
          fn: (span: Span, helpers: SpanHelpers) => T | Promise<T>,
          options?: SpanOptions
        ): Promise<T> => {
          await initPromise;

          if (!tracer) {
            const noopHelpers: SpanHelpers = {
              $fetch: $fetch as any,
              fetch: fetch,
              childSpan: async (_, childFn) => childFn(null as unknown as Span),
            };
            return await fn(null as unknown as Span, noopHelpers);
          }

          const span = tracer.startSpan(name, {
            kind: options?.kind ?? SpanKind.CLIENT,
            attributes: options?.attributes,
          });

          const { traceId, spanId } = span.spanContext();
          const traceParent = `00-${traceId}-${spanId}-01`;
          const spanCtx = trace.setSpan(context.active(), span);

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
```

---

## Usage Examples

### Server: API Handler with Tracing

```typescript
// server/api/users/[id].get.ts
import { defineTracedHandler, createSpan, ok, err } from "../utils/otel";

export default defineTracedHandler("get-user-handler", async (event, span) => {
  const userId = getRouterParam(event, "id");
  span.setAttribute("user.id", userId);

  // Nested span for database operation
  const userResult = await createSpan("db.find-user", async (dbSpan) => {
    dbSpan.setAttribute("db.table", "users");

    const user = await db.users.findUnique({ where: { id: userId } });
    if (!user) {
      return err({ message: "User not found", statusCode: 404 });
    }
    return ok(user);
  });

  if (userResult.isErr()) {
    return err(userResult.error);
  }

  return ok(userResult.value);
});
```

### Server: Service with Tracing

```typescript
// server/utils/user-service.ts
import { createSpan, ok, err, type Result } from "./otel";

export async function fetchUser(
  userId: number
): Promise<Result<User, UserError>> {
  return createSpan("user-service.fetchUser", async (span) => {
    span.setAttribute("user.id", userId);

    const user = await db.users.findUnique({ where: { id: userId } });

    if (!user) {
      return err({ code: "NOT_FOUND", message: "User not found" });
    }

    return ok(user);
  });
}
```

### Server: Background Tasks

```typescript
import { createSpanInBackground, ok } from "../utils/otel";

// Fire and forget - doesn't block response
createSpanInBackground("send-welcome-email", async (span) => {
  span.setAttribute("email.type", "welcome");
  span.setAttribute("user.id", userId);

  await emailService.send(userId, "welcome");

  return ok(undefined);
});
```

### Server: Traced Middleware

Middleware runs before handlers. Use `defineTracedMiddleware` to create spans that appear in the same trace as your handlers.

**Important:** Nitro middleware runs for ALL requests (pages, assets, APIs). Wrap with a path check to only trace API routes:

```typescript
// server/middleware/auth.ts
import { defineTracedMiddleware, ok, err } from "../utils/otel";

// Create the traced middleware
const authMiddleware = defineTracedMiddleware(
  "auth-middleware",
  async (event, span) => {
    const token = getHeader(event, "authorization");
    span.setAttribute("auth.has_token", !!token);

    if (!token) {
      return err({ message: "Unauthorized", statusCode: 401 });
    }

    // Simulate token validation
    const user = await validateToken(token);
    if (!user) {
      span.setAttribute("auth.invalid_token", true);
      return err({ message: "Invalid token", statusCode: 401 });
    }

    // Store user in event context for handlers
    span.setAttribute("auth.user_id", user.id);
    event.context.user = user;

    return ok(undefined);
  }
);

// Only run for API routes - skip page loads, assets, otel-proxy, etc.
export default defineEventHandler((event) => {
  if (!event.path.startsWith("/api/") || event.path === "/api/otel-proxy") {
    return; // Skip non-API routes and internal endpoints
  }
  return authMiddleware(event);
});
```

The trace context flows automatically from middleware to handlers:

```
Browser request
    │
    ▼
[auth-middleware] ──────────────────────┐
    │                                   │
    ▼                                   │  Same trace
[get-user-handler]                      │
    │                                   │
    ▼                                   │
[db.find-user] ─────────────────────────┘
```

### Client: Vue Component with Tracing

```vue
<script setup lang="ts">
const { $otel } = useNuxtApp();

async function checkout() {
  await $otel.createSpan(
    "checkout-flow",
    async (span, { $fetch, childSpan }) => {
      span.setAttribute("cart.items", cart.value.length);

      // This fetch automatically propagates trace context to the server
      const order = await $fetch("/api/orders", {
        method: "POST",
        body: { items: cart.value },
      });

      // Create a nested child span
      await childSpan("process-confirmation", async (cs) => {
        cs.setAttribute("order.id", order.id);
        showConfirmation(order);
      });

      return order;
    }
  );
}
</script>
```

---

## Axiom Configuration

### Region Endpoints

Choose the endpoint closest to your users:

| Region         | Endpoint                                           |
| -------------- | -------------------------------------------------- |
| US             | `https://api.axiom.co/v1/traces`                   |
| EU (Frankfurt) | `https://eu-central-1.aws.edge.axiom.co/v1/traces` |

Update the URL in both:

- `server/utils/otel.ts` → `OTLPTraceExporter` URL
- `server/api/otel-proxy.post.ts` → fetch URL

### Viewing Traces in Axiom

1. Go to your Axiom dashboard
2. Navigate to **Stream** and select your dataset
3. Use the **Traces** view to see distributed traces
4. Filter by `service.name` to see frontend vs backend spans
5. Click on a trace to see the full waterfall view

---

## Key Concepts

### Trace Propagation Flow

```
Browser (client span)
    │
    │ traceparent header: 00-{traceId}-{spanId}-01
    ▼
Server (extracts context, creates child span)
    │
    │ automatic context propagation
    ▼
Database/Service calls (child spans)
```

### neverthrow Result Pattern

All traced functions return `Result<T, E>` for type-safe error handling:

```typescript
const result = await createSpan("operation", async (span) => {
  if (someCondition) {
    return err({ message: "Failed", code: "ERROR" });
  }
  return ok(data);
});

if (result.isErr()) {
  // Handle error with full type safety
  console.error(result.error.message);
} else {
  // Use result.value
}
```

### Why XHR Instead of fetch?

The client uses `XMLHttpRequest` instead of `fetch` for traced requests to bypass the auto-instrumentation's fetch interception and ensure the `traceparent` header is sent exactly as specified.

---

## Troubleshooting

### Traces Not Appearing

1. Check that `AXIOM_TOKEN` and `AXIOM_DATASET` are set
2. Verify the Axiom endpoint URL matches your region
3. Check browser console for `[OTEL]` errors
4. Check server logs for initialization messages

### Disconnected Traces

If frontend and backend spans don't connect:

1. Ensure `traceparent` header is being sent (check Network tab)
2. Verify the server is extracting context with `extractTraceContext()`
3. Make sure you're using `createSpanFromRequest()` for HTTP handlers

### Build Warnings

The `nuxt.config.ts` suppresses common OpenTelemetry build warnings. If you see new warnings, add them to the `onwarn` handlers.

---

## Summary

This implementation provides full distributed tracing with:

- ✅ Automatic trace propagation from browser to server
- ✅ Type-safe error handling with neverthrow
- ✅ Secure proxy for browser traces (no exposed API keys)
- ✅ Middleware tracing with context propagation to handlers
- ✅ Background task tracing
- ✅ Nested span support
- ✅ Automatic HTTP span creation
- ✅ W3C Trace Context standard compliance
