import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  acquireTaskExecutionLease,
  appendTaskLog,
  heartbeatTaskExecutionLease,
  releaseTaskExecutionLease,
  updateTask
} from './db.js';
import { runMockGoose } from './mockGoose.js';
import { autoCreatePullRequest, autoMergeTaskBranchToTest, ensureProjectRepoReady, ensureTaskBranch } from './repoManager.js';

const activeRuns = new Map();
let shutdownHookInstalled = false;
const orchestrationCircuit = {
  consecutiveFailures: 0,
  openUntil: 0
};

const BOSS_NAME = 'Rajiv Gupta';
const CODING_AGENT_NAMES = ['Manish Malik', 'Sanjeev Lamba', 'Rajiv Jamwal'];
const QUALITY_PILOT_NAMES = ['Navdeep', 'Manish Srivastva'];
const THINKING_MESSAGES = [
  'thinking through edge cases...',
  'reviewing context and constraints...',
  'planning next best step...',
  'checking assumptions before responding...',
  'mapping files and dependencies...',
  'comparing options for safer changes...',
  'drafting the next change...'
];

function emitLine(broadcast, taskId, line) {
  const normalized = String(line || '')
    .replace(/^goose>/i, `${BOSS_NAME} (Boss)>`)
    .replace(/^repo>/i, `${BOSS_NAME} (Boss)>`)
    .replace(/^git>/i, `${BOSS_NAME} (Boss)>`)
    .replace(/^refiner>/i, `${BOSS_NAME} (Boss)>`)
    .replace(/^validate(?:\([^)]+\))?>/i, `${BOSS_NAME} (Boss)>`);
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${normalized}`;
  appendTaskLog(taskId, entry);
  broadcast({ type: 'task_log', taskId, line: entry });
}

function buildAgentNames(task, subagentCount = 0) {
  const primary = `${BOSS_NAME} (Boss)`;
  const coordinator = `${BOSS_NAME} (Boss)`;
  const qualityTask = /(test|qa|spec|assert|ci|verification|quality)/i.test(`${task?.title || ''} ${task?.description || ''}`);
  const pool = qualityTask ? QUALITY_PILOT_NAMES : CODING_AGENT_NAMES;
  const subagents = Array.from({ length: subagentCount }, (_, idx) => {
    return pool[idx % pool.length];
  });
  return { primary, coordinator, subagents };
}

function randomThinkingMessage() {
  return THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)];
}

function startThinkingTicker({ broadcast, taskId, agentName, intervalMs = 700 }) {
  let last = '';
  const emitThinking = () => {
    let next = randomThinkingMessage();
    if (THINKING_MESSAGES.length > 1) {
      while (next === last) next = randomThinkingMessage();
    }
    last = next;
    emitLine(broadcast, taskId, `${agentName}> ${next}`);
  };
  emitThinking();
  return setInterval(emitThinking, intervalMs);
}

function emitConversation({ broadcast, taskId, from, to, text }) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''));
  for (const line of lines) {
    if (!line) continue;
    emitLine(broadcast, taskId, `${from} -> ${to}: ${line}`);
  }
}

function pumpStream(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach((line) => onLine(line));
  });
  stream.on('end', () => {
    if (buffer) onLine(buffer);
  });
}

function parseJsonLine(line) {
  const raw = String(line || '').trim();
  const trimmed = raw.startsWith('data:') ? raw.slice(5).trim() : raw;
  if (trimmed === '[DONE]') return null;
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function getEventKind(payload) {
  const event = payload && typeof payload === 'object' ? payload : {};
  return String(event.event || event.type || event.kind || '').trim().toLowerCase();
}

function joinTextParts(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => joinTextParts(item)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.message === 'string') return value.message;
    if (typeof value.delta === 'string') return value.delta;
    if (Array.isArray(value.content)) return joinTextParts(value.content);
  }
  return '';
}

function collectTextLinesDeep(value, depth = 0, lines = []) {
  if (!value || depth > 6) return lines;
  if (typeof value === 'string') {
    const v = value.trim();
    if (v) lines.push(v);
    return lines;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextLinesDeep(item, depth + 1, lines);
    return lines;
  }
  if (typeof value === 'object') {
    const obj = value;
    const preferredKeys = ['text', 'content', 'message', 'delta', 'output', 'response', 'value'];
    for (const key of preferredKeys) {
      if (!(key in obj)) continue;
      collectTextLinesDeep(obj[key], depth + 1, lines);
    }
    for (const [key, entry] of Object.entries(obj)) {
      if (preferredKeys.includes(key)) continue;
      if (key === 'type' || key === 'role' || key === 'id') continue;
      collectTextLinesDeep(entry, depth + 1, lines);
    }
  }
  return lines;
}

function extractAssistantReplyLines(payload) {
  const event = payload && typeof payload === 'object' ? payload : {};
  const kind = getEventKind(event);
  const looksLikeAssistantEvent =
    !kind ||
    kind.includes('assistant') ||
    kind.includes('message') ||
    kind.includes('response') ||
    kind.includes('completion') ||
    kind.includes('output');

  const choicesText = Array.isArray(event.choices)
    ? event.choices
        .map((choice) => joinTextParts(choice))
        .filter(Boolean)
        .join('\n')
    : '';
  const candidate =
    joinTextParts(event.data) ||
    joinTextParts(event.message) ||
    joinTextParts(event.output) ||
    joinTextParts(event.response) ||
    joinTextParts(event.content) ||
    joinTextParts(event.text) ||
    choicesText;
  const compact = String(candidate || '');
  if (!compact.trim()) {
    const deepLines = Array.from(new Set(collectTextLinesDeep(event).filter(Boolean)))
      .map((line) => String(line || '').replace(/\r/g, '').trim())
      .filter((line) => line.length > 1)
      .filter((line) => !/^(assistant|user|system|tool|message|response|output)$/i.test(line))
      .slice(0, looksLikeAssistantEvent ? 80 : 24);
    if (!deepLines.length) return [];
    return deepLines;
  }
  return compact
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0);
}

function formatGooseStreamEvent(payload) {
  const event = payload && typeof payload === 'object' ? payload : {};
  const kind = getEventKind(event);
  const text = joinTextParts(event.data) || joinTextParts(event.message) || joinTextParts(event.output) || joinTextParts(event);
  const compactText = String(text || '').trim();

  if (kind.includes('error')) {
    return {
      logLines: [`event:error ${compactText || JSON.stringify(event)}`],
      approvalText: compactText ? [compactText] : []
    };
  }

  if (kind.includes('tool')) {
    const toolName = String(event.tool || event.tool_name || event.name || '').trim();
    const suffix = compactText ? ` ${compactText}` : '';
    const label = toolName ? `${toolName}${suffix}` : compactText;
    if (!label) return { logLines: [], approvalText: [] };
    return {
      logLines: [`event:${kind} ${label}`],
      approvalText: []
    };
  }

  if (compactText) {
    return {
      logLines: compactText.split('\n').map((line) => line.trim()).filter(Boolean),
      approvalText: compactText.split('\n').map((line) => line.trim()).filter(Boolean)
    };
  }

  if (kind) {
    return {
      logLines: [`event:${kind}`],
      approvalText: []
    };
  }

  return { logLines: [], approvalText: [] };
}

function buildGooseEnv() {
  const env = { ...process.env };
  const processHome = process.env.HOME || '';
  const userConfigRoot = processHome ? path.join(processHome, '.config') : '';
  const hasProviderConfig = (configRoot) => {
    if (!configRoot) return false;
    try {
      const gooseConfigPath = path.join(configRoot, 'goose', 'config.yaml');
      const raw = fs.readFileSync(gooseConfigPath, 'utf8');
      return /(^|\n)\s*GOOSE_PROVIDER:\s*\S+/m.test(raw);
    } catch {
      return false;
    }
  };
  const fallbackHome = path.resolve(process.cwd(), '.goose-home');
  const home = process.env.GOOSE_HOME || fallbackHome;
  const cache = process.env.GOOSE_CACHE || process.env.XDG_CACHE_HOME || path.join(home, '.cache');
  let config = process.env.GOOSE_CONFIG || process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const data = process.env.GOOSE_DATA || process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const state = process.env.GOOSE_STATE || process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  const preserveHome = toBoolEnv(process.env.GOOSE_PRESERVE_HOME, true);
  // If isolated workspace config has no provider, fall back to device-level Goose config.
  if (!process.env.GOOSE_CONFIG && !process.env.XDG_CONFIG_HOME) {
    const localHasProvider = hasProviderConfig(config);
    const userHasProvider = hasProviderConfig(userConfigRoot);
    if (!localHasProvider && userHasProvider) {
      config = userConfigRoot;
    }
  }
  for (const dir of [home, cache, config, data, state]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore directory creation errors and let goose report precise path errors.
    }
  }
  // Keep device-level HOME by default so provider CLIs (for example codex) can reuse existing auth/session state.
  if (!preserveHome && home) env.HOME = home;
  if (cache) env.XDG_CACHE_HOME = cache;
  if (config) env.XDG_CONFIG_HOME = config;
  if (data) env.XDG_DATA_HOME = data;
  if (state) env.XDG_STATE_HOME = state;
  // Goose codex provider defaults to "high" reasoning effort, which can add long first-token latency.
  // Force a safer default unless explicitly overridden.
  if (!env.CODEX_REASONING_EFFORT) {
    env.CODEX_REASONING_EFFORT = 'medium';
  }
  return env;
}

function mergePluginEnv(baseEnv, plugins) {
  const next = { ...baseEnv };
  for (const plugin of plugins) {
    const cfg = plugin?.config && typeof plugin.config === 'object' ? plugin.config : {};
    if (cfg.openaiApiKey) next.OPENAI_API_KEY = String(cfg.openaiApiKey);
    if (cfg.githubToken) next.GITHUB_PERSONAL_ACCESS_TOKEN = String(cfg.githubToken);
    if (cfg.anthropicApiKey) next.ANTHROPIC_API_KEY = String(cfg.anthropicApiKey);
    if (cfg.geminiApiKey) next.GEMINI_API_KEY = String(cfg.geminiApiKey);
    if (cfg.env && typeof cfg.env === 'object') {
      for (const [key, value] of Object.entries(cfg.env)) {
        if (value !== undefined && value !== null) next[String(key)] = String(value);
      }
    }
  }
  return next;
}

function resolveForcedBuiltins() {
  const raw = String(process.env.GOOSE_FORCE_BUILTINS || 'developer').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAgentPlugin(plugins) {
  const plugin = plugins.find((item) => item.type === 'agent');
  if (!plugin?.url) return {};
  const cfg = plugin.config && typeof plugin.config === 'object' ? plugin.config : {};
  const [provider, model] = String(plugin.url).split(':');
  return {
    provider: provider || undefined,
    model: model || undefined,
    useDeviceConfig: cfg.useDeviceConfig !== false
  };
}

function installShutdownHook() {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;

  const cleanup = () => {
    for (const run of activeRuns.values()) {
      const child = run?.child;
      if (!child || child.killed) continue;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore cleanup errors during shutdown.
      }
    }
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
}

function buildExtensionArgs(plugins) {
  const args = [];
  const seen = new Set();
  const builtins = [];

  for (const plugin of plugins) {
    const type = String(plugin.type || '').toLowerCase();
    const value = String(plugin.url || '').trim();
    const cfg = plugin.config && typeof plugin.config === 'object' ? plugin.config : {};
    if (!value) continue;

    if (type === 'mcp' || type === 'mcp_stdio') {
      const isEverythingServer = value.includes('mcp-server-everything');
      if (isEverythingServer && process.env.GOOSE_ENABLE_EVERYTHING !== '1') continue;
      const isGithubServer = value.includes('mcp-server-github');
      const hasGithubToken = Boolean(
        cfg.githubToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GITHUB_TOKEN
      );
      if (isGithubServer && !hasGithubToken) continue;
      if (seen.has(`ext:${value}`)) continue;
      seen.add(`ext:${value}`);
      args.push('--with-extension', value);
      continue;
    }

    if (type === 'mcp_http') {
      if (seen.has(`http:${value}`)) continue;
      seen.add(`http:${value}`);
      args.push('--with-streamable-http-extension', value);
      continue;
    }

    if (type === 'builtin') {
      builtins.push(value);
    }
  }

  if (builtins.length) args.push('--with-builtin', builtins.join(','));
  return args;
}

function injectGitHubAuthForGit(env, token) {
  if (!token) return env;
  const next = { ...env };
  const idx = Number(next.GIT_CONFIG_COUNT || 0);
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  next.GIT_CONFIG_COUNT = String(idx + 1);
  next[`GIT_CONFIG_KEY_${idx}`] = 'http.https://github.com/.extraheader';
  next[`GIT_CONFIG_VALUE_${idx}`] = `AUTHORIZATION: basic ${basic}`;
  return next;
}

function needsApprovalFromOutput(lines) {
  if (!lines.length) return false;
  const text = lines.join('\n').toLowerCase();
  const asksQuestion = /\?\s*$/.test(text.trim()) || text.includes('do you want me to') || text.includes('how do you want');
  const asksClarification =
    text.includes('which option') ||
    text.includes('another repo or directory') ||
    text.includes('contains the existing app') ||
    text.includes('need auth to continue') ||
    text.includes('provide credentials');
  const completionSignals =
    text.includes('created `') ||
    text.includes('committed') ||
    text.includes('pushed branch') ||
    text.includes('opened pr') ||
    text.includes('merged');
  return (asksQuestion || asksClarification) && !completionSignals;
}

function normalizeTaskKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function newRunId(taskId) {
  return `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function computeBackoffMs(attempt, baseMs = 800, maxMs = 8000) {
  const n = Math.max(1, Number(attempt) || 1);
  const exp = Math.min(maxMs, baseMs * 2 ** (n - 1));
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exp * 0.25)));
  return exp + jitter;
}

function markOrchestrationSuccess() {
  orchestrationCircuit.consecutiveFailures = 0;
  orchestrationCircuit.openUntil = 0;
}

function markOrchestrationFailure() {
  const threshold = parsePositiveInt(process.env.GOOSE_ORCHESTRATION_CB_THRESHOLD, 3);
  const cooldownMs = parsePositiveInt(process.env.GOOSE_ORCHESTRATION_CB_COOLDOWN_MS, 300000);
  orchestrationCircuit.consecutiveFailures += 1;
  if (orchestrationCircuit.consecutiveFailures >= threshold) {
    orchestrationCircuit.openUntil = Date.now() + cooldownMs;
  }
}

function isOrchestrationCircuitOpen() {
  return Date.now() < Number(orchestrationCircuit.openUntil || 0);
}

function summarizePrError(error) {
  const message = String(error?.message || error || '').trim();
  if (!message) return 'unknown';
  if (
    /No commits between/i.test(message) ||
    /Head ref must be a branch/i.test(message) ||
    /Head sha can't be blank/i.test(message) ||
    /Base sha can't be blank/i.test(message)
  ) {
    return 'missing remote refs or no commits between base and head';
  }
  if (/authentication|permission|forbidden|unauthorized|token/i.test(message)) {
    return 'github auth/permission issue';
  }
  return message.split('\n').slice(-1)[0].slice(0, 240);
}

function toBoolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function shouldAllowMockFallback() {
  return toBoolEnv(process.env.GOOSE_ALLOW_MOCK_FALLBACK, false);
}

function isRunningInContainer() {
  if (toBoolEnv(process.env.GOOSE_FORCE_DOCKER_MODE, false)) return true;
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    if (/(docker|containerd|kubepods|podman)/i.test(cgroup)) return true;
  } catch {
    // Ignore cgroup read failures and treat as non-container runtime.
  }
  return false;
}

function resolveGooseBridgeConfig() {
  const singleUrl = String(process.env.GOOSE_BRIDGE_URL || '').trim().replace(/\/+$/, '');
  const listRaw = String(process.env.GOOSE_BRIDGE_URLS || '').trim();
  const runningInContainer = isRunningInContainer();
  const forceLocalInContainer = toBoolEnv(process.env.GOOSE_LOCAL_IN_CONTAINER, false);
  const urls = []
    .concat(listRaw ? listRaw.split(',').map((item) => String(item || '').trim()) : [])
    .concat(singleUrl ? [singleUrl] : [])
    .concat(
      runningInContainer && !forceLocalInContainer
        ? ['http://host.docker.internal:8788', 'http://172.17.0.1:8788', 'http://gateway.docker.internal:8788']
        : []
    )
    .map((item) => item.replace(/\/+$/, ''))
    .filter(Boolean)
    .filter((item, idx, arr) => arr.indexOf(item) === idx);
  const token = String(process.env.GOOSE_BRIDGE_TOKEN || '').trim();
  const mapRaw = String(process.env.GOOSE_BRIDGE_CWD_MAP || '').trim();
  const maps = mapRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx <= 0) return null;
      const from = entry.slice(0, idx).trim();
      const to = entry.slice(idx + 1).trim();
      if (!from || !to) return null;
      return { from, to };
    })
    .filter(Boolean);
  return { enabled: urls.length > 0, url: urls[0] || '', urls, token, maps };
}

function mapCwdForGooseBridge(cwd, bridgeConfig) {
  const input = String(cwd || '').trim();
  if (!input) return input;
  const mappings = Array.isArray(bridgeConfig?.maps) ? bridgeConfig.maps : [];
  for (const item of mappings) {
    if (input === item.from) return item.to;
    if (input.startsWith(`${item.from}/`)) return `${item.to}${input.slice(item.from.length)}`;
  }
  return input;
}

async function probeGooseBridge(bridgeConfig) {
  const maxAttempts = parsePositiveInt(process.env.GOOSE_BRIDGE_PROBE_RETRIES, 3);
  const fetchTimeoutMs = parsePositiveInt(process.env.GOOSE_BRIDGE_FETCH_TIMEOUT_MS, 12000);
  const retryBaseMs = parsePositiveInt(process.env.GOOSE_BRIDGE_RETRY_BASE_MS, 400);
  const urls = Array.isArray(bridgeConfig?.urls) && bridgeConfig.urls.length ? bridgeConfig.urls : [bridgeConfig.url];
  const headers = { 'content-type': 'application/json' };
  if (bridgeConfig.token) headers['x-goose-bridge-token'] = bridgeConfig.token;
  let lastReason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(`${url}/v1/probe`, {
          method: 'POST',
          headers,
          body: JSON.stringify({}),
          signal: controller.signal
        });
        clearTimeout(timer);
        // eslint-disable-next-line no-await-in-loop
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
          bridgeConfig.url = url;
          return { ok: Boolean(payload?.ok), reason: String(payload?.reason || payload?.version || ''), url };
        }
        lastReason = `${url}: ${String(payload?.error || payload?.reason || `http_${response.status}`)}`;
      } catch (error) {
        clearTimeout(timer);
        const message = String(error?.name === 'AbortError' ? `bridge probe timeout ${fetchTimeoutMs}ms` : error?.message || error);
        lastReason = `${url}: ${message}`;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(computeBackoffMs(attempt, retryBaseMs, 2500));
  }
  return { ok: false, reason: lastReason || `bridge probe failed for urls=${urls.join(',')}` };
}

async function runGooseThroughBridge({
  bridgeConfig,
  args,
  cwd,
  env,
  timeoutMs,
  noOutputTimeoutMs,
  onStdoutLine,
  onStderrLine
}) {
  const connectAttempts = parsePositiveInt(process.env.GOOSE_BRIDGE_CONNECT_RETRIES, 2);
  const fetchTimeoutMs = parsePositiveInt(process.env.GOOSE_BRIDGE_FETCH_TIMEOUT_MS, 12000);
  const retryBaseMs = parsePositiveInt(process.env.GOOSE_BRIDGE_RETRY_BASE_MS, 400);
  const urls = Array.isArray(bridgeConfig?.urls) && bridgeConfig.urls.length ? bridgeConfig.urls : [bridgeConfig.url];
  const headers = { 'content-type': 'application/json' };
  if (bridgeConfig.token) headers['x-goose-bridge-token'] = bridgeConfig.token;
  let response = null;
  let openReason = '';
  for (let attempt = 1; attempt <= connectAttempts; attempt += 1) {
    for (const url of urls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await fetch(`${url}/v1/run-stream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            args,
            cwd,
            env,
            timeoutMs,
            noOutputTimeoutMs
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (response.ok) {
          bridgeConfig.url = url;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        const text = await response.text().catch(() => '');
        openReason = `${url}: ${text || `http_${response.status}`}`;
      } catch (error) {
        clearTimeout(timer);
        openReason = `${url}: ${String(error?.name === 'AbortError' ? `bridge connect timeout ${fetchTimeoutMs}ms` : error?.message || error)}`;
      }
    }
    if (response?.ok) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(computeBackoffMs(attempt, retryBaseMs, 2500));
  }
  if (!response || !response.ok) return { code: 1, reason: openReason || 'bridge connect failed' };
  if (!response.body) return { code: 1, reason: 'empty response body from bridge' };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let closeCode = 1;
  let reason = '';

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const raw = String(line || '').trim();
      if (!raw) continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      const type = String(event?.type || '').trim().toLowerCase();
      if (type === 'stdout') {
        if (typeof event.line === 'string') onStdoutLine(event.line);
      } else if (type === 'stderr') {
        if (typeof event.line === 'string') onStderrLine(event.line);
      } else if (type === 'info') {
        if (typeof event.message === 'string') onStderrLine(`[bridge] ${event.message}`);
      } else if (type === 'heartbeat') {
        // Keepalive from bridge; no-op.
      } else if (type === 'close') {
        closeCode = Number.isFinite(Number(event.code)) ? Number(event.code) : closeCode;
        reason = String(event.reason || reason || '').trim();
      } else if (type === 'error') {
        reason = String(event.message || reason || '').trim();
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const event = JSON.parse(tail);
      if (String(event?.type || '').trim().toLowerCase() === 'close') {
        closeCode = Number.isFinite(Number(event.code)) ? Number(event.code) : closeCode;
        reason = String(event.reason || reason || '').trim();
      }
    } catch {
      // Ignore tail parse failure.
    }
  }

  if (!reason && closeCode !== 0) {
    reason = 'bridge stream ended without explicit close reason';
  }
  return { code: closeCode, reason };
}

function withSmartCodeExecutionPrompt(prompt, mode = 'default') {
  const base = String(prompt || '').trim();
  if (!base) return base;
  if (!toBoolEnv(process.env.GOOSE_SMART_CODE_EXECUTION, true)) return base;
  if (base.includes('SMART CODE-EXECUTION MODE:')) return base;
  const compactMode = mode === 'subagent' || mode === 'manager';
  const policy = [
    '',
    'SMART CODE-EXECUTION MODE:',
    '- Use tools only when they reduce uncertainty or are required to apply/verify changes.',
    '- Prefer targeted commands over broad scans; avoid repeating equivalent commands.',
    '- Read only relevant snippets (use file+line targeting) instead of full-file dumps when possible.',
    '- Batch related edits, then run the smallest meaningful validation command.',
    '- Keep tool output concise: summarize findings in 1-2 lines and continue execution.',
    compactMode
      ? '- Do not ask for user input; make the safest assumption and proceed.'
      : '- If blocked by missing info, state exactly what is missing and continue with best-effort progress.',
    '- End with changed files + short verification summary.'
  ].join('\n');
  return `${base}\n${policy}\n`;
}

