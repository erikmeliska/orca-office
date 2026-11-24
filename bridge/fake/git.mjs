#!/usr/bin/env node
// A stand-in `git` (ORCA_OFFICE_GIT) for `npm run dev:fake`: answers only `git -C <dir> remote get-url origin`
// for the made-up repos, so the repo boards (#38) have a forge to ask.
const [, , c, dir, ...rest] = process.argv;
if (c !== '-C' || rest.join(' ') !== 'remote get-url origin') process.exit(2);
const remotes = { 'demo-web': 'git@github.com:example/demo-web.git', 'demo-api': 'https://gitlab.com/example/demo-api.git' };
const repo = Object.keys(remotes).find((r) => dir?.startsWith(`/code/${r}/`));
if (!repo) process.exit(2);
console.log(remotes[repo]);
