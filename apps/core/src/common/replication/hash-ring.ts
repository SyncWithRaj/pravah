import * as crypto from 'crypto';

export type HashFunction = (key: string) => number;

/**
 * Default hash function: MD5 mapping to a 32-bit unsigned integer (0 to 2^32 - 1).
 */
export function defaultHash(key: string): number {
  return crypto.createHash('md5').update(key).digest().readUInt32BE(0);
}

export interface IHashRing {
  addNode(nodeId: string): void;
  removeNode(nodeId: string): void;
  getNodes(key: string, count: number): string[];
  syncTopology(nodeIds: string[]): void;
}

/**
 * Consistent Hash Ring implementation mapping keys to a set of responsible physical nodes.
 * Features virtual nodes for even distribution and guarantees deduplicated physical node returns.
 */
export class HashRing implements IHashRing {
  private virtualNodes: number;
  private hashFn: HashFunction;

  // Maps a hash value on the ring to the physical node ID
  private ring: Map<number, string> = new Map();

  // Sorted array of hash values for O(log N) binary search
  private sortedKeys: number[] = [];

  // Set of physical nodes currently in the ring (the static topology)
  private physicalNodes: Set<string> = new Set();

  constructor(virtualNodes = 100, hashFn: HashFunction = defaultHash) {
    this.virtualNodes = virtualNodes;
    this.hashFn = hashFn;
  }

  /**
   * Adds a physical node to the ring, generating virtual nodes.
   */
  addNode(nodeId: string): void {
    if (this.physicalNodes.has(nodeId)) return;
    this.physicalNodes.add(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const vnodeKey = `${nodeId}:vnode:${i}`;
      const hash = this.hashFn(vnodeKey);
      this.ring.set(hash, nodeId);
      this.sortedKeys.push(hash);
    }

    // Sort keys to maintain the clockwise ring ordering
    this.sortedKeys.sort((a, b) => a - b);
  }

  /**
   * Removes a physical node and all its virtual nodes from the ring.
   */
  removeNode(nodeId: string): void {
    if (!this.physicalNodes.has(nodeId)) return;
    this.physicalNodes.delete(nodeId);

    // Rebuild the sorted keys array excluding this physical node
    this.sortedKeys = this.sortedKeys.filter((hash) => {
      const node = this.ring.get(hash);
      if (node === nodeId) {
        this.ring.delete(hash);
        return false;
      }
      return true;
    });
  }

  /**
   * Syncs the ring with a given list of physical node IDs, adding new ones and removing absent ones.
   */
  syncTopology(nodeIds: string[]): void {
    const newSet = new Set(nodeIds);
    // Remove nodes not in the new set
    for (const id of this.physicalNodes) {
      if (!newSet.has(id)) {
        this.removeNode(id);
      }
    }
    // Add new nodes
    for (const id of nodeIds) {
      if (!this.physicalNodes.has(id)) {
        this.addNode(id);
      }
    }
  }

  /**
   * Finds the responsible replica set (clockwise walk).
   * Guarantees returning 'count' DISTINCT physical nodes (if available).
   */
  getNodes(key: string, count: number): string[] {
    if (this.physicalNodes.size === 0) return [];

    const keyHash = this.hashFn(key);

    // 1. Find the starting position on the ring via binary search
    let idx = this.binarySearch(keyHash);

    const result = new Set<string>();
    // Graceful degradation: you can't get 3 owners if only 2 physical nodes exist
    const maxNodes = Math.min(count, this.physicalNodes.size);

    // 2. Walk clockwise until we have N distinct physical nodes
    while (result.size < maxNodes) {
      const hash = this.sortedKeys[idx];
      const nodeId = this.ring.get(hash);
      if (nodeId) {
        result.add(nodeId);
      }
      // Wrap around the circle if we reach the end
      idx = (idx + 1) % this.sortedKeys.length;
    }

    return Array.from(result);
  }

  /**
   * Binary search to find the first hash on the ring >= the target hash.
   */
  private binarySearch(target: number): number {
    let low = 0;
    let high = this.sortedKeys.length - 1;

    if (this.sortedKeys.length === 0) return 0;

    // If target is larger than all elements, wrap around to the first node
    if (target > this.sortedKeys[high]) {
      return 0;
    }

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sortedKeys[mid] >= target) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return low;
  }
}
