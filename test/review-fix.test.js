const {
  test,
  assert,
  fs,
  path,
  initRepo,
  seedCommit,
} = require('./helpers/install-test-helpers');
const cp = require('node:child_process');
const { runReviewFix, commandForFix, fixPrompt } = require('../src/review-fix');
const { runReviewGate } = require('../src/finish/review-gate');
const { codexReviewEffort } = require('../src/provider-binary');

const FINDING = {
  path: 'src/a.js', startLine: 0, line: 3, severity: 'high', category: '', message: 'unsafe', suggestion: 'const safe = true',
};

function git(repoDir, args) {
  return cp.spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
}

/** Fixture repos carry guardex's own primary-branch guard, which reverts the switch. */
function onAgentBranch() {
  const repoDir = initRepo();
  seedCommit(repoDir);
  cp.spawnSync('git', ['-C', repoDir, 'checkout', '-b', 'agent/test/fix'], {
    encoding: 'utf8',
    env: { ...process.env, GUARDEX_ALLOW_PRIMARY_BRANCH_SWITCH: '1' },
  });
  return repoDir;
}

test('commandForFix gives each provider a write-enabled invocation', () => {
  assert.deepEqual(commandForFix('codex', 'p', { effort: 'high' }), {
    cmd: 'codex',
    args: [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-c', 'model_reasoning_effort="high"',
      '--sandbox', 'workspace-write', 'p',
    ],
  });
  assert.deepEqual(commandForFix('claude', 'p'), { cmd: 'claude', args: ['--safe-mode', '-p', '--permission-mode', 'acceptEdits', 'p'] });
  assert.deepEqual(commandForFix('claude', 'p', { bin: '/opt/claude' }), { cmd: '/opt/claude', args: ['--safe-mode', '-p', '--permission-mode', 'acceptEdits', 'p'] });
  assert.deepEqual(
    commandForFix('codex', 'p', { model: 'fast-model', effort: 'high' }),
    {
      cmd: 'codex',
      args: [
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '-c', 'model_reasoning_effort="high"', '-m', 'fast-model',
        '--sandbox', 'workspace-write', 'p',
      ],
    },
  );
  const inheritedEffortArgs = process.env.GUARDEX_REVIEW_CODEX_EFFORT
    ? ['-c', `model_reasoning_effort="${codexReviewEffort()}"`]
    : [];
  assert.deepEqual(
    commandForFix('codex', 'p', { inheritConfig: true }),
    { cmd: 'codex', args: ['exec', ...inheritedEffortArgs, '--sandbox', 'workspace-write', 'p'] },
  );
});

test('fixPrompt carries the location, the severity, and the proposed replacement', () => {
  const prompt = fixPrompt([FINDING]);
  assert.match(prompt, /\[HIGH\] src\/a\.js:3 — unsafe/);
  assert.match(prompt, /const safe = true/);
  assert.match(prompt, /Do not run git commit/);
  assert.match(prompt, /Never run the full test suite, a broad linter, or a build/);
  assert.match(prompt, /finish flow runs the repository preflight and CI/);
});

test('runReviewFix refuses to write on a protected branch', () => {
  const repoDir = initRepo();
  seedCommit(repoDir);
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
    run: () => assert.fail('provider must not run on a protected branch'),
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /protected branch/);
});

test('runReviewFix refuses uncommitted tracked edits so unrelated WIP is never committed', () => {
  const repoDir = onAgentBranch();
  const tracked = git(repoDir, ['ls-files']).stdout.split('\n').filter(Boolean)[0];
  fs.writeFileSync(path.join(repoDir, tracked), 'unrelated work in progress', 'utf8');
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
    run: () => assert.fail('provider must not run over uncommitted edits'),
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /uncommitted change/);
});

