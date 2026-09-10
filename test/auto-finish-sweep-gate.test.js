const test = require('node:test');
const assert = require('node:assert/strict');

const { runAutoShipGateForBranch } = require('../src/doctor/index');

const BRANCH_INPUT = {
  repoRoot: '/repo',
  branch: 'agent/claude/x',
  baseBranch: 'main',
};

test('auto-ship off: sweep does not gate (runReviewGate never called)', () => {
  let called = 0;
  const out = runAutoShipGateForBranch(
    { autoShip: false, fallbackMode: '', ...BRANCH_INPUT },
    { runReviewGate: () => { called += 1; } },
  );
  assert.deepEqual(out, { skip: false });
  assert.equal(called, 0);
});

test('auto-ship on + PR path: gate runs and branch proceeds when it passes', () => {
  let seen = null;
  const gateResult = { reviewedHeadSha: 'head', reviewedBaseSha: 'base' };
  const out = runAutoShipGateForBranch(
    { autoShip: true, fallbackMode: '', ...BRANCH_INPUT },
    { runReviewGate: (arg) => { seen = arg; return gateResult; } },
  );
  assert.deepEqual(out, { skip: false, gateResult });
  assert.equal(seen.repoRoot, '/repo');
  assert.equal(seen.branch, 'agent/claude/x');
  assert.equal(seen.baseBranch, 'main');
  // The gate is invoked with the options runReviewGate actually reads.
  assert.equal(seen.options.reviewProvider, 'codex');
  assert.equal(seen.options.allowNoChecks, false);
});

test('GUARDEX_AUTO_SHIP_REVIEW_PROVIDER overrides the gate reviewer', () => {
  const prev = process.env.GUARDEX_AUTO_SHIP_REVIEW_PROVIDER;
  process.env.GUARDEX_AUTO_SHIP_REVIEW_PROVIDER = 'claude';
  try {
    let seen = null;
    runAutoShipGateForBranch(
      { autoShip: true, fallbackMode: '', ...BRANCH_INPUT },
      { runReviewGate: (arg) => { seen = arg; } },
    );
    assert.equal(seen.options.reviewProvider, 'claude');
  } finally {
    if (prev === undefined) delete process.env.GUARDEX_AUTO_SHIP_REVIEW_PROVIDER;
    else process.env.GUARDEX_AUTO_SHIP_REVIEW_PROVIDER = prev;
  }
});

test('auto-ship on + PR path: gate failure skips the branch (no merge)', () => {
  const out = runAutoShipGateForBranch(
    { autoShip: true, fallbackMode: '', ...BRANCH_INPUT },
    { runReviewGate: () => { throw new Error('review found CRITICAL'); } },
  );
  assert.equal(out.skip, true);
  assert.match(out.reason, /merge gate blocked/);
  assert.match(out.reason, /review found CRITICAL/);
});

test('auto-ship on + non-PR fallback: no PR/CI to gate, so it passes through', () => {
  for (const fallbackMode of ['direct', 'local']) {
    let called = 0;
    const out = runAutoShipGateForBranch(
      { autoShip: true, fallbackMode, ...BRANCH_INPUT },
      { runReviewGate: () => { called += 1; } },
    );
    assert.deepEqual(out, { skip: false }, `fallback ${fallbackMode} should not gate`);
    assert.equal(called, 0, `fallback ${fallbackMode} must not call the gate`);
  }
});
