import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HealthCheckService } from '../common/health-check/health-check.service';
import { HashRing } from '../common/replication/hash-ring';
import { haversineDistance } from '../common/routing/haversine.util';
import { EdgeNodeStatus } from '@prisma/client';

@Injectable()
export class PlacementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly healthCheck: HealthCheckService,
  ) {}

  /**
   * Returns file metadata + responsible replicas ranked by distance
   * from the requesting edge node.
   *
   * Flow:
   *   1. Fetch file + version metadata from Prisma
   *   2. Sync HashRing with ALL nodes (topology must be stable regardless of health)
   *   3. Get responsible replica set from HashRing
   *   4. Filter out unhealthy nodes and the requesting edge
   *   5. Rank by Haversine distance from requesting edge
   *   6. Return combined placement response
   */
  async getPlacement(
    fileId: string,
    versionNumber: number,
    requestingEdgeId: string,
  ) {
    // 1. Fetch file metadata
    const file = await this.prisma.file.findUnique({
      where: { id: fileId },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    const fileVersion = await this.prisma.fileVersion.findFirst({
      where: { fileId, versionNumber },
    });

    if (!fileVersion) {
      throw new NotFoundException('Version not found');
    }

    // 2. Sync HashRing with ALL known nodes (not just healthy ones)
    //    The HashRing determines permanent placement regardless of health state.
    const allNodes = this.healthCheck.getAllNodes();
    const hashRing = new HashRing();
    hashRing.syncTopology(allNodes.map((n) => n.id));

    // 3. Get responsible replicas (REPLICATION_FACTOR = 3)
    const REPLICATION_FACTOR = 3;
    const responsibleNodeIds = hashRing.getNodes(fileId, REPLICATION_FACTOR);

    // 4. Filter: keep only HEALTHY responsible replicas, exclude requesting edge
    const healthyResponsibleNodes = allNodes.filter(
      (node) =>
        responsibleNodeIds.includes(node.id) &&
        node.status === EdgeNodeStatus.HEALTHY &&
        node.id !== requestingEdgeId,
    );

    // 5. Calculate Haversine distance from requesting edge to each candidate
    const requestingEdge = allNodes.find((n) => n.id === requestingEdgeId);

    const responsibleReplicas = healthyResponsibleNodes
      .map((node) => {
        let distanceKm = 0;
        if (requestingEdge) {
          distanceKm = Math.round(
            haversineDistance(
              requestingEdge.latitude,
              requestingEdge.longitude,
              node.latitude,
              node.longitude,
            ),
          );
        }
        return {
          edgeId: node.id,
          endpoint: node.endpointUrl,
          region: node.region,
          distanceKm,
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);

    // 6. Return combined placement response
    return {
      fileId: file.id,
      version: fileVersion.versionNumber,
      storagePath: fileVersion.storagePath,
      mimeType: file.mimeType,
      size: fileVersion.size.toString(),
      ownerId: file.ownerId,
      checksum: fileVersion.checksum,
      responsibleReplicas,
    };
  }
}
