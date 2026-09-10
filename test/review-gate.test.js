const test = require('node:test');
const assert = require('node:assert');

const { evaluateReviewGate } = require('../src/pr-review');
const {
  waitForGreenCi,
  waitForPullRequestHead,
  runReviewGate,
} = require('../src/finish/review-gate');
const { parseFinishArgs } = require('../src/cli/args');

// ---- evaluateReviewGate (pure) ------------------------------------------

test('evaluateReviewGate blocks on high/critical, passes on empty/low/medium', () => {
  assert.deepEqual(evaluateReviewGate([]), { clean: true, blocking: [] });
  assert.equal(evaluateReviewGate(null).clean, true);
  assert.equal(
    evaluateReviewGate([{ severity: 'low' }, { severity: 'medium' }]).clean,
    true,
  );

  const high = evaluateReviewGate([{ severity: 'medium' }, { severity: 'high', path: 'a', line: 1, message: 'x' }]);
  assert.equal(high.clean, false);
  assert.equal(high.blocking.length, 1);

  assert.equal(evaluateReviewGate([{ severity: 'CRITICAL' }]).clean, false, 'severity match is case-insensitive');
});

test('evaluateReviewGate honors custom blockSeverities', () => {
  const r = evaluateReviewGate([{ severity: 'medium' }], { blockSeverities: ['medium', 'high', 'critical'] });
  assert.equal(r.clean, false);
});

// ---- waitForGreenCi (injected clock + status) ---------------------------

// A controllable clock: time only advances when the gate "sleeps".
function makeClock() {
  const clock = { t: 0 };
  return {
    now: () => clock.t,
    sleep: (seconds) => { clock.t += seconds * 1000; },
  };
}
function constStatus(snap) {
  return () => snap;
}
function seqStatus(snaps) {
  let i = 0;
  return () => snaps[Math.min(i++, snaps.length - 1)];
}
const GREEN = { checks: { failed: 0, pending: 0, total: 1 }, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };

test('waitForGreenCi returns green when settled + mergeable + has checks', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', { ...c, getStatus: constStatus(GREEN) });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi fails closed on failed checks', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c, getStatus: constStatus({ checks: { failed: 1, pending: 0, total: 2 }, mergeable: 'MERGEABLE', isDraft: false }),
  });
  assert.equal(r.status, 'checks-failed');
});

test('waitForGreenCi waits through pending then returns green', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 5,
    getStatus: seqStatus([
      {
        checks: { failed: 0, pending: 2, total: 2 },
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BLOCKED',
      },
      GREEN,
    ]),
  });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi blocks a check-less PR after the grace window (the promote->merge race guard)', () => {
  const c = makeClock();
  const noChecks = { checks: { failed: 0, pending: 0, total: 0 }, isDraft: false, mergeable: 'MERGEABLE' };
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 15,
    noChecksGraceSeconds: 30,
    timeoutSeconds: 600,
    requireChecks: true,
    getStatus: constStatus(noChecks),
  });
  assert.equal(r.status, 'no-checks');
});

test('waitForGreenCi treats a freshly-promoted PR (checks not registered yet) as green once a check appears', () => {
  const c = makeClock();
  const noChecks = { checks: { failed: 0, pending: 0, total: 0 }, isDraft: false, mergeable: 'MERGEABLE' };
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 15,
    noChecksGraceSeconds: 60,
    getStatus: seqStatus([noChecks, noChecks, GREEN]), // check registers before grace expires
  });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi passes a check-less PR when --allow-no-checks (requireChecks false)', () => {
  const c = makeClock();
  const noChecks = { checks: { failed: 0, pending: 0, total: 0 }, isDraft: false, mergeable: 'MERGEABLE' };
  const r = waitForGreenCi('repo', 'br', { ...c, requireChecks: false, getStatus: constStatus(noChecks) });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi fails closed on a CANCELLED check (the H1 fail-open)', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 1, pending: 0, success: 0, other: 0, total: 1 },
      isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    }),
  });
  assert.equal(r.status, 'checks-failed');
});

