import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryGateway } from './telemetry.gateway';

type JwtPayload = { sub: string; email?: string; role?: Role };
type UserRecord = { id: string; role: Role };
type FileOwnerRecord = { ownerId: string };

type ConfigGet = jest.Mock<string | undefined, [string]>;
type VerifyAsync = jest.Mock<
  Promise<JwtPayload>,
  [string, { secret?: string }]
>;
type UserFindUnique = jest.Mock<Promise<UserRecord | null>, [unknown]>;
type FileFindUnique = jest.Mock<Promise<FileOwnerRecord | null>, [unknown]>;

interface SocketHarness {
  socket: Socket;
  emit: jest.Mock<void, [string, unknown]>;
  join: jest.Mock<Promise<void>, [string]>;
  disconnect: jest.Mock<void, [boolean]>;
}

interface SocketOptions {
  auth?: Record<string, unknown>;
  authorization?: string;
  queryToken?: string;
}

function createSocket(
  data: Record<string, unknown> = {},
  options: SocketOptions = {},
): SocketHarness {
  const emit = jest.fn<void, [string, unknown]>();
  const join = jest.fn<Promise<void>, [string]>();
  join.mockResolvedValue(undefined);
  const disconnect = jest.fn<void, [boolean]>();
  const headers: Record<string, string | undefined> = {};
  if (options.authorization) {
    headers.authorization = options.authorization;
  }

  const socket = {
    id: `socket-${Math.random()}`,
    data,
    handshake: {
      auth: options.auth,
      headers,
      query: options.queryToken ? { token: options.queryToken } : undefined,
    },
    emit,
    join,
    disconnect,
  } as unknown as Socket;

  return { socket, emit, join, disconnect };
}

