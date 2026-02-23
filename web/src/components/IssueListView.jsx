export default function IssueListView({ tasks, onSelectTask }) {
  function isCheckedOut(task) {
    return Boolean(task.branchName) && (task.repoCurrentBranch === task.branchName || task.assigneeType === 'goose');
  }

  return (
    <div className="overflow-auto rounded-lg border border-border bg-panel">
      <table className="min-w-full text-left text-xs">
        <thead className="sticky top-0 z-10 border-b border-border bg-surface text-muted">
          <tr>
            <th className="px-3 py-2 font-semibold">Key</th>
            <th className="px-3 py-2 font-semibold">Title</th>
            <th className="px-3 py-2 font-semibold">State</th>
            <th className="px-3 py-2 font-semibold">Assignee</th>
            <th className="px-3 py-2 font-semibold">Priority</th>
            <th className="px-3 py-2 font-semibold">Due Date</th>
            <th className="px-3 py-2 font-semibold">Module</th>
            <th className="px-3 py-2 font-semibold">Cycle</th>
            <th className="px-3 py-2 font-semibold">Runtime</th>
            <th className="px-3 py-2 font-semibold">Branch</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className="cursor-pointer border-b border-border text-[12px] hover:bg-surface"
              onClick={() => onSelectTask(task)}
            >
              <td className="px-3 py-2 font-semibold text-muted">{task.externalId || `GSE-${task.id}`}</td>
              <td className="px-3 py-2">
                <p className="line-clamp-1 font-semibold text-ink">{task.title}</p>
                <p className="line-clamp-1 text-[11px] text-muted">{task.description}</p>
              </td>
              <td className="px-3 py-2 uppercase text-muted">{task.status.replace('_', ' ')}</td>
              <td className="px-3 py-2 text-muted">{task.assigneeType === 'goose' ? 'Goose' : 'Human'}</td>
              <td className="px-3 py-2 text-muted">{task.priority || '-'}</td>
              <td className="px-3 py-2 text-muted">{task.dueDate || '-'}</td>
              <td className="px-3 py-2 text-muted">{task.moduleName || '-'}</td>
              <td className="px-3 py-2 text-muted">{task.cycleName || '-'}</td>
              <td className="px-3 py-2 font-semibold text-ink">{task.runtimeStatus}</td>
                <td className="px-3 py-2 text-muted">
                  {task.branchName ? (
                  isCheckedOut(task) ? <span className="font-semibold text-emerald-700">{task.branchName} (checked out)</span> : task.branchName
                ) : (
                  '-'
                )}
              </td>
            </tr>
          ))}
          {tasks.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-3 py-8 text-center text-muted">
                No issues match current filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
