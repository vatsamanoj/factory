const items = [
  { id: 'work-items', label: 'Work Items' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'modules', label: 'Modules' },
  { id: 'views', label: 'Views' },
  { id: 'pages', label: 'Pages' },
  { id: 'analytics', label: 'Analytics' }
];

export default function Sidebar({ active = 'work-items', onSelect, counts = {}, projectName = 'Goose Ops' }) {
  return (
    <aside className="h-full rounded-xl border border-border bg-panel p-3 shadow-soft">
      <div className="mb-3 rounded-lg border border-border bg-surface px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Workspace</p>
        <p className="text-sm font-semibold text-ink">{projectName}</p>
      </div>

      <nav className="space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-[13px] ${
              item.id === active ? 'bg-accent/10 font-semibold text-accent' : 'text-ink hover:bg-surface'
            }`}
            onClick={() => onSelect?.(item.id)}
            type="button"
          >
            <span>{item.label}</span>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                item.id === active ? 'bg-accent/15 text-accent' : 'bg-surface text-ink'
              }`}
            >
              {counts[item.id] ?? 0}
            </span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
