import { Role } from '@prisma/client';
import { Request } from 'express';
import { AdminApiKeyController, ApiKeyController } from './api-key.controller';
import { ApiKeyService, CreateApiKeyDto } from './api-key.service';

type ApiKeyMock = {
  createApiKey: jest.Mock;
  listUserApiKeys: jest.Mock;
  listAllApiKeys: jest.Mock;
  revokeApiKey: jest.Mock;
};

type AuthenticatedRequest = Request & {
  user: { id: string; role: Role };
};

const requestFor = (id: string, role: Role): AuthenticatedRequest =>
  ({ user: { id, role } }) as AuthenticatedRequest;

const dto: CreateApiKeyDto = { name: 'CI key' };

describe('ApiKeyController', () => {
  let controller: ApiKeyController;
  let adminController: AdminApiKeyController;
  let service: ApiKeyMock;

  beforeEach(() => {
    service = {
      createApiKey: jest.fn().mockResolvedValue({ id: 'key-1' }),
      listUserApiKeys: jest.fn().mockResolvedValue([]),
      listAllApiKeys: jest.fn().mockResolvedValue([]),
      revokeApiKey: jest.fn().mockResolvedValue({ id: 'key-1' }),
    };
    controller = new ApiKeyController(service as unknown as ApiKeyService);
    adminController = new AdminApiKeyController(
      service as unknown as ApiKeyService,
    );
  });

  it('lets an admin create a key with the requested role', async () => {
    await controller.createApiKey(requestFor('admin-1', Role.ADMIN), {
      ...dto,
      role: Role.STREAMER,
    });

    expect(service.createApiKey).toHaveBeenCalledWith('admin-1', {
      ...dto,
      role: Role.STREAMER,
    });
  });

  it('defaults admin-created keys to USER', async () => {
    await controller.createApiKey(requestFor('admin-1', Role.ADMIN), dto);

    expect(service.createApiKey).toHaveBeenCalledWith('admin-1', {
      ...dto,
      role: Role.USER,
    });
  });

  it('prevents non-admins from elevating their key role', async () => {
    await controller.createApiKey(requestFor('streamer-1', Role.STREAMER), {
      ...dto,
      role: Role.ADMIN,
    });

    expect(service.createApiKey).toHaveBeenCalledWith('streamer-1', {
      ...dto,
      role: Role.STREAMER,
    });
  });

  it('lists and revokes keys for the authenticated user', async () => {
    await controller.listUserApiKeys(requestFor('user-1', Role.USER));
    await controller.revokeApiKey(requestFor('user-1', Role.USER), 'key-1');

    expect(service.listUserApiKeys).toHaveBeenCalledWith('user-1');
    expect(service.revokeApiKey).toHaveBeenCalledWith('key-1', 'user-1', false);
  });

  it('marks revokes as admin when the caller is an admin', async () => {
    await controller.revokeApiKey(requestFor('admin-1', Role.ADMIN), 'key-1');

    expect(service.revokeApiKey).toHaveBeenCalledWith('key-1', 'admin-1', true);
  });

  it('lets admins list and revoke every key', async () => {
    await adminController.listAllApiKeys();
    await adminController.adminRevokeApiKey('key-9');

    expect(service.listAllApiKeys).toHaveBeenCalled();
    expect(service.revokeApiKey).toHaveBeenCalledWith('key-9', undefined, true);
  });
});
