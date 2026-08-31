import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Role } from '@prisma/client';
import * as crypto from 'crypto';

export interface CreateApiKeyDto {
  name: string;
  role?: Role;
  expiresInDays?: number;
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  async createApiKey(userId: string | null, dto: CreateApiKeyDto) {
    const rawRandom = crypto.randomBytes(24).toString('hex');
    const rawKey = `prv_live_${rawRandom}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = `prv_live_${rawRandom.substring(0, 8)}...`;

    let expiresAt: Date | null = null;
    if (dto.expiresInDays && dto.expiresInDays > 0) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + dto.expiresInDays);
    }

    const apiKey = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        keyHash,
        keyPrefix,
        role: dto.role || Role.STREAMER,
        userId: userId || undefined,
        expiresAt,
        isActive: true,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      apiKey: rawKey, // Plaintext returned ONLY ONCE upon creation
      keyPrefix: apiKey.keyPrefix,
      role: apiKey.role,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      message:
        'Save this API key securely. You will not be able to view it again.',
    };
  }

  async listUserApiKeys(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        role: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listAllApiKeys() {
    return this.prisma.apiKey.findMany({
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        role: true,
        userId: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
        isActive: true,
        user: {
          select: {
            id: true,
            email: true,
            username: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeApiKey(keyId: string, userId?: string, isAdmin = false) {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
    });

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    if (!isAdmin && userId && key.userId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to revoke this API key',
      );
    }

    return this.prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        isActive: true,
        updatedAt: true,
      },
    });
  }
}
