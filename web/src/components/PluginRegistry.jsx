import { useMemo, useState } from 'react';

function formatError(error) {
  if (!error) return '';
  if (error.details?.errors?.length) return error.details.errors.join(' ');
  if (error.details?.connectivity?.message) return error.details.connectivity.message;
  return error.message || 'Validation failed';
}

function defaultInputState(schema) {
  const state = {};
  const props = schema?.properties || {};
  for (const [key, descriptor] of Object.entries(props)) {
    if (descriptor.default !== undefined) {
      if (descriptor.type === 'object' || descriptor.type === 'array') state[key] = JSON.stringify(descriptor.default);
      else state[key] = String(descriptor.default);
    } else if (descriptor.type === 'boolean') state[key] = 'false';
    else if (descriptor.type === 'object' || descriptor.type === 'array') state[key] = '{}';
    else state[key] = '';
  }
  return state;
}

function buildConfig(schema, inputs) {
  const config = {};
  const props = schema?.properties || {};
  for (const [key, descriptor] of Object.entries(props)) {
    const raw = inputs[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (descriptor.type === 'boolean') {
      config[key] = String(raw) === 'true';
      continue;
    }
    if (descriptor.type === 'number') {
      config[key] = Number(raw);
      continue;
    }
    if (descriptor.type === 'object' || descriptor.type === 'array') {
      config[key] = JSON.parse(raw);
      continue;
    }
    config[key] = raw;
  }
  return config;
}

function SchemaField({ fieldKey, descriptor, value, onChange }) {
  const title = descriptor.title || fieldKey;
  if (descriptor.type === 'boolean') {
    return (
      <select
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
      >
        <option value="false">{title}: false</option>
        <option value="true">{title}: true</option>
      </select>
    );
  }

  if (descriptor.type === 'object' || descriptor.type === 'array') {
    return (
      <textarea
        placeholder={`${title} (JSON)`}
        value={value}
        onChange={(e) => onChange(fieldKey, e.target.value)}
        className="min-h-20 rounded-lg border border-border bg-panel px-3 py-2 text-xs"
      />
    );
  }

  return (
    <input
      type={descriptor.secret ? 'password' : 'text'}
      placeholder={title}
      value={value}
      onChange={(e) => onChange(fieldKey, e.target.value)}
      className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
    />
  );
}

export default function PluginRegistry({
  plugins,
  catalog,
  templates,
  onValidate,
  onAdd,
  onCreateTemplate,
  onUpdateTemplate
}) {
  const [templateId, setTemplateId] = useState(catalog[0]?.id || '');
  const selected = useMemo(() => catalog.find((item) => item.id === templateId) || catalog[0], [catalog, templateId]);
  const [name, setName] = useState(selected?.defaultName || '');
  const [url, setUrl] = useState(selected?.defaultUrl || '');
  const [customSchemaText, setCustomSchemaText] = useState('');
  const [inputs, setInputs] = useState(defaultInputState(selected?.configSchema));
  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [isBusy, setIsBusy] = useState(false);

  const [adminId, setAdminId] = useState(selected?.id || '');
  const [adminLabel, setAdminLabel] = useState(selected?.label || '');
  const [adminType, setAdminType] = useState(selected?.type || 'mcp');
  const [adminDefaultName, setAdminDefaultName] = useState(selected?.defaultName || '');
  const [adminDefaultUrl, setAdminDefaultUrl] = useState(selected?.defaultUrl || '');
  const [adminSchemaText, setAdminSchemaText] = useState(
    JSON.stringify(selected?.configSchema || { type: 'object', properties: {} }, null, 2)
  );
  const [adminStatus, setAdminStatus] = useState({ kind: 'idle', text: '' });

  const isCustom = selected?.id === 'custom_mcp_stdio' || selected?.id === 'custom_mcp_http';
  const activeSchema = useMemo(() => {
    if (isCustom && customSchemaText.trim()) {
      try {
        return JSON.parse(customSchemaText);
      } catch {
        return selected?.configSchema || { type: 'object', properties: {} };
      }
    }
    return selected?.configSchema || { type: 'object', properties: {} };
  }, [isCustom, customSchemaText, selected]);

  function applyTemplate(nextId) {
    const next = catalog.find((item) => item.id === nextId);
    setTemplateId(nextId);
    setName(next?.defaultName || '');
    setUrl(next?.defaultUrl || '');
    setCustomSchemaText('');
    setInputs(defaultInputState(next?.configSchema));
    setStatus({ kind: 'idle', text: '' });
  }

  function loadAdminFromTemplate(id) {
    const next = (templates || []).find((item) => item.id === id) || (catalog || []).find((item) => item.id === id);
    if (!next) return;
    setAdminId(next.id || '');
    setAdminLabel(next.label || '');
    setAdminType(next.type || 'mcp');
    setAdminDefaultName(next.defaultName || '');
    setAdminDefaultUrl(next.defaultUrl || '');
    setAdminSchemaText(JSON.stringify(next.configSchema || { type: 'object', properties: {} }, null, 2));
    setAdminStatus({ kind: 'idle', text: '' });
  }

  function onFieldChange(key, value) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

  function payload() {
    const base = {
      name: name.trim(),
      type: selected?.type || 'mcp',
      schemaId: selected?.id || '',
      url: url.trim(),
      config: buildConfig(activeSchema, inputs)
    };
    if (isCustom && customSchemaText.trim()) {
      base.configSchema = JSON.parse(customSchemaText);
    }
    return base;
  }

  async function runAction(handler) {
    setIsBusy(true);
    setStatus({ kind: 'idle', text: '' });
    try {
      const result = await handler();
      setStatus({ kind: 'ok', text: result.connectivity?.message || 'Connectivity passed' });
      return result;
    } catch (error) {
      setStatus({ kind: 'error', text: formatError(error) });
      return null;
    } finally {
      setIsBusy(false);
    }
  }

  async function testConnectivity(event) {
    event.preventDefault();
    await runAction(() => onValidate(payload()));
  }

  async function connectPlugin(event) {
    event.preventDefault();
    const result = await runAction(() => onAdd(payload()));
    if (result?.plugin) setInputs(defaultInputState(activeSchema));
  }

  function adminPayload() {
    return {
      id: adminId.trim(),
      label: adminLabel.trim(),
      type: adminType,
      defaultName: adminDefaultName.trim(),
      defaultUrl: adminDefaultUrl.trim(),
      configSchema: JSON.parse(adminSchemaText)
    };
  }

  async function createTemplate(event) {
    event.preventDefault();
    setAdminStatus({ kind: 'idle', text: '' });
    try {
      await onCreateTemplate(adminPayload());
      setAdminStatus({ kind: 'ok', text: 'Template created (v1).' });
    } catch (error) {
      setAdminStatus({ kind: 'error', text: formatError(error) });
    }
  }

  async function updateTemplate(event) {
    event.preventDefault();
    setAdminStatus({ kind: 'idle', text: '' });
    try {
      await onUpdateTemplate(adminId.trim(), adminPayload());
      setAdminStatus({ kind: 'ok', text: 'Template updated with new version.' });
    } catch (error) {
      setAdminStatus({ kind: 'error', text: formatError(error) });
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-panel p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Integrations & Plugin Registry</h2>
        <p className="text-xs text-muted">Schema-aware, validated connections</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <form className="rounded-xl border border-border bg-surface p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Connect Plugin</h3>

          <div className="space-y-2">
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            >
              {catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} (v{item.version || 1})
                </option>
              ))}
            </select>

            <input
              placeholder="Plugin Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            />

            <input
              placeholder="Command / URL / provider:model"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            />

            {isCustom ? (
              <textarea
                placeholder="Optional custom JSON schema override"
                value={customSchemaText}
                onChange={(e) => setCustomSchemaText(e.target.value)}
                className="min-h-24 w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
              />
            ) : null}

            {Object.entries(activeSchema?.properties || {}).map(([fieldKey, descriptor]) => (
              <SchemaField
                key={fieldKey}
                fieldKey={fieldKey}
                descriptor={descriptor}
                value={inputs[fieldKey] ?? ''}
                onChange={onFieldChange}
              />
            ))}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={testConnectivity}
              disabled={isBusy}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs font-semibold text-ink"
            >
              Test
            </button>
            <button
              onClick={connectPlugin}
              disabled={isBusy}
              className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white"
            >
              Connect
            </button>
          </div>

          {status.text ? (
            <p className={`mt-2 text-xs ${status.kind === 'error' ? 'text-danger' : 'text-accent'}`}>{status.text}</p>
          ) : null}
        </form>

        <div className="rounded-xl border border-border bg-surface p-3">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Schema Admin</h3>

          <select
            value={adminId}
            onChange={(e) => loadAdminFromTemplate(e.target.value)}
            className="mb-2 w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
          >
            <option value="">Select template to edit</option>
            {(templates || []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} (v{item.version})
              </option>
            ))}
          </select>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              placeholder="template id"
              value={adminId}
              onChange={(e) => setAdminId(e.target.value)}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            />
            <input
              placeholder="Label"
              value={adminLabel}
              onChange={(e) => setAdminLabel(e.target.value)}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            />
            <input
              placeholder="Default plugin name"
              value={adminDefaultName}
              onChange={(e) => setAdminDefaultName(e.target.value)}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            />
            <select
              value={adminType}
              onChange={(e) => setAdminType(e.target.value)}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs"
            >
              <option value="mcp">mcp</option>
              <option value="mcp_http">mcp_http</option>
              <option value="agent">agent</option>
              <option value="builtin">builtin</option>
            </select>
          </div>

          <input
            placeholder="Default command / URL"
            value={adminDefaultUrl}
            onChange={(e) => setAdminDefaultUrl(e.target.value)}
            className="mt-2 w-full rounded-lg border border-border bg-panel px-3 py-2 text-xs"
          />

          <textarea
            placeholder='Config schema JSON'
            value={adminSchemaText}
            onChange={(e) => setAdminSchemaText(e.target.value)}
            className="mt-2 min-h-28 w-full rounded-lg border border-border bg-panel px-3 py-2 font-mono text-[11px]"
          />

          <div className="mt-2 flex gap-2">
            <button
              onClick={createTemplate}
              className="rounded-lg border border-border bg-panel px-3 py-2 text-xs font-semibold text-ink"
            >
              Create
            </button>
            <button onClick={updateTemplate} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white">
              Publish Version
            </button>
          </div>

          {adminStatus.text ? (
            <p className={`mt-2 text-xs ${adminStatus.kind === 'error' ? 'text-danger' : 'text-accent'}`}>
              {adminStatus.text}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-border bg-surface p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Connected Plugins</h3>
        <ul className="grid gap-1 text-xs text-muted sm:grid-cols-2">
          {plugins.map((plugin) => (
            <li key={plugin.id} className="rounded-lg border border-border bg-panel px-2 py-2">
              <p className="font-semibold text-ink">{plugin.name}</p>
              <p>
                {plugin.type}
                {' -> '}
                {plugin.url}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
