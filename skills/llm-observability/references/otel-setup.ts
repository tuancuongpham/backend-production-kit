// OpenTelemetry bootstrap for a Node service. Load it before anything else:
//   node --import ./otel-setup.ts server.ts
// Packages (not installed by the kit; this file is NOT executed by verify/):
//   npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-proto
// Check exact APIs against the installed versions; the OTel JS SDK moves quickly.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';

// Preferred: send everything to a local OTel Collector (see collector.yaml), which fans out to
// Langfuse for LLM traces and Tempo/Jaeger/your APM for everything. Apps then don't hold vendor keys.
// Direct-to-Langfuse alternative:
//   url: `${process.env.LANGFUSE_HOST}/api/public/otel/v1/traces`
//   headers: { Authorization: 'Basic ' + base64(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`) }
const exporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://localhost:4318/v1/traces',
});

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'api',
  traceExporter: exporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false }, // very noisy
      // pg spans with the SQL text; parameters are not recorded by default — keep it that way (PII).
      '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false },
    }),
  ],
});

sdk.start();

/**
 * Flush the last spans, or the most interesting ones (right before a deploy or a crash) are lost. Call it from
 * your graceful shutdown, after the HTTP drain: with service-hardening, `onShutdown: [shutdownTelemetry]`. The app
 * imports it from this same module (`import { shutdownTelemetry } from './otel-setup.ts'`); ESM loads a module
 * once, so that is the instance --import started.
 * There is deliberately no process.on('SIGTERM') here. Any SIGTERM listener replaces Node's default exit: one
 * that only flushes leaves the process running until the orchestrator's SIGKILL, and one that exits cuts the
 * graceful drain short.
 */
export const shutdownTelemetry = () => sdk.shutdown();
