#!/usr/bin/env bash
set -euo pipefail

BASE_BRANCH=""
BASE_BRANCH_EXPLICIT=0
SOURCE_BRANCH=""
PUSH_ENABLED=1
DELETE_REMOTE_BRANCH=0
DELETE_REMOTE_BRANCH_EXPLICIT=0
MERGE_MODE="auto"
GH_BIN="${GUARDEX_GH_BIN:-gh}"
NODE_BIN="${GUARDEX_NODE_BIN:-node}"
CLI_ENTRY="${GUARDEX_CLI_ENTRY:-}"
FINISH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CLEANUP_AFTER_MERGE_RAW="${GUARDEX_FINISH_CLEANUP:-true}"
WAIT_FOR_MERGE_RAW="${GUARDEX_FINISH_WAIT_FOR_MERGE:-true}"
WAIT_TIMEOUT_SECONDS_RAW="${GUARDEX_FINISH_WAIT_TIMEOUT_SECONDS:-1800}"
WAIT_POLL_SECONDS_RAW="${GUARDEX_FINISH_WAIT_POLL_SECONDS:-10}"
PARENT_GITLINK_AUTO_COMMIT_RAW="${GUARDEX_FINISH_PARENT_GITLINK_AUTO_COMMIT:-true}"
AUTO_RESOLVE_MODE_RAW="${GUARDEX_FINISH_AUTO_RESOLVE:-none}"
AUTO_RESOLVE_SAFE_GLOBS_DEFAULT='.omc/**:.omx/state/**:.dev-ports.json:apps/logs/**:.codex/settings.local.json:.claude/settings.local.json:.codex/state/**:.claude/state/**'
AUTO_RESOLVE_SAFE_GLOBS_RAW="${GUARDEX_FINISH_AUTO_RESOLVE_SAFE_GLOBS-$AUTO_RESOLVE_SAFE_GLOBS_DEFAULT}"
RECONCILE_OPENSPEC_TASKS_RAW="${GUARDEX_FINISH_RECONCILE_OPENSPEC_TASKS:-true}"
OPENSPEC_TASKS_RECONCILER="${GUARDEX_FINISH_OPENSPEC_TASKS_RECONCILER:-${FINISH_SCRIPT_DIR}/agent-reconcile-openspec-tasks.js}"
PREFLIGHT_ENABLED_RAW="${GUARDEX_FINISH_PREFLIGHT:-true}"
PREFLIGHT_SCRIPT_RAW="${GUARDEX_FINISH_PREFLIGHT_SCRIPT:-scripts/agent-preflight.sh}"
PREFLIGHT_REQUIRED_RAW="${GUARDEX_FINISH_REQUIRE_PREFLIGHT:-false}"
PREFLIGHT_CACHE_ENABLED_RAW="${GUARDEX_FINISH_PREFLIGHT_CACHE:-true}"
AUTO_PROMOTE_DRAFT_RAW="${GUARDEX_FINISH_AUTO_PROMOTE:-true}"
FINISH_CHECKLIST_RAW="${GUARDEX_FINISH_CHECKLIST:-false}"
FINISH_GATE_DONE_RAW="${GUARDEX_FINISH_GATE_DONE:-false}"
FINISH_EVENT_FILE="${GUARDEX_FINISH_EVENT_FILE:-}"
FINISH_RUN_ID="${GUARDEX_FINISH_RUN_ID:-}"
FINISH_EVENT_BRANCH="${GUARDEX_FINISH_EVENT_BRANCH:-}"
FINISH_EVENT_BASE="${GUARDEX_FINISH_EVENT_BASE:-}"
# Only an explicit --auto-promote FLAG lifts a persisted merge hold; the env
# default (or GUARDEX_FINISH_AUTO_PROMOTE=1) must not, or any unflagged
# re-run would silently lift holds placed by earlier runs.
AUTO_PROMOTE_EXPLICIT=0

run_guardex_cli() {
  if [[ -n "$CLI_ENTRY" ]]; then
    "$NODE_BIN" "$CLI_ENTRY" "$@"
    return $?
  fi
  if command -v gx >/dev/null 2>&1; then
    gx "$@"
    return $?
  fi
  if command -v gitguardex >/dev/null 2>&1; then
    gitguardex "$@"
    return $?
  fi
  echo "[agent-branch-finish] Guardex CLI entrypoint unavailable; rerun via gx." >&2
  return 127
}

normalize_bool() {
  local raw="${1:-}"
  local fallback="${2:-0}"
  local lowered
  lowered="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    1|true|yes|on) printf '1' ;;
    0|false|no|off) printf '0' ;;
    '') printf '%s' "$fallback" ;;
    *) printf '%s' "$fallback" ;;
  esac
}

normalize_int() {
  local raw="${1:-}"
  local fallback="${2:-0}"
  local min_value="${3:-0}"
  local value="$raw"

  if [[ -z "$value" || ! "$value" =~ ^[0-9]+$ ]]; then
    value="$fallback"
  fi

  if (( value < min_value )); then
    value="$min_value"
  fi

  printf '%s' "$value"
}

finish_json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

finish_event() {
  local stage="${1:-}"
  local state="${2:-}"
  local number="${3:-0}"
  local label="${4:-}"
  local detail="${5:-}"
  local timestamp=""
  [[ -n "$FINISH_EVENT_FILE" && -n "$FINISH_RUN_ID" ]] || return 0
  timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '{"schemaVersion":1,"runId":"%s","timestamp":"%s","branch":"%s","baseBranch":"%s","stage":"%s","state":"%s","index":%s,"total":8,"label":"%s","detail":"%s"}\n' \
    "$(finish_json_escape "$FINISH_RUN_ID")" \
    "$timestamp" \
    "$(finish_json_escape "$FINISH_EVENT_BRANCH")" \
    "$(finish_json_escape "$FINISH_EVENT_BASE")" \
    "$(finish_json_escape "$stage")" \
    "$(finish_json_escape "$state")" \
    "$number" \
    "$(finish_json_escape "$label")" \
    "$(finish_json_escape "$detail")" \
    >> "$FINISH_EVENT_FILE" 2>/dev/null || true
}

finish_progress() {
  local state="${1:-running}"
  local stage="${2:-}"
  local detail="${3:-}"
  local number=""
  local label=""
  local symbol="🔄"
  local connector="├─"
  [[ "${FINISH_CHECKLIST:-0}" -eq 1 ]] || return 0

  case "$stage" in
    preflight) number="2"; label="Local preflight" ;;
    pr) number="3"; label="Push and open PR" ;;
    merge) number="7"; label="Merge" ;;
    cleanup) number="8"; label="Cleanup" ;;
    *) return 0 ;;
  esac
  case "$state" in
    complete) symbol="✅" ;;
    skipped) symbol="⏭" ;;
    failed) symbol="❌" ;;
    finished) symbol="🏁" ;;
  esac
  if [[ "$stage" == "cleanup" && "$state" != "running" ]]; then
    connector="╰─"
  fi
  echo "[gx:finish] ${connector} ${symbol} ${number}/8  ${label}${detail:+ · ${detail}}" >&2
  finish_event "$stage" "$state" "$number" "$label" "$detail"
}

