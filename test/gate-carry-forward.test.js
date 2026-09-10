const { test, assert } = require('./helpers/install-test-helpers');
const { runReviewGate, resolveCarriedFindings } = require('../src/finish/review-gate');

const HIGH = {
  path: 'src/components/product-card-compact.tsx', line: 184, severity: 'high', message: 'drops the set-total price line',
};
const OTHER_HIGH = { path: 'src/pages/store.tsx', line: 1614, severity: 'high', message: 'loses text search' };

// ---- resolveCarriedFindings (pure) ----------------------------------------

test('a blocked file that was edited by the fix is accounted for', () => {
  const out = resolveCarriedFindings(new Set(['a.tsx']), new Set(['a.tsx']), []);
  assert.deepEqual(out, []);
});

test('a blocked file the latest review still mentions is accounted for', () => {
  const out = resolveCarriedFindings(new Set(['a.tsx']), new Set(), [{ path: 'a.tsx', severity: 'low' }]);
  assert.deepEqual(out, [], 'a downgraded finding still counts as "under review"');
});

test('a blocked file that was never edited and is no longer reported is unexplained', () => {
  const out = resolveCarriedFindings(new Set(['a.tsx', 'b.tsx']), new Set(['a.tsx']), []);
  assert.deepEqual(out, ['b.tsx']);
});

test('resolveCarriedFindings tolerates missing/garbage findings', () => {
  const out = resolveCarriedFindings(new Set(['a.tsx']), new Set(), null);
  assert.deepEqual(out, ['a.tsx']);
  assert.deepEqual(resolveCarriedFindings(new Set(), new Set(), [{}, null]), []);
});

// ---- gate integration -----------------------------------------------------

function gateDeps(overrides = {}) {
  return {
    openPullRequest: () => ({ pr: { number: 440 } }),
    readHeadSha: () => 'head-sha',
    readBaseSha: () => 'base-sha',
    waitForPullRequestHead: () => ({ status: 'current', pr: { headSha: 'head-sha' } }),
    markPullRequestReady: () => {},
    waitForGreenCi: () => ({ status: 'green', pr: { mergeStateStatus: 'CLEAN' } }),
    pushBranch: () => ({ ok: true, output: '' }),
    ...overrides,
  };
}

function gate(deps, options = {}) {
  return runReviewGate({
    repoRoot: '/repo', worktreePath: '/wt', branch: 'agent/x/y', baseBranch: 'main', options,
  }, deps);
}

test('a blocking finding that silently vanishes after an unrelated fix blocks the merge', () => {
  // Reproduces lifted.sk-storefront#440: round 1 blocks on two files, the fix
  // round edits only one of them, and the re-review no longer reports the other.
  let round = 0;
  const deps = gateDeps({
    runPrReview: () => {
      round += 1;
      return { findings: round === 1 ? [HIGH, OTHER_HIGH] : [], posted: true };
    },
    runReviewFix: () => ({ status: 'fixed', changedFiles: ['src/pages/store.tsx'], sha: 'abc' }),
  });

  assert.throws(
    () => gate(deps, { gateAutofix: true }),
    /disappeared without their file being changed[\s\S]*product-card-compact\.tsx/,
    'the untouched file must not be waved through',
  );
  assert.equal(round, 2);
});

test('a blocking finding whose file the fix actually edited clears normally', () => {
  let round = 0;
  const deps = gateDeps({
    runPrReview: () => {
      round += 1;
      return { findings: round === 1 ? [HIGH] : [], posted: true };
    },
    runReviewFix: () => ({
      status: 'fixed', changedFiles: ['src/components/product-card-compact.tsx'], sha: 'abc',
    }),
  });
  assert.deepEqual(gate(deps, { gateAutofix: true }), { prNumber: 440, reviewedHeadSha: 'head-sha', reviewedBaseSha: 'base-sha' });
});

test('a finding downgraded below the block threshold still counts as reviewed', () => {
  // The same defect coming back as MEDIUM is a judgement call, not a silent
  // disappearance — the gate blocks on severity, so this merges.
  let round = 0;
  const deps = gateDeps({
    runPrReview: () => {
      round += 1;
      return { findings: round === 1 ? [HIGH] : [{ ...HIGH, severity: 'medium' }], posted: true };
    },
    runReviewFix: () => ({ status: 'fixed', changedFiles: ['unrelated.ts'], sha: 'abc' }),
  });
  assert.deepEqual(gate(deps, { prNumber: 440, gateAutofix: true }), { prNumber: 440, reviewedHeadSha: 'head-sha', reviewedBaseSha: 'base-sha' });
});

test('carry-forward never fires without --gate-autofix', () => {
  // One review round only, so there is no later round for a finding to vanish
  // from. Behavior must be byte-identical to before this change.
  const deps = gateDeps({
    runPrReview: () => ({ findings: [], posted: true }),
    runReviewFix: () => assert.fail('no fix without the flag'),
  });
  assert.deepEqual(gate(deps, {}), { prNumber: 440, reviewedHeadSha: 'head-sha', reviewedBaseSha: 'base-sha' });
});

test('a clean first review merges even with autofix armed', () => {
  const deps = gateDeps({
    runPrReview: () => ({ findings: [{ path: 'a.tsx', line: 1, severity: 'low', message: 'nit' }], posted: true }),
    runReviewFix: () => assert.fail('nothing blocking, nothing to fix'),
  });
  assert.deepEqual(gate(deps, { gateAutofix: true }), { prNumber: 440, reviewedHeadSha: 'head-sha', reviewedBaseSha: 'base-sha' });
});

test('an aborted fix still blocks on the original finding, not the carry-forward path', () => {
  const deps = gateDeps({
    runPrReview: () => ({ findings: [HIGH], posted: true }),
    runReviewFix: () => ({ status: 'no-op', changedFiles: [], reason: 'provider made no edits' }),
  });
  assert.throws(() => gate(deps, { gateAutofix: true }), /1 blocking finding/);
});
