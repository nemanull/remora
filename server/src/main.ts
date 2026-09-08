import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { ServerConfig } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const config = app.get<ConfigService<ServerConfig, true>>(ConfigService);
  await app.listen(
    config.getOrThrow('PORT', { infer: true }),
    config.getOrThrow('HOST', { infer: true }),
  );
}

void bootstrap();
