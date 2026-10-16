import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ReplicationProcessor } from './replication.processor';
import { CacheModule } from '../cache/cache.module';
import { MinioModule } from '../minio/minio.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { REDIS_PASSWORD } from '../common/redis/redis.constants';

@Module({
  imports: [
    HttpModule,
    CacheModule,
    MinioModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => {
        const password =
          configService.get<string>('REDIS_PASSWORD') || REDIS_PASSWORD();
        const edgeNodeId =
          configService.get<string>('EDGE_NODE_ID', 'edge-node-01');
        return {
          prefix: edgeNodeId,
          connection: {
            host:
              configService.get<string>('BULLMQ_REDIS_HOST') ||
              configService.get<string>('CORE_REDIS_HOST') ||
              configService.get<string>('REDIS_HOST') ||
              'redis',
            port: configService.get<number>('BULLMQ_REDIS_PORT') || 6379,
            ...(password ? { password } : {}),
          },
        };
      },
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'replication.normal',
    }),
  ],
  providers: [ReplicationProcessor],
})
export class ReplicationModule {}
