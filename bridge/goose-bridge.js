#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';

const bind = String(process.env.GOOSE_BRIDGE_BIND || '0.0.0.0').trim();
const port = Number.parseInt(String(process.env.GOOSE_BRIDGE_PORT || '8788'), 10) || 8788;
const token = String(process.env.GOOSE_BRIDGE_TOKEN || '').trim();

function writeJson(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function writeEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function checkAuth(req, res) {
  if (!token) return true;
  const actual = String(req.headers['x-goose-bridge-token'] || '').trim();
  if (actual === token) return true;
  writeJson(res, 401, { error: 'unauthorized' });
  return false;
}

function pumpLines(stream, onLine) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) onLine(line.replace(/\r$/, ''));
  });
  stream.on('end', () => {
    if (buf) onLine(buf.replace(/\r$/, ''));
  });
}

async function runProbe(req, res) {
  if (!checkAuth(req, res)) return;
  const child = spawn('goose', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    err += chunk.toString();
  });
  child.on('error', (error) => {
    writeJson(res, 500, { ok: false, reason: String(error?.message || error) });
  });
  child.on('close', (code) => {
    if (code === 0) writeJson(res, 200, { ok: true, version: out.trim() });
    else writeJson(res, 500, { ok: false, reason: (err || out || '').trim() || `exit_${code}` });
  });
}

async function runStream(req, res) {
  if (!checkAuth(req, res)) return;
  let body = {};
  try {
    body = await readJson(req);
  } catch {
    writeJson(res, 400, { error: 'invalid_json' });
    return;
  }

  const args = Array.isArray(body?.args) ? body.args.map((v) => String(v)) : null;
  const cwd = String(body?.cwd || process.cwd()).trim() || process.cwd();
  const extraEnv = body?.env && typeof body.env === 'object' ? body.env : {};
  const timeoutMs = Number.parseInt(String(body?.timeoutMs || '0'), 10);
  const noOutputTimeoutMs = Number.parseInt(String(body?.noOutputTimeoutMs || '0'), 10);
  if (!args || !args.length) {
    writeJson(res, 400, { error: 'args_required' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });

  const child = spawn('goose', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ...extraEnv }
  });
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  let closed = false;

  const closeNow = (code, reason = '') => {
    if (closed) return;
    closed = true;
    writeEvent(res, { type: 'close', code, reason, durationMs: Date.now() - startedAt });
    res.end();
  };

  const watchdog = noOutputTimeoutMs > 0
    ? setInterval(() => {
        if (closed) return;
        const silentFor = Date.now() - lastOutputAt;
        if (silentFor < noOutputTimeoutMs) return;
        writeEvent(res, { type: 'error', message: `no output for ${silentFor}ms` });
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill errors.
        }
      }, Math.max(1000, Math.min(noOutputTimeoutMs, 5000)))
    : null;

  const timeout = timeoutMs > 0
    ? setTimeout(() => {
        if (closed) return;
        writeEvent(res, { type: 'error', message: `timeout after ${timeoutMs}ms` });
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore kill errors.
        }
      }, timeoutMs)
    : null;

  pumpLines(child.stdout, (line) => {
    lastOutputAt = Date.now();
    writeEvent(res, { type: 'stdout', line });
  });
  pumpLines(child.stderr, (line) => {
    lastOutputAt = Date.now();
    writeEvent(res, { type: 'stderr', line });
  });

  child.on('error', (error) => {
    if (watchdog) clearInterval(watchdog);
    if (timeout) clearTimeout(timeout);
    writeEvent(res, { type: 'error', message: String(error?.message || error) });
    closeNow(1, 'spawn_error');
  });

  child.on('close', (code) => {
    if (watchdog) clearInterval(watchdog);
    if (timeout) clearTimeout(timeout);
    closeNow(Number.isFinite(Number(code)) ? Number(code) : 1, '');
  });

  req.on('close', () => {
    if (closed) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignore kill errors.
    }
  });
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.url || '').split('?')[0];

  if (method === 'GET' && path === '/health') {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (method === 'POST' && path === '/v1/probe') {
    await runProbe(req, res);
    return;
  }
  if (method === 'POST' && path === '/v1/run-stream') {
    await runStream(req, res);
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
});

server.listen(port, bind, () => {
  // eslint-disable-next-line no-console
  console.log(`goose-bridge listening on http://${bind}:${port}`);
});
