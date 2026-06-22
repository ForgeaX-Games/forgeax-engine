#!/usr/bin/env bash
# lint-brand-runtime.sh — V8 五铁律 brand 赋值兜底（AC-15 / R1）
#
# 强制约束：brand 字段是纯类型层 phantom，运行时绝不可被赋值。
# 任何 `obj.__vec3 = ...` / `obj.__mat4 = ...` / `obj.__quat = ...` /
# `obj.__color = ...` 都会破坏 V8 elements-kinds 单态化（TypedArray 转 dictionary
# 模式 → 慢 100x）。
#
# 退出码：
#   0 — 全包无 brand 赋值，clean
#   1 — 命中赋值，列出文件供 reviewer 检查
#
# 关联：requirements §AC-15 V8 elements-kinds 五铁律；
#       plan-strategy §3.1 R1 brand 与 V8 兼容性对策；
#       research §Finding 7.4 grep lint；
#       wiki/typescript-branded-types §4.2 反例。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# 匹配赋值语义：__vec[234] / __mat[34] / __quat / __color 后接可选空格 + '='。
# 不匹配 '==' / '===' / 函数返回类型注释中 readonly __vec3: void 等纯类型出现。
PATTERN='\.__vec[234][[:space:]]*=[^=]\|\.__mat[34][[:space:]]*=[^=]\|\.__quat[[:space:]]*=[^=]\|\.__color[[:space:]]*=[^=]'

HITS=$(grep -rEn "${PATTERN}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.mts' \
  --include='*.cts' \
  --include='*.js' \
  --include='*.mjs' \
  packages/ apps/ 2>/dev/null \
  | grep -v '/dist/' \
  | grep -v '/node_modules/' \
  || true)

if [ -n "$HITS" ]; then
  echo "❌ brand 运行时赋值越界：__vec*/__mat*/__quat/__color 不可赋值（V8 五铁律）"
  echo "$HITS"
  exit 1
fi

echo "✅ brand runtime lint clean (无 .__vec*/__mat*/__quat/__color 赋值)"
exit 0
