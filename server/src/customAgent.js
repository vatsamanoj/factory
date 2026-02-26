import { appendTaskLog, updateTask, getCustomAgentApiKey } from './db.js';
import { create_agent } from './customAgentCompanion.js';

const AGENT_NAME = 'Custom Ember';

function emitLog(taskId, broadcast, line) {
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${AGENT_NAME}> ${line}`;
  appendTaskLog(taskId, entry);
  if (broadcast) broadcast({ type: 'task_log', taskId, line: entry });
}

export async function runCustomAgent({ task, broadcast, hydratedPrompt, project, shouldStop }) {
  emitLog(task.id, broadcast, 'initializing custom agent runtime');
  updateTask(task.id, { runtimeStatus: 'running' });
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
    default_cwd: project?.repoPath || process.cwd(),
    task_hint: `${task?.title || ''} ${task?.description || ''} ${project?.name || ''} ${task?.baseBranch || ''}`
  });
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
  const updated = updateTask(task.id, { status: 'review', runtimeStatus: 'success' });
  if (broadcast) broadcast({ type: 'task_status', task: updated });
  return { status: 'completed' };
}
