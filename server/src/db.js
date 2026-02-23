import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(moduleDir, '..');
const canonicalDataDir = path.join(serverRoot, 'data');
const canonicalDbPath = path.join(canonicalDataDir, 'dashboard.db');
const legacyDbPath = path.join(serverRoot, 'server', 'data', 'dashboard.db');
fs.mkdirSync(canonicalDataDir, { recursive: true });

if (process.env.DASHBOARD_DB_PATH) {
  const envDir = path.dirname(process.env.DASHBOARD_DB_PATH);
  fs.mkdirSync(envDir, { recursive: true });
} else if (fs.existsSync(legacyDbPath)) {
  const legacyStat = fs.statSync(legacyDbPath);
  if (!fs.existsSync(canonicalDbPath)) {
    fs.copyFileSync(legacyDbPath, canonicalDbPath);
  } else {
    const canonicalStat = fs.statSync(canonicalDbPath);
    if (legacyStat.mtimeMs > canonicalStat.mtimeMs && legacyStat.size > canonicalStat.size) {
      fs.copyFileSync(legacyDbPath, canonicalDbPath);
    }
  }
}

const dbPath = process.env.DASHBOARD_DB_PATH || canonicalDbPath;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('DROP TABLE IF EXISTS code_index_terms;');
db.exec('DROP TABLE IF EXISTS code_index_meta;');
db.exec('DROP INDEX IF EXISTS idx_code_index_terms_project_term;');
db.exec('DROP INDEX IF EXISTS idx_code_index_terms_project_file;');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    repo_url TEXT,
    repo_path TEXT,
    default_branch TEXT,
    github_token TEXT,
    auto_pr INTEGER NOT NULL DEFAULT 0,
    auto_merge INTEGER NOT NULL DEFAULT 0,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    external_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    priority TEXT,
    base_branch TEXT,
    branch_name TEXT,
    refinement_files_json TEXT NOT NULL DEFAULT '[]',
    assignee_type TEXT NOT NULL,
    status TEXT NOT NULL,
    runtime_status TEXT NOT NULL,
    context_json TEXT NOT NULL,
    cycle_id INTEGER,
    module_id INTEGER,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plugins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    schema_id TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT NOT NULL,
    goal TEXT,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL DEFAULT '#1d4ed8',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS saved_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    name TEXT NOT NULL,
    view_mode TEXT NOT NULL DEFAULT 'board',
    query TEXT NOT NULL DEFAULT '',
    assignee_filter TEXT NOT NULL DEFAULT 'all',
    runtime_filter TEXT NOT NULL DEFAULT 'all',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    line TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS execution_leases (
    task_id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT 'goose-runner',
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    attributes_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

`);

db.exec('CREATE INDEX IF NOT EXISTS idx_execution_leases_expires_at ON execution_leases(expires_at);');

function listColumnNames(tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((col) => col.name));
}

function ensureColumns(tableName, columns) {
  const existing = listColumnNames(tableName);
  for (const column of columns) {
    if (existing.has(column.name)) continue;
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.ddl}`);
  }
}

