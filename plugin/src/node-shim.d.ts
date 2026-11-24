// The worker runs in Node, but Orca's worker typings do not include @types/node.
declare const process: { version: string; platform: string };
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
declare module 'node:os' {
  export function homedir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare module 'node:crypto' {
  interface Hmac {
    update(data: string): Hmac;
    digest(encoding: 'hex'): string;
  }
  export function createHmac(algorithm: 'sha256', key: string): Hmac;
  export function randomBytes(size: number): { toString(encoding: 'hex'): string };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
