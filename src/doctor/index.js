const {
  fs,
  path,
  cachedSpawn,
  TOOL_NAME,
  SHORT_TOOL_NAME,
  GH_BIN,
  LOCK_FILE_RELATIVE,
  REQUIRED_MANAGED_REPO_FILES,
  OMX_SCAFFOLD_DIRECTORIES,
  OMX_SCAFFOLD_FILES,
  AGENT_WORKTREE_RELATIVE_DIRS,
  defaultAgentWorktreeRelativeDir,
  envFlagIsTruthy,
} = require('../context');
const { runPackageAsset } = require('../core/runtime');

// Route doctor probe-running calls through the process-scoped probe cache.
// cachedSpawn falls through to cp.spawnSync for any non-allowlisted call
// (git commit/push/stash/checkout, gh auth login, etc.), so writes are never
// cached. Doctor fires the same read questions many times within one run
// (current branch, remote URL, worktree list, gh auth status) — caching
// those is a pure perf win.
function run(cmd, args, options = {}) {
  return cachedSpawn(cmd, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: options.timeout,
  });
}
const {
  currentBranchName,
  gitRefExists,
  readGitConfig,
  ensureRepoBranch,
  hasOriginRemote,
  aheadBehind,
  mapWorktreePathsByBranch,
  hasSignificantWorkingTreeChanges,
  listLocalAgentBranches,
} = require('../git');
const {
  extractAgentBranchStartMetadata,
  resolveSandboxTarget,
  isSpawnFailure,
  startProtectedBaseSandbox,
  cleanupProtectedBaseSandbox,
} = require('../sandbox');
const { ensureOmxScaffold, configureHooks } = require('../scaffold');
const { detectRecoverableAutoFinishConflict, printAutoFinishSummary, isTerseMode } = require('../output');
const { runReviewGate } = require('../finish/review-gate');

/**
 * @typedef {Object} SandboxMetadata
 * @property {string} branch
 * @property {string} worktreePath
 */

/**
 * @typedef {Object} OperationResult
 * @property {string} status
 * @property {string} [note]
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {string} [prUrl]
 * @property {string[]} [stagedFiles]
 * @property {string} [commitMessage]
 * @property {OperationResult[]} [operations]
 * @property {OperationResult} [cleanup]
 * @property {OperationResult} [hookRefresh]
 */

/**
 * @typedef {Object} AutoFinishSummary
 * @property {boolean} [enabled]
 * @property {number} [attempted]
 * @property {number} [completed]
 * @property {number} [skipped]
 * @property {number} [failed]
 * @property {string[]} [details]
 * @property {string} [baseBranch]
 */

/**
 * @typedef {Object} SandboxStartResult
 * @property {SandboxMetadata} metadata
 * @property {string} [stdout]
 * @property {string} [stderr]
 */

/**
 * @typedef {Object} DoctorLockSyncState
 * @property {OperationResult} result
 * @property {string | null} sandboxLockContent
 */

/**
 * @typedef {Object} DoctorSandboxExecution
 * @property {OperationResult} autoCommit
 * @property {OperationResult} finish
 * @property {OperationResult} protectedBaseRepairSync
 * @property {OperationResult} lockSync
 * @property {OperationResult} omxScaffoldSync
 * @property {AutoFinishSummary} autoFinish
 * @property {string | null} sandboxLockContent
 */

function buildSandboxDoctorArgs(options, sandboxTarget) {
  const args = ['doctor', '--target', sandboxTarget];
  if (options.dryRun) args.push('--dry-run');
  if (options.force) {
    args.push('--force');
    for (const managedPath of options.forceManagedPaths || []) {
      args.push(managedPath);
    }
  }
  if (options.skipAgents) args.push('--skip-agents');
  if (options.skipPackageJson) args.push('--skip-package-json');
  if (options.skipGitignore) args.push('--no-gitignore');
  if (options.contract) args.push('--contract');
  if (!options.dropStaleLocks) args.push('--keep-stale-locks');
  args.push(options.waitForMerge ? '--wait-for-merge' : '--no-wait-for-merge');
  if (options.verboseAutoFinish) args.push('--verbose-auto-finish');
  if (options.json) args.push('--json');
  return args;
}

function originRemoteLooksLikeGithub(repoRoot) {
  const originUrl = readGitConfig(repoRoot, 'remote.origin.url');
  if (!originUrl) {
    return false;
  }
  return /github\.com[:/]/i.test(originUrl);
}

function isCommandAvailable(commandName) {
  return run('which', [commandName]).status === 0;
}

function parseGitPathList(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && line !== LOCK_FILE_RELATIVE);
}

function collectDoctorChangedPaths(worktreePath) {
  const changed = new Set();
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  for (const gitArgs of commands) {
    const result = run('git', ['-C', worktreePath, ...gitArgs], { timeout: 20_000 });
    for (const filePath of parseGitPathList(result.stdout)) {
      changed.add(filePath);
    }
  }
  return Array.from(changed);
}

function collectDoctorDeletedPaths(worktreePath) {
  const deleted = new Set();
  const commands = [
    ['diff', '--name-only', '--diff-filter=D'],
    ['diff', '--cached', '--name-only', '--diff-filter=D'],
  ];
  for (const gitArgs of commands) {
    const result = run('git', ['-C', worktreePath, ...gitArgs], { timeout: 20_000 });
    for (const filePath of parseGitPathList(result.stdout)) {
      deleted.add(filePath);
    }
  }
  return Array.from(deleted);
}

function collectWorktreeDirtyPaths(worktreePath) {
  const dirty = new Set();
  const commands = [
    ['diff', '--name-only'],
    ['diff', '--cached', '--name-only'],
    ['ls-files', '--others', '--exclude-standard'],
  ];
  for (const gitArgs of commands) {
    const result = run('git', ['-C', worktreePath, ...gitArgs], { timeout: 20_000 });
    for (const filePath of parseGitPathList(result.stdout)) {
      dirty.add(filePath);
    }
  }
  return Array.from(dirty);
}

function collectDoctorForceAddPaths(worktreePath) {
  return REQUIRED_MANAGED_REPO_FILES
    .filter((relativePath) => relativePath.startsWith('scripts/') || relativePath.startsWith('.githooks/'))
    .filter((relativePath) => fs.existsSync(path.join(worktreePath, relativePath)));
}

