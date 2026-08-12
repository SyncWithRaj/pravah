import * as crypto from 'crypto';

export type HashFunction = (key: string) => number;

export function defaultHash(key: string): number {
  return crypto.createHash('md5').update(key).digest().readUInt32BE(0);
}

export interface IHashRing {
  addNode(nodeId: string): void;
  removeNode(nodeId: string): void;
  getNodes(key: string, count: number): string[];
  syncTopology(nodeIds: string[]): void;
}

export class HashRing implements IHashRing {
  private virtualNodes: number;
  private hashFn: HashFunction;

  private ring: Map<number, string> = new Map();

  private sortedKeys: number[] = [];

  private physicalNodes: Set<string> = new Set();

  constructor(virtualNodes = 100, hashFn: HashFunction = defaultHash) {
    this.virtualNodes = virtualNodes;
    this.hashFn = hashFn;
  }

  addNode(nodeId: string): void {
    if (this.physicalNodes.has(nodeId)) return;
    this.physicalNodes.add(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const vnodeKey = `${nodeId}:vnode:${i}`;
      const hash = this.hashFn(vnodeKey);
      this.ring.set(hash, nodeId);
      this.sortedKeys.push(hash);
    }

    this.sortedKeys.sort((a, b) => a - b);
  }

  removeNode(nodeId: string): void {
    if (!this.physicalNodes.has(nodeId)) return;
    this.physicalNodes.delete(nodeId);

    this.sortedKeys = this.sortedKeys.filter((hash) => {
      const node = this.ring.get(hash);
      if (node === nodeId) {
        this.ring.delete(hash);
        return false;
      }
      return true;
    });
  }

  syncTopology(nodeIds: string[]): void {
    const newSet = new Set(nodeIds);

    for (const id of this.physicalNodes) {
      if (!newSet.has(id)) {
        this.removeNode(id);
      }
    }

    for (const id of nodeIds) {
      if (!this.physicalNodes.has(id)) {
        this.addNode(id);
      }
    }
  }

  getNodes(key: string, count: number): string[] {
    if (this.physicalNodes.size === 0) return [];

    const keyHash = this.hashFn(key);

    let idx = this.binarySearch(keyHash);

    const result = new Set<string>();

    const maxNodes = Math.min(count, this.physicalNodes.size);

    while (result.size < maxNodes) {
      const hash = this.sortedKeys[idx];
      const nodeId = this.ring.get(hash);
      if (nodeId) {
        result.add(nodeId);
      }

      idx = (idx + 1) % this.sortedKeys.length;
    }

    return Array.from(result);
  }

  private binarySearch(target: number): number {
    let low = 0;
    let high = this.sortedKeys.length - 1;

    if (this.sortedKeys.length === 0) return 0;

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
