import { Controller, Get, Param, Headers, ParseIntPipe } from '@nestjs/common';
import { PlacementService } from './placement.service';

@Controller('internal/placement')
export class PlacementController {
  constructor(private readonly placementService: PlacementService) {}

  /**
   * GET /api/v1/internal/placement/:fileId/v/:version
   *
   * Called by Edge nodes on cache miss to determine:
   *   1. File metadata (storagePath, mimeType, checksum, etc.)
   *   2. Responsible replicas ranked by distance from requesting edge
   *
   * The requesting edge identifies itself via the X-Edge-Node-Id header.
   */
  @Get(':fileId/v/:version')
  async getPlacement(
    @Param('fileId') fileId: string,
    @Param('version', ParseIntPipe) version: number,
    @Headers('x-edge-node-id') edgeNodeId: string,
  ) {
    return this.placementService.getPlacement(fileId, version, edgeNodeId);
  }
}
