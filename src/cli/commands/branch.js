// `gx branch`, `gx pivot`, `gx ship`, `gx locks`, `gx worktree` — branch
// workflow surface. Pure code-motion from src/cli/main.js.
const {
  TOOL_NAME,
  SHORT_TOOL_NAME,
  path,
  fs,
} = require('../../context');
const {
  resolveRepoRoot,
  resolveFinishBaseBranch,
  currentBranchName,
  listAgentWorktrees,
} = require('../../git');
const {
  run,
  extractTargetedArgs,
  runPackageAsset,
  invokePackageAsset,
} = require('../../core/runtime');
const { runReviewGate } = require('../../finish/review-gate');
const { createFinishProgress, summarizeFinishRun } = require('../../finish/progress');
const { autoCommitWorktreeForFinish } = require('../../finish');
const { finish, merge } = require('./finish');
const { locks } = require('../shared-locks');

const REVIEW_PROVIDERS = ['codex', 'claude'];

function printBranchFinishHelp() {
  console.log(`USAGE: ${SHORT_TOOL_NAME} branch finish [options]

Finish an agent branch by committing pending work, publishing it, opening or
updating a PR, enforcing optional gates, merging, and cleaning up.

TARGET
  --target <path>             Target repository (default: current directory)
  --branch <branch>           Agent branch to finish (default: current branch)
  --base <branch>             Destination branch

PUBLISH AND MERGE
  --via-pr                    Finish through a pull request
  --direct-only               Finish by direct merge only
  --no-push                   Do not push the branch
  --wait-for-merge            Wait until the PR is merged
  --cleanup                   Remove the finished worktree and branch
  --keep-remote-branch        Preserve the remote branch after merge

VERIFICATION
  --gate-review               Require AI review and green CI before merge
  --gate-autofix              Repair blocking review findings and review again
  --gate-autofix-rounds <n>   Limit repair rounds to 1-5 (default: 1)
  --gate-baseline             Ignore failures already present on the base branch
  --review-provider <name>    Review provider: codex|claude
  --review-model <name>       Model used by the review provider
  --review-timeout-ms <n>     Positive review timeout in milliseconds
  --no-preflight              Skip the repository preflight script
  --preflight                 Run the repository preflight script

COMMIT
  --no-auto-commit            Refuse to auto-commit pending work
  --commit-message <message>  Message for the automatic finish commit

  -h, --help                  Show this help without touching the repository`);
}

function isBranchFinishHelpRequest(args) {
  return args.some((arg) => arg === '--help' || arg === '-h')
    || (args.length === 1 && args[0] === 'help');
}

