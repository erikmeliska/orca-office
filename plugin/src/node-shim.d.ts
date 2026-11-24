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
