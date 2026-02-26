import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOOL_CALL_PATTERN = /TOOL_CALL:\s*(\{[\s\S]*\})/i;

const defaultShellTool = {
  name: 'shell',
  description: 'Run shell commands on the project workspace',
  async run({ command, cwd }) {
    if (!command) return 'no command provided';
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    return new Promise((resolve, reject) => {
      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        const output = stdout.trim();
        const errOut = stderr.trim();
        if (code === 0) {
          resolve(output || '(no stdout)');
        } else {
          resolve(`exit ${code}: ${errOut || output || 'no output'}`);
        }
      });
    });
  }
};

const defaultFileReadTool = {
  name: 'file_read',
  description: 'Read workspace files',
  async run({ path: filePath, baseDir }) {
    if (!filePath) return 'no path provided';
    const safeBase = String(baseDir || process.cwd());
    const resolved = path.resolve(safeBase, filePath);
    if (!resolved.startsWith(safeBase)) return 'access denied';
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (error) {
      return `error reading file: ${String(error?.message || error)}`;
    }
  }
};

function parseToolCall(text) {
  if (!text) return null;
  const match = TOOL_CALL_PATTERN.exec(text);
  if (!match) return null;
  const raw = String(match[1] || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return null;
  const payloadRaw = raw.slice(start, end + 1);
  try {
    const payload = JSON.parse(payloadRaw);
    return {
      toolName: payload.name,
      args: payload.args || {}
    };
  } catch {
    return null;
  }
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truncateText(value, maxChars) {
  const max = parsePositiveInt(maxChars, 1600);
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, max)}...` : raw;
}

function normalizeFinalReply(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutToolCall = raw.split(/TOOL_CALL:/i)[0].trim();
  const withoutFence = withoutToolCall.replace(/```[\s\S]*?```/g, '').trim();
  const compact = withoutFence.replace(/\s+/g, ' ').trim();
  return truncateText(compact, process.env.CUSTOM_AGENT_MAX_FINAL_CHARS || 1200);
}

function extractKeywords(value, limit = 12) {
  const seen = new Set();
  const out = [];
  const tokens = String(value || '')
    .toLowerCase()
    .match(/[a-z0-9_/-]{3,}/g);
  for (const token of tokens || []) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

function looksOnTopic(finalReply, taskHint, toolCalls) {
  if (!finalReply) return false;
  if ((toolCalls || []).length > 0) return true;
  const hay = finalReply.toLowerCase();
  const keywords = extractKeywords(taskHint, 12);
  if (!keywords.length) return true;
  return keywords.some((k) => hay.includes(k));
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return '';
  return baseUrl.replace(/\/+$/, '');
}

function resolveCandidateEndpoints(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl) || 'https://api.openai.com';
  const lower = normalized.toLowerCase();
  const out = [];

  // Kilo Gateway docs use base + /chat/completions (no /v1 prefix).
  if (lower.includes('api.kilo.ai/api/gateway')) {
    out.push(`${normalized}/chat/completions`);
  }

  if (normalized.endsWith('/v1')) {
    out.push(`${normalized}/chat/completions`);
  } else {
    out.push(`${normalized}/v1/chat/completions`);
    out.push(`${normalized}/chat/completions`);
  }

  return Array.from(new Set(out));
}

async function parseErrorSnippet(response) {
  try {
    const body = await response.text();
    if (!body) return '';
    return body.slice(0, 300);
  } catch {
    return '';
  }
}

async function callProvider({ url, model, apiKey, messages, onTrace }) {
  if (String(url || '').startsWith('mock://')) {
    onTrace?.(`llm> mock provider request model=${model}`);
    const hasShell = messages.some((msg) => msg?.role === 'tool' && msg?.name === 'shell');
    const hasFileRead = messages.some((msg) => msg?.role === 'tool' && msg?.name === 'file_read');
    if (!hasShell) {
      return 'TOOL_CALL: {"name":"shell","args":{"command":"pwd"}}';
    }
    if (!hasFileRead) {
      return 'TOOL_CALL: {"name":"file_read","args":{"path":"README.md"}}';
    }
    return 'Completed task after tool-assisted analysis. Ready for review.';
  }

  const endpoints = resolveCandidateEndpoints(url);
  const errors = [];
  const timeoutMs = parsePositiveInt(process.env.CUSTOM_AGENT_HTTP_TIMEOUT_MS, 45000);
  for (const endpoint of endpoints) {
    onTrace?.(`llm> request endpoint=${endpoint} model=${model}`);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };
    if (endpoint.includes('api.kilo.ai/api/gateway')) {
      const kiloMode = String(process.env.CUSTOM_AGENT_KILO_MODE || '').trim();
      if (kiloMode) headers['x-kilocode-mode'] = kiloMode;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3
        }),
        keepalive: true,
        signal: controller.signal
      });
    } catch (error) {
      onTrace?.(`llm> network_error endpoint=${endpoint} message=${String(error?.message || error)}`);
      errors.push(`${endpoint} -> network error: ${String(error?.message || error)}`);
      clearTimeout(timer);
      continue;
    }
    clearTimeout(timer);
    if (!res.ok) {
      const detail = await parseErrorSnippet(res);
      onTrace?.(`llm> response endpoint=${endpoint} status=${res.status}${detail ? ` detail=${detail}` : ''}`);
      errors.push(`${endpoint} -> ${res.status}${detail ? `: ${detail}` : ''}`);
      continue;
    }
    const payload = await res.json();
    const usage = payload?.usage
      ? ` prompt=${payload.usage.prompt_tokens ?? '?'} completion=${payload.usage.completion_tokens ?? '?'} total=${payload.usage.total_tokens ?? '?'}`
      : '';
    onTrace?.(`llm> response endpoint=${endpoint} status=${res.status}${usage}`);
    return payload.choices?.[0]?.message?.content || '';
  }

  throw new Error(`LLM request failed. Tried endpoints: ${errors.join(' | ')}`);
}

export function create_agent({ tools = [], model = 'glm-5', api_key, base_url, default_cwd, task_hint = '', on_trace }) {
  if (!api_key) throw new Error('api_key is required');
  const toolset = new Map();
  [defaultShellTool, defaultFileReadTool, ...tools].forEach((tool) => {
    if (!tool?.name || typeof tool.run !== 'function') return;
    toolset.set(tool.name, tool);
  });

  return {
    async ainvoke({ messages = [] }) {
      const history = [...messages];
      const toolCalls = [];
      let loopCount = 0;
      while (loopCount < 8) {
        const assistantOutput = await callProvider({
          url: base_url,
          model,
          apiKey: api_key,
          messages: history,
          onTrace: on_trace
        });
        history.push({ role: 'assistant', content: assistantOutput });
        const toolCall = parseToolCall(assistantOutput);
        if (!toolCall) {
          const final = normalizeFinalReply(assistantOutput);
          if (!looksOnTopic(final, task_hint, toolCalls)) {
            return {
              final:
                'Completed agent run, but final model reply looked off-task. Review tool outputs and rerun with stricter prompt.',
              toolCalls
            };
          }
          return {
            final,
            toolCalls
          };
        }
        const tool = toolset.get(toolCall.toolName);
        if (!tool) {
          history.push({
            role: 'assistant',
            content: `Tool ${toolCall.toolName} not recognized`
          });
          continue;
        }
        const args = { ...toolCall.args };
        if (!args.cwd && default_cwd) args.cwd = default_cwd;
        if (toolCall.toolName === 'file_read' && !args.baseDir) args.baseDir = default_cwd;
        const result = await tool.run(args);
        const toolMessage = {
          role: 'tool',
          name: tool.name,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        };
        history.push(toolMessage);
        toolCalls.push({ tool: tool.name, args, result });
        loopCount += 1;
      }
      return { final: history[history.length - 1].content.trim(), toolCalls };
    }
  };
}