ensureColumns('tasks', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'external_id', ddl: 'external_id TEXT' },
  { name: 'due_date', ddl: 'due_date TEXT' },
  { name: 'priority', ddl: 'priority TEXT' },
  { name: 'base_branch', ddl: 'base_branch TEXT' },
  { name: 'branch_name', ddl: 'branch_name TEXT' },
  { name: 'refinement_files_json', ddl: "refinement_files_json TEXT NOT NULL DEFAULT '[]'" },
  { name: 'cycle_id', ddl: 'cycle_id INTEGER' },
  { name: 'module_id', ddl: 'module_id INTEGER' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
db.exec(`UPDATE tasks SET status = 'todo' WHERE status = 'triage'`);
db.exec(`UPDATE tasks SET runtime_status = 'failed', status = 'review' WHERE runtime_status = 'running'`);
db.exec(`UPDATE tasks SET runtime_status = 'success' WHERE status = 'done' AND runtime_status = 'running'`);
db.prepare(`UPDATE execution_leases SET status = 'expired', updated_at = ? WHERE status = 'running' AND expires_at <= ?`).run(
  new Date().toISOString(),
  new Date().toISOString()
);

ensureColumns('plugins', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'config_json', ddl: "config_json TEXT NOT NULL DEFAULT '{}'" },
  { name: 'schema_id', ddl: "schema_id TEXT NOT NULL DEFAULT ''" },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
ensureColumns('cycles', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
ensureColumns('modules', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
ensureColumns('saved_views', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
ensureColumns('pages', [
  { name: 'project_id', ddl: 'project_id INTEGER' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);

const existingProjects = db.prepare('SELECT * FROM projects ORDER BY id ASC').all();
ensureColumns('projects', [
  { name: 'repo_url', ddl: 'repo_url TEXT' },
  { name: 'repo_path', ddl: 'repo_path TEXT' },
  { name: 'default_branch', ddl: 'default_branch TEXT' },
  { name: 'github_token', ddl: 'github_token TEXT' },
  { name: 'auto_pr', ddl: 'auto_pr INTEGER NOT NULL DEFAULT 0' },
  { name: 'auto_merge', ddl: 'auto_merge INTEGER NOT NULL DEFAULT 0' },
  { name: 'attributes_json', ddl: "attributes_json TEXT NOT NULL DEFAULT '{}'" }
]);
if (existingProjects.length === 0) {
  db.prepare(
    'INSERT INTO projects (name, description, repo_url, repo_path, default_branch, github_token, auto_pr, auto_merge, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    'Auto-campaigns launch',
    'Primary campaign command center',
    '',
    '',
    'main',
    '',
    0,
    0,
    new Date().toISOString()
  );
}

const defaultProjectId = db.prepare('SELECT id FROM projects ORDER BY id ASC LIMIT 1').get().id;
db.prepare('UPDATE tasks SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);
db.prepare('UPDATE plugins SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);
db.prepare('UPDATE cycles SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);
db.prepare('UPDATE modules SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);
db.prepare('UPDATE saved_views SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);
db.prepare('UPDATE pages SET project_id = ? WHERE project_id IS NULL').run(defaultProjectId);

function resolveProjectId(value) {
  const candidate = Number(value);
  if (Number.isFinite(candidate)) {
    const found = db.prepare('SELECT id FROM projects WHERE id = ?').get(candidate);
    if (found) return found.id;
  }
  return defaultProjectId;
}

const seedCount = db.prepare('SELECT COUNT(*) as count FROM tasks').get().count;

if (seedCount === 0) {
  const now = new Date().toISOString();
  const insertTask = db.prepare(`
    INSERT INTO tasks (project_id, external_id, title, description, due_date, priority, assignee_type, status, runtime_status, context_json, cycle_id, module_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const cycleId = db
    .prepare('INSERT INTO cycles (project_id, name, goal, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(defaultProjectId, 'Sprint Alpha', 'Stabilize Goose integrations', now.slice(0, 10), now.slice(0, 10), 'active', now)
    .lastInsertRowid;

  const moduleId = db
    .prepare('INSERT INTO modules (project_id, name, description, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(defaultProjectId, 'Core Platform', 'Execution layer and orchestration', '#1d4ed8', now).lastInsertRowid;

  insertTask.run(
    defaultProjectId,
    null,
    'Draft PRD for MCP Integration',
    'Collect required plugin endpoints and draft acceptance criteria.',
    null,
    'Medium',
    'human',
    'backlog',
    'waiting',
    JSON.stringify({ docs: ['SAFTA.pdf'], apis: ['plugin-openapi.json'], mcps: [] }),
    cycleId,
    moduleId,
    now
  );

  insertTask.run(
    defaultProjectId,
    null,
    'Generate CI patch using Goose',
    'Run unattended fix and push branch for review.',
    null,
    'High',
    'goose',
    'triage',
    'waiting',
    JSON.stringify({ docs: ['ci-rules.md'], apis: ['github-api.json'], mcps: ['https://mcp.github.local'] }),
    cycleId,
    moduleId,
    now
  );
}

const autoCampaignSeed = [
  { externalId: 'ENA 14', title: 'Audit user data to shortlist ideal case studies', dueDate: '15 Apr, 2025', priority: 'Medium', status: 'backlog' },
  { externalId: 'CON 20', title: 'Interview product and design for behind-the-scenes launch story', dueDate: '20 Apr, 2025', priority: 'Medium', status: 'backlog' },
  { externalId: 'CON 24', title: 'Benchmark competitor feature launches for positioning inputs', dueDate: '17 Apr, 2025', priority: 'Medium', status: 'backlog' },
  { externalId: 'DES 42', title: 'Mock up in-app spotlight banner for launch week', dueDate: '05 May, 2025', priority: 'High', status: 'backlog' },
  { externalId: 'CON 51', title: 'Draft product messaging for homepage hero refresh', dueDate: '14 Apr, 2025', priority: 'High', status: 'todo' },
  { externalId: 'DES 65', title: 'Storyboard launch explainer video with use-case narrative', dueDate: '5 May, 2025', priority: 'High', status: 'todo' },
  { externalId: 'CAM 60', title: 'Prep tailored drip emails for power users vs. churn-risk segment', dueDate: '16 Mar, 2025', priority: 'High', status: 'in_progress' },
  { externalId: 'CON 75', title: 'Write long-form blog: "How smart auto-campaigns launch faster"', dueDate: '17 Mar, 2025', priority: 'High', status: 'in_progress' },
  { externalId: 'DES 32', title: 'Create walkthrough carousel for in-app announcement', dueDate: '20 Mar, 2025', priority: 'High', status: 'in_progress' },
  { externalId: 'ENA 37', title: 'QA UTM tracking across email, in-app, and web CTAs', dueDate: '24 Mar, 2025', priority: 'High', status: 'in_progress' },
  { externalId: 'ENA 39', title: 'Coordinate with CS team to flag ideal accounts for launch outreach', dueDate: '20 Mar, 2025', priority: 'High', status: 'in_progress' }
];

for (const item of autoCampaignSeed) {
  const exists = db
    .prepare('SELECT id FROM tasks WHERE project_id = ? AND external_id = ?')
    .get(defaultProjectId, item.externalId);
  if (exists) continue;
  db.prepare(
    `INSERT INTO tasks (project_id, external_id, title, description, due_date, priority, assignee_type, status, runtime_status, context_json, cycle_id, module_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    defaultProjectId,
    item.externalId,
    item.title,
    '',
    item.dueDate,
    item.priority,
    'human',
    item.status,
    'waiting',
    JSON.stringify({ docs: [], apis: [], mcps: [] }),
    null,
    null,
    new Date().toISOString()
  );
}

const hasLaunchBrief = db.prepare('SELECT id FROM pages WHERE project_id = ? AND title = ?').get(defaultProjectId, 'Launch Brief');
if (!hasLaunchBrief) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO pages (project_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    defaultProjectId,
    'Launch Brief',
    `# Auto-campaigns launch\n\n## Goal\nShip a coordinated launch with strong adoption and clear positioning.\n\n## Checklist\n- Messaging alignment\n- In-app walkthrough readiness\n- UTM QA\n- Blog and email sequence`,
    now,
    now
  );
}

function mapTask(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    externalId: row.external_id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    priority: row.priority,
    baseBranch: row.base_branch || '',
    branchName: row.branch_name || '',
    refinementFiles: JSON.parse(row.refinement_files_json || '[]'),
    assigneeType: row.assignee_type,
    status: row.status,
    runtimeStatus: row.runtime_status,
    context: JSON.parse(row.context_json),
    cycleId: row.cycle_id,
    moduleId: row.module_id,
    attributes: JSON.parse(row.attributes_json || '{}'),
    createdAt: row.created_at
  };
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const parseObjectJson = (value) => {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

function collectExtraAttributes(input, knownKeys) {
  const extras = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (knownKeys.has(key)) continue;
    if (value === undefined) continue;
    extras[key] = value;
  }
  return extras;
}

function mergeAttributes(currentAttributes, patch, knownKeys) {
  const next = { ...(currentAttributes || {}) };
  if (patch?.attributes && typeof patch.attributes === 'object' && !Array.isArray(patch.attributes)) {
    Object.assign(next, patch.attributes);
  }
  Object.assign(next, collectExtraAttributes(patch, knownKeys));
  return next;
}

function buildDynamicUpdate(patch, fieldMap) {
  const sets = [];
  const values = [];
  for (const [key, config] of Object.entries(fieldMap)) {
    if (!hasOwn(patch, key)) continue;
    const value = config.toDb ? config.toDb(patch[key]) : patch[key];
    sets.push(`${config.column} = ?`);
    values.push(value);
  }
  if (!sets.length) return null;
  return { setClause: sets.join(', '), values };
}

function runDynamicUpdate(tableName, idColumn, idValue, patch, fieldMap) {
  const update = buildDynamicUpdate(patch, fieldMap);
  if (!update) return false;
  db.prepare(`UPDATE ${tableName} SET ${update.setClause} WHERE ${idColumn} = ?`).run(...update.values, idValue);
  return true;
}

function runImmediateTransaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  }
}

function parseIsoMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function mapExecutionLease(row) {
  if (!row) return null;
  return {
    taskId: row.task_id,
    runId: row.run_id,
    idempotencyKey: row.idempotency_key || '',
    owner: row.owner || 'goose-runner',
    status: row.status || 'running',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

const PROJECT_UPDATE_FIELDS = {
  name: { column: 'name' },
  description: { column: 'description', toDb: (v) => v ?? '' },
  repoUrl: { column: 'repo_url', toDb: (v) => v ?? '' },
  repoPath: { column: 'repo_path', toDb: (v) => v ?? '' },
  defaultBranch: { column: 'default_branch', toDb: (v) => v ?? 'main' },
  githubToken: { column: 'github_token', toDb: (v) => v ?? '' },
  autoPr: { column: 'auto_pr', toDb: (v) => (v ? 1 : 0) },
  autoMerge: { column: 'auto_merge', toDb: (v) => (v ? 1 : 0) },
  attributes: { column: 'attributes_json', toDb: (v) => JSON.stringify(v || {}) }
};

const TASK_UPDATE_FIELDS = {
  externalId: { column: 'external_id', toDb: (v) => v || null },
  title: { column: 'title' },
  description: { column: 'description', toDb: (v) => v ?? '' },
  dueDate: { column: 'due_date', toDb: (v) => v || null },
  priority: { column: 'priority', toDb: (v) => v || null },
  baseBranch: { column: 'base_branch', toDb: (v) => v || '' },
  branchName: { column: 'branch_name', toDb: (v) => v || '' },
  refinementFiles: { column: 'refinement_files_json', toDb: (v) => JSON.stringify(v || []) },
  assigneeType: { column: 'assignee_type' },
  status: { column: 'status' },
  runtimeStatus: { column: 'runtime_status' },
  context: { column: 'context_json', toDb: (v) => JSON.stringify(v || { docs: [], apis: [], mcps: [] }) },
  cycleId: { column: 'cycle_id', toDb: (v) => v || null },
  moduleId: { column: 'module_id', toDb: (v) => v || null },
  attributes: { column: 'attributes_json', toDb: (v) => JSON.stringify(v || {}) }
};

const PROJECT_INPUT_KEYS = new Set(['name', 'description', 'repoUrl', 'repoPath', 'defaultBranch', 'githubToken', 'autoPr', 'autoMerge', 'attributes']);
const TASK_INPUT_KEYS = new Set([
  'projectId',
  'externalId',
  'title',
  'description',
  'dueDate',
  'priority',
  'baseBranch',
  'branchName',
  'refinementFiles',
  'assigneeType',
  'status',
  'runtimeStatus',
  'context',
  'cycleId',
  'moduleId',
  'attributes'
]);
const PLUGIN_INPUT_KEYS = new Set(['projectId', 'name', 'type', 'url', 'schemaId', 'config', 'attributes']);
const CYCLE_INPUT_KEYS = new Set(['projectId', 'name', 'goal', 'startDate', 'endDate', 'status', 'attributes']);
const MODULE_INPUT_KEYS = new Set(['projectId', 'name', 'description', 'color', 'attributes']);
const VIEW_INPUT_KEYS = new Set(['projectId', 'name', 'viewMode', 'query', 'assigneeFilter', 'runtimeFilter', 'attributes']);
const PAGE_INPUT_KEYS = new Set(['projectId', 'title', 'content', 'attributes']);

export function listProjects() {
  return db
    .prepare('SELECT * FROM projects ORDER BY created_at ASC, id ASC')
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      repoUrl: row.repo_url || '',
      repoPath: row.repo_path || '',
      defaultBranch: row.default_branch || 'main',
      githubToken: row.github_token || '',
      autoPr: Boolean(row.auto_pr),
      autoMerge: Boolean(row.auto_merge),
      attributes: parseObjectJson(row.attributes_json),
      createdAt: row.created_at
    }));
}

export function createProject(input) {
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, PROJECT_INPUT_KEYS);
  const result = db
    .prepare(
      'INSERT INTO projects (name, description, repo_url, repo_path, default_branch, github_token, auto_pr, auto_merge, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.name,
      input.description || '',
      input.repoUrl || '',
      input.repoPath || '',
      input.defaultBranch || 'main',
      input.githubToken || '',
      input.autoPr ? 1 : 0,
      input.autoMerge ? 1 : 0,
      JSON.stringify(attributes),
      now
    );
  return listProjects().find((row) => row.id === result.lastInsertRowid);
}

export function getProject(projectId) {
  const pid = resolveProjectId(projectId);
  return listProjects().find((row) => row.id === pid) || null;
}

export function updateProject(projectId, patch) {
  const pid = resolveProjectId(projectId);
  const current = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  if (!current) return null;
  const nextAttributes = mergeAttributes(parseObjectJson(current.attributes_json), patch, PROJECT_INPUT_KEYS);
  runDynamicUpdate('projects', 'id', pid, { ...patch, attributes: nextAttributes }, PROJECT_UPDATE_FIELDS);
  return listProjects().find((row) => row.id === pid) || null;
}

export function listTasks(projectId) {
  const pid = resolveProjectId(projectId);
  return db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id DESC').all(pid).map(mapTask);
}

export function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? mapTask(row) : null;
}

export function createTask(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, TASK_INPUT_KEYS);
  const project = getProject(pid);
  const baseBranch = String(input.baseBranch || '').trim() || String(project?.defaultBranch || 'main').trim() || 'main';
  const result = db
    .prepare(
      `INSERT INTO tasks (project_id, external_id, title, description, due_date, priority, base_branch, branch_name, refinement_files_json, assignee_type, status, runtime_status, context_json, cycle_id, module_id, attributes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pid,
      input.externalId || null,
      input.title,
      input.description || '',
      input.dueDate || null,
      input.priority || null,
      baseBranch,
      input.branchName || '',
      JSON.stringify(input.refinementFiles || []),
      input.assigneeType || 'human',
      input.status || 'backlog',
      'waiting',
      JSON.stringify(input.context || { docs: [], apis: [], mcps: [] }),
      input.cycleId || null,
      input.moduleId || null,
      JSON.stringify(attributes),
      now
    );

  return getTask(result.lastInsertRowid);
}

export function updateTask(taskId, patch) {
  const currentRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!currentRow) return null;
  const nextAttributes = mergeAttributes(parseObjectJson(currentRow.attributes_json), patch, TASK_INPUT_KEYS);
  const updated = runDynamicUpdate('tasks', 'id', taskId, { ...patch, attributes: nextAttributes }, TASK_UPDATE_FIELDS);
  if (!updated) return mapTask(currentRow);
  return getTask(taskId);
}

export function listPlugins(projectId) {
  const pid = resolveProjectId(projectId);
  return db
    .prepare('SELECT * FROM plugins WHERE project_id = ? ORDER BY id DESC')
    .all(pid)
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      schemaId: row.schema_id,
      config: JSON.parse(row.config_json || '{}'),
      attributes: parseObjectJson(row.attributes_json),
      createdAt: row.created_at
    }));
}

export function createPlugin(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, PLUGIN_INPUT_KEYS);
  const result = db
    .prepare('INSERT INTO plugins (project_id, name, type, url, schema_id, config_json, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pid, input.name, input.type || 'mcp', input.url, input.schemaId || '', JSON.stringify(input.config || {}), JSON.stringify(attributes), now);
  return listPlugins(pid).find((row) => row.id === result.lastInsertRowid);
}

export function listCycles(projectId) {
  const pid = resolveProjectId(projectId);
  return db
    .prepare('SELECT * FROM cycles WHERE project_id = ? ORDER BY id DESC')
    .all(pid)
    .map((row) => ({ ...row, attributes: parseObjectJson(row.attributes_json) }));
}

export function createCycle(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, CYCLE_INPUT_KEYS);
  const result = db
    .prepare('INSERT INTO cycles (project_id, name, goal, start_date, end_date, status, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(pid, input.name, input.goal || '', input.startDate || null, input.endDate || null, input.status || 'planned', JSON.stringify(attributes), now);
  const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(result.lastInsertRowid);
  return row ? { ...row, attributes: parseObjectJson(row.attributes_json) } : null;
}

export function listModules(projectId) {
  const pid = resolveProjectId(projectId);
  return db
    .prepare('SELECT * FROM modules WHERE project_id = ? ORDER BY id DESC')
    .all(pid)
    .map((row) => ({ ...row, attributes: parseObjectJson(row.attributes_json) }));
}

export function createModule(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, MODULE_INPUT_KEYS);
  const result = db
    .prepare('INSERT INTO modules (project_id, name, description, color, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pid, input.name, input.description || '', input.color || '#1d4ed8', JSON.stringify(attributes), now);
  const row = db.prepare('SELECT * FROM modules WHERE id = ?').get(result.lastInsertRowid);
  return row ? { ...row, attributes: parseObjectJson(row.attributes_json) } : null;
}

export function listViews(projectId) {
  const pid = resolveProjectId(projectId);
  return db
    .prepare('SELECT * FROM saved_views WHERE project_id = ? ORDER BY id DESC')
    .all(pid)
    .map((row) => ({ ...row, attributes: parseObjectJson(row.attributes_json) }));
}

export function createView(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, VIEW_INPUT_KEYS);
  const result = db
    .prepare(
      'INSERT INTO saved_views (project_id, name, view_mode, query, assignee_filter, runtime_filter, attributes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      pid,
      input.name,
      input.viewMode || 'board',
      input.query || '',
      input.assigneeFilter || 'all',
      input.runtimeFilter || 'all',
      JSON.stringify(attributes),
      now
    );
  const row = db.prepare('SELECT * FROM saved_views WHERE id = ?').get(result.lastInsertRowid);
  return row ? { ...row, attributes: parseObjectJson(row.attributes_json) } : null;
}

export function listPages(projectId) {
  const pid = resolveProjectId(projectId);
  return db
    .prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY updated_at DESC')
    .all(pid)
    .map((row) => ({ ...row, attributes: parseObjectJson(row.attributes_json) }));
}

export function createPage(input) {
  const pid = resolveProjectId(input.projectId);
  const now = new Date().toISOString();
  const attributes = mergeAttributes({}, input, PAGE_INPUT_KEYS);
  const result = db
    .prepare('INSERT INTO pages (project_id, title, content, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(pid, input.title, input.content || '', JSON.stringify(attributes), now, now);
  const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(result.lastInsertRowid);
  return row ? { ...row, attributes: parseObjectJson(row.attributes_json) } : null;
}

export function updatePage(pageId, input) {
  const pid = resolveProjectId(input.projectId);
  const page = db.prepare('SELECT * FROM pages WHERE id = ? AND project_id = ?').get(pageId, pid);
  if (!page) return null;
  const now = new Date().toISOString();
  const nextAttributes = mergeAttributes(parseObjectJson(page.attributes_json), input, PAGE_INPUT_KEYS);
  db.prepare('UPDATE pages SET title = ?, content = ?, attributes_json = ?, updated_at = ? WHERE id = ?').run(
    input.title || page.title,
    typeof input.content === 'string' ? input.content : page.content,
    JSON.stringify(nextAttributes),
    now,
    pageId
  );
  const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId);
  return row ? { ...row, attributes: parseObjectJson(row.attributes_json) } : null;
}

export function getAnalyticsSnapshot(projectId) {
  const pid = resolveProjectId(projectId);
  const totals = db.prepare('SELECT COUNT(*) as total FROM tasks WHERE project_id = ?').get(pid);
  const byStatus = db
    .prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status ORDER BY count DESC')
    .all(pid);
  const byRuntime = db
    .prepare(
      'SELECT runtime_status as runtimeStatus, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY runtime_status ORDER BY count DESC'
    )
    .all(pid);
  const byAssignee = db
    .prepare('SELECT assignee_type as assigneeType, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY assignee_type ORDER BY count DESC')
    .all(pid);

  return {
    totalTasks: totals.total,
    byStatus,
    byRuntime,
    byAssignee,
    generatedAt: new Date().toISOString()
  };
}

export function appendTaskLog(taskId, line) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO task_logs (task_id, line, created_at) VALUES (?, ?, ?)').run(taskId, line, now);
}

export function listTaskLogs(taskId, limit = 5000) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 50000);
  return db
    .prepare('SELECT line, created_at FROM task_logs WHERE task_id = ? ORDER BY id ASC LIMIT ?')
    .all(taskId, safeLimit);
}

export function getTaskExecutionLease(taskId) {
  const row = db.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId);
  return mapExecutionLease(row);
}

export function acquireTaskExecutionLease({ taskId, runId, idempotencyKey = '', owner = 'goose-runner', leaseMs = 900000 }) {
  const ttlMs = Math.max(15000, Number(leaseMs) || 900000);
  const idem = String(idempotencyKey || '').trim().slice(0, 200);
  const actor = String(owner || 'goose-runner').trim().slice(0, 120) || 'goose-runner';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const nextExpiryIso = new Date(nowMs + ttlMs).toISOString();

  return runImmediateTransaction(() => {
    const currentRow = db.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId);
    if (!currentRow) {
      db.prepare(
        'INSERT INTO execution_leases (task_id, run_id, idempotency_key, owner, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(taskId, runId, idem, actor, 'running', nowIso, nowIso, nextExpiryIso);
      return { acquired: true, reason: 'created', lease: mapExecutionLease(db.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId)) };
    }

    const current = mapExecutionLease(currentRow);
    const active = current.status === 'running' && parseIsoMs(current.expiresAt) > nowMs;
    if (current.runId === runId) {
      db.prepare('UPDATE execution_leases SET updated_at = ?, expires_at = ?, status = ? WHERE task_id = ? AND run_id = ?').run(
        nowIso,
        nextExpiryIso,
        'running',
        taskId,
        runId
      );
      return { acquired: true, reason: 'renewed', lease: mapExecutionLease(db.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId)) };
    }

    if (active) {
      if (idem && current.idempotencyKey && current.idempotencyKey === idem) {
        return { acquired: false, reason: 'idempotent-replay', lease: current };
      }
      return { acquired: false, reason: 'already-running', lease: current };
    }

    db.prepare(
      'UPDATE execution_leases SET run_id = ?, idempotency_key = ?, owner = ?, status = ?, updated_at = ?, expires_at = ? WHERE task_id = ?'
    ).run(runId, idem, actor, 'running', nowIso, nextExpiryIso, taskId);
    return { acquired: true, reason: 'reclaimed-expired', lease: mapExecutionLease(db.prepare('SELECT * FROM execution_leases WHERE task_id = ?').get(taskId)) };
  });
}

export function heartbeatTaskExecutionLease({ taskId, runId, leaseMs = 900000 }) {
  const ttlMs = Math.max(15000, Number(leaseMs) || 900000);
  const nowIso = new Date().toISOString();
  const nextExpiryIso = new Date(Date.now() + ttlMs).toISOString();
  const updated = db
    .prepare('UPDATE execution_leases SET updated_at = ?, expires_at = ? WHERE task_id = ? AND run_id = ? AND status = ?')
    .run(nowIso, nextExpiryIso, taskId, runId, 'running');
  return updated.changes > 0;
}

export function releaseTaskExecutionLease({ taskId, runId, status = 'completed' }) {
  const nowIso = new Date().toISOString();
  const finalStatus = String(status || 'completed').trim().slice(0, 40) || 'completed';
  const updated = db
    .prepare('UPDATE execution_leases SET status = ?, updated_at = ?, expires_at = ? WHERE task_id = ? AND run_id = ?')
    .run(finalStatus, nowIso, nowIso, taskId, runId);
  return updated.changes > 0;
}
