import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendTaskLog, updateTask } from './db.js';
import { ensureProjectRepoReady } from './repoManager.js';
import { ensureCodeIndex, listIndexedFiles, searchIndexedFiles } from './codeIntelIndex.js';

function emitLine(broadcast, taskId, line) {
  const normalized = String(line || '')
    .replace(/^refiner>/i, 'Rajiv Gupta (Boss)>')
    .replace(/^repo>/i, 'Rajiv Gupta (Boss)>')
    .replace(/^git>/i, 'Rajiv Gupta (Boss)>')
    .replace(/^validate(?:\([^)]+\))?>/i, 'Rajiv Gupta (Boss)>');
  const stamp = new Date().toISOString();
  const entry = `[${stamp}] ${normalized}`;
  appendTaskLog(taskId, entry);
  broadcast({ type: 'task_log', taskId, line: entry });
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

async function branchExists(repoPath, branchName) {
  const branch = String(branchName || '').trim();
  if (!branch) return false;
  const remote = await runCommand('git', ['-C', repoPath, 'rev-parse', '--verify', `origin/${branch}`]);
  if (remote.code === 0) return true;
  const local = await runCommand('git', ['-C', repoPath, 'rev-parse', '--verify', branch]);
  return local.code === 0;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
}

function tokenizeRefinementQuery(task) {
  const text = `${task.title || ''} ${task.description || ''}`.toLowerCase();
  const stopWords = new Set([
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
    'option'
  ]);
  const uniq = new Set();
  for (const token of text.match(/[a-z0-9_/-]{3,}/g) || []) {
    if (stopWords.has(token)) continue;
    uniq.add(token);
    if (uniq.size >= 8) break;
  }
  return Array.from(uniq);
}

function tokenizePathParts(filePath) {
  return String(filePath || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function parseFunctionDefinitions(content) {
  const blocked = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'return',
    'const',
    'let',
    'var',
    'else',
    'do',
    'try',
    'case',
    'break',
    'continue',
    'new',
    'class',
    'function',
    'import',
    'export'
  ]);
  const defs = [];
  const lines = String(content || '').split('\n');
  const patterns = [
    /^\s*export\s+default\s+function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    /^\s*class\s+([A-Za-z_$][\w$]*)\b/,
    /^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ // class/object methods
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = String(match[1] || '').trim();
      if (!name) continue;
      if (blocked.has(name)) continue;
      defs.push({ name, line: i + 1 });
      break;
    }
  }
  return defs;
}

function pickNearestFunction(functions, lineNo) {
  if (!functions.length) return null;
  const target = Number(lineNo) || 1;
  let best = null;
  for (const fn of functions) {
    if (fn.line > target) continue;
    if (!best || fn.line > best.line) best = fn;
  }
  return best || functions[0];
}

function taskIntents(task) {
  const text = `${task?.title || ''} ${task?.description || ''}`.toLowerCase();
  const createWords = ['create', 'add', 'introduce', 'implement', 'build', 'generate', 'new'];
  const editWords = ['edit', 'update', 'fix', 'change', 'modify', 'refactor', 'adjust', 'tune', 'improve', 'optimize'];
  return {
    create: createWords.some((w) => text.includes(w)),
    edit: editWords.some((w) => text.includes(w))
  };
}