function stripDoctorSandboxLocks(rawContent, branchName) {
  if (!rawContent || !branchName) {
    return rawContent;
  }
  try {
    const parsed = JSON.parse(rawContent);
    const locks = parsed && typeof parsed === 'object' && parsed.locks && typeof parsed.locks === 'object'
      ? parsed.locks
      : null;
    if (!locks) {
      return rawContent;
    }
    let changed = false;
    const filteredLocks = {};
    for (const [filePath, lockInfo] of Object.entries(locks)) {
      if (lockInfo && lockInfo.branch === branchName) {
        changed = true;
        continue;
      }
      filteredLocks[filePath] = lockInfo;
    }
    if (!changed) {
      return rawContent;
    }
    return `${JSON.stringify({ ...parsed, locks: filteredLocks }, null, 2)}\n`;
  } catch {
    return rawContent;
  }
}

function claimDoctorChangedLocks(metadata) {
  if (!metadata.branch) {
    return {
      status: 'skipped',
      note: 'missing sandbox branch metadata',
      changedCount: 0,
      deletedCount: 0,
    };
  }

  const changedPaths = Array.from(new Set([
    ...collectDoctorChangedPaths(metadata.worktreePath),
    ...collectDoctorForceAddPaths(metadata.worktreePath),
  ]));
  const deletedPaths = collectDoctorDeletedPaths(metadata.worktreePath);
  if (changedPaths.length > 0) {
    runPackageAsset('lockTool', ['claim', '--branch', metadata.branch, ...changedPaths], {
      cwd: metadata.worktreePath,
      timeout: 30_000,
    });
  }
  if (deletedPaths.length > 0) {
    runPackageAsset('lockTool', ['allow-delete', '--branch', metadata.branch, ...deletedPaths], {
      cwd: metadata.worktreePath,
      timeout: 30_000,
    });
  }

  return {
    status: 'claimed',
    note: 'claimed locks for doctor auto-commit',
    changedCount: changedPaths.length,
    deletedCount: deletedPaths.length,
  };
}

function autoCommitDoctorSandboxChanges(metadata) {
  if (!metadata.worktreePath || !metadata.branch) {
    return {
      status: 'skipped',
      note: 'missing sandbox branch metadata',
    };
  }

  claimDoctorChangedLocks(metadata);
  run(
    'git',
    ['-C', metadata.worktreePath, 'add', '-A', '--', '.', `:(exclude)${LOCK_FILE_RELATIVE}`],
    { timeout: 20_000 },
  );
  const forceAddPaths = collectDoctorForceAddPaths(metadata.worktreePath);
  if (forceAddPaths.length > 0) {
    run(
      'git',
      ['-C', metadata.worktreePath, 'add', '-f', '--', ...forceAddPaths],
      { timeout: 20_000 },
    );
  }
  const staged = run(
    'git',
    ['-C', metadata.worktreePath, 'diff', '--cached', '--name-only', '--', '.', `:(exclude)${LOCK_FILE_RELATIVE}`],
    { timeout: 20_000 },
  );
  const stagedFiles = parseGitPathList(staged.stdout);
  if (stagedFiles.length === 0) {
    return {
      status: 'no-changes',
      note: 'no committable doctor changes found in sandbox',
    };
  }

  const commitResult = run(
    'git',
    ['-C', metadata.worktreePath, 'commit', '-m', 'Auto-finish: gx doctor repairs'],
    { timeout: 30_000 },
  );
  if (commitResult.status !== 0) {
    return {
      status: 'failed',
      note: 'doctor sandbox auto-commit failed',
      stdout: commitResult.stdout || '',
      stderr: commitResult.stderr || '',
    };
  }

  return {
    status: 'committed',
    note: 'doctor sandbox repairs committed',
    commitMessage: 'Auto-finish: gx doctor repairs',
    stagedFiles,
  };
}

function extractAgentBranchFinishPrUrl(output) {
  const match = String(output || '').match(/\[agent-branch-finish\] PR:\s*(\S+)/);
  return match ? match[1] : '';
}

function doctorFinishFlowIsPending(output) {
  return (
    /\[agent-branch-finish\] PR merge not completed yet; leaving PR open\./.test(output) ||
    /\[agent-branch-finish\] PR pending review\/check policy\./.test(output) ||
    /\[agent-branch-finish\] PR auto-merge enabled; waiting for required checks\/reviews\./.test(output) ||
    // A held merge (--no-auto-promote / guardex:merge-hold marker) exits 0
    // with the PR open and the lane deliberately retained. Anything but
    // 'pending' here sends the sandbox cleanup after a live held PR —
    // force-deleting its worktree, local branch, and remote branch.
    /^MERGE_HELD=1$/m.test(output) ||
    /\[agent-branch-finish\] Merge hold active/.test(output)
  );
}

function verifyDoctorSandboxCleanup(repoRoot, metadata) {
  const branchExists = Boolean(metadata.branch) && gitRefExists(repoRoot, `refs/heads/${metadata.branch}`);
  const worktreeExists = Boolean(metadata.worktreePath) && fs.existsSync(metadata.worktreePath);

  if (!branchExists && !worktreeExists) {
    return {
      status: 'verified',
      note: 'doctor sandbox cleanup verified',
    };
  }

  const cleanup = cleanupProtectedBaseSandbox(repoRoot, metadata);
  const branchStillExists = Boolean(metadata.branch) && gitRefExists(repoRoot, `refs/heads/${metadata.branch}`);
  const worktreeStillExists = Boolean(metadata.worktreePath) && fs.existsSync(metadata.worktreePath);
  if (branchStillExists || worktreeStillExists) {
    return {
      status: 'failed',
      note:
        'doctor sandbox cleanup incomplete ' +
        `(branch=${branchStillExists ? 'present' : 'missing'}, worktree=${worktreeStillExists ? 'present' : 'missing'})`,
      cleanup,
    };
  }

  return {
    status: 'verified',
    note: 'doctor sandbox cleanup verified',
    cleanup,
  };
}

