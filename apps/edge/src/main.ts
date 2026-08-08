import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  const port = process.env.PORT || 4001;
  const edgeNodeId = process.env.EDGE_NODE_ID || 'edge-node-01';
  
  await app.listen(port);
  
  Logger.log(`Edge Node [${edgeNodeId}] running on port ${port}`, 'Bootstrap');
}
bootstrap();
