import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    // Load .env file and make ConfigService available globally
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Global Prisma DB connection
    PrismaModule,

    // Feature modules (we'll add these as we build them)
    // AuthModule,
    // UploadModule,
    // DownloadModule,
    // MetadataModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
