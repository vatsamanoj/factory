import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createCycle,
  createModule,
  createProject,
  createPlugin,
  createPage,
  createTask,
  createView,
  appendTaskLog,
  getAnalyticsSnapshot,
  getProject,
  getTask,
  listTaskLogs,
  listCycles,
  listModules,
  listProjects,
  listPlugins,
  listPages,
  listTasks,
  listViews,
  updateProject,
  updatePage,
  updateTask
} from './db.js';
import { hydratePrompt } from './contextHydrator.js';
import { runGooseExecution } from './gooseRunner.js';
import {
  ensureProjectRepoReady,
  getProjectRepoStatus,
  listProjectBranches,
  readTaskAttachments,
  verifyRepoConnectivity
} from './repoManager.js';
import { runBacklogRefinement } from './backlogRefiner.js';
import { recommendedPlugins, runMcpDiagnostics } from './mcpDiagnostics.js';
import { pluginCatalog, validatePluginConnection } from './pluginGuard.js';
import { createSchemaTemplate, listSchemaTemplates, updateSchemaTemplate } from './schemaRegistry.js';

const app = express();
app.use(cors());
app.use(express.json());

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

function resolveBuildCommand(workingDirectory) {
  try {
    const pkgPath = path.join(workingDirectory, 'package.json');
    if (!fs.existsSync(pkgPath)) return '';
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = parsed && typeof parsed.scripts === 'object' ? parsed.scripts : {};
    if (typeof scripts.build === 'string' && scripts.build.trim()) return 'npm run build';
    return '';
  } catch {
    return '';
  }
}

function resolveIdempotencyKey(req, taskId, action) {
  const headerValue = String(req.get('x-idempotency-key') || '').trim();
  if (headerValue) return headerValue.slice(0, 200);
  if (!Number.isFinite(Number(taskId))) return '';
  return `task-${taskId}:${String(action || 'run')}`;
}

function detectContainerRuntime() {
  if (String(process.env.GOOSE_FORCE_DOCKER_MODE || '').trim() === '1') return true;
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return /(docker|containerd|kubepods|podman)/i.test(cgroup);
  } catch {
    return false;
  }
}

function resolveBridgeUrls() {
  const single = String(process.env.GOOSE_BRIDGE_URL || '').trim();
  const listRaw = String(process.env.GOOSE_BRIDGE_URLS || '').trim();
  const urls = []
    .concat(listRaw ? listRaw.split(',').map((item) => String(item || '').trim()) : [])
    .concat(single ? [single] : [])
    .map((item) => item.replace(/\/+$/, ''))
    .filter(Boolean)
    .filter((item, idx, arr) => arr.indexOf(item) === idx);
  return urls;
}

async function checkBridgeUrl(url, token, timeoutMs) {
  const headers = token ? { 'x-goose-bridge-token': token, 'content-type': 'application/json' } : {};
  const check = async (path, method = 'GET', body = undefined) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${url}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal
      });
      const text = await response.text().catch(() => '');
      return {
        ok: response.ok,
        status: response.status,
        body: text.slice(0, 300)
      };
    } catch (error) {
      return { ok: false, status: 0, error: String(error?.message || error) };
    } finally {
      clearTimeout(timer);
    }
  };

  const health = await check('/health');
  const probe = await check('/v1/probe', 'POST', JSON.stringify({}));
  return { url, health, probe, reachable: Boolean(probe.ok || health.ok) };
}

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/bridge/diagnostics', async (_, res) => {
  const urls = resolveBridgeUrls();
  const token = String(process.env.GOOSE_BRIDGE_TOKEN || '').trim();
  const timeoutMs = Number.parseInt(String(process.env.GOOSE_BRIDGE_DIAG_TIMEOUT_MS || '5000'), 10) || 5000;
  const inContainer = detectContainerRuntime();
  if (!urls.length) {
    return res.json({
      ok: false,
      inContainer,
      error: 'No bridge URL configured',
      suggestions: ['Set GOOSE_BRIDGE_URL or GOOSE_BRIDGE_URLS']
    });
  }
  const results = await Promise.all(urls.map((url) => checkBridgeUrl(url, token, timeoutMs)));
  const reachable = results.some((item) => item.reachable);
  res.json({
    ok: reachable,
    inContainer,
    configuredUrls: urls,
    timeoutMs,
    bridgeMode: {
      containerUseEnabled: String(process.env.GOOSE_BRIDGE_CONTAINER_USE || '').trim() !== '0',
      containerUseBuiltin: String(process.env.GOOSE_BRIDGE_CONTAINER_USE_BUILTIN || 'container-use').trim() || 'container-use'
    },
    diagnostics: results
  });
});

