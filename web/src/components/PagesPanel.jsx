import { useEffect, useMemo, useState } from 'react';

export default function PagesPanel({ pages, onCreate, onUpdate }) {
  const [title, setTitle] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState('');
  const selected = useMemo(() => pages.find((p) => p.id === selectedId) || null, [pages, selectedId]);

  useEffect(() => {
    if (!pages.length) return;
    if (!selectedId) setSelectedId(pages[0].id);
  }, [pages, selectedId]);

  useEffect(() => {
    setDraft(selected?.content || '');
  }, [selected?.id, selected?.content]);

  async function submitCreate(event) {
    event.preventDefault();
    const name = title.trim();
    if (!name) return;
    const { page } = await onCreate({ title: name, content: '' });
    setTitle('');
    setSelectedId(page.id);
  }

  async function savePage() {
    if (!selected) return;
    await onUpdate(selected.id, { content: draft });
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="rounded-lg border border-border bg-surface p-3">
        <form onSubmit={submitCreate} className="mb-3 flex gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="New page title"
            className="w-full rounded-md border border-border bg-panel px-2 py-1.5 text-xs"
          />
          <button type="submit" className="rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-white">
            Add
          </button>
        </form>
        <div className="space-y-1">
          {pages.map((page) => (
            <button
              key={page.id}
              type="button"
              onClick={() => setSelectedId(page.id)}
              className={`w-full rounded-md px-2.5 py-2 text-left text-xs ${
                selectedId === page.id ? 'bg-accent/10 font-semibold text-accent' : 'text-ink hover:bg-panel'
              }`}
            >
              {page.title}
            </button>
          ))}
          {!pages.length ? <p className="py-4 text-center text-xs text-muted">No pages yet.</p> : null}
        </div>
      </aside>

      <section className="rounded-lg border border-border bg-panel p-3">
        {selected ? (
          <>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">{selected.title}</h3>
              <button onClick={savePage} className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white">
                Save
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[360px] w-full rounded-lg border border-border bg-surface p-3 font-mono text-xs text-ink"
            />
          </>
        ) : (
          <p className="text-xs text-muted">Select a page to edit.</p>
        )}
      </section>
    </div>
  );
}
