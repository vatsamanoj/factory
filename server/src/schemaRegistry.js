import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'schemas', 'plugins');

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function parseVersion(filename) {
  const match = filename.match(/^v(\d+)\.json$/);
  return match ? Number(match[1]) : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isSchemaObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTemplate(input) {
  const template = {
    id: String(input?.id || '').trim(),
    label: String(input?.label || '').trim(),
    type: String(input?.type || 'mcp').trim(),
    defaultName: String(input?.defaultName || '').trim(),
    defaultUrl: String(input?.defaultUrl || '').trim(),
    configSchema: isSchemaObject(input?.configSchema) ? input.configSchema : { type: 'object', properties: {} }
  };
  if (!template.id) throw new Error('Template id is required.');
  if (!/^[a-z0-9_]+$/.test(template.id)) throw new Error('Template id must match ^[a-z0-9_]+$.');
  if (!template.label) throw new Error('Template label is required.');
  if (!template.defaultName) throw new Error('Template defaultName is required.');
  return template;
}

function templateDir(id) {
  return path.join(ROOT, id);
}

function listVersionFiles(id) {
  const dir = templateDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => ({ name, version: parseVersion(name) }))
    .filter((item) => item.version !== null)
    .sort((a, b) => a.version - b.version);
}

export function listSchemaTemplates() {
  ensureRoot();
  const ids = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return ids
    .map((id) => {
      const versions = listVersionFiles(id);
      if (!versions.length) return null;
      const latest = versions[versions.length - 1];
      const latestPath = path.join(templateDir(id), latest.name);
      const doc = readJson(latestPath);
      return {
        id: doc.id || id,
        label: doc.label || id,
        type: doc.type || 'mcp',
        defaultName: doc.defaultName || doc.label || id,
        defaultUrl: doc.defaultUrl || '',
        version: latest.version,
        versions: versions.map((item) => item.version),
        configSchema: doc.configSchema || { type: 'object', properties: {} }
      };
    })
    .filter(Boolean);
}

export function getSchemaTemplate(id) {
  const templates = listSchemaTemplates();
  return templates.find((item) => item.id === id) || null;
}

function writeVersionedTemplate(template, version) {
  const dir = templateDir(template.id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `v${version}.json`);
  const payload = { ...template, version };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

export function createSchemaTemplate(input) {
  const template = normalizeTemplate(input);
  const existing = getSchemaTemplate(template.id);
  if (existing) throw new Error(`Template ${template.id} already exists.`);
  writeVersionedTemplate(template, 1);
  return getSchemaTemplate(template.id);
}

export function updateSchemaTemplate(id, input) {
  const existing = getSchemaTemplate(id);
  if (!existing) throw new Error(`Template ${id} not found.`);
  const template = normalizeTemplate({ ...existing, ...input, id });
  const nextVersion = (existing.version || 0) + 1;
  writeVersionedTemplate(template, nextVersion);
  return getSchemaTemplate(id);
}