app.get('/api/tasks', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ tasks: listTasks(projectId) });
});

app.get('/api/tasks/:taskId/logs', (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'invalid task id' });
  const limit = Number(req.query?.limit || 5000);
  res.json({ logs: listTaskLogs(taskId, limit) });
});

app.get('/api/tasks/:taskId/attachments', (req, res) => {
  const taskId = Number(req.params.taskId);
  if (!Number.isFinite(taskId)) return res.status(400).json({ error: 'invalid task id' });
  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const project = getProject(task.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const attachments = readTaskAttachments(project, task);
  res.json({ attachments });
});

app.post('/api/tasks', (req, res) => {
  const baseBranch = String(req.body?.baseBranch || '').trim();
  if (!baseBranch) {
    return res.status(400).json({ error: 'baseBranch is required when creating a work item' });
  }
  const task = createTask(req.body || {});
  broadcast({ type: 'task_status', task });

  // Auto-start unattended Goose tasks created directly in "in_progress".
  if (task.status === 'in_progress' && task.assigneeType === 'goose') {
    const project = getProject(task.projectId);
    const hydratedPrompt = hydratePrompt(task, project);
    appendTaskLog(task.id, `[hydrated]\n${hydratedPrompt}`);
    broadcast({ type: 'task_log', taskId: task.id, line: `[hydrated]\n${hydratedPrompt}` });
    runGooseExecution({
      task,
      project,
      hydratedPrompt,
      plugins: listPlugins(task.projectId),
      broadcast,
      idempotencyKey: resolveIdempotencyKey(req, task.id, 'create-start')
    });
  }

  // For backlog Goose items, prepare LanceDB-backed code-intel context and task branch.
  if (task.status === 'backlog' && task.assigneeType === 'goose') {
    runBacklogRefinement({
      task,
      project: getProject(task.projectId),
      plugins: listPlugins(task.projectId),
      broadcast
    });
  }

  res.status(201).json({ task });
});

app.patch('/api/tasks/:taskId/status', (req, res) => {
  const taskId = Number(req.params.taskId);
  const status = req.body?.status;

  if (!status) return res.status(400).json({ error: 'status is required' });

  const current = getTask(taskId);
  if (!current) return res.status(404).json({ error: 'Task not found' });
  if (status === 'in_progress' && current.assigneeType === 'goose' && !String(current.baseBranch || '').trim()) {
    return res.status(400).json({ error: 'baseBranch is required before starting Goose execution' });
  }

  const patch = { status };
  if (status === 'done') {
    patch.runtimeStatus = 'success';
  } else if (status !== 'in_progress' && current.runtimeStatus === 'running') {
    patch.runtimeStatus = 'waiting';
  }

  const task = updateTask(taskId, patch);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  broadcast({ type: 'task_status', task });

  if (status === 'in_progress' && task.assigneeType === 'goose') {
    if (task.runtimeStatus === 'running') {
      appendTaskLog(task.id, '[runner] goose execution already running; duplicate start ignored');
      broadcast({ type: 'task_log', taskId: task.id, line: '[runner] goose execution already running; duplicate start ignored' });
      return res.json({ task });
    }
    const project = getProject(task.projectId);
    const hydratedPrompt = hydratePrompt(task, project);
    appendTaskLog(task.id, `[hydrated]\n${hydratedPrompt}`);
    broadcast({ type: 'task_log', taskId: task.id, line: `[hydrated]\n${hydratedPrompt}` });
    runGooseExecution({
      task,
      project,
      hydratedPrompt,
      plugins: listPlugins(task.projectId),
      broadcast,
      idempotencyKey: resolveIdempotencyKey(req, task.id, 'status-in-progress')
    });
  }

  res.json({ task });
});

app.patch('/api/tasks/:taskId/assignee', (req, res) => {
  const taskId = Number(req.params.taskId);
  const assigneeType = String(req.body?.assigneeType || '').trim();
  if (!['goose', 'human'].includes(assigneeType)) {
    return res.status(400).json({ error: 'assigneeType must be goose or human' });
  }
  const current = getTask(taskId);
  if (!current) return res.status(404).json({ error: 'Task not found' });
  if (assigneeType === 'goose' && !String(current.baseBranch || '').trim()) {
    return res.status(400).json({ error: 'baseBranch is required before assigning task to Goose' });
  }
  const task = updateTask(taskId, { assigneeType });
  if (!task) return res.status(404).json({ error: 'Task not found' });
  broadcast({ type: 'task_status', task });
  res.json({ task });
});

app.get('/api/plugins', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ plugins: listPlugins(projectId) });
});

