import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  it('builds a client with the lifecycle hooks Nest calls without connecting', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [
            () => ({
              DATABASE_URL: 'postgresql://remora:remora@127.0.0.1:1/remora',
            }),
          ],
        }),
      ],
      providers: [PrismaService],
    }).compile();

    const prisma = moduleRef.get(PrismaService);

    expect(typeof prisma.onModuleInit).toBe('function');
    expect(typeof prisma.onModuleDestroy).toBe('function');
    expect(typeof prisma.wallet.findMany).toBe('function');
  });
});
