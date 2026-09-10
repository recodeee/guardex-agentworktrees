const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '..', 'templates', 'scripts', 'agent-preflight.sh');

// A minimal Node repo whose `npm test` runs the given inline node script, so the
// preflight's run_step is exercised end-to-end.
function makeNodeRepo(testScript) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  cp.spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', scripts: { test: testScript } }, null, 2),
  );
  // package-lock.json + npm => the script's npm branch fires.
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, packages: {} }, null, 2),
  );
  return dir;
}

function runPreflight(dir, env = {}) {
  const res = cp.spawnSync('bash', [scriptPath], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

const NOISY_PASS = "node -e \"for(let i=0;i<200;i++)console.log('NOISE'+i)\"";

test('preflight SUPPRESSES a passing step\'s output by default (no context flood)', () => {
  const dir = makeNodeRepo(NOISY_PASS);
  try {
    const { status, out } = runPreflight(dir);
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /NOISE100/, 'noisy test output must be suppressed on success');
    assert.match(out, /lines suppressed/, 'reports how many lines were hidden (no silent cap)');
    assert.match(out, /\[agent-preflight] {4}ok/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GUARDEX_PREFLIGHT_VERBOSE=1 streams the full output', () => {
  const dir = makeNodeRepo(NOISY_PASS);
  try {
    const { status, out } = runPreflight(dir, { GUARDEX_PREFLIGHT_VERBOSE: '1' });
    assert.equal(status, 0, out);
    assert.match(out, /NOISE100/, 'verbose mode shows the full output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a FAILING step still surfaces its output (tail) and fails the preflight', () => {
  const dir = makeNodeRepo("node -e \"console.log('BOOM-DETAIL'); process.exit(1)\"");
  try {
    const { status, out } = runPreflight(dir);
    assert.notEqual(status, 0, 'preflight must fail when a step fails');
    assert.match(out, /FAIL/);
    assert.match(out, /BOOM-DETAIL/, 'failure output (tail) is shown so it stays diagnosable');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight strips Guardex runtime and bypass variables from verification commands', () => {
  const keys = [
    'ALLOW_BASH_ON_NON_AGENT_BRANCH',
    'ALLOW_CODE_EDIT_ON_PROTECTED_BRANCH',
    'ALLOW_CODE_EDIT_ON_PRIMARY_WORKTREE',
    'ALLOW_COMMIT_ON_PROTECTED_BRANCH',
    'ALLOW_PUSH_ON_PROTECTED_BRANCH',
    'GUARDEX_CLI_ENTRY',
    'GUARDEX_NODE_BIN',
    'GUARDEX_FINISH_ACTIVE_CWD',
    'GUARDEX_FINISH_CHECKLIST',
    'GUARDEX_FINISH_GATE_DONE',
    'GUARDEX_FINISH_REVIEWED_HEAD',
    'GUARDEX_FINISH_REVIEWED_BASE',
    'GUARDEX_FINISH_REQUIRE_PREFLIGHT',
    'GUARDEX_FINISH_EVENT_FILE',
    'GUARDEX_FINISH_RUN_ID',
    'GUARDEX_FINISH_EVENT_BRANCH',
    'GUARDEX_FINISH_EVENT_BASE',
  ];
  const assertion = `node -e 'const keys=${JSON.stringify(keys)}; const leaked=keys.filter(key => process.env[key]); if (leaked.length) { console.error(leaked.join(",")); process.exit(1); }'`;
  const dir = makeNodeRepo(assertion);
  try {
    const leakedEnv = Object.fromEntries(keys.map((key) => [key, '1']));
    const { status, out } = runPreflight(dir, leakedEnv);
    assert.equal(status, 0, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight consumes its target worktree without leaking it into nested verification', () => {
  const dir = makeNodeRepo('node -e "if(process.env.GUARDEX_PREFLIGHT_TARGET_WORKTREE)process.exit(1)"');
  try {
    const { status, out } = runPreflight(dir, { GUARDEX_PREFLIGHT_TARGET_WORKTREE: dir });
    assert.equal(status, 0, out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
