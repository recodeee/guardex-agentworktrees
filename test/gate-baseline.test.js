const { test, assert } = require('./helpers/install-test-helpers');
const { waitForGreenCi, runReviewGate } = require('../src/finish/review-gate');
const { checkOutcomes, baselineFailures } = require('../src/pr');

// A PR snapshot with `red` failing checks out of `total`.
function snapshot({
  failedNames = [], total = 2, pending = 0, other = 0, mergeStateStatus = 'UNSTABLE',
} = {}) {
  const failed = failedNames.length;
  return {
    number: 1,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus,
    failedNames,
    checks: {
      success: total - failed - pending - other,
      failed,
      pending,
      cancelled: 0,
      other,
      total,
    },
  };
}

// The clock always advances, so a snapshot that never resolves ends in
// `timeout` instead of spinning the poll loop forever.
function advancingClock() {
  let ticks = 0;
  return () => { ticks += 1; return ticks * 10_000; };
}

function wait(snap, options = {}) {
  return waitForGreenCi('/repo', 'agent/x/y', {
    getStatus: () => snap,
    sleep: () => {},
    now: advancingClock(),
    timeoutSeconds: 30,
    ...options,
  });
}

// ---- waitForGreenCi, baseline off (unchanged behavior) --------------------

test('without a baseline a failing check still blocks', () => {
  const result = wait(snapshot({ failedNames: ['test (node 20)'] }));
  assert.equal(result.status, 'checks-failed');
});

test('without a baseline an all-green PR passes', () => {
  const result = wait(snapshot({ failedNames: [], mergeStateStatus: 'CLEAN' }));
  assert.equal(result.status, 'green');
});

// ---- waitForGreenCi, baseline on ------------------------------------------

