import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { HeartbeatService } from './heartbeat.service';

@Module({
  imports: [HttpModule],
  providers: [HeartbeatService],
})
export class HeartbeatModule {}