app.get('/api/plugins/catalog', (_, res) => {
  res.json({ catalog: pluginCatalog() });
});

app.get('/api/schema-templates', (_, res) => {
  res.json({ templates: listSchemaTemplates() });
});

app.post('/api/schema-templates', (req, res) => {
  try {
    const template = createSchemaTemplate(req.body || {});
    res.status(201).json({ template });
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

app.put('/api/schema-templates/:id', (req, res) => {
  try {
    const template = updateSchemaTemplate(req.params.id, req.body || {});
    res.json({ template });
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

app.post('/api/plugins/validate', async (req, res) => {
  const result = await validatePluginConnection(req.body || {});
  if (!result.ok) {
    return res.status(400).json({
      error: 'Plugin connectivity failed. Recheck config parameters.',
      details: result
    });
  }
  res.json(result);
});

app.post('/api/plugins', async (req, res) => {
  const result = await validatePluginConnection(req.body || {});
  if (!result.ok) {
    return res.status(400).json({
      error: 'Plugin not connected. Recheck required config parameters.',
      details: result
    });
  }
  const plugin = createPlugin({ ...result.plugin, projectId: req.body?.projectId });
  res.status(201).json({ plugin, connectivity: result.connectivity });
});

app.post('/api/plugins/install-recommended', async (_, res) => {
  const projectId = _.body?.projectId;
  const existing = listPlugins(projectId);
  const installed = [];
  const skipped = [];

  for (const candidate of recommendedPlugins()) {
    const duplicate = existing.find(
      (row) => row.name === candidate.name && row.type === candidate.type && row.url === candidate.url
    );
    if (duplicate) continue;

    // Sequential validation to keep external checks deterministic.
    // eslint-disable-next-line no-await-in-loop
    const result = await validatePluginConnection(candidate);
    if (!result.ok) {
      skipped.push({ candidate: candidate.name, reason: result.errors.join(' ') });
      continue;
    }
    installed.push(createPlugin({ ...result.plugin, projectId }));
  }

  res.status(201).json({ installed, skipped, totalInstalled: installed.length });
});

app.get('/api/plugins/diagnostics', async (_, res) => {
  try {
    const diagnostics = await runMcpDiagnostics();
    res.json(diagnostics);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post('/api/tasks/:taskId/approve', (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const next = updateTask(taskId, { runtimeStatus: 'success', status: 'done' });
  broadcast({ type: 'task_status', task: next });
  res.json({ task: next });
});

app.post('/api/tasks/:taskId/retry', (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (task.runtimeStatus === 'running') {
    return res.status(409).json({ error: 'Task is already running' });
  }
  if (task.assigneeType === 'goose' && !String(task.baseBranch || '').trim()) {
    return res.status(400).json({ error: 'baseBranch is required before retrying Goose execution' });
  }

  const next = updateTask(taskId, { status: 'in_progress', runtimeStatus: 'waiting' });
  broadcast({ type: 'task_status', task: next });

  if (next.assigneeType === 'goose') {
    const project = getProject(next.projectId);
    const hydratedPrompt = hydratePrompt(next, project);
    appendTaskLog(next.id, `[hydrated]\n${hydratedPrompt}`);
    broadcast({ type: 'task_log', taskId: next.id, line: `[hydrated]\n${hydratedPrompt}` });
    runGooseExecution({
      task: next,
      project,
      hydratedPrompt,
      plugins: listPlugins(next.projectId),
      broadcast,
      idempotencyKey: resolveIdempotencyKey(req, next.id, 'retry')
    });
  }

  res.json({ task: next });
});

app.post('/api/tasks/:taskId/build-test', async (req, res) => {
  const taskId = Number(req.params.taskId);
  const task = getTask(taskId);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const project = getProject(task.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const running = updateTask(taskId, { runtimeStatus: 'build_running' });
  broadcast({ type: 'task_status', task: running });
  appendTaskLog(task.id, '[build-test] starting build validation...');
  broadcast({ type: 'task_log', taskId: task.id, line: '[build-test] starting build validation...' });

  try {
    const preferredBranch = String(task.branchName || task.baseBranch || '').trim();
    const repo = await ensureProjectRepoReady(project, (line) => {
      appendTaskLog(task.id, line);
      broadcast({ type: 'task_log', taskId: task.id, line });
    }, { preferredBranch });

    const cmd = resolveBuildCommand(repo.repoPath);
    if (!cmd) {
      const requireBuildCmd = String(process.env.GOOSE_BUILD_TEST_REQUIRE_CMD || '').trim() === '1';
      if (requireBuildCmd) {
        const failed = updateTask(taskId, { runtimeStatus: 'build_failed' });
        broadcast({ type: 'task_status', task: failed });
        const line = '[build-test] no build command found (missing package.json scripts.build)';
        appendTaskLog(task.id, line);
        broadcast({ type: 'task_log', taskId: task.id, line });
        return res.json({ ok: false, error: 'No build command found in package.json', task: failed });
      }
      const passed = updateTask(taskId, { runtimeStatus: 'build_success' });
      broadcast({ type: 'task_status', task: passed });
      const line =
        '[build-test] no build command found; treating as no-build project (set GOOSE_BUILD_TEST_REQUIRE_CMD=1 to enforce)';
      appendTaskLog(task.id, line);
      broadcast({ type: 'task_log', taskId: task.id, line });
      return res.json({ ok: true, skipped: true, task: passed });
    }

    appendTaskLog(task.id, `[build-test] running: ${cmd}`);
    broadcast({ type: 'task_log', taskId: task.id, line: `[build-test] running: ${cmd}` });
    const result = await runSpawn('bash', ['-lc', cmd], { cwd: repo.repoPath, env: process.env });

    for (const line of String(result.out || '').split('\n').filter(Boolean).slice(-120)) {
      const rendered = `[build(stdout)] ${line}`;
      appendTaskLog(task.id, rendered);
      broadcast({ type: 'task_log', taskId: task.id, line: rendered });
    }
    for (const line of String(result.err || '').split('\n').filter(Boolean).slice(-120)) {
      const rendered = `[build(stderr)] ${line}`;
      appendTaskLog(task.id, rendered);
      broadcast({ type: 'task_log', taskId: task.id, line: rendered });
    }

    if (result.code !== 0) {
      const failed = updateTask(taskId, { runtimeStatus: 'build_failed' });
      broadcast({ type: 'task_status', task: failed });
      const line = `[build-test] failed with exit code ${result.code}`;
      appendTaskLog(task.id, line);
      broadcast({ type: 'task_log', taskId: task.id, line });
      return res.json({ ok: false, error: `Build failed (exit ${result.code})`, task: failed });
    }

    const passed = updateTask(taskId, { runtimeStatus: 'build_success' });
    broadcast({ type: 'task_status', task: passed });
    const line = '[build-test] build passed';
    appendTaskLog(task.id, line);
    broadcast({ type: 'task_log', taskId: task.id, line });
    return res.json({ ok: true, task: passed });
  } catch (error) {
    const failed = updateTask(taskId, { runtimeStatus: 'build_failed' });
    broadcast({ type: 'task_status', task: failed });
    const line = `[build-test] setup failed: ${String(error?.message || error)}`;
    appendTaskLog(task.id, line);
    broadcast({ type: 'task_log', taskId: task.id, line });
    return res.json({ ok: false, error: String(error?.message || error), task: failed });
  }
});

app.get('/api/cycles', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ cycles: listCycles(projectId) });
});

app.post('/api/cycles', (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'name is required' });
  const cycle = createCycle(req.body);
  res.status(201).json({ cycle });
});

app.get('/api/modules', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ modules: listModules(projectId) });
});

app.post('/api/modules', (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'name is required' });
  const module = createModule(req.body);
  res.status(201).json({ module });
});

