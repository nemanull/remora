import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { join } from 'node:path';
import { ReplayModule } from './replay.module';
import { parseReplayArguments } from './replayArguments';
import { buildReplayReport, writeReplayReport } from './replayReport';
import { ReplayRun } from './replayRun';

async function replayWallet(): Promise<void> {
  const options = parseReplayArguments(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(ReplayModule, {
    logger: ['error', 'warn'],
  });
  app.useLogger(['log', 'warn', 'error']);
  try {
    const { input, outcome, isTruncated } = await app
      .get(ReplayRun)
      .run(options);
    const report = buildReplayReport(input, outcome, isTruncated, new Date());
    const paths = await writeReplayReport(
      report,
      join(process.cwd(), 'reports'),
    );
    new Logger('Replay').log(
      `Replay of ${options.wallet} over ${options.days} days wrote ${paths.markdown} and ${paths.json}`,
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  replayWallet().catch((error) => {
    new Logger('Replay').error(
      'Replay failed',
      error instanceof Error ? error.stack : String(error),
    );
    process.exitCode = 1;
  });
}
