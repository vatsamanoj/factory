import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
const codingAgentNames = ['Manish Malik', 'Sanjeev Lamba', 'Rajiv Jamwal'];

function normalizeLegacyLogLine(line) {
  let next = String(line || '');
  next = next.replace(/(^|\])\s*goose>/g, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/(^|\])\s*manager>/g, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/(^|\])\s*repo>/gi, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/(^|\])\s*git>/gi, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/(^|\])\s*refiner>/gi, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/(^|\])\s*validate(?:\([^)]+\))?>/gi, '$1 Rajiv Gupta (Boss)>');
  next = next.replace(/llm\(manager\)>/gi, 'Rajiv Gupta (Boss)>');
  next = next.replace(/llm\(subagent\s*(\d+)\)>/gi, (_, indexRaw) => {
    const idx = Math.max(1, Number(indexRaw)) - 1;
    const name = codingAgentNames[idx % codingAgentNames.length];
    return `${name}>`;
  });
  next = next.replace(/llm\(([^)]+)\)>/gi, '$1>');
  return next;
}

function ContextPanel({ task }) {
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Context Hydration</h3>
      <div className="space-y-1 text-xs text-ink">
        <p>Checkout From: {task.baseBranch || 'Project default'}</p>
        <p>Branch: {task.branchName || 'Not created yet'}</p>
        <p>Static Docs: {(task.context?.docs || []).join(', ') || 'None'}</p>
        <p>API Specs: {(task.context?.apis || []).join(', ') || 'None'}</p>
        <p>MCP Endpoints: {(task.context?.mcps || []).join(', ') || 'None'}</p>
        <p>Attachments: {(task.refinementFiles || []).join(', ') || 'None'}</p>
      </div>
    </div>
  );
}

export default function TaskDrawer({
  task,
  logs,
  attachmentsByTask,
  onAssigneeChange,
  onRetryTask,
  onBuildTest,
  onMoveToTrash,
  onRefreshAttachments,
  onClose
}) {
  const terminalRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [followTail, setFollowTail] = useState(true);
  const [wrapLines, setWrapLines] = useState(true);
  const [logsFocus, setLogsFocus] = useState(false);
  const taskLogs = useMemo(() => (task ? logs[task.id] || [] : []), [logs, task]);

  useEffect(() => {
    if (!terminalRef.current || !followTail) return;
    terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
  }, [taskLogs.length, task?.id, followTail]);

  async function copyLogs() {
    if (!taskLogs.length) return;
    const text = taskLogs.map((line) => normalizeLegacyLogLine(line)).join('\n');
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('clipboard-unavailable');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        setCopied(Boolean(ok));
        if (ok) setTimeout(() => setCopied(false), 1400);
      } catch {
        setCopied(false);
      }
    }
  }
  const attachmentRows = task ? attachmentsByTask?.[task.id] || [] : [];

  return (
    <AnimatePresence>
      {task ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-slate-900/40"
            onClick={onClose}
          />
          <motion.aside
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            className="fixed bottom-0 left-0 right-0 z-50 h-[92vh] rounded-t-3xl border-t border-border bg-panel p-4 shadow-card md:h-[88vh]"
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-ink">{task.title}</h2>
                  <p className="mt-1 text-[11px] text-muted">
                    {task.externalId || `GSE-${task.id}`} {task.priority ? `• ${task.priority}` : ''}{' '}
                    {task.dueDate ? `• Due ${task.dueDate}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={task.assigneeType}
                    onChange={(e) => onAssigneeChange?.(task.id, e.target.value)}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-xs font-semibold text-ink"
                  >
                    <option value="goose">Goose</option>
                    <option value="human">Manual</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => setLogsFocus((prev) => !prev)}
                    className="rounded-lg border border-border bg-surface px-2 py-1 text-xs font-semibold text-ink"
                  >
                    {logsFocus ? 'Show All' : 'Logs Focus'}
                  </button>
                  {task.runtimeStatus === 'failed' ? (
                    <button
                      type="button"
                      onClick={() => onRetryTask?.(task.id)}
                      className="rounded-lg border border-red-300 bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                    >
                      Move To In Progress
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={task.runtimeStatus === 'running' || task.runtimeStatus === 'build_running'}
                    onClick={() => onBuildTest?.(task.id)}
                    className="rounded-lg border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Build Test
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveToTrash?.(task.id)}
                    className="rounded-lg border border-slate-300 bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700"
                  >
                    Move To Trash
                  </button>
                  <button className="rounded-lg border border-border bg-surface px-3 py-1 text-xs font-semibold" onClick={onClose}>
                    Close
                  </button>
                </div>
              </div>

              {!logsFocus ? <ContextPanel task={task} /> : null}

              {!logsFocus ? (
                <section className="mt-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Attached MD Files</h3>
                    <button
                      type="button"
                      onClick={() => onRefreshAttachments?.(task.id)}
                      className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="max-h-32 overflow-auto rounded-xl border border-border bg-surface p-2 text-xs">
                    {attachmentRows.length === 0 ? <p className="text-muted">No attachments.</p> : null}
                    {attachmentRows.map((file) => (
                      <details key={file.path} className="mb-2 rounded border border-border bg-panel p-2">
                        <summary className="cursor-pointer font-semibold text-ink">{file.path}</summary>
                        {file.error ? <p className="mt-2 text-danger">{file.error}</p> : null}
                        {file.content ? <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[11px] text-ink">{file.content}</pre> : null}
                      </details>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="mt-3 flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Execution Terminal</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-medium text-muted">{taskLogs.length} lines</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        task.runtimeStatus === 'running' || task.runtimeStatus === 'build_running'
                          ? 'bg-blue-100 text-blue-700'
                          : task.runtimeStatus === 'build_success'
                            ? 'bg-emerald-100 text-emerald-700'
                            : task.runtimeStatus === 'build_failed'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-surface text-muted'
                      }`}
                    >
                      {task.runtimeStatus}
                    </span>
                    <button
                      type="button"
                      onClick={() => setFollowTail((prev) => !prev)}
                      className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink"
                    >
                      {followTail ? 'Following' : 'Follow Tail'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setWrapLines((prev) => !prev)}
                      className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink"
                    >
                      {wrapLines ? 'Wrap On' : 'Wrap Off'}
                    </button>
                    <button
                      type="button"
                      onClick={copyLogs}
                      className="rounded-md border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-ink"
                    >
                      {copied ? 'Copied' : 'Copy Logs'}
                    </button>
                  </div>
                </div>
                <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-slate-900/70 to-transparent" />
                  <div
                    ref={terminalRef}
                    className="terminal-scrollbar h-full w-full overflow-auto p-3 font-mono text-[11px] leading-5 text-emerald-300"
                  >
                    {taskLogs.length === 0 ? <div className="text-slate-400">Waiting for logs...</div> : null}
                    {taskLogs.map((line, idx) => (
                      <div key={`${task.id}-${idx}`} className="mb-1 flex gap-2">
                        <span className="w-8 shrink-0 select-none text-right text-slate-500">{idx + 1}</span>
                        <span className={wrapLines ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}>
                          {normalizeLegacyLogLine(line)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            </div>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  );
}
