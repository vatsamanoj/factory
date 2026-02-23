import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { getSchemaTemplate, listSchemaTemplates } from './schemaRegistry.js';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const GITHUB_ME_URL = 'https://api.github.com/user';

function parseCommand(commandString) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(commandString || ''))) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

function validateBySchema(config, schema) {
  const errors = [];
  const input = config && typeof config === 'object' ? config : {};
  const effectiveSchema = schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
  const required = Array.isArray(effectiveSchema.required) ? effectiveSchema.required : [];
  const properties =
    effectiveSchema.properties && typeof effectiveSchema.properties === 'object' ? effectiveSchema.properties : {};

  for (const key of required) {
    const value = input[key];
    if (value === undefined || value === null || value === '') errors.push(`Missing required config: ${key}`);
  }

  for (const [key, descriptor] of Object.entries(properties)) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    const type = descriptor?.type;
    if (type === 'string') {
      if (typeof value !== 'string') errors.push(`Config ${key} must be string`);
      if (descriptor.minLength && String(value).length < descriptor.minLength) {
        errors.push(`Config ${key} must be at least ${descriptor.minLength} chars`);
      }
      if (descriptor.pattern && !new RegExp(descriptor.pattern).test(String(value))) {
        errors.push(`Config ${key} does not match expected format`);
      }
      if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(value)) {
        errors.push(`Config ${key} must be one of: ${descriptor.enum.join(', ')}`);
      }
    }
    if (type === 'boolean' && typeof value !== 'boolean') errors.push(`Config ${key} must be boolean`);
    if (type === 'number' && typeof value !== 'number') errors.push(`Config ${key} must be number`);
    if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      errors.push(`Config ${key} must be object`);
    }
  }

  return errors;
}

async function smokeSpawn(commandString, env, timeoutMs = 1500) {
  const [command, ...args] = parseCommand(commandString);
  if (!command) return { ok: false, message: 'Invalid command' };

  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let settled = false;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ ok: true, message: 'Process booted successfully', stderr: stderr.trim().slice(0, 250) });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, message: String(error?.message || error) });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        message: code === 0 ? 'Command exited successfully' : `Command exited with code ${code}`,
        stderr: stderr.trim().slice(0, 250)
      });
    });
  });
}

async function checkOpenAI(apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, message: `OpenAI auth failed (${res.status})` };
    return { ok: true, message: 'OpenAI connectivity passed' };
  } catch (error) {
    return { ok: false, message: `OpenAI connectivity failed: ${String(error?.message || error)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function checkGooseDefaultProfile() {
  return new Promise((resolve) => {
    const child = spawn(
      'goose',
      ['run', '--no-session', '--text', 'Reply with exactly: OK', '--max-turns', '1', '--quiet'],
      { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', (error) => resolve({ ok: false, message: String(error?.message || error) }));
    child.on('close', (code) => {
      if (code === 0 && out.includes('OK')) resolve({ ok: true, message: 'Device Goose profile connectivity passed' });
      else resolve({ ok: false, message: `Device Goose profile check failed (${code}). ${err.trim().slice(0, 180)}` });
    });
  });
}

async function checkGithub(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(GITHUB_ME_URL, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'goose-c2-dashboard' },
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, message: `GitHub auth failed (${res.status})` };
    return { ok: true, message: 'GitHub connectivity passed' };
  } catch (error) {
    return { ok: false, message: `GitHub connectivity failed: ${String(error?.message || error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function inferSchemaId(plugin) {
  if (plugin.schemaId) return plugin.schemaId;
  if (plugin.type === 'agent' && String(plugin.url || '').startsWith('openai:')) return 'codex_agent';
  if (String(plugin.url || '').includes('mcp-server-github')) return 'github_mcp';
  return '';
}

function normalizeConfig(config) {
  return Object.fromEntries(
    Object.entries(config || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  );
}

export function pluginCatalog() {
  return listSchemaTemplates();
}

export async function validatePluginConnection(input) {
  const plugin = {
    name: String(input?.name || '').trim(),
    type: String(input?.type || 'mcp').trim(),
    url: String(input?.url || '').trim(),
    schemaId: String(input?.schemaId || '').trim(),
    config: input?.config && typeof input.config === 'object' ? input.config : {},
    configSchema: input?.configSchema && typeof input.configSchema === 'object' ? input.configSchema : undefined
  };

  const errors = [];
  if (!plugin.name) errors.push('Plugin name is required.');
  if (!plugin.url && plugin.type !== 'builtin') errors.push('Plugin URL/command is required.');

  const resolvedSchemaId = inferSchemaId(plugin);
  const resolvedSchema =
    plugin.configSchema || getSchemaTemplate(resolvedSchemaId)?.configSchema || { type: 'object', properties: {} };
  errors.push(...validateBySchema(plugin.config, resolvedSchema));

  if (errors.length) {
    return {
      ok: false,
      errors,
      connectivity: { ok: false, message: 'Validation failed before connectivity test.' },
      plugin: { ...plugin, schemaId: resolvedSchemaId, config: normalizeConfig(plugin.config) }
    };
  }

  let connectivity = { ok: true, message: 'No connectivity test required.' };
  if (plugin.type === 'mcp') {
    const env = {};
    if (plugin.config.githubToken) env.GITHUB_PERSONAL_ACCESS_TOKEN = String(plugin.config.githubToken);
    if (plugin.config.env && typeof plugin.config.env === 'object') {
      for (const [k, v] of Object.entries(plugin.config.env)) env[k] = String(v);
    }
    connectivity = await smokeSpawn(plugin.url, env);
    if (connectivity.ok && plugin.config.githubToken) {
      const gh = await checkGithub(String(plugin.config.githubToken));
      connectivity = gh.ok ? connectivity : gh;
    }
  }

  if (plugin.type === 'mcp_http') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const headers = plugin.config.authToken ? { Authorization: `Bearer ${plugin.config.authToken}` } : {};
      const res = await fetch(plugin.url, { method: 'GET', headers, signal: controller.signal });
      connectivity = res.ok
        ? { ok: true, message: `HTTP MCP reachable (${res.status})` }
        : { ok: false, message: `HTTP MCP not reachable (${res.status})` };
    } catch (error) {
      connectivity = { ok: false, message: `HTTP MCP connection failed: ${String(error?.message || error)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  if (plugin.type === 'agent' && String(plugin.url).startsWith('openai:')) {
    if (plugin.config.openaiApiKey) connectivity = await checkOpenAI(String(plugin.config.openaiApiKey));
    else connectivity = await checkGooseDefaultProfile();
  }

  await wait(0);
  return {
    ok: connectivity.ok,
    errors: connectivity.ok ? [] : [connectivity.message],
    connectivity,
    plugin: {
      name: plugin.name,
      type: plugin.type,
      url: plugin.url,
      schemaId: resolvedSchemaId,
      config: normalizeConfig(plugin.config)
    }
  };
}
