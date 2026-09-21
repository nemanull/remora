import { Controller, Get } from '@nestjs/common';
import type { ClustersResponse } from '@remora/sdk';
import { PrismaService } from '../prisma/prisma.service';
import { toClusterResponse } from './responses';

@Controller('api/clusters')
export class ClustersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async listClusters(): Promise<ClustersResponse> {
    const [clusters, waiting] = await Promise.all([
      this.prisma.cluster.findMany({
        orderBy: { id: 'asc' },
        include: {
          wallets: {
            select: { address: true, status: true },
            orderBy: { address: 'asc' },
          },
        },
      }),
      this.prisma.wallet.findMany({
        where: {
          clusterId: null,
          OR: [
            { status: { in: ['SHADOW', 'LIVE'] } },
            { positions: { some: { isOpen: true } } },
          ],
        },
        select: { address: true },
        orderBy: { address: 'asc' },
      }),
    ]);
    return {
      clusters: clusters.map(toClusterResponse),
      waitingWallets: waiting.map((wallet) => wallet.address),
    };
  }
}
