#!/bin/sh
set -eu

ANCHOR='com.tencent.wechat.update'
ANCHOR_FILE='/etc/pf.anchors/wechat-update'
PF_CONF='/etc/pf.conf'
BACKUP_DIR='/etc/pf.conf.wechat-backups'
CACHE_DIR="${HOME}/Library/Caches/com.tencent.xinWeChat"

domains='dldir1.qq.com dldir2.qq.com dldir3.qq.com dldir1v6.qq.com'

die() { printf '%s\n' "error: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" -eq 0 ] || die '请使用 sudo 执行此脚本'; }

resolve_ips() {
  command -v dig >/dev/null 2>&1 || die '需要 dig（macOS 通常已内置）'
  for domain in $domains; do
    dig +short A "$domain"
    dig +short AAAA "$domain"
  done | awk '/^[0-9]+(\.[0-9]+){3}$/ || /^[0-9A-Fa-f:]+:[0-9A-Fa-f:]+/' | sort -u
}

enable() {
  need_root
  ips="$(resolve_ips)"
  [ -n "$ips" ] || die '域名解析没有返回 IP，未修改 PF'
  mkdir -p /etc/pf.anchors "$BACKUP_DIR"
  backup="$BACKUP_DIR/pf.conf.$(date +%Y%m%d-%H%M%S)"
  cp -p "$PF_CONF" "$backup"
  {
    printf 'table <wechat_update> persist { '
    printf '%s' "$ips" | tr '\n' ' '
    printf '}\nblock drop out quick to <wechat_update>\n'
  } > "$ANCHOR_FILE"
  if ! grep -Fq 'anchor "com.tencent.wechat.update"' "$PF_CONF"; then
    printf '\n# TraceMemo: block WeChat update endpoints\nanchor "com.tencent.wechat.update"\nload anchor "com.tencent.wechat.update" from "/etc/pf.anchors/wechat-update"\n' >> "$PF_CONF"
  fi
  pfctl -vnf "$PF_CONF"
  pfctl -f "$PF_CONF"
  pfctl -E >/dev/null 2>&1 || true
  printf '已启用微信更新拦截，规则备份：%s\n' "$backup"
  printf '当前 IP：\n%s\n' "$ips"
}

disable() {
  need_root
  pfctl -a "$ANCHOR" -F all >/dev/null 2>&1 || true
  printf '已清空微信更新 PF anchor。要完全移除配置行，请从 /etc/pf.conf 删除 TraceMemo 标记的三行。\n'
}

status() {
  pfctl -s info 2>&1 | head -20
  printf '\n微信更新 anchor：\n'
  pfctl -a "$ANCHOR" -sr 2>&1 || true
  printf '\n缓存目录：\n%s\n' "$CACHE_DIR"
  ls -ldO "$CACHE_DIR" 2>/dev/null || true
}

case "${1:-status}" in
  enable) enable ;;
  disable) disable ;;
  status) status ;;
  *) die "用法：sudo $0 {enable|disable|status}" ;;
esac
