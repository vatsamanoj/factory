import { useState } from 'react';

export default function ViewsPanel({ views, onCreate, onApply }) {
  const [name, setName] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await onCreate({ name: name.trim() });
    setName('');
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="flex gap-2 rounded-xl border border-border bg-surface p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Saved view name"
          className="flex-1 rounded-lg border border-border bg-panel px-3 py-2 text-xs"
        />
        <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">
          Save Current
        </button>
      </form>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            onClick={() => onApply(view)}
            className="rounded-xl border border-border bg-panel p-3 text-left shadow-soft hover:bg-surface"
          >
            <p className="text-sm font-semibold text-ink">{view.name}</p>
            <p className="mt-1 text-xs text-muted">Mode: {view.view_mode || view.viewMode || 'board'}</p>
            <p className="text-xs text-muted">Assignee: {view.assignee_filter || view.assigneeFilter || 'all'}</p>
            <p className="text-xs text-muted">Runtime: {view.runtime_filter || view.runtimeFilter || 'all'}</p>
          </button>
        ))}
        {views.length === 0 ? <p className="text-xs text-muted">No saved views yet.</p> : null}
      </div>
    </div>
  );
}