// Review-gate and auto-commit options are gx-level flags.
// agent-branch-finish.sh does not parse them (it exits 1 on the unknown
// argument), and its --via-pr path merges the moment the PR opens, so the shell
// cannot enforce the gate itself. Pull the flags out of the script's argv and
// honor them here.
function splitGateReviewFlags(args) {
  const scriptArgs = [];
  let fastMode = false;
  let gateReview = false;
  let reviewProvider;
  let gateAutofix = false;
  let gateAutofixRounds = 1;
  let gateBaseline = false;
  let gateSerialCi = true;
  let reviewModel;
  let reviewTimeoutMs;
  let noAutoCommit = false;
  let commitMessage = '';
  let agentQuiet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--fast') {
      fastMode = true;
    } else if (arg === '--agent-quiet') {
      agentQuiet = true;
    } else if (arg === '--no-auto-commit') {
      noAutoCommit = true;
    } else if (arg === '--commit-message') {
      commitMessage = String(args[index + 1] ?? '').trim();
      if (!commitMessage || commitMessage.startsWith('-')) {
        throw new Error('--commit-message requires a value');
      }
      index += 1;
    } else if (arg === '--gate-review') {
      gateReview = true;
    } else if (arg === '--no-gate-review' || arg === '--skip-review-gate') {
      gateReview = false;
    } else if (arg === '--gate-serial-ci') {
      gateSerialCi = true;
    } else if (arg === '--no-gate-serial-ci') {
      gateSerialCi = false;
    } else if (arg === '--review-model') {
      // Consume the value for the same reason as --review-provider: a bare
      // model name left behind becomes a positional the shell script rejects.
      reviewModel = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--review-model=')) {
      reviewModel = arg.slice('--review-model='.length);
    } else if (arg === '--review-timeout-ms' || arg.startsWith('--review-timeout-ms=')) {
      // The shell script does not know this gx-level gate flag either.
      reviewTimeoutMs = arg.includes('=') ? arg.slice('--review-timeout-ms='.length) : (args[index + 1] ?? '');
      if (!arg.includes('=')) index += 1;
    } else if (arg === '--gate-baseline') {
      gateBaseline = true;
    } else if (arg === '--no-gate-baseline') {
      gateBaseline = false;
    } else if (arg === '--gate-autofix') {
      gateAutofix = true;
    } else if (arg === '--no-gate-autofix') {
      gateAutofix = false;
    } else if (arg === '--gate-autofix-rounds' || arg.startsWith('--gate-autofix-rounds=')) {
      // Consume the value too, for the same reason as --review-provider: a bare
      // number left behind becomes a positional the shell script rejects.
      let raw;
      if (arg.includes('=')) {
        raw = arg.slice('--gate-autofix-rounds='.length);
      } else {
        raw = args[index + 1];
        index += 1;
      }
      const rounds = Number.parseInt(String(raw ?? ''), 10);
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
        throw new Error('--gate-autofix-rounds requires an integer between 1 and 5');
      }
      gateAutofixRounds = rounds;
      gateAutofix = true;
    } else if (arg === '--review-provider') {
      // Consume the value too — leaving it behind would hand the script a bare
      // "claude" positional and it would exit 1. A missing value becomes "" so
      // the check below rejects it, matching args.js: falling back to the
      // default here would gate with codex a caller who asked for claude.
      reviewProvider = args[index + 1] ?? '';
      index += 1;
    } else if (arg.startsWith('--review-provider=')) {
      reviewProvider = arg.slice('--review-provider='.length);
    } else {
      scriptArgs.push(arg);
    }
  }

  if (fastMode) {
    const incompatibleFlag = args.find((arg) => [
      '--gate-review',
      '--gate-autofix',
      '--gate-autofix-rounds',
      '--preflight',
      '--direct-only',
    ].includes(arg));
    const modeIndex = args.indexOf('--mode');
    const modeValue = modeIndex >= 0 ? args[modeIndex + 1] : '';
    const incompatibleMode = modeIndex >= 0 && modeValue !== 'pr'
      ? `--mode ${modeValue || '<missing>'}`
      : '';
    const conflict = incompatibleFlag || incompatibleMode;
    if (conflict) {
      throw new Error(`--fast cannot be combined with ${conflict}`);
    }

    gateReview = false;
    gateAutofix = false;
    if (!scriptArgs.includes('--via-pr')) scriptArgs.push('--via-pr');
    if (!scriptArgs.includes('--no-preflight')) scriptArgs.push('--no-preflight');
  }

  if (reviewProvider !== undefined) {
    reviewProvider = String(reviewProvider).trim().toLowerCase();
    // Fail closed on a typo rather than silently falling back to the default: a
    // caller who named a provider must not quietly get a different one.
    if (!REVIEW_PROVIDERS.includes(reviewProvider)) {
      throw new Error(`--review-provider requires a value of ${REVIEW_PROVIDERS.join('|')}`);
    }
  }

  if (reviewModel !== undefined) {
    reviewModel = String(reviewModel).trim();
    // Same fail-closed reasoning as --review-provider: a caller who named a
    // model must not silently get the provider's default one instead.
    if (!reviewModel || reviewModel.startsWith('-')) {
      throw new Error('--review-model requires a model name (e.g. sonnet)');
    }
  }

  if (reviewTimeoutMs !== undefined) {
    reviewTimeoutMs = Number.parseInt(String(reviewTimeoutMs ?? ''), 10);
    if (!Number.isInteger(reviewTimeoutMs) || reviewTimeoutMs <= 0) {
      throw new Error('--review-timeout-ms requires a positive integer');
    }
  }

  return {
    gateReview,
    reviewProvider,
    reviewModel,
    reviewTimeoutMs,
    gateAutofix,
    gateAutofixRounds,
    gateBaseline,
    gateSerialCi,
    noAutoCommit,
    commitMessage,
    agentQuiet,
    scriptArgs,
  };
}

