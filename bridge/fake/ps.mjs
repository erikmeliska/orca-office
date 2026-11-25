#!/usr/bin/env node
// A stand-in `ps` (ORCA_OFFICE_PS) for `npm run dev:fake`: the made-up dev servers' command lines,
// so no real process on this machine ever shows on the services board.
import { PORTS } from './data.mjs';
const argv = process.argv.slice(2);
const pid = Number(argv[argv.indexOf('-p') + 1]);
const p = PORTS.find((x) => x.pid === pid);
if (!p) process.exit(1);
console.log(p.cmdline);