test('waitForGreenCi blocks on a non-mergeable mergeStateStatus (UNSTABLE/BLOCKED)', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 0, pending: 0, success: 1, other: 0, total: 1 },
      isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE',
    }),
  });
  assert.equal(r.status, 'merge-blocked');
});

test('waitForGreenCi blocks UNSTABLE when a skipped check accompanies audited billing waivers', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: {
        failed: 0, cancelled: 0, pending: 0, success: 0, skipped: 1, waived: 2, other: 0, total: 3,
      },
      billingWaivedNames: ['build', 'review'],
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
    }),
  });

  assert.equal(r.status, 'merge-blocked');
});

test('waitForGreenCi times out without a GitHub verdict when a skipped check accompanies billing waivers', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 60,
    timeoutSeconds: 120,
    getStatus: constStatus({
      checks: {
        failed: 0, cancelled: 0, pending: 0, success: 0, skipped: 1, waived: 2, other: 0, total: 3,
      },
      billingWaivedNames: ['build', 'review'],
      isDraft: false,
      mergeable: 'MERGEABLE',
    }),
  });

  assert.equal(r.status, 'timeout');
});

test('waitForGreenCi accepts UNSTABLE when every non-success check has an audited billing waiver', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: {
        failed: 0, cancelled: 0, pending: 0, success: 0, skipped: 0, waived: 2, other: 0, total: 2,
      },
      billingWaivedNames: ['build', 'review'],
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'UNSTABLE',
    }),
  });

  assert.equal(r.status, 'green');
  assert.deepEqual(r.billingWaivedNames, ['build', 'review']);
});

test('waitForGreenCi does not let billing waivers override BLOCKED branch protection', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 0, pending: 0, success: 0, waived: 1, other: 0, total: 1 },
      billingWaivedNames: ['build'],
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    }),
  });

  assert.equal(r.status, 'merge-blocked');
});

test('waitForGreenCi fails closed when waived-check names do not account for the waived count', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 0, pending: 0, success: 0, waived: 2, other: 0, total: 2 },
      billingWaivedNames: ['build'],
      isDraft: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
  });

  assert.equal(r.status, 'timeout');
});

test('waitForGreenCi will NOT pass an other-state check (ACTION_REQUIRED) without a GitHub verdict', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 60,
    timeoutSeconds: 120,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 0, pending: 0, success: 0, other: 1, total: 1 },
      isDraft: false, mergeable: 'MERGEABLE', // no mergeStateStatus -> require all-success
    }),
  });
  assert.equal(r.status, 'timeout'); // never green: other>0 and no GitHub CLEAN verdict
});

test('waitForGreenCi passes an other-state check (NEUTRAL) when GitHub says CLEAN', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    getStatus: constStatus({
      checks: { failed: 0, cancelled: 0, pending: 0, success: 0, other: 1, total: 1 },
      isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    }),
  });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi times out when CI never settles', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 30,
    timeoutSeconds: 120,
    getStatus: constStatus({ checks: { failed: 0, pending: 1, total: 1 }, isDraft: false, mergeable: 'UNKNOWN' }),
  });
  assert.equal(r.status, 'timeout');
});

test('waitForGreenCi refuses to call green on a head that is not the pushed commit', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 30,
    timeoutSeconds: 120,
    expectHeadSha: 'new-sha',
    getStatus: constStatus({ ...GREEN, headSha: 'old-sha' }),
  });
  assert.equal(r.status, 'stale-head', 'green on the replaced commit is not green on ours');
});

test('waitForGreenCi fails closed when the snapshot carries no head sha at all', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c, pollSeconds: 30, timeoutSeconds: 120, expectHeadSha: 'new-sha', getStatus: constStatus(GREEN),
  });
  assert.equal(r.status, 'stale-head', 'unprovable freshness blocks, same as proven staleness');
});

