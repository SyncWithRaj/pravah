import './tracer';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
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
  
  await app.listen(port);
  
  Logger.log(`Edge Node [${edgeNodeId}] running on port ${port}`, 'Bootstrap');
}
bootstrap();
