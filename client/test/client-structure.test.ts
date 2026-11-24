import { test } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const client = path.join(import.meta.dirname, '../src');
const read = (file: string) => readFileSync(file, 'utf8');

/**
 * The relative imports of a client module, resolved to files (`./foo` is foo.ts, or foo/index.ts).
 * With `types`, type-only ones too; without, what's loaded at run time.
 */
function importsOf(file: string, types = true): string[] {
  const out: string[] = [];
  for (const m of read(file).matchAll(/^\s*(import|export)\s(type\s)?[^'"]*?from\s+'(\.[^']+)'|^\s*import\s+'(\.[^']+)'/gm)) {
    if (m[2] && !types) continue;
    const spec = m[3] ?? m[4];
    // A stylesheet, or an asset's URL (a model, a sound).
    if (spec.endsWith('.css') || spec.includes('?')) continue;
    // The shared code (src/shared) names its imports as the server does, with .js for .ts.
    const base = path.resolve(path.dirname(file), spec.replace(/\.js$/, ''));
    const found = [`${base}.ts`, path.join(base, 'index.ts'), base].find((f) => existsSync(f) && statSync(f).isFile());
    assert.ok(found, `${path.relative(client, file)} imports ${spec}, which is not there`);
    out.push(found);
  }
  return out;
}

/** Every module `entry` loads at run time, itself included. */
function graph(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    todo.push(...importsOf(f, false));
  }
  return seen;
}

test('main.ts installs every feature, each with one install line', () => {
  const main = read(path.join(client, 'main.ts'));
  const features = readdirSync(path.join(client, 'features')).filter((d) => statSync(path.join(client, 'features', d)).isDirectory());
  assert.ok(features.length >= 25, `found ${features.length} features`);
  for (const f of features) {
    const dir = path.join(client, 'features', f);
    const installs = readdirSync(dir)
      .filter((x) => x.endsWith('.ts'))
      .flatMap((x) => [...read(path.join(dir, x)).matchAll(/^export function (install\w+)\(/gm)].map((m) => m[1]));
    assert.ok(installs.length, `features/${f} has an install function`);
    for (const name of installs) assert.equal(main.split(`${name}(ctx`).length - 1, 1, `main.ts calls ${name} once`);
  }
});

test('no part of the office imports main.ts: it only puts them together', () => {
  for (const dir of ['core', 'features', 'input', 'shared']) {
    for (const rel of readdirSync(path.join(client, dir), { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue;
      const file = path.join(client, dir, rel);
      for (const dep of importsOf(file)) assert.notEqual(path.relative(client, dep), 'main.ts', `${dir}/${rel} imports main.ts`);
    }
  }
});

test('the live list page (live.html) loads no three.js and none of the 3D office', () => {
  const live = graph(path.join(client, 'live.ts'));
  for (const f of live) {
    const rel = path.relative(client, f);
    assert.doesNotMatch(read(f), /from 'three(?:\/[^']*)?'/, `${rel} (loaded by live.ts) imports three.js`);
    assert.ok(!/^(core|features|input|world|player)\//.test(rel), `live.ts loads ${rel}, part of the 3D office`);
  }
});
