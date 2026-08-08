import { Injectable, Logger } from '@nestjs/common';
import {
  HealthCheckService,
  EdgeNodeRecord,
} from '../health-check/health-check.service';
import { REGION_COORDINATES } from './region-coordinates';
import { haversineDistance } from './haversine.util';

export interface RoutingDecision {
  edge: EdgeNodeRecord;
  distanceKm: number | null; // null when exact-region (distance not calculated)
  strategy: 'exact-region' | 'nearest-geo'; // Matched on region string or Haversine fallback
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(private readonly healthCheckService: HealthCheckService) {}

  /**
   * Determines the best edge node for a given client region.
   * Uses exact region match if available, otherwise falls back to Haversine nearest geo.
   * Returns null if no routing decision can be made (origin fallback).
   */
  selectBestEdge(clientRegion: string | undefined): RoutingDecision | null {
    // 0. No region provided — we have no geo info, cannot make a meaningful decision
    if (!clientRegion) return null;

    // 1. Get all healthy nodes from HealthCheckService (O(N) in-memory lookup)
    const healthyNodes = this.healthCheckService.getHealthyNodes();
    if (healthyNodes.length === 0) return null;

    // 2. Try EXACT region match first (skip Haversine entirely)
    const regionMatches = healthyNodes.filter((n) => n.region === clientRegion);
    if (regionMatches.length > 0) {
      // Multiple nodes in same region → random selection (basic load distribution)
      const selected =
        regionMatches[Math.floor(Math.random() * regionMatches.length)];
      return { edge: selected, distanceKm: null, strategy: 'exact-region' };
    }

    // 3. No exact match — look up the region's coordinates
    const clientCoords = REGION_COORDINATES[clientRegion];
    if (!clientCoords) {
      // Unknown region string — no reliable geo decision possible
      this.logger.warn(`Unknown region string: ${clientRegion}`);
      return null;
    }

    // 4. Haversine: calculate distance to every healthy node, pick closest
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

    return {
      edge: closest,
      distanceKm: Math.round(minDistance),
      strategy: 'nearest-geo',
    };
  }
}
