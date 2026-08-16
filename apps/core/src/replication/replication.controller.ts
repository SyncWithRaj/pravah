import { Controller, Post, Get, Body, Logger, Param } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ReplicationService } from './replication.service';

@Controller('admin/replication')
export class ReplicationController {
  private readonly logger = new Logger(ReplicationController.name);

  constructor(private readonly replicationService: ReplicationService) {}

  @MessagePattern('file.uploaded')
  async handleFileUploaded(@Payload() message: unknown) {
    return this.processFileEvent(message);
  }

  @MessagePattern('file.version_created')
  async handleFileVersionCreated(@Payload() message: unknown) {
    return this.processFileEvent(message);
  }

  @MessagePattern('edge.health_changed')
  async handleEdgeHealthChanged(@Payload() message: unknown) {
    let edgeId: string | undefined;
    let newStatus: string | undefined;

    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>;
      if (typeof msg.edgeId === 'string') {
        edgeId = msg.edgeId;
        newStatus =
          typeof msg.newStatus === 'string' ? msg.newStatus : undefined;
      } else if (typeof msg.value === 'object' && msg.value !== null) {
        const val = msg.value as Record<string, unknown>;
        if (typeof val.edgeId === 'string') {
          edgeId = val.edgeId;
          newStatus =
            typeof val.newStatus === 'string' ? val.newStatus : undefined;
        }
      }
    }

    if (edgeId && newStatus === 'DOWN') {
      this.logger.warn(
        `[Failover] Edge node ${edgeId} reported DOWN. Triggering dynamic replication repair...`,
      );
      return this.replicationService.handleEdgeCrashFailover(edgeId);
    }
  }

  private async processFileEvent(message: unknown) {
    let fileId: string | undefined;
    let versionId: string | undefined;
    let storagePath: string | undefined;

    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>;
      if (typeof msg.fileId === 'string') {
        fileId = msg.fileId;
        versionId =
          typeof msg.versionId === 'string' ? msg.versionId : undefined;
        storagePath =
          typeof msg.objectKey === 'string' ? msg.objectKey : undefined;
      } else if (typeof msg.value === 'object' && msg.value !== null) {
        const val = msg.value as Record<string, unknown>;
        if (typeof val.fileId === 'string') {
          fileId = val.fileId;
          versionId =
            typeof val.versionId === 'string' ? val.versionId : undefined;
          storagePath =
            typeof val.objectKey === 'string' ? val.objectKey : undefined;
        }
      }
    }

    if (fileId && versionId && storagePath) {
      this.logger.log(
        `Received file.uploaded event for file: ${fileId}. Dispatching replication jobs...`,
      );
      await this.replicationService.dispatchReplication(
        fileId,
        versionId,
        storagePath,
      );
    } else {
      this.logger.error(
        `Received file.uploaded event but missing required fields. Message: ${JSON.stringify(
          message,
        )}`,
      );
    }
  }

  @Get('status/:fileId')
  async getStatus(@Param('fileId') fileId: string) {
    const status = await this.replicationService.getReplicationStatus(fileId);
    return {
      fileId,
      totalJobs: status.length,
      completed: status.filter((s) => s.status === 'COMPLETE').length,
      failed: status.filter((s) => s.status === 'FAILED').length,
      pending: status.filter((s) => s.status === 'PENDING').length,
      inProgress: status.filter((s) => s.status === 'IN_PROGRESS').length,
      jobs: status,
    };
  }

  @Get('failed')
  async getFailedJobs() {
    const failedJobs = await this.replicationService.getFailedJobs();
    return {
      total: failedJobs.length,
      jobs: failedJobs,
    };
  }

  @Post('retry')
  async retryJob(@Body('replicationId') replicationId: string) {
    if (!replicationId) {
      return { success: false, message: 'replicationId is required' };
    }
    try {
      await this.replicationService.retryFailedJob(replicationId);
      return { success: true, message: 'Job re-queued successfully' };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      return { success: false, message: errorMessage };
    }
  }

  @Post('failover/:edgeId')
  async triggerFailover(@Param('edgeId') edgeId: string) {
    return this.replicationService.handleEdgeCrashFailover(edgeId);
  }
}
