import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(command, args, options = {}) {
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
    child.on('close', (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${command} failed (${code}): ${(err || out).trim()}`));
    });
  });
}

function sanitizeRepoUrl(repoUrl = '') {
  return String(repoUrl).trim().replace(/\/+$/, '');
}

function toAbsoluteRepoPath(repoPath = '') {
  const clean = String(repoPath).trim();
  if (!clean) return '';
  if (path.isAbsolute(clean)) return clean;
  return path.resolve(process.cwd(), clean);
}

function authArgs(token) {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}

function taskBranchName(task) {
  return task?.branchName || `gse-${task?.id || 'task'}-work-item`;
}

function toBoolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function isNetworkGitError(error) {
  const text = String(error?.message || error || '').toLowerCase();
  if (!text) return false;
  return (
    text.includes('could not resolve host') ||
    text.includes('failed to connect') ||
    text.includes('network is unreachable') ||
    text.includes('could not read from remote repository') ||
    text.includes('connection timed out')
  );
}

export function validateProjectRepoConfig(input = {}) {
  const errors = [];
  const repoUrl = sanitizeRepoUrl(input.repoUrl);
  const repoPath = String(input.repoPath || '').trim();
  if (!repoUrl) errors.push('repoUrl is required');
  if (!repoPath) errors.push('repoPath is required');
  const isGithubHttps = /^https:\/\/github\.com\/[^/]+\/[^/]+(\.git)?$/i.test(repoUrl);
  const isLocalPath = path.isAbsolute(repoUrl);
  const isFileUrl = repoUrl.startsWith('file://');
  if (repoUrl && !isGithubHttps && !isLocalPath && !isFileUrl) {
    errors.push('repoUrl must be a valid GitHub HTTPS URL or a local repository path/file:// URL');
  }
  return errors;
}

export async function verifyRepoConnectivity(project) {
  const repoUrl = sanitizeRepoUrl(project?.repoUrl);
  const repoPath = toAbsoluteRepoPath(project?.repoPath);
  const githubToken = String(project?.githubToken || '').trim();
  const defaultBranch = String(project?.defaultBranch || 'main').trim() || 'main';

  const errors = validateProjectRepoConfig({ repoUrl, repoPath });
  if (errors.length) return { ok: false, errors };

  const gitAuth = authArgs(githubToken);
  try {
    await run('git', [...gitAuth, 'ls-remote', '--heads', repoUrl, defaultBranch], { cwd: process.cwd() });
    return {
      ok: true,
      repoUrl,
      repoPath,
      defaultBranch
    };
  } catch (error) {
    return { ok: false, errors: [String(error?.message || error)] };
  }
}

export async function listProjectBranches(project) {
  const repoUrl = sanitizeRepoUrl(project?.repoUrl);
  const githubToken = String(project?.githubToken || '').trim();
  const defaultBranch = String(project?.defaultBranch || 'main').trim() || 'main';
  const errors = validateProjectRepoConfig({ repoUrl, repoPath: project?.repoPath || '/' });
  if (errors.length) return { ok: false, branches: [defaultBranch], errors };

  const gitAuth = authArgs(githubToken);
  try {
    const result = await run('git', [...gitAuth, 'ls-remote', '--heads', repoUrl], { cwd: process.cwd() });
    const branches = String(result.out || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[1] || '')
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.replace('refs/heads/', ''))
      .filter(Boolean);
    const unique = Array.from(new Set([defaultBranch, ...branches]));
    unique.sort((a, b) => a.localeCompare(b));
    return { ok: true, branches: unique };
  } catch (error) {
    return { ok: false, branches: [defaultBranch], errors: [String(error?.message || error)] };
  }
}

export async function ensureProjectRepoReady(project, onLog, options = {}) {
  const repoUrl = sanitizeRepoUrl(project?.repoUrl);
  const repoPath = toAbsoluteRepoPath(project?.repoPath);
  const githubToken = String(project?.githubToken || '').trim();
  const defaultBranch = String(project?.defaultBranch || 'main').trim() || 'main';
  const preferredBranch = String(options?.preferredBranch || '').trim();

  const errors = validateProjectRepoConfig({ repoUrl, repoPath });
  if (errors.length) throw new Error(errors.join('; '));

  fs.mkdirSync(path.dirname(repoPath), { recursive: true });
  const gitAuth = authArgs(githubToken);

  const emit = (line) => onLog?.(line);
  const allowOfflineGit = toBoolEnv(process.env.GOOSE_ALLOW_OFFLINE_GIT, true);
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    emit(`repo> cloning ${repoUrl} -> ${repoPath}`);
    await run('git', [...gitAuth, 'clone', repoUrl, repoPath], { cwd: process.cwd() });
  } else {
    emit(`repo> using existing repo at ${repoPath}`);
  }

  await run('git', ['-C', repoPath, 'remote', 'set-url', 'origin', repoUrl], { cwd: process.cwd() });
  emit('repo> fetching latest refs');
  await run('git', [...gitAuth, '-C', repoPath, 'fetch', '--all', '--prune'], { cwd: process.cwd() }).catch((error) => {
    if (allowOfflineGit && isNetworkGitError(error)) {
      emit(`repo> fetch skipped (offline): ${String(error?.message || error).slice(0, 220)}`);
      return;
    }
    throw error;
  });
  const status = await run('git', ['-C', repoPath, 'status', '--porcelain'], { cwd: process.cwd() });
  const dirty = String(status.out || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (dirty.length) {
    emit(`repo> detected dirty working tree (${dirty.length} files); auto-stashing before checkout`);
    await run('git', ['-C', repoPath, 'stash', 'push', '-u', '-m', `goose-c2-auto-stash-${Date.now()}`], {
      cwd: process.cwd()
    });
  }
  const checkoutBranch = preferredBranch || defaultBranch;
  const hasRemoteCheckoutBranch = await run('git', ['-C', repoPath, 'rev-parse', '--verify', `origin/${checkoutBranch}`], {
    cwd: process.cwd()
  })
    .then(() => true)
    .catch(() => false);
  const finalCheckout = hasRemoteCheckoutBranch ? checkoutBranch : defaultBranch;
  emit(
    `repo> checking out ${finalCheckout}${
      preferredBranch && finalCheckout !== preferredBranch ? ` (fallback from ${preferredBranch})` : ''
    }`
  );
  await run('git', ['-C', repoPath, 'checkout', finalCheckout], { cwd: process.cwd() });

  return { repoPath, repoUrl, defaultBranch, githubToken };
}

export async function ensureTaskBranch(repo, task, onLog) {
  const emit = (line) => onLog?.(line);
  const branch = taskBranchName(task);
  const gitAuth = authArgs(repo.githubToken || '');
  const explicitBase = String(task?.baseBranch || '').trim();
  const baseBranch = explicitBase || String(repo.defaultBranch || 'main').trim() || 'main';
  const allowOfflineGit = toBoolEnv(process.env.GOOSE_ALLOW_OFFLINE_GIT, true);
  emit(`repo> preparing task branch ${branch}`);
  await run('git', [...gitAuth, '-C', repo.repoPath, 'fetch', '--all', '--prune'], { cwd: process.cwd() }).catch((error) => {
    if (allowOfflineGit && isNetworkGitError(error)) {
      emit(`repo> branch fetch skipped (offline): ${String(error?.message || error).slice(0, 220)}`);
      return;
    }
    throw error;
  });
  emit(`repo> base branch for task: ${baseBranch}${explicitBase ? ' (from work item)' : ' (project default)'}`);
  const hasRemoteBranch = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${branch}`], {
    cwd: process.cwd()
  })
    .then(() => true)
    .catch(() => false);
  if (hasRemoteBranch) {
    await run('git', ['-C', repo.repoPath, 'checkout', '-B', branch, `origin/${branch}`], { cwd: process.cwd() });
    await run('git', [...gitAuth, '-C', repo.repoPath, 'pull', '--ff-only', 'origin', branch], { cwd: process.cwd() }).catch((error) => {
      if (allowOfflineGit && isNetworkGitError(error)) {
        emit(`repo> pull skipped (offline): ${String(error?.message || error).slice(0, 220)}`);
        return;
      }
      throw error;
    });
  } else {
    const hasRemoteBase = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${baseBranch}`], {
      cwd: process.cwd()
    })
      .then(() => true)
      .catch(() => false);
    const hasLocalBase = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', baseBranch], { cwd: process.cwd() })
      .then(() => true)
      .catch(() => false);
    const startPoint = hasRemoteBase ? `origin/${baseBranch}` : hasLocalBase ? baseBranch : repo.defaultBranch || 'main';
    await run('git', ['-C', repo.repoPath, 'checkout', '-B', branch, startPoint], { cwd: process.cwd() });
  }
  return branch;
}

export async function autoMergeTaskBranchToTest(repo, task, onLog, testBranch = 'test') {
  const emit = (line) => onLog?.(line);
  const gitAuth = authArgs(repo.githubToken || '');
  const branch = taskBranchName(task);
  emit(`repo> auto-merge flow start: ${branch} -> ${testBranch}`);
  await run('git', [...gitAuth, '-C', repo.repoPath, 'fetch', '--all', '--prune'], { cwd: process.cwd() });
  const hasRemoteTest = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${testBranch}`], {
    cwd: process.cwd()
  })
    .then(() => true)
    .catch(() => false);
  if (hasRemoteTest) {
    await run('git', ['-C', repo.repoPath, 'checkout', '-B', testBranch, `origin/${testBranch}`], { cwd: process.cwd() });
    await run('git', [...gitAuth, '-C', repo.repoPath, 'pull', '--ff-only', 'origin', testBranch], { cwd: process.cwd() }).catch(() => {});
  } else {
    await run('git', ['-C', repo.repoPath, 'checkout', '-B', testBranch, repo.defaultBranch || 'main'], {
      cwd: process.cwd()
    });
  }
  await run('git', ['-C', repo.repoPath, 'merge', '--no-ff', '--no-edit', branch], { cwd: process.cwd() });
  await run('git', [...gitAuth, '-C', repo.repoPath, 'push', 'origin', testBranch], { cwd: process.cwd() });
  emit(`repo> auto-merge completed: ${branch} -> ${testBranch}`);
}

