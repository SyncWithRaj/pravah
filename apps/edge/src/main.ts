import './tracer';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      keepAliveTimeout: 60000,
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
      'X-Cache',
      'X-Trace-Id',
      'traceparent',
      'tracestate',
      'ETag',
      'Content-Range',
      'Content-Encoding',
      'Location',
    ],
  });

  const port = process.env.PORT || 4001;
  const edgeNodeId = process.env.EDGE_NODE_ID || 'edge-node-01';
  
  await app.listen(port, '0.0.0.0');
  
  Logger.log(`Edge Node [${edgeNodeId}] running on port ${port} with Fastify Engine`, 'Bootstrap');
}
bootstrap();