function compactExecutionPrompt(prompt, mode = 'default') {
  const maxChars = parsePositiveInt(process.env.GOOSE_EXECUTION_PROMPT_MAX_CHARS, 1800);
  const maxLineChars = parsePositiveInt(process.env.GOOSE_EXECUTION_PROMPT_MAX_LINE_CHARS, 180);
  const rawLines = String(prompt || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((line) => (line.length > maxLineChars ? `${line.slice(0, maxLineChars)}...` : line));
  if (!rawLines.length) return '';
  const seen = new Set();
  const lines = [];
  for (const line of rawLines) {
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const lowPriority = [/^APIS:/i, /^MCPS:/i, /^DOCS:/i, /^REPO_PATH:/i, /^ACTION_FUNCTIONS:/i, /^ACTION_LINES:/i];
  const compacted = [...lines];
  const asText = () => compacted.join('\n').slice(0, maxChars);
  while (asText().length > maxChars) {
    const dropIndex = compacted.findIndex((line) => lowPriority.some((re) => re.test(line)));
    if (dropIndex < 0) break;
    compacted.splice(dropIndex, 1);
  }
  if (asText().length > maxChars) {
    const marker = mode === 'subagent' ? 'DONE_WHEN:' : 'SMART CODE-EXECUTION MODE:';
    const idx = compacted.findIndex((line) => line.includes(marker));
    if (idx >= 0) compacted.splice(idx + 1);
  }
  return compacted.join('\n').slice(0, maxChars);
}

function compactJson(value, maxChars = 1200) {
  try {
    const text = JSON.stringify(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...<trimmed>`;
  } catch {
    return String(value || '');
  }
}

function inferGoosePhaseFromPayload(payload) {
  const event = payload && typeof payload === 'object' ? payload : {};
  const kind = String(event.event || event.type || event.kind || '').trim().toLowerCase();
  if (!kind) return '';
  if (kind.includes('tool')) {
    const toolName = String(event.tool || event.tool_name || event.name || '').trim();
    return toolName ? `tool:${toolName}` : 'tool';
  }
  if (kind.includes('complete')) return 'complete';
  if (kind.includes('message') || kind.includes('assistant')) return 'responding';
  if (kind.includes('error')) return 'error';
  return kind;
}

function sanitizeChunkFileRef(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const hash = raw.indexOf('#L');
  const normalized = hash > 0 ? raw.slice(0, hash) : raw;
  return normalized.replace(/^\.\/+/, '');
}

function uniqueScopeFiles(values, maxFiles = 8) {
  const unique = [];
  const seen = new Set();
  for (const item of Array.isArray(values) ? values : []) {
    const file = sanitizeChunkFileRef(item);
    if (!file) continue;
    if (file.toLowerCase().endsWith('.md')) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    unique.push(file);
    if (unique.length >= maxFiles) break;
  }
  return unique;
}

function deriveScopePlan(task, maxFiles = 8, maxCreateFiles = 3) {
  const actions = task?.context?.codeIntel?.actions || {};
  const fromActionEdits = uniqueScopeFiles(actions.filesToEdit, maxFiles);
  const fromDocs = uniqueScopeFiles(task?.context?.docs, maxFiles);
  const filesToEdit = fromActionEdits.length ? fromActionEdits : fromDocs;
  const filesToCreate = uniqueScopeFiles(actions.filesToCreate, maxCreateFiles);
  return {
    filesToEdit,
    filesToCreate
  };
}

function ensureTrailingSlash(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!normalized) return '';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function deriveCreatePrefixes(files = [], createFiles = []) {
  const prefixes = new Set();
  for (const file of files) {
    const dir = path.posix.dirname(String(file || '').replace(/\\/g, '/'));
    if (dir && dir !== '.' && dir !== '/') prefixes.add(ensureTrailingSlash(dir));
  }
  for (const file of createFiles) {
    const normalized = sanitizeChunkFileRef(file);
    if (!normalized) continue;
    const dir = path.posix.dirname(normalized);
    if (dir && dir !== '.' && dir !== '/') prefixes.add(ensureTrailingSlash(dir));
  }
  return Array.from(prefixes).filter(Boolean).sort();
}

function buildWorkerScope(filesChunk = [], allCreateFiles = []) {
  const allowedExactFiles = uniqueScopeFiles(filesChunk, Number.MAX_SAFE_INTEGER);
  const chunkDirs = new Set(
    allowedExactFiles
      .map((file) => path.posix.dirname(file))
      .map((dir) => ensureTrailingSlash(dir))
      .filter(Boolean)
  );
  const relevantCreateFiles = uniqueScopeFiles(
    allCreateFiles.filter((createFile) => {
      const normalized = sanitizeChunkFileRef(createFile);
      if (!normalized) return false;
      const normalizedDir = ensureTrailingSlash(path.posix.dirname(normalized));
      if (!normalizedDir) return false;
      return chunkDirs.size ? chunkDirs.has(normalizedDir) : true;
    }),
    Number.MAX_SAFE_INTEGER
  );
  return {
    focusFiles: allowedExactFiles,
    allowedExactFiles,
    allowedCreatePrefixes: deriveCreatePrefixes(allowedExactFiles, relevantCreateFiles),
    filesToCreate: relevantCreateFiles
  };
}

function evaluateTaskOrchestrationNeed(task, scopePlan) {
  const actions = task?.context?.codeIntel?.actions || {};
  const editCount = Array.isArray(scopePlan?.filesToEdit) ? scopePlan.filesToEdit.length : 0;
  const createCount = Array.isArray(scopePlan?.filesToCreate) ? scopePlan.filesToCreate.length : 0;
  const functionTargets = Array.isArray(actions.functionTargets) ? actions.functionTargets.length : 0;
  const lineTargets = Array.isArray(actions.lineTargets) ? actions.lineTargets.length : 0;
  const intents = actions.intents || {};
  const titleLen = String(task?.title || '').trim().length;
  const descLen = String(task?.description || '').trim().length;

  const estimateSeconds =
    16 +
    editCount * 14 +
    createCount * 24 +
    Math.min(functionTargets, 12) * 2 +
    Math.min(lineTargets, 16) * 1 +
    (intents.create ? 10 : 0) +
    (descLen >= 220 ? 8 : 0) +
    (titleLen >= 80 ? 4 : 0);

  const thresholdSeconds = parsePositiveInt(process.env.GOOSE_SUBAGENT_MIN_ESTIMATED_SECONDS, 60);
  const bigEditFiles = parsePositiveInt(process.env.GOOSE_SUBAGENT_BIG_EDIT_FILES, 4);
  const bigCreateFiles = parsePositiveInt(process.env.GOOSE_SUBAGENT_BIG_CREATE_FILES, 2);
  const bigFunctionTargets = parsePositiveInt(process.env.GOOSE_SUBAGENT_BIG_FUNCTION_TARGETS, 8);
  const bigLineTargets = parsePositiveInt(process.env.GOOSE_SUBAGENT_BIG_LINE_TARGETS, 10);
  const bigDescriptionChars = parsePositiveInt(process.env.GOOSE_SUBAGENT_BIG_DESC_CHARS, 320);

  const isBigTask =
    editCount >= bigEditFiles ||
    createCount >= bigCreateFiles ||
    functionTargets >= bigFunctionTargets ||
    lineTargets >= bigLineTargets ||
    descLen >= bigDescriptionChars;
  const requiresOrchestration = editCount >= 2 && (estimateSeconds > thresholdSeconds || isBigTask);
  return {
    requiresOrchestration,
    estimateSeconds,
    thresholdSeconds,
    isBigTask,
    metrics: {
      editCount,
      createCount,
      functionTargets,
      lineTargets,
      descLen
    }
  };
}

function splitIntoChunks(items, chunkSize) {
  const size = Math.max(1, Number(chunkSize) || 2);
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function readPackageScripts(workingDirectory) {
  try {
    const pkgPath = path.join(workingDirectory, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.scripts === 'object' ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function isDefaultNoTestScript(script) {
  const raw = String(script || '').toLowerCase();
  return raw.includes('no test specified') && raw.includes('exit 1');
}

function resolveValidationSteps(workingDirectory) {
  const explicit = String(process.env.GOOSE_REQUIRED_TEST_CMD || process.env.GOOSE_VALIDATION_CMD || '').trim();
  if (explicit) return [{ name: 'validation', cmd: explicit, stdoutLabel: 'validate', stderrLabel: 'validate' }];
  const scripts = readPackageScripts(workingDirectory);
  const steps = [];
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    steps.push({ name: 'build', cmd: 'npm run build', stdoutLabel: 'build', stderrLabel: 'build' });
  }
  if (typeof scripts.test === 'string' && scripts.test.trim() && !isDefaultNoTestScript(scripts.test)) {
    steps.push({ name: 'test', cmd: 'npm test -- --watch=false', stdoutLabel: 'test', stderrLabel: 'test' });
  }
  return steps;
}

function detectMissingNodeDependency(output) {
  const text = String(output || '');
  if (!text) return '';
  const quoted =
    text.match(/Cannot find package '([^']+)'/i)?.[1] ||
    text.match(/Cannot find module '([^']+)'/i)?.[1] ||
    text.match(/Cannot find package "([^"]+)"/i)?.[1] ||
    text.match(/Cannot find module "([^"]+)"/i)?.[1] ||
    '';
  return String(quoted || '').trim();
}

function hasPackageJson(workingDirectory) {
  try {
    return fs.existsSync(path.join(workingDirectory, 'package.json'));
  } catch {
    return false;
  }
}

function runSpawn(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function runValidationGate({ task, workingDirectory, env, broadcast }) {
  const steps = resolveValidationSteps(workingDirectory);
  if (!steps.length) {
    const requireValidation = toBoolEnv(process.env.GOOSE_REQUIRE_VALIDATION_CMD, false);
    if (!requireValidation) {
      emitLine(
        broadcast,
        task.id,
        'validate> no build/test command found; skipping validation (set GOOSE_REQUIRE_VALIDATION_CMD=1 to enforce).'
      );
      return { ok: true, cmd: '', reason: 'validation-skipped' };
    }
    emitLine(
      broadcast,
      task.id,
      'validate> no build/test command available. Set GOOSE_REQUIRED_TEST_CMD to enforce a validation command.'
    );
    return { ok: false, cmd: '', reason: 'no-validation-command' };
  }

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const runStep = async () => {
      emitLine(broadcast, task.id, `validate> [${i + 1}/${steps.length}] ${step.name}: running ${step.cmd}`);
      const res = await runSpawn('bash', ['-lc', step.cmd], { cwd: workingDirectory, env });
      for (const line of String(res.out || '').split('\n').filter(Boolean).slice(-80)) {
        emitLine(broadcast, task.id, `${step.stdoutLabel}(stdout)> ${line}`);
      }
      for (const line of String(res.err || '').split('\n').filter(Boolean).slice(-80)) {
        emitLine(broadcast, task.id, `${step.stderrLabel}(stderr)> ${line}`);
      }
      return res;
    };

    let res = await runStep();
    if (res.code !== 0) {
      const autoInstallDeps = toBoolEnv(process.env.GOOSE_AUTO_INSTALL_DEPS, true);
      const missingPkg = detectMissingNodeDependency(`${res.err}\n${res.out}`);
      const canRetryWithInstall =
        autoInstallDeps && step.name === 'build' && hasPackageJson(workingDirectory) && Boolean(missingPkg);
      if (canRetryWithInstall) {
        emitLine(
          broadcast,
          task.id,
          `validate> detected missing package '${missingPkg}'. Running npm install and retrying build once.`
        );
        const install = await runSpawn('bash', ['-lc', 'npm install --no-audit --no-fund'], { cwd: workingDirectory, env });
        for (const line of String(install.out || '').split('\n').filter(Boolean).slice(-120)) {
          emitLine(broadcast, task.id, `install(stdout)> ${line}`);
        }
        for (const line of String(install.err || '').split('\n').filter(Boolean).slice(-120)) {
          emitLine(broadcast, task.id, `install(stderr)> ${line}`);
        }
        if (install.code !== 0) {
          emitLine(broadcast, task.id, `install> failed with exit code ${install.code}`);
          emitLine(broadcast, task.id, `${step.name}> failed with exit code ${res.code}`);
          return { ok: false, cmd: step.cmd, reason: 'dependency-install-failed' };
        }
        emitLine(broadcast, task.id, 'install> passed');
        res = await runStep();
      }
      if (res.code !== 0) {
        emitLine(broadcast, task.id, `${step.name}> failed with exit code ${res.code}`);
        return { ok: false, cmd: step.cmd, reason: `${step.name}-failed` };
      }
    }
    emitLine(broadcast, task.id, `${step.name}> passed`);
  }

  emitLine(broadcast, task.id, 'validate> passed');
  return { ok: true, cmd: steps.map((step) => step.cmd).join(' && '), reason: '' };
}

async function autoCommitIfDirty({ task, workingDirectory, env, broadcast, label = 'repo', commitMessage = '' }) {
  const status = await runSpawn('git', ['-C', workingDirectory, 'status', '--porcelain'], { cwd: workingDirectory, env });
  const dirty = String(status.out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!dirty.length) {
    emitLine(broadcast, task.id, `${label}> no local changes to commit.`);
    return { ok: true, committed: false };
  }
  emitLine(broadcast, task.id, `${label}> committing ${dirty.length} file changes.`);
  const add = await runSpawn('git', ['-C', workingDirectory, 'add', '-A'], { cwd: workingDirectory, env });
  if (add.code !== 0) {
    emitLine(broadcast, task.id, `${label}> git add failed: ${String(add.err || add.out || '').trim()}`);
    return { ok: false, committed: false };
  }
  const message = commitMessage || `chore(goose): finalize task ${task.id}`;
  const commit = await runSpawn('git', ['-C', workingDirectory, 'commit', '-m', message], { cwd: workingDirectory, env });
  if (commit.code !== 0) {
    const out = String(commit.err || commit.out || '').trim();
    if (out.includes('nothing to commit')) return { ok: true, committed: false };
    emitLine(broadcast, task.id, `${label}> git commit failed: ${out}`);
    return { ok: false, committed: false };
  }
  emitLine(broadcast, task.id, `${label}> committed changes.`);
  return { ok: true, committed: true };
}

function parseGooseOutputLines(rawOutput) {
  const outputLines = [];
  for (const raw of String(rawOutput || '').split('\n').filter(Boolean)) {
    const parsed = parseJsonLine(raw);
    if (!parsed) {
      outputLines.push(raw);
      continue;
    }
    const event = formatGooseStreamEvent(parsed);
    outputLines.push(...event.approvalText);
  }
  return outputLines;
}

function parseGooseAssistantLines(rawOutput) {
  const lines = [];
  for (const raw of String(rawOutput || '').split('\n').filter(Boolean)) {
    const parsed = parseJsonLine(raw);
    if (!parsed) continue;
    lines.push(...extractAssistantReplyLines(parsed));
  }
  return lines;
}

function parseGooseResponseLines(rawOutput) {
  const assistantLines = parseGooseAssistantLines(rawOutput);
  if (assistantLines.length) return assistantLines;
  return parseGooseOutputLines(rawOutput)
    .map((line) => String(line || '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 200);
}

function isMeaningfulResponseLine(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^●\s*new session/i.test(text)) return false;
  if (/^\d{8}_\d+\s*·/i.test(text)) return false;
  if (/^summary:\s*$/i.test(text)) return false;
  if (/^tests not run\.?$/i.test(text)) return false;
  if (/^<tool_call>/i.test(text) || /^<\/tool_call>/i.test(text)) return false;
  if (/^<function=/i.test(text) || /^<\/function>/i.test(text)) return false;
  if (/^<parameter/i.test(text) || /^<\/parameter>/i.test(text)) return false;
  if (/^function=/i.test(text) || /^tool_call/i.test(text)) return false;
  return /[a-z0-9]/i.test(text);
}

function collectMeaningfulResponseLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || '').trim())
    .filter((line) => isMeaningfulResponseLine(line));
}

function shouldSoftAcceptSubagentNonZero({ code, stalled, timedOut, meaningfulCount, changedCount }) {
  if (Number(code) === 0) return false;
  if (stalled || timedOut) return false;
  if (meaningfulCount <= 0) return false;
  const allowWithChanges = toBoolEnv(process.env.GOOSE_SUBAGENT_SOFT_SUCCESS_ON_NONZERO_WITH_CHANGES, true);
  const allowNoChanges = toBoolEnv(process.env.GOOSE_SUBAGENT_SOFT_SUCCESS_ON_NONZERO_WITH_REPLY, false);
  if (changedCount > 0) return allowWithChanges;
  return allowNoChanges;
}

function hasMalformedToolCallSignal({ out = '', err = '', lines = [] }) {
  const text = [out, err, ...(Array.isArray(lines) ? lines : [])]
    .map((item) => String(item || ''))
    .join('\n')
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('could not interpret tool use parameters') ||
    text.includes('stream decode error') ||
    text.includes('failed to parse streaming chunk') ||
    text.includes('invalid type: null, expected a string')
  );
}

function extractLikelyToolNames(lines = []) {
  const text = String((Array.isArray(lines) ? lines : []).join('\n') || '');
  const matches = text.match(/[a-z0-9_]+__[a-z0-9_]+/gi) || [];
  return Array.from(new Set(matches.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 8);
}

function buildToolCallRepairPrompt(basePrompt, toolNames = []) {
  const toolsHint = toolNames.length ? `- Expected tools from last attempt: ${toolNames.join(', ')}` : '- Expected tools: infer safely.';
  const recovery = [
    '',
    'TOOL-CALL RECOVERY MODE:',
    '- Previous attempt failed due to malformed tool call parameters.',
    '- When using any tool, arguments MUST be valid JSON objects (double quotes, no comments, no trailing commas).',
    '- Never send null for function arguments.',
    '- If a tool has no args, send {}.',
    toolsHint,
    '- Continue and finish the assigned task normally after fixing tool call formatting.'
  ].join('\n');
  return `${String(basePrompt || '').trim()}\n${recovery}\n`;
}

function buildStrictToolJsonPrompt(basePrompt) {
  return buildToolCallRepairPrompt(basePrompt, []);
}

function normalizeChangedPath(file) {
  return String(file || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function isArtifactOnlyPath(file) {
  const normalized = normalizeChangedPath(file);
  if (!normalized) return true;
  // Orchestration report artifacts should not qualify as task code changes.
  if (normalized.startsWith('work-items/')) return true;
  return false;
}

async function listBranchDeltaFiles(workingDirectory, env, baseBranch = '') {
  const candidates = Array.from(
    new Set(
      [
        baseBranch ? `origin/${baseBranch}` : '',
        baseBranch || '',
        'origin/test',
        'test',
        'origin/main',
        'main'
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    )
  );
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runSpawn('git', ['-C', workingDirectory, 'diff', '--name-only', `${candidate}...HEAD`], {
      cwd: workingDirectory,
      env
    });
    if (res.code !== 0) continue;
    return String(res.out || '')
      .split('\n')
      .map((line) => normalizeChangedPath(line))
      .filter(Boolean);
  }
  return [];
}

async function listRunDeltaFiles(workingDirectory, env, runStartHead = '') {
  const start = String(runStartHead || '').trim();
  if (!start) return [];
  const res = await runSpawn('git', ['-C', workingDirectory, 'diff', '--name-only', `${start}...HEAD`], {
    cwd: workingDirectory,
    env
  });
  if (res.code !== 0) return [];
  return String(res.out || '')
    .split('\n')
    .map((line) => normalizeChangedPath(line))
    .filter(Boolean);
}

async function detectMeaningfulTaskChanges({ workingDirectory, env, baseBranch = '', runStartHead = '' }) {
  const [dirty, branchDelta] = await Promise.all([
    listDirtyFiles(workingDirectory, env),
    runStartHead ? listRunDeltaFiles(workingDirectory, env, runStartHead) : listBranchDeltaFiles(workingDirectory, env, baseBranch)
  ]);
  const all = Array.from(new Set([...dirty, ...branchDelta].map((file) => normalizeChangedPath(file)).filter(Boolean)));
  const meaningful = all.filter((file) => !isArtifactOnlyPath(file));
  const artifactOnly = all.filter((file) => isArtifactOnlyPath(file));
  return { all, meaningful, artifactOnly };
}

function toTaskKey(task) {
  return String(task?.externalId || `GSE-${task?.id || 'unknown'}`).trim();
}

function formatMs(ms) {
  const n = Number(ms) || 0;
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function reportFilePath(workingDirectory, task) {
  const key = toTaskKey(task).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(workingDirectory, 'work-items', key, `subagent-orchestration-report-task-${task.id}.md`);
}

function fullTranscriptFilePath(workingDirectory, task) {
  const key = toTaskKey(task).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(workingDirectory, 'work-items', key, `subagent-orchestration-full-transcript-task-${task.id}.md`);
}

function estimateTokensFromChars(chars) {
  return Math.ceil((Number(chars) || 0) / 4);
}

function compactLine(line, maxChars) {
  const raw = String(line || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}...`;
}

function compactLines(lines, maxLines, maxCharsPerLine) {
  const src = Array.isArray(lines) ? lines : [];
  const compacted = src.map((line) => compactLine(line, maxCharsPerLine)).filter(Boolean).slice(0, maxLines);
  const truncated = src.length > compacted.length;
  return { lines: compacted, truncated };
}

function buildOrchestrationReportMarkdown({
  task,
  integrationBranch,
  generatedAt,
  subagents,
  mergeLog,
  coordinatorName,
  primaryName,
  managerSummary,
  managerStatus,
  managerPrompt,
  managerOutputLines
}) {
  const maxPromptChars = parsePositiveInt(process.env.GOOSE_REPORT_PROMPT_MAX_CHARS, 1200);
  const maxReplyLines = parsePositiveInt(process.env.GOOSE_REPORT_REPLY_MAX_LINES, 20);
  const maxReplyChars = parsePositiveInt(process.env.GOOSE_REPORT_REPLY_MAX_CHARS, 220);
  const lines = [];
  lines.push(`# Subagent Orchestration Report: ${toTaskKey(task)}`);
  lines.push('');
  lines.push(`Generated At: ${generatedAt}`);
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Title: ${task.title || ''}`);
  lines.push(`Integration Branch: ${integrationBranch}`);
  lines.push(`Boss: ${coordinatorName || 'Rajiv Gupta (Boss)'}`);
  lines.push(`Primary Agent: ${primaryName || 'Rajiv Gupta (Boss)'}`);
  lines.push(`Manager Status: ${managerStatus}`);
  lines.push('');
  lines.push('## Token Usage');
  lines.push('');
  const totalPromptChars =
    subagents.reduce((sum, worker) => sum + String(worker.prompt || '').length, 0) + String(managerPrompt || '').length;
  const totalReplyChars =
    subagents.reduce((sum, worker) => sum + String((worker.outputLines || []).join('\n')).length, 0) +
    String((managerOutputLines || []).join('\n')).length;
  lines.push(`- Prompt chars: ${totalPromptChars} (approx tokens: ${estimateTokensFromChars(totalPromptChars)})`);
  lines.push(`- Reply chars: ${totalReplyChars} (approx tokens: ${estimateTokensFromChars(totalReplyChars)})`);
  lines.push('- Transcript policy: token-capped per section (to keep reports compact).');
  lines.push('');
  lines.push('## Subagents');
  lines.push('');
  for (const worker of subagents) {
    lines.push(`### ${worker.subagentName || `Subagent ${worker.index + 1}`}`);
    lines.push(`- Branch: ${worker.branch}`);
    lines.push(`- Worktree: ${worker.worktreePath}`);
    lines.push(`- Assigned Files: ${worker.files.length ? worker.files.join(', ') : '(none)'}`);
    lines.push(`- Changed Files: ${worker.changedFiles?.length ? worker.changedFiles.join(', ') : '(none)'}`);
    lines.push(`- Duration: ${formatMs(worker.durationMs)}`);
    lines.push(`- Exit Code: ${worker.code}`);
    lines.push(`- Raw Exit Code: ${Number.isFinite(Number(worker.rawCode)) ? worker.rawCode : worker.code}`);
    lines.push(`- Status: ${worker.ok ? 'completed' : 'failed'}`);
    if (worker.unexpectedFiles?.length) {
      lines.push(`- Unexpected File Touches: ${worker.unexpectedFiles.join(', ')}`);
    }
    lines.push(`- Prompt (truncated to ${maxPromptChars} chars):`);
    lines.push('```text');
    lines.push(String(worker.prompt || '(none)').slice(0, maxPromptChars));
    lines.push('```');
    const replyView = compactLines(worker.outputLines || [], maxReplyLines, maxReplyChars);
    lines.push(`- Reply (first ${replyView.lines.length}${replyView.truncated ? '+' : ''} lines):`);
    lines.push('```text');
    for (const row of replyView.lines) lines.push(row);
    if (replyView.truncated) lines.push('...<truncated>');
    lines.push('```');
    lines.push('- Summary:');
    const summary = String(worker.summary || '(none)')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!summary.length) lines.push('  - (none)');
    else for (const item of summary) lines.push(`  - ${item}`);
    lines.push('');
  }
  lines.push(`## ${coordinatorName || 'Rajiv Gupta (Boss)'} Merge Queue`);
  lines.push('');
  if (!mergeLog.length) lines.push('- (none)');
  else for (const row of mergeLog) lines.push(`- ${row}`);
  lines.push('');
  lines.push(`## ${coordinatorName || 'Rajiv Gupta (Boss)'}-Subagent Communication`);
  lines.push('');
  lines.push(`### ${primaryName || 'Rajiv Gupta (Boss)'} Final Prompt`);
  lines.push('```text');
  lines.push(String(managerPrompt || '(none)').slice(0, maxPromptChars));
  lines.push('```');
  lines.push('');
  lines.push(`### ${primaryName || 'Rajiv Gupta (Boss)'} Final Reply`);
  const managerReplyView = compactLines(managerOutputLines || [], maxReplyLines, maxReplyChars);
  lines.push('```text');
  for (const row of managerReplyView.lines) lines.push(row);
  if (managerReplyView.truncated) lines.push('...<truncated>');
  lines.push('```');
  lines.push('');
  lines.push(`## ${coordinatorName || 'Rajiv Gupta (Boss)'} Finalization Summary`);
  lines.push('');
  const managerLines = String(managerSummary || '(none)')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!managerLines.length) lines.push('- (none)');
  else for (const row of managerLines) lines.push(`- ${row}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName = 'Orchestrator' }) {
  const filePath = reportFilePath(workingDirectory, task);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf8');
  emitLine(broadcast, task.id, `${actorName}> wrote orchestration report: ${filePath}`);
  return filePath;
}

function buildFullOrchestrationTranscriptMarkdown({
  task,
  integrationBranch,
  generatedAt,
  subagents,
  mergeLog,
  coordinatorName,
  primaryName,
  managerPrompt,
  managerOutputLines,
  managerStatus
}) {
  const lines = [];
  lines.push(`# Full Orchestration Transcript: ${toTaskKey(task)}`);
  lines.push('');
  lines.push(`Generated At: ${generatedAt}`);
  lines.push(`Task ID: ${task.id}`);
  lines.push(`Title: ${task.title || ''}`);
  lines.push(`Integration Branch: ${integrationBranch}`);
  lines.push(`Boss: ${coordinatorName || 'Rajiv Gupta (Boss)'}`);
  lines.push(`Primary Agent: ${primaryName || 'Rajiv Gupta (Boss)'}`);
  lines.push(`Manager Status: ${managerStatus}`);
  lines.push('');
  lines.push('## Subagent Transcripts');
  lines.push('');
  for (const worker of subagents) {
    lines.push(`### ${worker.subagentName || `Subagent ${worker.index + 1}`}`);
    lines.push(`- Branch: ${worker.branch}`);
    lines.push(`- Assigned Files: ${worker.files.length ? worker.files.join(', ') : '(none)'}`);
    lines.push(`- Changed Files: ${worker.changedFiles?.length ? worker.changedFiles.join(', ') : '(none)'}`);
    lines.push(`- Exit Code: ${worker.code}`);
    lines.push(`- Raw Exit Code: ${Number.isFinite(Number(worker.rawCode)) ? worker.rawCode : worker.code}`);
    lines.push(`- Status: ${worker.ok ? 'completed' : 'failed'}`);
    lines.push('');
    lines.push('#### Prompt');
    lines.push('```text');
    lines.push(String(worker.prompt || '(none)'));
    lines.push('```');
    lines.push('');
    lines.push('#### Reply');
    lines.push('```text');
    for (const row of worker.outputLines || []) lines.push(String(row || ''));
    lines.push('```');
    lines.push('');
  }
  lines.push(`## ${coordinatorName || 'Rajiv Gupta (Boss)'} Merge Queue`);
  lines.push('');
  if (!mergeLog.length) lines.push('- (none)');
  else for (const row of mergeLog) lines.push(`- ${row}`);
  lines.push('');
  lines.push(`## ${primaryName || 'Rajiv Gupta (Boss)'} Final Prompt`);
  lines.push('```text');
  lines.push(String(managerPrompt || '(none)'));
  lines.push('```');
  lines.push('');
  lines.push(`## ${primaryName || 'Rajiv Gupta (Boss)'} Final Reply`);
  lines.push('```text');
  for (const row of managerOutputLines || []) lines.push(String(row || ''));
  lines.push('```');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeFullOrchestrationTranscript({ task, workingDirectory, markdown, broadcast, actorName = 'Orchestrator' }) {
  const writeFullTranscript = toBoolEnv(process.env.GOOSE_WRITE_FULL_TRANSCRIPT, false);
  if (!writeFullTranscript) {
    emitLine(
      broadcast,
      task.id,
      `${actorName}> full orchestration transcript disabled (set GOOSE_WRITE_FULL_TRANSCRIPT=1 to enable).`
    );
    return '';
  }
  const filePath = fullTranscriptFilePath(workingDirectory, task);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, markdown, 'utf8');
  emitLine(broadcast, task.id, `${actorName}> wrote full orchestration transcript: ${filePath}`);
  return filePath;
}

async function getCurrentBranch(workingDirectory, env) {
  const res = await runSpawn('git', ['-C', workingDirectory, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workingDirectory, env });
  if (res.code !== 0) return '';
  return String(res.out || '').trim();
}

async function listChangedFiles(baseRef, workingDirectory, env) {
  const res = await runSpawn('git', ['-C', workingDirectory, 'diff', '--name-only', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`], {
    cwd: workingDirectory,
    env
  });
  if (res.code !== 0) return [];
  return String(res.out || '')
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean);
}

async function listDirtyFiles(workingDirectory, env) {
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
    ['ls-files', '--others', '--exclude-standard']
  ];
  const files = new Set();
  for (const args of commands) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runSpawn('git', ['-C', workingDirectory, ...args], { cwd: workingDirectory, env });
    if (res.code !== 0) continue;
    for (const line of String(res.out || '').split('\n')) {
      const file = line.trim().replace(/\\/g, '/');
      if (file) files.add(file);
    }
  }
  return Array.from(files);
}

async function listAllChangedFiles(baseRef, workingDirectory, env) {
  const [committed, dirty] = await Promise.all([
    listChangedFiles(baseRef, workingDirectory, env),
    listDirtyFiles(workingDirectory, env)
  ]);
  return Array.from(new Set([...committed, ...dirty]));
}

function hasScopeViolations(changedFiles, scope) {
  const allowedExact = new Set(
    (scope?.allowedExactFiles || [])
      .map((file) => sanitizeChunkFileRef(file))
      .filter(Boolean)
  );
  const createPrefixes = (scope?.allowedCreatePrefixes || []).map((entry) => ensureTrailingSlash(entry)).filter(Boolean);
  const changed = (Array.isArray(changedFiles) ? changedFiles : [])
    .map((file) => sanitizeChunkFileRef(file))
    .filter(Boolean);
  const meaningfulChanged = changed.filter((file) => !isArtifactOnlyPath(file));
  const unexpected = meaningfulChanged.filter((file) => {
    if (allowedExact.has(file)) return false;
    for (const prefix of createPrefixes) {
      if (file.startsWith(prefix)) return false;
    }
    return true;
  });
  return {
    unexpected,
    allowedExact,
    createPrefixes
  };
}

async function runGoosePrompt({
  prompt,
  limits,
  extensionArgs,
  agent,
  env,
  cwd,
  maxTurns,
  maxToolRepetitions,
  timeoutMs = 0,
  noOutputTimeoutMs = 0
}) {
  const promptWithPolicy = withSmartCodeExecutionPrompt(prompt, 'subagent');
  const promptForExecution = compactExecutionPrompt(promptWithPolicy, 'subagent');
  const disableProfile = toBoolEnv(process.env.GOOSE_NO_PROFILE, false);
  const forcedBuiltins = resolveForcedBuiltins();
  const args = [
    'run',
    '--no-session',
    ...(disableProfile ? ['--no-profile'] : []),
    '--output-format',
    'stream-json',
    '--max-turns',
    String(Math.max(2, maxTurns || limits.maxTurns)),
    '--max-tool-repetitions',
    String(Math.max(1, maxToolRepetitions || limits.maxToolRepetitions)),
    ...(forcedBuiltins.length ? ['--with-builtin', forcedBuiltins.join(',')] : []),
    ...extensionArgs,
    '--text',
    promptForExecution
  ];
  if (agent.useDeviceConfig === false) {
    if (agent.provider) args.push('--provider', agent.provider);
    if (agent.model) args.push('--model', agent.model);
  }
  return new Promise((resolve) => {
    const child = spawn('goose', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env
    });
    let out = '';
    let err = '';
    let closed = false;
    let timedOut = false;
    let stalled = false;
    let lastOutputAt = Date.now();
    let forceKillTimer = null;

    const finish = (code) => {
      if (closed) return;
      closed = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (stallTimer) clearInterval(stallTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ code: Number(code) || 1, out, err, timedOut, stalled });
    };

    const terminate = (reason) => {
      if (closed) return;
      if (reason === 'timeout') timedOut = true;
      if (reason === 'stalled') stalled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore termination errors.
      }
      forceKillTimer = setTimeout(() => {
        if (closed) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore kill errors.
        }
      }, 4000);
    };

    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      lastOutputAt = Date.now();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
      lastOutputAt = Date.now();
    });
    child.on('error', (error) => {
      err += String(error?.message || error);
      finish(1);
    });
    child.on('close', (code) => finish(code));

    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            terminate('timeout');
          }, timeoutMs)
        : null;
    const stallTimer =
      noOutputTimeoutMs > 0
        ? setInterval(() => {
            if (closed) return;
            if (Date.now() - lastOutputAt >= noOutputTimeoutMs) terminate('stalled');
          }, 1000)
        : null;
  });
}

async function runGooseSubagent({
  task,
  subagentIndex,
  subagentName,
  coordinatorName,
  total,
  scope,
  limits,
  extensionArgs,
  agent,
  env,
  baseRef,
  worktreePath,
  broadcast
}) {
  const files = Array.isArray(scope?.focusFiles) ? scope.focusFiles : [];
  const filesToCreate = Array.isArray(scope?.filesToCreate) ? scope.filesToCreate : [];
  const createPrefixes = Array.isArray(scope?.allowedCreatePrefixes) ? scope.allowedCreatePrefixes : [];
  const fileList = files.map((file) => `- ${file}`).join('\n');
  const createList = filesToCreate.map((file) => `- ${file}`).join('\n');
  const createPrefixList = createPrefixes.map((prefix) => `- ${prefix}`).join('\n');
  const prompt = [
    `${subagentName} (${subagentIndex + 1}/${total})`,
    `TASK: ${task.title || ''}`,
    `DESC: ${task.description || ''}`,
    'FOCUS FILES:',
    fileList || '- (none)',
    'ALLOWED CREATE FILES:',
    createList || '- (none)',
    'ALLOWED CREATE PREFIXES:',
    createPrefixList || '- (none)',
    'INSTRUCTIONS:',
    '- Make small, safe edits only in focus files.',
    '- New files are allowed only in ALLOWED CREATE FILES or ALLOWED CREATE PREFIXES.',
    '- Keep changes compilable.',
    '- Do not open PR or ask for user interaction.',
    '- End with a compact summary of exactly what changed.'
  ]
    .filter(Boolean)
    .join('\n');
  emitLine(broadcast, task.id, `${coordinatorName}> launching ${subagentName} (${subagentIndex + 1}/${total}) files=${files.length}`);
  emitConversation({ broadcast, taskId: task.id, from: coordinatorName, to: subagentName, text: prompt });
  const thinkingTicker = startThinkingTicker({ broadcast, taskId: task.id, agentName: subagentName });
  const subagentMaxTurns = Math.min(limits.maxTurns, parsePositiveInt(process.env.GOOSE_SUBAGENT_MAX_TURNS, 8));
  const subagentMaxToolRepetitions = Math.min(
    limits.maxToolRepetitions,
    parsePositiveInt(process.env.GOOSE_SUBAGENT_MAX_TOOL_REPETITIONS, 2)
  );
  const subagentTimeoutMs = parsePositiveInt(process.env.GOOSE_SUBAGENT_TIMEOUT_MS, Math.min(limits.timeoutMs, 180000));
  const subagentNoOutputTimeoutMs = parsePositiveInt(process.env.GOOSE_SUBAGENT_NO_OUTPUT_TIMEOUT_MS, 90000);
  let promptForRun = prompt;
  let repairedRetryAttempted = false;
  let res = await runGoosePrompt({
    prompt,
    limits,
    extensionArgs,
    agent,
    env,
    cwd: worktreePath,
    maxTurns: subagentMaxTurns,
    maxToolRepetitions: subagentMaxToolRepetitions,
    timeoutMs: subagentTimeoutMs,
    noOutputTimeoutMs: subagentNoOutputTimeoutMs
  });
  let outputLines = parseGooseOutputLines(res.out);
  let malformedToolCallDetected = hasMalformedToolCallSignal({ out: res.out, err: res.err, lines: outputLines });
  if (res.code !== 0 && !res.stalled && !res.timedOut && malformedToolCallDetected) {
    const likelyTools = extractLikelyToolNames(outputLines);
    emitLine(
      broadcast,
      task.id,
      `${coordinatorName}> ${subagentName} malformed tool-call payload detected; retrying once with repaired tool-call instructions.`
    );
    if (likelyTools.length) {
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} inferred tools: ${likelyTools.join(', ')}`);
    }
    promptForRun = buildToolCallRepairPrompt(prompt, likelyTools);
    repairedRetryAttempted = true;
    const retry = await runGoosePrompt({
      prompt: promptForRun,
      limits,
      extensionArgs,
      agent,
      env,
      cwd: worktreePath,
      maxTurns: subagentMaxTurns,
      maxToolRepetitions: subagentMaxToolRepetitions,
      timeoutMs: subagentTimeoutMs,
      noOutputTimeoutMs: subagentNoOutputTimeoutMs
    });
    res = retry;
    outputLines = parseGooseOutputLines(res.out);
    malformedToolCallDetected =
      malformedToolCallDetected || hasMalformedToolCallSignal({ out: res.out, err: res.err, lines: outputLines });
  }
  clearInterval(thinkingTicker);
  const responseLines = parseGooseResponseLines(res.out);
  const meaningfulResponseLines = collectMeaningfulResponseLines(responseLines);
  for (const line of responseLines) {
    emitConversation({ broadcast, taskId: task.id, from: subagentName, to: coordinatorName, text: line });
  }
  const changedFiles = await listAllChangedFiles(baseRef, worktreePath, env);
  const resultMeta = {
    stalled: Boolean(res.stalled),
    timedOut: Boolean(res.timedOut),
    malformedToolCall: Boolean(malformedToolCallDetected),
    repairedRetryAttempted: Boolean(repairedRetryAttempted),
    failureKind: 'none'
  };
  if (res.code !== 0) {
    if (res.stalled) {
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} stalled waiting for output; terminated.`);
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} failed code=${res.code}`);
      return {
        ok: false,
        code: res.code,
        rawCode: res.code,
        summary: '',
        outputLines,
        changedFiles,
        unexpectedFiles: [],
        prompt: promptForRun,
        ...resultMeta,
        failureKind: 'stalled'
      };
    }
    if (res.timedOut) {
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} timed out; terminated.`);
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} failed code=${res.code}`);
      return {
        ok: false,
        code: res.code,
        rawCode: res.code,
        summary: '',
        outputLines,
        changedFiles,
        unexpectedFiles: [],
        prompt: promptForRun,
        ...resultMeta,
        failureKind: 'timed_out'
      };
    }
    if (shouldSoftAcceptSubagentNonZero({
      code: res.code,
      stalled: res.stalled,
      timedOut: res.timedOut,
      meaningfulCount: meaningfulResponseLines.length,
      changedCount: changedFiles.length
    })) {
      if (changedFiles.length === 0) {
        emitLine(
          broadcast,
          task.id,
          `${coordinatorName}> ${subagentName} returned code=${res.code} with no file changes; treating as failure.`
        );
        return {
          ok: false,
          code: res.code,
          rawCode: res.code,
          summary: '',
          outputLines,
          changedFiles,
          unexpectedFiles: [],
          prompt: promptForRun,
          ...resultMeta,
          failureKind: malformedToolCallDetected ? 'tool_call' : 'nonzero_no_changes'
        };
      }
      emitLine(
        broadcast,
        task.id,
        `${coordinatorName}> ${subagentName} returned code=${res.code} but produced file changes; continuing with ownership + commit checks.`
      );
    } else {
      emitLine(broadcast, task.id, `${coordinatorName}> ${subagentName} failed code=${res.code}`);
      return {
        ok: false,
        code: res.code,
        rawCode: res.code,
        summary: '',
        outputLines,
        changedFiles,
        unexpectedFiles: [],
        prompt: promptForRun,
        ...resultMeta,
        failureKind: malformedToolCallDetected ? 'tool_call' : 'nonzero_exit'
      };
    }
  }
  const strictOwnership = toBoolEnv(process.env.GOOSE_STRICT_OWNERSHIP, true);
  const ownership = hasScopeViolations(changedFiles, scope);
  if (strictOwnership && ownership.unexpected.length) {
    emitLine(
      broadcast,
      task.id,
      `${coordinatorName}> ${subagentName} touched unexpected files: ${ownership.unexpected.join(', ')}`
    );
    return {
      ok: false,
      code: 2,
      rawCode: res.code,
      summary: '',
      outputLines,
      changedFiles,
      unexpectedFiles: ownership.unexpected,
      prompt: promptForRun,
      ...resultMeta,
      failureKind: 'scope_violation'
    };
  }
  const committed = await autoCommitIfDirty({
    task,
    workingDirectory: worktreePath,
    env,
    broadcast,
    label: subagentName,
    commitMessage: `chore(goose): ${subagentName} for task ${task.id}`
  });
  if (!committed.ok) {
    return {
      ok: false,
      code: 6,
      rawCode: res.code,
      summary: '',
      outputLines,
      changedFiles,
      unexpectedFiles: [],
      prompt: promptForRun,
      ...resultMeta,
      failureKind: 'commit_failed'
    };
  }
  const summary = (meaningfulResponseLines.length ? meaningfulResponseLines : responseLines.length ? responseLines : outputLines)
    .slice(-10)
    .join('\n')
    .trim();
  emitLine(
    broadcast,
    task.id,
    `${coordinatorName}> ${subagentName} completed changed=${changedFiles.length} strictOwnership=${strictOwnership ? 'on' : 'off'}`
  );
  return {
    ok: true,
    code: 0,
    rawCode: res.code,
    summary,
    outputLines,
    changedFiles,
    unexpectedFiles: [],
    prompt: promptForRun,
    ...resultMeta,
    failureKind: 'none'
  };
}

