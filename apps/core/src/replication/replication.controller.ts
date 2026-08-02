import { Controller, Post, Get, Body, Logger, Param } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ReplicationService } from './replication.service';

@Controller('admin/replication')
export class ReplicationController {
  private readonly logger = new Logger(ReplicationController.name);

  constructor(private readonly replicationService: ReplicationService) {}

  /**
   * Kafka consumer for file upload events.
   * This is where the replication process is kicked off.
   */
  @MessagePattern('file.uploaded')
  async handleFileUploaded(@Payload() message: unknown) {
    let fileId: string | undefined;
    let versionId: string | undefined;
    let storagePath: string | undefined;

    // Handle both plain objects and KafkaMessage payloads
    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>;
      if (typeof msg.fileId === 'string') {
        fileId = msg.fileId;
        versionId =
          typeof msg.versionId === 'string' ? msg.versionId : undefined;
        storagePath =
          typeof msg.storagePath === 'string' ? msg.storagePath : undefined;
      } else if (typeof msg.value === 'object' && msg.value !== null) {
        const val = msg.value as Record<string, unknown>;
        if (typeof val.fileId === 'string') {
          fileId = val.fileId;
          versionId =
            typeof val.versionId === 'string' ? val.versionId : undefined;
          storagePath =
            typeof val.storagePath === 'string' ? val.storagePath : undefined;
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

  /**
   * GET /admin/replication/status/:fileId
   * Returns the replication status for a specific file.
   */
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

  /**
   * GET /admin/replication/failed
   * Returns all failed replication jobs (DLQ inspection).
   */
  @Get('failed')
  async getFailedJobs() {
    const failedJobs = await this.replicationService.getFailedJobs();
    return {
      total: failedJobs.length,
      jobs: failedJobs,
    };
  }

  /**
   * POST /admin/replication/retry
   * Retries a specific failed replication job.
   */
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
}
