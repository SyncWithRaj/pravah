import { Controller, Get, Param, Headers, ParseIntPipe } from '@nestjs/common';
import { PlacementService } from './placement.service';

@Controller('internal/placement')
export class PlacementController {
  constructor(private readonly placementService: PlacementService) {}

  @Get(':fileId/v/:version')
  async getPlacement(
    @Param('fileId') fileId: string,
    @Param('version', ParseIntPipe) version: number,
    @Headers('x-edge-node-id') edgeNodeId: string,
  ) {
    return this.placementService.getPlacement(fileId, version, edgeNodeId);
  }
}
