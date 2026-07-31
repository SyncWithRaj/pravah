import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MinioModule } from './common/minio/minio.module';
import { UploadModule } from './upload/upload.module';
import { DownloadModule } from './download/download.module';
import { MetadataModule } from './metadata/metadata.module';
import { KafkaModule } from './common/kafka/kafka.module';

@Module({
  imports: [
    // Load .env file and make ConfigService available globally
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Global Prisma DB connection
    PrismaModule,

    // Global MinIO Object Storage connection
    MinioModule,
    KafkaModule,

    AuthModule,
    UploadModule,
    DownloadModule,
    MetadataModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
