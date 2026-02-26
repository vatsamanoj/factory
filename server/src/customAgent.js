import { appendTaskLog, updateTask, getCustomAgentApiKey } from './db.js';
import { create_agent } from './customAgentCompanion.js';
import { spawn } from 'node:child_process';
import { ensureProjectRepoReady, ensureTaskBranch } from './repoManager.js';

const AGENT_NAME = 'Custom Ember';

function emitLog(taskId, broadcast, line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${AGENT_NAME}> ${line}`;
  appendTaskLog(taskId, entry);
  if (broadcast) broadcast({ type: 'task_log', taskId, line: entry });
}

function parsePromptGitTargets(hydratedPrompt, fallbackBase = 'main', fallbackBranch = '') {
  const text = String(hydratedPrompt || '');
  const baseMatch = text.match(/\bbase=([a-zA-Z0-9._/-]+)/i);
  const branchMatch = text.match(/\bbranch=([a-zA-Z0-9._/-]+)/i);
  return {
    baseBranch: String(baseMatch?.[1] || fallbackBase || 'main').trim() || 'main',
    workBranch: String(branchMatch?.[1] || fallbackBranch || '').trim()
  };
}

function runGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, out: String(out || '').trim(), err: String(err || '').trim() });
      else resolve({ ok: false, out: String(out || '').trim(), err: String(err || '').trim(), code });
    });
  });
}

async function resolveRef(repoPath, refName) {
  const local = await runGit(repoPath, ['rev-parse', '--verify', refName]);
  if (local.ok) return refName;
  const remote = await runGit(repoPath, ['rev-parse', '--verify', `origin/${refName}`]);
  if (remote.ok) return `origin/${refName}`;
  return '';
}

async function verifyGitMergeEvidence({ project, task, hydratedPrompt, toolCalls, repoPathOverride = '' }) {
  const repoPath = String(repoPathOverride || project?.repoPath || '').trim();
  if (!repoPath) {
    return { ok: false, reason: 'project repo path is missing' };
  }
  const parsed = parsePromptGitTargets(hydratedPrompt, project?.defaultBranch || task?.baseBranch || 'main', task?.branchName || '');
  const workBranch = String(task?.branchName || parsed.workBranch || '').trim();
  const baseBranch = String(task?.baseBranch || parsed.baseBranch || project?.defaultBranch || 'main').trim() || 'main';
  if (!workBranch) {
    return { ok: false, reason: 'work branch could not be determined from task/prompt' };
  }

  const gitToolRuns = (toolCalls || []).filter(
    (event) => event?.tool === 'shell' && /\bgit\b/i.test(String(event?.args?.command || ''))
  );
  if (!gitToolRuns.length) {
    return { ok: false, reason: 'no git shell tool-call evidence in agent run' };
  }
  const hasCommitEvidence = gitToolRuns.some((event) => /\bgit\s+commit\b/i.test(String(event?.args?.command || '')));
  const hasPushEvidence = gitToolRuns.some((event) => /\bgit\s+push\b/i.test(String(event?.args?.command || '')));
  if (!hasCommitEvidence || !hasPushEvidence) {
    return { ok: false, reason: 'missing git write evidence in this run (require git commit + git push)' };
  }

  const repoCheck = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!repoCheck.ok) {
    return { ok: false, reason: `repo is not a valid git work tree at ${repoPath}` };
  }

  const workRef = await resolveRef(repoPath, workBranch);
  if (!workRef) {
    return { ok: false, reason: `work branch not found: ${workBranch}` };
  }
  const baseRef = await resolveRef(repoPath, baseBranch);
  if (!baseRef) {
    return { ok: false, reason: `base branch not found: ${baseBranch}` };
  }

  const merged = await runGit(repoPath, ['merge-base', '--is-ancestor', workRef, baseRef]);
  if (!merged.ok) {
    return { ok: false, reason: `work branch is not merged into base (${workRef} -> ${baseRef})` };
  }
  return { ok: true, baseBranch, workBranch, baseRef, workRef };
}

export async function runCustomAgent({ task, broadcast, hydratedPrompt, project, shouldStop }) {
  emitLog(task.id, broadcast, 'initializing custom agent runtime');
  updateTask(task.id, { runtimeStatus: 'running' });
  let executionTask = task;
  let repoPath = String(project?.repoPath || '').trim();
  try {
    const preferredBranch = String(task?.branchName || task?.baseBranch || project?.defaultBranch || '').trim();
    const repo = await ensureProjectRepoReady(
      project,
      (line) => emitLog(task.id, broadcast, line),
      preferredBranch ? { preferredBranch } : {}
    );
    repoPath = String(repo?.repoPath || repoPath || '').trim();
    const branchName = await ensureTaskBranch(repo, task, (line) => emitLog(task.id, broadcast, line));
    if (branchName && branchName !== String(task?.branchName || '')) {
      const patched = updateTask(task.id, { branchName });
      if (patched) executionTask = patched;
      emitLog(task.id, broadcast, `repo preflight ready: branch=${branchName}`);
    } else {
      emitLog(task.id, broadcast, `repo preflight ready: branch=${branchName || task?.branchName || '(none)'}`);
    }
  } catch (error) {
    emitLog(task.id, broadcast, `repo preflight failed: ${String(error?.message || error)}`);
    const failed = updateTask(task.id, { runtimeStatus: 'failed', status: 'todo' });
    if (broadcast) broadcast({ type: 'task_status', task: failed });
    return { status: 'failed' };
  }
  const apiKey = getCustomAgentApiKey();
  if (!apiKey) {
    emitLog(task.id, broadcast, 'missing API key: unable to reach LLM');
    const failed = updateTask(task.id, { runtimeStatus: 'failed', status: 'todo' });
    if (broadcast) broadcast({ type: 'task_status', task: failed });
    return { status: 'failed' };
  }
  const mask = apiKey.length > 8 ? `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}` : `${apiKey.slice(0, 2)}••••`;
  emitLog(task.id, broadcast, `using provisioned API key ${mask}`);
  const companion = create_agent({
    model: process.env.CUSTOM_AGENT_MODEL || 'glm-5',
    api_key: apiKey,
    base_url: process.env.CUSTOM_AGENT_BASE_URL || 'https://api.openai.com',
    default_cwd: repoPath || process.cwd(),
    task_hint: `${executionTask?.title || ''} ${executionTask?.description || ''} ${project?.name || ''} ${executionTask?.baseBranch || ''}`,
    on_trace: (line) => emitLog(task.id, broadcast, line)
  });
  emitLog(
    task.id,
    broadcast,
    `llm config model=${process.env.CUSTOM_AGENT_MODEL || 'glm-5'} base_url=${process.env.CUSTOM_AGENT_BASE_URL || 'https://api.openai.com'}`
  );
  const systemMessage = {
    role: 'system',
    content:
      'You are a repository-focused coding agent. Stay strictly within the current task and repository context. Do not invent unrelated projects, tests, or file trees. Use only evidence from tool outputs. You may call TOOL_CALL: {"name":"tool","args":{...}} to invoke helpers. After each tool call, continue until task completion. Final response must be a concise task-specific summary. Default tools: shell, file_read.'
  };
  const messages = [{ role: 'user', content: hydratedPrompt }];
  if (!messages[0].content) {
    emitLog(task.id, broadcast, 'hydrated prompt empty; skipping agent run');
    return { status: 'failed' };
  }
  const response = await companion.ainvoke({ messages: [systemMessage, ...messages] });
  if (!Array.isArray(response.toolCalls) || response.toolCalls.length === 0) {
    emitLog(task.id, broadcast, 'completion rejected: no tool calls were executed by custom agent');
    const failed = updateTask(task.id, { runtimeStatus: 'failed', status: 'todo' });
    if (broadcast) broadcast({ type: 'task_status', task: failed });
    return { status: 'failed' };
  }
  emitLog(task.id, broadcast, `assistant reply: ${response.final}`);
  for (const toolEvent of response.toolCalls || []) {
    emitLog(
      task.id,
      broadcast,
      `${toolEvent.tool} args=${JSON.stringify(toolEvent.args || {})} result=${String(toolEvent.result || '').slice(0, 200)}`
    );
  }
  if (shouldStop?.()) {
    emitLog(task.id, broadcast, 'custom agent stop requested');
    const stopped = updateTask(task.id, { runtimeStatus: 'waiting', status: 'todo' });
    if (broadcast) broadcast({ type: 'task_status', task: stopped });
    return { status: 'stopped' };
  }
  const gitEvidence = await verifyGitMergeEvidence({
    project,
    task: executionTask,
    hydratedPrompt,
    toolCalls: response.toolCalls || [],
    repoPathOverride: repoPath
  });
  if (!gitEvidence.ok) {
    emitLog(task.id, broadcast, `completion rejected: ${gitEvidence.reason}`);
    const failed = updateTask(task.id, { runtimeStatus: 'failed', status: 'todo' });
    if (broadcast) broadcast({ type: 'task_status', task: failed });
    return { status: 'failed' };
  }
  emitLog(
    task.id,
    broadcast,
    `verified git evidence: ${gitEvidence.workRef} is merged into ${gitEvidence.baseRef}; promoting task to review`
  );
  if (gitEvidence.workBranch && gitEvidence.workBranch !== String(executionTask.branchName || '')) {
    updateTask(task.id, { branchName: gitEvidence.workBranch });
  }
  const updated = updateTask(task.id, { status: 'review', runtimeStatus: 'success' });
  if (broadcast) broadcast({ type: 'task_status', task: updated });
  return { status: 'completed' };
}
