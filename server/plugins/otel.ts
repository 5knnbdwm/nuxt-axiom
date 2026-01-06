import { initOtel } from "../utils/otel";

export default defineNitroPlugin(async () => {
  // Initialize OpenTelemetry as early as possible
  await initOtel();
});
