export interface BridgeConfig {
  /** Always loopback: the bridge exposes terminals and actions (design #20). */
  host: '127.0.0.1';
  port: number;
}

export const DEFAULT_PORT = 4317;

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const raw = env.ORCA_OFFICE_PORT;
  let port = DEFAULT_PORT;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new Error(`ORCA_OFFICE_PORT must be a port number, got "${raw}"`);
    }
    port = n;
  }
  return { host: '127.0.0.1', port };
}