test('runReviewFix stages only what the fix touched, never pre-existing untracked files', () => {
  const repoDir = onAgentBranch();
  fs.writeFileSync(path.join(repoDir, 'scratch.txt'), 'pre-existing untracked note', 'utf8');
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
    run: () => {
      fs.writeFileSync(path.join(repoDir, 'fixed.js'), 'const safe = true\n', 'utf8');
      return { status: 0, stdout: 'done', stderr: '' };
    },
  });
  assert.equal(result.status, 'fixed', 'an untracked scratch file does not block the fix');
  assert.deepEqual(result.changedFiles, ['fixed.js']);
  const committed = git(repoDir, ['show', '--name-only', '--pretty=format:', 'HEAD']).stdout;
  assert.match(committed, /fixed\.js/);
  assert.doesNotMatch(committed, /scratch\.txt/, 'pre-existing untracked WIP stays out of the commit');
});

test('runReviewFix refuses when the checkout is on a different branch than the fix targets', () => {
  const repoDir = onAgentBranch();
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING], expectBranch: 'agent/other/lane' }, {
    run: () => assert.fail('provider must not run against the wrong branch'),
  });
  assert.equal(result.status, 'skipped');
  assert.match(result.reason, /targets 'agent\/other\/lane'/);
});

test('runReviewFix commits what the provider changed', () => {
  const repoDir = onAgentBranch();
  const before = git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
    run: () => {
      fs.writeFileSync(path.join(repoDir, 'fixed.js'), 'const safe = true\n', 'utf8');
      return { status: 0, stdout: 'done', stderr: '' };
    },
  });
  assert.equal(result.status, 'fixed');
  assert.deepEqual(result.changedFiles, ['fixed.js']);
  assert.notEqual(result.sha, before, 'a new commit exists');
  assert.match(git(repoDir, ['log', '-1', '--pretty=%B']).stdout, /fix\(review\): address 1 code-assist finding/);
});

test('runReviewFix resolves the provider binary before invoking the auto-fix agent', () => {
  const previous = process.env.GUARDEX_REVIEW_CLAUDE_BIN;
  process.env.GUARDEX_REVIEW_CLAUDE_BIN = '/opt/claude-real';
  try {
    const repoDir = onAgentBranch();
    let seenCmd = '';
    const result = runReviewFix({ repoRoot: repoDir, provider: 'claude', findings: [FINDING] }, {
      run: (cmd) => {
        seenCmd = cmd;
        fs.writeFileSync(path.join(repoDir, 'fixed.js'), 'const safe = true\n', 'utf8');
        return { status: 0, stdout: 'done', stderr: '' };
      },
    });
    assert.equal(result.status, 'fixed');
    assert.equal(seenCmd, '/opt/claude-real');
  } finally {
    if (previous === undefined) delete process.env.GUARDEX_REVIEW_CLAUDE_BIN;
    else process.env.GUARDEX_REVIEW_CLAUDE_BIN = previous;
  }
});

test('runReviewFix streams provider output and applies the review model override', () => {
  const previous = process.env.GUARDEX_REVIEW_MODEL;
  process.env.GUARDEX_REVIEW_MODEL = 'fast-model';
  try {
    const repoDir = onAgentBranch();
    let providerCall;
    const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
      run: (cmd, args, options) => {
        providerCall = { cmd, args, options };
        fs.writeFileSync(path.join(repoDir, 'fixed.js'), 'const safe = true\n', 'utf8');
        return { status: 0, stdout: 'done', stderr: '' };
      },
    });

    assert.equal(result.status, 'fixed');
    assert.deepEqual(providerCall.args.slice(0, 9), [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '-c', `model_reasoning_effort="${codexReviewEffort()}"`, '-m', 'fast-model', '--sandbox',
    ], 'the same review model knob controls the isolated auto-fix provider');
    assert.deepEqual(
      providerCall.options.stdio,
      ['ignore', 'inherit', 'inherit'],
      'auto-fix progress is visible instead of buffered until exit',
    );
  } finally {
    if (previous === undefined) delete process.env.GUARDEX_REVIEW_MODEL;
    else process.env.GUARDEX_REVIEW_MODEL = previous;
  }
});

test('runReviewFix reports a no-op when the provider edits nothing', () => {
  const repoDir = onAgentBranch();
  const result = runReviewFix({ repoRoot: repoDir, findings: [FINDING] }, {
    run: () => ({ status: 0, stdout: 'nothing to do', stderr: '' }),
  });
  assert.equal(result.status, 'no-op');
});

