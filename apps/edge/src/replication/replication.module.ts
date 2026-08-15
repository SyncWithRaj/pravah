import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ReplicationProcessor } from './replication.processor';
import { CacheModule } from '../cache/cache.module';
import { MinioModule } from '../minio/minio.module';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    HttpModule,
    CacheModule,
    MinioModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        connection: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get('REDIS_PORT', 6379),
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue({
      name: 'replication.normal',
    }),
  ],
  providers: [ReplicationProcessor],
})
export class ReplicationModule {}
