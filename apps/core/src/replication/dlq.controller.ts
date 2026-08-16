import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ReplicationService } from './replication.service';

@Controller('admin/dlq')
export class DlqController {
  private readonly logger = new Logger(DlqController.name);

  constructor(private readonly replicationService: ReplicationService) {}

  @Get()
  async getAllDLQEvents() {
    const events = await this.replicationService.getDLQEvents();
    return {
      total: events.length,
      topic: 'file.uploaded.dlq',
      events: events.map((e) => ({
        id: e.id,
        fileId: e.fileId,
        fileName: e.file?.name,
        edgeNodeId: e.edgeNodeId,
        edgeNodeName: e.edgeNode?.name,
        edgeRegion: e.edgeNode?.region,
        attempts: e.attempts,
        lastError: e.lastError,
        isDeadLetter: e.isDeadLetter,
        deadLetterAt: e.deadLetterAt,
        deadLetterReason: e.deadLetterReason,
        replayedAt: e.replayedAt,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  }

  @Get(':id')
  async getDLQEventById(@Param('id') id: string) {
    const event = await this.replicationService.getDLQEventById(id);
    if (!event) {
      throw new NotFoundException(`DLQ event with ID ${id} not found`);
    }
    return {
      ...event,
      file: event.file
        ? {
            ...event.file,
            totalSize: Number(event.file.totalSize),
          }
        : null,
    };
  }

  @Post('replay')
  async replayDLQEvent(
    @Body()
    body: {
      replicationId?: string;
      fileId?: string;
      event_id?: string;
    },
  ) {
    const targetId = body.replicationId || body.event_id;

    if (targetId) {
      try {
        const result = await this.replicationService.replayDLQEvent(targetId);
        return result;
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        throw new BadRequestException(errorMsg);
      }
    }

    if (body.fileId) {
      const records = await this.replicationService.getDLQEvents();
      const matching = records.filter((r) => r.fileId === body.fileId);

      if (matching.length === 0) {
        throw new NotFoundException(
          `No DLQ records found for fileId ${body.fileId}`,
        );
      }

      const results = [];
      for (const record of matching) {
        const res = await this.replicationService.replayDLQEvent(record.id);
        results.push(res);
      }

      return {
        success: true,
        message: `Replayed ${results.length} jobs for file ${body.fileId}`,
        replays: results,
      };
    }

    throw new BadRequestException(
      'Either replicationId, event_id, or fileId is required for replay',
    );
  }

  @Post('replay-all')
  async replayAll() {
    return this.replicationService.replayAllDLQEvents();
  }

  @Delete(':id')
  async purgeDLQEvent(@Param('id') id: string) {
    return this.replicationService.purgeDLQEvent(id);
  }
}