// ---- gate integration -----------------------------------------------------

function gateDeps(overrides = {}) {
  return {
    openPullRequest: () => ({ pr: { number: 7 } }),
    readHeadSha: () => 'head-sha',
    readBaseSha: () => 'base-sha',
    waitForPullRequestHead: () => ({ status: 'current', pr: { headSha: 'head-sha' } }),
    markPullRequestReady: () => {},
    waitForGreenCi: () => ({ status: 'green', pr: { mergeStateStatus: 'CLEAN' } }),
    pushBranch: () => ({ ok: true, output: '' }),
    ...overrides,
  };
}

test('gate without --gate-autofix blocks on a high finding and never runs a fix', () => {
  const deps = gateDeps({
    runPrReview: () => ({ findings: [FINDING], posted: true }),
    runReviewFix: () => assert.fail('auto-fix must be opt-in'),
  });
  assert.throws(
    () => runReviewGate({ repoRoot: '/tmp', branch: 'agent/x/y', baseBranch: 'main', options: {} }, deps),
    /1 blocking finding[\s\S]*--gate-autofix/,
  );
});

test('gate with --gate-autofix repairs, pushes, re-reviews, and then merges', () => {
  const calls = { reviews: 0, fixes: 0, pushes: 0 };
  const deps = gateDeps({
    runPrReview: () => {
      calls.reviews += 1;
      return { findings: calls.reviews === 1 ? [FINDING] : [], posted: true };
    },
    runReviewFix: (args) => {
      calls.fixes += 1;
      assert.equal(args.expectBranch, 'agent/x/y', 'the fix is pinned to the gated branch');
      assert.deepEqual(args.findings, [FINDING], 'only blocking findings are fixed');
      return { status: 'fixed', changedFiles: ['src/a.js'], sha: 'abc' };
    },
    pushBranch: () => {
      calls.pushes += 1;
      return { ok: true, output: '' };
    },
  });

  const result = runReviewGate({
    repoRoot: '/tmp', worktreePath: '/tmp/wt', branch: 'agent/x/y', baseBranch: 'main', options: { gateAutofix: true },
  }, deps);

  assert.deepEqual(result, { prNumber: 7, reviewedHeadSha: 'head-sha', reviewedBaseSha: 'base-sha' });
  assert.equal(calls.fixes, 1);
  assert.equal(calls.pushes, 1);
  assert.equal(calls.reviews, 2, 'the fix is re-reviewed by a fresh provider run, not self-certified');
});

test('gate stops fixing after the round budget and still blocks', () => {
  let fixes = 0;
  const deps = gateDeps({
    runPrReview: () => ({ findings: [FINDING], posted: true }),
    runReviewFix: () => {
      fixes += 1;
      return { status: 'fixed', changedFiles: ['src/a.js'], sha: 'abc' };
    },
  });
  assert.throws(
    () => runReviewGate({
      repoRoot: '/tmp', worktreePath: '/tmp/wt', branch: 'agent/x/y', baseBranch: 'main', options: { gateAutofix: true, gateAutofixRounds: 2 },
    }, deps),
    /Auto-fix did not clear them/,
  );
  assert.equal(fixes, 2, 'exactly the budgeted number of rounds ran');
});

test('gate falls through to the block when the fix changes nothing', () => {
  let fixes = 0;
  const deps = gateDeps({
    runPrReview: () => ({ findings: [FINDING], posted: true }),
    runReviewFix: () => {
      fixes += 1;
      return { status: 'no-op', changedFiles: [], reason: 'provider made no edits' };
    },
  });
  assert.throws(
    () => runReviewGate({
      repoRoot: '/tmp', worktreePath: '/tmp/wt', branch: 'agent/x/y', baseBranch: 'main', options: { gateAutofix: true, gateAutofixRounds: 3 },
    }, deps),
    /1 blocking finding/,
  );
  assert.equal(fixes, 1, 'a no-op fix stops the loop instead of retrying');
});
