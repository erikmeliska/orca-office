// What the fake Orca adds while it runs (new tasks, comments, read marks), shared between the fake
// plugin and the fake CLI, which are separate processes. Made-up data only, in the temp folder.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FILE = join(tmpdir(), `orca-office-fake-${process.env.ORCA_OFFICE_PORT ?? 4317}.json`);
const EMPTY = { workspaces: [], agents: [], comments: {}, read: [], typed: {} };

export function load() {
  try {
    return { ...EMPTY, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return { ...EMPTY };
  }
}

export function save(state) {
  writeFileSync(FILE, JSON.stringify(state));
}

export function reset() {
  save(EMPTY);
}
