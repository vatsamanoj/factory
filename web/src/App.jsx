import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import Column from './components/Column.jsx';
import TaskDrawer from './components/TaskDrawer.jsx';
import PluginRegistry from './components/PluginRegistry.jsx';
import Sidebar from './components/Sidebar.jsx';
import IssueListView from './components/IssueListView.jsx';
import CyclesPanel from './components/CyclesPanel.jsx';
import ModulesPanel from './components/ModulesPanel.jsx';
import ViewsPanel from './components/ViewsPanel.jsx';
import AnalyticsPanel from './components/AnalyticsPanel.jsx';
import PagesPanel from './components/PagesPanel.jsx';
import {
  addPlugin,
  approveTask,
  createPage,
  connectProjectRepo,
  getProjectBranches,
  getProjectRepoStatus,
  createProject,
  createCycle,
  createModule,
  createSchemaTemplate,
  createTask,
  createView,
  getAnalytics,
  getCycles,
  getModules,
  getPages,
  getProjects,
  getPluginCatalog,
  getPlugins,
  getSchemaTemplates,
  getTaskLogs,
  getTaskAttachments,
  getTasks,
  getViews,
  retryTask,
  runTaskBuildTest,
  updatePage,
  updateProject,
  updateSchemaTemplate,
  updateTaskAssignee,
  updateTaskStatus,
  validatePlugin
} from './lib/api.js';
import { openTaskSocket } from './lib/ws.js';

const COLUMNS = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' }
];

const SECTION_TABS = [
  { id: 'work-items', label: 'Work Items' },
  { id: 'cycles', label: 'Cycles' },
  { id: 'modules', label: 'Modules' },
  { id: 'views', label: 'Views' },
  { id: 'pages', label: 'Pages' },
  { id: 'analytics', label: 'Analytics' }
];

const sectionTitles = {
  'work-items': 'Work Items',
  cycles: 'Cycles',
  modules: 'Modules',
  views: 'Views',
  pages: 'Pages',
  analytics: 'Analytics'
};

const THEMES = [
  { id: 'default', label: 'Sunset' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'mint', label: 'Mint' },
  { id: 'rose', label: 'Rose' },
  { id: 'slate', label: 'Slate' },
  { id: 'primer', label: 'Primer' },
  { id: 'mauve', label: 'Mauve' },
  { id: 'sand', label: 'Sand' },
  { id: 'light-hc', label: 'High Contrast Light' },
  { id: 'google-light', label: 'Google Light' },
  { id: 'google-blueprint', label: 'Google Blueprint' },
  { id: 'dark', label: 'Dark' },
  { id: 'dark-hc', label: 'Dark High Contrast' },
  { id: 'vscode-dark-plus', label: 'VS Code Dark+' },
  { id: 'vscode-light-plus', label: 'VS Code Light+' },
  { id: 'vscode-monokai', label: 'VS Code Monokai' },
  { id: 'terminal', label: 'Terminal' }
];

function pickDefaultCheckoutBranch(branches, fallback = 'main') {
  const list = Array.isArray(branches) ? branches : [];
  if (!list.length) return fallback;
  let best = '';
  let bestNum = -1;
  for (const branch of list) {
    const nums = String(branch).match(/\d+/g);
    const score = nums ? Math.max(...nums.map((n) => Number(n))) : -1;
    if (score > bestNum) {
      bestNum = score;
      best = branch;
    }
  }
  return best || list[0] || fallback;
}

function getEffectiveRuntimeStatus(task) {
  if (task?.status === 'done' && task?.runtimeStatus === 'running') return 'success';
  return task?.runtimeStatus;
}

function isFailedRuntimeStatus(runtimeStatus) {
  return runtimeStatus === 'failed' || runtimeStatus === 'build_failed';
}

