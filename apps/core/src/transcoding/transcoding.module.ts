import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TranscodingService } from './transcoding.service';
import { TranscodingController } from './transcoding.controller';
import { TranscodingProcessor } from './transcoding.processor';
import { KafkaModule } from '../common/kafka/kafka.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MinioModule } from '../common/minio/minio.module';
import { TRANSCODE_QUEUE_NAME } from './transcoding.constants';

@Module({
  imports: [
    ConfigModule,
    KafkaModule,
    PrismaModule,
    MinioModule,

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
      name: TRANSCODE_QUEUE_NAME,
    }),
  ],
  controllers: [TranscodingController],
  providers: [TranscodingService, TranscodingProcessor],
  exports: [TranscodingService],
})
export class TranscodingModule {}
