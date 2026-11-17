import { Role } from '@prisma/client';
import { TranscodingController } from './transcoding.controller';
import { TranscodingService } from './transcoding.service';

type TranscodingMock = {
  getTranscodeStatus: jest.Mock;
  getTranscodeByFileAndVersion: jest.Mock;
};

describe('TranscodingController', () => {
  let controller: TranscodingController;
  let service: TranscodingMock;

  beforeEach(() => {
    service = {
      getTranscodeStatus: jest.fn().mockResolvedValue([]),
      getTranscodeByFileAndVersion: jest.fn().mockResolvedValue([]),
    };
    controller = new TranscodingController(
      service as unknown as TranscodingService,
    );
  });

  it('returns all transcode records for a file', async () => {
    service.getTranscodeStatus.mockResolvedValue([
      { id: 'transcode-1', status: 'COMPLETED' },
    ]);

    const result = await controller.getTranscodeStatus(
      { id: 'user-1', role: Role.STREAMER },
      'file-1',
    );

    expect(service.getTranscodeStatus).toHaveBeenCalledWith(
      'user-1',
      Role.STREAMER,
      'file-1',
    );
    expect(result).toEqual({
      fileId: 'file-1',
      totalRecords: 1,
      transcodes: [{ id: 'transcode-1', status: 'COMPLETED' }],
    });
  });

  it('returns transcode records for a specific version', async () => {
    service.getTranscodeByFileAndVersion.mockResolvedValue([]);

    const result = await controller.getTranscodeByVersion(
      { id: 'admin-1', role: Role.ADMIN },
      'file-1',
      'version-1',
    );

    expect(service.getTranscodeByFileAndVersion).toHaveBeenCalledWith(
      'admin-1',
      Role.ADMIN,
      'file-1',
      'version-1',
    );
    expect(result).toEqual({
      fileId: 'file-1',
      versionId: 'version-1',
      totalRecords: 0,
      transcodes: [],
    });
  });
});
