async function parseApiResponse(res, fallbackMessage) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || fallbackMessage);
    error.details = body.details;
    throw error;
  }
  return body;
}

function withProjectQuery(path, projectId) {
  if (!projectId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}projectId=${encodeURIComponent(projectId)}`;
}

export async function getTasks(projectId) {
  const res = await fetch(withProjectQuery('/api/tasks', projectId));
  return parseApiResponse(res, 'Failed to fetch tasks');
}

export async function getTaskLogs(taskId, limit = 5000) {
  const res = await fetch(`/api/tasks/${taskId}/logs?limit=${encodeURIComponent(limit)}`);
  return parseApiResponse(res, 'Failed to fetch task logs');
}

export async function getTaskAttachments(taskId) {
  const res = await fetch(`/api/tasks/${taskId}/attachments`);
  return parseApiResponse(res, 'Failed to fetch task attachments');
}

export async function approveTask(taskId) {
  const res = await fetch(`/api/tasks/${taskId}/approve`, {
    method: 'POST'
  });
  return parseApiResponse(res, 'Failed to approve task');
}

export async function retryTask(taskId) {
  const res = await fetch(`/api/tasks/${taskId}/retry`, {
    method: 'POST'
  });
  return parseApiResponse(res, 'Failed to retry task');
}

export async function runTaskBuildTest(taskId) {
  const res = await fetch(`/api/tasks/${taskId}/build-test`, {
    method: 'POST'
  });
  return parseApiResponse(res, 'Failed to run build test');
}

export async function updateTaskStatus(taskId, status) {
  const res = await fetch(`/api/tasks/${taskId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  return parseApiResponse(res, 'Failed to update status');
}

export async function updateTaskAssignee(taskId, assigneeType) {
  const res = await fetch(`/api/tasks/${taskId}/assignee`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assigneeType })
  });
  return parseApiResponse(res, 'Failed to update task assignee');
}

export async function createTask(payload) {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create task');
}

export async function getPlugins(projectId) {
  const res = await fetch(withProjectQuery('/api/plugins', projectId));
  return parseApiResponse(res, 'Failed to fetch plugins');
}

export async function getPluginCatalog() {
  const res = await fetch('/api/plugins/catalog');
  return parseApiResponse(res, 'Failed to fetch plugin catalog');
}

export async function getSchemaTemplates() {
  const res = await fetch('/api/schema-templates');
  return parseApiResponse(res, 'Failed to fetch schema templates');
}

export async function createSchemaTemplate(payload) {
  const res = await fetch('/api/schema-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create schema template');
}

export async function updateSchemaTemplate(id, payload) {
  const res = await fetch(`/api/schema-templates/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to update schema template');
}

export async function validatePlugin(payload) {
  const res = await fetch('/api/plugins/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Plugin validation failed');
}

export async function addPlugin(payload) {
  const res = await fetch('/api/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to add plugin');
}

export async function getCycles(projectId) {
  const res = await fetch(withProjectQuery('/api/cycles', projectId));
  return parseApiResponse(res, 'Failed to fetch cycles');
}

export async function createCycle(payload) {
  const res = await fetch('/api/cycles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create cycle');
}

export async function getModules(projectId) {
  const res = await fetch(withProjectQuery('/api/modules', projectId));
  return parseApiResponse(res, 'Failed to fetch modules');
}

export async function createModule(payload) {
  const res = await fetch('/api/modules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create module');
}

export async function getViews(projectId) {
  const res = await fetch(withProjectQuery('/api/views', projectId));
  return parseApiResponse(res, 'Failed to fetch saved views');
}

export async function createView(payload) {
  const res = await fetch('/api/views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create saved view');
}

export async function getPages(projectId) {
  const res = await fetch(withProjectQuery('/api/pages', projectId));
  return parseApiResponse(res, 'Failed to fetch pages');
}

export async function createPage(payload) {
  const res = await fetch('/api/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create page');
}

export async function updatePage(pageId, payload) {
  const res = await fetch(`/api/pages/${pageId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to update page');
}

export async function getAnalytics(projectId) {
  const res = await fetch(withProjectQuery('/api/analytics', projectId));
  return parseApiResponse(res, 'Failed to fetch analytics');
}

export async function getProjects() {
  const res = await fetch('/api/projects');
  return parseApiResponse(res, 'Failed to fetch projects');
}

export async function createProject(payload) {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to create project');
}

export async function updateProject(projectId, payload) {
  const res = await fetch(`/api/projects/${projectId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return parseApiResponse(res, 'Failed to update project');
}

export async function connectProjectRepo(projectId) {
  const res = await fetch(`/api/projects/${projectId}/connect-repo`, {
    method: 'POST'
  });
  return parseApiResponse(res, 'Failed to sync project repository');
}

export async function getProjectRepoStatus(projectId) {
  const res = await fetch(`/api/projects/${projectId}/status`);
  return parseApiResponse(res, 'Failed to fetch repository status');
}

export async function getProjectBranches(projectId) {
  const res = await fetch(`/api/projects/${projectId}/branches`);
  return parseApiResponse(res, 'Failed to fetch project branches');
}