// Read `--flag value` or `--flag=value` out of an argv array.
function readFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index >= 0 && index + 1 < args.length) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : undefined;
}

function isLinkedAgentWorktree(worktreePath) {
  try {
    return fs.statSync(path.join(worktreePath, '.git')).isFile();
  } catch {
    return false;
  }
}

function isReadOnlyBranchStart(args) {
  return args.some((arg) => ['--help', '-h', 'help', '--print-name-only'].includes(arg));
}

function recoverStaleManagedWorktrees(repoRoot) {
  const idleMinutes = process.env.GUARDEX_BRANCH_START_CLEANUP_IDLE_MINUTES || '15';
  const result = runPackageAsset(
    'worktreePrune',
    [
      '--prune-stale-lanes',
      '--preserve-open-prs',
      '--delete-branches',
      '--idle-minutes',
      idleMinutes,
    ],
    {
      cwd: repoRoot,
      timeout: 30_000,
      env: { GUARDEX_PRUNE_ACTIVE_CWD: process.cwd() },
    },
  );

  if (result.status !== 0) {
    process.stderr.write(
      `[${TOOL_NAME} branch start] Stale worktree recovery failed safely; continuing without cleanup.\n`,
    );
    return;
  }

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const removedWorktrees = Number(output.match(/removed_worktrees=(\d+)/)?.[1] || 0);
  if (removedWorktrees > 0) {
    const suffix = removedWorktrees === 1 ? '' : 's';
    process.stdout.write(
      `[${TOOL_NAME} branch start] Recovered ${removedWorktrees} stale managed worktree${suffix} before branch start.\n`,
    );
  }
}

