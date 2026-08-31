import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import {
  ApiKeyController,
  AdminApiKeyController,
} from './api-key/api-key.controller';
import { ApiKeyService } from './api-key/api-key.service';
import { RolesGuard } from './guards/roles.guard';
import { ApiKeyGuard } from './guards/api-key.guard';
import { InterServiceGuard } from './guards/inter-service.guard';
import { UnifiedAuthGuard } from './guards/unified-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') ||
          'super-secret-default-key-change-me',
        signOptions: { expiresIn: '7d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, ApiKeyController, AdminApiKeyController],
  providers: [
    AuthService,
    JwtStrategy,
    JwtAuthGuard,
    ApiKeyService,
    RolesGuard,
    ApiKeyGuard,
    InterServiceGuard,
    UnifiedAuthGuard,
  ],
  exports: [
    JwtStrategy,
    JwtAuthGuard,
    PassportModule,
    ApiKeyService,
    RolesGuard,
    ApiKeyGuard,
    InterServiceGuard,
    UnifiedAuthGuard,
  ],
})
export class AuthModule {}
