// Opt-in merge gate for `gx branch finish --gate-review` / `gx ship`.
//
// `gx branch finish` trusts server-side branch protection for the actual merge,
// which can fail open (it merged PR #610 to main with red preflight tests). When
// `--gate-review` is set, this module enforces a REAL local gate BEFORE the merge
// runs: a clean AI review (fail-closed) AND green CI AND GitHub reporting the PR
// mergeable under branch protection. It throws to block; the finish() catch then
// skips the merge for that branch. Synchronous, to match finish().

const { run } = require('../core/runtime');
const { TOOL_NAME } = require('../context');
const pr = require('../pr');
const prReview = require('../pr-review');
const reviewFix = require('../review-fix');
const { mapWorktreePathsByBranch } = require('../git');

const DEFAULT_GATE_TIMEOUT_SECONDS = 1800; // 30 min — CI can be slow.
const DEFAULT_GATE_POLL_SECONDS = 15;
const DEFAULT_NO_CHECKS_GRACE_SECONDS = 60; // let CI register check runs after promote.
const DEFAULT_PR_HEAD_TIMEOUT_SECONDS = 60;
const DEFAULT_PR_HEAD_POLL_SECONDS = 2;
// GitHub mergeStateStatus values that mean "mergeable under current protection".
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS']);
// mergeStateStatus values that mean "GitHub will not allow this merge as-is".
// UNSTABLE = a non-required check is failing/pending; BLOCKED = required review/
// check unmet; DIRTY = conflicts; BEHIND = base moved. All fail closed.
const BLOCKED_STATES = new Set(['DIRTY', 'BLOCKED', 'BEHIND', 'UNSTABLE']);

function gateLog(message) {
  console.log(`[${TOOL_NAME}] [gate] ${message}`);
}

function reportProgress(progress, method, stage, detail) {
  if (progress && typeof progress[method] === 'function') {
    progress[method](stage, detail);
  }
}

function requireGhAction(result, failureMessage) {
  if (result && result.ok === false) {
    throw new Error(
      `${failureMessage}${result.output ? `\n${result.output}` : ''}`,
    );
  }
}

/**
 * A review that never reached the PR does not count as a review.
 *
 * `runPrReview` can come back `posted: false` — GitHub auth unavailable to the
 * runner, or any path that writes a local artifact instead of posting. Treating
 * that as a pass makes two failures look like success: an in-memory verdict
 * cannot be audited after the merge, and a provider that returned nothing is
 * indistinguishable from a clean review.
 */
function requirePostedReview(review, prNumber) {
  if (review.posted) return;
  const why = review.reason === 'github-auth-unavailable'
    ? 'GitHub auth was unavailable to the review runner'
    : `the review runner reported posted=${JSON.stringify(review.posted)}`;
  throw new Error(
    `review gate: the AI review was not posted to PR #${prNumber} (${why}). Refusing to merge — `
    + 'an unposted review leaves no evidence the diff was examined, and a provider that returns '
    + 'nothing then looks exactly like a clean pass.'
    + (review.artifactPath ? `\nLocal artifact: ${review.artifactPath}` : '')
    + '\nFix the provider/auth issue and re-run, or bypass with --skip-review-gate.',
  );
}