function branch(rawArgs) {
  const activeCwd = process.cwd();
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === 'start') {
    const { target, passthrough } = extractTargetedArgs(rest);
    const repoRoot = resolveRepoRoot(target);
    if (!isReadOnlyBranchStart(passthrough)) recoverStaleManagedWorktrees(repoRoot);
    invokePackageAsset('branchStart', passthrough, { cwd: repoRoot });
    return;
  }
  if (subcommand === 'finish') {
    // Help is a read-only control path. Handle it before target resolution,
    // worktree discovery, progress initialization, or the automatic commit.
    if (isBranchFinishHelpRequest(rest)) {
      printBranchFinishHelp();
      process.exitCode = 0;
      return;
    }
    const { target, passthrough } = extractTargetedArgs(rest);
    const repoRoot = resolveRepoRoot(target);
    const {
      gateReview,
      reviewProvider,
      reviewModel,
      reviewTimeoutMs,
      gateAutofix,
      gateAutofixRounds,
      gateBaseline,
      gateSerialCi,
      noAutoCommit,
      commitMessage,
      agentQuiet,
      scriptArgs,
    } = splitGateReviewFlags(passthrough);
    const finishBranch = readFlagValue(scriptArgs, '--branch') || currentBranchName(repoRoot);
    const finishBase = resolveFinishBaseBranch(repoRoot, finishBranch, readFlagValue(scriptArgs, '--base'));
    const finishWorktree = listAgentWorktrees(repoRoot)
      .find((entry) => entry.branch === finishBranch)?.worktreePath || '';
    // Keep the legacy behavior for agent branches checked out directly in the
    // primary repository. Guardex-managed lanes are linked worktrees; limiting
    // auto-commit to those avoids scooping primary-checkout runtime artifacts
    // into an otherwise already-committed branch.
    const autoCommitWorktree = finishWorktree && isLinkedAgentWorktree(finishWorktree)
      ? finishWorktree
      : '';
    const progress = createFinishProgress({
      repoRoot,
      branch: finishBranch,
      baseBranch: finishBase,
      quiet: agentQuiet,
    });
    progress.start(
      'prepare',
      autoCommitWorktree ? 'checking worktree and pending changes' : 'resolving branch and finish policy',
    );
    const commitState = autoCommitWorktree
      ? autoCommitWorktreeForFinish(repoRoot, autoCommitWorktree, finishBranch, { noAutoCommit, commitMessage })
      : { changed: false, committed: false };
    if (commitState.committed && !agentQuiet) {
      console.log(`[${TOOL_NAME}] Auto-committed '${finishBranch}' before finish.`);
    }
    progress.complete(
      'prepare',
      commitState.committed ? 'pending changes auto-committed' : 'branch and base resolved',
    );
    // Fail-closed: runReviewGate throws on a dirty review, red CI, or a PR
    // GitHub will not merge. Throwing here means the script never runs, so
    // the merge never happens.
    let gateResult;
    if (gateReview) {
      gateResult = runReviewGate({
        repoRoot,
        branch: finishBranch,
        // Must match how the shell resolves --base when it is omitted, which
        // honors branch.<name>.guardexBase. Resolving differently would gate one
        // base and merge into another.
        baseBranch: finishBase,
        // review-gate.js falls back to its own default when this is undefined,
        // which keeps a bare --gate-review behaving exactly as before.
        options: {
          reviewProvider,
          reviewModel,
          reviewTimeoutMs,
          gateAutofix,
          gateAutofixRounds,
          gateBaseline,
          gateSerialCi,
        },
        progress,
      });
    } else {
      progress.skip('review', 'review gate disabled');
      progress.skip('autofix', 'review gate disabled');
      progress.skip('ci', 'review gate disabled; repository policy controls merge readiness');
    }
    const assetOptions = {
      cwd: repoRoot,
      env: {
        GUARDEX_FINISH_ACTIVE_CWD: activeCwd,
        GUARDEX_FINISH_CHECKLIST: '1',
        GUARDEX_FINISH_GATE_DONE: gateReview ? '1' : '0',
        GUARDEX_FINISH_REVIEWED_HEAD: gateResult?.reviewedHeadSha || '',
        GUARDEX_FINISH_REVIEWED_BASE: gateResult?.reviewedBaseSha || '',
        GUARDEX_FINISH_REQUIRE_PREFLIGHT: gateResult?.billingChecksWaived?.length > 0 ? '1' : '0',
        ...progress.eventEnv,
      },
    };
    if (agentQuiet) {
      const result = runPackageAsset('branchFinish', scriptArgs, { ...assetOptions, stdio: 'pipe' });
      const summary = summarizeFinishRun({
        eventFile: progress.eventEnv.GUARDEX_FINISH_EVENT_FILE,
        branch: finishBranch,
        baseBranch: finishBase,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
      });
      process.stdout.write(`[gx:finish] ${JSON.stringify(summary)}\n`);
      if (result.status !== 0) {
        throw new Error(`branchFinish command failed with status ${result.status}`);
      }
    } else {
      invokePackageAsset('branchFinish', scriptArgs, assetOptions);
    }
    return;
  }
  if (subcommand === 'merge') return merge(rest);
  throw new Error(
    `Usage: ${SHORT_TOOL_NAME} branch <start|finish|merge> [options] ` +
    `(examples: '${SHORT_TOOL_NAME} branch start "<task>" "<agent>"', '${SHORT_TOOL_NAME} branch finish --branch <agent/...>')`,
  );
}

