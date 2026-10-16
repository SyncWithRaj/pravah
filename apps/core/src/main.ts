import './tracer';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AppModule } from './app.module';
import { getKafkaSaslConfig } from './common/kafka/kafka.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useWebSocketAdapter(new IoAdapter(app));

  // Topology Decision for trust proxy:
  // Pravah Core is exposed directly on port 3000 to clients, dashboard, and edge nodes;
  // it does not sit behind an nginx reverse proxy in this deployment topology (nginx edge-proxy
  // only fronts the edge nodes on port 8000/3001). Therefore, we intentionally do NOT enable
  // 'trust proxy', ensuring request.ip resolves securely to the direct socket remote address
  // and cannot be spoofed via forged X-Forwarded-For headers.

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    exposedHeaders: [
      'X-CDN-Edge',
      'X-CDN-Region',
      'X-CDN-Distance-Km',
      'X-CDN-Strategy',
      'X-Trace-Id',
      'traceparent',
      'tracestate',
      'ETag',
      'Content-Range',
      'Content-Encoding',
      'Location',
    ],
  });

  app.setGlobalPrefix('api/v1');

  const saslConfig = getKafkaSaslConfig(
    process.env.KAFKA_SASL_USERNAME,
    process.env.KAFKA_SASL_PASSWORD,
    process.env.KAFKA_SASL_MECHANISM,
  );

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: [process.env.KAFKA_BROKERS || 'localhost:19092'],
        ...(saslConfig ? { sasl: saslConfig } : {}),
      },
      consumer: {
        groupId: process.env.KAFKA_GROUP_ID || 'pravah-core-cluster-group',
      },
    },
  });

  await app.startAllMicroservices();

  const port = process.env.APP_PORT ?? 3000;
  await app.listen(port);

  logger.log(`Pravah CDN Core running on: http://localhost:${port}/api/v1`);
}

void bootstrap();
