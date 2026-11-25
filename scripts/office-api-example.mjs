#!/usr/bin/env node
// A minimal Office API client (docs/api.md): prints the agents waiting for you, and with --watch
// keeps printing them as the office changes (Server-Sent Events). Node 22+, no dependencies.
//
//   node scripts/office-api-example.mjs            # once
//   node scripts/office-api-example.mjs --watch    # on every change
//   ORCA_OFFICE_PORT=4457 node scripts/office-api-example.mjs
//
// It prints what agents ask in full: private text, for your terminal only. Don't pipe it to a log.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.ORCA_OFFICE_PORT || 4317);
const base = `http://127.0.0.1:${port}/api/v1`;
const tokenPath = process.env.ORCA_OFFICE_API_TOKEN_FILE || join(homedir(), '.orca-office', 'api-token');
const token = readFileSync(tokenPath, 'utf8').trim();
// No Origin header: the API refuses requests that carry one (it is for processes, not browsers).
const headers = { authorization: `Bearer ${token}` };

async function snapshot() {
  const res = await fetch(`${base}/snapshot`, { headers });
  if (!res.ok) throw new Error(`snapshot: HTTP ${res.status} ${(await res.json().catch(() => ({}))).error ?? ''}`);
  return res.json();
}

function print(snap) {
  const floors = new Map(snap.floors.map((f) => [f.id, f.name]));
  const worktrees = new Map(snap.worktrees.map((w) => [w.id, w]));
  const waiting = snap.agents.filter((a) => a.needsYou);
  console.log(`\n${new Date(snap.at).toLocaleTimeString()}  rev ${snap.rev}  Orca ${snap.orca.connected ? 'connected' : 'offline'}  ${waiting.length} waiting for you`);
  for (const a of waiting) {
    const w = worktrees.get(a.worktreeId);
    const mins = Math.round((snap.at - a.since) / 60_000);
    console.log(`- ${floors.get(a.floorId) ?? '?'} / ${w?.name ?? a.worktreeId}${w?.branch ? ` (${w.branch})` : ''}  ${a.agent ?? 'agent'} ${a.asks}, ${mins} min`);
    if (a.question) console.log(`  ${a.question.replace(/\n/g, '\n  ')}`);
  }
  for (const r of snap.runs) for (const g of r.gates) console.log(`- decision in "${r.objective ?? r.id}": ${g.question ?? g.id}${g.options.length ? ` [${g.options.join(' | ')}]` : ''}`);
}

/** Reads the event stream; on `changed` with a rev we haven't printed, fetches the snapshot. */
async function watch() {
  let rev = -1;
  for (;;) {
    try {
      const res = await fetch(`${base}/events`, { headers });
      if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || !data) continue;
          const msg = JSON.parse(data);
          if (name === 'snapshot') {
            rev = msg.rev;
            print(msg);
          } else if (name === 'changed' && msg.rev !== rev) {
            const snap = await snapshot();
            rev = snap.rev;
            print(snap);
          }
        }
      }
    } catch (err) {
      console.error(String(err.message ?? err));
    }
    // The bridge restarted or went away: try again shortly.
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

if (process.argv.includes('--watch')) await watch();
else print(await snapshot());