function verifyDoctorSandboxRemoteCleanup(repoRoot, metadata) {
  if (!metadata.branch || !hasOriginRemote(repoRoot)) {
    return {
      status: 'skipped',
      note: 'doctor sandbox remote cleanup skipped',
    };
  }

  const remoteBefore = run(
    'git',
    ['-C', repoRoot, 'ls-remote', '--heads', 'origin', metadata.branch],
    { timeout: 20_000 },
  );
  if (isSpawnFailure(remoteBefore)) {
    throw remoteBefore.error;
  }
  if (remoteBefore.status !== 0) {
    return {
      status: 'failed',
      note: 'doctor sandbox remote branch inspection failed',
      stdout: remoteBefore.stdout || '',
      stderr: remoteBefore.stderr || '',
    };
  }
  if (!String(remoteBefore.stdout || '').trim()) {
    return {
      status: 'verified',
      note: 'doctor sandbox remote cleanup verified',
    };
  }

  const deleteResult = run(
    'git',
    ['-C', repoRoot, 'push', 'origin', '--delete', metadata.branch],
    { timeout: 30_000 },
  );
  if (isSpawnFailure(deleteResult)) {
    throw deleteResult.error;
  }
  if (deleteResult.status !== 0) {
    return {
      status: 'failed',
      note: 'doctor sandbox remote branch cleanup failed',
      stdout: deleteResult.stdout || '',
      stderr: deleteResult.stderr || '',
    };
  }

  const remoteAfter = run(
    'git',
    ['-C', repoRoot, 'ls-remote', '--heads', 'origin', metadata.branch],
    { timeout: 20_000 },
  );
  if (isSpawnFailure(remoteAfter)) {
    throw remoteAfter.error;
  }
  if (remoteAfter.status !== 0) {
    return {
      status: 'failed',
      note: 'doctor sandbox remote cleanup recheck failed',
      stdout: remoteAfter.stdout || '',
      stderr: remoteAfter.stderr || '',
    };
  }
  if (String(remoteAfter.stdout || '').trim()) {
    return {
      status: 'failed',
      note: 'doctor sandbox remote branch still present after cleanup',
      stdout: remoteAfter.stdout || '',
      stderr: remoteAfter.stderr || '',
    };
  }

  return {
    status: 'verified',
    note: 'doctor sandbox remote cleanup verified',
    stdout: deleteResult.stdout || '',
    stderr: deleteResult.stderr || '',
  };
}

