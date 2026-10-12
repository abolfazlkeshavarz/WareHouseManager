#!/usr/bin/env bash
#
# Host-side updater for the warehouse app (experimental).
#
# The app's «تنظیمات › نسخه و به‌روزرسانی» page cannot rebuild its own container, so it drops a
# request file into the data volume. This script runs ON THE SERVER, picks the request up and
# does what you would otherwise type by hand:
#
#   update    backup -> git pull (fast-forward) -> make prod-up -> health check
#             (if the new version does not come up healthy, the previous one is restored)
#   rollback  check out the version that was running before the last update -> make prod-up
#   check     git fetch, report whether a newer version exists
#
#   make updater-install      install + start as a systemd service
#   bash scripts/updater.sh run     run in the foreground (what the service does)
#   bash scripts/updater.sh once    handle one pending request / refresh the report, then exit
#
# Only the three fixed action names are accepted from the request file; nothing else in it is used.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib.sh"

DOCKER="${DOCKER:-docker}"
CONTAINER="${CONTAINER:-warehouse-app}"
BRANCH="${UPDATE_BRANCH:-main}"
REMOTE="${UPDATE_REMOTE:-origin}"
STATE_DIR="$ROOT_DIR/.updater"
POLL_SECONDS=5
HEARTBEAT_EVERY=6      # x POLL_SECONDS = 30s
FETCH_EVERY=360        # x POLL_SECONDS = 30min
mkdir -p "$STATE_DIR"

log() { echo "[$(date '+%F %T')] $*"; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# json_str <text> — a JSON string literal (quotes, backslashes and control characters made safe)
json_str() {
  [[ -z "$1" ]] && { printf '""'; return; }
  printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'
}

in_container() { "$DOCKER" exec "$CONTAINER" "$@" 2>/dev/null; }
# put <name> — stdin becomes /data/updater/<name> inside the container (written atomically)
put() {
  "$DOCKER" exec -i "$CONTAINER" sh -c "mkdir -p /data/updater && cat > /data/updater/$1.tmp && mv /data/updater/$1.tmp /data/updater/$1" 2>/dev/null
}

short() { git rev-parse --short "$1" 2>/dev/null || true; }
version_at() { git show "$1:package.json" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1; }

write_host_report() {
  local prev_json="null" avail_json="null" prev behind
  if [[ -s "$STATE_DIR/previous" ]]; then
    prev="$(cat "$STATE_DIR/previous")"
    if git cat-file -e "${prev}^{commit}" 2>/dev/null && [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$prev")" ]]; then
      prev_json="{\"commit\":$(json_str "$(short "$prev")"),\"version\":$(json_str "$(version_at "$prev")")}"
    fi
  fi
  behind="$(git rev-list --count "HEAD..${REMOTE}/${BRANCH}" 2>/dev/null || echo 0)"
  if [[ "${behind:-0}" -gt 0 ]]; then
    avail_json="{\"behind\":${behind},\"commit\":$(json_str "$(short "${REMOTE}/${BRANCH}")"),\"version\":$(json_str "$(version_at "${REMOTE}/${BRANCH}")"),\"subject\":$(json_str "$(git log -1 --format=%s "${REMOTE}/${BRANCH}" 2>/dev/null)"),\"date\":$(json_str "$(git log -1 --format=%cI "${REMOTE}/${BRANCH}" 2>/dev/null)")}"
  fi
  local checked=""
  [[ -s "$STATE_DIR/checked_at" ]] && checked="$(cat "$STATE_DIR/checked_at")"
  printf '{"heartbeat":%s,"branch":%s,"commit":%s,"previous":%s,"available":%s,"checked_at":%s}\n' \
    "$(json_str "$(now_iso)")" "$(json_str "$BRANCH")" "$(json_str "$(short HEAD)")" "$prev_json" "$avail_json" "$(json_str "$checked")" | put host.json
}

# status <state> <action> <step> [detail]   state: running | done | failed
status() {
  local started="${STARTED_AT:-$(now_iso)}" finished="null"
  [[ "$1" != "running" ]] && finished="$(json_str "$(now_iso)")"
  printf '{"state":%s,"action":%s,"step":%s,"detail":%s,"started_at":%s,"finished_at":%s,"from":%s,"to":%s}\n' \
    "$(json_str "$1")" "$(json_str "$2")" "$(json_str "$3")" "$(json_str "${4:-}")" "$(json_str "$started")" "$finished" \
    "$(json_str "${FROM_COMMIT:-}")" "$(json_str "$(short HEAD)")" | put status.json
  log "$2: $1 ($3) ${4:-}"
}

fetch_remote() {
  if git fetch --quiet "$REMOTE" "$BRANCH" 2>"$STATE_DIR/fetch.err"; then
    now_iso > "$STATE_DIR/checked_at"
    return 0
  fi
  log "git fetch failed: $(head -c 300 "$STATE_DIR/fetch.err")"
  return 1
}

