function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-border bg-panel px-3 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function BucketList({ title, rows, keyName }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-3">
      <p className="mb-2 text-sm font-semibold text-ink">{title}</p>
      <div className="space-y-2">
        {(rows || []).map((row) => (
          <div key={`${row[keyName]}-${row.count}`} className="flex items-center justify-between rounded-lg bg-surface px-3 py-2 text-xs">
            <span className="uppercase text-muted">{row[keyName]}</span>
            <span className="font-semibold text-ink">{row.count}</span>
          </div>
        ))}
        {!rows?.length ? <p className="text-xs text-muted">No data.</p> : null}
      </div>
    </div>
  );
}

export default function AnalyticsPanel({ analytics }) {
  const snapshot = analytics || {};

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Total Tasks" value={snapshot.totalTasks || 0} />
        <Metric label="Status Buckets" value={(snapshot.byStatus || []).length} />
        <Metric label="Assignee Buckets" value={(snapshot.byAssignee || []).length} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <BucketList title="By Status" rows={snapshot.byStatus} keyName="status" />
        <BucketList title="By Runtime" rows={snapshot.byRuntime} keyName="runtimeStatus" />
        <BucketList title="By Assignee" rows={snapshot.byAssignee} keyName="assigneeType" />
      </div>
    </div>
  );
}
