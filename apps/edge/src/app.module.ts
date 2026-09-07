import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ContentModule } from './content/content.module';
import { ReplicationModule } from './replication/replication.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { MetricsModule } from './metrics/metrics.module';
import { KafkaModule } from './kafka/kafka.module';
import { AppController } from './app.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    ScheduleModule.forRoot(),
    KafkaModule,
    ContentModule,
    ReplicationModule,
    HeartbeatModule,
    MetricsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
