import crypto from 'crypto';

export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; hashed: string } {
  const key = `vek_${crypto.randomBytes(32).toString('hex')}`;
  const prefix = key.substring(0, 12);
  const hashed = hashApiKey(key);
  return { key, prefix, hashed };
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createWebhookSignature(payload: any, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function estimateRenderTime(props: any): number {
  const duration = props?.project?.duration || 10;
  return Math.ceil(duration * 2);
}

export function getPriority(role: string): number {
  const priorities: Record<string, number> = { admin: 1, team: 2, pro: 3, free: 4 };
  return priorities[role] || 4;
}
