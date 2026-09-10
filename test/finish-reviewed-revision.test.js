const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = fs.readFileSync(
  path.join(__dirname, '../templates/scripts/agent-branch-finish.sh'),
  'utf8'
);

test('gated finish never synchronizes a reviewed source, including OpenSpec conflicts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-reviewed-'));
  const git = (...args) =>
    cp
      .execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/dev/null'
        }
      })
      .trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.test');
    git('config', 'multiagent.sync.requireBeforeFinish', 'true');
    fs.mkdirSync(path.join(root, 'openspec/changes/example'), { recursive: true });
    const tasks = path.join(root, 'openspec/changes/example/tasks.md');
    fs.writeFileSync(tasks, '- [ ] work\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('switch', '-qc', 'agent/test');
    fs.writeFileSync(tasks, '- [x] work\n');
    git('commit', '-qam', 'reviewed work');
    const head = git('rev-parse', 'HEAD');
    git('switch', '-q', 'main');
    fs.writeFileSync(tasks, '- [ ] updated work\n');
    git('commit', '-qam', 'base advances');
    const base = git('rev-parse', 'HEAD');
    git('switch', '-q', 'agent/test');
    git('remote', 'add', 'origin', root);
    git('fetch', '-q', 'origin');
    const start = script.indexOf('assert_reviewed_revision() {');
    assert.ok(start >= 0, 'finish needs a reviewed-revision guard');
    const end = script.indexOf('\nshould_create_integration_helper=1', start);
    const command = script.slice(start, end);
    const run = (expectedHead, expectedBase, extraEnv = {}) =>
      cp.spawnSync('bash', ['-eu', '-c', command], {
        encoding: 'utf8',
        env: {
          ...process.env,
          repo_root: root,
          source_worktree: root,
          SOURCE_BRANCH: 'agent/test',
          BASE_BRANCH: 'main',
          FINISH_GATE_DONE: '1',
          MERGE_MODE: 'pr',
          PUSH_ENABLED: '1',
          GUARDEX_FINISH_REVIEWED_HEAD: expectedHead,
          GUARDEX_FINISH_REVIEWED_BASE: expectedBase,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: '/dev/null',
          ...extraEnv
        }
      });
    const ok = run(head, base);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(git('rev-parse', 'HEAD'), head, 'no rebase or reconciliation commit');
    assert.equal(git('status', '--porcelain'), '', 'no merge probe left behind');
    assert.notEqual(run(head, base, { PUSH_ENABLED: '0' }).status, 0);
    assert.notEqual(run(head, base, { MERGE_MODE: 'direct' }).status, 0);
    for (const [h, b] of [
      [head, head],
      [base, base],
      ['', base],
      [head, '']
    ]) {
      const blocked = run(h, b);
      assert.notEqual(blocked.status, 0, 'changed or absent identity must block');
      assert.match(blocked.stderr, /reviewed revision|review gate/i);
      assert.equal(git('rev-parse', 'HEAD'), head);
    }
    fs.writeFileSync(tasks, 'uncommitted after preflight\n');
    const dirty = run(head, base);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stderr, /uncommitted changes/);
    assert.equal(git('rev-parse', 'HEAD'), head);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gated push publishes the reviewed object even if the local branch advances after the guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gx-reviewed-push-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null'
  };
  const git = (...args) =>
    cp
      .execFileSync('git', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] })
      .trim();
  try {
    git('init', '-q', '--bare', remote);
    git('init', '-q', '-b', 'agent/test', source);
    git('-C', source, 'config', 'user.name', 'Test');
    git('-C', source, 'config', 'user.email', 'test@example.test');
    git('-C', source, 'commit', '-qm', 'reviewed', '--allow-empty');
    const head = git('-C', source, 'rev-parse', 'HEAD');
    git('-C', source, 'remote', 'add', 'origin', remote);
    const start = script.indexOf(
      '  maybe_push_changed_submodule_branches "$start_ref" "$SOURCE_BRANCH"'
    );
    assert.ok(start >= 0);
    const end = script.indexOf('\n  pr_title=', start);
    const result = cp.spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        [
          'maybe_push_changed_submodule_branches() { :; }',
          // Inject concurrent local work immediately after the successful revision check.
          'assert_reviewed_revision() { git -C "$source_worktree" commit -qm unreviewed --allow-empty; }',
          script.slice(start, end)
        ].join('\n')
      ],
      {
        encoding: 'utf8',
        env: {
          ...env,
          source_worktree: source,
          SOURCE_BRANCH: 'agent/test',
          start_ref: head,
          FINISH_GATE_DONE: '1',
          GUARDEX_FINISH_REVIEWED_HEAD: head
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(git('-C', source, 'rev-parse', 'HEAD'), head);
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/agent/test'), head);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every gated merge attempt uses the reviewed head, never asynchronous auto-merge', () => {
  const attempts = script.split('\n').filter((line) => line.includes('pr merge "$SOURCE_BRANCH"'));
  assert.equal(attempts.length, 3);
  for (const line of attempts) assert.match(line, /merge_head_args/);
  assert.match(script, /assert_reviewed_revision \|\| return 1/);
  assert.match(script, /FINISH_GATE_DONE.*-eq 1[\s\S]*Review gate.*rerun/i);
});

test('gated merge rejects enabled, unknown, and unavailable merge queues', () => {
  const start = script.indexOf('assert_synchronous_merge() {');
  const end = script.indexOf('\nmerge_head_args=()', start);
  const guard = script.slice(start, end);
  for (const policy of ['false', 'true', 'null', '', 'error']) {
    const result = cp.spawnSync(
      'bash',
      [
        '-eu',
        '-c',
        [
          guard,
          'assert_reviewed_revision() { echo revision-checked; }',
          'gh_stub() { if [[ "$1" == pr ]]; then echo PR_id; elif [[ "$QUEUE" == error ]]; then return 1; else printf "%s\\n" "$QUEUE"; fi; }',
          'assert_synchronous_merge'
        ].join('\n')
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FINISH_GATE_DONE: '1',
          SOURCE_BRANCH: 'agent/test',
          GH_BIN: 'gh_stub',
          QUEUE: policy
        }
      }
    );
    assert.equal(result.status === 0, policy === 'false', policy);
    if (policy === 'false') assert.match(result.stdout, /revision-checked/);
    else assert.doesNotMatch(result.stdout, /revision-checked/);
  }
});

test('unattended doctor finish preserves the billing-waiver preflight requirement', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/doctor/index.js'), 'utf8');
  assert.match(
    source,
    /GUARDEX_FINISH_REQUIRE_PREFLIGHT: gateOutcome\.gateResult\?\.billingChecksWaived\?\.length > 0 \? '1' : '0'/
  );
});
