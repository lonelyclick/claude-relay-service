#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="claude-oauth-relay"
APP_DIR="${APP_DIR:-/home/ubuntu/projects/claude-oauth-relay}"
REMOTE_HOST="${REMOTE_HOST:-ubuntu@43.160.224.233}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_tencent_43_160_224_233}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
SKIP_PULL=0

usage() {
  cat <<'USAGE'
Usage: ./deploy.sh [--skip-pull]

Deploys the Tencent Singapore production checkout over SSH.

Options:
  --skip-pull Skip git fetch/pull before deploying.

Environment overrides:
  REMOTE_HOST=ubuntu@43.160.224.233
  SSH_KEY=~/.ssh/id_ed25519_tencent_43_160_224_233
  APP_DIR=/home/ubuntu/projects/claude-oauth-relay
  BRANCH=main
  REMOTE_NAME=origin
  SKIP_INSTALL=1
  SKIP_BUILD=1
  SKIP_VERIFY=1
  ALLOW_DIRTY=1
USAGE
}

log() {
  printf '[%s] %s\n' "$APP_NAME" "$*"
}

die() {
  printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2
  exit 1
}

quote() {
  printf '%q' "$1"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_env_key() {
  local file="$1"
  local key="$2"

  [[ -f "$file" ]] || die "missing environment file: $file"
  grep -Eq "^${key}=.+" "$file" || die "$file is missing required key: $key"
}

check_clean_worktree() {
  if [[ "${ALLOW_DIRTY:-0}" == "1" ]]; then
    log "ALLOW_DIRTY=1, skipping git worktree cleanliness check"
    return
  fi

  local status
  status="$(git status --porcelain --untracked-files=normal)"
  if [[ -n "$status" ]]; then
    printf '%s\n' "$status" >&2
    die "git worktree is not clean; commit or stash changes before deploying"
  fi
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local method="${3:-GET}"
  local code=""

  for _ in $(seq 1 20); do
    if [[ "$method" == "OPTIONS" ]]; then
      code="$(
        curl -sS -o /dev/null -w '%{http_code}' -X OPTIONS \
          -H 'Origin: https://dash.tokenqiao.com' \
          -H 'Access-Control-Request-Method: GET' \
          "$url" || true
      )"
    else
      code="$(curl -sS -o /dev/null -w '%{http_code}' "$url" || true)"
    fi

    if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
      log "$name OK ($code)"
      return
    fi

    sleep 1
  done

  die "$name did not return HTTP 2xx/3xx; last status: ${code:-none}; url: $url"
}

build_remote_command() {
  local cmd
  cmd="cd $(quote "$APP_DIR")"

  if [[ "$SKIP_PULL" != "1" ]]; then
    cmd+=" && git fetch $(quote "$REMOTE_NAME")"
    cmd+=" && git pull --ff-only $(quote "$REMOTE_NAME") $(quote "$BRANCH")"
  fi

  cmd+=" && APP_DIR=$(quote "$APP_DIR")"
  cmd+=" BRANCH=$(quote "$BRANCH")"
  cmd+=" REMOTE_NAME=$(quote "$REMOTE_NAME")"
  cmd+=" SKIP_INSTALL=$(quote "${SKIP_INSTALL:-0}")"
  cmd+=" SKIP_BUILD=$(quote "${SKIP_BUILD:-0}")"
  cmd+=" SKIP_VERIFY=$(quote "${SKIP_VERIFY:-0}")"
  cmd+=" ALLOW_DIRTY=$(quote "${ALLOW_DIRTY:-0}")"
  cmd+=" DEPLOY_RUN_ON_SERVER=1"
  cmd+=" bash ./deploy.sh --skip-pull"

  printf '%s' "$cmd"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-pull)
      SKIP_PULL=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown argument: $1"
      ;;
  esac
  shift
done

SSH_KEY="${SSH_KEY/#\~/$HOME}"

if [[ "${DEPLOY_RUN_ON_SERVER:-0}" != "1" ]]; then
  [[ -n "$SSH_KEY" ]] || die "SSH_KEY cannot be empty for remote deploy"
  [[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY"

  log "deploying on $REMOTE_HOST:$APP_DIR"
  ssh -i "$SSH_KEY" -o BatchMode=yes "$REMOTE_HOST" "$(build_remote_command)"
  exit
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
elif [[ -d "$SCRIPT_DIR/.git" ]]; then
  cd "$SCRIPT_DIR"
else
  die "cannot find a git checkout at APP_DIR=$APP_DIR or script directory=$SCRIPT_DIR"
fi

require_command git
require_command pnpm
require_command pm2
require_command curl

check_clean_worktree

if [[ "$SKIP_PULL" != "1" ]]; then
  log "pulling $REMOTE_NAME/$BRANCH"
  git fetch "$REMOTE_NAME"
  git pull --ff-only "$REMOTE_NAME" "$BRANCH"
fi

require_env_key ".env" "DATABASE_URL"
require_env_key ".env" "ADMIN_UI_SESSION_SECRET"
require_env_key ".env" "INTERNAL_TOKEN"
require_env_key ".env" "RELAY_CONTROL_URL"
require_env_key ".env" "BETTER_AUTH_DATABASE_URL"
require_env_key ".env" "BETTER_AUTH_API_URL"
require_env_key "web/.env.production" "VITE_API_BASE_URL"

if [[ "${SKIP_INSTALL:-0}" != "1" ]]; then
  log "installing dependencies"
  pnpm install --frozen-lockfile
fi

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "building relay, server, and admin web"
  pnpm build
fi

log "restarting PM2 processes"
pm2 restart cor-relay --update-env
pm2 restart cor-server --update-env
pm2 save

if [[ "${SKIP_VERIFY:-0}" != "1" ]]; then
  log "verifying local services"
  wait_for_http "local relay health" "http://127.0.0.1:3560/healthz"
  wait_for_http "local server health" "http://127.0.0.1:3561/healthz"

  log "verifying public endpoints"
  wait_for_http "api.tokenqiao.com health" "https://api.tokenqiao.com/healthz"
  wait_for_http "ccproxy.yohomobile.dev health" "https://ccproxy.yohomobile.dev/healthz"
  wait_for_http "dash.tokenqiao.com login" "https://dash.tokenqiao.com/login"
fi

log "deploy complete"
