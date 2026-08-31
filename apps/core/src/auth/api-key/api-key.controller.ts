import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiKeyService, CreateApiKeyDto } from './api-key.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Controller('auth/api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  async createApiKey(
    @Req() req: Request & { user: { id: string; role: Role } },
    @Body() dto: CreateApiKeyDto,
  ) {
    if (dto.role && req.user.role !== Role.ADMIN) {
      dto.role = req.user.role;
    }
    return this.apiKeyService.createApiKey(req.user.id, dto);
  }

  @Get()
  async listUserApiKeys(
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.apiKeyService.listUserApiKeys(req.user.id);
  }

  @Delete(':id')
  async revokeApiKey(
    @Req() req: Request & { user: { id: string; role: Role } },
    @Param('id') id: string,
  ) {
    const isAdmin = req.user.role === Role.ADMIN;
    return this.apiKeyService.revokeApiKey(id, req.user.id, isAdmin);
  }
}

@Controller('admin/api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Get()
  async listAllApiKeys() {
    return this.apiKeyService.listAllApiKeys();
  }

  @Delete(':id')
  async adminRevokeApiKey(@Param('id') id: string) {
    return this.apiKeyService.revokeApiKey(id, undefined, true);
  }
}
