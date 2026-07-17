#!/usr/bin/env bash
set -euo pipefail

readonly API_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly FLUKE_ROOT="$(cd "${API_ROOT}/../fluke" && pwd -P)"
readonly SOURCE_ENV="${FLUKE_ROOT}/apps/api/.env"
readonly SOURCE_PORT=4010
readonly TARGET_PORT=4011
readonly SOURCE_LOG="$(mktemp)"
readonly TARGET_LOG="$(mktemp)"
readonly PARITY_DIR="$(mktemp -d)"

SOURCE_PID=''
TARGET_PID=''

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    return 1
  fi
}

print_redacted_log() {
  local label="$1"
  local log_file="$2"

  printf '\n%s server log (sensitive lines and URL credentials redacted):\n' "${label}" >&2
  sed -E \
    -e '/(secret|password|token|credential|database_url|direct_url)/Id' \
    -e '/(database server|database host|connect(ion|ivity).*(database|postgres)|Please make sure your database)/Id' \
    -e 's#((postgres|postgresql|https?)://)[^/@[:space:]]+(:[^/@[:space:]]*)?@#\1[REDACTED]@#g' \
    "${log_file}" | tail -n 80 >&2
}

stop_process() {
  local pid="$1"

  if [[ -z "${pid}" ]]; then
    return
  fi

  if kill -0 "${pid}" 2>/dev/null; then
    pkill -TERM -P "${pid}" 2>/dev/null || true
    kill -TERM "${pid}" 2>/dev/null || true

    for _attempt in {1..20}; do
      if ! kill -0 "${pid}" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done

    pkill -KILL -P "${pid}" 2>/dev/null || true
    kill -KILL "${pid}" 2>/dev/null || true
  fi

  wait "${pid}" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?

  if ((exit_code != 0)); then
    print_redacted_log 'Source' "${SOURCE_LOG}"
    print_redacted_log 'Target' "${TARGET_LOG}"
  fi

  stop_process "${SOURCE_PID}"
  stop_process "${TARGET_PID}"
  rm -f "${SOURCE_LOG}" "${TARGET_LOG}"
  rm -rf "${PARITY_DIR}"
}
trap cleanup EXIT INT TERM

start_source_server() {
  (
    set +x
    set -a
    # shellcheck disable=SC1090
    source "${SOURCE_ENV}"
    set +a
    export PORT="${SOURCE_PORT}"
    cd "${FLUKE_ROOT}"
    exec pnpm --filter @fluke/api exec tsx src/index.ts
  ) >"${SOURCE_LOG}" 2>&1 &
  SOURCE_PID=$!
}

start_target_server() {
  (
    set +x
    set -a
    # shellcheck disable=SC1090
    source "${SOURCE_ENV}"
    set +a
    export PORT="${TARGET_PORT}"
    cd "${API_ROOT}"
    exec pnpm exec tsx src/index.ts
  ) >"${TARGET_LOG}" 2>&1 &
  TARGET_PID=$!
}

wait_for_health() {
  local label="$1"
  local port="$2"
  local pid="$3"
  local health_url="http://127.0.0.1:${port}/api/v1/health"

  for _attempt in {1..60}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      printf '%s server exited before becoming healthy.\n' "${label}" >&2
      return 1
    fi

    if curl --fail --silent --show-error --max-time 2 "${health_url}" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  printf '%s server did not become healthy within 60 seconds.\n' "${label}" >&2
  return 1
}

request_endpoint() {
  local index="$1"
  local label="$2"
  local port="$3"
  local path="$4"
  local response_file="${PARITY_DIR}/${index}-${label}.json"
  local status_file="${PARITY_DIR}/${index}-${label}.status"
  local normalized_file="${PARITY_DIR}/${index}-${label}.normalized.json"
  local attempts_file="${PARITY_DIR}/${index}-${label}.attempts"
  local attempt
  local status

  : >"${attempts_file}"
  for attempt in {1..3}; do
    if ! status="$(curl --silent --show-error --max-time 15 \
      --output "${response_file}" \
      --write-out '%{http_code}' \
      "http://127.0.0.1:${port}${path}")"; then
      status='000'
    fi
    printf 'attempt=%s status=%s\n' "${attempt}" "${status}" >>"${attempts_file}"

    if [[ "${status}" != '000' && "${status}" -lt 500 ]]; then
      break
    fi
    if ((attempt < 3)); then
      sleep 1
    fi
  done

  printf '%s\n' "${status}" >"${status_file}"

  if ! jq -S 'walk(if type == "object" then del(.requestId, .timestamp) else . end)' \
    "${response_file}" >"${normalized_file}"; then
    printf '%s returned a non-JSON response for %s.\n' "${label}" "${path}" >&2
    return 1
  fi
}

compare_endpoint() {
  local index="$1"
  local path="$2"
  local source_request_pid
  local target_request_pid
  local request_failed=0

  request_endpoint "${index}" source "${SOURCE_PORT}" "${path}" &
  source_request_pid=$!
  request_endpoint "${index}" target "${TARGET_PORT}" "${path}" &
  target_request_pid=$!

  wait "${source_request_pid}" || request_failed=1
  wait "${target_request_pid}" || request_failed=1
  if ((request_failed != 0)); then
    printf 'Request or JSON parsing failed for %s.\n' "${path}" >&2
    return 1
  fi

  printf '%s: source [%s]; target [%s]\n' \
    "${path}" \
    "$(paste -sd ', ' "${PARITY_DIR}/${index}-source.attempts")" \
    "$(paste -sd ', ' "${PARITY_DIR}/${index}-target.attempts")"

  if ! diff -u \
    "${PARITY_DIR}/${index}-source.status" \
    "${PARITY_DIR}/${index}-target.status"; then
    printf 'HTTP status mismatch for %s.\n' "${path}" >&2
    return 1
  fi

  if ! diff -u \
    "${PARITY_DIR}/${index}-source.normalized.json" \
    "${PARITY_DIR}/${index}-target.normalized.json"; then
    printf 'JSON body mismatch for %s.\n' "${path}" >&2
    return 1
  fi
}

main() {
  local paths=(
    '/api/v1/health'
    '/api/v1/whales'
    '/api/v1/sightings'
    '/api/v1/external-sightings'
    '/api/v1/sightings/historical?from=2020-01-01&to=2030-01-01'
    '/api/v1/predict?horizon=24h'
    '/api/v1/admin/sightings'
  )

  test -f "${SOURCE_ENV}" || {
    printf 'Source API environment file is unavailable.\n' >&2
    return 1
  }

  require_command curl
  require_command diff
  require_command jq
  require_command pnpm

  start_source_server
  start_target_server
  wait_for_health source "${SOURCE_PORT}" "${SOURCE_PID}"
  wait_for_health target "${TARGET_PORT}" "${TARGET_PID}"

  for index in "${!paths[@]}"; do
    compare_endpoint "${index}" "${paths[$index]}"
  done

  printf 'Parity verified for %s read-only endpoints.\n' "${#paths[@]}"
}

main "$@"
