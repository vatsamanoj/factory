import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'should',
  'would',
  'could',
  'task',
  'work',
  'item',
  'create',
  'update',
  'add',
  'use',
  'option',
  'true',
  'false',
  'null',
  'const',
  'let',
  'var',
  'function',
  'class',
  'return',
  'import',
  'export'
]);

const lanceState = {
  module: null,
  db: null
};

function toPositiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeTerm(value) {
  return String(value || '').toLowerCase().trim();
}

function tokenize(text, maxUnique) {
  const freq = new Map();
  for (const tokenRaw of String(text || '').match(/[a-z0-9_/-]{3,}/gi) || []) {
    const token = normalizeTerm(tokenRaw);
    if (!token || STOP_WORDS.has(token)) continue;
    if (token.length < 3 || token.length > 48) continue;
    freq.set(token, (freq.get(token) || 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxUnique)
    .map(([term, hits]) => ({ term, hits }));
}

function isLikelyTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const allow = new Set([
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.swift',
    '.rb',
    '.php',
    '.c',
    '.cc',
    '.cpp',
    '.h',
    '.hpp',
    '.cs',
    '.json',
    '.yml',
    '.yaml',
    '.toml',
    '.md',
    '.sql',
    '.sh'
  ]);
  return allow.has(ext);
}

function shouldIndexPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if (/^work-items\/[^/]+\/subagent-orchestration-.*-task-\d+\.md$/i.test(normalized)) return false;
  if (normalized.startsWith('.git/')) return false;
  if (normalized.includes('/.git/')) return false;
  if (normalized.startsWith('node_modules/')) return false;
  if (normalized.includes('/node_modules/')) return false;
  if (normalized.startsWith('.next/')) return false;
  if (normalized.includes('/.next/')) return false;
  if (normalized.startsWith('.cache/')) return false;
  if (normalized.includes('/.cache/')) return false;
  if (normalized.startsWith('coverage/')) return false;
  if (normalized.includes('/coverage/')) return false;
  if (normalized.startsWith('.turbo/')) return false;
  if (normalized.includes('/.turbo/')) return false;
  if (normalized.startsWith('.pnpm-store/')) return false;
  if (normalized.includes('/.pnpm-store/')) return false;
  return true;
}

function isBuildArtifactPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return (
    normalized.startsWith('dist/') ||
    normalized.includes('/dist/') ||
    normalized.startsWith('build/') ||
    normalized.includes('/build/')
  );
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function listRepoFiles(repoPath) {
  const gitTracked = await runCommand('git', ['-C', repoPath, 'ls-files']);
  if (gitTracked.code === 0) {
    const tracked = String(gitTracked.out || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const untrackedRes = await runCommand('git', ['-C', repoPath, 'ls-files', '--others', '--exclude-standard']);
    const untracked =
      untrackedRes.code === 0
        ? String(untrackedRes.out || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        : [];
    const ignoredRes = await runCommand('git', ['-C', repoPath, 'ls-files', '--others', '-i', '--exclude-standard']);
    const ignoredDistOrBuild =
      ignoredRes.code === 0
        ? String(ignoredRes.out || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => {
              const normalized = line.replace(/\\/g, '/');
              return (
                normalized.startsWith('dist/') ||
                normalized.includes('/dist/') ||
                normalized.startsWith('build/') ||
                normalized.includes('/build/')
              );
            })
        : [];
    return Array.from(new Set([...tracked, ...untracked, ...ignoredDistOrBuild]));
  }
  const rg = await runCommand('rg', ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], { cwd: repoPath });
  if (rg.code !== 0) return [];
  return String(rg.out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function dataDir() {
  return process.env.GOOSE_CODE_INDEX_LANCEDB_DIR || path.resolve(process.cwd(), 'server', 'data', 'codeintel.lancedb');
}

function indexTableName(projectId) {
  return `code_index_p${Number(projectId) || 0}`;
}

function metaTableName() {
  return 'code_index_meta';
}

async function ensureLanceModule() {
  if (lanceState.module) return lanceState.module;
  try {
    const mod = await import('@lancedb/lancedb');
    lanceState.module = mod;
    return mod;
  } catch (error) {
    throw new Error(
      `LanceDB dependency missing. Install @lancedb/lancedb in server workspace. (${String(error?.message || error)})`
    );
  }
}

async function getLanceDb() {
  if (lanceState.db) return lanceState.db;
  const mod = await ensureLanceModule();
  const dir = dataDir();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  lanceState.db = await mod.connect(dir);
  return lanceState.db;
}

async function openTableOrNull(tableName) {
  const db = await getLanceDb();
  try {
    return await db.openTable(tableName);
  } catch {
    return null;
  }
}

async function createOrOverwriteTable(tableName, rows) {
  const db = await getLanceDb();
  const safeRows = Array.isArray(rows) && rows.length ? rows : [{ __placeholder: true }];
  return db.createTable(tableName, safeRows, { mode: 'overwrite' });
}

async function tableToArray(table) {
  if (!table) return [];
  if (typeof table.toArray === 'function') {
    return table.toArray();
  }
  if (typeof table.query === 'function') {
    const q = table.query();
    if (q && typeof q.limit === 'function' && typeof q.toArray === 'function') {
      return q.limit(1_000_000).toArray();
    }
    if (q && typeof q.toArray === 'function') {
      return q.toArray();
    }
  }
  throw new Error('Unsupported LanceDB table API: missing toArray/query.toArray');
}

async function writeMeta(projectId, fileCount, termRows, branch) {
  const now = new Date().toISOString();
  const rows = [
    {
      projectId: Number(projectId) || 0,
      lastIndexedAt: now,
      fileCount: Number(fileCount) || 0,
      termRows: Number(termRows) || 0,
      branch: String(branch || '')
    }
  ];
  const tableName = metaTableName();
  const table = await openTableOrNull(tableName);
  if (!table) {
    await createOrOverwriteTable(tableName, rows);
    return;
  }
  const existing = (await tableToArray(table)).filter((row) => Number(row.projectId) !== Number(projectId));
  await createOrOverwriteTable(tableName, [...existing, ...rows]);
}

async function readMeta(projectId) {
  const table = await openTableOrNull(metaTableName());
  if (!table) return null;
  const rows = await tableToArray(table);
  const found = rows.find((row) => Number(row.projectId) === Number(projectId));
  if (!found) return null;
  return {
    projectId: Number(found.projectId),
    lastIndexedAt: String(found.lastIndexedAt || ''),
    fileCount: Number(found.fileCount) || 0,
    termRows: Number(found.termRows) || 0,
    branch: String(found.branch || '')
  };
}

async function replaceIndexRows(projectId, rows) {
  const tableName = indexTableName(projectId);
  await createOrOverwriteTable(tableName, rows);
}

async function readIndexRows(projectId) {
  const table = await openTableOrNull(indexTableName(projectId));
  if (!table) return [];
  const rows = await tableToArray(table);
  return rows.filter((row) => !row.__placeholder);
}

export async function getCodeIndexMeta(projectId) {
  return readMeta(projectId);
}

export async function ensureCodeIndex({ projectId, repoPath, branch, emit }) {
  const staleMs = toPositiveInt(process.env.GOOSE_CODE_INDEX_STALE_MS, 20 * 60 * 1000);
  const maxFiles = toPositiveInt(process.env.GOOSE_CODE_INDEX_MAX_FILES, 2500);
  const maxFileBytes = toPositiveInt(process.env.GOOSE_CODE_INDEX_MAX_FILE_BYTES, 180000);
  const maxTermsPerFile = toPositiveInt(process.env.GOOSE_CODE_INDEX_MAX_TERMS_PER_FILE, 64);
  const meta = await readMeta(projectId);
  const now = Date.now();
  const lastIndexedAt = meta?.lastIndexedAt ? Date.parse(meta.lastIndexedAt) : 0;
  const targetBranch = String(branch || '').trim();
  const isFresh = Number.isFinite(lastIndexedAt) && now - lastIndexedAt <= staleMs;
  const branchMatches = !targetBranch || !meta?.branch || meta.branch === targetBranch;
  if (isFresh && branchMatches) return { indexed: false, meta };

  if (isFresh && !branchMatches) {
    emit?.(`refiner> code-index branch changed ${meta?.branch || 'unknown'} -> ${targetBranch}; rebuilding`);
  }
  emit?.(`refiner> code-index build started for project ${projectId}`);
  const candidateFiles = (await listRepoFiles(repoPath)).filter(shouldIndexPath).filter(isLikelyTextFile).slice(0, maxFiles);
  const rows = [];
  let scanned = 0;

  for (const relativePath of candidateFiles) {
    const absolutePath = path.join(repoPath, relativePath);
    let stat;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    const sizeLimit = isBuildArtifactPath(relativePath) ? maxFileBytes * 3 : maxFileBytes;
    if (!stat.isFile() || stat.size <= 0 || stat.size > sizeLimit) continue;
    let content = '';
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const terms = tokenize(content, maxTermsPerFile);
    if (!terms.length) continue;
    scanned += 1;
    for (const term of terms) {
      rows.push({
        projectId: Number(projectId) || 0,
        term: term.term,
        filePath: relativePath.replace(/\\/g, '/'),
        hits: term.hits,
        updatedAt: new Date().toISOString()
      });
    }
  }

  await replaceIndexRows(projectId, rows);
  await writeMeta(projectId, scanned, rows.length, targetBranch);
  emit?.(`refiner> code-index build done files=${scanned} rows=${rows.length}`);
  return { indexed: true, meta: await readMeta(projectId) };
}

export async function searchIndexedFiles(projectId, terms, limit = 20) {
  const safeTerms = new Set(
    (Array.isArray(terms) ? terms : [])
      .map((term) => normalizeTerm(term))
      .filter(Boolean)
  );
  if (!safeTerms.size) return [];
  const rows = await readIndexRows(projectId);
  const scores = new Map();
  for (const row of rows) {
    const term = normalizeTerm(row.term);
    if (!safeTerms.has(term)) continue;
    const filePath = String(row.filePath || '').replace(/\\/g, '/');
    const hits = Number(row.hits) || 0;
    scores.set(filePath, (scores.get(filePath) || 0) + hits);
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(([filePath, score]) => ({ filePath, score }));
}

export async function listIndexedFiles(projectId, limit = 20) {
  const rows = await readIndexRows(projectId);
  const scores = new Map();
  for (const row of rows) {
    const filePath = String(row.filePath || '').replace(/\\/g, '/');
    if (!filePath) continue;
    const hits = Number(row.hits) || 0;
    scores.set(filePath, (scores.get(filePath) || 0) + hits);
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(([filePath, score]) => ({ filePath, score }));
}
