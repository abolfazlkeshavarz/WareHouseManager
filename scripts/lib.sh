#!/usr/bin/env bash
#
# Shared helpers sourced by the other deploy scripts (and by the Makefile).
# Not meant to be run directly.

# load_env <file>
#
# Loads a .env-style file WITHOUT `source`, which would execute every line as
# a shell command. Only well-formed KEY=VALUE lines are exported; anything else
# is warned about and ignored.
load_env() {
  local file="${1:-.env}"
  if [[ ! -f "$file" ]]; then
    echo "Error: $file not found." >&2
    return 1
  fi
  set -a
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      export "$line"
    else
      echo "Warning: ignoring malformed line in $file: $line" >&2
    fi
  done < "$file"
  set +a
}

# port_in_use <port> — true if anything on this host already listens there.
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Htln "( sport = :$port )" 2>/dev/null | grep -q .
    return $?
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3>&-; return 0; }
  return 1
}

# find_free_port <start> — first free port at or above <start>.
find_free_port() {
  local port="${1:-8090}"
  while port_in_use "$port"; do
    port=$((port + 1))
  done
  echo "$port"
}

# port_owner <port> — process name listening on a port ("nginx", "docker-proxy", ...), or empty.
port_owner() {
  local port="$1"
  command -v ss >/dev/null 2>&1 || return 0
  ss -Htlnp "( sport = :$port )" 2>/dev/null \
    | grep -oE 'users:\(\("[^"]+"' \
    | head -1 \
    | sed -E 's/.*"([^"]+)"/\1/'
}

# rand_secret <bytes> — URL/shell-safe random string.
rand_secret() {
  local bytes="${1:-32}"
  openssl rand -base64 "$bytes" | tr -d '\n=+/'
}

# wait_for_http <url> [seconds] — poll until the URL answers 200.
wait_for_http() {
  local url="$1" max="${2:-60}" i
  for ((i = 0; i < max; i++)); do
    if [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)" == "200" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}
