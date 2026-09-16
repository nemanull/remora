import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SERVER_DIRECTORY = join(__dirname, '..');
const POSTGRES_IMAGE = 'postgres:18.4';

export async function startMigratedPostgres(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('remora')
    .withUsername('remora')
    .withPassword('remora')
    .start();
  execFileSync(
    join(SERVER_DIRECTORY, 'node_modules/.bin/prisma'),
    ['migrate', 'deploy'],
    {
      cwd: SERVER_DIRECTORY,
      env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
      stdio: 'pipe',
    },
  );
  return container;
}
