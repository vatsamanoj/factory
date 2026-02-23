import { useState } from 'react';

export default function CyclesPanel({ cycles, onCreate }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    await onCreate({ name: name.trim(), goal: goal.trim() });
    setName('');
    setGoal('');
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="grid gap-2 rounded-xl border border-border bg-surface p-3 md:grid-cols-[1fr_2fr_auto]">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New cycle name"
          className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
        />
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Goal"
          className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
        />
        <button type="submit" className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">
          Add Cycle
        </button>
      </form>

      <div className="overflow-auto rounded-xl border border-border bg-panel">
        <table className="min-w-full text-left text-xs">
          <thead className="border-b border-border bg-surface text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Name</th>
              <th className="px-3 py-2 font-semibold">Goal</th>
              <th className="px-3 py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((cycle) => (
              <tr key={cycle.id} className="border-b border-border">
                <td className="px-3 py-2 font-semibold text-ink">{cycle.name}</td>
                <td className="px-3 py-2 text-muted">{cycle.goal || 'No goal set'}</td>
                <td className="px-3 py-2 uppercase text-muted">{cycle.status}</td>
              </tr>
            ))}
            {cycles.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-muted">
                  No cycles yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
