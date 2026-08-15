import { PrismaClient, EdgeNodeStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';

let dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  try {
    const envContent = fs.readFileSync(path.resolve(__dirname, '../../../.env'), 'utf-8');
    const match = envContent.match(/^DATABASE_URL=["']?([^"'\r\n]+)["']?/m);
    if (match) dbUrl = match[1];
  } catch {}
}

const adapter = new PrismaPg({ connectionString: dbUrl });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding Phase 5A Edge Nodes...');

  await prisma.edgeNode.deleteMany();

  const nodes = [
    {
      id: 'edge-node-01',
      name: 'Mumbai Edge',
      region: 'ap-south-1',
      latitude: 19.076,
      longitude: 72.8777,
      endpointUrl: 'http://localhost:3001',
      status: EdgeNodeStatus.HEALTHY,
    },
    {
      id: 'edge-node-02',
      name: 'Virginia Edge',
      region: 'us-east-1',
      latitude: 37.4316,
      longitude: -78.6569,
      endpointUrl: 'http://localhost:3002',
      status: EdgeNodeStatus.HEALTHY,
    },
    {
      id: 'edge-node-03',
      name: 'Frankfurt Edge',
      region: 'eu-central-1',
      latitude: 50.1109,
      longitude: 8.6821,
      endpointUrl: 'http://localhost:3003',
      status: EdgeNodeStatus.HEALTHY,
    },
  ];

  for (const node of nodes) {
    await prisma.edgeNode.create({
      data: node,
    });
    console.log(`Created edge node: ${node.name} (${node.id})`);
  }

  console.log('Seeding finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
