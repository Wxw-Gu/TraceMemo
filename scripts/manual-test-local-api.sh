#!/usr/bin/env bash

# TraceMemo v2.2.0 Local HTTP API 手动验收脚本
# 仅用于 macOS Terminal；不会写入或输出真实 API Token。

set -u

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:6131}"
API_BASE_URL="${API_BASE_URL%/}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tracememo-api-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS  %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL  %s%s\n' "$1" "${2:+ ($2)}"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf 'SKIP  %s\n' "$1"; }

printf 'TraceMemo Local HTTP API 手动测试\n'
printf 'API 地址: %s\n\n' "$API_BASE_URL"
read -r -s -p '请输入 API Token（不会显示）: ' API_TOKEN
printf '\n'
if [[ -z "$API_TOKEN" ]]; then
  printf 'Token 不能为空。\n'
  exit 2
fi

request() {
  local method="$1" path="$2" auth="$3" origin="$4" body="${5:-}"
  local out="$TMP_DIR/body" headers="$TMP_DIR/headers" err="$TMP_DIR/error"
  local -a args=(--silent --show-error --max-time 10 -X "$method" -D "$headers" -o "$out" -w '%{http_code}')
  [[ "$auth" == 1 ]] && args+=(-H "Authorization: Bearer $API_TOKEN")
  [[ "$auth" == invalid ]] && args+=(-H 'Authorization: Bearer invalid')
  [[ "$auth" == malformed ]] && args+=(-H 'Authorization: abc')
  [[ "$auth" == bearer-only ]] && args+=(-H 'Authorization: Bearer')
  [[ -n "$origin" ]] && args+=(-H "Origin: $origin")
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data "$body"); fi
  : >"$out"
  : >"$headers"
  : >"$err"
  local status
  status="$(curl "${args[@]}" "$API_BASE_URL$path" 2>"$err")"
  CURL_STATUS="$status"
  CURL_BODY="$(<"$out")"
  CURL_HEADERS="$(<"$headers")"
}

expect_status() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$name ($actual)"; else fail "$name" "期望 ${expected}，实际 ${actual:-000}"; fi
}

printf '%s\n' '--- 基础鉴权 ---'
request GET /api/v1/health 0 ''
expect_status 'health 无 Token' 200 "$CURL_STATUS"

request GET /api/v1/current_time 0 ''
expect_status '受保护 endpoint 无 Token' 401 "$CURL_STATUS"

request GET /api/v1/current_time invalid ''
expect_status '错误 Token' 401 "$CURL_STATUS"

request GET /api/v1/current_time 1 ''
expect_status '正确 Token' 200 "$CURL_STATUS"

request GET /api/v1/current_time malformed ''
expect_status 'Authorization: abc' 401 "$CURL_STATUS"

request GET /api/v1/current_time bearer-only ''
expect_status 'Authorization: Bearer' 401 "$CURL_STATUS"

printf '%s\n' '--- CORS ---'
request OPTIONS /api/v1/health 0 http://localhost
expect_status 'OPTIONS / CORS localhost' 204 "$CURL_STATUS"
if [[ "$CURL_HEADERS" == *'Access-Control-Allow-Origin: http://localhost'* && "$CURL_HEADERS" == *'Access-Control-Allow-Headers: Content-Type, Authorization'* ]]; then
  pass 'localhost Origin 响应头'
else
  fail 'localhost Origin 响应头'
fi

request OPTIONS /api/v1/health 0 http://evil.example.com
expect_status 'evil Origin 被拒绝' 403 "$CURL_STATUS"

request GET /api/v1/health 0 ''
if [[ "$CURL_STATUS" == 200 ]]; then pass '无 Origin 的 curl 请求'; else fail '无 Origin 的 curl 请求' "实际 ${CURL_STATUS:-000}"; fi

printf '%s\n' '--- API stop 后连接测试 ---'
RUN_STOP_CHECK="${RUN_STOP_CHECK:-0}"
if [[ -t 0 && "$RUN_STOP_CHECK" != 1 ]]; then
  read -r -p '现在请在 API Center 停止 API；完成后输入 y 验证连接失败，其他键跳过: ' STOP_CONFIRM
  [[ "$STOP_CONFIRM" == y || "$STOP_CONFIRM" == Y ]] && RUN_STOP_CHECK=1
fi
if [[ "$RUN_STOP_CHECK" == 1 ]]; then
  request GET /api/v1/health 0 ''
  if [[ "$CURL_STATUS" == 000 ]]; then
    pass 'API 已停止后连接失败'
  else
    fail 'API stop 后连接失败' "仍收到 HTTP ${CURL_STATUS:-000}"
  fi
else
  skip '未执行 stop 验证；也可在停止 API 后使用 RUN_STOP_CHECK=1 重新运行'
fi

printf '\n%s\n' '--- 人工验证项目（脚本不会自动操作） ---'
printf '%s\n' '1. API Center 默认隐藏 Token，点击“显示 Token”后可见，再点击隐藏。'
printf '%s\n' '2. 点击“复制 Token”，粘贴到安全位置确认复制成功；终端不要回显 Token。'
printf '%s\n' '3. 点击“重新生成 Token”并确认二次确认提示。'
printf '%s\n' '4. rotation 后，用旧 Token 请求 /api/v1/current_time 应立即返回 401。'
printf '%s\n' '5. 重启 App 后 Token 应保持不变。'
printf '%s\n' '6. 将 apiEnabled=false 后，API 应不再监听（可重新运行本脚本的 stop 测试）。'

printf '\n结果：PASS=%d FAIL=%d SKIP=%d\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
if (( FAIL_COUNT > 0 )); then exit 1; fi
exit 0