/** The commit checked out in `cwd`, or '' when git cannot answer. */
function readHeadSha(cwd) {
  const result = run('git', ['-C', cwd, 'rev-parse', 'HEAD'], { cwd, allowFailure: true });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function readBaseSha(cwd, baseBranch) {
  const result = run('git', ['-C', cwd, 'ls-remote', '--exit-code', 'origin', `refs/heads/${baseBranch}`], {
    cwd, allowFailure: true,
  });
  return result.status === 0 ? String(result.stdout || '').trim().split(/\s+/)[0] : '';
}

/** Worktree holding `branch`, or `repoRoot` when git cannot tell us. */
function resolveWorktreeForBranch(repoRoot, branch) {
  try {
    return mapWorktreePathsByBranch(repoRoot).get(branch) || repoRoot;
  } catch (_error) {
    return repoRoot;
  }
}

/** Wait until GitHub exposes the pushed commit before fetching the PR diff. */
function waitForPullRequestHead(repoRoot, branch, expectedHeadSha, options = {}) {
  const expected = String(expectedHeadSha || '').trim();
  if (!expected) return { status: 'missing-head' };

  const timeoutSeconds = options.timeoutSeconds || DEFAULT_PR_HEAD_TIMEOUT_SECONDS;
  const pollSeconds = options.pollSeconds || DEFAULT_PR_HEAD_POLL_SECONDS;
  const sleep = options.sleep || ((seconds) => run('sleep', [String(seconds)], { cwd: repoRoot }));
  const now = options.now || (() => Date.now());
  const getStatus = options.getStatus || ((r, b) => pr.getPullRequestStatus(r, b));
  const deadline = now() + timeoutSeconds * 1000;
  let snapshot;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    snapshot = getStatus(repoRoot, branch);
    if (snapshot?.headSha === expected) return { status: 'current', pr: snapshot };
    if (now() >= deadline) {
      return snapshot ? { status: 'stale-head', pr: snapshot } : { status: 'no-pr' };
    }
    sleep(pollSeconds);
  }
}

/**
 * Poll the PR's CI until it settles. Fail-closed: red checks, timeout, or a
 * check-less PR (after a grace window) all return a non-green status the caller
 * turns into a block. A just-promoted PR whose checks have not registered yet
 * keeps polling rather than being misread as check-less.
 *
 * Fail-closed semantics:
 *  - any failed OR cancelled check blocks (a cancelled required check is NOT a pass);
 *  - GitHub's mergeStateStatus is authoritative — BLOCKED/DIRTY/BEHIND/UNSTABLE block;
 *  - when GitHub gives no verdict (mss absent/UNKNOWN) we require EVERY check to be an
 *    explicit success (no `other` states like ACTION_REQUIRED slipping through);
 *  - a check-less PR is only declared `no-checks` after a grace window, so a freshly
 *    promoted PR whose checks have not registered yet is not misread.
 *
 * @returns {{status: 'green'|'checks-failed'|'merge-blocked'|'no-checks'|'stale-head'|'timeout'|'no-pr', pr?: object}}
 */