test('waitForGreenCi goes green once the PR head catches up to the pushed commit', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', {
    ...c,
    pollSeconds: 30,
    timeoutSeconds: 300,
    expectHeadSha: 'new-sha',
    getStatus: seqStatus([
      { ...GREEN, headSha: 'old-sha' },
      { ...GREEN, headSha: 'new-sha' },
    ]),
  });
  assert.equal(r.status, 'green');
});

test('waitForGreenCi ignores head pinning when no commit was pushed mid-run', () => {
  const c = makeClock();
  const r = waitForGreenCi('repo', 'br', { ...c, getStatus: constStatus({ ...GREEN, headSha: 'any' }) });
  assert.equal(r.status, 'green');
});

test('waitForPullRequestHead waits until GitHub exposes the pushed commit', () => {
  const c = makeClock();
  const r = waitForPullRequestHead('repo', 'br', 'new-sha', {
    ...c,
    pollSeconds: 2,
    getStatus: seqStatus([
      { headSha: 'old-sha' },
      { headSha: 'new-sha' },
    ]),
  });

  assert.equal(r.status, 'current');
  assert.equal(r.pr.headSha, 'new-sha');
});

test('waitForPullRequestHead fails closed instead of reviewing a stale PR diff', () => {
  const c = makeClock();
  const r = waitForPullRequestHead('repo', 'br', 'new-sha', {
    ...c,
    pollSeconds: 2,
    timeoutSeconds: 4,
    getStatus: constStatus({ headSha: 'old-sha' }),
  });

  assert.equal(r.status, 'stale-head');
  assert.equal(r.pr.headSha, 'old-sha');
});

// ---- runReviewGate orchestration (injected deps) ------------------------

function gateDeps(over = {}) {
  return {
    openPullRequest: () => ({ pr: { number: 42 } }),
    readHeadSha: () => 'initial-sha',
    readBaseSha: () => 'base-sha',
    waitForPullRequestHead: (_repoRoot, _branch, expectedHeadSha) => ({
      status: 'current', pr: { headSha: expectedHeadSha },
    }),
    runPrReview: () => ({ findings: [], posted: true }),
    markPullRequestReady: () => {},
    resolveOutdatedReviewThreads: () => ({ ok: true, resolved: 0 }),
    evaluateReviewGate, // real
    waitForGreenCi: () => ({ status: 'green', pr: { mergeStateStatus: 'CLEAN' } }),
    ...over,
  };
}
const gateArgs = { repoRoot: '/r', branch: 'agent/x/y', baseBranch: 'main', options: {} };

test('runReviewGate passes when review clean + CI green', () => {
  assert.deepEqual(runReviewGate(gateArgs, gateDeps()), {
    prNumber: 42, reviewedHeadSha: 'initial-sha', reviewedBaseSha: 'base-sha',
  });
});

test('runReviewGate pins CI even when no autofix was needed', () => {
  let expected;
  runReviewGate(gateArgs, gateDeps({
    waitForGreenCi: (_repo, _branch, options) => {
      expected = options.expectHeadSha;
      return { status: 'green', pr: { mergeStateStatus: 'CLEAN' } };
    },
  }));
  assert.equal(expected, 'initial-sha');
});

test('runReviewGate refuses missing base and source/base drift during review', () => {
  assert.throws(() => runReviewGate(gateArgs, gateDeps({
    readBaseSha: () => '',
  })), /cannot resolve the remote base/);
  for (const key of ['readBaseSha', 'readHeadSha']) {
    let reads = 0;
    assert.throws(() => runReviewGate(gateArgs, gateDeps({
      [key]: () => (++reads === 1 ? 'before' : 'after'),
    })), /source or base changed/);
  }
});