function setServer(
  gateway: TelemetryGateway,
  harnesses: SocketHarness[],
): void {
  const sockets = new Map<string, Socket>();
  for (const harness of harnesses) {
    sockets.set(harness.socket.id, harness.socket);
  }
  gateway.server = { sockets: { sockets } } as unknown as Server;
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('TelemetryGateway', () => {
  let gateway: TelemetryGateway;
  let configGet: ConfigGet;
  let verifyAsync: VerifyAsync;
  let userFindUnique: UserFindUnique;
  let fileFindUnique: FileFindUnique;

  beforeEach(() => {
    configGet = jest.fn<string | undefined, [string]>();
    configGet.mockReturnValue('jwt-secret');
    verifyAsync = jest.fn<Promise<JwtPayload>, [string, { secret?: string }]>();
    userFindUnique = jest.fn<Promise<UserRecord | null>, [unknown]>();
    fileFindUnique = jest.fn<Promise<FileOwnerRecord | null>, [unknown]>();

    const config = { get: configGet };
    const jwt = { verifyAsync };
    const prisma = {
      user: { findUnique: userFindUnique },
      file: { findUnique: fileFindUnique },
    };

    gateway = new TelemetryGateway(
      config as unknown as ConfigService,
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
    );
  });

  describe('handleConnection', () => {
    it('rejects connections without any token', async () => {
      const { socket, disconnect, join, emit } = createSocket();

      await gateway.handleConnection(socket);

      expect(disconnect).toHaveBeenCalledWith(true);
      expect(join).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('rejects invalid JWTs', async () => {
      verifyAsync.mockRejectedValue(new Error('invalid token'));
      const { socket, disconnect } = createSocket(
        {},
        { authorization: 'Bearer bad-token' },
      );

      await gateway.handleConnection(socket);

      expect(verifyAsync).toHaveBeenCalledWith('bad-token', {
        secret: 'jwt-secret',
      });
      expect(disconnect).toHaveBeenCalledWith(true);
    });

    it('rejects valid JWTs when the user no longer exists', async () => {
      verifyAsync.mockResolvedValue({ sub: 'deleted-user' });
      userFindUnique.mockResolvedValue(null);
      const { socket, disconnect, join } = createSocket(
        {},
        { authorization: 'Bearer valid-token' },
      );

      await gateway.handleConnection(socket);

      expect(userFindUnique).toHaveBeenCalledWith({
        where: { id: 'deleted-user' },
        select: { id: true, role: true },
      });
      expect(disconnect).toHaveBeenCalledWith(true);
      expect(join).not.toHaveBeenCalled();
    });

    it('authenticates a bearer token and joins user and role rooms', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-1' });
      userFindUnique.mockResolvedValue({ id: 'user-1', role: Role.ADMIN });
      const { socket, disconnect, join, emit } = createSocket(
        {},
        { authorization: 'Bearer valid-token' },
      );

      await gateway.handleConnection(socket);

      expect(join).toHaveBeenNthCalledWith(1, 'user:user-1');
      expect(join).toHaveBeenNthCalledWith(2, 'role:ADMIN');
      expect(emit).toHaveBeenCalledWith('connection_ack', {
        status: 'connected',
        timestamp: expect.any(String) as string,
      });
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('accepts tokens from the socket handshake auth payload', async () => {
      verifyAsync.mockResolvedValue({ sub: 'user-2' });
      userFindUnique.mockResolvedValue({ id: 'user-2', role: Role.STREAMER });
      const { socket, join } = createSocket(
        {},
        { auth: { token: 'auth-payload-token' } },
      );

      await gateway.handleConnection(socket);

      expect(verifyAsync).toHaveBeenCalledWith('auth-payload-token', {
        secret: 'jwt-secret',
      });
      expect(join).toHaveBeenCalledWith('role:STREAMER');
    });
  });

  it('answers ping with pong', () => {
    const { socket } = createSocket();

    expect(gateway.handlePing(socket)).toBe('pong');
  });

  describe('getFileOwner', () => {
    it('caches resolved owners', async () => {
      fileFindUnique.mockResolvedValue({ ownerId: 'owner-1' });

      await expect(gateway.getFileOwner('file-1')).resolves.toBe('owner-1');
      await expect(gateway.getFileOwner('file-1')).resolves.toBe('owner-1');

      expect(fileFindUnique).toHaveBeenCalledTimes(1);
    });

    it('returns null for missing files without caching', async () => {
      fileFindUnique.mockResolvedValue(null);

      await expect(gateway.getFileOwner('missing')).resolves.toBeNull();
      await expect(gateway.getFileOwner('missing')).resolves.toBeNull();

      expect(fileFindUnique).toHaveBeenCalledTimes(2);
    });

    it('returns null when the database lookup fails', async () => {
      fileFindUnique.mockRejectedValue(new Error('database unavailable'));

      await expect(gateway.getFileOwner('file-1')).resolves.toBeNull();
    });
  });

  describe('emitToUsers', () => {
    it('is a no-op before the server is initialized', () => {
      gateway.server = undefined as unknown as Server;

      expect(() =>
        gateway.emitToUsers('test.event', () => true, { value: 1 }),
      ).not.toThrow();
    });

    it('emits only to sockets matching the predicate', () => {
      const owner = createSocket({ userId: 'owner-1', role: Role.USER });
      const admin = createSocket({ userId: 'admin-1', role: Role.ADMIN });
      const anonymous = createSocket();
      setServer(gateway, [owner, admin, anonymous]);

      gateway.emitToUsers('test.event', (user) => user.userId === 'owner-1', {
        value: 1,
      });

      expect(owner.emit).toHaveBeenCalledWith('test.event', { value: 1 });
      expect(admin.emit).not.toHaveBeenCalled();
      expect(anonymous.emit).not.toHaveBeenCalled();
    });
  });

  describe('broadcasts', () => {
    it('sends upload progress to the file owner and admins only', async () => {
      fileFindUnique.mockResolvedValue({ ownerId: 'owner-1' });
      const owner = createSocket({ userId: 'owner-1', role: Role.USER });
      const admin = createSocket({ userId: 'admin-1', role: Role.ADMIN });
      const outsider = createSocket({
        userId: 'outsider-1',
        role: Role.USER,
      });
      setServer(gateway, [owner, admin, outsider]);
      const data = {
        fileId: 'file-1',
        fileName: 'video.mp4',
        chunkIndex: 1,
        totalChunks: 4,
        percentage: 25,
      };

      gateway.broadcastUploadProgress(data);
      await flushAsync();

      expect(owner.emit).toHaveBeenCalledWith('upload.progress', data);
      expect(admin.emit).toHaveBeenCalledWith('upload.progress', data);
      expect(outsider.emit).not.toHaveBeenCalled();
    });

    it('sends throughput to admins and streamers only', () => {
      const admin = createSocket({ userId: 'admin-1', role: Role.ADMIN });
      const streamer = createSocket({
        userId: 'streamer-1',
        role: Role.STREAMER,
      });
      const viewer = createSocket({ userId: 'viewer-1', role: Role.VIEWER });
      setServer(gateway, [admin, streamer, viewer]);
      const data = {
        bandwidthBps: 1024,
        totalBytesDelivered: 4096,
        requestsPerSecond: 2,
        totalHits: 10,
        totalMisses: 2,
        hitRatio: 0.83,
      };

      gateway.broadcastThroughput(data);

      expect(admin.emit).toHaveBeenCalledWith('telemetry.throughput', data);
      expect(streamer.emit).toHaveBeenCalledWith('telemetry.throughput', data);
      expect(viewer.emit).not.toHaveBeenCalled();
    });

    it('sanitizes stack traces in DLQ alerts', async () => {
      fileFindUnique.mockResolvedValue({ ownerId: 'owner-1' });
      const owner = createSocket({ userId: 'owner-1', role: Role.USER });
      const admin = createSocket({ userId: 'admin-1', role: Role.ADMIN });
      setServer(gateway, [owner, admin]);
      const data = {
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        attempts: 3,
        error: 'Error: replication failed\n    at ReplicationService.run',
        timestamp: '2026-01-01T00:00:00.000Z',
      };

      gateway.broadcastDLQAlert(data);
      await flushAsync();

      expect(owner.emit).toHaveBeenCalledWith('dlq.alert', {
        ...data,
        error: 'Error: replication failed',
      });
      expect(admin.emit).toHaveBeenCalledWith('dlq.alert', {
        ...data,
        error: 'Error: replication failed',
      });
    });

    it('uses a fallback message for empty DLQ errors', async () => {
      fileFindUnique.mockResolvedValue({ ownerId: 'owner-1' });
      const owner = createSocket({ userId: 'owner-1', role: Role.USER });
      setServer(gateway, [owner]);
      const data = {
        fileId: 'file-1',
        edgeNodeId: 'edge-node-01',
        attempts: 1,
        error: '',
        timestamp: '2026-01-01T00:00:00.000Z',
      };

      gateway.broadcastDLQAlert(data);
      await flushAsync();

      expect(owner.emit).toHaveBeenCalledWith('dlq.alert', {
        ...data,
        error: 'Replication job failed',
      });
    });
  });
});
