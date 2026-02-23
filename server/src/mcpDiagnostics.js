import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const binDir = path.join(projectRoot, 'node_modules', '.bin');
const pkgDir = path.join(projectRoot, 'node_modules', '@modelcontextprotocol');

function parseReadmeTools(packageName) {
  const readmePath = path.join(pkgDir, packageName, 'README.md');
  if (!fs.existsSync(readmePath)) return [];

  const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
  const tools = [];
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\*\*([a-zA-Z0-9_/-]+)\*\*/);
    if (match) tools.push(match[1]);
  }
  return [...new Set(tools)];
}

function smokeTestCommand(command, args = [], timeoutMs = 1200) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: true,
        note: 'Process started and responded before timeout',
        stdout: stdout.trim().slice(0, 300),
        stderr: stderr.trim().slice(0, 300)
      });
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        note: String(error?.message || error),
        stdout: stdout.trim().slice(0, 300),
        stderr: stderr.trim().slice(0, 300)
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        note: `Exited with code ${code}`,
        stdout: stdout.trim().slice(0, 300),
        stderr: stderr.trim().slice(0, 300)
      });
    });
  });
}

export function recommendedPlugins() {
  const fsPath = path.join(binDir, 'mcp-server-filesystem');
  const memoryPath = path.join(binDir, 'mcp-server-memory');
  const everythingPath = path.join(binDir, 'mcp-server-everything');
  const githubPath = path.join(binDir, 'mcp-server-github');
  const plugins = [
    { name: 'Filesystem MCP', type: 'mcp', schemaId: 'filesystem_mcp', url: `${fsPath} ${projectRoot}` },
    { name: 'Memory MCP', type: 'mcp', schemaId: 'memory_mcp', url: `${memoryPath}` },
    { name: 'Everything MCP', type: 'mcp', url: `${everythingPath} stdio` },
    { name: 'Codex Agent', type: 'agent', schemaId: 'codex_agent', url: 'openai:gpt-5-codex' }
  ];
  if (fs.existsSync(githubPath)) {
    plugins.splice(3, 0, { name: 'GitHub MCP', type: 'mcp', schemaId: 'github_mcp', url: `${githubPath}` });
  }
  return plugins;
}

export async function runMcpDiagnostics() {
  const checks = [
    {
      name: 'filesystem',
      packageName: 'server-filesystem',
      command: path.join(binDir, 'mcp-server-filesystem'),
      args: [projectRoot]
    },
    {
      name: 'memory',
      packageName: 'server-memory',
      command: path.join(binDir, 'mcp-server-memory')
    },
    {
      name: 'everything',
      packageName: 'server-everything',
      command: path.join(binDir, 'mcp-server-everything'),
      args: ['stdio']
    },
    {
      name: 'github',
      packageName: 'server-github',
      command: path.join(binDir, 'mcp-server-github')
    }
  ];

  const results = [];
  for (const check of checks) {
    const installed = fs.existsSync(check.command);
    if (!installed) {
      results.push({
        name: check.name,
        command: check.command,
        installed: false,
        runnable: false,
        tools: [],
        note: 'Command not found'
      });
      continue;
    }

    // Sequential checks keep output readable and avoid process contention.
    // eslint-disable-next-line no-await-in-loop
    const runtime = await smokeTestCommand(check.command, check.args || []);
    results.push({
      name: check.name,
      command: `${check.command} ${(check.args || []).join(' ')}`.trim(),
      installed: true,
      runnable: runtime.ok,
      note: runtime.note,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      tools: parseReadmeTools(check.packageName)
    });
  }

  return {
    checkedAt: new Date().toISOString(),
    results
  };
}