test('a check already red on the base branch does not block', () => {
  const result = wait(snapshot({ failedNames: ['test (node 20)'] }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'green', 'pre-existing failure is not this change s fault');
});

test('baseline mode treats BLOCKED from only known-red checks as green when mergeable', () => {
  const result = wait(snapshot({ failedNames: ['test (node 20)'], mergeStateStatus: 'BLOCKED' }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'green', 'GitHub can report BLOCKED solely because baseline-red checks failed');
});

test('a check NOT red on the base branch blocks and is named', () => {
  const result = wait(snapshot({ failedNames: ['test (node 20)', 'lint'] }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'checks-failed');
  assert.deepEqual(result.newFailures, ['lint'], 'only the genuinely new failure is reported');
});

test('a failing check blocks even when the snapshot omits the cancelled counter', () => {
  // Counter arithmetic must not go NaN on a partial snapshot: `NaN > 0` is
  // false, which would wave the failure through.
  const result = waitForGreenCi('/repo', 'agent/x/y', {
    getStatus: () => ({
      checks: { failed: 1, pending: 0, total: 2 }, mergeable: 'MERGEABLE', isDraft: false,
    }),
    sleep: () => {},
    now: advancingClock(),
    timeoutSeconds: 30,
  });
  assert.equal(result.status, 'checks-failed');
});

test('an unnameable failing check blocks even in baseline mode', () => {
  // 2 failures reported by the counters but only 1 name resolved: the unnamed
  // one cannot be proven pre-existing, so it must not be waved through.
  const snap = snapshot({ failedNames: ['test (node 20)'] });
  snap.checks.failed = 2;
  snap.checks.success = 0;
  const result = wait(snap, { baselineFailures: new Set(['test (node 20)']) });
  assert.equal(result.status, 'checks-failed');
});

test('baseline mode still blocks DIRTY/BEHIND, which GitHub itself refuses', () => {
  for (const mergeStateStatus of ['DIRTY', 'BEHIND']) {
    const result = wait(snapshot({ failedNames: ['test (node 20)'], mergeStateStatus }), {
      baselineFailures: new Set(['test (node 20)']),
    });
    assert.equal(result.status, 'merge-blocked', `${mergeStateStatus} must still block`);
  }
});

test('baseline mode still blocks BLOCKED when no baseline failure explains it', () => {
  const result = wait(snapshot({ failedNames: [], mergeStateStatus: 'BLOCKED' }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'merge-blocked');
});

test('baseline mode still blocks an ambiguous check state', () => {
  // No GitHub verdict + an `other` state: never a pass, so this can only time out.
  const result = wait(snapshot({ failedNames: ['test (node 20)'], total: 3, other: 1, mergeStateStatus: '' }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'timeout', 'an ACTION_REQUIRED-style state is never a pass');
});

test('baseline mode still waits on pending checks', () => {
  const result = wait(snapshot({ failedNames: ['test (node 20)'], total: 3, pending: 1 }), {
    baselineFailures: new Set(['test (node 20)']),
  });
  assert.equal(result.status, 'timeout', 'a pending check is not resolved by a baseline');
});

// ---- checkOutcomes / baselineFailures -------------------------------------

test('checkOutcomes collects failing check-runs and legacy statuses', () => {
  const calls = [];
  const runner = (_bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'repo' && args[1] === 'view') {
      return { status: 0, stdout: 'opencue/gitguardex\n', stderr: '' };
    }
    if (args.some((a) => a.includes('check-runs'))) {
      return { status: 0, stdout: 'failure\ttest (node 20)\nsuccess\tbuild\ntimed_out\te2e\n', stderr: '' };
    }
    return { status: 0, stdout: 'error\tci/external\npending\tci/slow\n', stderr: '' };
  };
  const { failing, total } = checkOutcomes('/repo', 'main', runner);
  assert.deepEqual([...failing].sort(), ['ci/external', 'e2e', 'test (node 20)']);
  assert.equal(total, 5, 'total counts every observed check, not just the failures');
  assert.ok(
    calls.some((call) => call.includes('repos/opencue/gitguardex/commits/main/check-runs')),
    'check-run API call uses the canonical repository route',
  );
});

test('checkOutcomes reports zero total when the API is unreachable', () => {
  const { failing, total } = checkOutcomes('/repo', 'main', () => ({ status: 1, stdout: '', stderr: 'boom' }));
  assert.equal(failing.size, 0);
  assert.equal(total, 0, 'unreachable is "unknown", which the caller must not read as green');
});

test('baselineFailures unions the base branch with the last merged PR', () => {
  const runner = (_bin, args) => {
    const joined = args.join(' ');
    if (joined.includes('pulls?base')) return { status: 0, stdout: 'abc1234def\n', stderr: '' };
    if (joined.includes('commits/main/check-runs')) {
      return { status: 0, stdout: 'failure\tscorecard\n', stderr: '' };
    }
    if (joined.includes('commits/abc1234def/check-runs')) {
      return { status: 0, stdout: 'failure\ttest (node 20)\nsuccess\tlint\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = baselineFailures('/repo', 'main', runner);
  assert.deepEqual([...result.failing].sort(), ['scorecard', 'test (node 20)']);
  assert.equal(result.source, "branch 'main' + last merged PR (abc1234)");
});

test('baselineFailures still finds the baseline when CI only runs on pull_request', () => {
  // The motivating case: ci.yml has no `push` trigger, so the base branch HEAD
  // carries only an unrelated check-run. A "does the base have checks?" test
  // would answer yes and hide test (node 20) entirely — the union does not.
  const runner = (_bin, args) => {
    const joined = args.join(' ');
    if (joined.includes('pulls?base')) return { status: 0, stdout: 'abc1234def\n', stderr: '' };
    if (joined.includes('commits/main/check-runs')) {
      return { status: 0, stdout: 'success\tSync Frontend Mirror\n', stderr: '' };
    }
    if (joined.includes('commits/abc1234def/check-runs')) {
      return { status: 0, stdout: 'failure\ttest (node 20)\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = baselineFailures('/repo', 'main', runner);
  assert.deepEqual([...result.failing], ['test (node 20)']);
});

test('baselineFailures reports unavailable when nothing anywhere has checks', () => {
  const result = baselineFailures('/repo', 'main', () => ({ status: 0, stdout: '', stderr: '' }));
  assert.equal(result.failing.size, 0);
  assert.equal(result.source, 'unavailable', 'an empty baseline is labelled, not silently trusted');
});

// ---- runReviewGate integration --------------------------------------------

function gateDeps(overrides = {}) {
  return {
    openPullRequest: () => ({ pr: { number: 7 } }),
    readHeadSha: () => 'head-sha',
    readBaseSha: () => 'base-sha',
    waitForPullRequestHead: () => ({ status: 'current', pr: { headSha: 'head-sha' } }),
    runPrReview: () => ({ findings: [], posted: true }),
    markPullRequestReady: () => {},
    ...overrides,
  };
}

test('runReviewGate reads the baseline only when --gate-baseline is set', () => {
  let read = 0;
  const deps = gateDeps({
    baselineFailures: () => { read += 1; return { failing: new Set(['test (node 20)']), source: "branch 'main'" }; },
    waitForGreenCi: (_r, _b, options) => {
      assert.equal(options.baselineFailures.size, 1, 'the baseline reaches the CI wait');
      return { status: 'green', pr: { mergeStateStatus: 'UNSTABLE' } };
    },
  });
  runReviewGate({
    repoRoot: '/repo', branch: 'agent/x/y', baseBranch: 'main', options: { gateBaseline: true },
  }, deps);
  assert.equal(read, 1);

  const offDeps = gateDeps({
    baselineFailures: () => assert.fail('baseline must not be read without the flag'),
    waitForGreenCi: (_r, _b, options) => {
      assert.equal(options.baselineFailures.size, 0);
      return { status: 'green', pr: {} };
    },
  });
  runReviewGate({
    repoRoot: '/repo', branch: 'agent/x/y', baseBranch: 'main', options: {},
  }, offDeps);
});

test('runReviewGate names the new failures and suggests the flag when it is off', () => {
  const deps = gateDeps({
    waitForGreenCi: () => ({ status: 'checks-failed', newFailures: [], pr: {} }),
  });
  assert.throws(
    () => runReviewGate({
      repoRoot: '/repo', branch: 'agent/x/y', baseBranch: 'main', options: {},
    }, deps),
    /--gate-baseline/,
  );

  const withFlag = gateDeps({
    baselineFailures: () => ({ failing: new Set(['test (node 20)']), source: "branch 'main'" }),
    waitForGreenCi: () => ({ status: 'checks-failed', newFailures: ['lint'], pr: {} }),
  });
  assert.throws(
    () => runReviewGate({
      repoRoot: '/repo', branch: 'agent/x/y', baseBranch: 'main', options: { gateBaseline: true },
    }, withFlag),
    /New failure\(s\) vs 'main': lint/,
  );
});