export async function autoCreatePullRequest(repo, task, onLog, targetBranch) {
  const emit = (line) => onLog?.(line);
  const gitAuth = authArgs(repo.githubToken || '');
  const branch = taskBranchName(task);
  const requestedBase = targetBranch || repo.defaultBranch || 'main';
  let base = requestedBase;
  const key = task.externalId || `GSE-${task.id}`;
  const title = `[${key}] ${task.title}`;

  // Make sure refs are current and the head branch exists on origin.
  await run('git', [...gitAuth, '-C', repo.repoPath, 'fetch', '--all', '--prune'], { cwd: process.cwd() }).catch(() => {});
  emit(`repo> ensuring remote head branch exists: ${branch}`);
  await run('git', [...gitAuth, '-C', repo.repoPath, 'push', '-u', 'origin', branch], { cwd: process.cwd() });
  await run('git', [...gitAuth, '-C', repo.repoPath, 'fetch', 'origin', branch], { cwd: process.cwd() }).catch(() => {});

  const remoteHeadExists = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${branch}`], {
    cwd: process.cwd()
  })
    .then(() => true)
    .catch(() => false);
  if (!remoteHeadExists) {
    emit(`repo> skipping PR: remote head branch origin/${branch} is missing.`);
    return { url: '', skipped: true, reason: 'head-missing' };
  }

  const remoteRequestedBaseExists = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${requestedBase}`], {
    cwd: process.cwd()
  })
    .then(() => true)
    .catch(() => false);
  if (!remoteRequestedBaseExists) {
    const fallbackBase = String(repo.defaultBranch || 'main').trim() || 'main';
    const remoteFallbackExists = await run('git', ['-C', repo.repoPath, 'rev-parse', '--verify', `origin/${fallbackBase}`], {
      cwd: process.cwd()
    })
      .then(() => true)
      .catch(() => false);
    if (!remoteFallbackExists) {
      emit(`repo> skipping PR: remote base branch origin/${requestedBase} does not exist.`);
      return { url: '', skipped: true, reason: 'base-missing' };
    }
    base = fallbackBase;
    emit(`repo> requested base ${requestedBase} not found on origin; falling back to ${base}.`);
  }

  // Skip PR creation when there are no commits between remote base and remote head.
  const diffCountRes = await run('git', ['-C', repo.repoPath, 'rev-list', '--count', `origin/${base}..origin/${branch}`], {
    cwd: process.cwd()
  }).catch(() => ({ out: '0' }));
  const diffCount = Number.parseInt(String(diffCountRes.out || '0').trim(), 10) || 0;
  if (diffCount <= 0) {
    emit(`repo> skipping PR: no commits between origin/${base} and origin/${branch}`);
    return { url: '', skipped: true, reason: 'no-commits' };
  }

  emit(`repo> creating PR for ${branch} -> ${base}`);
  const body = [
    `Auto-generated PR for work item ${key}.`,
    '',
    `Branch: ${branch}`,
    `Base: ${base}`,
    '',
    'This PR was created by Goose automation.'
  ].join('\n');
  const ghEnv = {
    ...process.env,
    ...(repo.githubToken ? { GH_TOKEN: repo.githubToken, GITHUB_TOKEN: repo.githubToken } : {})
  };
  const result = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], {
    cwd: repo.repoPath,
    env: ghEnv
  }).catch((error) => {
    const message = String(error?.message || error);
    if (
      /No commits between/i.test(message) ||
      /Head ref must be a branch/i.test(message) ||
      /Head sha can't be blank/i.test(message) ||
      /Base sha can't be blank/i.test(message)
    ) {
      emit(`repo> skipping PR: ${message}`);
      return { out: '', skipped: true, reason: 'gh-graphql' };
    }
    throw error;
  });
  const url = String(result.out || '').trim().split('\n').find((line) => line.startsWith('http'));
  if (!url) {
    return { url: '', skipped: true, reason: 'gh-no-url' };
  }
  emit(`repo> PR created: ${url}`);
  return { url };
}

