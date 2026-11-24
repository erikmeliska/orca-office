/**
 * Wire protocol between the Orca plugin, the bridge and the browser client.
 * Bumped on any breaking change to the messages below.
 */
export const PROTOCOL_VERSION = 0;

/** First message every peer sends after connecting. */
export interface Hello {
  type: 'hello';
  role: 'plugin' | 'client';
  protocol: number;
}

export function isHello(value: unknown): value is Hello {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'hello' && (v.role === 'plugin' || v.role === 'client') && typeof v.protocol === 'number';
}