# Resolve the pre-flight script path. Required relative scripts run from a
# temporary archive of the trusted base ref so script-relative helpers are also
# trusted; optional relative scripts retain worktree behavior.
resolve_preflight_script() {
  local worktree="$1"
  local configured="$2"
  if [[ -z "$configured" ]]; then
    configured="scripts/agent-preflight.sh"
  fi
  if [[ "${PREFLIGHT_REQUIRED:-0}" -eq 1 ]]; then
    configured="${configured#./}"
    if [[ -z "$configured" || "$configured" = /* || "$configured" == ".." || "$configured" == ../*
      || "$configured" == */../* || "$configured" == */.. ]]; then
      return 0
    fi
    local trusted_tree=""
    trusted_tree="$(mktemp -d "${TMPDIR:-/tmp}/guardex-preflight.XXXXXX")" || return 0
    if git -C "$worktree" archive "$start_ref" 2>/dev/null | tar -x -C "$trusted_tree" 2>/dev/null; then
      local trusted_script="${trusted_tree}/${configured}"
      local trusted_script_real=""
      trusted_script_real="$(realpath -e -- "$trusted_script" 2>/dev/null || true)"
      if [[ -n "$trusted_script_real" && "$trusted_script_real" == "$trusted_tree/"* && -x "$trusted_script_real" ]]; then
        trusted_script="$trusted_script_real"
        printf '%s' "$trusted_script"
        return 0
      fi
    fi
    rm -rf -- "$trusted_tree"
    return 0
  fi
  if [[ "$configured" = /* ]]; then
    if [[ -x "$configured" ]]; then
      printf '%s' "$configured"
    fi
    return 0
  fi
  local candidate="${worktree}/${configured}"
  if [[ -x "$candidate" ]]; then
    printf '%s' "$candidate"
  fi
}

# Bind a reusable success receipt to every input that can change the result.
# The receipt is per source branch and is overwritten when HEAD, the base ref,
# or the configured preflight script changes. Mandatory billing-waiver
# preflights deliberately bypass this cache and always execute fail-closed.
preflight_cache_fingerprint() {
  local worktree="$1"
  local script_path="$2"
  local source_sha=""
  local base_sha=""
  local script_sha=""

  source_sha="$(git -C "$worktree" rev-parse 'HEAD^{commit}' 2>/dev/null || true)"
  base_sha="$(git -C "$worktree" rev-parse "${start_ref}^{commit}" 2>/dev/null || true)"
  script_sha="$(git -C "$worktree" hash-object --no-filters "$script_path" 2>/dev/null || true)"
  if [[ -z "$source_sha" || -z "$base_sha" || -z "$script_sha" ]]; then
    return 0
  fi

  printf 'guardex-preflight-cache-v1\n%s\n%s\n%s\n%s\n' \
    "$source_sha" "$base_sha" "$PREFLIGHT_SCRIPT_RAW" "$script_sha" \
    | git -C "$worktree" hash-object --stdin 2>/dev/null || true
}

preflight_cache_receipt_path() {
  local worktree="$1"
  local common_git_dir=""
  local branch_name=""
  local branch_key=""

  common_git_dir="$(git -C "$worktree" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -z "$common_git_dir" ]]; then
    return 0
  fi
  if [[ "$common_git_dir" != /* ]]; then
    common_git_dir="${worktree}/${common_git_dir}"
  fi
  branch_name="${SOURCE_BRANCH:-$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null || true)}"
  if [[ -z "$branch_name" ]]; then
    return 0
  fi
  branch_key="$(printf '%s' "$branch_name" | git -C "$worktree" hash-object --stdin 2>/dev/null || true)"
  if [[ -z "$branch_key" ]]; then
    return 0
  fi

  printf '%s/guardex/preflight-cache/%s.receipt' "$common_git_dir" "$branch_key"
}

write_preflight_cache_receipt() {
  local receipt_path="$1"
  local fingerprint="$2"
  local receipt_dir=""
  local temporary_receipt=""

  [[ -n "$receipt_path" && -n "$fingerprint" ]] || return 0
  receipt_dir="$(dirname "$receipt_path")"
  mkdir -p "$receipt_dir" 2>/dev/null || return 0
  temporary_receipt="${receipt_path}.$$"
  if printf '%s\n' "$fingerprint" > "$temporary_receipt" 2>/dev/null; then
    mv -f "$temporary_receipt" "$receipt_path" 2>/dev/null || rm -f "$temporary_receipt"
  else
    rm -f "$temporary_receipt"
  fi
}

# Run the pre-flight verification gate in the agent worktree before
# any push happens. Returns 0 on success or when no gate is
# configured; returns non-zero (and prints a hint) on failure, which
# the caller propagates so the push is refused.
run_preflight() {
  local worktree="$1"
  if [[ "$PREFLIGHT_ENABLED" -ne 1 ]]; then
    if [[ "$PREFLIGHT_REQUIRED" -eq 1 ]]; then
      finish_progress failed preflight "required because GitHub billing checks were waived"
      echo "[agent-branch-finish] Billing-waived GitHub checks require local pre-flight; --no-preflight is not allowed." >&2
      return 1
    fi
    finish_progress skipped preflight "disabled by flag"
    return 0
  fi
  local script_path
  script_path="$(resolve_preflight_script "$worktree" "$PREFLIGHT_SCRIPT_RAW")"
  if [[ -z "$script_path" ]]; then
    if [[ "$PREFLIGHT_REQUIRED" -eq 1 ]]; then
      finish_progress failed preflight "required executable script missing"
      echo "[agent-branch-finish] Billing-waived GitHub checks require a target-aware pre-flight script at ${PREFLIGHT_SCRIPT_RAW} in trusted base ${start_ref}; refusing push." >&2
      return 1
    fi
    finish_progress skipped preflight "no executable pre-flight script"
    echo "[agent-branch-finish] No executable pre-flight script at ${PREFLIGHT_SCRIPT_RAW} (in ${worktree}); skipping pre-flight." >&2
    return 0
  fi
  finish_progress running preflight "final verification before publish"
  echo "[agent-branch-finish] Running pre-flight: ${script_path}" >&2
  local preflight_cwd="$worktree"
  local trusted_tree=""
  if [[ "$PREFLIGHT_REQUIRED" -eq 1 && "$PREFLIGHT_SCRIPT_RAW" != /* ]]; then
    local relative_configured="${PREFLIGHT_SCRIPT_RAW#./}"
    local trusted_prefix="${TMPDIR:-/tmp}/guardex-preflight."
    if [[ "$script_path" != "$trusted_prefix"*"/$relative_configured" ]]; then
      finish_progress failed preflight "trusted execution tree missing"
      echo "[agent-branch-finish] Mandatory pre-flight did not resolve inside its trusted base archive; refusing push." >&2
      return 1
    fi
    local trusted_tree_length=$((${#script_path} - ${#relative_configured} - 1))
    trusted_tree="${script_path:0:$trusted_tree_length}"
    preflight_cwd="$trusted_tree"
    local capabilities=""
    capabilities="$(cd "$preflight_cwd" && "$script_path" --guardex-capabilities 2>/dev/null || true)"
    if [[ "$capabilities" != "guardex-target-worktree-v1" ]]; then
      rm -rf -- "$trusted_tree"
      finish_progress failed preflight "trusted script does not support the target-worktree protocol"
      echo "[agent-branch-finish] Mandatory pre-flight must implement guardex-target-worktree-v1; refusing push." >&2
      return 1
    fi
  fi
  local cache_fingerprint=""
  local cache_receipt_path=""
  local cached_fingerprint=""
  if [[ "${PREFLIGHT_CACHE_ENABLED:-1}" -eq 1 && "$PREFLIGHT_REQUIRED" -ne 1 ]]; then
    cache_fingerprint="$(preflight_cache_fingerprint "$worktree" "$script_path")"
    cache_receipt_path="$(preflight_cache_receipt_path "$worktree")"
    if [[ -n "$cache_fingerprint" && -n "$cache_receipt_path" && -f "$cache_receipt_path" ]]; then
      cached_fingerprint="$(head -n 1 "$cache_receipt_path" 2>/dev/null || true)"
      if [[ "$cached_fingerprint" == "$cache_fingerprint" ]]; then
        if [[ -n "$trusted_tree" ]]; then
          rm -rf -- "$trusted_tree"
        fi
        finish_progress complete preflight "cached pass"
        echo "[agent-branch-finish] Pre-flight unchanged; reusing cached successful result." >&2
        return 0
      fi
    fi
  fi
  local preflight_status=0
  if [[ -n "$trusted_tree" ]]; then
    ( cd "$preflight_cwd" && "$script_path" --guardex-target-worktree "$worktree" ) || preflight_status=$?
  else
    ( cd "$preflight_cwd" && GUARDEX_PREFLIGHT_TARGET_WORKTREE="$worktree" "$script_path" ) || preflight_status=$?
  fi
  if [[ -n "$trusted_tree" ]]; then
    rm -rf -- "$trusted_tree"
  fi
  if [[ "$preflight_status" -eq 0 ]]; then
    write_preflight_cache_receipt "$cache_receipt_path" "$cache_fingerprint"
    finish_progress complete preflight "passed"
    echo "[agent-branch-finish] Pre-flight passed." >&2
    return 0
  fi
  finish_progress failed preflight "failed"
  echo "[agent-branch-finish] Pre-flight FAILED; refusing push. Override with --no-preflight if you really mean it." >&2
  return 1
}

# Persisted merge hold. The hold must bind EVERY finish run on the lane, not
# just the one that placed it — otherwise any unflagged re-run (the Claude
# stop hook, the doctor auto-finish sweep, `gx finish --all`) would promote
# the draft and merge, recreating exactly the incident the hold exists to
# prevent. The durable artifact is a marker in the PR body; only an explicit
# --auto-promote finish lifts it.
HOLD_MARKER='guardex:merge-hold'
HOLD_MARKER_COMMENT="<!-- ${HOLD_MARKER} -->"

# Marker state for the PR selected by $1 (URL or branch).
# Returns: 0 = marker present; 1 = no marker; 2 = PR body unreadable (no PR,
# gh missing, transient failure). Callers pick the failure direction: the PR
# flow fails CLOSED (unknown => held), the direct-push guard fails open
# (unknown usually means "no PR at all").
pr_hold_marker_state() {
  local body
  if ! body="$("$GH_BIN" pr view "$1" --json body --jq '.body' 2>/dev/null)"; then
    return 2
  fi
  if grep -qF "$HOLD_MARKER_COMMENT" <<<"$body"; then
    return 0
  fi
  return 1
}

place_hold_marker() {
  local pr_url="$1" body
  if ! body="$("$GH_BIN" pr view "$pr_url" --json body --jq '.body' 2>/dev/null)"; then
    echo "[agent-branch-finish] Warning: could not read the PR body; NOT writing the ${HOLD_MARKER} marker (refusing to clobber the body). The hold will NOT survive an unflagged re-run." >&2
    return 0
  fi
  if grep -qF "$HOLD_MARKER_COMMENT" <<<"$body"; then
    return 0
  fi
  if ! "$GH_BIN" pr edit "$pr_url" --body "${body}"$'\n\n'"${HOLD_MARKER_COMMENT}" >/dev/null 2>&1; then
    echo "[agent-branch-finish] Warning: could not write the ${HOLD_MARKER} marker to the PR body; the hold will NOT survive an unflagged re-run of the finish flow." >&2
  fi
}

# Returns non-zero when the marker could not be removed, in which case the
# caller must keep treating the PR as held.
remove_hold_marker() {
  local pr_url="$1" body
  if ! body="$("$GH_BIN" pr view "$pr_url" --json body --jq '.body' 2>/dev/null)"; then
    echo "[agent-branch-finish] Warning: could not read the PR body to remove the ${HOLD_MARKER} marker; the hold remains in force." >&2
    return 1
  fi
  if ! grep -qF "$HOLD_MARKER_COMMENT" <<<"$body"; then
    return 0
  fi
  body="$(printf '%s\n' "$body" | grep -vF "$HOLD_MARKER_COMMENT")"
  if ! "$GH_BIN" pr edit "$pr_url" --body "$body" >/dev/null 2>&1; then
    echo "[agent-branch-finish] Warning: could not remove the ${HOLD_MARKER} marker; the hold remains in force." >&2
    return 1
  fi
}

# After a PR exists, if it is in draft and auto-promote is enabled,
# mark it ready-for-review. With the budget-friendly CI defaults
# (draft PRs skip CI), this is the moment when CI is allowed to fire.
maybe_auto_promote_pr() {
  local pr_url="$1"
  if [[ -z "$pr_url" ]] || [[ "$AUTO_PROMOTE_DRAFT" -ne 1 ]]; then
    return 0
  fi
  if ! command -v "$GH_BIN" >/dev/null 2>&1; then
    return 0
  fi
  local is_draft
  is_draft="$("$GH_BIN" pr view "$pr_url" --json isDraft --jq '.isDraft' 2>/dev/null || true)"
  if [[ "$is_draft" != "true" ]]; then
    return 0
  fi
  echo "[agent-branch-finish] PR is draft; promoting to ready-for-review (pre-flight passed)." >&2
  if "$GH_BIN" pr ready "$pr_url" >/dev/null 2>&1; then
    echo "[agent-branch-finish] PR marked ready-for-review." >&2
  else
    echo "[agent-branch-finish] gh pr ready failed; PR left in draft. Promote manually if intended." >&2
  fi
}

CLEANUP_AFTER_MERGE="$(normalize_bool "$CLEANUP_AFTER_MERGE_RAW" "1")"
WAIT_FOR_MERGE="$(normalize_bool "$WAIT_FOR_MERGE_RAW" "1")"
WAIT_TIMEOUT_SECONDS="$(normalize_int "$WAIT_TIMEOUT_SECONDS_RAW" "1800" "30")"
WAIT_POLL_SECONDS="$(normalize_int "$WAIT_POLL_SECONDS_RAW" "10" "0")"
PARENT_GITLINK_AUTO_COMMIT="$(normalize_bool "$PARENT_GITLINK_AUTO_COMMIT_RAW" "1")"
FINISH_CHECKLIST="$(normalize_bool "$FINISH_CHECKLIST_RAW" "0")"
FINISH_GATE_DONE="$(normalize_bool "$FINISH_GATE_DONE_RAW" "0")"
PREFLIGHT_REQUIRED="$(normalize_bool "$PREFLIGHT_REQUIRED_RAW" "0")"
RECONCILE_OPENSPEC_TASKS="$(normalize_bool "$RECONCILE_OPENSPEC_TASKS_RAW" "1")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      echo "Usage: $0 [--base <branch>] [--branch <branch>] [--no-push] [--cleanup|--no-cleanup] [--wait-for-merge|--no-wait-for-merge] [--wait-timeout-seconds <n>] [--wait-poll-seconds <n>] [--parent-gitlink-commit|--no-parent-gitlink-commit] [--keep-remote-branch|--delete-remote-branch] [--mode auto|direct|pr|--via-pr|--direct-only] [--auto-resolve[=none|safe|full]|--no-auto-resolve] [--no-preflight|--preflight] [--preflight-script <path>] [--no-auto-promote|--auto-promote]"
      exit 0
      ;;
    --base)
      BASE_BRANCH="${2:-}"
      BASE_BRANCH_EXPLICIT=1
      shift 2
      ;;
    --branch)
      SOURCE_BRANCH="${2:-}"
      shift 2
      ;;
    --no-push)
      PUSH_ENABLED=0
      shift
      ;;
    --keep-remote-branch)
      DELETE_REMOTE_BRANCH=0
      DELETE_REMOTE_BRANCH_EXPLICIT=1
      shift
      ;;
    --delete-remote-branch)
      DELETE_REMOTE_BRANCH=1
      DELETE_REMOTE_BRANCH_EXPLICIT=1
      shift
      ;;
    --cleanup)
      CLEANUP_AFTER_MERGE=1
      shift
      ;;
    --no-cleanup)
      CLEANUP_AFTER_MERGE=0
      shift
      ;;
    --wait-for-merge)
      WAIT_FOR_MERGE=1
      shift
      ;;
    --no-wait-for-merge)
      WAIT_FOR_MERGE=0
      shift
      ;;
    --wait-timeout-seconds)
      WAIT_TIMEOUT_SECONDS="$(normalize_int "${2:-}" "1800" "30")"
      shift 2
      ;;
    --wait-poll-seconds)
      WAIT_POLL_SECONDS="$(normalize_int "${2:-}" "10" "0")"
      shift 2
      ;;
    --parent-gitlink-commit)
      PARENT_GITLINK_AUTO_COMMIT=1
      shift
      ;;
    --no-parent-gitlink-commit)
      PARENT_GITLINK_AUTO_COMMIT=0
      shift
      ;;
    --mode)
      MERGE_MODE="${2:-auto}"
      shift 2
      ;;
    --via-pr)
      MERGE_MODE="pr"
      shift
      ;;
    --direct-only)
      MERGE_MODE="direct"
      shift
      ;;
    --auto-resolve)
      if [[ "${2:-}" =~ ^(none|safe|full)$ ]]; then
        AUTO_RESOLVE_MODE_RAW="$2"
        shift 2
      else
        AUTO_RESOLVE_MODE_RAW="safe"
        shift
      fi
      ;;
    --auto-resolve=*)
      AUTO_RESOLVE_MODE_RAW="${1#--auto-resolve=}"
      shift
      ;;
    --no-auto-resolve)
      AUTO_RESOLVE_MODE_RAW="none"
      shift
      ;;
    --no-preflight)
      PREFLIGHT_ENABLED_RAW="false"
      shift
      ;;
    --preflight)
      PREFLIGHT_ENABLED_RAW="true"
      shift
      ;;
    --preflight-script)
      PREFLIGHT_SCRIPT_RAW="${2:-}"
      shift 2
      ;;
    --no-auto-promote)
      AUTO_PROMOTE_DRAFT_RAW="false"
      AUTO_PROMOTE_EXPLICIT=0
      shift
      ;;
    --auto-promote)
      AUTO_PROMOTE_DRAFT_RAW="true"
      AUTO_PROMOTE_EXPLICIT=1
      shift
      ;;
    *)
      echo "[agent-branch-finish] Unknown argument: $1" >&2
      echo "Usage: $0 [--base <branch>] [--branch <branch>] [--no-push] [--cleanup|--no-cleanup] [--wait-for-merge|--no-wait-for-merge] [--wait-timeout-seconds <n>] [--wait-poll-seconds <n>] [--parent-gitlink-commit|--no-parent-gitlink-commit] [--keep-remote-branch|--delete-remote-branch] [--mode auto|direct|pr|--via-pr|--direct-only] [--auto-resolve[=none|safe|full]|--no-auto-resolve] [--no-preflight|--preflight] [--preflight-script <path>] [--no-auto-promote|--auto-promote]" >&2
      exit 1
      ;;
  esac
done

# Normalize toggles whose flags set the RAW value DURING the parse loop
# (--no-preflight/--preflight, --no-auto-promote/--auto-promote). These MUST be
# normalized AFTER the loop — doing it before (as the env-only defaults above do)
# silently ignored the flags, leaving --no-preflight inert. Flags that set the
# normalized var directly in-loop (--cleanup, --wait-for-merge, ...) are unaffected.
PREFLIGHT_ENABLED="$(normalize_bool "$PREFLIGHT_ENABLED_RAW" "1")"
PREFLIGHT_CACHE_ENABLED="$(normalize_bool "$PREFLIGHT_CACHE_ENABLED_RAW" "1")"
AUTO_PROMOTE_DRAFT="$(normalize_bool "$AUTO_PROMOTE_DRAFT_RAW" "1")"

if [[ "$CLEANUP_AFTER_MERGE" -eq 1 && "$DELETE_REMOTE_BRANCH_EXPLICIT" -eq 0 ]]; then
  DELETE_REMOTE_BRANCH=1
fi

case "$MERGE_MODE" in
  auto|direct|pr) ;;
  *)
    echo "[agent-branch-finish] Invalid --mode value: ${MERGE_MODE} (expected auto|direct|pr)" >&2
    exit 1
    ;;
esac

# --no-auto-promote is a merge hold: the PR must stay open (draft when the
# host supports it) until someone deliberately promotes + merges it. A direct
# push would land the commit with no PR to hold, so the hold forces the PR
# path and refuses --direct-only outright.
MERGE_HELD=0
if [[ "$AUTO_PROMOTE_DRAFT" -ne 1 ]]; then
  if [[ "$MERGE_MODE" == "direct" ]]; then
    echo "[agent-branch-finish] The merge hold (set via --no-auto-promote or GUARDEX_FINISH_AUTO_PROMOTE=0) keeps the merge behind a PR; it cannot be combined with --direct-only. Pass --auto-promote to override." >&2
    exit 1
  fi
  MERGE_MODE="pr"
fi

AUTO_RESOLVE_MODE="$(printf '%s' "$AUTO_RESOLVE_MODE_RAW" | tr '[:upper:]' '[:lower:]')"
case "$AUTO_RESOLVE_MODE" in
  none|safe|full) ;;
  *)
    echo "[agent-branch-finish] Invalid --auto-resolve value: ${AUTO_RESOLVE_MODE_RAW} (expected none|safe|full)" >&2
    exit 1
    ;;
esac

path_matches_auto_resolve_safe_glob() {
  local path="$1"
  if [[ -z "${AUTO_RESOLVE_SAFE_GLOBS_RAW:-}" ]]; then
    return 1
  fi
  local -a globs=()
  IFS=':' read -ra globs <<< "$AUTO_RESOLVE_SAFE_GLOBS_RAW"
  local pattern rewritten
  for pattern in "${globs[@]}"; do
    [[ -z "$pattern" ]] && continue
    rewritten="${pattern%/**}"
    if [[ "$rewritten" != "$pattern" ]]; then
      if [[ "$path" == "$rewritten"/* ]]; then
        return 0
      fi
    else
      # shellcheck disable=SC2053
      if [[ "$path" == $pattern ]]; then
        return 0
      fi
    fi
  done
  return 1
}

is_openspec_change_tasks_path() {
  local conflict_path="$1"
  [[ "$conflict_path" =~ ^openspec/changes/[^/]+/tasks\.md$ ]]
}

try_reconcile_openspec_tasks_conflict() {
  local worktree="$1"
  local conflict_path="$2"
  [[ "$RECONCILE_OPENSPEC_TASKS" -eq 1 ]] || return 1
  is_openspec_change_tasks_path "$conflict_path" || return 1
  if [[ ! -f "$OPENSPEC_TASKS_RECONCILER" ]]; then
    echo "[agent-branch-finish] OpenSpec tasks reconciler missing: ${OPENSPEC_TASKS_RECONCILER}" >&2
    return 1
  fi
  "$NODE_BIN" "$OPENSPEC_TASKS_RECONCILER" "$worktree" "$conflict_path" >/dev/null
}

validate_reconciled_openspec_tasks() {
  local worktree="$1"
  local reconciled_paths="$2"
  local conflict_path=""
  local change_name=""
  if ! command -v openspec >/dev/null 2>&1; then
    echo "[agent-branch-finish] openspec CLI unavailable; deterministic tasks.md validation passed, spec validation skipped." >&2
    return 0
  fi
  while IFS= read -r conflict_path; do
    [[ -z "$conflict_path" ]] && continue
    if ! is_openspec_change_tasks_path "$conflict_path"; then
      echo "[agent-branch-finish] Refusing to validate unexpected reconciled path: ${conflict_path}" >&2
      return 1
    fi
    change_name="${conflict_path#openspec/changes/}"
    change_name="${change_name%/tasks.md}"
    if ! (cd "$worktree" && openspec validate "$change_name" --type change --strict --no-interactive >/dev/null); then
      echo "[agent-branch-finish] OpenSpec validation failed for change '${change_name}' after tasks.md reconciliation; leaving the Git operation for manual repair." >&2
      return 1
    fi
  done < <(printf '%s' "$reconciled_paths" | sort -u)
}

try_finish_rebase_with_openspec_tasks() {
  local worktree="$1"
  local git_dir=""
  local conflict_files=""
  local conflict_path=""
  local resolved_paths=""
  local resolved_round=""

  git_dir="$(git -C "$worktree" rev-parse --absolute-git-dir 2>/dev/null || true)"
  while [[ -n "$git_dir" && ( -e "${git_dir}/rebase-merge" || -e "${git_dir}/rebase-apply" ) ]]; do
    conflict_files="$(git -C "$worktree" diff --name-only --diff-filter=U || true)"
    [[ -n "$conflict_files" ]] || return 1
    resolved_round=""
    while IFS= read -r conflict_path; do
      [[ -z "$conflict_path" ]] && continue
      if ! try_reconcile_openspec_tasks_conflict "$worktree" "$conflict_path"; then
        return 1
      fi
      resolved_round+="${conflict_path}"$'\n'
      resolved_paths+="${conflict_path}"$'\n'
    done <<< "$conflict_files"

    while IFS= read -r conflict_path; do
      [[ -n "$conflict_path" ]] && run_guardex_cli locks claim --branch "$SOURCE_BRANCH" "$conflict_path" >/dev/null 2>&1 || true
    done <<< "$resolved_round"
    validate_reconciled_openspec_tasks "$worktree" "$resolved_round" || return 1

    if ! GIT_EDITOR=true git -C "$worktree" rebase --continue >/dev/null 2>&1; then
      git_dir="$(git -C "$worktree" rev-parse --absolute-git-dir 2>/dev/null || true)"
      if [[ -e "${git_dir}/rebase-merge" || -e "${git_dir}/rebase-apply" ]]; then
        continue
      fi
      return 1
    fi
    git_dir="$(git -C "$worktree" rev-parse --absolute-git-dir 2>/dev/null || true)"
  done

  [[ -n "$resolved_paths" ]] || return 1
  echo "[agent-sync-guard] Automatically reconciled OpenSpec task progress during rebase:" >&2
  printf '%s' "$resolved_paths" | sort -u | sed 's/^/  - /' >&2
}

# Resolve a conflicting submodule pointer if and only if one side is a strict
# ancestor of the other (fast-forward direction). Writes the resolved SHA via
# git update-index and prints the chosen SHA on stdout. Returns 0 on success,
# 1 on uninitialized/divergent/unreachable cases.
try_resolve_submodule_pointer_conflict() {
  local repo_root_arg="$1"
  local source_worktree_arg="$2"
  local conflict_path="$3"

  # Confirm registered submodule path.
  if [[ ! -f "$repo_root_arg/.gitmodules" ]]; then
    return 1
  fi
  if ! git -C "$repo_root_arg" config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null \
       | awk '{print $2}' | grep -Fxq -- "$conflict_path"; then
    return 1
  fi

  # Read the three stages from the index.
  local stage_out
  stage_out="$(git -C "$source_worktree_arg" ls-files -u -- "$conflict_path" 2>/dev/null || true)"
  if [[ -z "$stage_out" ]]; then
    return 1
  fi

  local base_sha="" ours_sha="" theirs_sha=""
  local mode_field stage_sha stage_num path_field
  while IFS=$'\t' read -r meta path_field; do
    [[ -z "$meta" || -z "$path_field" ]] && continue
    # meta format: "<mode> <sha> <stage>"
    read -r mode_field stage_sha stage_num <<< "$meta"
    [[ "$mode_field" != "160000" ]] && return 1
    case "$stage_num" in
      1) base_sha="$stage_sha" ;;
      2) ours_sha="$stage_sha" ;;
      3) theirs_sha="$stage_sha" ;;
    esac
  done <<< "$stage_out"

  if [[ -z "$ours_sha" || -z "$theirs_sha" ]]; then
    return 1
  fi

  # Pick a working clone for the submodule. Three sources, in order:
  #   1) checked-out submodule worktree (cheap, no network)
  #   2) cached internal clone at .git/modules/<name>
  #   3) temp bare clone from the submodule URL (last resort; needs network)
  local sub_query_dir=""
  local sub_dir="$source_worktree_arg/$conflict_path"
  if [[ -d "$sub_dir" ]] && git -C "$sub_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    sub_query_dir="$sub_dir"
  else
    local repo_git_dir
    repo_git_dir="$(git -C "$source_worktree_arg" rev-parse --git-common-dir 2>/dev/null || true)"
    if [[ -n "$repo_git_dir" && -d "$repo_git_dir/modules/$conflict_path" ]]; then
      sub_query_dir="$repo_git_dir/modules/$conflict_path"
    fi
  fi

  local temp_sub_clone=""
  cleanup_temp_sub_clone() {
    [[ -n "$temp_sub_clone" && -d "$temp_sub_clone" ]] && rm -rf "$temp_sub_clone"
  }
  trap cleanup_temp_sub_clone RETURN

  if [[ -z "$sub_query_dir" ]]; then
    local sub_url
    sub_url="$(git -C "$repo_root_arg" config -f .gitmodules --get "submodule.${conflict_path}.url" 2>/dev/null || true)"
    if [[ -z "$sub_url" ]]; then
      return 1
    fi
    temp_sub_clone="$(mktemp -d -t gx-submod-resolve-XXXXXX 2>/dev/null || true)"
    if [[ -z "$temp_sub_clone" || ! -d "$temp_sub_clone" ]]; then
      return 1
    fi
    if ! git clone --quiet --bare "$sub_url" "$temp_sub_clone" >/dev/null 2>&1; then
      return 1
    fi
    sub_query_dir="$temp_sub_clone"
  fi

  if ! git -C "$sub_query_dir" cat-file -e "${ours_sha}^{commit}" 2>/dev/null \
     || ! git -C "$sub_query_dir" cat-file -e "${theirs_sha}^{commit}" 2>/dev/null; then
    git -C "$sub_query_dir" fetch --quiet --all 2>/dev/null || true
  fi
  if ! git -C "$sub_query_dir" cat-file -e "${ours_sha}^{commit}" 2>/dev/null \
     || ! git -C "$sub_query_dir" cat-file -e "${theirs_sha}^{commit}" 2>/dev/null; then
    return 1
  fi

  local chosen_sha=""
  if [[ "$ours_sha" == "$theirs_sha" ]]; then
    chosen_sha="$ours_sha"
  elif git -C "$sub_query_dir" merge-base --is-ancestor "$ours_sha" "$theirs_sha" 2>/dev/null; then
    chosen_sha="$theirs_sha"
  elif git -C "$sub_query_dir" merge-base --is-ancestor "$theirs_sha" "$ours_sha" 2>/dev/null; then
    chosen_sha="$ours_sha"
  else
    # Divergent histories; refuse.
    return 1
  fi

  if ! git -C "$source_worktree_arg" update-index --cacheinfo "160000,${chosen_sha},${conflict_path}" >/dev/null 2>&1; then
    return 1
  fi

  printf '%s' "$chosen_sha"
  return 0
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "[agent-branch-finish] Not inside a git repository." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
finish_active_cwd="${GUARDEX_FINISH_ACTIVE_CWD:-$(pwd -P)}"
if [[ -d "$finish_active_cwd" ]]; then
  finish_active_cwd="$(cd "$finish_active_cwd" && pwd -P)"
else
  finish_active_cwd=""
fi
# The physical cwd may be a subdirectory inside the source worktree. Cleanup
# decisions need the enclosing worktree root, otherwise finishing from `src/`
# can delete the caller's cwd and turn a successful merge into a false shell
# failure.
current_worktree="$repo_root"
common_git_dir_raw="$(git -C "$repo_root" rev-parse --git-common-dir)"
if [[ "$common_git_dir_raw" == /* ]]; then
  common_git_dir="$common_git_dir_raw"
else
  common_git_dir="$(cd "$repo_root/$common_git_dir_raw" && pwd -P)"
fi
repo_common_root="$(cd "$common_git_dir/.." && pwd -P)"

resolve_same_repo_worktree_for_cwd() {
  local active_cwd="$1"
  [[ -n "$active_cwd" && -d "$active_cwd" ]] || return 0
  git -C "$active_cwd" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0

  local active_worktree=""
  active_worktree="$(git -C "$active_cwd" rev-parse --show-toplevel 2>/dev/null || true)"
  [[ -n "$active_worktree" ]] || return 0

  local active_common_raw=""
  local active_common_dir=""
  active_common_raw="$(git -C "$active_worktree" rev-parse --git-common-dir 2>/dev/null || true)"
  [[ -n "$active_common_raw" ]] || return 0
  if [[ "$active_common_raw" == /* ]]; then
    active_common_dir="$active_common_raw"
  else
    active_common_dir="${active_worktree}/${active_common_raw}"
  fi
  active_common_dir="$(cd "$active_common_dir" 2>/dev/null && pwd -P)" || return 0

  if [[ "$active_common_dir" == "$common_git_dir" ]]; then
    cd "$active_worktree" 2>/dev/null && pwd -P
  fi
}

active_cwd_worktree="$(resolve_same_repo_worktree_for_cwd "$finish_active_cwd")"
if [[ -n "$active_cwd_worktree" ]]; then
  current_worktree="$active_cwd_worktree"
fi

if [[ -z "$SOURCE_BRANCH" ]]; then
  SOURCE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

stored_worktree_root_rel="$(git -C "$repo_root" config --get "branch.${SOURCE_BRANCH}.guardexWorktreeRoot" || true)"
if [[ -z "$stored_worktree_root_rel" ]]; then
  stored_worktree_root_rel=".omx/agent-worktrees"
fi
agent_worktree_root="${repo_root}/${stored_worktree_root_rel}"
runtime_state_root_rel="$(dirname "$stored_worktree_root_rel")"
temp_worktree_root="${repo_common_root}/${runtime_state_root_rel}/.tmp-worktrees"

if [[ "$BASE_BRANCH_EXPLICIT" -eq 1 && -z "$BASE_BRANCH" ]]; then
  echo "[agent-branch-finish] --base requires a non-empty branch name." >&2
  exit 1
fi

if [[ "$BASE_BRANCH_EXPLICIT" -eq 0 ]]; then
  source_branch_base="$(git -C "$repo_root" config --get "branch.${SOURCE_BRANCH}.guardexBase" || true)"
  if [[ -n "$source_branch_base" ]]; then
    BASE_BRANCH="$source_branch_base"
  else
    configured_base="$(git -C "$repo_root" config --get multiagent.baseBranch || true)"
    if [[ -n "$configured_base" ]]; then
      BASE_BRANCH="$configured_base"
    fi
  fi
fi

if [[ -z "$BASE_BRANCH" ]]; then
  for fallback_branch in dev main master; do
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/${fallback_branch}" \
      || git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${fallback_branch}"; then
      BASE_BRANCH="$fallback_branch"
      break
    fi
  done
fi

if [[ -z "$BASE_BRANCH" ]]; then
  BASE_BRANCH="dev"
fi

if [[ "$SOURCE_BRANCH" == "$BASE_BRANCH" ]]; then
  echo "[agent-branch-finish] Source branch and base branch are both '$BASE_BRANCH'." >&2
  echo "[agent-branch-finish] Switch to your agent branch or pass --branch <agent-branch>." >&2
  exit 1
fi

cleanup_missing_merged_source_branch() {
  local state_line=""
  local parsed_state=""
  local parsed_merged_at=""
  local parsed_url=""
  local remote_delete_output=""
  local prune_args=()

  if [[ "$MERGE_MODE" != "pr" || "$CLEANUP_AFTER_MERGE" -ne 1 ]]; then
    return 1
  fi
  if ! command -v "$GH_BIN" >/dev/null 2>&1; then
    return 1
  fi

  state_line="$("$GH_BIN" pr list \
    --state merged \
    --head "$SOURCE_BRANCH" \
    --base "$BASE_BRANCH" \
    --json state,mergedAt,url \
    --jq 'sort_by(.mergedAt // "") | reverse | (.[0] // {}) | [(.state // ""), (.mergedAt // ""), (.url // "")] | join("\u001f")' \
    2>/dev/null || true)"
  if [[ -z "$state_line" ]]; then
    return 1
  fi

  IFS=$'\x1f' read -r parsed_state parsed_merged_at parsed_url <<< "$state_line"
  if [[ "$parsed_state" != "MERGED" && -z "$parsed_merged_at" ]]; then
    return 1
  fi

  echo "[agent-branch-finish] Local source branch '${SOURCE_BRANCH}' is already absent, but a merged PR exists; continuing cleanup." >&2
  if [[ -n "$parsed_url" ]]; then
    echo "[agent-branch-finish] Merged PR: ${parsed_url}" >&2
  fi

  run_guardex_cli locks release --branch "$SOURCE_BRANCH" >/dev/null 2>&1 || true

  if [[ "$PUSH_ENABLED" -eq 1 && "$DELETE_REMOTE_BRANCH" -eq 1 ]]; then
    if git -C "$repo_root" ls-remote --exit-code --heads origin "$SOURCE_BRANCH" >/dev/null 2>&1; then
      if ! remote_delete_output="$(git -C "$repo_root" push origin --delete "$SOURCE_BRANCH" 2>&1)"; then
        echo "[agent-branch-finish] Warning: remote branch cleanup failed for '${SOURCE_BRANCH}'." >&2
        [[ -n "$remote_delete_output" ]] && echo "$remote_delete_output" >&2
      fi
    fi
  fi

  prune_args=(worktree prune --base "$BASE_BRANCH" --only-dirty-worktrees --delete-branches)
  if [[ "$DELETE_REMOTE_BRANCH" -eq 1 ]]; then
    prune_args+=(--delete-remote-branches)
  fi
  if ! run_guardex_cli "${prune_args[@]}"; then
    echo "[agent-branch-finish] Warning: automatic worktree prune failed." >&2
    echo "[agent-branch-finish] You can run manual cleanup: gx cleanup --base ${BASE_BRANCH}" >&2
  fi

  echo "[agent-branch-finish] Merged '${SOURCE_BRANCH}' into '${BASE_BRANCH}' via pr flow and found source branch/worktree already cleaned."
  exit 0
}

if ! git -C "$repo_root" show-ref --verify --quiet "refs/heads/${SOURCE_BRANCH}"; then
  cleanup_missing_merged_source_branch
  echo "[agent-branch-finish] Local source branch does not exist: ${SOURCE_BRANCH}" >&2
  exit 1
fi

get_worktree_for_branch() {
  local branch="$1"
  git -C "$repo_root" worktree list --porcelain | awk -v target="refs/heads/${branch}" -v probe_prefix="${temp_worktree_root}/__source-probe-" '
    $1 == "worktree" { wt = $2 }
    $1 == "branch" && $2 == target {
      if (index(wt, probe_prefix) != 1) {
        print wt
        exit
      }
    }
  '
}

remove_stale_source_probe_worktrees() {
  local branch="$1"
  local stale_probe=""

  while IFS= read -r stale_probe; do
    [[ -z "$stale_probe" ]] && continue
    [[ "$stale_probe" == "$current_worktree" ]] && continue

    echo "[agent-branch-finish] Removing stale source-probe worktree for '${branch}': ${stale_probe}" >&2
    git -C "$stale_probe" rebase --abort >/dev/null 2>&1 || true
    git -C "$stale_probe" merge --abort >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove "$stale_probe" --force >/dev/null 2>&1 || true
  done < <(
    git -C "$repo_root" worktree list --porcelain | awk -v target="refs/heads/${branch}" -v probe_prefix="${temp_worktree_root}/__source-probe-" '
      $1 == "worktree" { wt = $2 }
      $1 == "branch" && $2 == target {
        if (index(wt, probe_prefix) == 1) {
          print wt
        }
      }
    '
  )
}

is_clean_worktree() {
  local wt="$1"
  git -C "$wt" diff --quiet -- . ":(exclude).omx/state/agent-file-locks.json" \
    && git -C "$wt" diff --cached --quiet -- . ":(exclude).omx/state/agent-file-locks.json"
}

refresh_clean_base_worktree() {
  local wt="$1"
  local pull_output=""
  [[ -z "$wt" || "$PUSH_ENABLED" -ne 1 ]] && return 0

  if pull_output="$(GUARDEX_DISABLE_POST_MERGE_CLEANUP=1 GUARDEX_PRUNE_ACTIVE_CWD="$finish_active_cwd" git -C "$wt" -c rebase.autoStash=false -c merge.autostash=false pull --ff-only origin "$BASE_BRANCH" 2>&1)"; then
    echo "[agent-branch-finish] Refreshed local ${BASE_BRANCH} worktree with 'git pull --ff-only origin ${BASE_BRANCH}': ${wt}"
  else
    echo "[agent-branch-finish] Warning: failed to refresh local ${BASE_BRANCH} worktree with 'git pull --ff-only origin ${BASE_BRANCH}': ${wt}" >&2
    if [[ -n "$pull_output" ]]; then
      echo "$pull_output" >&2
    fi
  fi
}

remove_stale_source_probe_worktrees "$SOURCE_BRANCH"
source_worktree="$(get_worktree_for_branch "$SOURCE_BRANCH")"
created_source_probe=0
source_probe_path=""
integration_worktree=""
integration_branch=""
merge_completed=0
merge_status="pr"
direct_push_error=""
pr_url=""
changed_submodule_push_done=0

cleanup() {
  if [[ -n "$integration_worktree" && -d "$integration_worktree" ]]; then
    git -C "$repo_root" worktree remove "$integration_worktree" --force >/dev/null 2>&1 || true
  fi
  if [[ -n "${integration_branch:-}" ]]; then
    git -C "$repo_root" branch -D "$integration_branch" >/dev/null 2>&1 || true
  fi
  if [[ "$created_source_probe" -eq 1 && -n "$source_probe_path" && -d "$source_probe_path" ]]; then
    # Abort any in-progress git op so `worktree remove --force` succeeds on conflict-stuck probes.
    git -C "$source_probe_path" rebase --abort >/dev/null 2>&1 || true
    git -C "$source_probe_path" merge --abort >/dev/null 2>&1 || true
    git -C "$repo_root" worktree remove "$source_probe_path" --force >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "$source_worktree" ]]; then
  source_probe_path="${temp_worktree_root}/__source-probe-${SOURCE_BRANCH//\//__}-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$(dirname "$source_probe_path")"
  git -C "$repo_root" worktree add "$source_probe_path" "$SOURCE_BRANCH" >/dev/null
  source_worktree="$source_probe_path"
  created_source_probe=1
fi

if ! is_clean_worktree "$source_worktree"; then
  echo "[agent-branch-finish] Source worktree is not clean for '${SOURCE_BRANCH}': ${source_worktree}" >&2
  echo "[agent-branch-finish] Commit/stash changes on the source branch before finishing." >&2
  exit 1
fi

assert_reviewed_revision() {
  [[ "$FINISH_GATE_DONE" -eq 1 ]] || return 0
  local head base branch status
  head="$(git -C "$source_worktree" rev-parse HEAD)" || return 1
  branch="$(git -C "$source_worktree" symbolic-ref --quiet --short HEAD)" || return 1
  status="$(git -C "$source_worktree" status --porcelain)" || return 1
  base="$(git -C "$repo_root" ls-remote --exit-code origin "refs/heads/$BASE_BRANCH")" || return 1
  base="${base%%[[:space:]]*}"
  if [[ "$MERGE_MODE" != "pr" || "$branch" != "$SOURCE_BRANCH" || -z "${GUARDEX_FINISH_REVIEWED_HEAD:-}" || -z "${GUARDEX_FINISH_REVIEWED_BASE:-}" \
    || "$head" != "$GUARDEX_FINISH_REVIEWED_HEAD" || "$base" != "$GUARDEX_FINISH_REVIEWED_BASE" ]]; then
    echo "[agent-branch-finish] Reviewed revision changed or missing. Rerun the review gate; refusing synchronization, push, and merge." >&2
    return 1
  fi
  if [[ -n "$status" ]]; then
    echo "[agent-branch-finish] Reviewed revision has uncommitted changes. Rerun the review gate." >&2
    return 1
  fi
}

merge_head_args=()
if [[ "$FINISH_GATE_DONE" -eq 1 ]]; then
  assert_reviewed_revision || exit 1
  merge_head_args=(--match-head-commit "$GUARDEX_FINISH_REVIEWED_HEAD")
fi

start_ref="$BASE_BRANCH"
if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  git -C "$repo_root" fetch origin "$BASE_BRANCH" --quiet
  start_ref="origin/${BASE_BRANCH}"
fi

# A successful gate authorizes one revision, not automatic synchronization.
# Keep BOTH rebase and the conflict-reconciliation merge probe outside that gate.
if [[ "$FINISH_GATE_DONE" -ne 1 ]]; then
require_before_finish_raw="$(git -C "$repo_root" config --get multiagent.sync.requireBeforeFinish || true)"
if [[ -z "$require_before_finish_raw" ]]; then
  require_before_finish_raw="true"
fi
require_before_finish="$(printf '%s' "$require_before_finish_raw" | tr '[:upper:]' '[:lower:]')"
should_require_sync=0
case "$require_before_finish" in
  1|true|yes|on) should_require_sync=1 ;;
  0|false|no|off) should_require_sync=0 ;;
  *) should_require_sync=1 ;;
esac

if [[ "$should_require_sync" -eq 1 ]] && git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  behind_count="$(git -C "$repo_root" rev-list --left-right --count "${SOURCE_BRANCH}...origin/${BASE_BRANCH}" 2>/dev/null | awk '{print $2}')"
  behind_count="${behind_count:-0}"
  if [[ "$behind_count" -gt 0 ]]; then
    echo "[agent-sync-guard] Branch '${SOURCE_BRANCH}' is behind origin/${BASE_BRANCH} by ${behind_count} commit(s)." >&2
    echo "[agent-sync-guard] Auto-syncing '${SOURCE_BRANCH}' onto origin/${BASE_BRANCH} before finish..." >&2
    if ! git -C "$source_worktree" rebase "origin/${BASE_BRANCH}"; then
      rebase_reconciled=0
      if try_finish_rebase_with_openspec_tasks "$source_worktree"; then
        rebase_reconciled=1
      fi
      if [[ "$rebase_reconciled" -eq 1 ]]; then
        echo "[agent-sync-guard] Auto-sync completed after safe OpenSpec tasks.md reconciliation." >&2
      else
        git_dir="$(git -C "$source_worktree" rev-parse --absolute-git-dir)"
        rebase_active=0
        if [[ -e "${git_dir}/rebase-merge" || -e "${git_dir}/rebase-apply" ]]; then
          rebase_active=1
        fi

        echo "[agent-sync-guard] Auto-sync failed while rebasing '${SOURCE_BRANCH}' onto origin/${BASE_BRANCH}." >&2
        if [[ "$rebase_active" -eq 1 ]]; then
          if [[ "$created_source_probe" -eq 1 ]]; then
            echo "[agent-sync-guard] Temporary source-probe worktree will be cleaned up on exit." >&2
            echo "[agent-sync-guard] Reattach '${SOURCE_BRANCH}' in a regular worktree, then rebase it onto origin/${BASE_BRANCH} manually." >&2
          else
            echo "[agent-sync-guard] Resolve conflicts, then run: git -C \"$source_worktree\" rebase --continue" >&2
            echo "[agent-sync-guard] Or abort: git -C \"$source_worktree\" rebase --abort" >&2
          fi
        fi
        exit 1
      fi
    fi

    behind_after="$(git -C "$repo_root" rev-list --left-right --count "${SOURCE_BRANCH}...origin/${BASE_BRANCH}" 2>/dev/null | awk '{print $2}')"
    behind_after="${behind_after:-0}"
    echo "[agent-sync-guard] Auto-sync complete (behind now: ${behind_after})." >&2
  fi
fi

if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  git -C "$source_worktree" fetch origin "$BASE_BRANCH" --quiet

  if ! git -C "$source_worktree" merge --no-commit --no-ff "origin/${BASE_BRANCH}" >/dev/null 2>&1; then
    conflict_files="$(git -C "$source_worktree" diff --name-only --diff-filter=U || true)"
    openspec_tasks_reconciled=""
    while IFS= read -r conflict_path; do
      [[ -z "$conflict_path" ]] && continue
      if try_reconcile_openspec_tasks_conflict "$source_worktree" "$conflict_path"; then
        openspec_tasks_reconciled+="${conflict_path}"$'\n'
      fi
    done <<< "$conflict_files"
    conflict_files="$(git -C "$source_worktree" diff --name-only --diff-filter=U || true)"

    if [[ -z "$conflict_files" && -n "$openspec_tasks_reconciled" ]]; then
      while IFS= read -r resolved_path; do
        [[ -n "$resolved_path" ]] && run_guardex_cli locks claim --branch "$SOURCE_BRANCH" "$resolved_path" >/dev/null 2>&1 || true
      done <<< "$openspec_tasks_reconciled"
      if ! validate_reconciled_openspec_tasks "$source_worktree" "$openspec_tasks_reconciled" \
        || ! git -C "$source_worktree" commit -m "Merge origin/${BASE_BRANCH} into ${SOURCE_BRANCH} (gx reconciled OpenSpec task progress)" >/dev/null 2>&1; then
        git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true
        echo "[agent-branch-finish] Failed to validate or commit reconciled OpenSpec task progress." >&2
        exit 1
      fi
      echo "[agent-branch-finish] Automatically reconciled OpenSpec task progress:" >&2
      printf '%s' "$openspec_tasks_reconciled" | sort -u | sed 's/^/  - /' >&2
    elif [[ "$AUTO_RESOLVE_MODE" != "none" && -n "$conflict_files" ]]; then
      auto_resolve_unresolved=""
      auto_resolve_resolved_state=""
      auto_resolve_resolved_submodules=""
      while IFS= read -r conflict_path; do
        [[ -z "$conflict_path" ]] && continue
        if path_matches_auto_resolve_safe_glob "$conflict_path"; then
          if git -C "$source_worktree" checkout --theirs -- "$conflict_path" >/dev/null 2>&1 \
            && git -C "$source_worktree" add -- "$conflict_path" >/dev/null 2>&1; then
            auto_resolve_resolved_state+="${conflict_path}"$'\n'
            continue
          fi
        fi
        if [[ "$AUTO_RESOLVE_MODE" == "full" ]]; then
          if chosen_sha="$(try_resolve_submodule_pointer_conflict "$repo_root" "$source_worktree" "$conflict_path")"; then
            auto_resolve_resolved_submodules+="${conflict_path}@${chosen_sha}"$'\n'
            continue
          fi
        fi
        auto_resolve_unresolved+="${conflict_path}"$'\n'
      done <<< "$conflict_files"

      if [[ -n "$auto_resolve_unresolved" ]]; then
        git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true
        echo "[agent-branch-finish] --auto-resolve=${AUTO_RESOLVE_MODE}: some conflicts are outside the safe allowlist (or submodule histories diverge); aborting." >&2
        echo "[agent-branch-finish] Unresolved conflicts:" >&2
        while IFS= read -r unresolved_path; do
          [[ -n "$unresolved_path" ]] && echo "  - ${unresolved_path}" >&2
        done <<< "$auto_resolve_unresolved"
        echo "[agent-branch-finish] State-file allowlist (GUARDEX_FINISH_AUTO_RESOLVE_SAFE_GLOBS): ${AUTO_RESOLVE_SAFE_GLOBS_RAW}" >&2
        if [[ "$AUTO_RESOLVE_MODE" != "full" ]]; then
          echo "[agent-branch-finish] Submodule pointer auto-resolve requires --auto-resolve=full; not enabled for this run." >&2
        fi
        exit 1
      fi

      # Claim resolved paths so the pre-commit lock guard accepts the merge.
      auto_resolve_claim_paths=()
      while IFS= read -r resolved_path; do
        [[ -n "$resolved_path" ]] && auto_resolve_claim_paths+=("$resolved_path")
      done <<< "$auto_resolve_resolved_state"
      while IFS= read -r resolved_entry; do
        [[ -z "$resolved_entry" ]] && continue
        auto_resolve_claim_paths+=("${resolved_entry%@*}")
      done <<< "$auto_resolve_resolved_submodules"
      while IFS= read -r resolved_path; do
        [[ -n "$resolved_path" ]] && auto_resolve_claim_paths+=("$resolved_path")
      done <<< "$openspec_tasks_reconciled"
      if [[ "${#auto_resolve_claim_paths[@]}" -gt 0 ]]; then
        run_guardex_cli locks claim --branch "$SOURCE_BRANCH" "${auto_resolve_claim_paths[@]}" >/dev/null 2>&1 || true
      fi

      auto_resolve_summary="state files -> base, submodule pointers fast-forwarded"
      if [[ -n "$openspec_tasks_reconciled" ]]; then
        auto_resolve_summary="OpenSpec task progress reconciled, ${auto_resolve_summary}"
      fi
      auto_resolve_commit_msg="Merge origin/${BASE_BRANCH} into ${SOURCE_BRANCH} (gx --auto-resolve=${AUTO_RESOLVE_MODE}; ${auto_resolve_summary})"
      if [[ -n "$openspec_tasks_reconciled" ]] \
        && ! validate_reconciled_openspec_tasks "$source_worktree" "$openspec_tasks_reconciled"; then
        git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true
        echo "[agent-branch-finish] OpenSpec validation failed after task reconciliation." >&2
        exit 1
      fi
      if ! git -C "$source_worktree" commit -m "$auto_resolve_commit_msg" >/dev/null 2>&1; then
        git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true
        echo "[agent-branch-finish] --auto-resolve=${AUTO_RESOLVE_MODE}: failed to commit resolved merge (pre-commit hook may have rejected it; verify file locks)." >&2
        exit 1
      fi

      state_count=0
      submod_count=0
      [[ -n "$auto_resolve_resolved_state" ]] && state_count="$(printf '%s' "$auto_resolve_resolved_state" | grep -c '^[^[:space:]]')"
      [[ -n "$auto_resolve_resolved_submodules" ]] && submod_count="$(printf '%s' "$auto_resolve_resolved_submodules" | grep -c '^[^[:space:]]')"
      tasks_count=0
      [[ -n "$openspec_tasks_reconciled" ]] && tasks_count="$(printf '%s' "$openspec_tasks_reconciled" | grep -c '^[^[:space:]]')"
      echo "[agent-branch-finish] --auto-resolve=${AUTO_RESOLVE_MODE}: resolved ${tasks_count} OpenSpec tasks conflict(s), ${state_count} state-file conflict(s), ${submod_count} submodule pointer conflict(s)." >&2
      if [[ -n "$auto_resolve_resolved_state" ]]; then
        echo "[agent-branch-finish] State files (resolved to base):" >&2
        while IFS= read -r resolved_path; do
          [[ -n "$resolved_path" ]] && echo "  - ${resolved_path}" >&2
        done <<< "$auto_resolve_resolved_state"
      fi
      if [[ -n "$auto_resolve_resolved_submodules" ]]; then
        echo "[agent-branch-finish] Submodule pointers (fast-forwarded):" >&2
        while IFS= read -r resolved_entry; do
          [[ -n "$resolved_entry" ]] && echo "  - ${resolved_entry%@*} -> ${resolved_entry##*@}" >&2
        done <<< "$auto_resolve_resolved_submodules"
      fi
    else
      git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true

      echo "[agent-branch-finish] Preflight conflict detected between '${SOURCE_BRANCH}' and latest origin/${BASE_BRANCH}." >&2
      if [[ -n "$conflict_files" ]]; then
        echo "[agent-branch-finish] Conflicting files:" >&2
        while IFS= read -r file; do
          [[ -n "$file" ]] && echo "  - ${file}" >&2
        done <<< "$conflict_files"
      fi
      echo "[agent-branch-finish] Rebase/merge '${BASE_BRANCH}' into '${SOURCE_BRANCH}' and resolve conflicts before finishing." >&2
      echo "[agent-branch-finish] Or rerun with --auto-resolve=safe (state files) or --auto-resolve=full (state files + fast-forward-able submodule pointers)." >&2
      exit 1
    fi
  else
    git -C "$source_worktree" merge --abort >/dev/null 2>&1 || true
  fi
fi

fi

should_create_integration_helper=1
if [[ "$MERGE_MODE" == "pr" && "$PUSH_ENABLED" -eq 1 ]]; then
  should_create_integration_helper=0
fi

if [[ "$should_create_integration_helper" -eq 1 ]]; then
  existing_base_worktree=""
  if [[ "$PUSH_ENABLED" -eq 0 ]]; then
    existing_base_worktree="$(get_worktree_for_branch "$BASE_BRANCH")"
  fi

  if [[ -n "$existing_base_worktree" ]] && is_clean_worktree "$existing_base_worktree"; then
    if ! git -C "$existing_base_worktree" merge --no-ff --no-edit "$SOURCE_BRANCH"; then
      echo "[agent-branch-finish] Merge conflict detected while merging '${SOURCE_BRANCH}' into '${BASE_BRANCH}'." >&2
      git -C "$existing_base_worktree" merge --abort >/dev/null 2>&1 || true
      exit 1
    fi
    merge_completed=1
    merge_status="direct"
  else
    integration_stamp="$(date +%Y%m%d-%H%M%S)"
    integration_worktree_base="${temp_worktree_root}/__integrate-${BASE_BRANCH//\//__}-${integration_stamp}"
    integration_branch_base="__agent_integrate_${BASE_BRANCH//\//_}_$(date +%Y%m%d_%H%M%S)"
    integration_worktree="$integration_worktree_base"
    integration_branch="$integration_branch_base"
    integration_suffix=1
    while [[ -e "$integration_worktree" ]] || git -C "$repo_root" show-ref --verify --quiet "refs/heads/${integration_branch}"; do
      integration_worktree="${integration_worktree_base}-${integration_suffix}"
      integration_branch="${integration_branch_base}_${integration_suffix}"
      integration_suffix=$((integration_suffix + 1))
    done
    mkdir -p "$(dirname "$integration_worktree")"

    git -C "$repo_root" worktree add "$integration_worktree" "$start_ref" >/dev/null
    git -C "$integration_worktree" checkout -b "$integration_branch" >/dev/null

    if ! git -C "$integration_worktree" merge --no-ff --no-edit "$SOURCE_BRANCH"; then
      echo "[agent-branch-finish] Merge conflict detected while merging '${SOURCE_BRANCH}' into '${BASE_BRANCH}'." >&2
      git -C "$integration_worktree" merge --abort >/dev/null 2>&1 || true
      exit 1
    fi

    merge_completed=1
    merge_status="direct"
  fi
fi

# True when `gh pr merge` landed the PR server-side and only its LOCAL cleanup
# failed — the merge succeeded, so the caller must continue rather than retry.
#
# gh reports that cleanup two different ways, and matching only the first costs
# a full WAIT_TIMEOUT_SECONDS wait loop per finish:
#   1. "failed to delete local branch <b>: ... used by worktree ..."
#   2. "failed to run git: fatal: '<base>' is already used by worktree at ..."
# The second comes from the checkout to the base that precedes the delete, and
# it is the NORMAL case here: gitguardex puts every agent on its own worktree
# while the primary checkout sits on the base branch, so `--delete-branch` can
# never check that base out. Treating it as a failed merge sent the flow into
# the retry loop against an already-merged PR (lifted.sk-storefront #512, which
# merged at 21:44:56Z while the finish reported nothing and kept polling).
is_local_branch_delete_error() {
  local output="$1"
  if [[ "$output" == *"failed to delete local branch"* ]]; then
    if [[ "$output" == *"cannot delete branch"* ]] || [[ "$output" == *"used by worktree"* ]]; then
      return 0
    fi
    return 1
  fi
  if [[ "$output" == *"failed to run git"* ]] && [[ "$output" == *"already used by worktree"* ]]; then
    return 0
  fi
  return 1
}

is_remote_branch_missing_error() {
  local output="$1"
  if [[ "$output" == *"remote ref does not exist"* ]]; then
    return 0
  fi
  return 1
}

local_branch_exists() {
  local branch="$1"
  git -C "$repo_root" show-ref --verify --quiet "refs/heads/${branch}"
}

delete_local_branch_for_cleanup() {
  local branch="$1"
  local delete_output=""

  if ! local_branch_exists "$branch"; then
    echo "[agent-branch-finish] Local branch '${branch}' was already deleted; continuing cleanup." >&2
    return 0
  fi

  if delete_output="$(git -C "$repo_root" branch -d "$branch" 2>&1)"; then
    return 0
  fi

  if ! local_branch_exists "$branch"; then
    echo "[agent-branch-finish] Local branch '${branch}' was already deleted; continuing cleanup." >&2
    return 0
  fi

  # `git branch -d` insists on an ancestor link to HEAD. A squash merge — the
  # default this flow uses (`gh pr merge --squash`) — never creates one, so the
  # refusal here is the NORMAL post-merge outcome, not a sign the work is
  # unmerged. GitHub is the authority on that, so ask whether this exact head
  # landed in a merged PR and only then force the delete. When it did not (a
  # rebase during finish, or commits pushed after the merge), fall through and
  # keep the branch rather than destroying commits that never landed.
  if read_merged_pr_for_head "$(git -C "$repo_root" rev-parse "$branch" 2>/dev/null || true)"; then
    if git -C "$repo_root" branch -D "$branch" >/dev/null 2>&1; then
      echo "[agent-branch-finish] Local branch '${branch}' had no ancestor link to '${BASE_BRANCH}' (squash merge), but its head landed in a merged PR; deleted it." >&2
      return 0
    fi
  fi

  echo "$delete_output" >&2
  return 1
}

read_pr_state() {
  local state_line
  state_line="$("$GH_BIN" pr view "$SOURCE_BRANCH" --json state,mergedAt,url --jq '[.state, (.mergedAt // ""), (.url // "")] | join("\u001f")' 2>/dev/null || true)"
  if [[ -z "$state_line" ]]; then
    return 1
  fi

  local parsed_state=""
  local parsed_merged_at=""
  local parsed_url=""
  IFS=$'\x1f' read -r parsed_state parsed_merged_at parsed_url <<< "$state_line"
  PR_STATE="$parsed_state"
  PR_MERGED_AT="$parsed_merged_at"
  if [[ -n "$parsed_url" ]]; then
    pr_url="$parsed_url"
  fi
  return 0
}

read_merged_pr_for_head() {
  local head_sha="${1:-}"
  local state_line=""
  local parsed_state=""
  local parsed_merged_at=""
  local parsed_url=""

  if [[ -z "$head_sha" ]]; then
    return 1
  fi

  state_line="$("$GH_BIN" pr list \
    --state merged \
    --head "$SOURCE_BRANCH" \
    --base "$BASE_BRANCH" \
    --json state,mergedAt,url,headRefOid \
    --jq "map(select(.headRefOid == \"$head_sha\")) | sort_by(.mergedAt // \"\") | reverse | (.[0] // {}) | [(.state // \"\"), (.mergedAt // \"\"), (.url // \"\")] | join(\"\u001f\")" \
    2>/dev/null || true)"
  if [[ -z "$state_line" ]]; then
    return 1
  fi

  IFS=$'\x1f' read -r parsed_state parsed_merged_at parsed_url <<< "$state_line"
  if [[ -z "$parsed_state" && -z "$parsed_merged_at" && -z "$parsed_url" ]]; then
    return 1
  fi
  if [[ "$parsed_state" != "MERGED" && -z "$parsed_merged_at" ]]; then
    return 1
  fi

  PR_STATE="$parsed_state"
  PR_MERGED_AT="$parsed_merged_at"
  if [[ -n "$parsed_url" ]]; then
    pr_url="$parsed_url"
  fi
  return 0
}

maybe_auto_commit_parent_gitlink() {
  local base_wt="${1:-}"
  local base_wt_real=""
  local super_root_raw=""
  local super_root=""
  local subrepo_rel=""
  local gitlink_mode=""
  local gitlink_index_sha=""
  local gitlink_parent_head_sha=""
  local subrepo_head_sha=""
  local update_index_output=""
  local commit_output=""
  local commit_message=""

  if [[ "$PARENT_GITLINK_AUTO_COMMIT" -ne 1 || "$PUSH_ENABLED" -ne 1 ]]; then
    return 0
  fi
  if [[ -z "$base_wt" ]]; then
    return 0
  fi
  if ! base_wt_real="$(cd "$base_wt" && pwd -P 2>/dev/null)"; then
    return 0
  fi
  if [[ "$base_wt_real" != "$repo_common_root" ]]; then
    return 0
  fi
  if ! is_clean_worktree "$repo_common_root"; then
    echo "[agent-branch-finish] Parent gitlink auto-commit skipped; nested base worktree is dirty: ${repo_common_root}" >&2
    return 0
  fi

  super_root_raw="$(git -C "$repo_common_root" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  if [[ -z "$super_root_raw" ]]; then
    return 0
  fi
  if ! super_root="$(cd "$super_root_raw" && pwd -P 2>/dev/null)"; then
    return 0
  fi

  case "$repo_common_root" in
    "$super_root"/*) subrepo_rel="${repo_common_root#"$super_root"/}" ;;
    *) return 0 ;;
  esac
  if [[ -z "$subrepo_rel" || "$subrepo_rel" == "$repo_common_root" ]]; then
    return 0
  fi

  gitlink_mode="$(git -C "$super_root" ls-files -s -- "$subrepo_rel" | awk 'NR == 1 { print $1 }')"
  if [[ "$gitlink_mode" != "160000" ]]; then
    return 0
  fi
  gitlink_index_sha="$(git -C "$super_root" ls-files -s -- "$subrepo_rel" | awk 'NR == 1 { print $2 }')"
  gitlink_parent_head_sha="$(git -C "$super_root" ls-tree HEAD -- "$subrepo_rel" | awk 'NR == 1 { print $3 }')"
  subrepo_head_sha="$(git -C "$repo_common_root" rev-parse HEAD 2>/dev/null || true)"
  if [[ -z "$subrepo_head_sha" ]]; then
    return 0
  fi
  if [[ -n "$gitlink_index_sha" && "$gitlink_index_sha" == "$gitlink_parent_head_sha" && "$gitlink_index_sha" == "$subrepo_head_sha" ]]; then
    return 0
  fi

  if [[ "$gitlink_index_sha" != "$subrepo_head_sha" ]]; then
    if ! update_index_output="$(git -C "$super_root" update-index --cacheinfo 160000 "$subrepo_head_sha" "$subrepo_rel" 2>&1)"; then
      echo "[agent-branch-finish] Warning: parent gitlink staging failed for ${subrepo_rel} in ${super_root}." >&2
      [[ -n "$update_index_output" ]] && echo "$update_index_output" >&2
      return 0
    fi
    gitlink_index_sha="$(git -C "$super_root" ls-files -s -- "$subrepo_rel" | awk 'NR == 1 { print $2 }')"
  fi
  gitlink_parent_head_sha="$(git -C "$super_root" ls-tree HEAD -- "$subrepo_rel" | awk 'NR == 1 { print $3 }')"
  if [[ "$gitlink_index_sha" == "$gitlink_parent_head_sha" ]]; then
    return 0
  fi

  commit_message="Update ${subrepo_rel} subrepo pointer"
  if ! commit_output="$(git -C "$super_root" commit -m "$commit_message" -- "$subrepo_rel" 2>&1)"; then
    echo "[agent-branch-finish] Warning: parent gitlink auto-commit failed in ${super_root}." >&2
    [[ -n "$commit_output" ]] && echo "$commit_output" >&2
    return 0
  fi

  echo "[agent-branch-finish] Parent gitlink auto-committed '${subrepo_rel}' in ${super_root}."
}

maybe_push_changed_submodule_branches() {
  local base_ref="${1:-}"
  local source_ref="${2:-}"
  local changed_path=""
  local gitlink_mode=""
  local gitlink_sha=""
  local submodule_dir=""
  local branch_name=""
  local candidate_branch=""
  local remote_name=""
  local push_output=""

  if [[ "$PUSH_ENABLED" -ne 1 || "$changed_submodule_push_done" -eq 1 ]]; then
    return 0
  fi
  changed_submodule_push_done=1
  if [[ -z "$base_ref" || -z "$source_ref" ]]; then
    return 0
  fi

  while IFS= read -r changed_path; do
    [[ -n "$changed_path" ]] || continue

    gitlink_mode="$(git -C "$source_worktree" ls-tree "$source_ref" -- "$changed_path" | awk 'NR == 1 { print $1 }')"
    if [[ "$gitlink_mode" != "160000" ]]; then
      continue
    fi
    gitlink_sha="$(git -C "$source_worktree" ls-tree "$source_ref" -- "$changed_path" | awk 'NR == 1 { print $3 }')"
    if [[ -z "$gitlink_sha" ]]; then
      continue
    fi

    submodule_dir="${source_worktree}/${changed_path}"
    if ! git -C "$submodule_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "[agent-branch-finish] Warning: changed gitlink '${changed_path}' has no checked-out submodule at ${submodule_dir}; cannot auto-push submodule commit ${gitlink_sha}." >&2
      return 1
    fi
    if ! git -C "$submodule_dir" cat-file -e "${gitlink_sha}^{commit}" >/dev/null 2>&1; then
      echo "[agent-branch-finish] Warning: changed gitlink '${changed_path}' points at ${gitlink_sha}, but that commit is not present in ${submodule_dir}; cannot auto-push it." >&2
      return 1
    fi

    branch_name="$(git -C "$submodule_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$branch_name" || "$branch_name" == "HEAD" ]] || ! git -C "$submodule_dir" merge-base --is-ancestor "$gitlink_sha" "$branch_name" >/dev/null 2>&1; then
      candidate_branch="$(git -C "$submodule_dir" for-each-ref --contains "$gitlink_sha" --format='%(refname:short)' refs/heads | head -n 1)"
      branch_name="$candidate_branch"
    fi
    if [[ -z "$branch_name" || "$branch_name" == "HEAD" ]]; then
      echo "[agent-branch-finish] Warning: changed gitlink '${changed_path}' points at ${gitlink_sha}, but no local submodule branch contains it; cannot choose a safe remote branch to push." >&2
      return 1
    fi

    remote_name="$(git -C "$submodule_dir" config --get "branch.${branch_name}.remote" || true)"
    if [[ -z "$remote_name" ]]; then
      remote_name="origin"
    fi
    if ! git -C "$submodule_dir" remote get-url "$remote_name" >/dev/null 2>&1; then
      echo "[agent-branch-finish] Warning: changed gitlink '${changed_path}' branch '${branch_name}' has no usable remote '${remote_name}'; cannot auto-push submodule commit ${gitlink_sha}." >&2
      return 1
    fi

    if push_output="$(git -C "$submodule_dir" push -u "$remote_name" "${branch_name}:${branch_name}" 2>&1)"; then
      echo "[agent-branch-finish] Pushed changed submodule '${changed_path}' branch '${branch_name}' to '${remote_name}' before parent finish."
    else
      echo "[agent-branch-finish] Changed submodule '${changed_path}' must be pushed before the parent branch can be finished." >&2
      [[ -n "$push_output" ]] && echo "$push_output" >&2
      return 1
    fi
  done < <(git -C "$source_worktree" diff --name-only "$base_ref" "$source_ref" -- 2>/dev/null || true)
}

wait_for_pr_merge() {
  local deadline
  deadline=$(( $(date +%s) + WAIT_TIMEOUT_SECONDS ))
  local wait_notice_printed=0
  local merge_output=""

  while true; do
    assert_reviewed_revision || return 1
    if merge_output="$("$GH_BIN" pr merge "$SOURCE_BRANCH" --squash --delete-branch "${merge_head_args[@]}" 2>&1)"; then
      return 0
    fi
    if is_local_branch_delete_error "$merge_output"; then
      echo "[agent-branch-finish] PR merged but gh could not delete the local branch (active worktree); continuing local cleanup." >&2
      return 0
    fi

    PR_STATE=""
    PR_MERGED_AT=""
    if read_pr_state; then
      if [[ "$PR_STATE" == "MERGED" || -n "$PR_MERGED_AT" ]]; then
        return 0
      fi
      if [[ "$PR_STATE" == "CLOSED" ]]; then
        echo "[agent-branch-finish] PR closed without merge; cannot continue auto-finish." >&2
        if [[ -n "$pr_url" ]]; then
          echo "[agent-branch-finish] PR: ${pr_url}" >&2
        fi
        if [[ -n "$merge_output" ]]; then
          echo "$merge_output" >&2
        fi
        return 1
      fi
    fi

    if [[ "$wait_notice_printed" -eq 0 ]]; then
      echo "[agent-branch-finish] Waiting for required checks/reviews, then retrying merge automatically (timeout ${WAIT_TIMEOUT_SECONDS}s)." >&2
      if [[ -n "$pr_url" ]]; then
        echo "[agent-branch-finish] PR: ${pr_url}" >&2
      fi
      wait_notice_printed=1
    fi

    if (( $(date +%s) >= deadline )); then
      echo "[agent-branch-finish] Timed out waiting for PR merge after ${WAIT_TIMEOUT_SECONDS}s." >&2
      if [[ -n "$merge_output" ]]; then
        echo "$merge_output" >&2
      fi
      return 2
    fi

    sleep "$WAIT_POLL_SECONDS"
  done
}

run_pr_flow() {
  local source_head_sha=""

  if ! command -v "$GH_BIN" >/dev/null 2>&1; then
    [[ "$FINISH_GATE_DONE" -eq 1 ]] || finish_progress failed pr "GitHub CLI unavailable"
    echo "[agent-branch-finish] PR fallback requested but GitHub CLI not found: ${GH_BIN}" >&2
    return 1
  fi

  [[ "$FINISH_GATE_DONE" -eq 1 ]] || finish_progress running pr "pushing branch and opening or reusing a PR"
  source_head_sha="$(git -C "$repo_root" rev-parse "$SOURCE_BRANCH" 2>/dev/null || true)"
  if read_merged_pr_for_head "$source_head_sha"; then
    [[ "$FINISH_GATE_DONE" -eq 1 ]] || finish_progress complete pr "existing merged PR"
    echo "[agent-branch-finish] Source branch head already landed in a merged PR; skipping new PR creation and continuing cleanup." >&2
    if [[ -n "$pr_url" ]]; then
      echo "[agent-branch-finish] Merged PR: ${pr_url}" >&2
    fi
    return 0
  fi

  maybe_push_changed_submodule_branches "$start_ref" "$SOURCE_BRANCH"
  assert_reviewed_revision || return 1
  git -C "$source_worktree" push -u origin "$SOURCE_BRANCH"

  pr_title="$(git -C "$repo_root" log -1 --pretty=%s "$SOURCE_BRANCH" 2>/dev/null || true)"
  if [[ -z "$pr_title" ]]; then
    pr_title="Merge ${SOURCE_BRANCH} into ${BASE_BRANCH}"
  fi
  pr_body="Automated by gx branch finish (PR flow)."

  pr_create_args=(
    --base "$BASE_BRANCH"
    --head "$SOURCE_BRANCH"
    --title "$pr_title"
    --body "$pr_body"
  )
  # Merge hold: open the PR as a draft so nothing — required checks going
  # green, a human clicking merge, repo auto-merge — can land it before the
  # hold is lifted.
  if [[ "$AUTO_PROMOTE_DRAFT" -ne 1 ]]; then
    pr_create_args+=(--draft)
  fi
  pr_create_output=""
  if pr_create_output="$("$GH_BIN" pr create "${pr_create_args[@]}" 2>&1)"; then
    :
  elif [[ "$AUTO_PROMOTE_DRAFT" -ne 1 ]] && grep -qi 'draft pull requests are not supported' <<<"$pr_create_output"; then
    # Some plans reject drafts (e.g. private repos on GitHub Free). Fall back
    # to a ready PR — the merge-hold early return below still applies.
    echo "[agent-branch-finish] Draft PRs unsupported in this repository; opening a ready PR (merge still held)." >&2
    if ! pr_create_output="$("$GH_BIN" pr create \
      --base "$BASE_BRANCH" \
      --head "$SOURCE_BRANCH" \
      --title "$pr_title" \
      --body "$pr_body" 2>&1)"; then
      if ! grep -qiE 'already exists|a pull request for branch' <<<"$pr_create_output"; then
        echo "[agent-branch-finish] gh pr create failed:" >&2
        echo "${pr_create_output}" >&2
      fi
    fi
  else
    # Idempotent: a PR already opened for this head is fine — fall through
    # to `gh pr view` so we still capture the URL. Anything else is a real
    # failure and the user needs to see it.
    if ! grep -qiE 'already exists|a pull request for branch' <<<"$pr_create_output"; then
      echo "[agent-branch-finish] gh pr create failed:" >&2
      echo "${pr_create_output}" >&2
    fi
  fi

  pr_url="$("$GH_BIN" pr view "$SOURCE_BRANCH" --json url --jq '.url' 2>/dev/null || true)"

  if [[ -z "$pr_url" ]]; then
    [[ "$FINISH_GATE_DONE" -eq 1 ]] || finish_progress failed pr "PR unavailable after push"
    echo "[agent-branch-finish] No PR found for '${SOURCE_BRANCH}' after gh pr create; cannot proceed with PR merge." >&2
    if [[ -n "$pr_create_output" ]]; then
      echo "[agent-branch-finish] Last gh pr create output:" >&2
      echo "${pr_create_output}" >&2
    fi
    return 1
  fi
  [[ "$FINISH_GATE_DONE" -eq 1 ]] || finish_progress complete pr "$pr_url"
  echo "[agent-branch-finish] PR URL: ${pr_url}" >&2

  # Honor a persisted hold BEFORE any promotion or merge. Only an explicit
  # --auto-promote flag lifts it; the default (env-derived) auto-promote must
  # not, or every unflagged re-run would lift holds it never placed.
  hold_state=0
  pr_hold_marker_state "$pr_url" || hold_state=$?
  if [[ "$hold_state" -eq 2 ]]; then
    # Fail closed: a transient failure reading the body must not silently
    # lift a hold. A spurious hold is recoverable (rerun); a spurious lift
    # merges the PR.
    MERGE_HELD=1
    echo "[agent-branch-finish] Could not read the PR body to check for a merge hold; treating the PR as held (fail closed)." >&2
    return 2
  fi
  if [[ "$hold_state" -eq 0 ]]; then
    if [[ "$AUTO_PROMOTE_EXPLICIT" -eq 1 && "$AUTO_PROMOTE_DRAFT" -eq 1 ]]; then
      if ! remove_hold_marker "$pr_url"; then
        MERGE_HELD=1
        return 2
      fi
      echo "[agent-branch-finish] Merge hold lifted (explicit --auto-promote)." >&2
    else
      MERGE_HELD=1
      # Re-demote in case an outer layer (gate-review markReady, a human)
      # promoted the held PR since the hold was placed. Idempotent when the
      # PR is already draft; best-effort like the placement disarm.
      "$GH_BIN" pr ready --undo "$pr_url" >/dev/null 2>&1 || true
      echo "[agent-branch-finish] Existing merge hold (${HOLD_MARKER}) honored; not promoting or merging." >&2
      return 2
    fi
  fi

  # Pre-flight already passed by the time we reach the PR; promote any
  # existing draft so the budget-friendly CI gate fires once.
  maybe_auto_promote_pr "$pr_url"

  # Merge hold (--no-auto-promote): stop before the merge attempts below.
  # Without this return the unconditional `gh pr merge` lands the PR the
  # moment the repo has no blocking checks — the exact accident the flag
  # exists to prevent.
  if [[ "$AUTO_PROMOTE_DRAFT" -ne 1 ]]; then
    MERGE_HELD=1
    # Disarm anything that could still land the PR while held: GitHub
    # auto-merge armed by an earlier run, and ready state left by an earlier
    # run or the gate-review markReady step. Best-effort; the marker below is
    # the load-bearing hold.
    "$GH_BIN" pr merge "$pr_url" --disable-auto >/dev/null 2>&1 || true
    "$GH_BIN" pr ready --undo "$pr_url" >/dev/null 2>&1 || true
    place_hold_marker "$pr_url"
    finish_progress skipped merge "merge hold active"
    echo "[agent-branch-finish] Merge held (--no-auto-promote): PR left unmerged for review/e2e." >&2
    return 2
  fi

  finish_progress running merge "waiting for GitHub merge readiness"
  merge_output=""
  assert_reviewed_revision || return 1
  if merge_output="$("$GH_BIN" pr merge "$SOURCE_BRANCH" --squash --delete-branch "${merge_head_args[@]}" 2>&1)"; then
    return 0
  fi
  if is_local_branch_delete_error "$merge_output"; then
    echo "[agent-branch-finish] PR merged but gh could not delete the local branch (active worktree); continuing local cleanup." >&2
    return 0
  fi

  if [[ "$WAIT_FOR_MERGE" -eq 1 ]]; then
    wait_for_pr_merge
    return $?
  fi

  if [[ "$FINISH_GATE_DONE" -eq 1 ]]; then
    echo "[agent-branch-finish] Review gate cannot authorize a future auto-merge; rerun finish when ready." >&2
    return 1
  fi
  auto_output=""
  if auto_output="$("$GH_BIN" pr merge "$SOURCE_BRANCH" --squash --delete-branch --auto "${merge_head_args[@]}" 2>&1)"; then
    echo "[agent-branch-finish] PR auto-merge enabled; waiting for required checks/reviews." >&2
    return 2
  fi

  if [[ -n "$merge_output" ]]; then
    echo "[agent-branch-finish] PR merge not completed yet; leaving PR open." >&2
    echo "${merge_output}" >&2
  fi
  if [[ -n "$auto_output" ]]; then
    echo "${auto_output}" >&2
  fi
  return 2
}

if [[ "$PUSH_ENABLED" -ne 1 ]]; then
  finish_progress skipped pr "push disabled"
  finish_progress running merge "local merge only"
fi

if [[ "$PUSH_ENABLED" -eq 1 ]]; then
  if ! run_preflight "$source_worktree"; then
    exit 1
  fi
  if [[ "$MERGE_MODE" != "pr" ]]; then
    finish_progress skipped pr "direct flow"
    finish_progress running merge "pushing verified integration result"
    # A persisted merge hold must also stop the direct-push shortcut, or a
    # rerun in auto/direct mode would land the held work without ever
    # consulting the marker. State 2 (no PR / body unreadable) proceeds:
    # most direct pushes have no PR at all.
    direct_hold_state=0
    pr_hold_marker_state "$SOURCE_BRANCH" || direct_hold_state=$?
    if [[ "$direct_hold_state" -eq 0 ]]; then
      if [[ "$MERGE_MODE" == "direct" ]]; then
        echo "[agent-branch-finish] Existing merge hold (${HOLD_MARKER}) on the PR for '${SOURCE_BRANCH}'; refusing the --direct-only push. Lift with 'gx branch finish --branch ${SOURCE_BRANCH} --auto-promote'." >&2
        exit 1
      fi
      echo "[agent-branch-finish] Existing merge hold (${HOLD_MARKER}) on the PR for '${SOURCE_BRANCH}'; skipping the direct push and using the PR flow." >&2
      merge_completed=0
    else
      maybe_push_changed_submodule_branches "$start_ref" "$SOURCE_BRANCH"
      if ! direct_push_output="$(git -C "$integration_worktree" push origin "HEAD:${BASE_BRANCH}" 2>&1)"; then
        direct_push_error="$direct_push_output"
        merge_completed=0
      fi
    fi
  else
    merge_completed=0
  fi

  if [[ "$merge_completed" -eq 0 ]]; then
    if [[ "$MERGE_MODE" == "direct" ]]; then
      echo "[agent-branch-finish] Direct push/merge failed in --direct-only mode." >&2
      if [[ -n "$direct_push_error" ]]; then
        echo "$direct_push_error" >&2
      fi
      exit 1
    fi

    if run_pr_flow; then
      merge_completed=1
      merge_status="pr"
    else
      pr_exit=$?
      if [[ "$pr_exit" -eq 2 ]]; then
        echo "[agent-branch-finish] PR flow created/updated branch '${SOURCE_BRANCH}' against '${BASE_BRANCH}'." >&2
        if [[ -n "$pr_url" ]]; then
          echo "[agent-branch-finish] PR: ${pr_url}" >&2
        fi
        if [[ "$MERGE_HELD" -eq 1 ]]; then
          echo "[agent-branch-finish] Merge hold active; worktree retained. When your gate (review/e2e) passes, lift the hold with: gx branch finish --branch ${SOURCE_BRANCH} --auto-promote" >&2
          echo "MERGE_HELD=1"
          exit 0
        fi
        if [[ "$WAIT_FOR_MERGE" -eq 1 ]]; then
          finish_progress failed merge "wait window expired"
          echo "[agent-branch-finish] Merge did not complete within wait window; keeping branch open." >&2
          exit 1
        fi
        finish_progress skipped merge "PR left pending"
        echo "[agent-branch-finish] PR pending review/check policy. Worktree retained for now; the autofinish watcher (or 'gx worktree prune --include-pr-merged --delete-branches') will prune it after merge. Verify with 'git worktree list' before claiming the worktree is still on disk." >&2
        exit 0
      fi
      echo "[agent-branch-finish] PR flow failed." >&2
      if [[ -n "$direct_push_error" ]]; then
        echo "[agent-branch-finish] Direct push failure details:" >&2
        echo "$direct_push_error" >&2
      fi
      exit 1
    fi
  fi
fi

# Reaching here means the merge landed. That is the outcome the caller cares
# about, so state it once, unmistakably, BEFORE any best-effort cleanup runs —
# otherwise a warning from worktree/branch teardown reads as the headline and
# the merge scrolls away. Everything below this line is cleanup: it can warn,
# it must not fail the run, because the work is already in the base branch.
finish_progress complete merge "landed in ${BASE_BRANCH}"
echo "[agent-branch-finish] ✅ MERGED  ${SOURCE_BRANCH} -> ${BASE_BRANCH} (${merge_status} flow)"
if [[ -n "$pr_url" ]]; then
  echo "[agent-branch-finish] ✅ PR: ${pr_url}"
fi

if [[ "$CLEANUP_AFTER_MERGE" -eq 1 ]]; then
  finish_progress running cleanup "releasing locks and pruning branch/worktree"
else
  finish_progress skipped cleanup "disabled by flag"
fi

run_guardex_cli locks release --branch "$SOURCE_BRANCH" >/dev/null 2>&1 || true

base_worktree="$(get_worktree_for_branch "$BASE_BRANCH")"
refresh_clean_base_worktree "$base_worktree"
maybe_auto_commit_parent_gitlink "$base_worktree"

# Pivot out of the agent worktree before prune calls that may remove it.
# Without this, subprocess spawns can fail with ENOENT uv_cwd after cwd
# disappears even when the merge succeeded.
pivot_to_repo_root_before_prune() {
  if [[ "$current_worktree" == "$source_worktree" && "$source_worktree" == "${agent_worktree_root}"/* ]]; then
    cd "$repo_root" 2>/dev/null || true
  fi
}

run_guardex_prune() {
  GUARDEX_PRUNE_ACTIVE_CWD="$finish_active_cwd" run_guardex_cli worktree prune "$@"
}

if [[ "$CLEANUP_AFTER_MERGE" -eq 1 ]]; then
  if [[ "$source_worktree" == "$repo_root" ]]; then
    if is_clean_worktree "$source_worktree"; then
      switched_to_base=0
      if git -C "$source_worktree" checkout "$BASE_BRANCH" >/dev/null 2>&1; then
        switched_to_base=1
      else
        git -C "$source_worktree" checkout --detach >/dev/null 2>&1 || true
      fi
      if [[ "$switched_to_base" -eq 1 && "$PUSH_ENABLED" -eq 1 ]] && git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
        refresh_clean_base_worktree "$source_worktree"
      fi
    fi
  elif [[ "$source_worktree" == "$current_worktree" && "$source_worktree" == "${agent_worktree_root}"/* ]]; then
    git -C "$source_worktree" checkout --detach >/dev/null 2>&1 || true
  fi

  if [[ "$source_worktree" != "$current_worktree" && "$source_worktree" == "${agent_worktree_root}"/* ]]; then
    git -C "$repo_root" worktree remove "$source_worktree" --force >/dev/null 2>&1 || true
  fi

  # The merge already landed (see the MERGED banner above), so a branch that
  # refuses to delete is a leftover to report, not a reason to fail the run and
  # make a successful ship look broken. Keep the branch AND its remote in that
  # case: the commits it still holds exist nowhere else.
  local_branch_cleaned=1
  if ! delete_local_branch_for_cleanup "$SOURCE_BRANCH"; then
    local_branch_cleaned=0
    echo "[agent-branch-finish] Warning: kept local branch '${SOURCE_BRANCH}' — it holds commits that never landed in '${BASE_BRANCH}' (rebased during finish, or pushed after the merge)." >&2
    echo "[agent-branch-finish] Inspect: git log ${BASE_BRANCH}..${SOURCE_BRANCH}" >&2
    echo "[agent-branch-finish] Delete once you are satisfied: git branch -D ${SOURCE_BRANCH}" >&2
  fi

  if [[ "$local_branch_cleaned" -eq 1 && "$PUSH_ENABLED" -eq 1 && "$DELETE_REMOTE_BRANCH" -eq 1 ]]; then
    if git -C "$repo_root" ls-remote --exit-code --heads origin "$SOURCE_BRANCH" >/dev/null 2>&1; then
      remote_delete_output=""
      if ! remote_delete_output="$(git -C "$repo_root" push origin --delete "$SOURCE_BRANCH" 2>&1)"; then
        if is_remote_branch_missing_error "$remote_delete_output"; then
          echo "[agent-branch-finish] Remote branch '${SOURCE_BRANCH}' was already deleted; continuing cleanup." >&2
        else
          echo "[agent-branch-finish] Warning: remote branch cleanup failed for '${SOURCE_BRANCH}' after merge; continuing local cleanup." >&2
          echo "$remote_delete_output" >&2
        fi
      fi
    fi
  fi

  # prune deletes with `git branch -D`, so handing it --delete-branches right
  # after we deliberately kept a branch with unlanded commits would force-delete
  # exactly what we just protected. Skip branch deletion for this run; the next
  # finish or an explicit `gx cleanup` sweeps the rest.
  prune_args=(--base "$BASE_BRANCH" --only-dirty-worktrees)
  if [[ "$local_branch_cleaned" -eq 1 ]]; then
    prune_args+=(--delete-branches)
    if [[ "$DELETE_REMOTE_BRANCH" -eq 1 ]]; then
      prune_args+=(--delete-remote-branches)
    fi
  else
    echo "[agent-branch-finish] Skipping branch deletion during prune so '${SOURCE_BRANCH}' survives; sweep later with: gx cleanup --base ${BASE_BRANCH}" >&2
  fi

  pivot_to_repo_root_before_prune
  if ! run_guardex_prune "${prune_args[@]}"; then
    echo "[agent-branch-finish] Warning: automatic worktree prune failed." >&2
    echo "[agent-branch-finish] You can run manual cleanup: gx cleanup --base ${BASE_BRANCH}" >&2
  fi

  # Say what actually happened: claiming the branch was cleaned when it was
  # deliberately kept is the same misreport in the other direction. The two
  # cleaned wordings differ ("branch/remote" vs "branch/worktree") and callers
  # match on them, so keep each one exactly as it was.
  if [[ "$local_branch_cleaned" -eq 1 ]]; then
    kept_branch_summary=""
  else
    kept_branch_summary="kept source branch (commits not in '${BASE_BRANCH}')"
  fi

  if [[ "$source_worktree" == "$current_worktree" && "$source_worktree" == "${agent_worktree_root}"/* && -d "$source_worktree" ]]; then
    echo "[agent-branch-finish] Merged '${SOURCE_BRANCH}' into '${BASE_BRANCH}' via ${merge_status} flow and ${kept_branch_summary:-cleaned source branch/remote}."
    echo "[agent-branch-finish] Current worktree '${source_worktree}' still exists because it is the active shell cwd." >&2
    echo "[agent-branch-finish] Leave this directory, then run: gx cleanup --base ${BASE_BRANCH}" >&2
  else
    echo "[agent-branch-finish] Merged '${SOURCE_BRANCH}' into '${BASE_BRANCH}' via ${merge_status} flow and ${kept_branch_summary:-cleaned source branch/worktree}."
  fi
  finish_progress finished cleanup "best-effort cleanup finished; inspect warnings above"
else
  pivot_to_repo_root_before_prune
  if ! run_guardex_prune --base "$BASE_BRANCH"; then
    echo "[agent-branch-finish] Warning: temporary worktree prune failed." >&2
  fi

  echo "[agent-branch-finish] Merged '${SOURCE_BRANCH}' into '${BASE_BRANCH}' via ${merge_status} flow and kept source branch/worktree."
  echo "[agent-branch-finish] Cleanup later with: gx cleanup --base ${BASE_BRANCH}"
fi