export async function getProjectRepoStatus(project) {
  const repoPath = toAbsoluteRepoPath(project?.repoPath);
  const repoUrl = sanitizeRepoUrl(project?.repoUrl);
  const defaultBranch = String(project?.defaultBranch || 'main').trim() || 'main';
  if (!repoPath || !repoUrl) {
    return {
      ok: false,
      repoPath,
      repoUrl,
      defaultBranch,
      exists: false,
      gitReady: false,
      currentBranch: '',
      headSha: '',
      error: 'Repository is not configured.'
    };
  }

  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return {
      ok: true,
      repoPath,
      repoUrl,
      defaultBranch,
      exists: fs.existsSync(repoPath),
      gitReady: false,
      currentBranch: '',
      headSha: '',
      error: 'Repository is not cloned yet.'
    };
  }

  try {
    const branchRes = await run('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: process.cwd() });
    const shaRes = await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { cwd: process.cwd() });
    const currentBranch = String(branchRes.out || '').trim();
    const headSha = String(shaRes.out || '').trim();
    return {
      ok: true,
      repoPath,
      repoUrl,
      defaultBranch,
      exists: true,
      gitReady: true,
      currentBranch,
      headSha,
      detachedHead: currentBranch === 'HEAD'
    };
  } catch (error) {
    return {
      ok: false,
      repoPath,
      repoUrl,
      defaultBranch,
      exists: true,
      gitReady: true,
      currentBranch: '',
      headSha: '',
      error: String(error?.message || error)
    };
  }
}

export function readTaskAttachments(project, task) {
  const repoPath = toAbsoluteRepoPath(project?.repoPath);
  const files = Array.isArray(task?.refinementFiles) ? task.refinementFiles : [];
  if (!repoPath || !files.length) return [];
  return files
    .filter((rel) => String(rel).toLowerCase().endsWith('.md'))
    .map((relativePath) => {
      const safeRelative = String(relativePath).replace(/\\/g, '/');
      const absolutePath = path.resolve(repoPath, safeRelative);
      if (!absolutePath.startsWith(repoPath + path.sep) && absolutePath !== repoPath) {
        return { path: safeRelative, error: 'Path blocked' };
      }
      if (!fs.existsSync(absolutePath)) return { path: safeRelative, error: 'File not found' };
      return { path: safeRelative, content: fs.readFileSync(absolutePath, 'utf8') };
    });
}
