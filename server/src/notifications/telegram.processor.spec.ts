import type { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config';
import { TelegramProcessor } from './telegram.processor';

function createProcessor(settings: Partial<ServerConfig>) {
  const config = {
    get: (key: keyof ServerConfig) => settings[key],
  } as unknown as ConfigService<ServerConfig, true>;
  return new TelegramProcessor(config);
}

function job(data: unknown, name = 'send-telegram'): Job {
  return { id: '1', name, data } as Job;
}

function stubFetch(status: number, body = '{"ok":true}') {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const CONFIGURED = { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '42' };

describe('TelegramProcessor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends nothing while the bot token is unset', async () => {
    const fetchMock = stubFetch(200);

    await createProcessor({}).process(job({ text: 'hello' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the text to the chat through sendMessage', async () => {
    const fetchMock = stubFetch(200);

    await createProcessor(CONFIGURED).process(job({ text: 'hello' }));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-token/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      chat_id: '42',
      text: 'hello',
      disable_web_page_preview: true,
    });
  });

  it('retries when Telegram is rate limited or down', async () => {
    stubFetch(429, '{"ok":false,"parameters":{"retry_after":3}}');

    const sending = createProcessor(CONFIGURED).process(job({ text: 'hi' }));

    await expect(sending).rejects.toThrow('Telegram answered 429');
    await expect(sending).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it('gives up on a message Telegram refuses', async () => {
    stubFetch(400, '{"ok":false,"description":"chat not found"}');

    await expect(
      createProcessor(CONFIGURED).process(job({ text: 'hi' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('refuses a job without a text', async () => {
    stubFetch(200);

    await expect(
      createProcessor(CONFIGURED).process(job({})),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
