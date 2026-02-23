#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const bind = String(process.env.GOOSE_BRIDGE_BIND || '0.0.0.0').trim();
const port = Number.parseInt(String(process.env.GOOSE_BRIDGE_PORT || '8788'), 10) || 8788;
const token = String(process.env.GOOSE_BRIDGE_TOKEN || '').trim();
const maxBodyBytes = Number.parseInt(String(process.env.GOOSE_BRIDGE_MAX_BODY_BYTES || '1048576'), 10) || 1048576;
const maxConcurrentRuns = Number.parseInt(String(process.env.GOOSE_BRIDGE_MAX_CONCURRENT_RUNS || '2'), 10) || 2;
const probeTimeoutMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_PROBE_TIMEOUT_MS || '10000'), 10) || 10000;
const runGraceKillMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_GRACE_KILL_MS || '5000'), 10) || 5000;
const runHeartbeatMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_HEARTBEAT_MS || '15000'), 10) || 15000;
const maxRunTimeoutMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_MAX_RUN_TIMEOUT_MS || '3600000'), 10) || 3600000;
const maxNoOutputTimeoutMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_MAX_NO_OUTPUT_TIMEOUT_MS || '900000'), 10) || 900000;

const activeChildren = new Set();
const startedAt = Date.now();
let shuttingDown = false;

function nowIso() {
  return new Date().toISOString();
}

function requestId() {
  return crypto.randomBytes(6).toString('hex');
}

function safeInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function writeJson(res, code, payload, rid = '') {
  if (res.writableEnded) return;
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (rid) headers['x-request-id'] = rid;
  res.writeHead(code, headers);
  res.end(JSON.stringify(payload));
}

