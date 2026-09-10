// `gx branch finish --gate-review` must enforce the merge gate.
//
// Regression cover for the routing gap that let PR #298 (lifted.sk-storefront)
// merge with its `review` check skipped: `gx branch finish` passed argv straight
// to agent-branch-finish.sh, which (a) exits 1 on the unknown `--gate-review`
// argument and (b) merges as soon as the PR opens. Only `gx ship` / `gx finish`
// ran runReviewGate. These tests pin the flag handling and the fail-closed path.
//
// The command's collaborators are stubbed through the require cache before
// branch.js binds its destructured imports. `node --test` runs each test file in
// its own process, so the cache surgery cannot leak into other suites.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function loadBranchWithStubs({ gateThrows = false, gateResult } = {}) {
  const calls = {
    finish: [],
    gate: [],
    script: [],
    repoResolution: [],
    autoCommit: [],
  };

  const stub = (relPath, exports) => {
    const resolved = require.resolve(path.join(repoRoot, relPath));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  };

  // Mirrors the real resolveFinishBaseBranch: explicit --base wins, otherwise the
  // per-branch `branch.<name>.guardexBase`, otherwise the repo default.
  const perBranchBase = { 'agent/claude/on-dev': 'dev' };
  stub('src/git/index.js', {
    resolveRepoRoot: () => {
      calls.repoResolution.push('root');
      return '/fake/repo';
    },
    resolveFinishBaseBranch: (_root, branch, base) => base || perBranchBase[branch] || 'main',
    currentBranchName: () => {
      calls.repoResolution.push('branch');
      return 'agent/claude/from-head';
    },
    listAgentWorktrees: () => {
      calls.repoResolution.push('worktrees');
      return [];
    },
  });
  stub('src/core/runtime.js', {
    run: () => {},
    extractTargetedArgs: (args) => ({ target: undefined, passthrough: args }),
    runPackageAsset: (asset, args, options) => {
      calls.script.push({ asset, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    invokePackageAsset: (asset, args, options) => calls.script.push({ asset, args, options }),
  });
  stub('src/finish/review-gate.js', {
    runReviewGate: (opts) => {
      calls.gate.push(opts);
      if (gateThrows) throw new Error('AI review found a CRITICAL finding');
      return gateResult;
    },
  });
  stub('src/finish/index.js', {
    autoCommitWorktreeForFinish: (...args) => {
      calls.autoCommit.push(args);
      return { changed: false, committed: false };
    },
  });
  stub('src/cli/commands/finish.js', {
    finish: (args) => calls.finish.push(args),
    merge: () => {},
  });

  delete require.cache[require.resolve(path.join(repoRoot, 'src/cli/commands/branch.js'))];
  const { branch, ship } = require(path.join(repoRoot, 'src/cli/commands/branch.js'));
  return { branch, ship, calls };
}

test('branch finish --help prints usage before resolving or mutating the repository', () => {
  const { branch, calls } = loadBranchWithStubs();
  const output = [];
  const originalLog = console.log;
  console.log = (...args) => output.push(args.join(' '));

  try {
    branch(['finish', '--help']);
  } finally {
    console.log = originalLog;
  }

  assert.match(output.join('\n'), /USAGE:\s+gx branch finish \[options\]/);
  assert.deepEqual(calls.repoResolution, [], 'help must return before repository discovery');
  assert.deepEqual(calls.autoCommit, [], 'help must never auto-commit pending work');
  assert.deepEqual(calls.gate, [], 'help must never start review');
  assert.deepEqual(calls.script, [], 'help must never invoke the finish shell script');
});

test('branch finish --gate-review runs the gate and keeps the flag out of the shell argv', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/x', '--base', 'dev', '--via-pr', '--gate-review', '--auto-resolve=safe']);

  assert.equal(calls.gate.length, 1, 'gate should run exactly once');
  assert.equal(calls.gate[0].branch, 'agent/claude/x');
  assert.equal(calls.gate[0].baseBranch, 'dev');

  const argv = calls.script[0].args;
  assert.ok(!argv.includes('--gate-review'), 'agent-branch-finish.sh cannot parse --gate-review');
  assert.ok(argv.includes('--auto-resolve=safe'), 'unrelated flags must still reach the script');
  assert.deepEqual(argv, ['--branch', 'agent/claude/x', '--base', 'dev', '--via-pr', '--auto-resolve=safe']);
});

test('branch finish requires repository preflight when GitHub billing checks were waived', () => {
  const { branch, calls } = loadBranchWithStubs({
    gateResult: { prNumber: 42, billingChecksWaived: ['build'] },
  });

  branch(['finish', '--branch', 'agent/claude/x', '--base', 'main', '--via-pr', '--gate-review']);

  assert.equal(calls.script[0].options.env.GUARDEX_FINISH_REQUIRE_PREFLIGHT, '1');
});

test('branch finish forwards the exact reviewed revision to the shell', () => {
  const { branch, calls } = loadBranchWithStubs({
    gateResult: { prNumber: 42, reviewedHeadSha: 'head', reviewedBaseSha: 'base' },
  });
  branch(['finish', '--branch', 'agent/claude/x', '--base', 'main', '--via-pr', '--gate-review']);
  assert.equal(calls.script[0].options.env.GUARDEX_FINISH_REVIEWED_HEAD, 'head');
  assert.equal(calls.script[0].options.env.GUARDEX_FINISH_REVIEWED_BASE, 'base');
});

test('bare --gate-review selects PR mode, and direct/local modes fail before review', () => {
  const { branch, calls } = loadBranchWithStubs();
  branch(['finish', '--gate-review']);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
  for (const flags of [['--no-push'], ['--direct-only'], ['--mode', 'auto'], ['--mode=direct']]) {
    const isolated = loadBranchWithStubs();
    assert.throws(() => isolated.branch(['finish', '--gate-review', ...flags]), /push-enabled PR/);
    assert.equal(isolated.calls.gate.length, 0);
    assert.equal(isolated.calls.autoCommit.length, 0);
    assert.equal(isolated.calls.script.length, 0);
  }
});

test('branch finish --gate-review fails closed: a throwing gate blocks the merge', () => {
  const { branch, calls } = loadBranchWithStubs({ gateThrows: true });

  assert.throws(
    () => branch(['finish', '--branch', 'agent/claude/y', '--base', 'main', '--via-pr', '--gate-review']),
    /CRITICAL/,
  );
  assert.equal(calls.script.length, 0, 'the shell script (and thus the merge) must never run');
});

test('branch finish --no-gate-review skips the gate and strips the opt-out flag', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/z', '--via-pr', '--no-gate-review']);

  assert.equal(calls.gate.length, 0, 'opt-out must not run the gate');
  assert.deepEqual(calls.script[0].args, ['--branch', 'agent/claude/z', '--via-pr']);
});

