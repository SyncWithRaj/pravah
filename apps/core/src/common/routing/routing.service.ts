import { Injectable, Logger } from '@nestjs/common';
import {
  HealthCheckService,
  EdgeNodeRecord,
} from '../health-check/health-check.service';
import { REGION_COORDINATES } from './region-coordinates';
import { haversineDistance } from './haversine.util';

import { MetricsService } from '../../metrics/metrics.service';

export interface RoutingDecision {
  edge: EdgeNodeRecord;
  distanceKm: number | null;
  strategy: 'exact-region' | 'nearest-geo';
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly metricsService: MetricsService,
  ) {}

  selectBestEdge(clientRegion: string | undefined): RoutingDecision | null {
    if (!clientRegion) return null;

    const healthyNodes = this.healthCheckService.getHealthyNodes();
    if (healthyNodes.length === 0) return null;

    const regionMatches = healthyNodes.filter((n) => n.region === clientRegion);
    if (regionMatches.length > 0) {
      const selected =
        regionMatches[Math.floor(Math.random() * regionMatches.length)];
      this.metricsService.geoRoutingTotal.inc({
        edge_name: selected.name,
        edge_region: selected.region,
        strategy: 'exact-region',
      });
      return { edge: selected, distanceKm: null, strategy: 'exact-region' };
    }

    const clientCoords = REGION_COORDINATES[clientRegion];
    if (!clientCoords) {
      this.logger.warn(`Unknown region string: ${clientRegion}`);
      return null;
    }

    let closest: EdgeNodeRecord = healthyNodes[0];
    let minDistance = Infinity;

    for (const node of healthyNodes) {
      const dist = haversineDistance(
        clientCoords.lat,
        clientCoords.lon,
        node.latitude,
        node.longitude,
      );
      if (dist < minDistance) {
        minDistance = dist;
        closest = node;
      }
    }

    this.metricsService.geoRoutingTotal.inc({
      edge_name: closest.name,
      edge_region: closest.region,
      strategy: 'nearest-geo',
    });

    return {
      edge: closest,
      distanceKm: Math.round(minDistance),
      strategy: 'nearest-geo',
    };
  }
}
