#!/usr/bin/env node
/**
 * Final pass — an openrouteservice whose daily allowance is already spent.
 *
 * Every routing request is refused with 429 and an `x-ratelimit-reset` an hour
 * away, exactly the shape the hosted service answers when its quota runs out.
 * `GET /count` reports how many routing requests arrived, so the simulation
 * can prove the client stopped asking (the process-wide breaker), and
 * `GET /health` answers for Playwright's webServer probe.
 */
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 4399);
let count = 0;
createServer((req, res) => {
  if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  if (req.url === '/count') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count }));
  count += 1;
  const reset = Math.floor(Date.now() / 1000) + 3600;
  req.resume();
  res.writeHead(429, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }).end(JSON.stringify({ error: 'Rate Limit Exceeded' }));
}).listen(port, '127.0.0.1');