test('branch finish --agent-quiet captures the script and strips the gx-only flag', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/quiet', '--via-pr', '--agent-quiet']);

  assert.deepEqual(calls.script[0].args, ['--branch', 'agent/claude/quiet', '--via-pr']);
  assert.equal(calls.script[0].options.stdio, 'pipe');
});

test('branch finish --skip-review-gate is honored as an opt-out alias', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--skip-review-gate']);

  assert.equal(calls.gate.length, 0);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish --fast skips local preflight and AI review but keeps PR merge mode', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--fast']);

  assert.equal(calls.gate.length, 0, 'fast mode must not start an AI review');
  assert.deepEqual(calls.script[0].args, ['--via-pr', '--no-preflight']);
});

test('branch finish --fast rejects incompatible review and direct-merge flags', () => {
  const { branch, calls } = loadBranchWithStubs();

  for (const args of [
    ['finish', '--fast', '--gate-review'],
    ['finish', '--fast', '--gate-autofix'],
    ['finish', '--fast', '--preflight'],
    ['finish', '--fast', '--direct-only'],
  ]) {
    assert.throws(() => branch(args), /--fast cannot be combined with/);
  }
  assert.equal(calls.gate.length, 0);
  assert.equal(calls.script.length, 0);
});

test('gx ship --fast does not re-enable the AI review gate', () => {
  const { ship, calls } = loadBranchWithStubs();

  ship(['--fast']);

  assert.deepEqual(calls.finish[0], [
    '--fast',
    '--via-pr',
    '--wait-for-merge',
    '--cleanup',
  ]);
});

test('branch finish --gate-review without --branch gates the current HEAD branch', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review']);

  assert.equal(calls.gate[0].branch, 'agent/claude/from-head');
  assert.equal(calls.gate[0].baseBranch, 'main');
});

// The gate must resolve the base the same way agent-branch-finish.sh does when
// --base is omitted: via branch.<name>.guardexBase. Resolving it differently
// would review one base and merge into another.
test('branch finish --gate-review honors a per-branch base when --base is omitted', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/on-dev', '--via-pr', '--gate-review']);

  assert.equal(calls.gate[0].baseBranch, 'dev', 'gate must target the branch-configured base');
  assert.ok(!calls.script[0].args.includes('--base'), 'script re-resolves the base itself');
});

test('branch finish --gate-review reads the inline --branch=/--base= form', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch=agent/claude/inline', '--base=dev', '--via-pr', '--gate-review']);

  assert.equal(calls.gate[0].branch, 'agent/claude/inline');
  assert.equal(calls.gate[0].baseBranch, 'dev');
});

// Regression guard for every repo using `gx branch finish` without the gate:
// argv must reach the shell script byte-for-byte unchanged.
test('branch finish without any gate flag is an unchanged passthrough', () => {
  const { branch, calls } = loadBranchWithStubs();
  const argv = ['--branch', 'agent/claude/plain', '--base', 'main', '--via-pr', '--wait-for-merge', '--cleanup'];

  branch(['finish', ...argv]);

  assert.equal(calls.gate.length, 0, 'no gate without the flag');
  assert.deepEqual(calls.script[0].args, argv, 'argv must pass through untouched');
});

