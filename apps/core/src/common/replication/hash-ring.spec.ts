import { HashRing, defaultHash } from './hash-ring';

describe('HashRing', () => {
  it('returns no nodes when the ring is empty', () => {
    const ring = new HashRing();

    expect(ring.getNodes('file-1', 3)).toEqual([]);
  });

  it('returns distinct physical nodes for a key', () => {
    const ring = new HashRing(16);
    ring.syncTopology(['edge-a', 'edge-b', 'edge-c']);

    const nodes = ring.getNodes('file-1', 2);

    expect(nodes).toHaveLength(2);
    expect(new Set(nodes).size).toBe(2);
    for (const node of nodes) {
      expect(['edge-a', 'edge-b', 'edge-c']).toContain(node);
    }
  });

  it('returns every node when the requested count exceeds the topology', () => {
    const ring = new HashRing(16);
    ring.syncTopology(['edge-a', 'edge-b', 'edge-c']);

    expect(ring.getNodes('file-1', 10).sort()).toEqual([
      'edge-a',
      'edge-b',
      'edge-c',
    ]);
  });

  it('is deterministic for the same topology and key', () => {
    const first = new HashRing(32);
    const second = new HashRing(32);
    first.syncTopology(['edge-a', 'edge-b', 'edge-c']);
    second.syncTopology(['edge-a', 'edge-b', 'edge-c']);

    expect(first.getNodes('file-42', 3)).toEqual(second.getNodes('file-42', 3));
  });

  it('does not add the same physical node twice', () => {
    const ring = new HashRing(8);
    ring.addNode('edge-a');
    ring.addNode('edge-a');

    expect(ring.getNodes('file-1', 10)).toEqual(['edge-a']);
  });

  it('removes nodes from the ring', () => {
    const ring = new HashRing(8);
    ring.syncTopology(['edge-a', 'edge-b']);
    ring.removeNode('edge-a');

    expect(ring.getNodes('file-1', 10)).toEqual(['edge-b']);
  });

  it('syncs topology by adding new nodes and removing stale nodes', () => {
    const ring = new HashRing(8);
    ring.syncTopology(['edge-a', 'edge-b']);
    ring.syncTopology(['edge-b', 'edge-c']);

    expect(ring.getNodes('file-1', 10).sort()).toEqual(['edge-b', 'edge-c']);
  });

  it('wraps around to the start of the ring', () => {
    const ring = new HashRing(1, (key: string) => {
      if (key === 'edge-a:vnode:0') return 10;
      if (key === 'edge-b:vnode:0') return 20;
      return 30;
    });
    ring.syncTopology(['edge-a', 'edge-b']);

    expect(ring.getNodes('file-after-last-vnode', 2)).toEqual([
      'edge-a',
      'edge-b',
    ]);
  });

  it('produces a deterministic unsigned 32-bit hash', () => {
    const hash = defaultHash('pravah');

    expect(Number.isInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(defaultHash('pravah')).toBe(hash);
  });
});
