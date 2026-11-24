import { createServer } from 'node:http';
import { PROTOCOL_VERSION } from '@orca-office/shared';
import { loadConfig } from './config.js';

const config = loadConfig();

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(config.port, config.host, () => {
  console.log(`orca-office bridge on http://${config.host}:${config.port}`);
});
