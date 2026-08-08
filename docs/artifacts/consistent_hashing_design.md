# Consistent Hashing & Replica Placement (Phase 5B)

## 1. Architectural Objectives
- **Deterministic Placement:** Replace `Math.random()` replica assignment with predictable, hash-based placement.
- **Minimized Rebalancing:** Ensure that adding or removing an edge node only redistributes a fraction of the keyspace, rather than invalidating the entire cluster mapping.
- **Separation of Concerns:** Isolate the hash ring logic from infrastructure concerns (Prisma, Redis, HTTP).

## 2. Proactive vs. Opportunistic Caching
This phase explicitly distinguishes between two types of file caching:

| Type | Determined By | Mechanism | Persistence |
|---|---|---|---|
| **Proactive Replica** | The Hash Ring | Pushed asynchronously via Kafka/BullMQ immediately after upload. | "Permanent" (Responsible Replica Set) |
| **Opportunistic Replica** | User Traffic (Geo-Routing) | Fetched on cache-miss (Cache-on-Demand) when a user hits a non-responsible edge. | Temporary (Evicted via LRU) |

*Example:* A file is uploaded. The Hash Ring assigns it to Frankfurt and Virginia (Proactive). A user in Tokyo requests it and is geo-routed to Mumbai. Mumbai experiences a cache miss, fetches from Origin, and caches it (Opportunistic).

## 3. The `HashRing` Abstraction
The ring will be implemented as a pure algorithmic utility class. It takes a pluggable hash function (defaulting to MD5 -> `uint32`).

### Core API Contract
```typescript
export interface IHashRing {
  addNode(nodeId: string): void;
  removeNode(nodeId: string): void;
  getNodes(key: string, count: number): string[];
}
```

### Virtual Nodes & Deduplication
To prevent "clumping" (uneven data distribution), we use **Virtual Nodes**. 
- Each physical node is added to the ring multiple times (configurable, default `100`).
- Internally, they are hashed as `nodeId:vnode:1`, `nodeId:vnode:2`, etc.

**The Deduplication Rule:**
When walking clockwise to find `count=3` replicas, the ring will inevitably hit multiple virtual nodes belonging to the *same* physical node (e.g., `Mumbai:v42`, `Mumbai:v88`). The `getNodes` method uses a `Set<string>` to deduplicate the physical IDs, guaranteeing it returns exactly 3 *distinct* physical edge nodes.

## 4. Handling Node Scarcity (Graceful Degradation)
If the system experiences a massive outage (e.g., 2 out of 4 global nodes go DOWN), the desired replication factor (3) might exceed the available healthy nodes (2).

**Rule:** `actual_replicas = min(desired_replicas, healthy_nodes.length)`

The system will **never** fail a user's upload due to edge scarcity. Instead, it will emit a `ReplicationWarning` (e.g., `[Replication] WARNING: desired=3, actual=2`) and proceed with the available nodes.

## 5. Ring Membership vs Node Health
A transient health failure should not automatically redefine the ownership topology. Therefore, we explicitly separate these two concerns:

- **Ring Membership (Hash Ring):** Answers *"Which nodes are responsible for this key?"* The ring contains the physical topology of all provisioned nodes, regardless of their current health status.
- **Node Health (Replication Layer):** Answers *"Which of those responsible nodes are currently available?"* 

When determining placement, the `HashRing` returns the responsible candidates, and the `ReplicationService` filters them against the `HealthCheckService` data to determine the live availability, applying the `min(3, N)` fallback if necessary.

## 6. Node Churn & Rebalancing Behavior
A core property of Consistent Hashing is stability during churn. 

**Before Adding Node E:**
`A ─── B ─── C ─── D`
Keys falling between A and B map to B. Keys between B and C map to C.

**After Adding Node E:**
`A ─── B ─── E ─── C ─── D`
Only the keys falling between B and E are remapped (they move from C to E). All other keys in the system remain exactly where they are. 

*(Note: Phase 5B will establish the deterministic ring for placement. The active background worker that actually moves physical bytes between nodes during a rebalance event will be tackled in a future phase).*

## 7. Implementation Plan
1. **Utility:** Implement `HashRing` class in `src/common/replication/hash-ring.ts`.
2. **Integration:** Inject `HashRing` into `ReplicationService` with the static/provisioned topology of all edge nodes.
3. **Execution:** Update the file upload flow to call `hashRing.getNodes(fileId, 3)`. The `ReplicationService` will then cross-reference these responsible nodes against `HealthCheckService.getHealthyNodes()` and dispatch BullMQ jobs to the available replicas.
