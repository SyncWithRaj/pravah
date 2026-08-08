import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ContentModule } from './content/content.module';
import { ReplicationModule } from './replication/replication.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    ContentModule,
    ReplicationModule,
    HeartbeatModule,
  ],
})
export class AppModule {}
