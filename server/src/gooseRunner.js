import { appendTaskLog, acquireTaskExecutionLease, heartbeatTaskExecutionLease, releaseTaskExecutionLease, updateTask, getCustomAgentApiKey } from './db.js';
import { runCustomAgent } from './customAgent.js';

const activeRuns = new Map();
let shutdownHookInstalled = false;

function emitLine(broadcast, taskId, line) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] CustomAgentRunner> ${line}`;
  appendTaskLog(taskId, entry);
  broadcast?.({ type: 'task_log', taskId, line: entry });
}

function newRunId(taskId) {
  return `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function installShutdownHook() {
  if (shutdownHookInstalled) return;
  shutdownHookInstalled = true;
  const cleanup = () => {
    activeRuns.clear();
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
}

export async function runGooseExecution({ task, project, hydratedPrompt, broadcast, idempotencyKey = '' }) {
  installShutdownHook();
  if (activeRuns.has(task.id)) {
    emitLine(broadcast, task.id, 'execution already running; skipping duplicate launch.');
    return;
  }

  const runId = newRunId(task.id);
  let lease;
  try {
    lease = acquireTaskExecutionLease({
      taskId: task.id,
      runId,
      idempotencyKey: String(idempotencyKey).slice(0, 200),
      owner: 'custom-agent'
    });
  } catch (error) {
    emitLine(broadcast, task.id, `lease acquisition failed: ${String(error?.message || error)}`);
    return;
  }

  if (!lease?.acquired) {
    emitLine(
      broadcast,
      task.id,
      `lease not acquired (${lease?.reason || 'already running'}) for run ${lease?.lease?.runId || runId}`
    );
    return;
  }

  activeRuns.set(task.id, { runId, stopRequested: false });

  const running = updateTask(task.id, { runtimeStatus: 'running' });
  broadcast?.({ type: 'task_status', task: running });

  let heartbeatInterval;
  try {
    const shouldStop = () => activeRuns.get(task.id)?.stopRequested;
    const apiKey = getCustomAgentApiKey();
    heartbeatInterval = setInterval(() => {
      heartbeatTaskExecutionLease({ taskId: task.id, runId });
    }, 10000);

    await runCustomAgent({
      task,
      project,
      hydratedPrompt,
      broadcast,
      apiKey,
      shouldStop
    });
  } catch (error) {
    emitLine(broadcast, task.id, `custom agent error: ${String(error?.message || error)}`);
    const failed = updateTask(task.id, { runtimeStatus: 'failed', status: 'todo' });
    broadcast?.({ type: 'task_status', task: failed });
  } finally {
    clearInterval(heartbeatInterval);
    activeRuns.delete(task.id);
    releaseTaskExecutionLease({ taskId: task.id, runId, status: 'completed' });
  }
}

export function stopGooseExecution(taskId, { broadcast } = {}) {
  const run = activeRuns.get(taskId);
  if (!run) {
    return { stopped: false, reason: 'not-running' };
  }
  run.stopRequested = true;
  emitLine(broadcast, taskId, 'stop requested for custom agent run.');
  return { stopped: true };
}
