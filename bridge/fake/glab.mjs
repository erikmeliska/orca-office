#!/usr/bin/env node
// A stand-in `glab` (ORCA_OFFICE_GLAB) for `npm run dev:fake`: made-up open issues and merge requests of example/demo-api.
const args = process.argv.slice(2);
const base = 'https://gitlab.com/example/demo-api/-';
const issues = [
  [9, 'Search takes 4 s on big accounts'],
  [12, 'Rate limit headers are missing'],
].map(([iid, title]) => ({ iid, title, web_url: `${base}/issues/${iid}`, state: 'opened' }));
const mrs = [
  [17, 'Index the search columns', 'search-speed'],
  [19, 'Theme preference endpoint', 'theme-pref'],
].map(([iid, title, source_branch]) => ({ iid, title, web_url: `${base}/merge_requests/${iid}`, source_branch, state: 'opened', draft: false }));
if (args[0] === 'issue' && args[1] === 'list') console.log(JSON.stringify(issues));
else if (args[0] === 'mr' && args[1] === 'list') console.log(JSON.stringify(mrs));
else process.exit(2);