# deploy — rebuild + restart from the checked-out commit and wait until it answers.
deploy() {
  local port="8090"
  [[ -f "$ROOT_DIR/.env.prod" ]] && port="$(sed -n 's/^HTTP_PORT=\([0-9]*\).*/\1/p' "$ROOT_DIR/.env.prod" | head -1)"
  port="${port:-8090}"
  if ! make prod-up >"$STATE_DIR/deploy.log" 2>&1; then
    log "make prod-up failed: $(tail -n 5 "$STATE_DIR/deploy.log" | tr '\n' ' ')"
    return 1
  fi
  wait_for_http "http://127.0.0.1:${port}/health" 150
}

do_update() {
  local before after
  STARTED_AT="$(now_iso)"; FROM_COMMIT="$(short HEAD)"
  before="$(git rev-parse HEAD)"
  status running update backup
  bash scripts/backup-prod.sh >"$STATE_DIR/backup.log" 2>&1 || log "backup failed (continuing): $(tail -n 2 "$STATE_DIR/backup.log" | tr '\n' ' ')"

  status running update fetch
  if ! fetch_remote; then status failed update fetch "$(head -c 200 "$STATE_DIR/fetch.err")"; return; fi
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    status failed update local_changes "$(git status --porcelain --untracked-files=no | head -n 5 | tr '\n' ' ')"; return
  fi
  if ! git checkout --quiet "$BRANCH" 2>"$STATE_DIR/git.err" || ! git merge --quiet --ff-only "${REMOTE}/${BRANCH}" 2>>"$STATE_DIR/git.err"; then
    git checkout --quiet --detach "$before" 2>/dev/null
    status failed update merge "$(head -c 200 "$STATE_DIR/git.err")"; return
  fi
  after="$(git rev-parse HEAD)"
  if [[ "$after" == "$before" ]]; then status done update up_to_date; return; fi

  status running update build
  if deploy; then
    echo "$before" > "$STATE_DIR/previous"
    write_host_report
    status done update done
    return
  fi
  # the new version did not come up: put the old one back
  status running update restoring "$(tail -n 3 "$STATE_DIR/deploy.log" | tr '\n' ' ')"
  git checkout --quiet --detach "$before"
  if deploy; then status failed update restored "$(tail -n 3 "$STATE_DIR/deploy.log" | tr '\n' ' ')"
  else status failed update broken "$(tail -n 3 "$STATE_DIR/deploy.log" | tr '\n' ' ')"; fi
}

do_rollback() {
  local before target
  STARTED_AT="$(now_iso)"; FROM_COMMIT="$(short HEAD)"
  before="$(git rev-parse HEAD)"
  if [[ ! -s "$STATE_DIR/previous" ]]; then status failed rollback no_previous; return; fi
  target="$(cat "$STATE_DIR/previous")"
  if ! git cat-file -e "${target}^{commit}" 2>/dev/null; then status failed rollback no_previous; return; fi
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    status failed rollback local_changes "$(git status --porcelain --untracked-files=no | head -n 5 | tr '\n' ' ')"; return
  fi
  status running rollback backup
  bash scripts/backup-prod.sh >"$STATE_DIR/backup.log" 2>&1 || log "backup failed (continuing)"
  status running rollback build
  git checkout --quiet --detach "$target"
  if deploy; then
    rm -f "$STATE_DIR/previous"
    write_host_report
    status done rollback done
    return
  fi
  status running rollback restoring
  git checkout --quiet --detach "$before"
  if deploy; then status failed rollback restored "$(tail -n 3 "$STATE_DIR/deploy.log" | tr '\n' ' ')"
  else status failed rollback broken "$(tail -n 3 "$STATE_DIR/deploy.log" | tr '\n' ' ')"; fi
}

handle_request() {
  local raw action
  raw="$(in_container cat /data/updater/request.json)" || return 1
  [[ -n "$raw" ]] || return 1
  in_container rm -f /data/updater/request.json
  action="$(printf '%s' "$raw" | sed -n 's/.*"action"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' | head -1)"
  case "$action" in
    check)    fetch_remote; write_host_report ;;
    update)   do_update;   write_host_report ;;
    rollback) do_rollback; write_host_report ;;
    *)        log "ignored request with unknown action" ;;
  esac
  return 0
}

container_up() { [[ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == "true" ]]; }

case "${1:-run}" in
  once)
    container_up || { echo "container ${CONTAINER} is not running" >&2; exit 1; }
    handle_request || { fetch_remote; write_host_report; }
    ;;
  run)
    log "updater started in ${ROOT_DIR} (branch ${BRANCH})"
    i=0
    while true; do
      if container_up; then
        handle_request || true
        (( i % HEARTBEAT_EVERY == 0 )) && write_host_report
        (( i % FETCH_EVERY == 0 )) && { fetch_remote && write_host_report; }
      fi
      i=$(( i + 1 ))
      sleep "$POLL_SECONDS"
    done
    ;;
  *)
    echo "usage: $0 [run|once]" >&2; exit 1 ;;
esac
