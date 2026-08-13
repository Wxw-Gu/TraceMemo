#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
EXAMPLE_FILE="$REPO_ROOT/.env.example"
WORKER_DIR="$REPO_ROOT/services/share-card-worker"
BASE_CONFIG="$WORKER_DIR/wrangler.jsonc"
LOCAL_CONFIG="$WORKER_DIR/wrangler.local.jsonc"
BUCKET_NAME="wechatexplorer-share-reports"

cd "$REPO_ROOT"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '[share-card] %s\n' "$*"
}

require_project() {
  [[ -f "$BASE_CONFIG" ]] || fail "请在 TraceMemo 仓库根目录运行此脚本"
  [[ -f "$EXAMPLE_FILE" ]] || fail "缺少 .env.example"
}

ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$EXAMPLE_FILE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info "已从 .env.example 创建本机 .env"
  fi
}

read_env_value() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  printf '%s' "${line#*=}"
}

write_env_value() {
  local key="$1"
  local value="$2"
  local escaped
  escaped="$(printf '%s' "$value" | sed 's/[\\&|]/\\&/g')"
  if grep -q -E "^${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^${key}=.*$|${key}=${escaped}|" "$ENV_FILE"
    command rm "$ENV_FILE.bak"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

normalize_domain() {
  local value="$1"
  value="${value#http://}"
  value="${value#https://}"
  value="${value%%/*}"
  printf '%s' "$value"
}

ensure_upload_token() {
  local token
  token="$(read_env_value WECHAT_SHARE_UPLOAD_TOKEN)"
  if [[ ${#token} -lt 32 ]]; then
    token="$(openssl rand -hex 32)"
    write_env_value WECHAT_SHARE_UPLOAD_TOKEN "$token"
    info "已生成新的 UPLOAD_TOKEN 并安全写入 .env"
  fi
}

wrangler() {
  if [[ -x "$REPO_ROOT/node_modules/.bin/wrangler" ]]; then
    "$REPO_ROOT/node_modules/.bin/wrangler" "$@"
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm dlx wrangler@latest "$@"
  elif command -v npx >/dev/null 2>&1; then
    npx --yes wrangler@latest "$@"
  else
    fail "需要 Node.js 以及 pnpm 或 npm 才能运行 Wrangler"
  fi
}

ensure_wrangler_login() {
  if wrangler whoami >/dev/null 2>&1; then
    wrangler whoami
    return
  fi
  info "即将打开 Cloudflare OAuth 登录，请在浏览器中完成授权"
  wrangler login
  wrangler whoami
}

validate_required_config() {
  local domain app_id app_secret token
  domain="$(normalize_domain "$(read_env_value WECHAT_SHARE_DOMAIN)")"
  app_id="$(read_env_value WECHAT_SHARE_APP_ID)"
  app_secret="$(read_env_value WECHAT_SHARE_APP_SECRET)"
  token="$(read_env_value WECHAT_SHARE_UPLOAD_TOKEN)"
  [[ -n "$domain" && "$domain" != "share.example.com" ]] || fail "缺少真实 WECHAT_SHARE_DOMAIN"
  [[ -n "$app_id" ]] || fail "缺少 WECHAT_SHARE_APP_ID"
  [[ -n "$app_secret" ]] || fail "缺少 WECHAT_SHARE_APP_SECRET"
  [[ ${#token} -ge 32 ]] || fail "WECHAT_SHARE_UPLOAD_TOKEN 长度不足"
}

configure_interactively() {
  ensure_env_file
  local domain app_id app_secret
  domain="$(read_env_value WECHAT_SHARE_DOMAIN)"
  if [[ -z "$domain" || "$domain" == "share.example.com" ]]; then
    read -r -p '分享域名（例如 share.example.com，不带 https://）：' domain
    domain="$(normalize_domain "$domain")"
    [[ -n "$domain" ]] || fail "分享域名不能为空"
    write_env_value WECHAT_SHARE_DOMAIN "$domain"
  fi

  app_id="$(read_env_value WECHAT_SHARE_APP_ID)"
  if [[ -z "$app_id" ]]; then
    read -r -p '微信测试号 AppID：' app_id
    [[ -n "$app_id" ]] || fail "AppID 不能为空"
    write_env_value WECHAT_SHARE_APP_ID "$app_id"
  fi

  app_secret="$(read_env_value WECHAT_SHARE_APP_SECRET)"
  if [[ -z "$app_secret" ]]; then
    read -r -s -p '微信测试号 AppSecret（输入不会显示）：' app_secret
    printf '\n'
    [[ -n "$app_secret" ]] || fail "AppSecret 不能为空"
    write_env_value WECHAT_SHARE_APP_SECRET "$app_secret"
  fi

  ensure_upload_token
  info "本机配置已准备完成"
}

generate_local_config() {
  local domain
  domain="$(normalize_domain "$(read_env_value WECHAT_SHARE_DOMAIN)")"
  cat > "$LOCAL_CONFIG" <<EOF
{
  "\$schema": "node_modules/wrangler/config-schema.json",
  "name": "wechatexplorer-share-card",
  "main": "src/index.js",
  "compatibility_date": "2026-07-23",
  "routes": [{ "pattern": "$domain", "custom_domain": true }],
  "r2_buckets": [{ "binding": "REPORTS", "bucket_name": "$BUCKET_NAME" }],
  "triggers": { "crons": ["17 3 * * *"] },
  "vars": {
    "PUBLIC_ORIGIN": "https://$domain",
    "DEFAULT_EXPIRY_DAYS": "7"
  }
}
EOF
  info "已生成本机 Worker 配置 services/share-card-worker/wrangler.local.jsonc"
}

assert_secrets_not_tracked() {
  git check-ignore -q .env || fail ".env 未被 Git 忽略，请停止部署并检查 .gitignore"
  if git ls-files --error-unmatch .env >/dev/null 2>&1; then
    fail ".env 已被 Git 跟踪，请先从索引移除"
  fi
  if git diff --cached --name-only | grep -Eq '(^|/)\.env$|wrangler\.local\.jsonc$'; then
    fail "敏感本机配置已被暂存，请先取消暂存"
  fi
}

create_bucket_if_needed() {
  local output
  set +e
  output="$(wrangler r2 bucket create "$BUCKET_NAME" --config "$LOCAL_CONFIG" 2>&1)"
  local status=$?
  set -e
  if [[ $status -eq 0 ]]; then
    printf '%s\n' "$output"
  elif printf '%s' "$output" | grep -Eqi 'already exists|already owned|10004'; then
    info "R2 Bucket 已存在，继续部署"
  else
    printf '%s\n' "$output" >&2
    fail "创建 R2 Bucket 失败"
  fi
}

put_secrets() {
  local upload_token app_id app_secret
  upload_token="$(read_env_value WECHAT_SHARE_UPLOAD_TOKEN)"
  app_id="$(read_env_value WECHAT_SHARE_APP_ID)"
  app_secret="$(read_env_value WECHAT_SHARE_APP_SECRET)"
  printf '%s' "$upload_token" | wrangler secret put UPLOAD_TOKEN --config "$LOCAL_CONFIG"
  printf '%s' "$app_id" | wrangler secret put WECHAT_APP_ID --config "$LOCAL_CONFIG"
  printf '%s' "$app_secret" | wrangler secret put WECHAT_APP_SECRET --config "$LOCAL_CONFIG"
}

verify_service() {
  local domain health signature
  domain="$(normalize_domain "$(read_env_value WECHAT_SHARE_DOMAIN)")"
  health="$(curl -fsS --retry 5 --retry-delay 2 "https://$domain/health")"
  printf '%s' "$health" | grep -q '"storage":"ready"' || fail "健康检查未返回 storage: ready"
  signature="$(curl -fsS --retry 3 --retry-delay 2 "https://$domain/api/wx-signature?url=https%3A%2F%2F${domain}%2Fhealth")"
  printf '%s' "$signature" | grep -q '"signature"' || fail "微信 JS-SDK 签名检查失败：$signature"
  info "服务验证成功：https://$domain"
}

doctor() {
  require_project
  ensure_env_file
  ensure_upload_token
  assert_secrets_not_tracked
  info "Node: $(node --version 2>/dev/null || printf '未安装')"
  info "pnpm: $(pnpm --version 2>/dev/null || printf '未安装')"
  if wrangler --version >/dev/null 2>&1; then
    info "Wrangler 可用：$(wrangler --version | tail -n 1)"
  else
    fail "Wrangler 无法运行"
  fi
  local domain app_id app_secret
  domain="$(read_env_value WECHAT_SHARE_DOMAIN)"
  app_id="$(read_env_value WECHAT_SHARE_APP_ID)"
  app_secret="$(read_env_value WECHAT_SHARE_APP_SECRET)"
  [[ -n "$domain" && "$domain" != "share.example.com" ]] && info "分享域名：已配置" || info "分享域名：缺失"
  [[ -n "$app_id" ]] && info "微信 AppID：已配置" || info "微信 AppID：缺失"
  [[ -n "$app_secret" ]] && info "微信 AppSecret：已配置" || info "微信 AppSecret：缺失"
  info "UPLOAD_TOKEN：已配置"
}

deploy() {
  require_project
  ensure_env_file
  ensure_upload_token
  validate_required_config
  assert_secrets_not_tracked
  ensure_wrangler_login
  generate_local_config
  create_bucket_if_needed
  put_secrets
  wrangler deploy --config "$LOCAL_CONFIG"
  verify_service
}

copy_token() {
  ensure_env_file
  ensure_upload_token
  local token
  token="$(read_env_value WECHAT_SHARE_UPLOAD_TOKEN)"
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$token" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$token" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$token" | xclip -selection clipboard
  else
    fail "未找到剪贴板工具；请让用户自行从 .env 读取 WECHAT_SHARE_UPLOAD_TOKEN"
  fi
  info "UPLOAD_TOKEN 已复制到剪贴板"
}

case "${1:-doctor}" in
  doctor) doctor ;;
  configure) configure_interactively ;;
  deploy) deploy ;;
  copy-token) copy_token ;;
  *) fail "用法：$0 {doctor|configure|deploy|copy-token}" ;;
esac
