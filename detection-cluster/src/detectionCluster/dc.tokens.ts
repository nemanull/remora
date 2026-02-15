export function resolveClusterIdFromEnv(): number {
  const rawClusterId = process.env.CLUSTER_ID ?? process.env.cluster_id ?? '1';
  const parsed = Number.parseInt(rawClusterId, 10);

  if (Number.isNaN(parsed)) {
    throw new Error('CLUSTER_ID must be a valid number');
  }

  return parsed;
}
