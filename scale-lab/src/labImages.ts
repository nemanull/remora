import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export const REPOSITORY_ROOT = resolve(__dirname, '..', '..');

export const LAB_IMAGES = {
  server: 'remora-server',
  walletFinder: 'remora-wallet-finder',
  collector: 'remora-collector',
  simulator: 'remora-hyperliquid-sim',
} as const;

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.sim.yml'];
const COMPOSE_SERVICES = [
  'core',
  'wallet-finder',
  'collector',
  'hyperliquid-sim',
];

export default async function buildLabImages(): Promise<void> {
  const fileArguments = COMPOSE_FILES.flatMap((file) => ['-f', file]);
  try {
    await promisify(execFile)(
      'docker',
      [
        'compose',
        ...fileArguments,
        '--profile',
        'app',
        'build',
        ...COMPOSE_SERVICES,
      ],
      { cwd: REPOSITORY_ROOT, maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String(error.stderr).slice(-4_000)
        : String(error);
    throw new Error(`Building the lab images failed\n${stderr}`);
  }
}
