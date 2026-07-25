#!/bin/sh
set -eu

: "${CODEX_HOME:=/home/codex-web/.codex}"
: "${CODEX_CONFIG_SOURCE:=/bootstrap-config/config.toml}"
: "${CODEX_AUTH_SOURCE:=/bootstrap-auth/auth.json}"
: "${CODEX_BOOTSTRAP_FORCE_COPY:=false}"

case "${CODEX_HOME}" in
  ""|/)
    echo "CODEX_HOME must be a dedicated directory" >&2
    exit 1
    ;;
esac

case "${CODEX_BOOTSTRAP_FORCE_COPY}" in
  1|true|TRUE|yes|YES|on|ON)
    force_copy=1
    ;;
  0|false|FALSE|no|NO|off|OFF)
    force_copy=0
    ;;
  *)
    echo "CODEX_BOOTSTRAP_FORCE_COPY must be true or false" >&2
    exit 1
    ;;
esac

if [ -L "${CODEX_HOME}" ]; then
  echo "CODEX_HOME must not be a symlink" >&2
  exit 1
fi

if [ ! -s "${CODEX_CONFIG_SOURCE}" ]; then
  echo "missing or empty ${CODEX_CONFIG_SOURCE}" >&2
  exit 1
fi

if [ ! -s "${CODEX_AUTH_SOURCE}" ]; then
  echo "missing or empty ${CODEX_AUTH_SOURCE}" >&2
  exit 1
fi

mkdir -p "${CODEX_HOME}"

config_tmp=""
auth_tmp=""
cleanup() {
  if [ -n "${config_tmp}" ]; then rm -f "${config_tmp}"; fi
  if [ -n "${auth_tmp}" ]; then rm -f "${auth_tmp}"; fi
}
trap cleanup EXIT HUP INT TERM

copy_if_needed() {
  source_path="$1"
  destination_path="$2"
  label="$3"

  if [ -L "${destination_path}" ] || [ -d "${destination_path}" ]; then
    echo "${label} destination must be a regular file, not a link or directory" >&2
    return 1
  fi

  if [ "${force_copy}" -eq 0 ] && [ -e "${destination_path}" ]; then
    chmod 0600 "${destination_path}"
    return 0
  fi

  temporary_path="$(mktemp "${destination_path}.tmp.XXXXXX")"
  if [ "${label}" = "config.toml" ]; then
    config_tmp="${temporary_path}"
  else
    auth_tmp="${temporary_path}"
  fi

  cp "${source_path}" "${temporary_path}"
  chmod 0600 "${temporary_path}"
  mv -f "${temporary_path}" "${destination_path}"

  if [ "${label}" = "config.toml" ]; then
    config_tmp=""
  else
    auth_tmp=""
  fi
}

umask 077
copy_if_needed "${CODEX_CONFIG_SOURCE}" "${CODEX_HOME}/config.toml" "config.toml"
copy_if_needed "${CODEX_AUTH_SOURCE}" "${CODEX_HOME}/auth.json" "auth.json"
trap - EXIT HUP INT TERM
