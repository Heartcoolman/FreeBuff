#!/usr/bin/env bash
set -euo pipefail

TARGET_ROOT="${1:-.}"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"
LOG_HINT="${2:-}"

if ! command -v rg >/dev/null 2>&1; then
  echo "[-] 需要 ripgrep(rg) 才能运行这个检查脚本"
  exit 2
fi

if [ ! -d "$TARGET_ROOT" ]; then
  echo "[-] 目标目录不存在: $TARGET_ROOT"
  exit 2
fi

declare -i RISK_SCORE=0

say() {
  printf '%s\n' "$*"
}

section() {
  printf '\n[%s]\n' "$1"
}

mark_ok() {
  printf '[+] %s\n' "$1"
}

mark_warn() {
  printf '[!] %s\n' "$1"
}

mark_err() {
  printf '[-] %s\n' "$1"
}

add_risk() {
  RISK_SCORE=$((RISK_SCORE + $1))
}

resolve_version() {
  if git -C "$TARGET_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$TARGET_ROOT" describe --tags --always 2>/dev/null && return 0
    git -C "$TARGET_ROOT" rev-parse --short HEAD 2>/dev/null && return 0
  fi

  local version_match
  version_match="$(rg -n --no-heading --glob '!scripts/check-newapi-stripe-webhook.sh' 'Version\s*=\s*"v?[0-9]+\.[0-9]+\.[0-9]+' "$TARGET_ROOT" 2>/dev/null | head -n 1 || true)"
  if [ -n "$version_match" ]; then
    printf '%s\n' "$version_match" | sed -E 's/.*(v[0-9]+\.[0-9]+\.[0-9]+).*/\1/'
    return 0
  fi

  return 1
}

check_patch_markers() {
  local marker_output
  marker_output="$(rg -n --no-heading --glob '!scripts/check-newapi-stripe-webhook.sh' 'StripeWebhookSecret == ""|ConstructEventWithOptions|ErrNotConfigured|http.StatusForbidden|Webhook secret is not configured' "$TARGET_ROOT" 2>/dev/null || true)"

  if [ -z "$marker_output" ]; then
    mark_warn "没有搜到明显的 Stripe webhook 修复特征，代码可能未修复或目录不对"
    add_risk 3
    return
  fi

  if printf '%s\n' "$marker_output" | rg 'StripeWebhookSecret == ""' >/dev/null 2>&1; then
    mark_ok "发现空 Stripe webhook secret 拒绝逻辑"
  else
    mark_warn "没发现显式的空 secret 拒绝逻辑"
    add_risk 2
  fi

  if printf '%s\n' "$marker_output" | rg 'ConstructEventWithOptions' >/dev/null 2>&1; then
    mark_ok "发现 Stripe 签名构造/校验调用"
  else
    mark_warn "没发现 Stripe 官方签名校验调用"
    add_risk 1
  fi

  say "$marker_output" | sed 's/^/    /'
}

check_config_files() {
  local config_hits
  config_hits="$(rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!scripts/check-newapi-stripe-webhook.sh' 'StripeWebhookSecret|STRIPE_WEBHOOK_SECRET' "$TARGET_ROOT" 2>/dev/null || true)"

  if [ -z "$config_hits" ]; then
    mark_warn "没有找到 Stripe webhook secret 配置项，若使用 Stripe 充值需要人工确认"
    add_risk 2
    return
  fi

  mark_ok "找到 Stripe webhook 相关配置引用"
  say "$config_hits" | sed 's/^/    /'

  local empty_hits
  empty_hits="$(rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!scripts/check-newapi-stripe-webhook.sh' 'StripeWebhookSecret[[:space:]]*[:=][[:space:]]*""|STRIPE_WEBHOOK_SECRET[[:space:]]*=[[:space:]]*$|STRIPE_WEBHOOK_SECRET[[:space:]]*:[[:space:]]*""' "$TARGET_ROOT" 2>/dev/null || true)"
  if [ -n "$empty_hits" ]; then
    mark_err "发现疑似空 webhook secret 配置"
    say "$empty_hits" | sed 's/^/    /'
    add_risk 4
  fi
}

collect_log_candidates() {
  local candidates=()

  if [ -n "$LOG_HINT" ] && [ -d "$LOG_HINT" ]; then
    candidates+=("$LOG_HINT")
  fi

  for dir in \
    "$TARGET_ROOT/log" \
    "$TARGET_ROOT/logs" \
    "$TARGET_ROOT/runtime" \
    "$TARGET_ROOT/storage/logs" \
    "$TARGET_ROOT/data"; do
    if [ -d "$dir" ]; then
      candidates+=("$dir")
    fi
  done

  if [ "${#candidates[@]}" -eq 0 ]; then
    return 0
  fi

  printf '%s\n' "${candidates[@]}" | awk '!seen[$0]++'
}

check_logs() {
  local log_dirs
  log_dirs="$(collect_log_candidates)"

  if [ -z "$log_dirs" ]; then
    mark_warn "没有可扫描的日志目录"
    return
  fi

  local suspicious
  suspicious="$(printf '%s\n' "$log_dirs" | while IFS= read -r dir; do
    [ -d "$dir" ] || continue
    rg -n --hidden --glob '!node_modules' --glob '!.git' --glob '!scripts/check-newapi-stripe-webhook.sh' \
      --glob '*.log' --glob '*.txt' --glob '*.out' --glob '*.json' \
      'webhook|stripe|topup|充值|payment|pending|succeeded|success' \
      "$dir" 2>/dev/null || true
  done | head -n 80)"

  if [ -z "$suspicious" ]; then
    mark_warn "没有从本地目录扫到明显的充值/webhook 相关日志"
    return
  fi

  mark_ok "扫描到可能相关的充值/webhook 日志线索"
  say "$suspicious" | sed 's/^/    /'

  local high_signal
  high_signal="$(printf '%s\n' "$suspicious" | rg 'pending.*success|success.*pending|Webhook secret is not configured|forbidden|403|trade_no|sessionAsyncPaymentSucceeded' || true)"
  if [ -n "$high_signal" ]; then
    mark_warn "存在值得人工复核的高信号日志"
    say "$high_signal" | sed 's/^/    /'
    add_risk 1
  fi
}

section "目标"
say "路径: $TARGET_ROOT"

section "版本"
if version="$(resolve_version)"; then
  say "检测到版本/标识: $version"
else
  mark_warn "未能自动识别版本，建议手工确认是否至少为 v0.12.10"
  add_risk 1
fi

section "代码修复点"
check_patch_markers

section "配置检查"
check_config_files

section "日志排查"
check_logs

section "结论"
if [ "$RISK_SCORE" -ge 6 ]; then
  mark_err "综合风险较高，建议立即升级到 v0.12.10+ 并核对真实支付流水"
elif [ "$RISK_SCORE" -ge 3 ]; then
  mark_warn "存在一定风险，建议尽快人工复核配置、版本和充值记录"
else
  mark_ok "未发现明显高风险信号，但仍建议抽查近期充值成功订单"
fi

say
say "建议动作:"
say "1. 升级到 new-api v0.12.10 或更高版本。"
say "2. 确认 StripeWebhookSecret/STRIPE_WEBHOOK_SECRET 非空。"
say "3. 对比近期充值成功订单与 Stripe 后台真实支付记录。"
say "4. 如不使用 Stripe，直接关闭对应支付入口和 webhook。"
