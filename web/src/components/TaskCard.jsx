import { motion } from 'framer-motion';
import { useRef } from 'react';

const statusMeta = {
  waiting: { dot: 'bg-slate-400', label: 'Waiting' },
  running: { dot: 'bg-blue-500', label: 'Running' },
  build_running: { dot: 'bg-sky-500', label: 'Build Running' },
  build_success: { dot: 'bg-emerald-500', label: 'Build Passed' },
  build_failed: { dot: 'bg-red-500', label: 'Build Failed' },
  success: { dot: 'bg-emerald-500', label: 'Success' },
  failed: { dot: 'bg-red-500', label: 'Failed' },
  approval: { dot: 'bg-violet-500', label: 'Approval' },
  waiting_for_approval: { dot: 'bg-violet-500', label: 'Waiting Approval' }
};

export default function TaskCard({ task, onClick, onDragStart, onSwipeRight }) {
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);

  function onTouchStart(event) {
    const touch = event.changedTouches[0];
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;
  }

  function onTouchEnd(event) {
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStartX.current;
    const deltaY = Math.abs(touch.clientY - touchStartY.current);
    if (deltaX > 72 && deltaY < 32) onSwipeRight?.(task);
  }

  const meta = statusMeta[task.runtimeStatus] || statusMeta.waiting;
  const isCheckedOut = Boolean(task.branchName) && (task.repoCurrentBranch === task.branchName || task.assigneeType === 'goose');
  const priorityTone =
    task.priority === 'High'
      ? 'bg-rose-50 text-rose-700'
      : task.priority === 'Medium'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-surface text-muted';

  return (
    <motion.article
      layout
      whileTap={{ scale: 0.99 }}
      className={`relative min-h-28 overflow-hidden rounded-lg border border-border bg-panel p-3 shadow-soft transition-all hover:border-slate-300 ${
        task.runtimeStatus === 'running' || task.runtimeStatus === 'build_running' ? 'pulse-running' : ''
      }`}
      draggable
      onDragStart={(event) => onDragStart(event, task.id)}
      onClick={() => onClick(task)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{task.externalId || `GSE-${task.id}`}</p>
          <p className="line-clamp-2 text-[13px] font-semibold leading-5 text-ink">{task.title}</p>
        </div>
        <span className={`mt-1 inline-block h-2.5 w-2.5 rounded-full ${meta.dot}`} />
      </header>

      <p className="line-clamp-2 text-xs leading-5 text-muted">{task.description}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        {task.branchName ? (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-ink">{task.branchName}</span>
        ) : null}
        {task.branchName ? (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              isCheckedOut ? 'bg-emerald-100 text-emerald-700' : 'bg-surface text-muted'
            }`}
          >
            {isCheckedOut ? 'Checked Out' : 'Not Checked Out'}
          </span>
        ) : null}
        {task.priority ? (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${priorityTone}`}>{task.priority}</span>
        ) : null}
        {task.dueDate ? (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">{task.dueDate}</span>
        ) : null}
        {task.moduleName ? (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">{task.moduleName}</span>
        ) : null}
        {task.cycleName ? (
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-muted">{task.cycleName}</span>
        ) : null}
      </div>

      <footer className="mt-2 flex items-center justify-between text-[10px]">
        <span className="rounded bg-surface px-1.5 py-0.5 text-muted">
          {task.assigneeType === 'goose' ? 'Goose' : 'Human'}
        </span>
        <span className="font-semibold text-ink">{meta.label}</span>
      </footer>

      {task.status === 'review' ? <p className="mt-1 text-[10px] font-medium text-accent">Swipe right to approve</p> : null}
    </motion.article>
  );
}
