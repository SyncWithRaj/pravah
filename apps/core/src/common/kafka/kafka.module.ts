import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { KafkaService } from './kafka.service';
import { getKafkaSaslConfig } from './kafka.config';

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: 'KAFKA_CLIENT',
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => {
          const sasl = getKafkaSaslConfig(
            configService.get<string>('KAFKA_SASL_USERNAME'),
            configService.get<string>('KAFKA_SASL_PASSWORD'),
            configService.get<string>('KAFKA_SASL_MECHANISM'),
          );

          return {
            transport: Transport.KAFKA,
            options: {
              client: {
                clientId: 'pravah-core',
                brokers: [
                  configService.get<string>('KAFKA_BROKERS') || 'localhost:19092',
                ],
                ...(sasl ? { sasl } : {}),
              },
              producerOnlyMode: true,
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [KafkaService],
  exports: [KafkaService],
})
export class KafkaModule {}
