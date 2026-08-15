import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

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

  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    exposedHeaders: [
      'X-CDN-Edge',
      'X-CDN-Region',
      'X-CDN-Distance-Km',
      'X-CDN-Strategy',
      'ETag',
      'Content-Range',
      'Content-Encoding',
      'Location',
    ],
  });

  app.setGlobalPrefix('api/v1');

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
