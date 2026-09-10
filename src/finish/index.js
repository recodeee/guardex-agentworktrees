// @ts-check
const { TOOL_NAME, SHORT_TOOL_NAME, LOCK_FILE_RELATIVE, path, fs } = require('../context');
const { isTerseMode } = require('../output');
const { run, runPackageAsset, assetStdio } = require('../core/runtime');
const {
  resolveRepoRoot,
  uniquePreserveOrder,
  listAgentWorktrees,
  listLocalAgentBranchesForFinish,
  branchExists,
  resolveFinishBaseBranch,
  worktreeHasLocalChanges,
  branchMergedIntoBase,
  resolveBaseBranch,
  resolveSyncStrategy,
  ensureOriginBaseRef,
  gitRun,
  currentBranchName,
  workingTreeIsDirty,
  aheadBehind,
  lockRegistryStatus,
  syncOperation,
  gitOutputLines,
} = require('../git');
const {
  parseCleanupArgs,
  parseMergeArgs,
  parseFinishArgs,
  parseSyncArgs,
} = require('../cli/args');
const submoduleModule = require('../submodule');
const { runPreflight, summarizePreflight } = require('./preflight');
const { runReviewGate } = require('./review-gate');
const { createFinishProgress, summarizeFinishRun } = require('./progress');

/**
 * Options recognized by {@link autoCommitWorktreeForFinish} and the public
 * {@link finish} entry. Mirrors the relevant subset of `parseFinishArgs`'s
 * output.
 *
 * @typedef {Object} FinishOptions
 * @property {boolean} [noAutoCommit] When true, refuse to auto-commit dirty worktrees.
 * @property {boolean} [dryRun] When true, surface intended actions without performing them.
 * @property {string} [commitMessage] Override for the auto-commit message.
 * @property {boolean} [advanceSubmodules] Run `submoduleModule.advance` against the worktree before finish.
 * @property {boolean} [waitForMerge] Forward `--wait-for-merge` to `agent-branch-finish`.
 * @property {boolean} [cleanup] Forward `--cleanup` (vs `--no-cleanup`) to `agent-branch-finish`.
 * @property {'pr'|'direct'|'auto'} [mergeMode] Merge selection forwarded to `agent-branch-finish`.
 * @property {boolean} [keepRemote] Forward `--keep-remote-branch` to `agent-branch-finish`.
 * @property {boolean} [parentGitlinkCommit] Toggle for `--parent-gitlink-commit`.
 * @property {boolean} [failFast] Stop the loop after the first failing branch.
 * @property {boolean} [all] Include already-merged branches in the candidate list.
 * @property {string} [branch] Single branch to finish (skips discovery).
 * @property {string} [base] Explicit base branch override.
 * @property {string} [target] Path inside the target repo (defaults to cwd).
 * @property {boolean} [agentQuiet] Capture narrative finish output and emit compact JSON summaries.
 */

/**
 * Whether the caller explicitly requested that the legacy branch-finish script
 * skip its full repository-defined preflight.
 */
function shouldSkipBranchPreflight(options = {}) {
  return options.skipPreflight === true;
}

/**
 * Outcome of an auto-commit attempt for a single branch.
 *
 * @typedef {Object} AutoCommitResult
 * @property {boolean} changed True when the worktree had local changes.
 * @property {boolean} committed True only when a commit was created.
 * @property {boolean} [dryRun] True when `--dry-run` short-circuited the commit.
 * @property {string} [message] Commit message used (when `committed` is true).
 */

/**
 * Claim agent file locks for every file the worktree is about to commit,
 * including pending deletions. No-op when there is nothing to claim.
 *
 * @param {string} repoRoot Repo root for the lock tool to operate on.
 * @param {string} worktreePath Worktree whose changes are being committed.
 * @param {string} branch Agent branch that should own the new claims.
 * @returns {void}
 * @throws {Error} When the lock-claim or allow-delete subprocess exits non-zero.
 */