function waitForGreenCi(repoRoot, branch, options = {}) {
  const timeoutSeconds = options.timeoutSeconds || DEFAULT_GATE_TIMEOUT_SECONDS;
  const pollSeconds = options.pollSeconds || DEFAULT_GATE_POLL_SECONDS;
  const requireChecks = options.requireChecks !== false;
  const graceSeconds = options.noChecksGraceSeconds || DEFAULT_NO_CHECKS_GRACE_SECONDS;
  const sleep = options.sleep || ((seconds) => run('sleep', [String(seconds)], { cwd: repoRoot }));
  const now = options.now || (() => Date.now());
  const getStatus = options.getStatus || ((r, b) => pr.getPullRequestStatus(r, b));
  // Commit this wait is allowed to judge. Set when the run itself pushed (an
  // auto-fix round), where the checks GitHub reports can still belong to the
  // commit that push replaced.
  const expectHeadSha = String(options.expectHeadSha || '').trim();
  // Checks already failing on the base branch. Empty (the default) reproduces
  // the original absolute-green behavior exactly.
  const baseline = options.baselineFailures instanceof Set ? options.baselineFailures : new Set();
  const baselineMode = baseline.size > 0;
  // Loop-invariant, so build them once. In baseline mode UNSTABLE moves from
  // "blocked" to "trusted": it is exactly what GitHub reports for a red
  // non-required check, and those failures are cleared as pre-existing below.
  // BLOCKED is only trusted when all failed checks are known baseline failures
  // and GitHub still says the branch is mergeable; DIRTY/BEHIND stay blocking
  // either way.
  const blockedStates = baselineMode
    ? new Set([...BLOCKED_STATES].filter((state) => state !== 'UNSTABLE'))
    : BLOCKED_STATES;
  const trustedStates = baselineMode
    ? new Set([...MERGEABLE_STATES, 'UNSTABLE'])
    : MERGEABLE_STATES;

  const start = now();
  const deadline = start + timeoutSeconds * 1000;
  const graceDeadline = start + graceSeconds * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = getStatus(repoRoot, branch);
    if (!snap) return { status: 'no-pr' };
    // A verdict about the wrong commit is not a verdict. Judge nothing — not
    // green, not even a failure — until the PR head matches the commit we
    // pushed. Fail closed on a missing headSha too: unable to prove the rollup
    // is current is the same risk as knowing it is not.
    if (expectHeadSha && snap.headSha !== expectHeadSha) {
      if (now() >= deadline) return { status: 'stale-head', pr: snap };
      sleep(pollSeconds);
      // eslint-disable-next-line no-continue
      continue;
    }
    const c = snap.checks;
    // A failed or cancelled check is terminal and never a pass — UNLESS it is
    // already failing on the base branch, in which case this change did not
    // introduce it. A failing check with no resolvable name always blocks: an
    // unnameable failure cannot be proven pre-existing.
    const failedNames = Array.isArray(snap.failedNames) ? snap.failedNames : [];
    // Coerce every counter: a snapshot missing one would make the sums NaN, and
    // `NaN > 0` is false — which would wave a failing check straight through.
    const count = (key) => Number(c[key]) || 0;
    const failingCount = count('failed') + count('cancelled');
    const waivedCount = count('waived');
    const billingWaivedNames = Array.isArray(snap.billingWaivedNames)
      ? snap.billingWaivedNames
      : [];
    const namedWaivers = waivedCount > 0 && billingWaivedNames.length === waivedCount;
    const settled = count('pending') === 0;
    const namedFailures = failedNames.length === failingCount;
    const novelFailures = failedNames.filter((name) => !baseline.has(name));
    const onlyBaselineFailures = baselineMode
      && failingCount > 0
      && namedFailures
      && novelFailures.length === 0;
    if (failingCount > 0) {
      if (!baselineMode || !namedFailures || novelFailures.length > 0) {
        return { status: 'checks-failed', pr: snap, newFailures: novelFailures };
      }
    }

    const mss = snap.mergeStateStatus;
    const mergeable = !snap.isDraft && snap.mergeable === 'MERGEABLE';
    // In baseline mode GitHub can still call the PR BLOCKED solely because a
    // known-red, non-required check failed. If every failure is already in the
    // base baseline and GitHub still says the branch is mergeable, that state is
    // the same "no new failures" verdict as UNSTABLE.
    const baselineBlockedByKnownChecks = mss === 'BLOCKED' && mergeable && onlyBaselineFailures;
    const unstableOnlyBecauseBillingChecksWereWaived = mss === 'UNSTABLE'
      && namedWaivers
      && failingCount === 0
      && count('pending') === 0
      && count('other') === 0
      && count('skipped') === 0
      && count('success') + waivedCount === count('total');
    // GitHub says this can't merge as-is. Some BLOCKED/UNSTABLE snapshots are
    // just "required checks are still pending" immediately after a draft PR is
    // promoted to ready, so wait for pending checks to settle before treating
    // those states as terminal. DIRTY/BEHIND do not self-resolve within a finish
    // run and stay immediate blockers.
    if (mss && (mss === 'DIRTY' || mss === 'BEHIND')) {
      return { status: 'merge-blocked', pr: snap };
    }
    if (mss && blockedStates.has(mss) && settled
      && !baselineBlockedByKnownChecks
      && !unstableOnlyBecauseBillingChecksWereWaived) {
      return { status: 'merge-blocked', pr: snap };
    }

    const hasChecks = c.total > 0;
    // Trust GitHub's CLEAN/HAS_HOOKS verdict; with no verdict, demand all-success
    // (every check SUCCESS, zero `other`/ambiguous states).
    //
    // Baseline mode widens both halves by exactly the failures already proven
    // pre-existing: UNSTABLE joins the trusted verdicts, and the no-verdict
    // fallback accounts every check as success-or-cleared-failure. `other` must
    // still be zero either way — an ambiguous state is never a pass.
    const waiversAccountedFor = waivedCount === 0 || namedWaivers;
    const allAccountedFor = waiversAccountedFor && (baselineMode
      ? count('other') === 0
        && count('success') + failingCount + waivedCount === count('total')
      : count('other') === 0
        && count('success') + waivedCount === count('total'));
    const trusted = waiversAccountedFor && (
      baselineBlockedByKnownChecks
      || unstableOnlyBecauseBillingChecksWereWaived
      || (mss ? trustedStates.has(mss) : allAccountedFor)
    );

    if (settled && mergeable && hasChecks && trusted) {
      const result = { status: 'green', pr: snap };
      if (namedWaivers) result.billingWaivedNames = billingWaivedNames;
      return result;
    }
    if (settled && mergeable && !hasChecks && (mss ? MERGEABLE_STATES.has(mss) : true)) {
      if (!requireChecks) return { status: 'green', pr: snap };
      // No checks yet — give CI a grace window to create check runs before
      // concluding the PR is genuinely check-less (avoids the promote->merge race).
      if (now() >= graceDeadline) return { status: 'no-checks', pr: snap };
    }
    if (now() >= deadline) return { status: 'timeout', pr: snap };
    sleep(pollSeconds);
  }
}