test('runReviewGate waits for the pushed PR head before its first review', () => {
  const calls = [];
  const deps = gateDeps({
    readHeadSha: () => 'pushed-sha',
    waitForPullRequestHead: (_repoRoot, _branch, expectedHeadSha) => {
      calls.push(`head:${expectedHeadSha}`);
      return { status: 'current', pr: { headSha: expectedHeadSha } };
    },
    runPrReview: () => {
      calls.push('review');
      return { findings: [], posted: true };
    },
  });

  runReviewGate(gateArgs, deps);
  assert.deepEqual(calls.slice(0, 2), ['head:pushed-sha', 'review']);
});

test('runReviewGate blocks before first review when GitHub still exposes the previous head', () => {
  let reviewed = false;
  const deps = gateDeps({
    readHeadSha: () => 'pushed-sha',
    waitForPullRequestHead: () => ({ status: 'stale-head', pr: { headSha: 'previous-sha' } }),
    runPrReview: () => {
      reviewed = true;
      return { findings: [], posted: true };
    },
  });

  assert.throws(
    () => runReviewGate(gateArgs, deps),
    /still reports head previous-sha.*pushed-sha/s,
  );
  assert.equal(reviewed, false, 'a stale GitHub diff must never reach the first review');
});

test('runReviewGate resolves outdated GitGuardex threads after a clean review', () => {
  const calls = [];
  const advisory = { severity: 'medium', path: 'a.js', line: 4, message: 'advisory' };
  const deps = gateDeps({
    runPrReview: () => ({ findings: [advisory], posted: true }),
    resolveOutdatedReviewThreads: (prNumber, _repoRoot, findings) => {
      calls.push({ prNumber, findings });
      return { ok: true, resolved: 2 };
    },
  });

  assert.deepEqual(runReviewGate(gateArgs, deps), {
    prNumber: 42, reviewedHeadSha: 'initial-sha', reviewedBaseSha: 'base-sha',
  });
  assert.deepEqual(calls, [{ prNumber: 42, findings: [advisory] }]);
});

test('runReviewGate reports billing-waived checks so callers can require local preflight', () => {
  const deps = gateDeps({
    waitForGreenCi: () => ({
      status: 'green',
      pr: { mergeStateStatus: 'UNSTABLE' },
      billingWaivedNames: ['build', 'review'],
    }),
  });

  assert.deepEqual(runReviewGate(gateArgs, deps), {
    prNumber: 42,
    billingChecksWaived: ['build', 'review'],
    reviewedHeadSha: 'initial-sha',
    reviewedBaseSha: 'base-sha',
  });
});

test('runReviewGate fails CLOSED when the AI review provider throws', () => {
  const deps = gateDeps({ runPrReview: () => { throw new Error('codex not found'); } });
  assert.throws(() => runReviewGate(gateArgs, deps), /AI review did not complete/);
});

test('runReviewGate blocks on a high/critical finding', () => {
  const deps = gateDeps({
    runPrReview: () => ({ findings: [{ severity: 'high', path: 'a.js', line: 5, message: 'bug' }], posted: true }),
  });
  assert.throws(() => runReviewGate(gateArgs, deps), /blocking finding/);
});

test('runReviewGate blocks when CI checks fail', () => {
  const deps = gateDeps({ waitForGreenCi: () => ({ status: 'checks-failed', pr: {} }) });
  assert.throws(() => runReviewGate(gateArgs, deps), /CI checks failed/);
});

test('runReviewGate blocks when GitHub reports the PR not mergeable', () => {
  const deps = gateDeps({ waitForGreenCi: () => ({ status: 'merge-blocked', pr: { mergeStateStatus: 'BLOCKED' } }) });
  assert.throws(() => runReviewGate(gateArgs, deps), /mergeStateStatus=BLOCKED/);
});

test('runReviewGate blocks a check-less PR unless --allow-no-checks', () => {
  const deps = gateDeps({ waitForGreenCi: () => ({ status: 'no-checks', pr: {} }) });
  assert.throws(() => runReviewGate(gateArgs, deps), /no CI checks/);
});

// ---- parseFinishArgs gate flags -----------------------------------------

