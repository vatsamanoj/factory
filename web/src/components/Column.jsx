import { motion } from 'framer-motion';
import { useState } from 'react';
import TaskCard from './TaskCard.jsx';

const columnStyles = {
  backlog: 'bg-surface',
  todo: 'bg-surface',
  triage: 'bg-surface',
  in_progress: 'bg-surface',
  review: 'bg-surface',
  done: 'bg-surface'
};

export default function Column({
  title,
  status,
  tasks,
  isCollapsed,
  onToggleCollapse,
  onQuickAdd,
  onDropTask,
  onSelectTask,
  onDragStart,
  onSwipeRight
}) {
  const [quickTitle, setQuickTitle] = useState('');

  function submitQuickAdd(e) {
    e.preventDefault();
    if (!quickTitle.trim()) return;
    onQuickAdd?.(status, quickTitle.trim());
    setQuickTitle('');
  }

  if (isCollapsed) {
    return (
      <section className="w-[68px] shrink-0 rounded-lg border border-border bg-panel p-2 shadow-soft">
        <button
          type="button"
          onClick={() => onToggleCollapse?.(status)}
          className="flex h-full w-full flex-col items-center justify-between gap-2"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted [writing-mode:vertical-lr]">{title}</span>
          <span className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted">{tasks.length}</span>
        </button>
      </section>
    );
  }

  return (
    <section
      className={`flex h-[calc(100vh-18rem)] w-[84vw] shrink-0 snap-start flex-col rounded-lg border border-border p-2 shadow-soft md:w-[320px] ${
        columnStyles[status] || 'bg-surface'
      }`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDropTask(e, status)}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-ink">{title}</h2>
          <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold text-muted">{tasks.length}</span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onToggleCollapse?.(status)}
            className="rounded border border-border bg-panel px-1.5 py-1 text-[10px] font-semibold text-muted"
          >
            Collapse
          </button>
        </div>
      </header>

      <form onSubmit={submitQuickAdd} className="mb-2 flex gap-1">
        <input
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          placeholder="Quick add issue"
          className="w-full rounded border border-border bg-panel px-2 py-1.5 text-[11px]"
        />
        <button type="submit" className="rounded bg-accent px-2 py-1.5 text-[11px] font-semibold text-white">
          Add
        </button>
      </form>

      <motion.div layout className="no-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onClick={onSelectTask}
            onDragStart={onDragStart}
            onSwipeRight={onSwipeRight}
          />
        ))}
      </motion.div>

      {tasks.length === 0 ? <p className="mt-2 text-[11px] text-muted">Drop tasks here</p> : null}
    </section>
  );
}
