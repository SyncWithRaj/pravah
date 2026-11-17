import { User } from '@prisma/client';
import {
  MetadataController,
  InternalMetadataController,
} from './metadata.controller';
import { MetadataService } from './metadata.service';

type MetadataMock = {
  findAll: jest.Mock;
  findOne: jest.Mock;
  findVersions: jest.Mock;
  remove: jest.Mock;
  findInternalVersion: jest.Mock;
  findInternalFile: jest.Mock;
};

const user = { id: 'user-1', email: 'user@example.com' } as User;

describe('MetadataController', () => {
  let controller: MetadataController;
  let internal: InternalMetadataController;
  let service: MetadataMock;

  beforeEach(() => {
    service = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      findOne: jest.fn().mockResolvedValue({ id: 'file-1' }),
      findVersions: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue({ success: true }),
      findInternalVersion: jest.fn().mockResolvedValue({}),
      findInternalFile: jest.fn().mockResolvedValue({}),
    };
    controller = new MetadataController(service as unknown as MetadataService);
    internal = new InternalMetadataController(
      service as unknown as MetadataService,
    );
  });

  it('lists files with the query filters', async () => {
    await controller.getFiles(user, { page: 2, limit: 5 });

    expect(service.findAll).toHaveBeenCalledWith('user-1', {
      page: 2,
      limit: 5,
    });
  });

  it('loads file details, versions, and deletes with the caller identity', async () => {
    await controller.getFileDetails(user, 'file-1');
    await controller.getFileVersions(user, 'file-1');
    await controller.deleteFile(user, 'file-1');

    expect(service.findOne).toHaveBeenCalledWith('user-1', 'file-1');
    expect(service.findVersions).toHaveBeenCalledWith('user-1', 'file-1');
    expect(service.remove).toHaveBeenCalledWith('user-1', 'file-1');
  });

  it('parses version numbers for internal lookups', async () => {
    await internal.getInternalFileVersion('file-1', '3');
    await internal.getInternalFile('file-1');

    expect(service.findInternalVersion).toHaveBeenCalledWith('file-1', 3);
    expect(service.findInternalFile).toHaveBeenCalledWith('file-1');
  });
});
