import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Global validation pipe — auto-validates all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip unknown fields from requests
      forbidNonWhitelisted: true, // Throw error if unknown fields sent
      transform: true, // Auto-transform payloads to DTO class instances
    }),
  );

  // Global API prefix — all routes will be /api/v1/...
  app.setGlobalPrefix('api/v1');

  // Connect to Kafka Microservice for receiving cluster events
  // We use a random consumer group ID so EVERY edge node receives the broadcast!
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: [process.env.KAFKA_BROKERS || 'localhost:19092'],
      },
      consumer: {
        groupId: 'pravah-core-edge-' + Math.random().toString(36).substring(7),
      },
    },
  });

  await app.startAllMicroservices();

  const port = process.env.APP_PORT ?? 3000;
  await app.listen(port);

  logger.log(`Pravah CDN Core running on: http://localhost:${port}/api/v1`);
}

void bootstrap();