/**
 * Files that carried a blocking finding earlier but can no longer be accounted
 * for: not edited by any auto-fix, and not mentioned by the latest review.
 *
 * Exists because provider output varies run to run. Observed in the wild: a HIGH
 * ("the compact card drops the set-total price line") blocked round 2, the fix
 * round edited a different file entirely, and round 3 just did not report it —
 * flipping the gate to pass with the bug still in the branch. Absence of a
 * finding is not evidence of a fix.
 *
 * @param {Set<string>} blockedPaths every file that has held a blocking finding
 * @param {Set<string>} repairedPaths every file an auto-fix actually edited
 * @param {Array<object>} currentFindings the latest review's findings, any severity
 * @returns {string[]} paths whose disappearance is unexplained
 */
function resolveCarriedFindings(blockedPaths, repairedPaths, currentFindings) {
  const stillReported = new Set(
    (Array.isArray(currentFindings) ? currentFindings : [])
      .map((finding) => finding && finding.path)
      .filter(Boolean),
  );
  return [...blockedPaths]
    .filter((path) => !repairedPaths.has(path) && !stillReported.has(path))
    .sort();
}

/**
 * Enforce the merge gate for `branch`. Throws (blocking the merge) unless the PR
 * passes a clean AI review AND green CI AND GitHub reports it mergeable. Returns
 * `{ prNumber }` on pass; the caller then proceeds to the real merge.
 */