function deriveCreatePath(task, topFiles) {
  const first = String(topFiles?.[0]?.file || '').replace(/\\/g, '/');
  const preferredDir = first ? path.posix.dirname(first) : 'src';
  const safeBase = String(task?.title || 'work_item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'work_item';
  return `${preferredDir}/${safeBase}.js`.replace(/\/+/g, '/');
}

function buildActionPlan({ repoPath, task, terms, topFiles, snippets }) {
  const intents = taskIntents(task);
  const filesToEdit = topFiles.slice(0, 6).map((item) => item.file);
  const filesToCreate = [];
  if (intents.create && filesToEdit.length < 2) {
    filesToCreate.push(deriveCreatePath(task, topFiles));
  }

  const snippetByFile = new Map();
  for (const item of snippets) {
    const key = String(item.file || '');
    if (!key) continue;
    if (!snippetByFile.has(key)) snippetByFile.set(key, []);
    snippetByFile.get(key).push(item);
  }

  const functionTargets = [];
  const lineTargets = [];
  const seenFn = new Set();

  for (const file of filesToEdit) {
    const absolutePath = path.join(repoPath, file);
    let content = '';
    try {
      content = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    const functions = parseFunctionDefinitions(content);
    const fileSnippets = snippetByFile.get(file) || [];

    for (const snip of fileSnippets.slice(0, 4)) {
      lineTargets.push({
        file,
        line: snip.line,
        action: 'edit',
        snippet: snip.snippet
      });
      const nearest = pickNearestFunction(functions, snip.line);
      if (!nearest) continue;
      const key = `${file}:${nearest.name}:${nearest.line}`;
      if (seenFn.has(key)) continue;
      seenFn.add(key);
      functionTargets.push({
        file,
        functionName: nearest.name,
        line: nearest.line,
        action: intents.create ? 'create_or_edit' : 'edit'
      });
    }

    if (!fileSnippets.length && functions.length) {
      const topFn = functions[0];
      const key = `${file}:${topFn.name}:${topFn.line}`;
      if (!seenFn.has(key)) {
        seenFn.add(key);
        functionTargets.push({
          file,
          functionName: topFn.name,
          line: topFn.line,
          action: intents.create ? 'create_or_edit' : 'edit'
        });
      }
    }
  }

  return {
    terms,
    intents,
    filesToEdit: filesToEdit.slice(0, 6),
    filesToCreate: filesToCreate.slice(0, 3),
    functionTargets: functionTargets.slice(0, 12),
    lineTargets: lineTargets.slice(0, 16)
  };
}

function parseRgLine(line) {
  const first = line.indexOf(':');
  if (first <= 0) return null;
  const second = line.indexOf(':', first + 1);
  if (second <= first + 1) return null;
  const file = line.slice(0, first);
  const lineNoRaw = line.slice(first + 1, second);
  const snippet = line.slice(second + 1).trim();
  const lineNo = Number.parseInt(lineNoRaw, 10);
  if (!Number.isFinite(lineNo) || lineNo <= 0) return null;
  return { file, line: lineNo, snippet };
}

function makeRelativePath(repoPath, filePath) {
  const normalizedRepo = String(repoPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFile = String(filePath || '').replace(/\\/g, '/');
  if (normalizedRepo && normalizedFile.startsWith(`${normalizedRepo}/`)) {
    return normalizedFile.slice(normalizedRepo.length + 1);
  }
  return normalizedFile;
}

function isGeneratedOrVendorPath(filePath) {
  const p = String(filePath || '').toLowerCase();
  const isOrchestrationReport = /^work-items\/[^/]+\/subagent-orchestration-.*-task-\d+\.md$/.test(p);
  return (
    isOrchestrationReport ||
    p.startsWith('dist/') ||
    p.startsWith('build/') ||
    p.includes('/dist/') ||
    p.includes('/build/') ||
    p.includes('/node_modules/') ||
    p.endsWith('.min.js') ||
    p.endsWith('.map')
  );
}

function isMarkdownReference(value) {
  const text = String(value || '').toLowerCase();
  return text.endsWith('.md') || text.includes('.md#l');
}

async function collectCodeIntel(repoPath, task) {
  const terms = tokenizeRefinementQuery(task);
  const snippets = [];
  const seenSnippet = new Set();
  const indexed = await searchIndexedFiles(task.projectId, terms, 30);
  let indexedFiles = indexed
    .map((item) => item.filePath)
    .filter((filePath) => !isGeneratedOrVendorPath(filePath) && !isMarkdownReference(filePath))
    .slice(0, 20);
  const indexedScore = new Map(indexed.map((item) => [item.filePath, Number(item.score) || 0]));
  if (!indexedFiles.length) {
    const broadFallback = await listIndexedFiles(task.projectId, 40);
    for (const item of broadFallback) {
      const filePath = String(item.filePath || '');
      if (!filePath || isGeneratedOrVendorPath(filePath)) continue;
      if (isMarkdownReference(filePath)) continue;
      if (!indexedScore.has(filePath)) indexedScore.set(filePath, Number(item.score) || 0);
      indexedFiles.push(filePath);
      if (indexedFiles.length >= 20) break;
    }
  }
  const fallbackFileScores = new Map();
  const rgBaseArgs = ['-n', '--no-heading', '--color', 'never', '-S', '--glob', '!.git/**', '--glob', '!node_modules/**'];

  for (const term of terms) {
    const fileArgs = indexedFiles.length ? indexedFiles : [repoPath];
    const res = await runCommand('rg', [...rgBaseArgs, term, ...fileArgs], { cwd: repoPath });
    if (res.code !== 0 && !String(res.err || '').includes('No files were searched')) continue;
    for (const rawLine of String(res.out || '').split('\n')) {
      if (!rawLine.trim()) continue;
      const hit = parseRgLine(rawLine);
      if (!hit) continue;
      const normalizedFile = makeRelativePath(repoPath, hit.file);
      if (isGeneratedOrVendorPath(normalizedFile)) continue;
      if (isMarkdownReference(normalizedFile)) continue;
      fallbackFileScores.set(normalizedFile, (fallbackFileScores.get(normalizedFile) || 0) + 1);
      const key = `${normalizedFile}:${hit.line}`;
      if (!seenSnippet.has(key) && snippets.length < 24) {
        seenSnippet.add(key);
        snippets.push({ ...hit, file: normalizedFile });
      }
    }
  }

  let topFiles;
  if (indexedFiles.length) {
    topFiles = indexedFiles.slice(0, 12).map((file) => ({
      file,
      score: indexedScore.get(file) || fallbackFileScores.get(file) || 0
    }));
  } else {
    topFiles = Array.from(fallbackFileScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([file, score]) => ({ file, score }));
  }

  // Smart relevance pass: prioritize files/snippets whose path or content aligns with task terms.
  const termSet = new Set(terms);
  const snippetCounts = new Map();
  for (const item of snippets) {
    snippetCounts.set(item.file, (snippetCounts.get(item.file) || 0) + 1);
  }
  topFiles = topFiles
    .map((item) => {
      const file = String(item.file || '');
      const pathTokens = tokenizePathParts(file);
      const pathOverlap = pathTokens.filter((token) => termSet.has(token)).length;
      const snippetHits = snippetCounts.get(file) || 0;
      return {
        ...item,
        relevance: (Number(item.score) || 0) + pathOverlap * 3 + snippetHits * 4
      };
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 12)
    .map(({ file, score }) => ({ file, score }));

  const actions = buildActionPlan({
    repoPath,
    task,
    terms,
    topFiles,
    snippets: snippets.slice(0, 12)
  });

  return {
    terms,
    topFiles,
    snippets: snippets.slice(0, 12),
    actions,
    generatedAt: new Date().toISOString()
  };
}

export async function runBacklogRefinement({ task, project, plugins, broadcast }) {
  const running = updateTask(task.id, { runtimeStatus: 'running' });
  broadcast({ type: 'task_status', task: running });
  emitLine(broadcast, task.id, 'refiner> backlog refinement started');

  if (!project) {
    const failed = updateTask(task.id, { runtimeStatus: 'failed' });
    broadcast({ type: 'task_status', task: failed });
    emitLine(broadcast, task.id, 'refiner> no project found for task');
    return;
  }

  try {
    const repo = await ensureProjectRepoReady(project, (line) => emitLine(broadcast, task.id, line));
    const branchName = task.branchName || `gse-${task.id}-${slugify(task.title) || 'work-item'}`;
    const preferredIndexBranch = String(process.env.GOOSE_CODE_INDEX_BRANCH || 'test').trim();
    const requestedBaseBranch = String(task.baseBranch || repo.defaultBranch || 'main').trim() || 'main';
    const usePreferredIndexBranch =
      preferredIndexBranch &&
      preferredIndexBranch !== requestedBaseBranch &&
      (await branchExists(repo.repoPath, preferredIndexBranch));
    const baseBranch = usePreferredIndexBranch ? preferredIndexBranch : requestedBaseBranch;
    if (usePreferredIndexBranch) {
      emitLine(
        broadcast,
        task.id,
        `refiner> using ${preferredIndexBranch} as code-intel base branch (overriding ${requestedBaseBranch})`
      );
    }

    await runCommand('git', ['-C', repo.repoPath, 'checkout', baseBranch]);
    await runCommand('git', ['-C', repo.repoPath, 'pull', '--ff-only', 'origin', baseBranch]);
    await runCommand('git', ['-C', repo.repoPath, 'checkout', '-B', branchName, baseBranch]);
    emitLine(broadcast, task.id, `refiner> branch ready: ${branchName}`);
    await ensureCodeIndex({
      projectId: task.projectId,
      repoPath: repo.repoPath,
      branch: baseBranch,
      emit: (line) => emitLine(broadcast, task.id, line)
    });
    const codeIntel = await collectCodeIntel(repo.repoPath, task);
    // Backlog refinement now uses LanceDB-derived code intel only.
    // Do not carry forward pre-attached markdown docs or generated refinement docs.
    // Keep attached context compact and task-focused:
    // prefer snippet anchors, then add only a couple of file-level fallbacks.
    const snippetAnchors = codeIntel.snippets.slice(0, 8).map((item) => `${item.file}#L${item.line}`);
    const focusedFiles = codeIntel.topFiles
      .map((item) => item.file)
      .filter(Boolean)
      .slice(0, 2);
    const nextContextDocs = Array.from(new Set([...snippetAnchors, ...focusedFiles])).filter(
      (entry) => !isMarkdownReference(entry)
    );
    const updated = updateTask(task.id, {
      branchName,
      refinementFiles: [],
      context: {
        ...(task.context || { docs: [], apis: [], mcps: [] }),
        docs: nextContextDocs,
        codeIntel
      },
      runtimeStatus: 'waiting'
    });
    broadcast({ type: 'task_status', task: updated });
    emitLine(
      broadcast,
      task.id,
      `refiner> code-intel ready terms=${codeIntel.terms.join(', ') || 'none'} files=${codeIntel.topFiles.length} snippets=${codeIntel.snippets.length} actionFiles=${codeIntel.actions?.filesToEdit?.length || 0} actionFns=${codeIntel.actions?.functionTargets?.length || 0}`
    );
    for (const item of codeIntel.topFiles.slice(0, 5)) {
      emitLine(broadcast, task.id, `refiner> file ${item.file} (score=${item.score})`);
    }
  } catch (error) {
    const failed = updateTask(task.id, { runtimeStatus: 'failed' });
    broadcast({ type: 'task_status', task: failed });
    emitLine(broadcast, task.id, `refiner> failed: ${String(error?.message || error)}`);
  }
}
