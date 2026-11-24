export interface BridgeConfig {
  /** Always loopback: the bridge exposes terminals and actions (design #20). */
  host: '127.0.0.1';
  port: number;
  /** Port of the office page, the only Origin allowed on `/client`. */
  clientPort: number;
  /** ORCA_OFFICE_STUB=1: `/client` gets made-up office data instead of Orca's (see stub.ts). */
  stub: boolean;
}

export const DEFAULT_PORT = 4317;
export const DEFAULT_CLIENT_PORT = 5317;

function readPort(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be a port number, got "${raw}"`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  return {
    host: '127.0.0.1',
    port: readPort(env, 'ORCA_OFFICE_PORT', DEFAULT_PORT),
    clientPort: readPort(env, 'ORCA_OFFICE_CLIENT_PORT', DEFAULT_CLIENT_PORT),
    stub: env.ORCA_OFFICE_STUB === '1',
  };
}