function finishDoctorSandboxBranch(blocked, metadata, options = {}) {
  if (!hasOriginRemote(blocked.repoRoot)) {
    return {
      status: 'skipped',
      note: 'origin remote missing; skipped auto-finish',
    };
  }
  const explicitGhBin = Boolean(String(process.env.GUARDEX_GH_BIN || '').trim());
  if (!explicitGhBin && !originRemoteLooksLikeGithub(blocked.repoRoot)) {
    return {
      status: 'skipped',
      note: 'origin remote is not GitHub; skipped auto-finish PR flow',
    };
  }

  const ghBin = GH_BIN;
  if (!isCommandAvailable(ghBin)) {
    return {
      status: 'skipped',
      note: `'${ghBin}' not available; skipped auto-finish PR flow`,
    };
  }
  const ghAuthStatus = run(ghBin, ['auth', 'status'], { timeout: 20_000 });
  if (ghAuthStatus.status !== 0) {
    return {
      status: 'skipped',
      note: `'${ghBin}' auth unavailable; skipped auto-finish PR flow`,
      stderr: ghAuthStatus.stderr || '',
    };
  }

  const rawWaitTimeoutSeconds = Number.parseInt(process.env.GUARDEX_FINISH_WAIT_TIMEOUT_SECONDS || '1800', 10);
  const waitTimeoutSeconds =
    Number.isFinite(rawWaitTimeoutSeconds) && rawWaitTimeoutSeconds >= 30 ? rawWaitTimeoutSeconds : 1800;
  const finishTimeoutMs = Math.max(180_000, (waitTimeoutSeconds + 60) * 1000);
  const waitForMergeArg = options.waitForMerge === false ? '--no-wait-for-merge' : '--wait-for-merge';

  const finishResult = runPackageAsset(
    'branchFinish',
    ['--branch', metadata.branch, '--base', blocked.branch, '--via-pr', waitForMergeArg, '--no-cleanup'],
    { cwd: blocked.repoRoot, timeout: finishTimeoutMs },
  );
  if (isSpawnFailure(finishResult)) {
    return {
      status: 'failed',
      note: 'doctor sandbox finish flow errored',
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }
  if (finishResult.status !== 0) {
    return {
      status: 'failed',
      note: 'doctor sandbox finish flow failed',
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }

  const combinedOutput = `${finishResult.stdout || ''}\n${finishResult.stderr || ''}`;
  if (doctorFinishFlowIsPending(combinedOutput)) {
    return {
      status: 'pending',
      note: 'PR created and waiting for merge policy/checks',
      prUrl: extractAgentBranchFinishPrUrl(combinedOutput),
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }

  let cleanupVerification;
  try {
    cleanupVerification = verifyDoctorSandboxCleanup(blocked.repoRoot, metadata);
  } catch (error) {
    return {
      status: 'failed',
      note: `doctor sandbox cleanup verification failed: ${error.message}`,
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }
  if (cleanupVerification.status === 'failed') {
    return {
      status: 'failed',
      note: cleanupVerification.note,
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }

  let remoteCleanupVerification;
  try {
    remoteCleanupVerification = verifyDoctorSandboxRemoteCleanup(blocked.repoRoot, metadata);
  } catch (error) {
    return {
      status: 'failed',
      note: `doctor sandbox remote cleanup verification failed: ${error.message}`,
      stdout: finishResult.stdout || '',
      stderr: finishResult.stderr || '',
    };
  }
  if (remoteCleanupVerification.status === 'failed') {
    return {
      status: 'failed',
      note: remoteCleanupVerification.note,
      stdout: [finishResult.stdout || '', remoteCleanupVerification.stdout || ''].filter(Boolean).join('\n'),
      stderr: [finishResult.stderr || '', remoteCleanupVerification.stderr || ''].filter(Boolean).join('\n'),
    };
  }

  return {
    status: 'completed',
    note: 'doctor sandbox finish flow completed and cleanup verified',
    stdout: [finishResult.stdout || '', remoteCleanupVerification.stdout || ''].filter(Boolean).join('\n'),
    stderr: [finishResult.stderr || '', remoteCleanupVerification.stderr || ''].filter(Boolean).join('\n'),
    cleanup: cleanupVerification.cleanup,
  };
}

function mergeDoctorSandboxRepairsBackToProtectedBase(options, blocked, metadata, autoCommitResult, finishResult) {
  if (options.dryRun) {
    return {
      status: autoCommitResult.status === 'committed' ? 'would-merge' : 'skipped',
      note: autoCommitResult.status === 'committed'
        ? 'dry run: would fast-forward tracked doctor repairs into the protected base workspace'
        : 'dry run skips tracked repair merge',
    };
  }

  if (autoCommitResult.status !== 'committed') {
    return {
      status: autoCommitResult.status === 'no-changes' ? 'unchanged' : 'skipped',
      note: autoCommitResult.status === 'no-changes'
        ? 'no tracked doctor repairs needed in the protected base workspace'
        : 'tracked doctor repair merge skipped',
    };
  }

  if (finishResult.status !== 'skipped') {
    return {
      status: 'skipped',
      note: finishResult.status === 'failed'
        ? 'tracked doctor repairs remain in the sandbox after finish failure'
        : 'tracked doctor repairs are being delivered through the sandbox finish flow',
    };
  }

  const allowedPaths = new Set([
    ...(autoCommitResult.stagedFiles || []),
    ...OMX_SCAFFOLD_DIRECTORIES,
    ...Array.from(OMX_SCAFFOLD_FILES.keys()),
    ...REQUIRED_MANAGED_REPO_FILES,
    'bin',
    'package.json',
    '.gitignore',
    'AGENTS.md',
  ]);
  const dirtyPaths = collectWorktreeDirtyPaths(blocked.repoRoot);
  let stashRef = '';
  if (dirtyPaths.length > 0) {
    const unexpectedPaths = dirtyPaths.filter((filePath) => {
      if (allowedPaths.has(filePath)) {
        return false;
      }
      return !AGENT_WORKTREE_RELATIVE_DIRS.some(
        (relativeDir) => filePath === relativeDir || filePath.startsWith(`${relativeDir}/`),
      );
    });
    if (unexpectedPaths.length > 0) {
      return {
        status: 'failed',
        note: `protected branch workspace has unrelated local changes: ${unexpectedPaths.join(', ')}`,
      };
    }
    const stashMessage = `guardex-doctor-merge-${Date.now()}`;
    const stashResult = run(
      'git',
      ['-C', blocked.repoRoot, 'stash', 'push', '--all', '--message', stashMessage],
      { timeout: 30_000 },
    );
    if (isSpawnFailure(stashResult)) {
      return {
        status: 'failed',
        note: 'could not stash protected branch doctor drift before merge',
        stdout: stashResult.stdout || '',
        stderr: stashResult.stderr || '',
      };
    }
    if (stashResult.status !== 0) {
      return {
        status: 'failed',
        note: 'stashing protected branch doctor drift failed',
        stdout: stashResult.stdout || '',
        stderr: stashResult.stderr || '',
      };
    }

    const stashLookup = run(
      'git',
      ['-C', blocked.repoRoot, 'stash', 'list'],
      { timeout: 20_000 },
    );
    stashRef = String(stashLookup.stdout || '')
      .split('\n')
      .find((line) => line.includes(stashMessage))
      ?.split(':')[0]
      ?.trim() || '';
  }

  const restoreResult = ensureRepoBranch(blocked.repoRoot, blocked.branch);
  if (!restoreResult.ok) {
    if (stashRef) {
      run('git', ['-C', blocked.repoRoot, 'stash', 'apply', stashRef], { timeout: 30_000 });
    }
    return {
      status: 'failed',
      note: `could not restore protected branch '${blocked.branch}' before applying sandbox repairs`,
      stdout: restoreResult.stdout || '',
      stderr: restoreResult.stderr || '',
    };
  }

  const mergeResult = run(
    'git',
    ['-C', blocked.repoRoot, 'merge', '--ff-only', metadata.branch],
    { timeout: 30_000 },
  );
  if (isSpawnFailure(mergeResult)) {
    if (stashRef) {
      run('git', ['-C', blocked.repoRoot, 'stash', 'apply', stashRef], { timeout: 30_000 });
    }
    return {
      status: 'failed',
      note: 'tracked doctor repair merge errored',
      stdout: mergeResult.stdout || '',
      stderr: mergeResult.stderr || '',
    };
  }
  if (mergeResult.status !== 0) {
    if (stashRef) {
      run('git', ['-C', blocked.repoRoot, 'stash', 'apply', stashRef], { timeout: 30_000 });
    }
    return {
      status: 'failed',
      note: 'tracked doctor repair merge failed',
      stdout: mergeResult.stdout || '',
      stderr: mergeResult.stderr || '',
    };
  }

  let cleanupResult;
  try {
    cleanupResult = cleanupProtectedBaseSandbox(blocked.repoRoot, metadata);
  } catch (error) {
    return {
      status: 'failed',
      note: `tracked doctor repair merge succeeded but sandbox cleanup failed: ${error.message}`,
      stdout: mergeResult.stdout || '',
      stderr: mergeResult.stderr || '',
    };
  }

  let hookRefreshResult;
  try {
    hookRefreshResult = configureHooks(blocked.repoRoot, false);
  } catch (error) {
    return {
      status: 'failed',
      note: `tracked doctor repair merge succeeded but local hook refresh failed: ${error.message}`,
      stdout: mergeResult.stdout || '',
      stderr: mergeResult.stderr || '',
    };
  }

  if (stashRef) {
    run('git', ['-C', blocked.repoRoot, 'stash', 'drop', stashRef], { timeout: 20_000 });
  }

  return {
    status: 'merged',
    note: 'fast-forwarded tracked doctor repairs into the protected base workspace',
    stdout: mergeResult.stdout || '',
    stderr: mergeResult.stderr || '',
    cleanup: cleanupResult,
    hookRefresh: hookRefreshResult,
  };
}

function createDoctorSkippedOperation(note = 'sandbox doctor did not complete successfully') {
  return {
    status: 'skipped',
    note,
  };
}

function createSkippedDoctorAutoFinishSummary(note = 'sandbox doctor did not complete successfully') {
  return {
    enabled: false,
    attempted: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    details: [`Skipped auto-finish sweep (${note}).`],
  };
}

function createDoctorSandboxExecutionState(note = 'sandbox doctor did not complete successfully') {
  return {
    autoCommit: createDoctorSkippedOperation(note),
    finish: createDoctorSkippedOperation(note),
    protectedBaseRepairSync: createDoctorSkippedOperation(note),
    lockSync: createDoctorSkippedOperation(note),
    omxScaffoldSync: createDoctorSkippedOperation(note),
    autoFinish: createSkippedDoctorAutoFinishSummary(note),
    sandboxLockContent: null,
  };
}

function summarizeDoctorOmxScaffoldSync(repoRoot, dryRun) {
  const omxScaffoldOps = ensureOmxScaffold(repoRoot, dryRun);
  const changedOmxPaths = omxScaffoldOps.filter((operation) => operation.status !== 'unchanged');
  if (changedOmxPaths.length === 0) {
    return {
      status: 'unchanged',
      note: '.omx scaffold already in sync',
      operations: omxScaffoldOps,
    };
  }
  return {
    status: dryRun ? 'would-sync' : 'synced',
    note: `${dryRun ? 'would sync' : 'synced'} ${changedOmxPaths.length} .omx path(s)`,
    operations: omxScaffoldOps,
  };
}

function syncDoctorLockRegistryBeforeMerge(repoRoot, metadata) {
  const sandboxLockPath = path.join(metadata.worktreePath, LOCK_FILE_RELATIVE);
  const baseLockPath = path.join(repoRoot, LOCK_FILE_RELATIVE);
  if (!fs.existsSync(baseLockPath)) {
    return {
      result: {
        status: 'skipped',
        note: `${LOCK_FILE_RELATIVE} missing in protected base workspace`,
      },
      sandboxLockContent: null,
    };
  }
  if (!fs.existsSync(sandboxLockPath)) {
    return {
      result: {
        status: 'skipped',
        note: `${LOCK_FILE_RELATIVE} missing in sandbox worktree`,
      },
      sandboxLockContent: null,
    };
  }

  const sourceContent = stripDoctorSandboxLocks(
    fs.readFileSync(sandboxLockPath, 'utf8'),
    metadata.branch,
  );
  const destinationContent = fs.readFileSync(baseLockPath, 'utf8');
  if (sourceContent === destinationContent) {
    return {
      result: {
        status: 'unchanged',
        note: `${LOCK_FILE_RELATIVE} already in sync`,
      },
      sandboxLockContent: sourceContent,
    };
  }

  fs.mkdirSync(path.dirname(baseLockPath), { recursive: true });
  fs.writeFileSync(baseLockPath, sourceContent, 'utf8');
  return {
    result: {
      status: 'synced',
      note: `${LOCK_FILE_RELATIVE} synced from sandbox`,
    },
    sandboxLockContent: sourceContent,
  };
}

function syncDoctorLockRegistryAfterMerge(repoRoot, sandboxLockContent) {
  if (sandboxLockContent === null) {
    return {
      status: 'skipped',
      note: `${LOCK_FILE_RELATIVE} missing in sandbox worktree`,
    };
  }

  const baseLockPath = path.join(repoRoot, LOCK_FILE_RELATIVE);
  if (!fs.existsSync(baseLockPath)) {
    fs.mkdirSync(path.dirname(baseLockPath), { recursive: true });
    fs.writeFileSync(baseLockPath, sandboxLockContent, 'utf8');
    return {
      status: 'synced',
      note: `${LOCK_FILE_RELATIVE} recreated from sandbox`,
    };
  }

  const destinationContent = fs.readFileSync(baseLockPath, 'utf8');
  if (sandboxLockContent === destinationContent) {
    return {
      status: 'unchanged',
      note: `${LOCK_FILE_RELATIVE} already in sync`,
    };
  }

  fs.mkdirSync(path.dirname(baseLockPath), { recursive: true });
  fs.writeFileSync(baseLockPath, sandboxLockContent, 'utf8');
  return {
    status: 'synced',
    note: `${LOCK_FILE_RELATIVE} synced from sandbox`,
  };
}

// When GUARDEX_AUTO_SHIP is on, the unattended auto-finish sweep must honor the
// same merge gate as `gx finish` (clean AI review + green CI + GitHub-mergeable)
// before merging an agent branch to base. The gate only applies to the PR path;
// the direct/local fallbacks have no PR or CI to gate, so they pass through
// unchanged. `runReviewGate` is injectable via `deps.runReviewGate` for tests.
// Returns `{ skip: true, reason }` when the gate blocks the merge.
function runAutoShipGateForBranch({ autoShip, fallbackMode, repoRoot, branch, baseBranch }, deps = {}) {
  if (!autoShip || fallbackMode !== '') {
    return { skip: false };
  }
  const gate = deps.runReviewGate || runReviewGate;
  // Override the reviewer for unattended runs: if the default provider is
  // unavailable in the sweep environment, GUARDEX_AUTO_SHIP_REVIEW_PROVIDER
  // avoids a permanent gate-block on every branch.
  const reviewProvider = process.env.GUARDEX_AUTO_SHIP_REVIEW_PROVIDER || 'codex';
  try {
    const gateResult = gate({
      repoRoot,
      branch,
      baseBranch,
      options: { reviewProvider, allowNoChecks: false },
    });
    return { skip: false, gateResult };
  } catch (error) {
    return { skip: true, reason: `merge gate blocked (${error.message})` };
  }
}

function autoFinishReadyAgentBranches(repoRoot, options = {}) {
  const baseBranch = String(options.baseBranch || '').trim();
  const dryRun = Boolean(options.dryRun);
  const waitForMerge = options.waitForMerge !== false;
  const excludedBranches = new Set(
    Array.isArray(options.excludeBranches)
      ? options.excludeBranches.map((branch) => String(branch || '').trim()).filter(Boolean)
      : [],
  );
  const autoShip = envFlagIsTruthy(process.env.GUARDEX_AUTO_SHIP);

  const summary = {
    enabled: true,
    baseBranch,
    attempted: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  if (!baseBranch || baseBranch === 'HEAD' || baseBranch.startsWith('agent/')) {
    summary.enabled = false;
    summary.details.push('Skipped auto-finish sweep (base branch is missing or not a non-agent local branch).');
    return summary;
  }

  if (String(process.env.GUARDEX_DOCTOR_SANDBOX || '') === '1') {
    summary.enabled = false;
    summary.details.push('Skipped auto-finish sweep inside doctor sandbox pass.');
    return summary;
  }

  if (String(process.env.GUARDEX_SKIP_AUTO_FINISH_READY_BRANCHES || '') === '1') {
    summary.enabled = false;
    summary.details.push('Skipped auto-finish sweep (GUARDEX_SKIP_AUTO_FINISH_READY_BRANCHES=1).');
    return summary;
  }

  if (dryRun) {
    summary.enabled = false;
    summary.details.push('Skipped auto-finish sweep in dry-run mode.');
    return summary;
  }

  const originAvailable = hasOriginRemote(repoRoot);
  const explicitGhBin = Boolean(String(process.env.GUARDEX_GH_BIN || '').trim());
  const ghBin = GH_BIN;
  const ghAvailable =
    originAvailable &&
    (explicitGhBin || originRemoteLooksLikeGithub(repoRoot)) &&
    run(ghBin, ['--version']).status === 0;

  let fallbackMode = '';
  if (!originAvailable) {
    fallbackMode = 'local';
    summary.details.push('origin remote missing; falling back to local direct merge (no push, no PR).');
  } else if (!ghAvailable) {
    fallbackMode = 'direct';
    if (!explicitGhBin && !originRemoteLooksLikeGithub(repoRoot)) {
      summary.details.push('origin remote is not GitHub; falling back to direct merge + push.');
    } else {
      summary.details.push(`${ghBin} not available; falling back to direct merge + push.`);
    }
  }

  const branchWorktrees = mapWorktreePathsByBranch(repoRoot);
  const agentBranches = listLocalAgentBranches(repoRoot);
  if (agentBranches.length === 0) {
    summary.enabled = false;
    summary.details.push('No local agent branches found for auto-finish sweep.');
    return summary;
  }

  for (const branch of agentBranches) {
    if (excludedBranches.has(branch)) {
      summary.skipped += 1;
      summary.details.push(`[skip] ${branch}: excluded from this auto-finish sweep.`);
      continue;
    }

    const branchBase = readGitConfig(repoRoot, `branch.${branch}.guardexBase`) || baseBranch;
    if (!branchBase || branchBase === 'HEAD' || branchBase.startsWith('agent/')) {
      summary.skipped += 1;
      summary.details.push(`[skip] ${branch}: recorded base is missing or invalid.`);
      continue;
    }

    if (branch === branchBase) {
      summary.skipped += 1;
      summary.details.push(`[skip] ${branch}: source branch equals base branch.`);
      continue;
    }

    const branchWorktree = branchWorktrees.get(branch) || '';
    if (branchWorktree && hasSignificantWorkingTreeChanges(branchWorktree)) {
      summary.skipped += 1;
      summary.details.push(
        `[skip] ${branch}: dirty worktree; refusing unattended auto-commit or sync (${branchWorktree}).`,
      );
      continue;
    }

    let counts;
    try {
      counts = aheadBehind(repoRoot, branch, branchBase);
    } catch (error) {
      summary.failed += 1;
      summary.details.push(`[fail] ${branch}: unable to compute ahead/behind (${error.message}).`);
      continue;
    }

    if (counts.ahead <= 0) {
      summary.skipped += 1;
      summary.details.push(`[skip] ${branch}: already merged into ${branchBase}.`);
      continue;
    }

    const gateOutcome = runAutoShipGateForBranch(
      { autoShip, fallbackMode, repoRoot, branch, baseBranch: branchBase },
      { runReviewGate: options.runReviewGate },
    );
    if (gateOutcome.skip) {
      summary.skipped += 1;
      summary.details.push(`[skip] ${branch}: ${gateOutcome.reason}`);
      continue;
    }

    summary.attempted += 1;
    const finishArgs = [
      '--branch',
      branch,
      '--base',
      branchBase,
    ];
    if (fallbackMode === 'local') {
      finishArgs.push('--direct-only', '--no-push');
    } else if (fallbackMode === 'direct') {
      finishArgs.push('--direct-only');
    } else {
      finishArgs.push('--via-pr');
    }
    finishArgs.push(waitForMerge ? '--wait-for-merge' : '--no-wait-for-merge');
    finishArgs.push('--cleanup');

    const finishResult = runPackageAsset('branchFinish', finishArgs, {
      cwd: repoRoot,
      env: {
        GUARDEX_FINISH_GATE_DONE: autoShip && fallbackMode === '' ? '1' : '0',
        GUARDEX_FINISH_REVIEWED_HEAD: gateOutcome.gateResult?.reviewedHeadSha || '',
        GUARDEX_FINISH_REVIEWED_BASE: gateOutcome.gateResult?.reviewedBaseSha || '',
        GUARDEX_FINISH_REQUIRE_PREFLIGHT: gateOutcome.gateResult?.billingChecksWaived?.length > 0 ? '1' : '0',
      },
    });
    const combinedOutput = [finishResult.stdout || '', finishResult.stderr || ''].join('\n').trim();

    if (finishResult.status === 0) {
      summary.completed += 1;
      summary.details.push(`[done] ${branch}: auto-finish completed.`);
      continue;
    }

    const recoverableConflict = detectRecoverableAutoFinishConflict(combinedOutput);
    if (recoverableConflict) {
      summary.skipped += 1;
      const tail = combinedOutput ? ` ${combinedOutput.split('\n').slice(-2).join(' | ')}` : '';
      summary.details.push(`[skip] ${branch}: ${recoverableConflict.rawLabel}${tail}`);
      continue;
    }

    summary.failed += 1;
    const tail = combinedOutput ? ` ${combinedOutput.split('\n').slice(-2).join(' | ')}` : '';
    summary.details.push(`[fail] ${branch}: auto-finish failed.${tail}`);
  }

  return summary;
}

function pruneStaleAgentWorktrees(repoRoot, options = {}) {
  const summary = {
    enabled: true,
    ran: false,
    status: 'skipped',
    details: [],
  };

  const dryRun = Boolean(options.dryRun);
  const baseBranch = String(options.baseBranch || '').trim();

  if (String(process.env.GUARDEX_DOCTOR_SANDBOX || '') === '1') {
    summary.enabled = false;
    summary.details.push('Skipped stale-worktree prune inside doctor sandbox pass.');
    return summary;
  }

  if (String(process.env.GUARDEX_SKIP_AUTO_WORKTREE_PRUNE || '') === '1') {
    summary.enabled = false;
    summary.details.push('Skipped stale-worktree prune (GUARDEX_SKIP_AUTO_WORKTREE_PRUNE=1).');
    return summary;
  }

  const idleMinutesRaw = Number(options.idleMinutes);
  const idleMinutes = Number.isFinite(idleMinutesRaw) && idleMinutesRaw >= 0
    ? Math.floor(idleMinutesRaw)
    : 60;

  const args = [
    '--idle-minutes', String(idleMinutes),
    // Doctor may retire clean inactive lanes after the grace period, but the
    // prune asset must classify them from PR metadata first. Open PRs, dirty
    // worktrees, and live processes remain fail-closed recovery points.
    '--prune-stale-lanes',
    '--preserve-open-prs',
    '--delete-branches',
    '--delete-remote-branches',
    '--include-pr-merged',
  ];
  if (baseBranch && baseBranch !== 'HEAD' && !baseBranch.startsWith('agent/')) {
    args.push('--base', baseBranch);
  }
  if (dryRun) {
    args.push('--dry-run');
  }

  const runResult = runPackageAsset('worktreePrune', args, { cwd: repoRoot });
  summary.ran = true;
  const stdout = String(runResult.stdout || '').trim();
  const stderr = String(runResult.stderr || '').trim();
  if (stdout) {
    for (const line of stdout.split('\n')) {
      if (line.trim()) summary.details.push(line);
    }
  }
  if (runResult.status === 0) {
    summary.status = dryRun ? 'dry-run' : 'pruned';
  } else {
    summary.status = 'failed';
    if (stderr) {
      summary.details.push(`[error] ${stderr.split('\n').slice(-2).join(' | ')}`);
    } else {
      summary.details.push(`[error] worktreePrune exited with status ${runResult.status}`);
    }
  }
  return summary;
}

function executeDoctorSandboxLifecycle(options, blocked, metadata, integrations) {
  const execution = createDoctorSandboxExecutionState();
  const dryRun = Boolean(options.dryRun);
  const resolvedIntegrations = integrations && typeof integrations === 'object' ? integrations : {};
  const autoFinishRunner =
    resolvedIntegrations.autoFinishReadyAgentBranches || autoFinishReadyAgentBranches;

  execution.omxScaffoldSync = summarizeDoctorOmxScaffoldSync(blocked.repoRoot, dryRun);

  // `gx doctor` is the explicit recovery path for an invalid lock registry.
  // Publish the repaired sandbox copy before claiming changed files so the
  // fail-closed lock tool never has to ignore corrupt sibling state.
  const lockSyncState = syncDoctorLockRegistryBeforeMerge(blocked.repoRoot, metadata);
  execution.lockSync = lockSyncState.result;
  execution.sandboxLockContent = lockSyncState.sandboxLockContent;

  if (!dryRun) {
    execution.autoCommit = autoCommitDoctorSandboxChanges(metadata);
    if (execution.autoCommit.status === 'committed') {
      execution.finish = finishDoctorSandboxBranch(blocked, metadata, options);
    } else if (execution.autoCommit.status === 'no-changes') {
      execution.finish = createDoctorSkippedOperation('no doctor changes to auto-finish');
    } else if (execution.autoCommit.status !== 'failed') {
      execution.finish = createDoctorSkippedOperation('auto-commit did not run');
    }
  } else {
    execution.autoCommit = createDoctorSkippedOperation('dry-run skips doctor sandbox auto-commit');
    execution.finish = createDoctorSkippedOperation('dry-run skips doctor sandbox finish flow');
  }

  execution.protectedBaseRepairSync = mergeDoctorSandboxRepairsBackToProtectedBase(
    options,
    blocked,
    metadata,
    execution.autoCommit,
    execution.finish,
  );

  execution.omxScaffoldSync = summarizeDoctorOmxScaffoldSync(blocked.repoRoot, dryRun);
  execution.lockSync = syncDoctorLockRegistryAfterMerge(
    blocked.repoRoot,
    execution.sandboxLockContent,
  );
  execution.autoFinish = autoFinishRunner(blocked.repoRoot, {
    baseBranch: blocked.branch,
    dryRun: options.dryRun,
    waitForMerge: options.waitForMerge,
    excludeBranches: [metadata.branch],
  });

  return execution;
}

function emitDoctorSandboxJsonOutput(nestedResult, execution) {
  if (nestedResult.stdout) {
    if (nestedResult.status === 0) {
      try {
        const parsed = JSON.parse(nestedResult.stdout);
        process.stdout.write(
          JSON.stringify(
            {
              ...parsed,
              protectedBaseRepairSync: execution.protectedBaseRepairSync,
              sandboxOmxScaffoldSync: execution.omxScaffoldSync,
              sandboxLockSync: execution.lockSync,
              sandboxAutoCommit: execution.autoCommit,
              sandboxFinish: execution.finish,
              autoFinish: execution.autoFinish,
            },
            null,
            2,
          ) + '\n',
        );
      } catch {
        process.stdout.write(nestedResult.stdout);
      }
    } else {
      process.stdout.write(nestedResult.stdout);
    }
  }
  if (nestedResult.stderr) process.stderr.write(nestedResult.stderr);
}

function emitDoctorSandboxConsoleOutput(options, blocked, metadata, startResult, nestedResult, execution) {
  const terse = isTerseMode();
  console.log(
    `[${TOOL_NAME}] doctor detected protected branch '${blocked.branch}'. ` +
    `Running repairs in sandbox branch '${metadata.branch || 'agent/<auto>'}'.`,
  );
  if (startResult.stdout) process.stdout.write(startResult.stdout);
  if (startResult.stderr) process.stderr.write(startResult.stderr);
  if (nestedResult.stdout) process.stdout.write(nestedResult.stdout);
  if (nestedResult.stderr) process.stderr.write(nestedResult.stderr);
  if (nestedResult.status !== 0) {
    return;
  }

  // Terse mode: drop "[OK] X skipped because of Y" / "already in sync"
  // confirmations. Keep committed/failed/pending/merged states verbose so
  // operators still see action-required hints, PR URLs, branch names, and
  // file paths.
  if (execution.autoCommit.status === 'committed') {
    console.log(
      `[${TOOL_NAME}] Auto-committed doctor repairs in sandbox branch '${metadata.branch}'.`,
    );
  } else if (execution.autoCommit.status === 'failed') {
    console.log(`[${TOOL_NAME}] Doctor sandbox auto-commit failed; branch left for manual follow-up.`);
    if (execution.autoCommit.stdout) process.stdout.write(execution.autoCommit.stdout);
    if (execution.autoCommit.stderr) process.stderr.write(execution.autoCommit.stderr);
  } else if (!terse) {
    console.log(`[${TOOL_NAME}] Doctor sandbox auto-commit skipped: ${execution.autoCommit.note}.`);
  }

  if (execution.protectedBaseRepairSync.status === 'merged') {
    console.log(`[${TOOL_NAME}] Fast-forwarded tracked doctor repairs into the protected branch workspace.`);
  } else if (execution.protectedBaseRepairSync.status === 'would-merge') {
    console.log(`[${TOOL_NAME}] Dry run: would fast-forward tracked doctor repairs into the protected branch workspace.`);
  } else if (execution.protectedBaseRepairSync.status === 'failed') {
    console.log(`[${TOOL_NAME}] Protected branch tracked repair merge failed: ${execution.protectedBaseRepairSync.note}.`);
    if (execution.protectedBaseRepairSync.stdout) process.stdout.write(execution.protectedBaseRepairSync.stdout);
    if (execution.protectedBaseRepairSync.stderr) process.stderr.write(execution.protectedBaseRepairSync.stderr);
  } else if (!terse) {
    if (execution.protectedBaseRepairSync.status === 'unchanged') {
      console.log(`[${TOOL_NAME}] Protected branch workspace already had the tracked doctor repairs.`);
    } else {
      console.log(`[${TOOL_NAME}] Protected branch tracked repair merge skipped: ${execution.protectedBaseRepairSync.note}.`);
    }
  }

  if (execution.lockSync.status === 'synced') {
    console.log(
      `[${TOOL_NAME}] Synced repaired lock registry back to protected branch workspace (${LOCK_FILE_RELATIVE}).`,
    );
  } else if (execution.lockSync.status === 'unchanged') {
    // Kept verbose in terse mode too: downstream consumers (and tests) rely
    // on seeing the lock-registry sync stage reach a terminal state line.
    console.log(`[${TOOL_NAME}] Lock registry already synced in protected branch workspace.`);
  } else if (!terse) {
    console.log(`[${TOOL_NAME}] Lock registry sync skipped: ${execution.lockSync.note}.`);
  }

  if (execution.finish.status === 'completed') {
    console.log(`[${TOOL_NAME}] Auto-finish flow completed for sandbox branch '${metadata.branch}'.`);
    if (execution.finish.stdout) process.stdout.write(execution.finish.stdout);
    if (execution.finish.stderr) process.stderr.write(execution.finish.stderr);
  } else if (execution.finish.status === 'pending') {
    console.log(
      `[${TOOL_NAME}] Auto-finish pending for sandbox branch '${metadata.branch}': ${execution.finish.note}.`,
    );
    if (execution.finish.prUrl) {
      console.log(`[${TOOL_NAME}] PR: ${execution.finish.prUrl}`);
    }
    if (execution.finish.stdout) process.stdout.write(execution.finish.stdout);
    if (execution.finish.stderr) process.stderr.write(execution.finish.stderr);
  } else if (execution.finish.status === 'failed') {
    console.log(`[${TOOL_NAME}] Auto-finish flow failed for sandbox branch '${metadata.branch}'.`);
    if (execution.finish.stdout) process.stdout.write(execution.finish.stdout);
    if (execution.finish.stderr) process.stderr.write(execution.finish.stderr);
  } else if (!terse) {
    console.log(`[${TOOL_NAME}] Auto-finish skipped: ${execution.finish.note}.`);
  }

  printAutoFinishSummary(execution.autoFinish, {
    baseBranch: blocked.branch,
    verbose: options.verboseAutoFinish,
  });
  if (execution.omxScaffoldSync.status === 'synced') {
    console.log(`[${TOOL_NAME}] Synced .omx scaffold back to protected branch workspace.`);
  } else if (execution.omxScaffoldSync.status === 'would-sync') {
    console.log(`[${TOOL_NAME}] Dry run: would sync .omx scaffold back to protected branch workspace.`);
  } else if (!terse) {
    if (execution.omxScaffoldSync.status === 'unchanged') {
      console.log(`[${TOOL_NAME}] .omx scaffold already aligned in protected branch workspace.`);
    } else {
      console.log(`[${TOOL_NAME}] .omx scaffold sync skipped: ${execution.omxScaffoldSync.note}.`);
    }
  }
}

function setDoctorSandboxExitCode(nestedResult, execution) {
  if (typeof nestedResult.status === 'number') {
    let exitCode = nestedResult.status;
    if (exitCode === 0 && execution.autoCommit.status === 'failed') {
      exitCode = 1;
    }
    if (
      exitCode === 0 &&
      execution.autoCommit.status === 'committed' &&
      (execution.finish.status === 'failed' || execution.finish.status === 'pending')
    ) {
      exitCode = 1;
    }
    if (exitCode === 0 && execution.protectedBaseRepairSync.status === 'failed') {
      exitCode = 1;
    }
    process.exitCode = exitCode;
    return;
  }
  process.exitCode = 1;
}

function runDoctorInSandbox(options, blocked, rawIntegrations = {}) {
  const integrations = rawIntegrations && typeof rawIntegrations === 'object' ? rawIntegrations : {};
  const startSandbox = integrations.startProtectedBaseSandbox || startProtectedBaseSandbox;
  const startResult = startSandbox(blocked, {
    taskName: `${SHORT_TOOL_NAME}-doctor`,
    sandboxSuffix: 'gx-doctor',
  });
  const metadata = startResult.metadata;

  const sandboxTarget = resolveSandboxTarget(blocked.repoRoot, metadata.worktreePath, options.target);
  const nestedResult = run(
    process.execPath,
    [require.main?.filename || process.argv[1], ...buildSandboxDoctorArgs(options, sandboxTarget)],
    { cwd: metadata.worktreePath, env: { GUARDEX_DOCTOR_SANDBOX: '1' } },
  );
  if (isSpawnFailure(nestedResult)) {
    throw nestedResult.error;
  }

  const execution = nestedResult.status === 0
    ? executeDoctorSandboxLifecycle(options, blocked, metadata, integrations)
    : createDoctorSandboxExecutionState();

  if (options.json) {
    emitDoctorSandboxJsonOutput(nestedResult, execution);
  } else {
    emitDoctorSandboxConsoleOutput(options, blocked, metadata, startResult, nestedResult, execution);
  }

  setDoctorSandboxExitCode(nestedResult, execution);
}

module.exports = {
  doctorFinishFlowIsPending,
  extractAgentBranchStartMetadata,
  resolveSandboxTarget,
  buildSandboxDoctorArgs,
  isSpawnFailure,
  startProtectedBaseSandbox,
  cleanupProtectedBaseSandbox,
  claimDoctorChangedLocks,
  autoCommitDoctorSandboxChanges,
  finishDoctorSandboxBranch,
  mergeDoctorSandboxRepairsBackToProtectedBase,
  syncDoctorLockRegistryBeforeMerge,
  syncDoctorLockRegistryAfterMerge,
  executeDoctorSandboxLifecycle,
  emitDoctorSandboxJsonOutput,
  emitDoctorSandboxConsoleOutput,
  autoFinishReadyAgentBranches,
  runAutoShipGateForBranch,
  pruneStaleAgentWorktrees,
  runDoctorInSandbox,
};