function runReviewGate({
  repoRoot, worktreePath, branch, baseBranch, options = {}, progress,
}, deps = {}) {
  const openPullRequest = deps.openPullRequest || pr.openPullRequest;
  const runPrReview = deps.runPrReview || prReview.runPrReview;
  const markReady = deps.markPullRequestReady || pr.markPullRequestReady;
  const markDraft = deps.markPullRequestDraft || pr.markPullRequestDraft;
  const evaluate = deps.evaluateReviewGate || prReview.evaluateReviewGate;
  const resolveThreads = deps.resolveOutdatedReviewThreads || prReview.resolveOutdatedReviewThreads;
  const waitGreen = deps.waitForGreenCi || waitForGreenCi;
  const readBaseline = deps.baselineFailures || pr.baselineFailures;
  const runFix = deps.runReviewFix || reviewFix.runReviewFix;
  const pushBranch = deps.pushBranch || pr.pushBranch;
  const headSha = deps.readHeadSha || readHeadSha;
  const baseSha = deps.readBaseSha || readBaseSha;
  const waitHead = deps.waitForPullRequestHead || waitForPullRequestHead;

  const provider = options.reviewProvider || 'codex';
  const requireChecks = !options.allowNoChecks;
  // Fix rounds are opt-in and bounded: an unfixable finding must fall through to
  // the block rather than spin the provider forever.
  const maxFixRounds = options.gateAutofix ? Math.max(1, options.gateAutofixRounds || 1) : 0;
  // Fixes are edits to the checked-out branch, so they run in the worktree that
  // holds it — repoRoot may be the primary checkout sitting on a protected base.
  const fixCwd = worktreePath || resolveWorktreeForBranch(repoRoot, branch);

  // 1. Ensure a PR exists (push + open as draft, so promoting to ready is what
  //    starts CI and we control when that happens).
  reportProgress(progress, 'start', 'pr', 'pushing branch and opening or reusing a PR');
  let opened;
  try {
    opened = openPullRequest({ repoRoot, branch, base: baseBranch, push: true });
  } catch (error) {
    reportProgress(progress, 'fail', 'pr', error.message);
    throw error;
  }
  const prNumber = opened.pr.number;
  const initialHeadSha = headSha(fixCwd);
  const reviewedBaseSha = baseSha(fixCwd, baseBranch);
  if (!reviewedBaseSha) {
    throw new Error('review gate: cannot resolve the remote base commit. Refusing to merge.');
  }
  const initialHeadSync = waitHead(repoRoot, branch, initialHeadSha, {
    timeoutSeconds: options.gateHeadTimeoutSeconds,
    pollSeconds: options.gateHeadPollSeconds,
  });
  if (initialHeadSync.status !== 'current') {
    const seen = initialHeadSync.pr?.headSha || 'unknown';
    reportProgress(progress, 'fail', 'pr', `PR head is still ${seen}`);
    throw new Error(
      `review gate: PR #${prNumber} still reports head ${seen}, not the pushed commit `
      + `${initialHeadSha || 'unknown'}. Refusing to review a stale PR diff.`,
    );
  }
  reportProgress(progress, 'complete', 'pr', `PR #${prNumber}`);
  gateLog(`PR #${prNumber}: enforcing review + CI gate before merge`);

  // 1b. The default keeps the PR draft while review is pending. The explicit
  //     `--no-gate-serial-ci` fast mode promotes first so CI overlaps the review:
  //     draft state is the only GitHub-side hard barrier this gate controls before
  //     its verdict, so even green CI cannot be merged manually or by automation.
  //     Undefined stays serial as a fail-safe for direct/internal callers.
  const serialCi = options.gateSerialCi !== false;
  if (serialCi && opened.pr.isDraft === false) {
    requireGhAction(
      markDraft(repoRoot, prNumber),
      `review gate: could not hold PR #${prNumber} as draft before review. Refusing to merge.`,
    );
    gateLog(`PR #${prNumber}: held as draft while the review runs`);
  }
  if (!serialCi) {
    requireGhAction(
      markReady(repoRoot, prNumber),
      `review gate: could not promote PR #${prNumber} before review. Refusing to merge.`,
    );
    gateLog(`PR #${prNumber}: promoted to ready — CI runs alongside the review`);
  }

  // 2. AI review — FAIL CLOSED. A provider error / timeout / unparseable output
  //    throws here; convert it to a block, never a silent pass.
  //
  //    With --gate-autofix, a dirty verdict gets up to `maxFixRounds` repair
  //    rounds: fix in the worktree, push, then RE-REVIEW with a fresh provider
  //    run so the fixer never grades its own homework.
  let review;
  let verdict;
  // Files that have ever carried a BLOCKING finding, and files an auto-fix has
  // actually edited. A blocking finding that vanishes from a later round is only
  // treated as repaired when its file was touched — see resolveCarriedFindings.
  const blockedPaths = new Set();
  const repairedPaths = new Set();
  let autofixAttempted = false;
  // Pin CI from the first review, and advance only after a reviewed autofix.
  let pushedHeadSha = initialHeadSha;
  for (let round = 0; round <= maxFixRounds; round += 1) {
    reportProgress(
      progress,
      'start',
      'review',
      `round ${round + 1}/${maxFixRounds + 1} via ${provider}`,
    );
    try {
      review = runPrReview({
        target: repoRoot,
        pr: prNumber,
        provider,
        post: true,
        model: options.reviewModel,
        timeoutMs: options.reviewTimeoutMs,
      });
    } catch (err) {
      reportProgress(progress, 'fail', 'review', err.message);
      throw new Error(
        `review gate: AI review did not complete (${err.message}). Refusing to merge. `
        + 'Fix the provider/auth issue or rerun with --skip-review-gate.',
      );
    }
    // Evidence check, before anything is spent on this review. A review that
    // did not reach the PR cannot be audited afterwards, and a provider that
    // returned nothing then looks exactly like a clean pass — which is how
    // lifted.sk-storefront #463, #465 and #466 each merged carrying zero
    // reviews while this gate announced it was enforcing one.
    //
    // Here rather than after the loop: `posted` is known the moment the first
    // review returns and its cause does not change between rounds, so deferring
    // would burn every --gate-autofix round and push agent-authored fix commits
    // before refusing. It also keeps the error honest when the review is both
    // unposted and dirty, where the blocking-findings message would otherwise
    // send the operator to a PR that has no review on it.
    try {
      requirePostedReview(review, prNumber);
    } catch (error) {
      reportProgress(progress, 'fail', 'review', error.message);
      throw error;
    }

    verdict = evaluate(review.findings);
    for (const finding of verdict.blocking) {
      if (finding && finding.path) blockedPaths.add(finding.path);
    }
    if (verdict.clean || round === maxFixRounds) break;

    gateLog(`PR #${prNumber}: ${verdict.blocking.length} blocking finding(s) — auto-fix round ${round + 1}/${maxFixRounds}`);
    autofixAttempted = true;
    reportProgress(
      progress,
      'start',
      'autofix',
      `round ${round + 1}/${maxFixRounds}: ${verdict.blocking.length} blocking finding(s)`,
    );
    let fix;
    try {
      fix = runFix({
        repoRoot: fixCwd, provider, findings: verdict.blocking, expectBranch: branch,
      });
    } catch (err) {
      reportProgress(progress, 'fail', 'autofix', err.message);
      gateLog(`auto-fix failed: ${err.message}`);
      break;
    }
    if (fix.status !== 'fixed') {
      reportProgress(progress, 'fail', 'autofix', fix.reason || fix.status);
      gateLog(`auto-fix changed nothing (${fix.reason || fix.status})`);
      break;
    }
    for (const changed of fix.changedFiles) repairedPaths.add(changed);
    gateLog(`auto-fix committed ${fix.changedFiles.length} file(s): ${fix.changedFiles.slice(0, 5).join(', ')}`);
    const pushed = pushBranch(fixCwd, branch);
    if (!pushed.ok) {
      reportProgress(progress, 'fail', 'autofix', 'push failed');
      gateLog(`push after auto-fix failed: ${pushed.output}`);
      break;
    }
    pushedHeadSha = headSha(fixCwd);
    const headSync = waitHead(repoRoot, branch, pushedHeadSha, {
      timeoutSeconds: options.gateHeadTimeoutSeconds,
      pollSeconds: options.gateHeadPollSeconds,
    });
    if (headSync.status !== 'current') {
      const seen = headSync.pr?.headSha || 'unknown';
      reportProgress(progress, 'fail', 'autofix', `PR head is still ${seen}`);
      throw new Error(
        `review gate: PR #${prNumber} still reports head ${seen}, not the auto-fix commit `
        + `${pushedHeadSha || 'unknown'}. Refusing to re-review a stale PR diff.`,
      );
    }
    reportProgress(progress, 'complete', 'autofix', `${fix.changedFiles.length} file(s) fixed and pushed`);
  }

  if (!verdict.clean) {
    reportProgress(progress, 'fail', 'review', `${verdict.blocking.length} blocking finding(s) remain`);
    if (!autofixAttempted) {
      reportProgress(progress, 'skip', 'autofix', maxFixRounds > 0 ? 'no repair round completed' : 'disabled');
    }
    const detail = verdict.blocking
      .map((f) => `  - ${String(f.severity).toUpperCase()} ${f.path}:${f.line} ${f.message}`)
      .join('\n');
    throw new Error(
      `review gate: ${verdict.blocking.length} blocking finding(s). Refusing to merge.\n${detail}\n`
      + (maxFixRounds > 0
        ? 'Auto-fix did not clear them. Fix manually or rerun with --skip-review-gate.'
        : 'Fix the findings, rerun with --gate-autofix to let the agent repair them, or bypass with --skip-review-gate.'),
    );
  }

  // A clean final verdict is not enough on its own. Review providers are
  // nondeterministic: a blocking finding can simply fail to reappear in a later
  // round, and reading that silence as "repaired" merges the bug. Every file
  // that ever blocked must either still be under review or have actually been
  // edited by a fix.
  const unexplained = resolveCarriedFindings(blockedPaths, repairedPaths, review.findings);
  if (unexplained.length > 0) {
    reportProgress(progress, 'fail', 'review', `${unexplained.length} finding(s) disappeared without a matching edit`);
    throw new Error(
      `review gate: ${unexplained.length} earlier blocking finding(s) disappeared without their file being changed. `
      + `Refusing to merge — a finding that is merely absent from a later review is not a fixed finding.\n`
      + unexplained.map((p) => `  - ${p} (blocked earlier, never edited, no current finding)`).join('\n')
      + '\nRe-run the review, fix these by hand, or bypass with --skip-review-gate.',
    );
  }
  const threadResolution = resolveThreads(prNumber, repoRoot, review.findings);
  if (threadResolution.ok === false) {
    gateLog(
      `PR #${prNumber}: could not inspect outdated GitGuardex review threads`
      + `${threadResolution.output ? ` (${threadResolution.output})` : ''}; merge-state gate remains authoritative`,
    );
  } else if (threadResolution.resolved > 0) {
    gateLog(`PR #${prNumber}: resolved ${threadResolution.resolved} outdated GitGuardex review thread(s)`);
  }
  reportProgress(
    progress,
    'complete',
    'review',
    `clean review posted${threadResolution.resolved > 0 ? `; ${threadResolution.resolved} stale thread(s) resolved` : ''}`,
  );
  if (!autofixAttempted) {
    reportProgress(progress, 'skip', 'autofix', 'not needed');
  }
  gateLog(
    `PR #${prNumber}: review clean (${review.findings.length} non-blocking finding(s)), posted to the PR`,
  );

  // 3. Promote draft -> ready so required CI checks fire. Already done in step
  //    1b unless serial CI held the draft barrier until the review came in clean.
  if (serialCi) {
    requireGhAction(
      markReady(repoRoot, prNumber),
      `review gate: could not promote PR #${prNumber} after a clean review. Refusing to merge.`,
    );
    gateLog(`PR #${prNumber}: promoted to ready after a clean review`);
  }

  // 4. Wait for CI to settle green + GitHub to report mergeable. waitForGreenCi
  //    is fully fail-closed (failed/cancelled checks, blocked mergeStateStatus,
  //    timeout, and check-less PRs all return non-green statuses).
  //    With --gate-baseline, checks already red on the base branch are excluded
  //    from that judgement, so a repo whose base is red can still gate on the
  //    only question that matters: does this change ADD a failure?
  let baselineFailures = new Set();
  if (options.gateBaseline) {
    const baseline = readBaseline(repoRoot, baseBranch);
    baselineFailures = baseline.failing;
    gateLog(baselineFailures.size > 0
      ? `baseline from ${baseline.source}: ${baselineFailures.size} check(s) already failing — [${[...baselineFailures].join(', ')}]`
      : `baseline from ${baseline.source}: no known failures — every failing check counts as new`);
  }

  reportProgress(progress, 'start', 'ci', 'waiting for required GitHub checks');
  let ci;
  try {
    ci = waitGreen(repoRoot, branch, {
      timeoutSeconds: options.gateTimeoutSeconds,
      pollSeconds: options.gatePollSeconds,
      requireChecks,
      baselineFailures,
      expectHeadSha: pushedHeadSha,
    });
  } catch (error) {
    reportProgress(progress, 'fail', 'ci', error.message);
    throw error;
  }
  if (ci.status === 'checks-failed') {
    reportProgress(progress, 'fail', 'ci', 'checks failed or were cancelled');
    const novel = Array.isArray(ci.newFailures) && ci.newFailures.length > 0
      ? ` New failure(s) vs '${baseBranch}': ${ci.newFailures.join(', ')}.`
      : '';
    throw new Error(
      `review gate: CI checks failed/cancelled on PR #${prNumber}. Refusing to merge.${novel}`
      + (options.gateBaseline ? '' : ' Pass --gate-baseline to ignore failures already red on the base branch.'),
    );
  }
  if (ci.status === 'merge-blocked') {
    const mss = (ci.pr && ci.pr.mergeStateStatus) || 'BLOCKED';
    reportProgress(progress, 'fail', 'ci', `mergeStateStatus=${mss}`);
    throw new Error(
      `review gate: GitHub reports mergeStateStatus=${mss} for PR #${prNumber} `
      + '(not mergeable under branch protection). Refusing to merge.',
    );
  }
  if (ci.status === 'no-checks') {
    reportProgress(progress, 'fail', 'ci', 'no CI checks configured');
    throw new Error(
      `review gate: PR #${prNumber} has no CI checks configured. Refusing to merge an `
      + 'unverified PR. Pass --allow-no-checks to override.',
    );
  }
  if (ci.status === 'stale-head') {
    const seen = (ci.pr && ci.pr.headSha) || 'unknown';
    reportProgress(progress, 'fail', 'ci', `stale PR head ${seen}`);
    throw new Error(
      `review gate: PR #${prNumber} still reports head ${seen}, not the auto-fix commit `
      + `${pushedHeadSha}. Refusing to merge — the checks GitHub is reporting describe a `
      + 'commit that push replaced, so their green says nothing about the code being merged.',
    );
  }
  if (ci.status === 'timeout') {
    reportProgress(progress, 'fail', 'ci', 'timed out');
    throw new Error(`review gate: timed out waiting for CI to go green on PR #${prNumber}.`);
  }
  if (ci.status !== 'green') {
    reportProgress(progress, 'fail', 'ci', ci.status);
    throw new Error(`review gate: PR #${prNumber} not in a mergeable state (${ci.status}).`);
  }

  if (headSha(fixCwd) !== pushedHeadSha || baseSha(fixCwd, baseBranch) !== reviewedBaseSha) {
    throw new Error('review gate: source or base changed during review. Rerun the review gate before merging.');
  }
  const revision = { reviewedHeadSha: pushedHeadSha, reviewedBaseSha };
  const mss = ci.pr && ci.pr.mergeStateStatus;
  const billingChecksWaived = Array.isArray(ci.billingWaivedNames)
    ? ci.billingWaivedNames
    : [];
  if (billingChecksWaived.length > 0) {
    reportProgress(
      progress,
      'complete',
      'ci',
      `${billingChecksWaived.length} GitHub billing-blocked check(s) waived; local preflight required`,
    );
    gateLog(
      `PR #${prNumber}: review clean; GitHub billing prevented [${billingChecksWaived.join(', ')}] from starting. `
      + 'Proceeding only with mandatory repository preflight.',
    );
    return { prNumber, ...revision, billingChecksWaived };
  }
  reportProgress(progress, 'complete', 'ci', `green${mss ? `, mergeStateStatus=${mss}` : ''}`);
  gateLog(`PR #${prNumber}: review clean + CI green${mss ? ` + mergeStateStatus=${mss}` : ''} — proceeding to merge`);
  return { prNumber, ...revision };
}

module.exports = {
  runReviewGate,
  resolveCarriedFindings,
  waitForGreenCi,
  waitForPullRequestHead,
  DEFAULT_GATE_TIMEOUT_SECONDS,
  MERGEABLE_STATES,
};