app.get('/api/views', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ views: listViews(projectId) });
});

app.post('/api/views', (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'name is required' });
  const view = createView(req.body);
  res.status(201).json({ view });
});

app.get('/api/pages', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ pages: listPages(projectId) });
});

app.post('/api/pages', (req, res) => {
  if (!req.body?.title) return res.status(400).json({ error: 'title is required' });
  const page = createPage(req.body);
  res.status(201).json({ page });
});

app.put('/api/pages/:pageId', (req, res) => {
  const pageId = Number(req.params.pageId);
  if (!Number.isFinite(pageId)) return res.status(400).json({ error: 'invalid page id' });
  const page = updatePage(pageId, req.body || {});
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json({ page });
});

app.get('/api/analytics', (_, res) => {
  const projectId = _.query?.projectId;
  res.json({ analytics: getAnalyticsSnapshot(projectId) });
});

app.get('/api/projects', (_, res) => {
  res.json({ projects: listProjects() });
});

app.post('/api/projects', async (req, res) => {
  if (!req.body?.name) return res.status(400).json({ error: 'name is required' });
  const verified = await verifyRepoConnectivity(req.body || {});
  if (!verified.ok) {
    return res.status(400).json({
      error: 'Repository connectivity failed. Recheck repo URL/path/token.',
      details: verified.errors
    });
  }
  const project = createProject({
    ...req.body,
    repoUrl: verified.repoUrl,
    repoPath: verified.repoPath,
    defaultBranch: verified.defaultBranch,
    autoPr: Boolean(req.body?.autoPr),
    autoMerge: Boolean(req.body?.autoMerge)
  });
  res.status(201).json({ project, connectivity: verified });
});

