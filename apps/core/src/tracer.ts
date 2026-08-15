import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';

if (process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/traces`
  : 'http://jaeger:4318/v1/traces';

const serviceName = process.env.OTEL_SERVICE_NAME || 'pravah-core';

const traceExporter = new OTLPTraceExporter({
  url: otelEndpoint,
});

export const otelSdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: '1.0.0',
    'deployment.environment': process.env.NODE_ENV || 'development',
  }),
  traceExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': {
        enabled: false,
      },
      '@opentelemetry/instrumentation-http': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-express': {
        enabled: true,
      },
      '@opentelemetry/instrumentation-ioredis': {
        enabled: true,
      },
    }),
  ],
});

try {
  otelSdk.start();
  console.log(
    `[OpenTelemetry] Tracer initialized for service: ${serviceName} -> ${otelEndpoint}`,
  );
} catch (error) {
  console.error(
    '[OpenTelemetry] Failed to initialize OpenTelemetry SDK:',
    error,
  );
}

process.on('SIGTERM', () => {
  otelSdk
    .shutdown()
    .then(() => console.log('[OpenTelemetry] SDK terminated'))
    .catch((err) =>
      console.error('[OpenTelemetry] Error terminating SDK', err),
    );
});