test('parseFinishArgs: gate is OFF by default (backward compatible)', () => {
  const o = parseFinishArgs(['--via-pr', '--wait-for-merge', '--cleanup']);
  assert.equal(o.gateReview, false);
  assert.equal(o.reviewProvider, 'codex');
  assert.equal(o.allowNoChecks, false);
});

test('parseFinishArgs: --gate-review opts in; --no-gate-review / --skip-review-gate opt out', () => {
  assert.equal(parseFinishArgs(['--gate-review']).gateReview, true);
  assert.equal(parseFinishArgs(['--gate-review', '--no-gate-review']).gateReview, false);
  assert.equal(parseFinishArgs(['--gate-review', '--skip-review-gate']).gateReview, false);
});

test('parseFinishArgs: --review-provider validates and --allow-no-checks parses', () => {
  assert.equal(parseFinishArgs(['--gate-review', '--review-provider', 'claude']).reviewProvider, 'claude');
  assert.equal(parseFinishArgs(['--gate-review', '--allow-no-checks']).allowNoChecks, true);
  assert.throws(() => parseFinishArgs(['--review-provider', 'bogus']), /codex\|claude/);
});

test('parseFinishArgs: --review-model names the model, and demands a value', () => {
  assert.equal(parseFinishArgs([]).reviewModel, '', 'empty means the provider default');
  assert.equal(parseFinishArgs(['--gate-review', '--review-model', 'sonnet']).reviewModel, 'sonnet');
  assert.throws(() => parseFinishArgs(['--review-model']), /requires a model name/);
  assert.throws(() => parseFinishArgs(['--review-model', '--cleanup']), /requires a model name/);
});

test('parseFinishArgs: --review-timeout-ms sets the provider timeout, and demands a positive integer', () => {
  assert.equal(parseFinishArgs([]).reviewTimeoutMs, undefined);
  assert.equal(parseFinishArgs(['--gate-review', '--review-timeout-ms', '60000']).reviewTimeoutMs, 60_000);
  assert.throws(() => parseFinishArgs(['--review-timeout-ms']), /positive integer/);
  assert.throws(() => parseFinishArgs(['--review-timeout-ms', '0']), /positive integer/);
});

test('parseFinishArgs: CI waits for review by default; --no-gate-serial-ci opts into overlap', () => {
  assert.equal(parseFinishArgs(['--gate-review']).gateSerialCi, true);
  assert.equal(parseFinishArgs(['--gate-review'], { gateSerialCi: false }).gateSerialCi, false);
  assert.equal(parseFinishArgs(['--gate-review', '--gate-serial-ci']).gateSerialCi, true);
  assert.equal(parseFinishArgs(['--gate-serial-ci', '--no-gate-serial-ci']).gateSerialCi, false);
});

test('runReviewGate refuses to merge when the review was not posted', () => {
  // A verdict that never reached the PR leaves no evidence the diff was read,
  // and an empty-findings result from a provider that silently returned
  // nothing is indistinguishable from a genuine clean pass.
  const deps = gateDeps({ runPrReview: () => ({ findings: [], posted: false }) });
  assert.throws(() => runReviewGate(gateArgs, deps), /was not posted/);
});

test('runReviewGate names the auth cause and the artifact when nothing was posted', () => {
  const deps = gateDeps({
    runPrReview: () => ({
      findings: [],
      posted: false,
      reason: 'github-auth-unavailable',
      artifactPath: '/tmp/pr-1.md',
    }),
  });
  assert.throws(
    () => runReviewGate(gateArgs, deps),
    (err) => /GitHub auth was unavailable/.test(err.message)
      && /\/tmp\/pr-1\.md/.test(err.message),
  );
});