app.put('/api/projects/:projectId', async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'invalid project id' });
  const current = getProject(projectId);
  if (!current) return res.status(404).json({ error: 'Project not found' });
  const nextInput = { ...current, ...(req.body || {}) };
  const verified = await verifyRepoConnectivity(nextInput);
  if (!verified.ok) {
    return res.status(400).json({
      error: 'Repository connectivity failed. Recheck repo URL/path/token.',
      details: verified.errors
    });
  }
  const project = updateProject(projectId, {
    name: req.body?.name,
    description: req.body?.description,
    repoUrl: nextInput.repoUrl,
    repoPath: nextInput.repoPath,
    defaultBranch: nextInput.defaultBranch || 'main',
    githubToken: nextInput.githubToken || '',
    autoPr: req.body?.autoPr,
    autoMerge: req.body?.autoMerge
  });
  res.json({ project, connectivity: verified });
});

app.post('/api/projects/:projectId/connect-repo', async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'invalid project id' });
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const ready = await ensureProjectRepoReady(project);
    res.json({ ok: true, repo: ready });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get('/api/projects/:projectId/status', async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'invalid project id' });
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const status = await getProjectRepoStatus(project);
    res.json({ status });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/projects/:projectId/branches', async (req, res) => {
  const projectId = Number(req.params.projectId);
  if (!Number.isFinite(projectId)) return res.status(400).json({ error: 'invalid project id' });
  const project = getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const result = await listProjectBranches(project);
  res.json(result);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'boot', message: 'Realtime Goose stream connected.' }));
});

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`Goose C2 server running on http://${HOST}:${PORT}`);
});
