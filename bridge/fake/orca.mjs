#!/usr/bin/env node
// A stand-in `orca` CLI (ORCA_BIN) that answers what the bridge polls with made-up data.
import { AGENTS, BOTS, REMOTE } from './data.mjs';
const args = process.argv.slice(2).join(' ');
const out = (result) => console.log(JSON.stringify({ id: 'fake', ok: true, result }));
if (args.startsWith('agent list') && args.includes('--environment')) out({ agents: REMOTE, hostScope: { hostIds: ['runtime:demo'] }, truncated: false });
else if (args.startsWith('agent list')) out({ agents: AGENTS, hostScope: { hostIds: ['local'], omittedHostSelectors: [{ hostId: 'runtime:demo', selector: '--environment demo.example' }] }, truncated: false });
else if (args.startsWith('bot list')) out({ bots: BOTS });
else {
  console.error(`fake orca: ${args} not faked`);
  process.exit(2);
}
