import { z } from 'zod';

function positiveInteger(fallback: number) {
  return z.coerce.number().int().positive().default(fallback);
}

export const simulatorConfigSchema = z.object({
  SIM_SEED: z.coerce.number().int().nonnegative().default(1),
  SIM_WALLETS: z.coerce.number().int().min(1).max(2_000).default(300),
  SIM_SPEED: z.coerce.number().min(1).max(100).default(1),
  SIM_REST_LAG_MS: z.coerce.number().int().nonnegative().default(0),
  SIM_MAX_CONNECTIONS: positiveInteger(10),
  SIM_NEW_CONNECTIONS_PER_MINUTE: positiveInteger(30),
  SIM_MAX_USERS: positiveInteger(10),
  SIM_MAX_SUBSCRIPTIONS: positiveInteger(1_000),
  SIM_MESSAGES_PER_MINUTE: positiveInteger(2_000),
  SIM_WEIGHT_PER_MINUTE: positiveInteger(1_200),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3030),
});

export type SimulatorConfig = z.output<typeof simulatorConfigSchema>;

export function validateSimulatorConfig(
  environment: Record<string, unknown>,
): SimulatorConfig {
  const setVariables = Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== ''),
  );
  const result = simulatorConfigSchema.safeParse(setVariables);
  if (!result.success) {
    throw new Error(
      `Invalid simulator configuration\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
