import { PrismaClient, EdgeNodeStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding Phase 5A Edge Nodes...');

  const nodes = [
    {
      name: 'Mumbai Edge',
      region: 'ap-south-1',
      latitude: 19.076,
      longitude: 72.8777,
      endpointUrl: 'http://localhost:3001',
      status: EdgeNodeStatus.HEALTHY,
    },
    {
      name: 'Virginia Edge',
      region: 'us-east-1',
      latitude: 37.4316,
      longitude: -78.6569,
      endpointUrl: 'http://localhost:3002',
      status: EdgeNodeStatus.HEALTHY,
    },
    {
      name: 'Frankfurt Edge',
      region: 'eu-central-1',
      latitude: 50.1109,
      longitude: 8.6821,
      endpointUrl: 'http://localhost:3003',
      status: EdgeNodeStatus.HEALTHY,
    },
  ];

  for (const node of nodes) {
    await prisma.edgeNode.upsert({
      where: { name: node.name },
      update: {
        region: node.region,
        latitude: node.latitude,
        longitude: node.longitude,
        endpointUrl: node.endpointUrl,
      },
      create: node,
    });
    console.log(`Upserted edge node: ${node.name}`);
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