function claimLocksForAutoCommit(repoRoot, worktreePath, branch) {
  const changedFiles = uniquePreserveOrder([
    ...gitOutputLines(worktreePath, ['diff', '--name-only', '--', '.', ':(exclude).omx/state/agent-file-locks.json']),
    ...gitOutputLines(worktreePath, ['diff', '--cached', '--name-only', '--', '.', ':(exclude).omx/state/agent-file-locks.json']),
    ...gitOutputLines(worktreePath, ['ls-files', '--others', '--exclude-standard']),
  ]);

  if (changedFiles.length > 0) {
    const claim = runPackageAsset('lockTool', ['claim', '--branch', branch, ...changedFiles], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    if (claim.status !== 0) {
      throw new Error(
        `Lock claim failed for ${branch}: ${(
          claim.stderr || claim.stdout || ''
        ).trim()}`,
      );
    }
  }

  const deletedFiles = uniquePreserveOrder([
    ...gitOutputLines(worktreePath, [
      'diff',
      '--name-only',
      '--diff-filter=D',
      '--',
      '.',
      ':(exclude).omx/state/agent-file-locks.json',
    ]),
    ...gitOutputLines(worktreePath, [
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=D',
      '--',
      '.',
      ':(exclude).omx/state/agent-file-locks.json',
    ]),
  ]);

  if (deletedFiles.length > 0) {
    const allowDelete = runPackageAsset('lockTool', ['allow-delete', '--branch', branch, ...deletedFiles], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
    if (allowDelete.status !== 0) {
      throw new Error(
        `Delete-lock grant failed for ${branch}: ${(
          allowDelete.stderr || allowDelete.stdout || ''
        ).trim()}`,
      );
    }
  }
}

/**
 * Stage and commit pending work in `worktreePath` (if any) before the
 * finish flow takes over. Honors `--no-auto-commit` and `--dry-run`.
 *
 * @param {string} repoRoot Repo root for lock-tool dispatch.
 * @param {string} worktreePath Worktree to commit in.
 * @param {string} branch Agent branch the worktree is checked out on.
 * @param {FinishOptions} options Finish options (only auto-commit fields are read).
 * @returns {AutoCommitResult} What happened (or would happen, in dry-run).
 * @throws {Error} When `--no-auto-commit` is set with dirty state, or when git add/commit fails.
 */
function autoCommitWorktreeForFinish(repoRoot, worktreePath, branch, options) {
  const hasChanges = worktreeHasLocalChanges(worktreePath);
  if (!hasChanges) {
    return { changed: false, committed: false };
  }

  if (options.noAutoCommit) {
    throw new Error(
      `Branch '${branch}' has local changes in ${worktreePath}. Re-run without --no-auto-commit or commit manually first.`,
    );
  }

  if (options.dryRun) {
    return { changed: true, committed: false, dryRun: true };
  }

  claimLocksForAutoCommit(repoRoot, worktreePath, branch);

  const addResult = run('git', ['-C', worktreePath, 'add', '-A'], { stdio: 'pipe' });
  if (addResult.status !== 0) {
    throw new Error(`git add failed in ${worktreePath}: ${(addResult.stderr || addResult.stdout || '').trim()}`);
  }

  const stagedHasChanges = run('git', [
    '-C',
    worktreePath,
    'diff',
    '--cached',
    '--quiet',
    '--',
    '.',
    ':(exclude).omx/state/agent-file-locks.json',
  ], { stdio: 'pipe' }).status === 1;
  if (!stagedHasChanges) {
    return { changed: true, committed: false };
  }

  const commitMessage = options.commitMessage || `Auto-finish: ${branch}`;
  const commitResult = run('git', ['-C', worktreePath, 'commit', '-m', commitMessage], { stdio: 'pipe' });
  if (commitResult.status !== 0) {
    throw new Error(
      `Auto-commit failed on '${branch}': ${(
        commitResult.stderr || commitResult.stdout || ''
      ).trim()}`,
    );
  }

  return { changed: true, committed: true, message: commitMessage };
}

/**
 * Run the worktree-prune sweep with options parsed from `rawArgs`. In watch
 * mode loops forever (or until `--once`), printing the cycle header and
 * delegating each cycle to the `worktreePrune` package asset.
 *
 * @param {ReadonlyArray<string>} rawArgs CLI argv slice for the cleanup command.
 * @returns {void}
 * @throws {Error} When the underlying prune subprocess exits non-zero or the watch sleep fails.
 */
function cleanup(rawArgs) {
  if (rawArgs.some((arg) => arg === '--help' || arg === '-h') || (rawArgs.length === 1 && rawArgs[0] === 'help')) {
    console.log(`USAGE: ${SHORT_TOOL_NAME} cleanup [options]

Prune merged or stale agent branches and worktrees.

OPTIONS
  --target <path>          Target repository (default: current directory)
  --base <branch>          Base branch used to determine merged branches
  --branch <agent/*>       Limit cleanup to one agent branch
  --dry-run                Print actions without changing branches or worktrees
  --force-dirty            Allow cleanup of dirty worktrees
  --keep-remote            Keep remote agent branches
  --prune-clean-worktrees  Explicitly prune clean, unmerged agent worktrees
  --keep-clean-worktrees   Preserve clean, unmerged agent worktrees (default)
  --include-clean-linked-worktrees
                           Also prune clean linked worktrees outside managed agent directories
  --include-pr-merged      Treat branches from merged PRs as merged
  --idle-minutes <n>       Only consider worktrees idle for at least n minutes
  --watch                  Repeat cleanup cycles (defaults idle threshold to 60)
  --interval <seconds>     Watch interval in seconds (minimum: 5; default: 60)
  --once                   Run one cleanup cycle when used with --watch
  --max-branches <n>       Limit branches processed per cycle
  -h, --help               Show this help`);
    process.exitCode = 0;
    return;
  }

  const activeCwd = process.cwd();
  const options = parseCleanupArgs(rawArgs);
  const repoRoot = resolveRepoRoot(options.target);

  const args = [];
  if (options.base) {
    args.push('--base', options.base);
  }
  if (options.branch) {
    args.push('--branch', options.branch);
  }
  if (options.forceDirty) {
    args.push('--force-dirty');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }
  if (!options.keepCleanWorktrees) {
    args.push('--only-dirty-worktrees');
  }
  if (options.includeCleanLinkedWorktrees) {
    args.push('--include-clean-linked-worktrees');
  }
  if (options.includePrMerged) {
    args.push('--include-pr-merged');
  }
  if (options.idleMinutes > 0) {
    args.push('--idle-minutes', String(options.idleMinutes));
  }
  if (options.maxBranches > 0) {
    args.push('--max-branches', String(options.maxBranches));
  }
  args.push('--delete-branches');
  if (!options.keepRemote) {
    args.push('--delete-remote-branches');
  }

  const runCleanupCycle = () => {
    const runResult = runPackageAsset('worktreePrune', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { GUARDEX_PRUNE_ACTIVE_CWD: activeCwd },
    });
    if (runResult.status !== 0) {
      throw new Error('Cleanup command failed');
    }
  };

  if (options.watch) {
    let cycle = 0;
    while (true) {
      cycle += 1;
      console.log(
        `[${TOOL_NAME}] Cleanup watch cycle=${cycle} (interval=${options.intervalSeconds}s, idleMinutes=${options.idleMinutes}, maxBranches=${options.maxBranches > 0 ? options.maxBranches : 'unbounded'}).`,
      );
      runCleanupCycle();
      if (options.once) {
        break;
      }
      const sleepResult = run('sleep', [String(options.intervalSeconds)], { cwd: repoRoot });
      if (sleepResult.status !== 0) {
        throw new Error(`Cleanup watch sleep failed (interval=${options.intervalSeconds}s)`);
      }
    }
    process.exitCode = 0;
    return;
  }

  runCleanupCycle();
  process.exitCode = 0;
}

/**
 * Dispatch to the `branchMerge` package asset with options parsed from
 * `rawArgs`. Pipes stdout/stderr through to the parent process.
 *
 * @param {ReadonlyArray<string>} rawArgs CLI argv slice for the merge command.
 * @returns {void}
 * @throws {Error} When the merge subprocess exits non-zero.
 */
function merge(rawArgs) {
  const options = parseMergeArgs(rawArgs);
  const repoRoot = resolveRepoRoot(options.target);

  const args = [];
  if (options.base) {
    args.push('--base', options.base);
  }
  if (options.into) {
    args.push('--into', options.into);
  }
  if (options.task) {
    args.push('--task', options.task);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  for (const branch of options.branches) {
    args.push('--branch', branch);
  }

  const mergeResult = runPackageAsset('branchMerge', args, { cwd: repoRoot, stdio: 'pipe' });
  if (mergeResult.stdout) {
    process.stdout.write(mergeResult.stdout);
  }
  if (mergeResult.stderr) {
    process.stderr.write(mergeResult.stderr);
  }
  if (mergeResult.status !== 0) {
    throw new Error(`merge command failed with status ${mergeResult.status}`);
  }

  process.exitCode = 0;
}

/**
 * Drive the finish flow across one or many agent branches: discover
 * candidates, auto-commit dirty worktrees, optionally advance submodules,
 * and invoke `agent-branch-finish` for each branch. Aggregates per-branch
 * outcomes and prints a single summary line at the end.
 *
 * @param {ReadonlyArray<string>} rawArgs CLI argv slice for the finish command.
 * @param {Partial<FinishOptions>} [defaults] Defaults merged before CLI overrides.
 * @returns {void}
 * @throws {Error} When `--branch` references an unknown ref, or when any branch fails to finish (after the loop completes).
 */
/**
 * Decide whether a finish run should sweep merged-but-stranded worktree dirs
 * after the per-lane loop. Only for bulk `--all`, never on a dry run, only when
 * every lane succeeded (failed === 0), and honoring the --no-sweep-orphans
 * opt-out. Pure so the guard can be tested without the gh/PR finish flow.
 *
 * @param {{all?: boolean, sweepOrphans?: boolean, dryRun?: boolean}} options
 * @param {number} failed Count of lanes that failed to finish.
 * @returns {boolean}
 */
function shouldSweepOrphans(options, failed) {
  return Boolean(options.all && options.sweepOrphans && !options.dryRun && failed === 0);
}

function finish(rawArgs, defaults = {}) {
  const activeCwd = process.cwd();
  const options = parseFinishArgs(rawArgs, defaults);
  if (options.gateReview && options.mergeMode !== 'pr') {
    throw new Error('--gate-review requires a PR finish; direct/local modes are incompatible.');
  }
  const repoRoot = resolveRepoRoot(options.target);

  const worktreeEntries = listAgentWorktrees(repoRoot);
  const worktreeByBranch = new Map(worktreeEntries.map((entry) => [entry.branch, entry.worktreePath]));

  let candidateBranches = [];
  if (options.branch) {
    if (!branchExists(repoRoot, options.branch)) {
      throw new Error(`Local branch not found: ${options.branch}`);
    }
    candidateBranches = [options.branch];
  } else {
    candidateBranches = uniquePreserveOrder([
      ...listLocalAgentBranchesForFinish(repoRoot),
      ...worktreeEntries.map((entry) => entry.branch),
    ]);
  }

  const candidates = [];
  for (const branch of candidateBranches) {
    const worktreePath = worktreeByBranch.get(branch) || '';
    const baseBranch = resolveFinishBaseBranch(repoRoot, branch, options.base);
    const hasChanges = worktreePath ? worktreeHasLocalChanges(worktreePath) : false;
    const alreadyMerged = branchMergedIntoBase(repoRoot, branch, baseBranch);
    if (options.all || options.branch || hasChanges || !alreadyMerged) {
      candidates.push({
        branch,
        baseBranch,
        worktreePath,
        hasChanges,
        alreadyMerged,
      });
    }
  }

  if (candidates.length === 0) {
    console.log(`[${TOOL_NAME}] No pending agent branches to finish.`);
    process.exitCode = 0;
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let autoCommitted = 0;
  const terse = isTerseMode() || options.agentQuiet;

  for (const candidate of candidates) {
    const { branch, baseBranch, worktreePath } = candidate;
    const progress = createFinishProgress({
      repoRoot,
      branch,
      baseBranch,
      persistEvents: !options.dryRun,
      quiet: options.agentQuiet,
    });
    // In terse mode, defer the "Finishing X -> Y" line until we know whether
    // we also need to announce an auto-commit, then emit a single combined
    // line per branch. Keep branch + base + worktree path so agents still see
    // the load-bearing literals.
    if (!terse) {
      console.log(
        `[${TOOL_NAME}] Finishing '${branch}' -> '${baseBranch}'${worktreePath ? ` (${worktreePath})` : ''}...`,
      );
    }

    try {
      progress.start('prepare', worktreePath ? 'checking worktree and pending changes' : 'checking branch');
      let commitState = { changed: false, committed: false };
      if (worktreePath) {
        commitState = autoCommitWorktreeForFinish(repoRoot, worktreePath, branch, options);
      }

      if (terse) {
        const suffix = commitState.committed
          ? ' [auto-committed]'
          : (commitState.changed && commitState.dryRun ? ' [dry-run: would auto-commit]' : '');
        if (!options.agentQuiet) {
          console.log(
            `[${TOOL_NAME}] Finishing '${branch}' -> '${baseBranch}'${worktreePath ? ` (${worktreePath})` : ''}${suffix}`,
          );
        }
        if (commitState.committed) {
          autoCommitted += 1;
        }
      } else if (commitState.committed) {
        autoCommitted += 1;
        console.log(`[${TOOL_NAME}] Auto-committed '${branch}' before finish.`);
      } else if (commitState.changed && commitState.dryRun) {
        console.log(`[${TOOL_NAME}] [dry-run] Would auto-commit pending changes on '${branch}'.`);
      }
      progress.complete(
        'prepare',
        commitState.committed
          ? 'pending changes auto-committed'
          : (commitState.changed && commitState.dryRun ? 'would auto-commit pending changes' : 'branch ready'),
      );

      if (options.advanceSubmodules && worktreePath) {
        const gitmodulesPath = path.join(worktreePath, '.gitmodules');
        if (fs.existsSync(gitmodulesPath)) {
          if (options.dryRun) {
            const preview = submoduleModule.advance({
              target: worktreePath,
              push: false,
              commit: false,
              dryRun: true,
            });
            console.log(`[${TOOL_NAME}] [dry-run] Would advance submodules for '${branch}':`);
            submoduleModule.printAdvanceResult(preview);
          } else {
            const advanceResult = submoduleModule.advance({
              target: worktreePath,
              push: false,
              commit: true,
              dryRun: false,
            });
            submoduleModule.printAdvanceResult(advanceResult);
          }
        } else {
          console.log(`[${TOOL_NAME}] --advance-submodules ignored: '${branch}' has no .gitmodules.`);
        }
      }

      const finishArgs = [
        '--branch',
        branch,
        '--base',
        baseBranch,
        options.waitForMerge ? '--wait-for-merge' : '--no-wait-for-merge',
        options.cleanup ? '--cleanup' : '--no-cleanup',
      ];
      if (options.mergeMode === 'pr') {
        finishArgs.push('--via-pr');
      } else if (options.mergeMode === 'direct') {
        finishArgs.push('--direct-only');
      } else {
        finishArgs.push('--mode', 'auto');
      }
      if (options.keepRemote) {
        finishArgs.push('--keep-remote-branch');
      }
      finishArgs.push(options.parentGitlinkCommit ? '--parent-gitlink-commit' : '--no-parent-gitlink-commit');

      if (options.dryRun) {
        progress.skip('preflight', 'dry run');
        progress.skip('pr', 'dry run');
        progress.skip('review', 'dry run');
        progress.skip('autofix', 'dry run');
        progress.skip('ci', 'dry run');
        progress.skip('merge', 'dry run');
        progress.skip('cleanup', 'dry run');
        console.log(`[${TOOL_NAME}] [dry-run] Would run: gx branch finish ${finishArgs.join(' ')}`);
        succeeded += 1;
        continue;
      }

      // Preflight: typecheck + lint touched workspace packages before opening
      // a PR. Only enforced for PR-mode finishes; bypass with --skip-preflight.
      if (options.mergeMode === 'pr' && !options.skipPreflight) {
        progress.start('preflight', 'running targeted local verification');
        const preflight = runPreflight(repoRoot, worktreePath, branch, baseBranch, {
          verbose: !terse,
        });
        if (!options.agentQuiet) console.log(`[${TOOL_NAME}] ${summarizePreflight(preflight)}`);
        if (preflight.status === 'failed') {
          progress.fail('preflight', `${preflight.failures.length} script(s) failed`);
          for (const f of preflight.failures) {
            console.error(`[${TOOL_NAME}] preflight failure: ${f.label} (exit ${f.status})`);
            if (f.stderr && f.stderr.trim()) {
              console.error(f.stderr.trim());
            } else if (f.stdout && f.stdout.trim()) {
              console.error(f.stdout.trim());
            }
          }
          throw new Error(
            `preflight failed for ${preflight.failures.length} script(s). Fix the failures or rerun with --skip-preflight to bypass.`,
          );
        }
        progress.complete('preflight', preflight.status);
      } else {
        progress.skip(
          'preflight',
          options.skipPreflight ? 'disabled by flag' : 'not a PR finish',
        );
      }

      // Opt-in merge gate (--gate-review / gx ship): enforce a clean AI review +
      // green CI + GitHub-mergeable verdict BEFORE the shell merge runs. Throws on
      // failure, which the catch below turns into a finish failure (no merge).
      let gateResult;
      if (options.mergeMode === 'pr' && options.gateReview) {
        gateResult = runReviewGate({
          repoRoot, worktreePath, branch, baseBranch, options, progress,
        });
      } else {
        progress.skip('review', 'review gate disabled');
        progress.skip('autofix', 'review gate disabled');
        progress.skip('ci', 'review gate disabled; repository policy controls merge readiness');
      }

      if (shouldSkipBranchPreflight(options)) {
        finishArgs.push('--no-preflight');
      }

      // Streamed, not piped: the script can sit for minutes waiting on the PR
      // merge, and buffering means the operator sees nothing until it exits —
      // and sees NOTHING AT ALL if the process is killed while waiting, since
      // the buffer dies with it. Streaming cannot interleave two branches'
      // output, because lanes run sequentially here.
      //
      // The exception is `gx agents finish --json`, which reads this script's
      // output through a process.stdout.write patch to recover the merged-PR
      // URL — a child on 'inherit' writes past that patch. assetStdio owns that
      // decision for every caller, so this path and invokePackageAsset cannot
      // drift apart.
      const finishResult = runPackageAsset('branchFinish', finishArgs, {
        cwd: repoRoot,
        stdio: options.agentQuiet ? 'pipe' : assetStdio('branchFinish'),
        env: {
          GUARDEX_FINISH_ACTIVE_CWD: activeCwd,
          GUARDEX_FINISH_CHECKLIST: '1',
          GUARDEX_FINISH_GATE_DONE: options.gateReview ? '1' : '0',
          GUARDEX_FINISH_REVIEWED_HEAD: gateResult?.reviewedHeadSha || '',
          GUARDEX_FINISH_REVIEWED_BASE: gateResult?.reviewedBaseSha || '',
          GUARDEX_FINISH_REQUIRE_PREFLIGHT: gateResult?.billingChecksWaived?.length > 0 ? '1' : '0',
          ...progress.eventEnv,
        },
      });
      if (options.agentQuiet) {
        const summary = summarizeFinishRun({
          eventFile: progress.eventEnv.GUARDEX_FINISH_EVENT_FILE,
          branch,
          baseBranch,
          stdout: finishResult.stdout,
          stderr: finishResult.stderr,
          status: finishResult.status,
        });
        process.stdout.write(`[gx:finish] ${JSON.stringify(summary)}\n`);
      } else {
        // Null under 'inherit'; kept so an explicit pipe still prints.
        if (finishResult.stdout) process.stdout.write(finishResult.stdout);
        if (finishResult.stderr) process.stderr.write(finishResult.stderr);
      }
      if (finishResult.status !== 0) {
        throw new Error(`agent-branch-finish exited with status ${finishResult.status}`);
      }

      succeeded += 1;
    } catch (error) {
      failed += 1;
      console.error(`[${TOOL_NAME}] Finish failed for '${branch}': ${error.message}`);
      if (options.failFast) {
        break;
      }
    }
  }

  if (options.agentQuiet) {
    process.stdout.write(`[gx:finish] ${JSON.stringify({
      total: candidates.length,
      success: succeeded,
      failed,
      autoCommitted,
    })}\n`);
  } else {
    console.log(
      `[${TOOL_NAME}] Finish summary: total=${candidates.length}, success=${succeeded}, failed=${failed}, autoCommitted=${autoCommitted}`,
    );
  }

  // Bulk `--all` finish self-cleans: sweep merged-but-stranded worktree dirs
  // whose branch was merged out-of-band and never reaped (the post-merge
  // "retained for now" gap in agent-branch-finish.sh). Only when every lane
  // succeeded, never on a dry run, and opt-out via --no-sweep-orphans. The
  // sweep is best-effort: a failure warns but does not fail the finish.
  if (shouldSweepOrphans(options, failed)) {
    const baseForSweep = options.base || candidates[0].baseBranch;
    const sweepArgs = ['--include-pr-merged', '--delete-branches'];
    if (baseForSweep) {
      sweepArgs.push('--base', baseForSweep);
    }
    if (!options.agentQuiet) console.log(`[${TOOL_NAME}] Sweeping merged-but-stranded worktrees...`);
    const sweep = runPackageAsset('worktreePrune', sweepArgs, {
      cwd: repoRoot,
      stdio: options.agentQuiet ? 'pipe' : 'inherit',
      env: { GUARDEX_PRUNE_ACTIVE_CWD: activeCwd },
    });
    if (sweep.status !== 0) {
      console.error(`[${TOOL_NAME}] Warning: orphan sweep failed (non-fatal).`);
    }
  }

  if (failed > 0) {
    throw new Error('finish command failed for one or more agent branches');
  }

  process.exitCode = 0;
}

/**
 * Sync the current (or all) agent branches against the configured base
 * branch using either rebase or merge. Supports `--check`, `--dry-run`,
 * `--json`, and `--all-agent-branches` modes. Temporarily resets the lock
 * registry around the sync operation when it is dirty so it does not block
 * the rebase/merge, then restores the saved contents.
 *
 * @param {ReadonlyArray<string>} rawArgs CLI argv slice for the sync command.
 * @returns {void}
 * @throws {Error} When the working tree is dirty (without `--allow-dirty`), the lock reset fails, or the underlying rebase/merge fails.
 */
function sync(rawArgs) {
  const options = parseSyncArgs(rawArgs);
  const repoRoot = resolveRepoRoot(options.target);
  const baseBranch = resolveBaseBranch(repoRoot, options.base);
  const strategy = resolveSyncStrategy(repoRoot, options.strategy);
  const baseRef = `origin/${baseBranch}`;

  ensureOriginBaseRef(repoRoot, baseBranch);

  if (options.allAgentBranches) {
    const refs = gitRun(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent/*'], { allowFailure: true });
    if (refs.status !== 0) {
      throw new Error('Unable to list local agent branches');
    }
    const branches = (refs.stdout || '').split('\n').map((item) => item.trim()).filter(Boolean);
    const rows = branches.map((branch) => {
      const counts = aheadBehind(repoRoot, branch, baseRef);
      return {
        branch,
        base: baseRef,
        ahead: counts.ahead,
        behind: counts.behind,
        syncRequired: counts.behind > 0,
      };
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify({
        repoRoot,
        base: baseRef,
        branchCount: rows.length,
        rows,
      }, null, 2)}\n`);
    } else {
      console.log(`[${TOOL_NAME}] Sync report target: ${repoRoot}`);
      console.log(`[${TOOL_NAME}] Base: ${baseRef}`);
      if (rows.length === 0) {
        console.log(`[${TOOL_NAME}] No local agent branches found.`);
      } else {
        for (const row of rows) {
          console.log(`  - ${row.branch} | ahead ${row.ahead} | behind ${row.behind} | syncRequired=${row.syncRequired}`);
        }
      }
    }

    const hasBehind = rows.some((row) => row.behind > 0);
    process.exitCode = options.check && hasBehind ? 1 : 0;
    return;
  }

  const branch = currentBranchName(repoRoot);
  if (!options.allowNonAgent && !branch.startsWith('agent/')) {
    throw new Error(`sync is limited to agent/* branches by default (current: ${branch}). Use --allow-non-agent to override.`);
  }

  const dirty = workingTreeIsDirty(repoRoot);
  if (!options.check && !options.allowDirty && dirty) {
    throw new Error('Sync blocked: working tree is not clean. Commit or stash changes first, or pass --allow-dirty.');
  }

  const before = aheadBehind(repoRoot, branch, baseRef);

  const payload = {
    repoRoot,
    branch,
    base: baseRef,
    strategy,
    dirty,
    aheadBefore: before.ahead,
    behindBefore: before.behind,
    syncRequired: before.behind > 0,
    status: 'checked',
  };

  if (options.check) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log(`[${TOOL_NAME}] Sync check target: ${repoRoot}`);
      console.log(`[${TOOL_NAME}] Branch: ${branch}`);
      console.log(`[${TOOL_NAME}] Base: ${baseRef}`);
      console.log(`[${TOOL_NAME}] Ahead: ${before.ahead}`);
      console.log(`[${TOOL_NAME}] Behind: ${before.behind}`);
      console.log(`[${TOOL_NAME}] Sync required: ${before.behind > 0 ? 'yes' : 'no'}`);
    }
    process.exitCode = before.behind > 0 ? 1 : 0;
    return;
  }

  if (before.behind === 0) {
    const result = { ...payload, status: 'no-op', aheadAfter: before.ahead, behindAfter: before.behind };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`[${TOOL_NAME}] Branch '${branch}' is already up to date with ${baseRef}.`);
    }
    process.exitCode = 0;
    return;
  }

  if (options.dryRun) {
    const result = { ...payload, status: 'dry-run' };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(`[${TOOL_NAME}] Dry run: would sync '${branch}' onto ${baseRef} via ${strategy}.`);
    }
    process.exitCode = 0;
    return;
  }

  const lockPath = path.join(repoRoot, LOCK_FILE_RELATIVE);
  const lockState = lockRegistryStatus(repoRoot);
  let lockBackup = null;
  if (lockState.dirty && fs.existsSync(lockPath)) {
    lockBackup = fs.readFileSync(lockPath, 'utf8');
  }

  if (lockState.dirty) {
    if (lockState.untracked) {
      fs.rmSync(lockPath, { force: true });
    } else {
      const resetLock = gitRun(repoRoot, ['checkout', '--', LOCK_FILE_RELATIVE], { allowFailure: true });
      if (resetLock.status !== 0) {
        throw new Error(`Unable to temporarily reset ${LOCK_FILE_RELATIVE} before sync`);
      }
    }
  }

  try {
    syncOperation(repoRoot, strategy, baseRef, options.ffOnly);
  } finally {
    if (lockBackup !== null) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, lockBackup, 'utf8');
    }
  }
  const after = aheadBehind(repoRoot, branch, baseRef);
  const result = {
    ...payload,
    status: 'success',
    aheadAfter: after.ahead,
    behindAfter: after.behind,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    console.log(`[${TOOL_NAME}] Sync target: ${repoRoot}`);
    console.log(`[${TOOL_NAME}] Branch: ${branch}`);
    console.log(`[${TOOL_NAME}] Base: ${baseRef}`);
    console.log(`[${TOOL_NAME}] Strategy: ${strategy}`);
    console.log(`[${TOOL_NAME}] Behind before sync: ${before.behind}`);
    console.log(`[${TOOL_NAME}] Result: success (behind now: ${after.behind})`);
  }

  process.exitCode = 0;
}

module.exports = {
  cleanup,
  merge,
  finish,
  sync,
  autoCommitWorktreeForFinish,
  shouldSweepOrphans,
  shouldSkipBranchPreflight,
};
