import {
  trace,
  propagation,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";

let initialized = false;
let initPromise: Promise<void> | null = null;
let tracer: ReturnType<typeof trace.getTracer> | null = null;

async function initOtelClient(serviceName: string) {
  if (initialized || initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const { WebTracerProvider } = await import(
        "@opentelemetry/sdk-trace-web"
      );
      const { SimpleSpanProcessor } = await import(
        "@opentelemetry/sdk-trace-base"
      );
      const { OTLPTraceExporter } = await import(
        "@opentelemetry/exporter-trace-otlp-http"
      );
      const { Resource } = await import("@opentelemetry/resources");
      const { SEMRESATTRS_SERVICE_NAME } = await import(
        "@opentelemetry/semantic-conventions"
      );
      const { ZoneContextManager } = await import(
        "@opentelemetry/context-zone"
      );
      const { FetchInstrumentation } = await import(
        "@opentelemetry/instrumentation-fetch"
      );
      const { registerInstrumentations } = await import(
        "@opentelemetry/instrumentation"
      );
      const { W3CTraceContextPropagator } = await import("@opentelemetry/core");

      const provider = new WebTracerProvider({
        resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: serviceName }),
      });

      provider.addSpanProcessor(
        new SimpleSpanProcessor(
          new OTLPTraceExporter({ url: "/api/otel-proxy" })
        )
      );
      provider.register({ contextManager: new ZoneContextManager() });
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());

      registerInstrumentations({
        instrumentations: [
          new FetchInstrumentation({
            propagateTraceHeaderCorsUrls: [
              new RegExp(`${window.location.origin}/.*`),
            ],
            ignoreUrls: [/\/api\/otel-proxy/],
          }),
        ],
      });

      tracer = trace.getTracer(serviceName, "1.0.0");
      initialized = true;
    } catch (error) {
      console.error("[OTEL Client] Failed to initialize:", error);
      initialized = true;
    }
  })();

  return initPromise;
}

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig();
  const serviceName = `${config.public.otelServiceName}-client`;

  initOtelClient(serviceName);

  return {
    provide: {
      otel: {
        ready: () => initPromise,
        SpanKind,
        createSpan: async <T>(
          name: string,
          fn: () => T | Promise<T>,
          options?: {
            kind?: SpanKind;
            attributes?: Record<string, string | number | boolean>;
          }
        ): Promise<T> => {
          await initPromise;
          if (!tracer) return await fn();

          return tracer.startActiveSpan(
            name,
            { kind: options?.kind, attributes: options?.attributes },
            async (span) => {
              try {
                const result = await fn();
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
            }
          );
        },
      },
    },
  };
});
