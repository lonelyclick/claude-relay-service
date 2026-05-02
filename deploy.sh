#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="tokenqiao"
APP_DIR="${APP_DIR:-/home/ubuntu/projects/tokenqiao}"
REMOTE_HOST="${REMOTE_HOST:-ubuntu@43.160.224.233}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_tencent_43_160_224_233}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
TARGET=""

usage() {
  cat <<'USAGE'
Usage: ./deploy.sh relay|server|frontend

Deploys one tokenqiao production target.

Targets:
  relay     Build and restart tokenqiao-relay only.
  server    Build and restart tokenqiao-server only.
  frontend  Build the admin web and deploy Cloudflare Pages project ccdash.

Hard requirements before deploy:
  - The local checkout must be on main.
  - The local worktree must be clean.
  - The local HEAD must already be pushed to origin/main.
  - The production checkout must also be on main and clean before pulling.

Environment overrides:
  REMOTE_HOST=ubuntu@43.160.224.233
  SSH_KEY=~/.ssh/id_ed25519_tencent_43_160_224_233
  APP_DIR=/home/ubuntu/projects/tokenqiao
  BRANCH=main
  REMOTE_NAME=origin
  CLOUDFLARE_EMAIL=...
  CLOUDFLARE_API_KEY=...
  CLOUDFLARE_ACCOUNT_ID=...
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

require_present_env() {
  local key="$1"
  [[ -n "${!key:-}" ]] || die "missing required environment variable: $key"
}

load_cloudflare_env() {
  local candidates=()
  local env_file

  [[ -z "${CLOUDFLARE_ENV_FILE:-}" ]] || candidates+=("$CLOUDFLARE_ENV_FILE")
  candidates+=(".deploy.cloudflare.env" "$HOME/.config/yoho/cloudflare-default.env")

  for env_file in "${candidates[@]}"; do
    if [[ -f "$env_file" ]]; then
      set -a
      # shellcheck disable=SC1090
      source "$env_file"
      set +a
      log "loaded Cloudflare credentials from $env_file"
      return
    fi
  done
}

ensure_main_branch() {
  local label="$1"
  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ "$current_branch" == "$BRANCH" ]] || die "$label must be on $BRANCH, current branch is $current_branch"
}

ensure_clean_worktree() {
  local label="$1"
  local status
  status="$(git status --porcelain --untracked-files=normal)"
  if [[ -n "$status" ]]; then
    printf '%s\n' "$status" >&2
    die "$label worktree is not clean; commit or stash changes before deploying"
  fi
}

ensure_local_head_pushed() {
  local local_head
  local remote_head

  log "checking $REMOTE_NAME/$BRANCH"
  git fetch "$REMOTE_NAME" "$BRANCH"
  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse "$REMOTE_NAME/$BRANCH")"
  [[ "$local_head" == "$remote_head" ]] || die "local HEAD is not pushed to $REMOTE_NAME/$BRANCH"
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
  cmd+=" && current_branch=\$(git rev-parse --abbrev-ref HEAD)"
  cmd+=" && if [ \"\$current_branch\" != $(quote "$BRANCH") ]; then printf '%s\n' 'ERROR: production checkout is not on required branch' >&2; exit 1; fi"
  cmd+=" && if [ -n \"\$(git status --porcelain --untracked-files=normal)\" ]; then git status --short; printf '%s\n' 'ERROR: production worktree is not clean' >&2; exit 1; fi"
  cmd+=" && git fetch $(quote "$REMOTE_NAME") $(quote "$BRANCH")"
  cmd+=" && git pull --ff-only $(quote "$REMOTE_NAME") $(quote "$BRANCH")"
  cmd+=" && APP_DIR=$(quote "$APP_DIR")"
  cmd+=" BRANCH=$(quote "$BRANCH")"
  cmd+=" REMOTE_NAME=$(quote "$REMOTE_NAME")"
  cmd+=" CI=true"
  cmd+=" DEPLOY_RUN_ON_SERVER=1"
  cmd+=" DEPLOY_SKIP_PULL=1"
  cmd+=" bash ./deploy.sh $(quote "$TARGET")"

  printf '%s' "$cmd"
}

