import { BadRequestException } from '@nestjs/common';
import { User } from '@prisma/client';
import { InitUploadDto } from './dto/init-upload.dto';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { TelemetryGateway } from '../telemetry/telemetry.gateway';

type UploadMock = {
  initUpload: jest.Mock;
  initVersionUpload: jest.Mock;
  uploadChunk: jest.Mock;
  getUploadStatus: jest.Mock;
  completeUpload: jest.Mock;
};

type TelemetryMock = { broadcastUploadProgress: jest.Mock };

const user = { id: 'user-1', email: 'streamer@example.com' } as User;
const dto: InitUploadDto = {
  name: 'notes.txt',
  mimeType: 'text/plain',
  totalSize: 11,
  totalChunks: 1,
};

describe('UploadController', () => {
  let controller: UploadController;
  let upload: UploadMock;
  let telemetry: TelemetryMock;

  beforeEach(() => {
    upload = {
      initUpload: jest.fn().mockResolvedValue({ fileId: 'file-1' }),
      initVersionUpload: jest.fn().mockResolvedValue({ fileId: 'file-1' }),
      uploadChunk: jest.fn().mockResolvedValue({
        success: true,
        fileId: 'file-1',
        chunkIndex: 0,
        uploadedChunks: 1,
        totalChunks: 2,
      }),
      getUploadStatus: jest.fn().mockResolvedValue({ status: 'UPLOADING' }),
      completeUpload: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
    };
    telemetry = { broadcastUploadProgress: jest.fn() };
    controller = new UploadController(
      upload as unknown as UploadService,
      telemetry as unknown as TelemetryGateway,
    );
  });

  it('starts an upload for the authenticated user', async () => {
    await expect(controller.initUpload(user, dto)).resolves.toEqual({
      fileId: 'file-1',
    });
    expect(upload.initUpload).toHaveBeenCalledWith('user-1', dto);
  });

  it('starts a new version for an existing file', async () => {
    await controller.initVersionUpload(user, 'file-1', dto);

    expect(upload.initVersionUpload).toHaveBeenCalledWith(
      'user-1',
      'file-1',
      dto,
    );
  });

  it('rejects a chunk upload without a file', async () => {
    await expect(
      controller.uploadChunk(
        user,
        'file-1',
        0,
        { checksum: 'checksum-1' },
        undefined as unknown as Express.Multer.File,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload.uploadChunk).not.toHaveBeenCalled();
  });

  it('uploads a chunk and broadcasts progress', async () => {
    const file = {
      buffer: Buffer.from('hello'),
      originalname: 'notes.txt',
    } as Express.Multer.File;

    const result = await controller.uploadChunk(
      user,
      'file-1',
      0,
      { checksum: 'checksum-1' },
      file,
    );

    expect(upload.uploadChunk).toHaveBeenCalledWith(
      'user-1',
      'file-1',
      0,
      'checksum-1',
      file.buffer,
    );
    expect(telemetry.broadcastUploadProgress).toHaveBeenCalledWith({
      fileId: 'file-1',
      fileName: 'notes.txt',
      chunkIndex: 0,
      totalChunks: 2,
      percentage: 50,
    });
    expect(result.success).toBe(true);
  });

  it('falls back to safe defaults when progress totals are missing', async () => {
    upload.uploadChunk.mockResolvedValue({
      success: true,
      fileId: 'file-1',
      chunkIndex: 0,
      uploadedChunks: 1,
      totalChunks: 0,
    });
    const file = {
      buffer: Buffer.from('x'),
      originalname: '',
    } as Express.Multer.File;

    await controller.uploadChunk(user, 'file-1', 0, { checksum: 'c' }, file);

    expect(telemetry.broadcastUploadProgress).toHaveBeenCalledWith({
      fileId: 'file-1',
      fileName: 'file',
      chunkIndex: 0,
      totalChunks: 1,
      percentage: 100,
    });
  });

  it('returns upload status and completes the upload', async () => {
    await controller.getUploadStatus(user, 'file-1');
    await controller.completeUpload(user, { fileId: 'file-1' });

    expect(upload.getUploadStatus).toHaveBeenCalledWith('user-1', 'file-1');
    expect(upload.completeUpload).toHaveBeenCalledWith('user-1', {
      fileId: 'file-1',
    });
  });
});