test('runReviewGate does not merge on an unposted review even with zero findings', () => {
  let waited = false;
  const deps = gateDeps({
    runPrReview: () => ({ findings: [], posted: undefined }),
    waitForGreenCi: () => { waited = true; return { status: 'green', pr: {} }; },
  });
  assert.throws(() => runReviewGate(gateArgs, deps));
  // What must hold is that an unposted review never reaches the merge: the run
  // throws before the CI wait, and runReviewGate returning is the only thing
  // that lets a merge run.
  assert.equal(waited, false, 'an unposted review must not reach the CI wait');
});

test('runReviewGate in serial mode does not promote a PR whose review was never posted', () => {
  let promoted = false;
  const deps = gateDeps({
    runPrReview: () => ({ findings: [], posted: undefined }),
    markPullRequestReady: () => { promoted = true; },
  });
  assert.throws(() => runReviewGate({ ...gateArgs, options: { gateSerialCi: true } }, deps));
  assert.equal(promoted, false, '--gate-serial-ci spends no CI on a review that never landed');
});

// ---- CI/review overlap --------------------------------------------------

/** A runPrReview that returns each review in turn, then repeats the last. */
function seqReviews(reviews) {
  let i = 0;
  return () => reviews[Math.min(i++, reviews.length - 1)];
}

/** Deps that record the order of the calls the overlap changes. */
function orderedDeps(over = {}) {
  const calls = [];
  const deps = gateDeps({
    markPullRequestDraft: () => { calls.push('draft'); return { ok: true }; },
    markPullRequestReady: () => { calls.push('ready'); },
    runPrReview: () => { calls.push('review'); return { findings: [], posted: true }; },
    waitForGreenCi: () => { calls.push('wait'); return { status: 'green', pr: {} }; },
    ...over,
  });
  return { calls, deps };
}

test('runReviewGate holds CI until the review is clean by default', () => {
  const { calls, deps } = orderedDeps();
  runReviewGate(gateArgs, deps);
  assert.deepEqual(calls, ['review', 'ready', 'wait']);
});

test('runReviewGate redrafts an existing ready PR while the default serial review runs', () => {
  const { calls, deps } = orderedDeps();
  deps.openPullRequest = () => ({ pr: { number: 42, isDraft: false } });
  runReviewGate(gateArgs, deps);
  assert.deepEqual(calls, ['draft', 'review', 'ready', 'wait']);
});

test('runReviewGate fails closed when it cannot redraft before a serial review', () => {
  let reviewed = false;
  let waited = false;
  const deps = gateDeps({
    openPullRequest: () => ({ pr: { number: 42, isDraft: false } }),
    markPullRequestDraft: () => ({ ok: false, output: 'draft failed' }),
    runPrReview: () => {
      reviewed = true;
      return { findings: [], posted: true };
    },
    waitForGreenCi: () => {
      waited = true;
      return { status: 'green', pr: {} };
    },
  });

  assert.throws(
    () => runReviewGate(gateArgs, deps),
    /could not hold PR #42 as draft before review[\s\S]*draft failed/,
  );
  assert.equal(reviewed, false);
  assert.equal(waited, false);
});

test('runReviewGate with --no-gate-serial-ci promotes before the review', () => {
  const { calls, deps } = orderedDeps();
  runReviewGate({ ...gateArgs, options: { gateSerialCi: false } }, deps);
  assert.deepEqual(calls, ['ready', 'review', 'wait']);
});

test('runReviewGate fails closed when it cannot promote before an overlapping review', () => {
  let reviewed = false;
  let waited = false;
  const deps = gateDeps({
    markPullRequestReady: () => ({ ok: false, output: 'ready failed' }),
    runPrReview: () => {
      reviewed = true;
      return { findings: [], posted: true };
    },
    waitForGreenCi: () => {
      waited = true;
      return { status: 'green', pr: {} };
    },
  });

  assert.throws(
    () => runReviewGate({ ...gateArgs, options: { gateSerialCi: false } }, deps),
    /could not promote PR #42 before review[\s\S]*ready failed/,
  );
  assert.equal(reviewed, false);
  assert.equal(waited, false);
});