// `gx ship` / `gx finish` honor `--review-provider` (args.js -> finish/index.js
// passes the whole options object to the gate), but `gx branch finish` handed
// the gate a bare `options: {}`, so it always ran review-gate.js's `codex`
// default. On a machine where codex is unavailable the gate then fails closed on
// every run and the only way forward is --skip-review-gate — the gate turned off
// by the very mechanism meant to enforce it.
test('branch finish --gate-review forwards the review provider to the gate', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/p', '--via-pr', '--gate-review', '--review-provider', 'claude']);

  assert.equal(calls.gate[0].options.reviewProvider, 'claude');
  const argv = calls.script[0].args;
  assert.ok(!argv.includes('--review-provider'), 'agent-branch-finish.sh exits 1 on the unknown flag');
  assert.ok(!argv.includes('claude'), 'the provider value must not leak into the script argv either');
  assert.deepEqual(argv, ['--branch', 'agent/claude/p', '--via-pr']);
});

test('branch finish --gate-review reads the inline --review-provider= form', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--review-provider=claude']);

  assert.equal(calls.gate[0].options.reviewProvider, 'claude');
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish --gate-review forwards the review model and keeps it out of the shell argv', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/p', '--via-pr', '--gate-review', '--review-model', 'sonnet']);

  assert.equal(calls.gate[0].options.reviewModel, 'sonnet');
  assert.deepEqual(calls.script[0].args, ['--branch', 'agent/claude/p', '--via-pr']);
});

test('branch finish --gate-review forwards the review timeout and keeps it out of the shell argv', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--branch', 'agent/claude/p', '--via-pr', '--gate-review', '--review-timeout-ms', '60000']);

  assert.equal(calls.gate[0].options.reviewTimeoutMs, 60_000);
  assert.deepEqual(calls.script[0].args, ['--branch', 'agent/claude/p', '--via-pr']);
});

test('branch finish --gate-review reads the inline --review-timeout-ms= form', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--review-timeout-ms=60000']);

  assert.equal(calls.gate[0].options.reviewTimeoutMs, 60_000);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish rejects --review-timeout-ms with no value', () => {
  const { branch, calls } = loadBranchWithStubs();

  assert.throws(
    () => branch(['finish', '--via-pr', '--gate-review', '--review-timeout-ms']),
    /positive integer/,
  );
  assert.equal(calls.script.length, 0);
});

test('branch finish --gate-review reads the inline --review-model= form', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--review-model=sonnet']);

  assert.equal(calls.gate[0].options.reviewModel, 'sonnet');
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish rejects --review-model with no value', () => {
  const { branch, calls } = loadBranchWithStubs();

  assert.throws(
    () => branch(['finish', '--via-pr', '--gate-review', '--review-model']),
    /requires a model name/,
  );
  assert.equal(calls.script.length, 0);
});

test('branch finish forwards --gate-serial-ci and strips it from the shell argv', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--gate-serial-ci']);

  assert.equal(calls.gate[0].options.gateSerialCi, true);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish waits for review by default and retains the repository preflight', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review']);

  assert.equal(calls.gate[0].options.gateSerialCi, true);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish keeps --no-gate-serial-ci as an explicit fast-mode alias', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--no-gate-serial-ci']);

  assert.equal(calls.gate[0].options.gateSerialCi, false);
  assert.deepEqual(calls.script[0].args, ['--via-pr']);
});

test('branch finish preserves an explicit post-gate --preflight request', () => {
  const { branch, calls } = loadBranchWithStubs();

  branch(['finish', '--via-pr', '--gate-review', '--preflight']);

  assert.equal(calls.gate[0].options.gateSerialCi, true);
  assert.deepEqual(calls.script[0].args, ['--via-pr', '--preflight']);
});

// Fail closed on a typo rather than silently falling back to codex: a caller who
// asked for a specific provider must not get a different one.
test('branch finish rejects an unknown review provider before the script runs', () => {
  const { branch, calls } = loadBranchWithStubs();

  assert.throws(
    () => branch(['finish', '--via-pr', '--gate-review', '--review-provider', 'gpt']),
    /codex\|claude/,
  );
  assert.equal(calls.script.length, 0, 'the merge must never run on a bad provider');
});

// args.js throws when the value is missing ("--review-provider requires a value
// of codex|claude"). branch.js must match: a silent fall back to the default is
// how a caller who asked for claude ends up gated by codex without being told.
test('branch finish rejects --review-provider with no value', () => {
  const { branch, calls } = loadBranchWithStubs();

  assert.throws(
    () => branch(['finish', '--via-pr', '--gate-review', '--review-provider']),
    /codex\|claude/,
  );
  assert.equal(calls.script.length, 0);
});