async function mergeSubagentBranch({
  task,
  coordinatorName,
  branch,
  workingDirectory,
  env,
  broadcast,
  summaries,
  limits,
  extensionArgs,
  agent
}) {
  const merge = await runSpawn('git', ['-C', workingDirectory, 'merge', '--no-ff', '--no-edit', branch], { cwd: workingDirectory, env });
  if (merge.code === 0) {
    emitLine(broadcast, task.id, `${coordinatorName}> merged ${branch}`);
    return { ok: true, resolved: false, conflicted: [] };
  }
  const conflictedRes = await runSpawn('git', ['-C', workingDirectory, 'diff', '--name-only', '--diff-filter=U'], { cwd: workingDirectory, env });
  const conflicted = String(conflictedRes.out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  emitLine(
    broadcast,
    task.id,
    `${coordinatorName}> merge conflict on ${branch}; invoking resolver for files: ${conflicted.join(', ') || 'unknown'}`
  );
  const resolverPrompt = [
    `MERGE CONFLICT RESOLUTION FOR TASK: ${task.title || ''}`,
    `CONFLICTED FILES:\n${conflicted.map((f) => `- ${f}`).join('\n') || '- unknown'}`,
    'SUBAGENT SUMMARIES:',
    summaries.join('\n\n') || '(none)',
    'INSTRUCTIONS:',
    '- Resolve merge conflicts preserving correct behavior.',
    '- Keep changes minimal and compilable.',
    '- After resolving, stage changes and commit merge resolution.'
  ].join('\n');
  emitConversation({ broadcast, taskId: task.id, from: coordinatorName, to: `${coordinatorName} Resolver`, text: resolverPrompt });
  const resolverTicker = startThinkingTicker({ broadcast, taskId: task.id, agentName: `${coordinatorName} Resolver` });
  const resolver = await runGoosePrompt({
    prompt: resolverPrompt,
    limits,
    extensionArgs,
    agent,
    env,
    cwd: workingDirectory,
    maxTurns: Math.min(limits.maxTurns, parsePositiveInt(process.env.GOOSE_MANAGER_MAX_TURNS, 10)),
    maxToolRepetitions: Math.min(limits.maxToolRepetitions, parsePositiveInt(process.env.GOOSE_MANAGER_MAX_TOOL_REPETITIONS, 3)),
    timeoutMs: parsePositiveInt(process.env.GOOSE_MANAGER_TIMEOUT_MS, Math.min(limits.timeoutMs, 240000)),
    noOutputTimeoutMs: parsePositiveInt(process.env.GOOSE_MANAGER_NO_OUTPUT_TIMEOUT_MS, 120000)
  });
  clearInterval(resolverTicker);
  const resolverAssistantLines = parseGooseResponseLines(resolver.out);
  for (const line of resolverAssistantLines) {
    emitConversation({ broadcast, taskId: task.id, from: `${coordinatorName} Resolver`, to: coordinatorName, text: line });
  }
  if (resolver.code !== 0) {
    if (resolver.stalled) {
      emitLine(broadcast, task.id, `${coordinatorName}> resolver stalled waiting for output; terminated.`);
    } else if (resolver.timedOut) {
      emitLine(broadcast, task.id, `${coordinatorName}> resolver timed out; terminated.`);
    }
    await runSpawn('git', ['-C', workingDirectory, 'merge', '--abort'], { cwd: workingDirectory, env });
    emitLine(broadcast, task.id, `${coordinatorName}> resolver failed for ${branch}`);
    return { ok: false, resolved: false, conflicted };
  }
  const add = await runSpawn('git', ['-C', workingDirectory, 'add', '-A'], { cwd: workingDirectory, env });
  if (add.code !== 0) return { ok: false };
  const commit = await runSpawn('git', ['-C', workingDirectory, 'commit', '-m', `chore(goose): resolve merge conflicts for task ${task.id}`], {
    cwd: workingDirectory,
    env
  });
  if (commit.code !== 0) {
    const out = String(commit.err || commit.out || '').trim();
    if (!out.includes('nothing to commit')) {
      emitLine(broadcast, task.id, `${coordinatorName}> resolver commit failed: ${out}`);
      return { ok: false, resolved: false, conflicted };
    }
  }
  emitLine(broadcast, task.id, `${coordinatorName}> resolver completed for ${branch}`);
  return { ok: true, resolved: true, conflicted };
}

async function runOrchestratedGoose({ task, limits, extensionArgs, agent, env, workingDirectory, broadcast, primaryName }) {
  const scopePlan = deriveScopePlan(
    task,
    parsePositiveInt(process.env.GOOSE_SUBAGENT_MAX_FILES, 8),
    parsePositiveInt(process.env.GOOSE_SUBAGENT_MAX_CREATE_FILES, 3)
  );
  const orchestrationNeed = evaluateTaskOrchestrationNeed(task, scopePlan);
  if (!orchestrationNeed.requiresOrchestration) {
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> orchestration skipped: estimated=${orchestrationNeed.estimateSeconds}s threshold=${orchestrationNeed.thresholdSeconds}s bigTask=${
        orchestrationNeed.isBigTask ? 'yes' : 'no'
      } files=${orchestrationNeed.metrics.editCount}.`
    );
    return { handled: false, code: 0, outputLines: [] };
  }
  const files = scopePlan.filesToEdit;
  const chunkSize = parsePositiveInt(process.env.GOOSE_SUBAGENT_CHUNK_SIZE, 1);
  const chunks = splitIntoChunks(files, chunkSize).slice(0, parsePositiveInt(process.env.GOOSE_SUBAGENTS_MAX, 2));
  if (chunks.length < 2) return { handled: false, code: 0, outputLines: [] };
  const agentNames = buildAgentNames(task, chunks.length);
  const coordinatorName = agentNames.coordinator || `${primaryName} Lead`;
  const integrationBranch = await getCurrentBranch(workingDirectory, env);
  if (!integrationBranch) return { handled: false, code: 0, outputLines: [] };
  const baseRef = integrationBranch;
  emitLine(
    broadcast,
    task.id,
    `${coordinatorName}> orchestration enabled subagents=${chunks.length} chunkSize=${chunkSize} mode=parallel-worktree`
  );
  emitLine(
    broadcast,
    task.id,
    `${coordinatorName}> scope-plan editFiles=${scopePlan.filesToEdit.length} createFiles=${scopePlan.filesToCreate.length}`
  );
  emitLine(
    broadcast,
    task.id,
    `${coordinatorName}> roster: primary=${primaryName}; subagents=${agentNames.subagents.join(', ')}`
  );

  const workers = chunks.map((filesChunk, i) => ({
    idx: i,
    scope: buildWorkerScope(filesChunk, scopePlan.filesToCreate),
    branch: `${integrationBranch}-sa${i + 1}`,
    worktreePath: fs.mkdtempSync(path.join('/tmp', `goose-${task.id}-sa${i + 1}-`))
  }));

  const teardown = async () => {
    await Promise.all(
      workers.map(async (worker) => {
        await runSpawn('git', ['-C', workingDirectory, 'worktree', 'remove', '--force', worker.worktreePath], { cwd: workingDirectory, env });
        await runSpawn('git', ['-C', workingDirectory, 'branch', '-D', worker.branch], { cwd: workingDirectory, env });
      })
    );
  };

  try {
    for (const worker of workers) {
      // eslint-disable-next-line no-await-in-loop
      const add = await runSpawn('git', ['-C', workingDirectory, 'worktree', 'add', '-B', worker.branch, worker.worktreePath, baseRef], {
        cwd: workingDirectory,
        env
      });
      if (add.code !== 0) {
        emitLine(broadcast, task.id, `${coordinatorName}> failed to create worktree for ${worker.branch}`);
        return { handled: true, code: 3, outputLines: [] };
      }
    }

    const subagentResults = await Promise.all(
      workers.map(async (worker) => {
        const startedAt = Date.now();
        const result = await runGooseSubagent({
          task,
          subagentIndex: worker.idx,
          subagentName: agentNames.subagents[worker.idx] || `Subagent ${worker.idx + 1}`,
          coordinatorName,
          total: workers.length,
          scope: worker.scope,
          limits,
          extensionArgs,
          agent,
          env,
          baseRef,
          worktreePath: worker.worktreePath,
          broadcast
        });
        return {
          ...result,
          durationMs: Date.now() - startedAt,
          index: worker.idx,
          subagentName: agentNames.subagents[worker.idx] || `Subagent ${worker.idx + 1}`,
          files: worker.scope.focusFiles,
          scope: worker.scope,
          branch: worker.branch,
          worktreePath: worker.worktreePath
        };
      })
    );

    const combinedOutput = subagentResults.flatMap((r) => r.outputLines);
    const failedSubagents = subagentResults.filter((r) => !r.ok);
    const successfulSubagents = subagentResults.filter((r) => r.ok);
    const successfulMeaningfulSubagents = successfulSubagents.filter((result) =>
      (result.changedFiles || []).some((file) => !isArtifactOnlyPath(file))
    );
    const unstableFailureKinds = new Set(['tool_call', 'stalled', 'timed_out']);
    const unstableSubagentFailures = failedSubagents.filter((result) => unstableFailureKinds.has(String(result.failureKind || '')));
    const scopeSubagentFailures = failedSubagents.filter((result) => String(result.failureKind || '') === 'scope_violation');
    const repeatedToolCallInstability = !successfulSubagents.length && unstableSubagentFailures.length >= Math.min(2, workers.length);
    const repeatedScopeDrift = !successfulSubagents.length && scopeSubagentFailures.length >= Math.min(2, workers.length);
    if (repeatedToolCallInstability) {
      const reason = `Repeated tool-call/stall instability across subagents (${unstableSubagentFailures.length}/${workers.length}); switching to strict single-agent mode.`;
      emitLine(broadcast, task.id, `${coordinatorName}> ${reason}`);
      const markdown = buildOrchestrationReportMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerSummary: '',
        managerStatus: 'failed',
        managerPrompt: '',
        managerOutputLines: []
      });
      const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
      const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerPrompt: '',
        managerOutputLines: [],
        managerStatus: 'failed'
      });
      writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
      return { handled: true, code: 9, outputLines: combinedOutput, reportPath, reason: 'tool_instability' };
    }
    if (repeatedScopeDrift) {
      const reason = `Repeated scope drift across subagents (${scopeSubagentFailures.length}/${workers.length}); switching to single-agent mode.`;
      emitLine(broadcast, task.id, `${coordinatorName}> ${reason}`);
      const markdown = buildOrchestrationReportMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerSummary: '',
        managerStatus: 'failed',
        managerPrompt: '',
        managerOutputLines: []
      });
      const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
      const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerPrompt: '',
        managerOutputLines: [],
        managerStatus: 'failed'
      });
      writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
      return { handled: true, code: 9, outputLines: combinedOutput, reportPath, reason: 'scope_drift' };
    }
    if (!successfulSubagents.length) {
      const markdown = buildOrchestrationReportMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: ['Subagent phase failed before merge. No successful subagent output to integrate.'],
        coordinatorName,
        primaryName,
        managerSummary: '',
        managerStatus: 'failed',
        managerPrompt: '',
        managerOutputLines: []
      });
      const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
      const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: ['Subagent phase failed before merge. No successful subagent output to integrate.'],
        coordinatorName,
        primaryName,
        managerPrompt: '',
        managerOutputLines: [],
        managerStatus: 'failed'
      });
      writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
      return { handled: true, code: failedSubagents[0]?.code || 4, outputLines: combinedOutput, reportPath };
    }
    if (!successfulMeaningfulSubagents.length) {
      const reason =
        'Subagents returned without meaningful task file edits (artifact/no-op only); forcing fallback to single-agent execution.';
      emitLine(broadcast, task.id, `${coordinatorName}> ${reason}`);
      const markdown = buildOrchestrationReportMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerSummary: '',
        managerStatus: 'failed',
        managerPrompt: '',
        managerOutputLines: []
      });
      const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
      const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog: [reason],
        coordinatorName,
        primaryName,
        managerPrompt: '',
        managerOutputLines: [],
        managerStatus: 'failed'
      });
      writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
      return { handled: true, code: 7, outputLines: combinedOutput, reportPath };
    }
    if (failedSubagents.length) {
      emitLine(
        broadcast,
        task.id,
        `${coordinatorName}> ${failedSubagents.length}/${subagentResults.length} subagents failed; continuing with successful subagent outputs.`
      );
    }

    const summaries = subagentResults.map(
      (result, i) => `${agentNames.subagents[i] || `Subagent ${i + 1}`} summary:\n${result.summary || '(no summary)'}`
    );
    const mergeLog = [];
    let hadConflictMerge = false;
    for (const failed of failedSubagents) {
      mergeLog.push(
        `Skipped ${failed.subagentName || `Subagent ${failed.index + 1}`} due to failure (exit=${failed.code}, raw=${failed.rawCode ?? failed.code}).`
      );
    }
    const workersToMerge = workers.filter((worker) => {
      const result = subagentResults.find((row) => row.index === worker.idx);
      return Boolean(result?.ok && (result.changedFiles || []).some((file) => !isArtifactOnlyPath(file)));
    });
    for (const worker of workersToMerge) {
      // eslint-disable-next-line no-await-in-loop
      const merged = await mergeSubagentBranch({
        task,
        coordinatorName,
        branch: worker.branch,
        workingDirectory,
        env,
        broadcast,
        summaries,
        limits,
        extensionArgs,
        agent
      });
      if (!merged.ok) {
        mergeLog.push(`Failed to merge ${worker.branch}; conflicted files: ${(merged.conflicted || []).join(', ') || 'unknown'}`);
        const markdown = buildOrchestrationReportMarkdown({
          task,
          integrationBranch,
          generatedAt: new Date().toISOString(),
          subagents: subagentResults,
          mergeLog,
          coordinatorName,
          primaryName,
          managerSummary: '',
          managerStatus: 'failed',
          managerPrompt: '',
          managerOutputLines: []
        });
        const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
        const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
          task,
          integrationBranch,
          generatedAt: new Date().toISOString(),
          subagents: subagentResults,
          mergeLog,
          coordinatorName,
          primaryName,
          managerPrompt: '',
          managerOutputLines: [],
          managerStatus: 'failed'
        });
        writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
        return { handled: true, code: 5, outputLines: combinedOutput, reportPath };
      }
      mergeLog.push(
        merged.resolved
          ? `Merged ${worker.branch} with resolver (conflicts: ${(merged.conflicted || []).join(', ') || 'none'})`
          : `Merged ${worker.branch} cleanly`
      );
      if (merged.resolved) hadConflictMerge = true;
    }

    const managerRequired = toBoolEnv(process.env.GOOSE_MANAGER_REQUIRED, false);
    const managerOnCleanMerge = toBoolEnv(process.env.GOOSE_MANAGER_ON_CLEAN_MERGE, false);
    const runManagerFinalization = managerRequired || hadConflictMerge || managerOnCleanMerge;
    if (!runManagerFinalization) {
      emitLine(
        broadcast,
        task.id,
        `${coordinatorName}> final integration pass skipped (no merge conflicts; set GOOSE_MANAGER_ON_CLEAN_MERGE=1 to force).`
      );
      const markdown = buildOrchestrationReportMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog,
        coordinatorName,
        primaryName,
        managerSummary: '',
        managerStatus: 'skipped',
        managerPrompt: '',
        managerOutputLines: []
      });
      const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
      const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
        task,
        integrationBranch,
        generatedAt: new Date().toISOString(),
        subagents: subagentResults,
        mergeLog,
        coordinatorName,
        primaryName,
        managerPrompt: '',
        managerOutputLines: [],
        managerStatus: 'skipped'
      });
      writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
      return { handled: true, code: 0, outputLines: combinedOutput, reportPath };
    }

    const managerPrompt = [
      `MANAGER FINALIZATION FOR TASK: ${task.title || ''}`,
      `DESC: ${task.description || ''}`,
      'SUBAGENT HANDOFFS:',
      summaries.join('\n\n'),
      'INSTRUCTIONS:',
      '- Verify combined edits are coherent.',
      '- Apply any required final integration tweaks.',
      '- Keep output concise and include changed files.'
    ].join('\n');
    emitLine(broadcast, task.id, `${coordinatorName}> final integration pass started`);
    emitConversation({ broadcast, taskId: task.id, from: coordinatorName, to: primaryName, text: managerPrompt });
    const managerTicker = startThinkingTicker({ broadcast, taskId: task.id, agentName: primaryName });
    const managerRes = await runGoosePrompt({
      prompt: managerPrompt,
      limits,
      extensionArgs,
      agent,
      env,
      cwd: workingDirectory,
      maxTurns: Math.min(limits.maxTurns, parsePositiveInt(process.env.GOOSE_MANAGER_MAX_TURNS, 10)),
      maxToolRepetitions: Math.min(limits.maxToolRepetitions, parsePositiveInt(process.env.GOOSE_MANAGER_MAX_TOOL_REPETITIONS, 3)),
      timeoutMs: parsePositiveInt(process.env.GOOSE_MANAGER_TIMEOUT_MS, Math.min(limits.timeoutMs, 240000)),
      noOutputTimeoutMs: parsePositiveInt(process.env.GOOSE_MANAGER_NO_OUTPUT_TIMEOUT_MS, 120000)
    });
    clearInterval(managerTicker);
    combinedOutput.push(...parseGooseOutputLines(managerRes.out));
    const managerAssistantLines = parseGooseResponseLines(managerRes.out);
    for (const line of managerAssistantLines) {
      emitConversation({ broadcast, taskId: task.id, from: primaryName, to: coordinatorName, text: line });
    }
    const managerOutputLines = parseGooseOutputLines(managerRes.out);
    const managerMeaningfulLines = collectMeaningfulResponseLines(managerAssistantLines.length ? managerAssistantLines : managerOutputLines);
    const managerSoftSuccessAllowed = toBoolEnv(process.env.GOOSE_MANAGER_SOFT_SUCCESS_ON_NONZERO_WITH_REPLY, true);
    const managerSoftSuccess = Boolean(
      managerRes.code !== 0 &&
        !managerRes.stalled &&
        !managerRes.timedOut &&
        managerSoftSuccessAllowed &&
        managerMeaningfulLines.length > 0
    );
    let managerFinalCode = managerRes.code === 0 || managerSoftSuccess ? 0 : managerRes.code;
    if (managerFinalCode !== 0 && !managerRequired) {
      emitLine(
        broadcast,
        task.id,
        `${coordinatorName}> final integration pass failed code=${managerRes.code}, but manager is optional; proceeding with merged subagent output.`
      );
      managerFinalCode = 0;
    }
    const managerSummary = (managerMeaningfulLines.length ? managerMeaningfulLines : managerOutputLines).slice(-20).join('\n');
    emitLine(
      broadcast,
      task.id,
      managerFinalCode === 0
        ? managerSoftSuccess
          ? `${coordinatorName}> final integration pass soft-completed (raw code=${managerRes.code}).`
          : `${coordinatorName}> final integration pass completed`
        : `${coordinatorName}> final integration pass failed code=${managerRes.code}`
    );
    const markdown = buildOrchestrationReportMarkdown({
      task,
      integrationBranch,
      generatedAt: new Date().toISOString(),
      subagents: subagentResults,
      mergeLog,
      coordinatorName,
      primaryName,
      managerSummary,
      managerStatus: managerFinalCode === 0 ? (managerSoftSuccess ? 'soft-completed' : 'completed') : 'failed',
      managerPrompt,
      managerOutputLines
    });
    const reportPath = writeOrchestrationReport({ task, workingDirectory, markdown, broadcast, actorName: coordinatorName });
    const fullTranscript = buildFullOrchestrationTranscriptMarkdown({
      task,
      integrationBranch,
      generatedAt: new Date().toISOString(),
      subagents: subagentResults,
      mergeLog,
      coordinatorName,
      primaryName,
      managerPrompt,
      managerOutputLines,
      managerStatus: managerFinalCode === 0 ? (managerSoftSuccess ? 'soft-completed' : 'completed') : 'failed'
    });
    writeFullOrchestrationTranscript({ task, workingDirectory, markdown: fullTranscript, broadcast, actorName: coordinatorName });
    return { handled: true, code: managerFinalCode, outputLines: combinedOutput, reportPath };
  } finally {
    await teardown();
  }
}

function resolveGooseLimits(task) {
  const defaultMaxTurns = parsePositiveInt(process.env.GOOSE_MAX_TURNS, 30);
  const defaultMaxToolRepetitions = parsePositiveInt(process.env.GOOSE_MAX_TOOL_REPETITIONS, 4);
  const defaultTimeoutMs = parsePositiveInt(process.env.GOOSE_TIMEOUT_MS, 300000);
  const keysRaw = process.env.GOOSE_FAST_TASK_KEYS || 'gse-23';
  const fastKeys = Array.from(
    new Set(
      keysRaw
        .split(',')
        .map((item) => normalizeTaskKey(item))
        .filter(Boolean)
    )
  );
  const fastKeySet = new Set(fastKeys);
  const hasFastMatch = (taskKey) =>
    fastKeySet.has(taskKey) || fastKeys.some((fastKey) => taskKey.startsWith(`${fastKey}-`));
  const taskKeys = [
    normalizeTaskKey(task.externalId),
    normalizeTaskKey(task.branchName),
    normalizeTaskKey(`gse-${task.id}`)
  ].filter(Boolean);
  const matchedKey = taskKeys.find((key) => hasFastMatch(key));
  if (!matchedKey) {
    return {
      maxTurns: defaultMaxTurns,
      maxToolRepetitions: defaultMaxToolRepetitions,
      timeoutMs: defaultTimeoutMs,
      expedited: false,
      matchedKey: '',
      taskKeys
    };
  }
  return {
    maxTurns: parsePositiveInt(process.env.GOOSE_FAST_MAX_TURNS, 12),
    maxToolRepetitions: parsePositiveInt(process.env.GOOSE_FAST_MAX_TOOL_REPETITIONS, 2),
    timeoutMs: parsePositiveInt(process.env.GOOSE_FAST_TIMEOUT_MS, Math.max(defaultTimeoutMs, 480000)),
    expedited: true,
    matchedKey,
    taskKeys
  };
}

export async function runGooseExecution({ task, project, hydratedPrompt, plugins, broadcast, idempotencyKey = '' }) {
  const primaryName = buildAgentNames(task, 0).primary;
  installShutdownHook();
  if (activeRuns.has(task.id)) {
    emitLine(broadcast, task.id, `${primaryName}> execution already running for this task, skipping duplicate launch.`);
    return;
  }

  const requestIdempotencyKey = String(idempotencyKey || '').trim().slice(0, 200);
  const runId = newRunId(task.id);
  const leaseMs = parsePositiveInt(process.env.GOOSE_EXECUTION_LEASE_MS, 900000);
  let leaseAttempt;
  try {
    leaseAttempt = acquireTaskExecutionLease({
      taskId: task.id,
      runId,
      idempotencyKey: requestIdempotencyKey,
      owner: 'gooseRunner',
      leaseMs
    });
  } catch (error) {
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> lease acquisition failed: ${String(error?.message || error)}`
    );
    return;
  }
  if (!leaseAttempt.acquired) {
    const reason = leaseAttempt.reason === 'idempotent-replay' ? 'idempotent replay' : 'already running';
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> execution lease not acquired (${reason}); active run=${leaseAttempt.lease?.runId || 'unknown'}.`
    );
    return;
  }

  let leaseReleased = false;
  const releaseLease = (status) => {
    if (leaseReleased) return;
    leaseReleased = true;
    releaseTaskExecutionLease({
      taskId: task.id,
      runId,
      status
    });
  };

  const heartbeatEveryMs = Math.min(
    Math.max(parsePositiveInt(process.env.GOOSE_EXECUTION_LEASE_HEARTBEAT_MS, Math.floor(leaseMs / 3)), 5000),
    Math.max(5000, leaseMs - 1000)
  );
  let leaseOwnershipLost = false;
  let leaseHeartbeatLostLogged = false;
  let leaseHeartbeatDbErrorLogged = false;
  const leaseHeartbeat = setInterval(() => {
    let ok = false;
    try {
      ok = heartbeatTaskExecutionLease({ taskId: task.id, runId, leaseMs });
    } catch (error) {
      if (!leaseHeartbeatDbErrorLogged) {
        leaseHeartbeatDbErrorLogged = true;
        emitLine(broadcast, task.id, `${primaryName}> lease heartbeat DB error: ${String(error?.message || error)}`);
      }
      return;
    }
    leaseHeartbeatDbErrorLogged = false;
    if (ok) return;
    leaseOwnershipLost = true;
    if (activeRuns.get(task.id)?.runId === runId) activeRuns.delete(task.id);
    releaseLease('lost');
    if (!leaseHeartbeatLostLogged) {
      leaseHeartbeatLostLogged = true;
      emitLine(broadcast, task.id, `${primaryName}> lease heartbeat lost ownership; suppressing stale updates for this run.`);
    }
  }, heartbeatEveryMs);

  activeRuns.set(task.id, { startedAt: Date.now(), runId });
  const isCurrentRun = () => !leaseOwnershipLost && activeRuns.get(task.id)?.runId === runId;
  const clearRunIfCurrent = () => {
    if (!isCurrentRun()) return;
    activeRuns.delete(task.id);
  };
  const updateTaskStatusIfCurrent = (patch) => {
    if (!isCurrentRun()) return null;
    const next = updateTask(task.id, patch);
    broadcast({ type: 'task_status', task: next });
    return next;
  };
  emitLine(broadcast, task.id, `${primaryName}> assigned as primary agent for task ${task.id}.`);

  const running = updateTaskStatusIfCurrent({ runtimeStatus: 'running' });
  if (!running) {
    clearInterval(leaseHeartbeat);
    releaseLease('cancelled');
    return;
  }

  const realGooseEnabled = process.env.GOOSE_REAL !== '0';
  if (!realGooseEnabled) {
    emitLine(broadcast, task.id, `${primaryName}> GOOSE_REAL=0 detected. Using mock runner.`);
    await runMockGoose(task, broadcast);
    clearRunIfCurrent();
    clearInterval(leaseHeartbeat);
    releaseLease('completed');
    return;
  }

  const gooseEnv = mergePluginEnv(buildGooseEnv(), plugins);
  const gooseBridge = resolveGooseBridgeConfig();
  const runningInContainer = isRunningInContainer();
  const forceLocalInContainer = toBoolEnv(process.env.GOOSE_LOCAL_IN_CONTAINER, false);
  const bridgeOnlyMode = runningInContainer && !forceLocalInContainer;
  const useBridge = !forceLocalInContainer && (bridgeOnlyMode || gooseBridge.enabled);
  if (bridgeOnlyMode) {
    emitLine(broadcast, task.id, `${primaryName}> runtime detected as container; bridge-only goose execution enabled.`);
  } else if (runningInContainer && forceLocalInContainer) {
    emitLine(broadcast, task.id, `${primaryName}> runtime detected as container; local Goose execution mode enabled.`);
  }
  if (bridgeOnlyMode && !gooseBridge.enabled) {
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> bridge-only mode requires GOOSE_BRIDGE_URL/GOOSE_BRIDGE_URLS, but none are configured; marking task failed.`
    );
    updateTaskStatusIfCurrent({ status: 'triage', runtimeStatus: 'failed' });
    clearRunIfCurrent();
    clearInterval(leaseHeartbeat);
    releaseLease('failed');
    return;
  }
  const allowMockFallback = shouldAllowMockFallback();
  const gooseProbe = useBridge
    ? await probeGooseBridge(gooseBridge).catch((error) => ({ ok: false, reason: String(error?.message || error) }))
    : await new Promise((resolve) => {
        const child = spawn('goose', ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: gooseEnv
        });
        let err = '';
        child.stderr.on('data', (chunk) => {
          err += chunk.toString();
        });
        child.on('error', (error) => resolve({ ok: false, reason: String(error?.message || error) }));
        child.on('close', (code) => resolve({ ok: code === 0, reason: err.trim() }));
      });

  if (!gooseProbe.ok) {
    const detail = gooseProbe.reason ? ` (${gooseProbe.reason.slice(0, 220)})` : '';
    const candidates = (gooseBridge.urls || []).length ? ` candidates=[${gooseBridge.urls.join(', ')}]` : '';
    if (!allowMockFallback) {
      emitLine(
        broadcast,
        task.id,
        `${primaryName}> Goose CLI probe failed${detail}${candidates}; strict mode active (GOOSE_ALLOW_MOCK_FALLBACK=0), marking task failed.`
      );
      updateTaskStatusIfCurrent({ status: 'triage', runtimeStatus: 'failed' });
      clearRunIfCurrent();
      clearInterval(leaseHeartbeat);
      releaseLease('failed');
      return;
    }
    emitLine(broadcast, task.id, `${primaryName}> Goose CLI probe failed${detail}; switching to mock runner.`);
    await runMockGoose(task, broadcast);
    clearRunIfCurrent();
    clearInterval(leaseHeartbeat);
    releaseLease('completed');
    return;
  }

  const extensionArgs = buildExtensionArgs(plugins);
  const agent = parseAgentPlugin(plugins);
  let workingDirectory = process.cwd();
  let projectToken = '';
  try {
    if (project) {
      const repo = await ensureProjectRepoReady(project, (line) => emitLine(broadcast, task.id, line), {
        preferredBranch: task.baseBranch
      });
      workingDirectory = repo.repoPath;
      projectToken = repo.githubToken || '';
      const nextBranch = await ensureTaskBranch(repo, task, (line) => emitLine(broadcast, task.id, line));
      if (nextBranch !== task.branchName) {
        updateTaskStatusIfCurrent({ branchName: nextBranch });
      }
      emitLine(broadcast, task.id, `repo> goose cwd set to ${workingDirectory}`);
    } else {
      emitLine(broadcast, task.id, 'repo> no project repo configured; using server cwd');
    }
  } catch (error) {
    updateTaskStatusIfCurrent({ runtimeStatus: 'failed', status: 'todo' });
    emitLine(broadcast, task.id, `repo> setup failed: ${String(error?.message || error)}`);
    clearRunIfCurrent();
    clearInterval(leaseHeartbeat);
    releaseLease('failed');
    return;
  }

  emitLine(broadcast, task.id, `${primaryName}> executing real CLI run...`);
  emitLine(broadcast, task.id, `${primaryName}> cwd: ${workingDirectory}`);
  emitLine(broadcast, task.id, `${primaryName}> git mode: Goose-owned workflow (fetch/pull/commit/push/PR)`);
  emitLine(broadcast, task.id, `${primaryName}> plugin extensions: ${extensionArgs.length ? 'enabled' : 'none'}`);
  const verboseStream = toBoolEnv(process.env.GOOSE_VERBOSE_STREAM, true);
  const heartbeatEnabled = true;
  const heartbeatMs = parsePositiveInt(process.env.GOOSE_HEARTBEAT_MS, 700);
  const activityPulseEnabled = true;
  const activityPulseMs = parsePositiveInt(process.env.GOOSE_ACTIVITY_PULSE_MS, 900);
  if (verboseStream) {
    emitLine(broadcast, task.id, `${primaryName}> verbose stream logging enabled (raw events + summaries).`);
  }

  const limits = resolveGooseLimits(task);
  if (limits.expedited) {
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> expedited limits for ${limits.matchedKey}: maxTurns=${limits.maxTurns}, maxToolRepetitions=${limits.maxToolRepetitions}, timeoutMs=${limits.timeoutMs}`
    );
  } else {
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> standard limits: maxTurns=${limits.maxTurns}, maxToolRepetitions=${limits.maxToolRepetitions}, timeoutMs=${limits.timeoutMs}, taskKeys=${limits.taskKeys.join('|') || 'none'}`
    );
  }
  const buildDirectArgs = (promptText) => {
    const promptWithPolicy = withSmartCodeExecutionPrompt(promptText, 'default');
    const promptForExecution = compactExecutionPrompt(promptWithPolicy, 'default');
    const args = [
      'run',
      '--no-session',
      ...(toBoolEnv(process.env.GOOSE_NO_PROFILE, false) ? ['--no-profile'] : []),
      '--output-format',
      'stream-json',
      '--max-turns',
      String(limits.maxTurns),
      '--max-tool-repetitions',
      String(limits.maxToolRepetitions),
      ...(resolveForcedBuiltins().length ? ['--with-builtin', resolveForcedBuiltins().join(',')] : []),
      ...extensionArgs,
      '--text',
      promptForExecution
    ];
    if (agent.useDeviceConfig === false) {
      if (agent.provider) args.push('--provider', agent.provider);
      if (agent.model) args.push('--model', agent.model);
    }
    return args;
  };
  let directPrompt = hydratedPrompt;
  const primaryThinkingTicker = startThinkingTicker({ broadcast, taskId: task.id, agentName: primaryName, intervalMs: 700 });
  const env = { ...gooseEnv };
  if (projectToken && !env.GITHUB_PERSONAL_ACCESS_TOKEN) env.GITHUB_PERSONAL_ACCESS_TOKEN = projectToken;
  if (projectToken && !env.GITHUB_TOKEN) env.GITHUB_TOKEN = projectToken;
  const authReadyEnv = injectGitHubAuthForGit(env, projectToken);
  emitLine(broadcast, task.id, `repo> git https auth injected: ${projectToken ? 'yes' : 'no'}`);
  let runStartHead = '';
  const startHeadRes = await runSpawn('git', ['-C', workingDirectory, 'rev-parse', 'HEAD'], { cwd: workingDirectory, env: authReadyEnv });
  if (startHeadRes.code === 0) {
    runStartHead = String(startHeadRes.out || '').trim();
    emitLine(broadcast, task.id, `repo> run start HEAD: ${runStartHead.slice(0, 12)}`);
  } else {
    emitLine(
      broadcast,
      task.id,
      `repo> unable to resolve run start HEAD (code=${startHeadRes.code}): ${String(startHeadRes.err || startHeadRes.out || '')
        .trim()
        .slice(0, 220)}`
    );
  }

  if (!isCurrentRun()) {
    clearInterval(primaryThinkingTicker);
    clearInterval(leaseHeartbeat);
    releaseLease('cancelled');
    return;
  }

  const completeSuccessfulRun = async (outputLines) => {
    if (!isCurrentRun()) return;
    if (needsApprovalFromOutput(outputLines)) {
      emitLine(broadcast, task.id, `${primaryName}> waiting for user approval/clarification before proceeding.`);
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'waiting_for_approval' });
      return;
    }

    const changes = await detectMeaningfulTaskChanges({
      workingDirectory,
      env: authReadyEnv,
      baseBranch: String(task.baseBranch || process.env.GOOSE_TEST_BRANCH || 'test').trim(),
      runStartHead
    });
    const requireTaskChanges = toBoolEnv(process.env.GOOSE_REQUIRE_NON_ARTIFACT_CHANGES, true);
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> change-detection: all=${changes.all.length} meaningful=${changes.meaningful.length} artifactOnly=${changes.artifactOnly.length}`
    );
    if (changes.meaningful.length) {
      emitLine(broadcast, task.id, `${primaryName}> meaningful changes: ${changes.meaningful.join(', ')}`);
    }
    if (requireTaskChanges && !runStartHead) {
      emitLine(broadcast, task.id, `${primaryName}> missing run-start HEAD; refusing no-op success path.`);
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
      return;
    }
    if (requireTaskChanges && changes.meaningful.length === 0) {
      emitLine(
        broadcast,
        task.id,
        `${primaryName}> no non-artifact task changes detected (artifact-only: ${
          changes.artifactOnly.length ? changes.artifactOnly.join(', ') : 'none'
        }); failing run.`
      );
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
      return;
    }

    if (!updateTaskStatusIfCurrent({ runtimeStatus: 'build_running' })) return;
    const validation = await runValidationGate({
      task,
      workingDirectory,
      env: authReadyEnv,
      broadcast
    });
    if (!isCurrentRun()) return;
    if (!validation.ok) {
      const failedStatus = validation.reason === 'build-failed' ? 'build_failed' : 'failed';
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: failedStatus });
      return;
    }
    if (!updateTaskStatusIfCurrent({ runtimeStatus: 'build_success' })) return;
    const commit = await autoCommitIfDirty({
      task,
      workingDirectory,
      env: authReadyEnv,
      broadcast,
      label: 'repo',
      commitMessage: `chore(goose): finalize task ${task.id}`
    });
    if (!isCurrentRun()) return;
    if (!commit.ok) {
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
      return;
    }

    if (task.assigneeType === 'goose' && project && (project.autoPr || project.autoMerge)) {
      const mergeTarget = process.env.GOOSE_TEST_BRANCH || 'test';
      const prTarget = String(task.baseBranch || project.defaultBranch || 'main').trim() || 'main';
      try {
        const repo = await ensureProjectRepoReady(project, (line) => emitLine(broadcast, task.id, line), {
          preferredBranch: task.baseBranch
        });
        if (!isCurrentRun()) return;
        let prResult = null;
        if (project.autoPr) {
          try {
            prResult = await autoCreatePullRequest(repo, task, (line) => emitLine(broadcast, task.id, line), prTarget);
          } catch (error) {
            emitLine(broadcast, task.id, `repo> auto-pr failed: ${summarizePrError(error)}`);
          }
        }

        const fallbackMergeBecauseNoCommits = Boolean(project.autoPr && !project.autoMerge && prResult?.skipped && prResult?.reason === 'no-commits');
        const shouldAutoMerge = Boolean(project.autoMerge || fallbackMergeBecauseNoCommits);
        if (fallbackMergeBecauseNoCommits) {
          emitLine(
            broadcast,
            task.id,
            `repo> PR skipped due to no-commits; applying fallback auto-merge flow to ${mergeTarget}.`
          );
        }

        if (shouldAutoMerge) {
          await autoMergeTaskBranchToTest(repo, task, (line) => emitLine(broadcast, task.id, line), mergeTarget);
          if (!isCurrentRun()) return;
          updateTaskStatusIfCurrent({ status: 'done', runtimeStatus: 'success' });
        } else {
          updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'success' });
        }
      } catch (error) {
        emitLine(broadcast, task.id, `repo> post-run automation failed: ${String(error?.message || error)}`);
        updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
      }
      return;
    }

    updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'success' });
  };

  const orchestrateEnabled = toBoolEnv(process.env.GOOSE_ENABLE_SUBAGENTS, false);
  let orchestrationAttempted = false;
  let forceStrictToolJsonDirectMode = false;
  if (orchestrateEnabled && !isOrchestrationCircuitOpen()) {
    orchestrationAttempted = true;
    const maxOrchestrationAttempts = parsePositiveInt(process.env.GOOSE_ORCHESTRATION_MAX_ATTEMPTS, 1);
    let orchestrationFailed = false;
    let orchestrationError = '';
    for (let attempt = 1; attempt <= maxOrchestrationAttempts; attempt += 1) {
      if (!isCurrentRun()) {
        clearInterval(leaseHeartbeat);
        releaseLease('cancelled');
        return;
      }
      try {
        const orchestrated = await runOrchestratedGoose({
          task,
          limits,
          extensionArgs,
          agent,
          env: authReadyEnv,
          workingDirectory,
          broadcast,
          primaryName
        });
        if (!orchestrated.handled) {
          markOrchestrationSuccess();
          break;
        }
        emitLine(
          broadcast,
          task.id,
          `${primaryName}> orchestrated run exited code=${orchestrated.code} (attempt ${attempt}/${maxOrchestrationAttempts})`
        );
        if (orchestrated.code === 0) {
          markOrchestrationSuccess();
          clearInterval(primaryThinkingTicker);
          await completeSuccessfulRun(orchestrated.outputLines);
          clearRunIfCurrent();
          clearInterval(leaseHeartbeat);
          releaseLease('completed');
          return;
        }
        if (orchestrated.code === 9) {
          orchestrationFailed = true;
          orchestrationError = String(orchestrated.reason || 'orchestration-instability');
          if (orchestrated.reason === 'tool_instability') {
            forceStrictToolJsonDirectMode = true;
            emitLine(
              broadcast,
              task.id,
              `${primaryName}> detected repeated malformed/stalled tool calls in subagents; switching directly to strict single-agent mode.`
            );
          } else if (orchestrated.reason === 'scope_drift') {
            emitLine(
              broadcast,
              task.id,
              `${primaryName}> detected repeated scope drift across subagents; switching to direct single-agent mode.`
            );
          } else {
            emitLine(
              broadcast,
              task.id,
              `${primaryName}> detected repeated orchestration instability; switching to direct single-agent mode.`
            );
          }
          break;
        }
        orchestrationFailed = true;
        orchestrationError = `exit=${orchestrated.code}`;
      } catch (error) {
        orchestrationFailed = true;
        orchestrationError = String(error?.message || error);
        emitLine(
          broadcast,
          task.id,
          `${primaryName}> orchestrated run failed (attempt ${attempt}/${maxOrchestrationAttempts}): ${orchestrationError}`
        );
      }
      if (attempt < maxOrchestrationAttempts) {
        const waitMs = computeBackoffMs(
          attempt,
          parsePositiveInt(process.env.GOOSE_ORCHESTRATION_RETRY_BASE_MS, 900),
          parsePositiveInt(process.env.GOOSE_ORCHESTRATION_RETRY_MAX_MS, 7000)
        );
        emitLine(broadcast, task.id, `${primaryName}> retrying orchestration in ${waitMs}ms.`);
        // jittered retry prevents synchronized failure storms.
        // eslint-disable-next-line no-await-in-loop
        await sleep(waitMs);
      }
    }
    if (orchestrationFailed) {
      markOrchestrationFailure();
      const remainingMs = Math.max(0, Number(orchestrationCircuit.openUntil || 0) - Date.now());
      if (remainingMs > 0) {
        emitLine(
          broadcast,
          task.id,
          `${primaryName}> orchestration circuit opened for ${Math.ceil(remainingMs / 1000)}s after repeated failures (${orchestrationError || 'unknown'}).`
        );
      } else {
        emitLine(
          broadcast,
          task.id,
          `${primaryName}> orchestration failed after retries (${orchestrationError || 'unknown'}), falling back to single-agent execution path.`
        );
      }
    }
  } else if (orchestrateEnabled && isOrchestrationCircuitOpen()) {
    orchestrationAttempted = true;
    const remainingMs = Math.max(0, Number(orchestrationCircuit.openUntil || 0) - Date.now());
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> orchestration circuit open; skipping subagents for ${Math.ceil(remainingMs / 1000)}s and using single-agent mode.`
    );
  }

  if (orchestrationAttempted) {
    emitLine(broadcast, task.id, `${primaryName}> continuing with direct goose run (orchestration fallback mode).`);
  }
  if (forceStrictToolJsonDirectMode) {
    directPrompt = buildStrictToolJsonPrompt(hydratedPrompt);
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> direct mode strict tool-call JSON policy enabled after orchestration instability.`
    );
  }

  if (!isCurrentRun()) {
    clearInterval(primaryThinkingTicker);
    clearInterval(leaseHeartbeat);
    releaseLease('cancelled');
    return;
  }

  const args = buildDirectArgs(directPrompt);
  const logArgs = [...args];
  const textIdx = logArgs.indexOf('--text');
  if (textIdx >= 0 && textIdx + 1 < logArgs.length) logArgs[textIdx + 1] = `<hydrated_prompt:${directPrompt.length} chars>`;
  emitLine(broadcast, task.id, `${primaryName}> command: goose ${logArgs.join(' ')}`);

  if (useBridge) {
    const timeoutMs = limits.timeoutMs;
    const noOutputTimeoutMs = parsePositiveInt(process.env.GOOSE_NO_OUTPUT_TIMEOUT_MS, 120000);
    const mappedCwd = mapCwdForGooseBridge(workingDirectory, gooseBridge);
    if (mappedCwd !== workingDirectory) {
      emitLine(broadcast, task.id, `${primaryName}> goose bridge cwd map: ${workingDirectory} -> ${mappedCwd}`);
    }
    emitLine(
      broadcast,
      task.id,
      `${primaryName}> goose bridge: ${gooseBridge.url || gooseBridge.urls?.[0] || 'unresolved'} (candidates: ${(gooseBridge.urls || []).join(', ')})`
    );
    let eventSeq = 0;
    let currentPhase = 'starting';
    let phaseUpdatedAt = Date.now();
    const setPhase = (phase) => {
      const next = String(phase || '').trim();
      if (!next || next === currentPhase) return;
      currentPhase = next;
      phaseUpdatedAt = Date.now();
      emitLine(broadcast, task.id, `${primaryName}> phase: ${next}`);
    };
    const startedAt = Date.now();
    const outputLines = [];
    setPhase('waiting_for_events');
    const activityPulseMs = parsePositiveInt(process.env.GOOSE_ACTIVITY_PULSE_MS, 900);
    const activityPulse = setInterval(() => {
      const idleSec = Math.floor((Date.now() - phaseUpdatedAt) / 1000);
      emitLine(broadcast, task.id, `${primaryName}> ${randomThinkingMessage()} phase=${currentPhase} events=${eventSeq} idle=${idleSec}s`);
    }, activityPulseMs);
    const bridgeResult = await runGooseThroughBridge({
      bridgeConfig: gooseBridge,
      args,
      cwd: mappedCwd,
      env: authReadyEnv,
      timeoutMs,
      noOutputTimeoutMs,
      onStdoutLine: (line) => {
        const parsed = parseJsonLine(line);
        if (!parsed) {
          outputLines.push(line);
          emitLine(broadcast, task.id, `${primaryName}(stdout)> ${line}`);
          if (String(line).includes('new session')) setPhase('session_started');
          return;
        }
        eventSeq += 1;
        setPhase(inferGoosePhaseFromPayload(parsed));
        const assistantLines = extractAssistantReplyLines(parsed);
        const event = formatGooseStreamEvent(parsed);
        const deepFallbackLines = Array.from(new Set(collectTextLinesDeep(parsed).filter(Boolean)))
          .map((text) => String(text || '').replace(/\r/g, '').trim())
          .filter((text) => text.length > 1)
          .slice(0, 24);
        const responseLines = assistantLines.length
          ? assistantLines
          : event.approvalText.map((text) => String(text || '').trim()).filter(Boolean).slice(0, 80);
        const finalResponseLines = responseLines.length ? responseLines : deepFallbackLines;
        for (const item of finalResponseLines) {
          emitConversation({ broadcast, taskId: task.id, from: primaryName, to: `${BOSS_NAME} (Boss)`, text: item });
        }
        for (const text of finalResponseLines) outputLines.push(text);
        for (const text of event.approvalText) outputLines.push(text);
        for (const rendered of event.logLines) emitLine(broadcast, task.id, `${primaryName}(event:${eventSeq})> ${rendered}`);
      },
      onStderrLine: (line) => {
        outputLines.push(`stderr> ${line}`);
        emitLine(broadcast, task.id, `stderr> ${line}`);
      }
    }).catch((error) => ({ code: 1, reason: String(error?.message || error) }));

    clearInterval(activityPulse);
    const durationSec = Math.floor((Date.now() - startedAt) / 1000);
    setPhase(bridgeResult.code === 0 ? 'completed' : 'failed');
    emitLine(broadcast, task.id, `${primaryName}> process exited code=${bridgeResult.code} after ${durationSec}s`);
    if (bridgeResult.code !== 0) {
      const detail = bridgeResult.reason ? ` (${String(bridgeResult.reason).slice(0, 220)})` : '';
      emitLine(broadcast, task.id, `${primaryName}> bridge run failed${detail}`);
      updateTaskStatusIfCurrent({ status: 'triage', runtimeStatus: 'failed' });
      clearInterval(primaryThinkingTicker);
      clearInterval(leaseHeartbeat);
      releaseLease('failed');
      clearRunIfCurrent();
      return;
    }
    clearInterval(primaryThinkingTicker);
    await completeSuccessfulRun(outputLines).catch((error) => {
      emitLine(broadcast, task.id, `${primaryName}> completion pipeline failed: ${String(error?.message || error)}`);
      updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
    });
    clearInterval(leaseHeartbeat);
    releaseLease('completed');
    clearRunIfCurrent();
    return;
  }

  const child = spawn('goose', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: authReadyEnv,
    cwd: workingDirectory
  });
  const currentRun = activeRuns.get(task.id) || {};
  activeRuns.set(task.id, { ...currentRun, child, runId });

  const timeoutMs = limits.timeoutMs;
  const noOutputTimeoutMs = parsePositiveInt(process.env.GOOSE_NO_OUTPUT_TIMEOUT_MS, 120000);
  const initialNoOutputTimeoutMs = parsePositiveInt(process.env.GOOSE_INITIAL_NO_OUTPUT_TIMEOUT_MS, 360000);
  let closed = false;
  let timedOut = false;
  let stalled = false;
  let terminating = false;
  let forceKillTimer = null;
  let eventSeq = 0;
  let currentPhase = 'starting';
  let phaseUpdatedAt = Date.now();
  const setPhase = (phase) => {
    const next = String(phase || '').trim();
    if (!next || next === currentPhase) return;
    currentPhase = next;
    phaseUpdatedAt = Date.now();
    emitLine(broadcast, task.id, `${primaryName}> phase: ${next}`);
  };
  const terminateProcess = (reasonLine, reasonFlag) => {
    if (terminating || closed) return;
    terminating = true;
    if (reasonFlag === 'timeout') timedOut = true;
    if (reasonFlag === 'stalled') stalled = true;
    emitLine(broadcast, task.id, reasonLine);
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (closed) return;
      emitLine(broadcast, task.id, `${primaryName}> process did not exit after SIGTERM, sending SIGKILL.`);
      child.kill('SIGKILL');
    }, 5000);
  };
  const timeout = setTimeout(() => {
    terminateProcess(`${primaryName}> timeout after ${timeoutMs}ms, terminating process.`, 'timeout');
  }, timeoutMs);

  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  const heartbeat = heartbeatEnabled
    ? setInterval(() => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        const silenceMs = Date.now() - lastOutputAt;
        const waitingForFirstEvent = eventSeq === 0 && (currentPhase === 'waiting_for_events' || currentPhase === 'session_started');
        const activeNoOutputLimitMs = waitingForFirstEvent ? Math.max(noOutputTimeoutMs, initialNoOutputTimeoutMs) : noOutputTimeoutMs;
        if (activeNoOutputLimitMs > 0 && silenceMs >= activeNoOutputLimitMs) {
          terminateProcess(
            `${primaryName}> no stdout/stderr output for ${Math.floor(silenceMs / 1000)}s (limit ${Math.floor(
              activeNoOutputLimitMs / 1000
            )}s), terminating process.`,
            'stalled'
          );
          return;
        }
        emitLine(broadcast, task.id, `${primaryName}> ${randomThinkingMessage()} (${seconds}s elapsed)`);
      }, heartbeatMs)
    : null;

  const outputLines = [];
  setPhase('waiting_for_events');
  const activityPulse = activityPulseEnabled
    ? setInterval(() => {
        const idleSec = Math.floor((Date.now() - phaseUpdatedAt) / 1000);
        emitLine(broadcast, task.id, `${primaryName}> ${randomThinkingMessage()} phase=${currentPhase} events=${eventSeq} idle=${idleSec}s`);
      }, activityPulseMs)
    : null;
  pumpStream(child.stdout, (line) => {
    lastOutputAt = Date.now();
    const parsed = parseJsonLine(line);
    if (!parsed) {
      outputLines.push(line);
      emitLine(broadcast, task.id, `${primaryName}(stdout)> ${line}`);
      if (String(line).includes('new session')) setPhase('session_started');
      return;
    }
    eventSeq += 1;
    setPhase(inferGoosePhaseFromPayload(parsed));
    const assistantLines = extractAssistantReplyLines(parsed);
    const event = formatGooseStreamEvent(parsed);
    const deepFallbackLines = Array.from(new Set(collectTextLinesDeep(parsed).filter(Boolean)))
      .map((text) => String(text || '').replace(/\r/g, '').trim())
      .filter((text) => text.length > 1)
      .slice(0, 24);
    const responseLines = assistantLines.length
      ? assistantLines
      : event.approvalText.map((text) => String(text || '').trim()).filter(Boolean).slice(0, 80);
    const finalResponseLines = responseLines.length ? responseLines : deepFallbackLines;
    for (const item of finalResponseLines) {
      emitConversation({ broadcast, taskId: task.id, from: primaryName, to: `${BOSS_NAME} (Boss)`, text: item });
    }
    for (const text of finalResponseLines) outputLines.push(text);
    if (verboseStream) {
      emitLine(broadcast, task.id, `${primaryName}(raw:${eventSeq})> ${compactJson(parsed)}`);
    }
    for (const text of event.approvalText) outputLines.push(text);
    for (const rendered of event.logLines) emitLine(broadcast, task.id, `${primaryName}(event:${eventSeq})> ${rendered}`);
  });
  pumpStream(child.stderr, (line) => {
    lastOutputAt = Date.now();
    outputLines.push(`stderr> ${line}`);
    emitLine(broadcast, task.id, `stderr> ${line}`);
  });

  child.on('error', () => {
    if (!isCurrentRun()) return;
    closed = true;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (activityPulse) clearInterval(activityPulse);
    clearInterval(primaryThinkingTicker);
    if (!allowMockFallback) {
      emitLine(
        broadcast,
        task.id,
        `${primaryName}> process spawn failed; strict mode active (GOOSE_ALLOW_MOCK_FALLBACK=0), marking task failed.`
      );
      updateTaskStatusIfCurrent({ status: 'triage', runtimeStatus: 'failed' });
      clearInterval(leaseHeartbeat);
      releaseLease('failed');
      clearRunIfCurrent();
      return;
    }
    emitLine(broadcast, task.id, `${primaryName}> process spawn failed, switching to mock runner.`);
    void runMockGoose(task, broadcast).finally(() => {
      clearInterval(leaseHeartbeat);
      releaseLease('failed');
      clearRunIfCurrent();
    });
  });

  child.on('close', (code) => {
    if (!isCurrentRun()) return;
    closed = true;
    clearTimeout(timeout);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (activityPulse) clearInterval(activityPulse);
    clearInterval(primaryThinkingTicker);
    const durationSec = Math.floor((Date.now() - startedAt) / 1000);
    setPhase(code === 0 ? 'completed' : 'failed');
    emitLine(broadcast, task.id, `${primaryName}> process exited code=${code} after ${durationSec}s`);
    if (code !== 0) {
      updateTaskStatusIfCurrent({
        status: timedOut || stalled ? 'todo' : 'triage',
        runtimeStatus: 'failed'
      });
      clearInterval(leaseHeartbeat);
      releaseLease('failed');
      clearRunIfCurrent();
      return;
    }
    completeSuccessfulRun(outputLines)
      .catch((error) => {
        emitLine(broadcast, task.id, `${primaryName}> completion pipeline failed: ${String(error?.message || error)}`);
        updateTaskStatusIfCurrent({ status: 'review', runtimeStatus: 'failed' });
        releaseLease('failed');
      })
      .finally(() => {
        clearInterval(leaseHeartbeat);
        if (!leaseReleased) releaseLease('completed');
        clearRunIfCurrent();
      });
  });
}
