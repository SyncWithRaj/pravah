import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ContentModule } from './content/content.module';
import { ReplicationModule } from './replication/replication.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '../../.env',
    }),
    ScheduleModule.forRoot(),
    ContentModule,
    ReplicationModule,
    HeartbeatModule,
    MetricsModule,
  ],
})
export class AppModule {}