function writeEvent(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(payload)}\n`);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) throw new Error('payload_too_large');
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkAuth(req, res, rid) {
  if (!token) return true;
  const actual = String(req.headers['x-goose-bridge-token'] || '').trim();
  if (safeEqual(actual, token)) return true;
  writeJson(res, 401, { error: 'unauthorized', requestId: rid }, rid);
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

function sanitizeEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  const allowPrefixes = ['GOOSE_', 'OPENAI_', 'ANTHROPIC_', 'GEMINI_', 'GITHUB_', 'CODEX_', 'XDG_', 'LANG', 'LC_'];
  const allowExact = new Set(['HOME', 'PATH']);
  for (const [key, value] of Object.entries(env)) {
    const k = String(key || '').trim();
    if (!k) continue;
    const allowed = allowExact.has(k) || allowPrefixes.some((prefix) => k.startsWith(prefix));
    if (!allowed) continue;
    if (value === undefined || value === null) continue;
    out[k] = String(value);
  }
  return out;
}

function ensureValidCwd(cwd) {
  const value = String(cwd || '').trim() || process.cwd();
  const resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('cwd_not_directory');
  return resolved;
}

function terminateChild(child, reasonLine = '') {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // Ignore signal errors.
  }
  setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore signal errors.
      }
    }
  }, runGraceKillMs);
  if (reasonLine) {
    // eslint-disable-next-line no-console
    console.error(`[${nowIso()}] bridge terminate: ${reasonLine}`);
  }
}

async function runProbe(req, res, rid) {
  if (!checkAuth(req, res, rid)) return;
  let done = false;
  const child = spawn('goose', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  activeChildren.add(child);
  let out = '';
  let err = '';
  const timeout = setTimeout(() => {
    if (done) return;
    terminateChild(child, `probe timeout ${probeTimeoutMs}ms rid=${rid}`);
  }, probeTimeoutMs);

  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    err += chunk.toString();
  });
  child.on('error', (error) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    activeChildren.delete(child);
    writeJson(res, 500, { ok: false, reason: String(error?.message || error), requestId: rid }, rid);
  });
  child.on('close', (code) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    activeChildren.delete(child);
    if (code === 0) writeJson(res, 200, { ok: true, version: out.trim(), requestId: rid }, rid);
    else writeJson(res, 500, { ok: false, reason: (err || out || '').trim() || `exit_${code}`, requestId: rid }, rid);
  });
}

async function runStream(req, res, rid) {
  if (!checkAuth(req, res, rid)) return;
  if (activeChildren.size >= maxConcurrentRuns) {
    res.setHeader('retry-after', '2');
    writeJson(res, 429, { error: 'bridge_busy', requestId: rid, activeRuns: activeChildren.size }, rid);
    return;
  }

  let body = {};
  try {
    body = await readJson(req);
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('payload_too_large')) {
      writeJson(res, 413, { error: 'payload_too_large', requestId: rid, maxBodyBytes }, rid);
      return;
    }
    writeJson(res, 400, { error: 'invalid_json', requestId: rid }, rid);
    return;
  }

  const args = Array.isArray(body?.args) ? body.args.map((v) => String(v)) : null;
  if (!args || !args.length) {
    writeJson(res, 400, { error: 'args_required', requestId: rid }, rid);
    return;
  }
  if (args[0] !== 'run') {
    writeJson(res, 400, { error: 'unsupported_command', requestId: rid }, rid);
    return;
  }

  let cwd = process.cwd();
  try {
    cwd = ensureValidCwd(body?.cwd || process.cwd());
  } catch {
    writeJson(res, 400, { error: 'invalid_cwd', requestId: rid }, rid);
    return;
  }

  const extraEnv = sanitizeEnv(body?.env);
  const timeoutMs = safeInt(body?.timeoutMs, 300000, 1000, maxRunTimeoutMs);
  const noOutputTimeoutMs = safeInt(body?.noOutputTimeoutMs, 120000, 1000, maxNoOutputTimeoutMs);

  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-request-id': rid
  });

  const child = spawn('goose', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ...extraEnv }
  });
  activeChildren.add(child);

  const runStartedAt = Date.now();
  let lastOutputAt = runStartedAt;
  let closed = false;
  let forceKillTimer = null;

  const closeNow = (code, reason = '') => {
    if (closed) return;
    closed = true;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    writeEvent(res, { type: 'close', code, reason, durationMs: Date.now() - runStartedAt, requestId: rid });
    res.end();
  };

  const stopWithReason = (message) => {
    writeEvent(res, { type: 'error', message, requestId: rid });
    terminateChild(child, `${message} rid=${rid}`);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    forceKillTimer = setTimeout(() => {
      if (closed) return;
      terminateChild(child, `forced kill rid=${rid}`);
    }, runGraceKillMs);
  };

  const watchdog = setInterval(() => {
    if (closed) return;
    const silentFor = Date.now() - lastOutputAt;
    if (silentFor >= noOutputTimeoutMs) {
      stopWithReason(`no output for ${silentFor}ms`);
    }
  }, Math.max(1000, Math.min(noOutputTimeoutMs, 5000)));

  const heartbeat = setInterval(() => {
    if (closed) return;
    writeEvent(res, { type: 'heartbeat', ts: nowIso(), requestId: rid });
  }, Math.max(1000, runHeartbeatMs));

  const timeout = setTimeout(() => {
    if (closed) return;
    stopWithReason(`timeout after ${timeoutMs}ms`);
  }, timeoutMs);

  pumpLines(child.stdout, (line) => {
    lastOutputAt = Date.now();
    writeEvent(res, { type: 'stdout', line, requestId: rid });
  });
  pumpLines(child.stderr, (line) => {
    lastOutputAt = Date.now();
    writeEvent(res, { type: 'stderr', line, requestId: rid });
  });

  child.on('error', (error) => {
    clearInterval(watchdog);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    activeChildren.delete(child);
    writeEvent(res, { type: 'error', message: String(error?.message || error), requestId: rid });
    closeNow(1, 'spawn_error');
  });

  child.on('close', (code) => {
    clearInterval(watchdog);
    clearInterval(heartbeat);
    clearTimeout(timeout);
    activeChildren.delete(child);
    closeNow(Number.isFinite(Number(code)) ? Number(code) : 1, '');
  });

  const onClientDisconnect = () => {
    if (closed) return;
    stopWithReason('client_disconnected');
  };
  req.on('aborted', onClientDisconnect);
  req.on('close', onClientDisconnect);
}

const server = http.createServer(async (req, res) => {
  const rid = requestId();
  res.setHeader('x-request-id', rid);

  if (shuttingDown) {
    writeJson(res, 503, { error: 'bridge_shutting_down', requestId: rid }, rid);
    return;
  }

  const method = String(req.method || 'GET').toUpperCase();
  const path = String(req.url || '').split('?')[0];

  try {
    if (method === 'GET' && path === '/health') {
      writeJson(
        res,
        200,
        {
          ok: true,
          requestId: rid,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          activeRuns: activeChildren.size,
          maxConcurrentRuns
        },
        rid
      );
      return;
    }
    if (method === 'POST' && path === '/v1/probe') {
      await runProbe(req, res, rid);
      return;
    }
    if (method === 'POST' && path === '/v1/run-stream') {
      await runStream(req, res, rid);
      return;
    }
    writeJson(res, 404, { error: 'not_found', requestId: rid }, rid);
  } catch (error) {
    writeJson(res, 500, { error: 'bridge_internal_error', reason: String(error?.message || error), requestId: rid }, rid);
  }
});

server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

server.listen(port, bind, () => {
  // eslint-disable-next-line no-console
  console.log(`[${nowIso()}] goose-bridge listening on http://${bind}:${port}`);
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-console
  console.log(`[${nowIso()}] bridge shutdown signal=${signal}; activeRuns=${activeChildren.size}`);
  for (const child of activeChildren) terminateChild(child, `shutdown ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 12000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  // eslint-disable-next-line no-console
  console.error(`[${nowIso()}] uncaughtException`, error);
});
process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error(`[${nowIso()}] unhandledRejection`, reason);
});
