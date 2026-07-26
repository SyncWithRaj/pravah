import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
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

  const port = process.env.APP_PORT ?? 3000;
  await app.listen(port);

  logger.log(`🚀 Pravah CDN Core running on: http://localhost:${port}/api/v1`);
}

bootstrap();
