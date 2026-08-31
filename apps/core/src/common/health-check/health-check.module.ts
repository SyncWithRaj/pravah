import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthCheckService } from './health-check.service';
import { HealthCheckController } from './health-check.controller';
import { KafkaModule } from '../kafka/kafka.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    KafkaModule,
    PrismaModule,
    AuthModule,
  ],
  controllers: [HealthCheckController],
  providers: [HealthCheckService],
  exports: [HealthCheckService],
})
export class HealthCheckModule {}
