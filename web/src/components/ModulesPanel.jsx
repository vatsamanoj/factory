import { useState } from 'react';

export default function ModulesPanel({ modules, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#1d4ed8');

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await onCreate({ name: name.trim(), description: description.trim(), color });
    setName('');
    setDescription('');
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="grid gap-2 rounded-xl border border-border bg-surface p-3 md:grid-cols-[1fr_2fr_auto_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Module name"
          className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
        />
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 rounded border border-border bg-panel p-1" />
        <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">
          Add Module
        </button>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map((module) => (
          <div key={module.id} className="rounded-xl border border-border bg-panel p-3 shadow-soft">
            <div className="mb-2 flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: module.color }} />
              <p className="text-sm font-semibold text-ink">{module.name}</p>
            </div>
            <p className="text-xs text-muted">{module.description || 'No description.'}</p>
          </div>
        ))}
        {modules.length === 0 ? <p className="text-xs text-muted">No modules yet.</p> : null}
      </div>
    </div>
  );
}