test('runReviewGate still blocks a dirty review after promoting early', () => {
  const { calls, deps } = orderedDeps({
    runPrReview: () => {
      calls.push('review');
      return { findings: [{ severity: 'high', path: 'a.js', line: 5, message: 'bug' }], posted: true };
    },
  });
  assert.throws(() => runReviewGate({ ...gateArgs, options: { gateSerialCi: false } }, deps), /blocking finding/);
  assert.deepEqual(calls, ['ready', 'review'], 'promoted, reviewed, then blocked before the CI wait');
});

test('runReviewGate pins the CI wait to the commit an auto-fix pushed', () => {
  let seenExpect = null;
  let reviewCalls = 0;
  let syncedBeforeSecondReview = false;
  let headReads = 0;
  const deps = gateDeps({
    runPrReview: () => {
      reviewCalls += 1;
      if (reviewCalls === 2) assert.equal(syncedBeforeSecondReview, true);
      return reviewCalls === 1
        ? { findings: [{ severity: 'high', path: 'a.js', line: 1, message: 'bug' }], posted: true }
        : { findings: [], posted: true };
    },
    runReviewFix: () => ({ status: 'fixed', changedFiles: ['a.js'] }),
    pushBranch: () => ({ ok: true }),
    readHeadSha: () => (headReads++ === 0 ? 'initial-sha' : 'sha-after-fix'),
    waitForPullRequestHead: (_r, _b, expectedHeadSha) => {
      if (expectedHeadSha === 'sha-after-fix') syncedBeforeSecondReview = true;
      return { status: 'current', pr: { headSha: expectedHeadSha } };
    },
    waitForGreenCi: (_r, _b, opts) => { seenExpect = opts.expectHeadSha; return { status: 'green', pr: {} }; },
  });
  runReviewGate({ ...gateArgs, options: { gateAutofix: true } }, deps);
  assert.equal(seenExpect, 'sha-after-fix');
});

test('runReviewGate blocks before re-review when GitHub still exposes the pre-fix head', () => {
  let reviewCalls = 0;
  let headReads = 0;
  const deps = gateDeps({
    runPrReview: () => {
      reviewCalls += 1;
      return { findings: [{ severity: 'high', path: 'a.js', line: 1, message: 'bug' }], posted: true };
    },
    runReviewFix: () => ({ status: 'fixed', changedFiles: ['a.js'] }),
    pushBranch: () => ({ ok: true }),
    readHeadSha: () => (headReads++ === 0 ? 'initial-sha' : 'sha-after-fix'),
    waitForPullRequestHead: (_r, _b, expectedHeadSha) => (
      expectedHeadSha === 'initial-sha'
        ? { status: 'current', pr: { headSha: expectedHeadSha } }
        : { status: 'stale-head', pr: { headSha: 'sha-before-fix' } }
    ),
  });

  assert.throws(
    () => runReviewGate({ ...gateArgs, options: { gateAutofix: true } }, deps),
    /still reports head sha-before-fix.*sha-after-fix/s,
  );
  assert.equal(reviewCalls, 1, 'a stale GitHub diff must never reach the second review');
});

test('runReviewGate passes review model and timeout through to the provider runner', () => {
  let seen = null;
  const deps = gateDeps({
    runPrReview: (args) => {
      seen = args;
      return { findings: [], posted: true };
    },
  });
  runReviewGate({
    ...gateArgs,
    options: { reviewModel: 'sonnet', reviewTimeoutMs: 60_000 },
  }, deps);
  assert.equal(seen.model, 'sonnet');
  assert.equal(seen.timeoutMs, 60_000);
});

test('runReviewGate blocks when the PR head never catches up to the auto-fix commit', () => {
  const deps = gateDeps({ waitForGreenCi: () => ({ status: 'stale-head', pr: { headSha: 'old-sha' } }) });
  assert.throws(() => runReviewGate(gateArgs, deps), /still reports head old-sha/);
});
