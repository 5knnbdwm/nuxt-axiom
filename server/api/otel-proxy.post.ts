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
