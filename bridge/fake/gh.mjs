#!/usr/bin/env node
// A stand-in `gh` (ORCA_OFFICE_GH) for `npm run dev:fake`: made-up open issues and pull requests of example/demo-web.
// ORCA_OFFICE_FAKE_FORGE=auth plays a `gh` that isn't logged in.
const args = process.argv.slice(2);
if (process.env.ORCA_OFFICE_FAKE_FORGE === 'auth') {
  console.error('To get started with GitHub CLI, please run:  gh auth login');
  process.exit(4);
}
const base = 'https://github.com/example/demo-web';
const issues = [
  [97, 'Expired sessions land on a blank dashboard'],
  [88, 'Install steps are out of date'],
  [102, 'Keyboard shortcut for the search box'],
  [105, 'Export the table as CSV'],
  [109, 'Avatar upload fails for PNGs over 2 MB'],
].map(([number, title]) => ({ number, title, url: `${base}/issues/${number}` }));
const pulls = [
  [128, 'Redirect to the login page when the session expires', 'fix-login', false],
  [131, 'Dark mode palette tokens', 'dark-mode', false],
  [133, 'Bump the chart library', 'deps/charts', true],
  [134, 'Faster first paint on the dashboard', 'perf-first-paint', false],
].map(([number, title, headRefName, isDraft]) => ({ number, title, url: `${base}/pull/${number}`, headRefName, isDraft }));
if (args[0] === 'issue' && args[1] === 'list') console.log(JSON.stringify(issues));
else if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify(pulls));
else process.exit(2);
