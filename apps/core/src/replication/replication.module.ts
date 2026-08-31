import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ReplicationService } from './replication.service';
import { ReplicationController } from './replication.controller';
import { DlqController } from './dlq.controller';
import { ReplicationProcessor } from './replication.processor';
import { KafkaModule } from '../common/kafka/kafka.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MinioModule } from '../common/minio/minio.module';
import { HealthCheckModule } from '../common/health-check/health-check.module';
import { EdgeCacheModule } from '../common/edge-cache/edge-cache.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    KafkaModule,
    PrismaModule,
    MinioModule,
    HealthCheckModule,
    EdgeCacheModule,
    AuthModule,

    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('REDIS_HOST') || 'localhost',
          port: configService.get<number>('REDIS_PORT') || 6379,
        },
      }),
    }),

    BullModule.registerQueue({
      name: 'replication.normal',
    }),
  ],
  controllers: [ReplicationController, DlqController],
  providers: [ReplicationService, ReplicationProcessor],
  exports: [ReplicationService],
})
export class ReplicationModule {}
