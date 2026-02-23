function toPositiveInt(raw, fallback) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function compactText(value, maxChars) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function compactList(values, maxItems, maxItemChars) {
  return (Array.isArray(values) ? values : [])
    .map((item) => compactText(item, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function compactPrompt(value, maxChars) {
  const normalized = String(value || '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 180))
    .filter(Boolean)
    .join('\n');
  return normalized.slice(0, maxChars);
}

function normalizePathHint(value, maxChars) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  return compactText(raw.replace(/^\.\/+/, ''), maxChars);
}

function compactActionFiles(values, maxItems, maxItemChars) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizePathHint(item, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function compactActionFunctions(values, maxItems, maxItemChars) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      const file = compactText(item?.file || '', 48);
      const fn = compactText(item?.functionName || '', 36);
      const line = Number(item?.line) || 0;
      const action = compactText(item?.action || 'edit', 16);
      return compactText(`${file}:${fn}@L${line || 0}(${action})`, maxItemChars);
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function compactActionLines(values, maxItems, maxItemChars) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      const file = normalizePathHint(item?.file || '', 52);
      const line = Number(item?.line) || 0;
      const action = compactText(item?.action || 'edit', 16);
      return compactText(`${file}#L${line || 0}(${action})`, maxItemChars);
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueCompact(values, maxItems, maxItemChars) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(values) ? values : []) {
    const v = compactText(item, maxItemChars);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractLineTargetFiles(actionLines, maxItems, maxItemChars) {
  const files = [];
  for (const row of Array.isArray(actionLines) ? actionLines : []) {
    const token = String(row || '').split('#L')[0].trim();
    if (!token) continue;
    files.push(normalizePathHint(token, maxItemChars));
    if (files.length >= maxItems) break;
  }
  return files.filter(Boolean);
}

function fitPromptLines(requiredLines, optionalLines, maxChars) {
  const lines = [...requiredLines];
  let text = compactPrompt(lines.join('\n'), maxChars);
  for (const line of optionalLines) {
    if (!line) continue;
    const candidate = compactPrompt(`${text}\n${line}`, maxChars);
    if (candidate.length <= text.length) continue;
    text = candidate;
    if (text.length >= maxChars) break;
  }
  return text;
}

export function hydratePrompt(task, project) {
  const maxPromptChars = toPositiveInt(process.env.GOOSE_PROMPT_MAX_CHARS, 1200);
  const maxItems = toPositiveInt(process.env.GOOSE_PROMPT_MAX_ITEMS, 3);
  const maxItemChars = toPositiveInt(process.env.GOOSE_PROMPT_MAX_ITEM_CHARS, 72);
  const title = compactText(task.title, 80) || 'Untitled task';
  const description = compactText(task.description, 180) || 'No description.';
  const taskKey = compactText(task.externalId || `GSE-${task.id}`, 32);
  const branchName = compactText(task.branchName || `gse-${task.id}-work-item`, 48);
  const baseBranch = compactText(task.baseBranch || project?.defaultBranch || 'main', 48);
  const docs = compactList(task.context?.docs, maxItems, maxItemChars);
  const apis = compactList(task.context?.apis, maxItems, maxItemChars);
  const mcps = compactList(task.context?.mcps, maxItems, maxItemChars);
  const actionFilesEdit = compactActionFiles(task.context?.codeIntel?.actions?.filesToEdit, maxItems, maxItemChars);
  const actionFilesCreate = compactActionFiles(task.context?.codeIntel?.actions?.filesToCreate, maxItems, maxItemChars);
  const actionFunctions = compactActionFunctions(task.context?.codeIntel?.actions?.functionTargets, maxItems, maxItemChars);
  const actionLines = compactActionLines(task.context?.codeIntel?.actions?.lineTargets, maxItems, maxItemChars);
  const lineTargetFiles = extractLineTargetFiles(actionLines, maxItems, maxItemChars);
  const files = uniqueCompact([...actionFilesEdit, ...lineTargetFiles, ...docs], maxItems, maxItemChars);

  const requiredLines = [
    `TASK: ${taskKey} ${title}`,
    `GOAL: ${description}`,
    `FILES: ${files.length ? files.join(', ') : '(infer with targeted search)'}`,
    `CONSTRAINTS: minimal diff; no unrelated edits; base=${baseBranch}; branch=${branchName}; keep build/test healthy.`,
    'DONE_WHEN: required edits complete, validation run (or reason), changed files + brief summary.'
  ];
  const optionalLines = [
    actionFilesCreate.length ? `CREATE_FILES: ${actionFilesCreate.join(', ')}` : '',
    actionFunctions.length ? `FUNCTION_TARGETS: ${actionFunctions.join(', ')}` : '',
    actionLines.length ? `LINE_TARGETS: ${actionLines.join(', ')}` : '',
    apis.length ? `APIS: ${apis.join(', ')}` : '',
    mcps.length ? `MCPS: ${mcps.join(', ')}` : ''
  ].filter(Boolean);
  return fitPromptLines(requiredLines, optionalLines, maxPromptChars);
}