function isRunningRuntimeStatus(runtimeStatus) {
  return runtimeStatus === 'running' || runtimeStatus === 'build_running';
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [plugins, setPlugins] = useState([]);
  const [pluginCatalog, setPluginCatalog] = useState([]);
  const [schemaTemplates, setSchemaTemplates] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [modules, setModules] = useState([]);
  const [views, setViews] = useState([]);
  const [pages, setPages] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [logsByTask, setLogsByTask] = useState({});
  const [attachmentsByTask, setAttachmentsByTask] = useState({});
  const [dragTaskId, setDragTaskId] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [activeSection, setActiveSection] = useState('work-items');
  const [viewMode, setViewMode] = useState('board');
  const [query, setQuery] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('all');
  const [runtimeFilter, setRuntimeFilter] = useState('all');
  const [dashboardStatusFilter, setDashboardStatusFilter] = useState('all');
  const [collapsedColumns, setCollapsedColumns] = useState({});
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectRepoUrl, setNewProjectRepoUrl] = useState('');
  const [newProjectRepoPath, setNewProjectRepoPath] = useState('');
  const [newProjectBranch, setNewProjectBranch] = useState('main');
  const [newProjectToken, setNewProjectToken] = useState('');
  const [newProjectAutoPr, setNewProjectAutoPr] = useState(false);
  const [newProjectAutoMerge, setNewProjectAutoMerge] = useState(false);
  const [projectError, setProjectError] = useState('');
  const [projectInfo, setProjectInfo] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [repoStatusByProject, setRepoStatusByProject] = useState({});
  const [branchOptionsByProject, setBranchOptionsByProject] = useState({});
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [theme, setTheme] = useState('default');
  const [newTask, setNewTask] = useState({
    title: '',
    description: '',
    status: 'backlog',
    assigneeType: 'goose',
    baseBranch: '',
    cycleId: '',
    moduleId: ''
  });
  const recognitionRef = useRef(null);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem('goose-theme') || 'default';
    setTheme(savedTheme);
  }, []);

  useEffect(() => {
    const next = theme === 'default' ? '' : theme;
    if (next) {
      document.documentElement.setAttribute('data-theme', next);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    window.localStorage.setItem('goose-theme', theme);
  }, [theme]);

  useEffect(() => {
    getProjects()
      .then((data) => {
        const rows = data.projects || [];
        setProjects(rows);
        if (rows[0]?.id) setActiveProjectId(String(rows[0].id));
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    Promise.all([
      getTasks(activeProjectId),
      getPlugins(activeProjectId),
      getPluginCatalog(),
      getSchemaTemplates(),
      getCycles(activeProjectId),
      getModules(activeProjectId),
      getViews(activeProjectId),
      getPages(activeProjectId),
      getAnalytics(activeProjectId)
    ])
      .then(([taskData, pluginData, catalogData, templateData, cycleData, moduleData, viewData, pageData, analyticsData]) => {
        setTasks(taskData.tasks || []);
        setPlugins(pluginData.plugins || []);
        setPluginCatalog(catalogData.catalog || []);
        setSchemaTemplates(templateData.templates || []);
        setCycles(cycleData.cycles || []);
        setModules(moduleData.modules || []);
        setViews(viewData.views || []);
        setPages(pageData.pages || []);
        setAnalytics(analyticsData.analytics || null);
      })
      .catch(console.error);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeProjectId) return;
    getProjectBranches(activeProjectId)
      .then((data) => {
        const branches = Array.isArray(data.branches) ? data.branches : [];
        setBranchOptionsByProject((prev) => ({ ...prev, [activeProjectId]: branches }));
      })
      .catch(() => {
        const fallback = projects.find((p) => String(p.id) === activeProjectId)?.defaultBranch || 'main';
        setBranchOptionsByProject((prev) => ({ ...prev, [activeProjectId]: [fallback] }));
      });
  }, [activeProjectId, projects]);

  useEffect(() => {
    if (!showCreateModal) return;
    if (newTask.baseBranch) return;
    const branches = branchOptionsByProject[activeProjectId] || [];
    const projectDefault = projects.find((p) => String(p.id) === activeProjectId)?.defaultBranch || 'main';
    const pick = pickDefaultCheckoutBranch(branches, projectDefault);
    setNewTask((prev) => ({ ...prev, baseBranch: prev.baseBranch || pick }));
  }, [showCreateModal, newTask.baseBranch, branchOptionsByProject, activeProjectId, projects]);

  useEffect(() => {
    if (!activeProjectId) return;
    getProjectRepoStatus(activeProjectId)
      .then((data) => {
        setRepoStatusByProject((prev) => ({ ...prev, [activeProjectId]: data.status || {} }));
      })
      .catch(() => {
        setRepoStatusByProject((prev) => ({ ...prev, [activeProjectId]: { error: 'Unable to read repo status' } }));
      });
  }, [activeProjectId]);

  useEffect(() => {
    const socket = openTaskSocket({
      onEvent(event) {
        if (event.type === 'task_log') {
          setLogsByTask((prev) => ({
            ...prev,
            [event.taskId]: [...(prev[event.taskId] || []), event.line]
          }));
        }

        if (event.type === 'task_status') {
          setTasks((prev) => prev.map((task) => (task.id === event.task.id ? event.task : task)));
        }
      }
    });

    return () => socket.close();
  }, []);

  // Keep drawer task object in sync with latest task list updates (WS/polling).
  useEffect(() => {
    if (!selectedTask?.id) return;
    const latest = tasks.find((row) => row.id === selectedTask.id);
    if (!latest) return;
    setSelectedTask((prev) => (prev && prev.id === latest.id ? latest : prev));
  }, [tasks, selectedTask?.id]);

  // Fallback polling so UI self-heals if a WS task_status event is missed.
  useEffect(() => {
    if (!activeProjectId) return undefined;
    const pollMs = 2500;
    const timer = window.setInterval(() => {
      getTasks(activeProjectId)
        .then((data) => {
          setTasks(data.tasks || []);
        })
        .catch(() => {});
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [activeProjectId]);

  useEffect(() => {
    if (!selectedTask?.id) return;
    Promise.all([getTaskLogs(selectedTask.id, 20000), getTaskAttachments(selectedTask.id)])
      .then(([logData, attachmentData]) => {
        const lines = (logData.logs || []).map((row) => row.line);
        setLogsByTask((prev) => ({ ...prev, [selectedTask.id]: lines }));
        setAttachmentsByTask((prev) => ({ ...prev, [selectedTask.id]: attachmentData.attachments || [] }));
      })
      .catch(console.error);
  }, [selectedTask?.id]);

  // While selected task is running, refresh logs periodically to avoid stale terminal view.
  useEffect(() => {
    if (!selectedTask?.id) return undefined;
    if (!isRunningRuntimeStatus(getEffectiveRuntimeStatus(selectedTask))) return undefined;
    const pollMs = 1800;
    const timer = window.setInterval(() => {
      getTaskLogs(selectedTask.id, 20000)
        .then((logData) => {
          const lines = (logData.logs || []).map((row) => row.line);
          setLogsByTask((prev) => ({ ...prev, [selectedTask.id]: lines }));
        })
        .catch(() => {});
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [selectedTask?.id, selectedTask?.runtimeStatus, selectedTask?.status]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(console.error);
    }
  }, []);

  const cycleMap = useMemo(() => Object.fromEntries(cycles.map((row) => [row.id, row])), [cycles]);
  const moduleMap = useMemo(() => Object.fromEntries(modules.map((row) => [row.id, row])), [modules]);
  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== 'trash'), [tasks]);

  const filteredTasks = useMemo(() => {
    return activeTasks.filter((task) => {
      const text = `${task.title} ${task.description}`.toLowerCase();
      const effectiveRuntimeStatus = getEffectiveRuntimeStatus(task);
      const matchQuery = query ? text.includes(query.toLowerCase()) : true;
      const matchAssignee = assigneeFilter === 'all' ? true : task.assigneeType === assigneeFilter;
      const matchRuntime = runtimeFilter === 'all' ? true : effectiveRuntimeStatus === runtimeFilter;
      const matchDashboardStatus =
        dashboardStatusFilter === 'all'
          ? true
          : dashboardStatusFilter === 'running'
            ? isRunningRuntimeStatus(effectiveRuntimeStatus)
            : dashboardStatusFilter === 'done'
              ? task.status === 'done'
              : dashboardStatusFilter === 'failed'
                ? isFailedRuntimeStatus(effectiveRuntimeStatus)
                : true;
      return matchQuery && matchAssignee && matchRuntime && matchDashboardStatus;
    });
  }, [activeTasks, query, assigneeFilter, runtimeFilter, dashboardStatusFilter]);

  const decoratedFilteredTasks = useMemo(
    () =>
      filteredTasks.map((task) => ({
        ...task,
        runtimeStatus: getEffectiveRuntimeStatus(task),
        cycleName: cycleMap[task.cycleId]?.name || '',
        moduleName: moduleMap[task.moduleId]?.name || '',
        repoCurrentBranch: repoStatusByProject[activeProjectId]?.currentBranch || ''
      })),
    [filteredTasks, cycleMap, moduleMap, repoStatusByProject, activeProjectId]
  );

  const grouped = useMemo(
    () =>
      COLUMNS.reduce((acc, col) => {
        acc[col.key] = decoratedFilteredTasks.filter((task) => task.status === col.key);
        return acc;
      }, {}),
    [decoratedFilteredTasks]
  );

  const stats = useMemo(() => {
    const running = activeTasks.filter((t) => isRunningRuntimeStatus(getEffectiveRuntimeStatus(t))).length;
    const done = activeTasks.filter((t) => t.status === 'done').length;
    const failed = activeTasks.filter((t) => isFailedRuntimeStatus(getEffectiveRuntimeStatus(t))).length;
    return { total: activeTasks.length, running, done, failed };
  }, [activeTasks]);

  const sidebarCounts = useMemo(
    () => ({
      'work-items': activeTasks.length,
      cycles: cycles.length,
      modules: modules.length,
      views: views.length,
      pages: pages.length,
      analytics: analytics ? analytics.totalTasks || 0 : 0
    }),
    [activeTasks.length, cycles.length, modules.length, views.length, pages.length, analytics]
  );

  async function refreshCatalogAndTemplates() {
    const [catalogData, templateData] = await Promise.all([getPluginCatalog(), getSchemaTemplates()]);
    setPluginCatalog(catalogData.catalog || []);
    setSchemaTemplates(templateData.templates || []);
  }

  async function handleDropTask(event, newStatus) {
    event.preventDefault();
    if (!dragTaskId) return;
    const { task } = await updateTaskStatus(dragTaskId, newStatus);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
    setDragTaskId(null);
  }

  async function handleQuickAdd(status, title) {
    const { task } = await createTask({
      projectId: Number(activeProjectId),
      title,
      description: 'Quick-created from board column.',
      status,
      assigneeType: 'goose',
      context: { docs: [], apis: [], mcps: [] }
    });
    setTasks((prev) => [task, ...prev]);
  }

  async function handleCreateTask() {
    if (!newTask.title.trim()) return;
    const { task } = await createTask({
      projectId: Number(activeProjectId),
      title: newTask.title.trim(),
      description: newTask.description.trim(),
      status: newTask.status,
      assigneeType: newTask.assigneeType,
      baseBranch: newTask.baseBranch || undefined,
      cycleId: newTask.cycleId ? Number(newTask.cycleId) : null,
      moduleId: newTask.moduleId ? Number(newTask.moduleId) : null,
      context: { docs: [], apis: [], mcps: [] }
    });
    setTasks((prev) => [task, ...prev]);
    setShowCreateModal(false);
    setNewTask({ title: '', description: '', status: 'backlog', assigneeType: 'goose', baseBranch: '', cycleId: '', moduleId: '' });
    setActiveSection('work-items');
  }

  async function createVoiceTask(text) {
    const payload = {
      projectId: Number(activeProjectId),
      title: `Voice Task: ${text.slice(0, 42) || 'New task'}`,
      description: text || 'Created from mobile voice input pathway.',
      assigneeType: 'goose',
      status: 'backlog',
      context: { docs: ['SAFTA.md'], apis: ['openapi.json'], mcps: ['https://mcp.local/server'] }
    };
    const { task } = await createTask(payload);
    setTasks((prev) => [task, ...prev]);
    setActiveSection('work-items');
  }

  async function handleVoiceTask() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      await createVoiceTask('Investigate CI pipeline and propose a fix (fallback transcript).');
      return;
    }
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognitionRef.current = recognition;
    setIsListening(true);
    recognition.onresult = async (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript?.trim();
      await createVoiceTask(transcript || 'Create a to-do task from voice input.');
    };
    recognition.onerror = () => createVoiceTask('Voice capture failed; created fallback task.');
    recognition.onend = () => {
      setIsListening(false);
      recognitionRef.current = null;
    };
    recognition.start();
  }

  async function handleSwipeRight(task) {
    if (task.status !== 'review') return;
    const { task: approved } = await approveTask(task.id);
    setTasks((prev) => prev.map((item) => (item.id === approved.id ? approved : item)));
  }

  async function handleTaskAssigneeChange(taskId, assigneeType) {
    const { task } = await updateTaskAssignee(taskId, assigneeType);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
    setSelectedTask((prev) => (prev && prev.id === task.id ? task : prev));
  }

  async function handleRetryTask(taskId) {
    const { task } = await retryTask(taskId);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
    setSelectedTask((prev) => (prev && prev.id === task.id ? task : prev));
  }

  async function handleRunBuildTest(taskId) {
    const { task } = await runTaskBuildTest(taskId);
    setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
    setSelectedTask((prev) => (prev && prev.id === task.id ? task : prev));
    const logData = await getTaskLogs(taskId, 20000);
    const lines = (logData.logs || []).map((row) => row.line);
    setLogsByTask((prev) => ({ ...prev, [taskId]: lines }));
  }

  async function handleRefreshAttachments(taskId) {
    const data = await getTaskAttachments(taskId);
    setAttachmentsByTask((prev) => ({ ...prev, [taskId]: data.attachments || [] }));
  }

  async function handleMoveTaskToTrash(taskId) {
    const { task } = await updateTaskStatus(taskId, 'trash');
    setTasks((prev) => prev.map((item) => (item.id === task.id ? task : item)));
    setSelectedTask((prev) => (prev && prev.id === task.id ? null : prev));
  }

  async function handleCreateCycle(payload) {
    const { cycle } = await createCycle({ ...payload, projectId: Number(activeProjectId) });
    setCycles((prev) => [cycle, ...prev]);
  }

  async function handleCreateModule(payload) {
    const { module } = await createModule({ ...payload, projectId: Number(activeProjectId) });
    setModules((prev) => [module, ...prev]);
  }

  async function handleCreateView(payload) {
    const { view } = await createView({
      ...payload,
      projectId: Number(activeProjectId),
      viewMode,
      query,
      assigneeFilter,
      runtimeFilter
    });
    setViews((prev) => [view, ...prev]);
  }

  async function handleCreatePage(payload) {
    const { page } = await createPage({ ...payload, projectId: Number(activeProjectId) });
    setPages((prev) => [page, ...prev]);
    return { page };
  }

  async function handleUpdatePage(pageId, payload) {
    const { page } = await updatePage(pageId, { ...payload, projectId: Number(activeProjectId) });
    setPages((prev) => prev.map((row) => (row.id === page.id ? page : row)));
    return { page };
  }

  function handleApplyView(view) {
    setViewMode(view.view_mode || view.viewMode || 'board');
    setQuery(view.query || '');
    setAssigneeFilter(view.assignee_filter || view.assigneeFilter || 'all');
    setRuntimeFilter(view.runtime_filter || view.runtimeFilter || 'all');
    setActiveSection('work-items');
  }

  useEffect(() => {
    if (activeSection !== 'analytics') return;
    getAnalytics(activeProjectId)
      .then((data) => setAnalytics(data.analytics || null))
      .catch(console.error);
  }, [activeSection, tasks, activeProjectId]);

  async function handleAddPlugin(payload) {
    const response = await addPlugin({ ...payload, projectId: Number(activeProjectId) });
    setPlugins((prev) => [response.plugin, ...prev]);
    return response;
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    const repoUrl = newProjectRepoUrl.trim();
    const repoPath = newProjectRepoPath.trim();
    const defaultBranch = newProjectBranch.trim() || 'main';
    if (!name || !repoUrl || !repoPath) {
      setProjectError('Project name, repo URL and repo path are required.');
      return;
    }
    setProjectBusy(true);
    setProjectError('');
    try {
      const { project } = await createProject({
        name,
        repoUrl,
        repoPath,
        defaultBranch,
        githubToken: newProjectToken.trim(),
        autoPr: newProjectAutoPr,
        autoMerge: newProjectAutoMerge
      });
      setProjects((prev) => [...prev, project]);
      setActiveProjectId(String(project.id));
      setNewProjectName('');
      setNewProjectRepoUrl('');
      setNewProjectRepoPath('');
      setNewProjectBranch('main');
      setNewProjectToken('');
      setNewProjectAutoPr(false);
      setNewProjectAutoMerge(false);
      setProjectInfo('Project created and repository verified.');
      setShowProjectModal(false);
    } catch (error) {
      setProjectError(error?.message || 'Failed to create project.');
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleSaveProjectRepo() {
    const selected = projects.find((p) => String(p.id) === activeProjectId);
    if (!selected) return;
    setProjectBusy(true);
    setProjectError('');
    setProjectInfo('');
    try {
      const { project } = await updateProject(selected.id, {
        repoUrl: selected.repoUrl,
        repoPath: selected.repoPath,
        defaultBranch: selected.defaultBranch || 'main',
        githubToken: selected.githubToken || '',
        autoPr: Boolean(selected.autoPr),
        autoMerge: Boolean(selected.autoMerge)
      });
      setProjects((prev) => prev.map((row) => (row.id === project.id ? project : row)));
      const statusRes = await getProjectRepoStatus(project.id);
      setRepoStatusByProject((prev) => ({ ...prev, [String(project.id)]: statusRes.status || {} }));
      setProjectInfo('Repository configuration saved.');
    } catch (error) {
      setProjectError(error?.message || 'Failed to save repository configuration.');
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleSyncProjectRepo() {
    const selected = projects.find((p) => String(p.id) === activeProjectId);
    if (!selected) return;
    setProjectBusy(true);
    setProjectError('');
    setProjectInfo('');
    try {
      await connectProjectRepo(selected.id);
      const statusRes = await getProjectRepoStatus(selected.id);
      setRepoStatusByProject((prev) => ({ ...prev, [String(selected.id)]: statusRes.status || {} }));
      setProjectInfo('Repository synced successfully.');
    } catch (error) {
      setProjectError(error?.message || 'Repository sync failed.');
    } finally {
      setProjectBusy(false);
    }
  }

  function updateSelectedProjectField(field, value) {
    setProjects((prev) =>
      prev.map((project) => (String(project.id) === activeProjectId ? { ...project, [field]: value } : project))
    );
  }

  function handleDashboardCardClick(nextFilter) {
    setActiveSection('work-items');
    setDashboardStatusFilter((prev) => (prev === nextFilter ? 'all' : nextFilter));
  }

  async function handleCreateSchemaTemplate(payload) {
    const response = await createSchemaTemplate(payload);
    await refreshCatalogAndTemplates();
    return response;
  }

  async function handleUpdateSchemaTemplate(id, payload) {
    const response = await updateSchemaTemplate(id, payload);
    await refreshCatalogAndTemplates();
    return response;
  }

  function toggleColumn(key) {
    setCollapsedColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1580px] flex-col gap-3 p-2 pb-16 md:p-4">
      <header className="sticky top-2 z-40 rounded-xl border border-border bg-surface p-3 shadow-card">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted">
              {projects.find((p) => String(p.id) === activeProjectId)?.name || 'Project'}
            </p>
            <h1 className="text-lg font-semibold text-ink">{sectionTitles[activeSection] || 'Work Items'}</h1>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={activeProjectId}
              onChange={(e) => {
                setActiveProjectId(e.target.value);
                setProjectError('');
                setProjectInfo('');
              }}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink"
            >
              {THEMES.map((item) => (
                <option key={item.id} value={item.id}>
                  Theme: {item.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setShowProjectModal(true)}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink"
            >
              New Project
            </button>
            <button onClick={() => setShowPlugins(true)} className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink">Integrations</button>
            <button onClick={() => setShowCreateModal(true)} className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-white">New Work Item</button>
            <button onClick={handleVoiceTask} className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold ${isListening ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-surface text-ink'}`}>{isListening ? 'Listening...' : 'Mic'}</button>
          </div>
        </div>

        {projectError ? <p className="mb-2 text-xs font-medium text-danger">{projectError}</p> : null}
        {projectInfo ? <p className="mb-2 text-xs font-medium text-emerald-700">{projectInfo}</p> : null}

        {activeProjectId ? (
          <div className="mb-2 grid grid-cols-1 gap-2 rounded-md border border-border bg-panel p-2 lg:grid-cols-8">
            <input
              value={projects.find((p) => String(p.id) === activeProjectId)?.repoUrl || ''}
              onChange={(e) => updateSelectedProjectField('repoUrl', e.target.value)}
              placeholder="Repo URL"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs lg:col-span-2"
            />
            <input
              value={projects.find((p) => String(p.id) === activeProjectId)?.repoPath || ''}
              onChange={(e) => updateSelectedProjectField('repoPath', e.target.value)}
              placeholder="Repo local path"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs lg:col-span-2"
            />
            <input
              value={projects.find((p) => String(p.id) === activeProjectId)?.defaultBranch || 'main'}
              onChange={(e) => updateSelectedProjectField('defaultBranch', e.target.value)}
              placeholder="main"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs lg:col-span-1"
            />
            <input
              type="password"
              value={projects.find((p) => String(p.id) === activeProjectId)?.githubToken || ''}
              onChange={(e) => updateSelectedProjectField('githubToken', e.target.value)}
              placeholder="GitHub token"
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs lg:col-span-1"
            />
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink lg:col-span-1">
              <input
                type="checkbox"
                checked={Boolean(projects.find((p) => String(p.id) === activeProjectId)?.autoPr)}
                onChange={(e) => updateSelectedProjectField('autoPr', e.target.checked)}
              />
              Auto PR
            </label>
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink lg:col-span-1">
              <input
                type="checkbox"
                checked={Boolean(projects.find((p) => String(p.id) === activeProjectId)?.autoMerge)}
                onChange={(e) => updateSelectedProjectField('autoMerge', e.target.checked)}
              />
              Auto Merge
            </label>
            <button
              onClick={handleSaveProjectRepo}
              disabled={projectBusy}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60 lg:col-span-1"
            >
              Save Repo
            </button>
            <button
              onClick={handleSyncProjectRepo}
              disabled={projectBusy}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-60 lg:col-span-1"
            >
              Sync Repo
            </button>
            <div className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-ink lg:col-span-8">
              <span className="font-semibold">Connected Branch:</span>{' '}
              {repoStatusByProject[activeProjectId]?.currentBranch || 'Not detected'}
              {repoStatusByProject[activeProjectId]?.headSha ? (
                <span className="ml-2 text-muted">
                  ({String(repoStatusByProject[activeProjectId].headSha).slice(0, 8)})
                </span>
              ) : null}
              {repoStatusByProject[activeProjectId]?.error ? (
                <span className="ml-2 text-danger">• {repoStatusByProject[activeProjectId].error}</span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid grid-cols-4 gap-2 text-center text-[11px] md:w-[460px]">
          <button
            type="button"
            onClick={() => handleDashboardCardClick('all')}
            className={`rounded-md border px-2 py-1.5 ${dashboardStatusFilter === 'all' ? 'border-accent bg-accent/10' : 'border-border bg-surface'}`}
          >
            <p className="font-semibold text-ink">{stats.total}</p>
            <p className="text-muted">Total</p>
          </button>
          <button
            type="button"
            onClick={() => handleDashboardCardClick('running')}
            className={`rounded-md border px-2 py-1.5 ${dashboardStatusFilter === 'running' ? 'border-accent bg-accent/10' : 'border-border bg-surface'}`}
          >
            <p className="font-semibold text-blue-700">{stats.running}</p>
            <p className="text-muted">Running</p>
          </button>
          <button
            type="button"
            onClick={() => handleDashboardCardClick('done')}
            className={`rounded-md border px-2 py-1.5 ${dashboardStatusFilter === 'done' ? 'border-accent bg-accent/10' : 'border-border bg-surface'}`}
          >
            <p className="font-semibold text-emerald-700">{stats.done}</p>
            <p className="text-muted">Done</p>
          </button>
          <button
            type="button"
            onClick={() => handleDashboardCardClick('failed')}
            className={`rounded-md border px-2 py-1.5 ${dashboardStatusFilter === 'failed' ? 'border-accent bg-accent/10' : 'border-border bg-surface'}`}
          >
            <p className="font-semibold text-red-600">{stats.failed}</p>
            <p className="text-muted">Failed</p>
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-3 lg:grid-cols-[250px_minmax(0,1fr)]">
        <div className="hidden lg:block">
          <Sidebar
            active={activeSection}
            onSelect={setActiveSection}
            counts={sidebarCounts}
            projectName={projects.find((p) => String(p.id) === activeProjectId)?.name || 'Project'}
          />
        </div>

        <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
          <div className="no-scrollbar flex gap-2 overflow-x-auto lg:hidden">
            {SECTION_TABS.map((tab) => (
              <button key={tab.id} type="button" onClick={() => setActiveSection(tab.id)} className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold ${activeSection === tab.id ? 'bg-accent text-white' : 'bg-surface text-ink'}`}>{tab.label}</button>
            ))}
          </div>

          <div className="rounded-xl border border-border bg-panel p-3 shadow-card md:p-4">
            {activeSection === 'work-items' ? (
              <>
                <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="flex gap-2">
                    <button className={`rounded-md px-3 py-1.5 text-xs font-semibold ${viewMode === 'board' ? 'bg-accent text-white' : 'bg-surface text-ink'}`} onClick={() => setViewMode('board')}>Board</button>
                    <button className={`rounded-md px-3 py-1.5 text-xs font-semibold ${viewMode === 'list' ? 'bg-accent text-white' : 'bg-surface text-ink'}`} onClick={() => setViewMode('list')}>List</button>
                  </div>

                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:w-[720px]">
                    <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search work items" className="rounded-md border border-border bg-surface px-3 py-2 text-xs" />
                    <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                      <option value="all">All assignees</option>
                      <option value="goose">Goose</option>
                      <option value="human">Human</option>
                    </select>
                    <select value={runtimeFilter} onChange={(e) => setRuntimeFilter(e.target.value)} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                      <option value="all">All runtime states</option>
                      <option value="waiting">Waiting</option>
                      <option value="running">Running</option>
                      <option value="build_running">Build Running</option>
                      <option value="build_success">Build Success</option>
                      <option value="build_failed">Build Failed</option>
                      <option value="waiting_for_approval">Waiting for Approval</option>
                      <option value="success">Success</option>
                      <option value="failed">Failed</option>
                    </select>
                  </div>
                </div>

                {dashboardStatusFilter !== 'all' ? (
                  <div className="mb-2 flex items-center justify-between rounded-md border border-border bg-surface px-3 py-2 text-xs">
                    <p className="text-ink">
                      Showing tasks for: <span className="font-semibold capitalize">{dashboardStatusFilter}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => setDashboardStatusFilter('all')}
                      className="rounded-md border border-border bg-panel px-2 py-1 text-xs font-semibold text-ink"
                    >
                      Clear
                    </button>
                  </div>
                ) : null}

                {viewMode === 'board' ? (
                  <div className="no-scrollbar flex snap-x items-start gap-3 overflow-x-auto pb-2">
                    {COLUMNS.map((col) => (
                      <Column
                        key={col.key}
                        title={col.label}
                        status={col.key}
                        tasks={grouped[col.key] || []}
                        isCollapsed={Boolean(collapsedColumns[col.key])}
                        onToggleCollapse={toggleColumn}
                        onQuickAdd={handleQuickAdd}
                        onDropTask={handleDropTask}
                        onSelectTask={setSelectedTask}
                        onDragStart={(_, taskId) => setDragTaskId(taskId)}
                        onSwipeRight={handleSwipeRight}
                      />
                    ))}
                  </div>
                ) : (
                  <IssueListView tasks={decoratedFilteredTasks} onSelectTask={setSelectedTask} />
                )}
              </>
            ) : null}

            {activeSection === 'cycles' ? <CyclesPanel cycles={cycles} onCreate={handleCreateCycle} /> : null}
            {activeSection === 'modules' ? <ModulesPanel modules={modules} onCreate={handleCreateModule} /> : null}
            {activeSection === 'views' ? <ViewsPanel views={views} onCreate={handleCreateView} onApply={handleApplyView} /> : null}
            {activeSection === 'pages' ? <PagesPanel pages={pages} onCreate={handleCreatePage} onUpdate={handleUpdatePage} /> : null}
            {activeSection === 'analytics' ? <AnalyticsPanel analytics={analytics} /> : null}
          </div>
        </motion.section>
      </section>

      {showCreateModal ? (
        <div className="fixed inset-0 z-50 bg-slate-900/45 p-2" onClick={() => setShowCreateModal(false)}>
          <div className="mx-auto mt-8 max-w-xl rounded-xl border border-border bg-panel p-4 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-sm font-semibold text-ink">Create Work Item</h3>
            <div className="space-y-2">
              <input placeholder="Title" value={newTask.title} onChange={(e) => setNewTask((prev) => ({ ...prev, title: e.target.value }))} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs" />
              <textarea placeholder="Description" value={newTask.description} onChange={(e) => setNewTask((prev) => ({ ...prev, description: e.target.value }))} className="min-h-24 w-full rounded-md border border-border bg-surface px-3 py-2 text-xs" />
              <div className="grid grid-cols-2 gap-2">
                <select value={newTask.status} onChange={(e) => setNewTask((prev) => ({ ...prev, status: e.target.value }))} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  {COLUMNS.map((col) => <option key={col.key} value={col.key}>{col.label}</option>)}
                </select>
                <select value={newTask.assigneeType} onChange={(e) => setNewTask((prev) => ({ ...prev, assigneeType: e.target.value }))} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <option value="goose">Goose</option>
                  <option value="human">Human</option>
                </select>
                <select
                  value={newTask.baseBranch}
                  onChange={(e) => setNewTask((prev) => ({ ...prev, baseBranch: e.target.value }))}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-xs"
                >
                  {(branchOptionsByProject[activeProjectId] || [projects.find((p) => String(p.id) === activeProjectId)?.defaultBranch || 'main']).map((branch) => (
                    <option key={branch} value={branch}>
                      Checkout From: {branch}
                    </option>
                  ))}
                </select>
                <select value={newTask.cycleId} onChange={(e) => setNewTask((prev) => ({ ...prev, cycleId: e.target.value }))} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <option value="">No cycle</option>
                  {cycles.map((cycle) => <option key={cycle.id} value={cycle.id}>{cycle.name}</option>)}
                </select>
                <select value={newTask.moduleId} onChange={(e) => setNewTask((prev) => ({ ...prev, moduleId: e.target.value }))} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                  <option value="">No module</option>
                  {modules.map((module) => <option key={module.id} value={module.id}>{module.name}</option>)}
                </select>
              </div>
              <p className="text-[11px] text-muted">
                New task branches will be created from the selected checkout branch.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowCreateModal(false)} className="rounded-md border border-border bg-surface px-3 py-2 text-xs font-semibold text-ink">Cancel</button>
                <button onClick={handleCreateTask} className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white">Create</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {showProjectModal ? (
        <div className="fixed inset-0 z-50 bg-slate-900/45 p-2" onClick={() => setShowProjectModal(false)}>
          <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-border bg-panel p-4 shadow-soft" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 text-sm font-semibold text-ink">Create Project</h3>
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Project name"
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs"
              />
              <input
                value={newProjectBranch}
                onChange={(e) => setNewProjectBranch(e.target.value)}
                placeholder="Default branch (main)"
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs"
              />
              <input
                value={newProjectRepoUrl}
                onChange={(e) => setNewProjectRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo.git"
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs lg:col-span-2"
              />
              <input
                value={newProjectRepoPath}
                onChange={(e) => setNewProjectRepoPath(e.target.value)}
                placeholder="/home/infosys/work/repo"
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs lg:col-span-2"
              />
              <input
                type="password"
                value={newProjectToken}
                onChange={(e) => setNewProjectToken(e.target.value)}
                placeholder="GitHub token"
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs lg:col-span-2"
              />
              <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-ink">
                <input type="checkbox" checked={newProjectAutoPr} onChange={(e) => setNewProjectAutoPr(e.target.checked)} />
                Auto PR
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs text-ink">
                <input
                  type="checkbox"
                  checked={newProjectAutoMerge}
                  onChange={(e) => setNewProjectAutoMerge(e.target.checked)}
                />
                Auto Merge (to test)
              </label>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                onClick={() => setShowProjectModal(false)}
                className="rounded-md border border-border bg-surface px-3 py-2 text-xs font-semibold text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateProject}
                disabled={projectBusy}
                className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {projectBusy ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showPlugins ? (
        <div className="fixed inset-0 z-50 bg-slate-900/45 p-2 md:p-6" onClick={() => setShowPlugins(false)}>
          <div className="mx-auto h-full w-full max-w-5xl overflow-auto rounded-xl" onClick={(e) => e.stopPropagation()}>
            <div className="relative">
              <button onClick={() => setShowPlugins(false)} className="absolute right-2 top-2 z-10 rounded-md border border-border bg-panel px-3 py-1 text-xs font-semibold text-ink">Close</button>
              <PluginRegistry
                plugins={plugins}
                catalog={pluginCatalog}
                templates={schemaTemplates}
                onValidate={validatePlugin}
                onAdd={handleAddPlugin}
                onCreateTemplate={handleCreateSchemaTemplate}
                onUpdateTemplate={handleUpdateSchemaTemplate}
              />
            </div>
          </div>
        </div>
      ) : null}

      <TaskDrawer
        task={selectedTask}
        logs={logsByTask}
        attachmentsByTask={attachmentsByTask}
        onAssigneeChange={handleTaskAssigneeChange}
        onRetryTask={handleRetryTask}
        onBuildTest={handleRunBuildTest}
        onMoveToTrash={handleMoveTaskToTrash}
        onRefreshAttachments={handleRefreshAttachments}
        onClose={() => setSelectedTask(null)}
      />
    </main>
  );
}