// `gx pivot` — single-tool-call escape from a protected branch into an isolated
// agent worktree. AI agents (Claude Code / Codex) cannot set the bypass env
// vars from inside a tool call, so they need a whitelisted command that does
// the whole hop: branch+worktree creation, dirty-tree migration, and a clean
// trailer (`WORKTREE_PATH=...`, `BRANCH=...`, `NEXT_STEP=cd ...`) the agent can
// parse to know exactly where to `cd`.
//
// On an existing agent/* branch, `gx pivot` short-circuits and just prints the
// current worktree path — safe to call as a no-op.
function pivot(rawArgs) {
  const { target, passthrough } = extractTargetedArgs(rawArgs);
  const repoRoot = resolveRepoRoot(target);
  const headProc = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const currentBranch = String(headProc.stdout || '').trim();
  if (currentBranch.startsWith('agent/')) {
    const wtProc = run('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot });
    const wtPath = String(wtProc.stdout || '').trim() || repoRoot;
    process.stdout.write(`[${TOOL_NAME} pivot] Already on agent branch '${currentBranch}'.\n`);
    process.stdout.write(`WORKTREE_PATH=${wtPath}\n`);
    process.stdout.write(`BRANCH=${currentBranch}\n`);
    process.stdout.write(`NEXT_STEP=cd "${wtPath}"\n`);
    process.exitCode = 0;
    return;
  }
  const result = runPackageAsset('branchStart', passthrough, { cwd: repoRoot });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    return;
  }
  const stdoutText = String(result.stdout || '');
  const wtMatch = stdoutText.match(/^\[agent-branch-start\] Worktree:\s+(.+)$/m);
  const branchMatch = stdoutText.match(/^\[agent-branch-start\] (?:Created branch|Reusing existing branch):\s+(.+)$/m);
  if (wtMatch) {
    const wtPath = wtMatch[1].trim();
    process.stdout.write('\n');
    process.stdout.write(`WORKTREE_PATH=${wtPath}\n`);
    if (branchMatch) process.stdout.write(`BRANCH=${branchMatch[1].trim()}\n`);
    process.stdout.write(`NEXT_STEP=cd "${wtPath}"\n`);
  }
  process.exitCode = 0;
}

// `gx ship` — alias for the canonical "I am done" command. Defaults to
// `finish --via-pr --wait-for-merge --cleanup` so AI agents don't strand
// commits or worktrees by accident. Any explicit user-supplied flags survive.
function ship(rawArgs) {
  const args = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  const ensureFlag = (flag) => {
    if (!args.includes(flag)) args.push(flag);
  };
  ensureFlag('--via-pr');
  ensureFlag('--wait-for-merge');
  ensureFlag('--cleanup');
  // `gx ship` enforces the merge gate (clean review + green CI) by default;
  // an explicit --no-gate-review / --skip-review-gate opts back out.
  if (
    !args.includes('--fast')
    && !args.includes('--no-gate-review')
    && !args.includes('--skip-review-gate')
  ) {
    ensureFlag('--gate-review');
  }
  return finish(args);
}

function worktree(rawArgs) {
  const activeCwd = process.cwd();
  const [subcommand, ...rest] = rawArgs;
  if (subcommand === 'prune') {
    const { target, passthrough } = extractTargetedArgs(rest);
    invokePackageAsset('worktreePrune', passthrough, {
      cwd: resolveRepoRoot(target),
      env: { GUARDEX_PRUNE_ACTIVE_CWD: process.env.GUARDEX_PRUNE_ACTIVE_CWD || activeCwd },
    });
    return;
  }
  throw new Error(`Usage: ${SHORT_TOOL_NAME} worktree prune [cleanup-options]`);
}

module.exports = {
  branch,
  pivot,
  ship,
  locks,
  worktree,
};