deploy_frontend() {
  require_command pnpm
  require_command wrangler
  require_command curl
  load_cloudflare_env
  require_present_env "CLOUDFLARE_EMAIL"
  require_present_env "CLOUDFLARE_API_KEY"
  require_present_env "CLOUDFLARE_ACCOUNT_ID"
  require_env_key "web/.env.production" "VITE_API_BASE_URL"

  log "installing dependencies"
  pnpm install --frozen-lockfile

  log "building admin web"
  pnpm run build:web

  log "deploying Cloudflare Pages project ccdash"
  wrangler pages deploy web/dist \
    --project-name=ccdash \
    --branch="$BRANCH"

  log "verifying Cloudflare Pages frontend"
  wait_for_http "dash.tokenqiao.com" "https://dash.tokenqiao.com/"
  wait_for_http "ccdash.pages.dev" "https://ccdash.pages.dev/"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    relay|server|frontend)
      [[ -z "$TARGET" ]] || die "deploy target was provided more than once"
      TARGET="$1"
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

[[ -n "$TARGET" ]] || {
  usage >&2
  die "missing deploy target: relay, server, or frontend"
}

SSH_KEY="${SSH_KEY/#\~/$HOME}"

if [[ "${DEPLOY_RUN_ON_SERVER:-0}" != "1" ]]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  cd "$SCRIPT_DIR"

  require_command git
  require_command ssh
  ensure_main_branch "local checkout"
  ensure_clean_worktree "local checkout"
  ensure_local_head_pushed

  if [[ "$TARGET" == "frontend" ]]; then
    deploy_frontend
    log "$TARGET deploy complete"
    exit
  fi

  [[ -n "$SSH_KEY" ]] || die "SSH_KEY cannot be empty for remote deploy"
  [[ -f "$SSH_KEY" ]] || die "SSH key not found: $SSH_KEY"

  log "deploying $TARGET on $REMOTE_HOST:$APP_DIR"
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

[[ "$TARGET" != "frontend" ]] || die "frontend target must be deployed from the local checkout, not on the production server"
ensure_main_branch "production checkout"
ensure_clean_worktree "production checkout"

if [[ "${DEPLOY_SKIP_PULL:-0}" != "1" ]]; then
  log "pulling $REMOTE_NAME/$BRANCH"
  git fetch "$REMOTE_NAME" "$BRANCH"
  git pull --ff-only "$REMOTE_NAME" "$BRANCH"
fi

case "$TARGET" in
  relay)
    require_env_key ".env" "DATABASE_URL"
    require_env_key ".env" "INTERNAL_TOKEN"

    log "installing dependencies"
    pnpm install --frozen-lockfile

    log "building relay"
    pnpm run build:relay

    log "restarting tokenqiao-relay"
    pm2 restart tokenqiao-relay --update-env
    pm2 save

    log "verifying relay endpoints"
    wait_for_http "local relay health" "http://127.0.0.1:3560/healthz"
    wait_for_http "api.tokenqiao.com health" "https://api.tokenqiao.com/healthz"
    wait_for_http "ccproxy.yohomobile.dev health" "https://ccproxy.yohomobile.dev/healthz"
    wait_for_http "ccapi.yohomobile.dev health" "https://ccapi.yohomobile.dev/healthz"
    ;;
  server)
    require_env_key ".env" "DATABASE_URL"
    require_env_key ".env" "ADMIN_UI_SESSION_SECRET"
    require_env_key ".env" "INTERNAL_TOKEN"
    require_env_key ".env" "RELAY_CONTROL_URL"
    require_env_key ".env" "BETTER_AUTH_DATABASE_URL"
    require_env_key ".env" "BETTER_AUTH_API_URL"

    log "installing dependencies"
    pnpm install --frozen-lockfile

    log "building server"
    pnpm run build:server

    log "restarting tokenqiao-server"
    pm2 restart tokenqiao-server --update-env
    pm2 save

    log "verifying server endpoints"
    wait_for_http "local server health" "http://127.0.0.1:3561/healthz"
    ;;
esac

log "$TARGET deploy complete"
