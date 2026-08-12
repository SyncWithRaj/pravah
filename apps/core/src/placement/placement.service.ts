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

  async getPlacement(
    fileId: string,
    versionNumber: number,
    requestingEdgeId: string,
  ) {
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

    const allNodes = this.healthCheck.getAllNodes();
    const hashRing = new HashRing();
    hashRing.syncTopology(allNodes.map((n) => n.id));

    const REPLICATION_FACTOR = 3;
    const responsibleNodeIds = hashRing.getNodes(fileId, REPLICATION_FACTOR);

    const healthyResponsibleNodes = allNodes.filter(
      (node) =>
        responsibleNodeIds.includes(node.id) &&
        node.status === EdgeNodeStatus.HEALTHY &&
        node.id !== requestingEdgeId,
    );

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
