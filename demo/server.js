'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { networkInterfaces } = require('node:os');
const { DemoMarket, calendar, rules, fail } = require('./market');
const { play } = require('./agent-client');

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/trade', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['dashboard.js', 'application/javascript; charset=utf-8']],
]);

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json.');
  }
  let bytes = 0;
  const parts = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 65536) fail(413, 'BODY_TOO_LARGE', 'Request exceeds 64 KiB.');
    parts.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    fail(400, 'INVALID_JSON', 'Expected a JSON object.');
  }
}

function interfaceAddresses() {
  return Object.values(networkInterfaces()).flat()
    .filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address);
}

function createServer({ external = false, network = false } = {}) {
  const market = new DemoMarket();
  let timer;
  let controller;
  let ends = null;
  let roundSeconds = 8;
  let automatic = false;
  let lastPoll = '';
  let agentStatus = external ? 'external' : 'idle';

  function tick() {
    clearTimeout(timer);
    ends = null;
    market.advance();
    if (!automatic || market.phase === 'CLOSED') return;
    const seconds = { SETUP: 1, APPRAISAL: 7, ROUND_OPEN: roundSeconds, ROUND_CLEARING: 0.8 }[market.phase];
    ends = Date.now() + seconds * 1000;
    timer = setTimeout(tick, seconds * 1000);
  }

  function reset(seed = 28) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) fail(422, 'INVALID_SEED', 'Use a non-negative integer seed.');
    clearTimeout(timer);
    controller?.abort();
    controller = null;
    ends = null;
    lastPoll = '';
    agentStatus = external ? 'external' : 'idle';
    market.reset(seed);
  }

  const server = http.createServer(async (req, res) => {
    function send(code, data, type = 'application/json; charset=utf-8') {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    }
    try {
      const host = req.headers.host;
      const hostname = /^([^:]+)(?::\d+)?$/.exec(host || '')?.[1];
      if (!(hostname === '127.0.0.1' || hostname === 'localhost' ||
          (network && interfaceAddresses().includes(hostname))) ||
          (req.headers.origin && req.headers.origin !== `http://${host}`)) {
        fail(403, 'INVALID_HOST', 'Use the market URL printed by the demo.');
      }
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const method = req.method;
      const route = `${method} ${p}`;
      const state = () => market.state(ends === null ? null : Math.max(0, (ends - Date.now()) / 1000));
      if (method === 'GET' && assets.has(p)) {
        const [file, type] = assets.get(p);
        return send(200, fs.readFileSync(path.join(__dirname, 'web', file)), type);
      }
      switch (route) {
        case 'GET /v1/version': return send(200, { version: '1.0-demo', market: 'sandbox', server_time: Date.now() / 1000 });
        case 'GET /v1/calendar':
          market.log(method, p, 'กติกาและปฏิทิน');
          return send(200, { rules, calendar });
        case 'GET /v1/state': {
          const current = state();
          if (external && req.headers['x-demo-client'] === 'optimized-v2') {
            agentStatus = current.phase === 'CLOSED' ? 'closed' : 'connected';
          }
          const key = `${current.phase}:${current.round?.round_id || ''}`;
          if (lastPoll !== key) {
            market.log(method, p, [current.phase, current.round?.round_id].filter(Boolean).join(' · '));
            lastPoll = key;
          }
          return send(200, current);
        }
        case 'GET /v1/lots': return send(200, { lots: state().lots });
        case 'GET /v1/rfqs': return send(200, { rfqs: state().rfqs });
        case 'GET /v1/appraisals': return send(200, { items: market.appraisals || [] });
        case 'GET /v1/offers': return send(200, { offers: state().my_open_offers });
        case 'GET /v1/results': {
          const chosen = url.searchParams.get('round');
          const result = chosen ? market.results.find(r => r.round_id === chosen) : market.results.at(-1);
          if (chosen && !result) fail(404, 'UNKNOWN_RESULT', 'This round has no result.');
          return send(200, result ?? null);
        }
        case 'GET /v1/standings': return send(200, market.standings());
        case 'GET /v1/leaderboard': return send(200, { leaderboard: [{ rank: 1, team_id: 'T28', ...market.profile }] });
        case 'GET /v1/profile': return send(200, market.profile);
        case 'GET /v1/sandbox/reveal': return send(200, market.reveal());
        case 'GET /demo/session': return send(200, { state: state(), events: market.events, results: market.results,
          reveal: market.phase === 'CLOSED' ? market.reveal() : null, agentStatus, seed: market.seed });
        case 'POST /v1/profile': {
          const profile = await readBody(req);
          for (const field of ['team_name', 'university']) {
            if (typeof profile[field] !== 'string' || profile[field].length > 80) {
              fail(422, 'INVALID_PROFILE', 'Profile fields must have at most 80 characters.');
            }
          }
          market.profile = { team_name: profile.team_name.trim(), university: profile.university.trim() };
          return send(200, market.profile);
        }
        case 'POST /v1/appraisals': {
          const result = market.appraise((await readBody(req)).items);
          market.log(method, p, `ส่งผลประเมิน ${result.items.length} ล็อต`);
          return send(201, result);
        }
        case 'POST /v1/offers:batch':
        case 'POST /v1/offers': {
          const body = await readBody(req);
          const batch = p.endsWith(':batch');
          const offers = market.submit(batch ? body.offers : [body], batch && body.replace_existing === true, batch);
          market.log(method, p, `${state().round.round_id} · ${offers.length} ซอง · ${offers.reduce((kg, o) => kg + o.kg, 0)} กก.`);
          return send(201, batch ? { offers } : offers[0]);
        }
        case 'POST /v1/sandbox/reset':
          reset((await readBody(req)).seed);
          return send(200, state());
        case 'POST /demo/start': {
          const options = await readBody(req);
          if (market.phase !== 'WAITING') fail(409, 'ALREADY_STARTED', 'Reset before starting again.');
          roundSeconds = options.roundSeconds ?? 8;
          if (!Number.isInteger(roundSeconds) || roundSeconds < 2 || roundSeconds > 60) {
            fail(422, 'INVALID_DURATION', 'Use a round duration between 2 and 60 seconds.');
          }
          automatic = options.automatic !== false;
          tick();
          if (!external) {
            controller = new AbortController();
            const { signal } = controller;
            agentStatus = 'running';
            play(`http://127.0.0.1:${server.address().port}`, signal).then(() => {
              if (!signal.aborted) agentStatus = 'closed';
            }).catch(error => {
              if (!signal.aborted) {
                agentStatus = 'error';
                market.log('ERROR', '/agent', error.message);
              }
            });
          }
          return send(200, state());
        }
        case 'POST /demo/advance':
          await readBody(req);
          if (market.phase === 'WAITING') fail(409, 'NOT_STARTED', 'Start the demo first.');
          tick();
          return send(200, state());
        default: {
          const id = /^\/v1\/offers\/(O\d+)$/.exec(p)?.[1];
          if (id && method === 'PUT') return send(200, market.change(id, await readBody(req), false));
          if (id && method === 'DELETE') return send(200, market.change(id, null, true));
          fail(404, 'NOT_FOUND', 'Endpoint not found.');
        }
      }
    } catch (error) {
      if (!error.status) console.error(error);
      send(error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR',
        message: error.status ? error.message : 'The local market hit an error.', allowed: error.allowed } });
    }
  });
  server.once('close', () => {
    clearTimeout(timer);
    controller?.abort();
  });
  return server;
}

if (require.main === module) {
  const raw = process.argv.find(arg => arg.startsWith('--port='));
  const port = raw ? Number(raw.split('=')[1]) : 8787;
  const network = process.argv.includes('--network');
  const external = process.argv.includes('--external');
  const server = createServer({ external, network });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose --port=8788.` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, network ? '0.0.0.0' : '127.0.0.1', () => {
    const actualPort = server.address().port;
    console.log(`Track 3 Demo: http://127.0.0.1:${actualPort}/trade`);
    for (const ip of network ? interfaceAddresses() : []) {
      if (!ip.startsWith('169.254.')) console.log(`LAN: http://${ip}:${actualPort}/trade`);
    }
    if (external) console.log('Waiting for an external agent.');
  });
  process.on('SIGINT', () => server.close());
}

module.exports = { createServer };
