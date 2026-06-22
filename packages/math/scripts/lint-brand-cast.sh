#!/usr/bin/env bash
# lint-brand-cast.sh — 业务代码 brand cast 蔓延对策（R7 / D-P15）
#
# 强制约束：`as Vec2|3|4 / as Mat3|4 / as Quat / as Color` 只允许出现在
# packages/math/src/ 内（工厂函数收口）；其它任何位置出现即视为绕过 brand 类型。
#
# 退出码：
#   0 — 业务代码无 brand cast，clean
#   1 — 命中越界 cast，列出文件路径供 reviewer 检查
#
# 关联：plan-strategy §3.1 R7 + D-P15；
#       research §Finding 7.4 R7 grep lint 兜底模板；
#       wiki/typescript-branded-types §2.2 cast 收口。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# grep 范围：packages/ 与 apps/；过滤掉 packages/math/src/（合法 cast 区）
# 与 dist/、node_modules/、.git/。
PATTERN='as Vec[234]\b\|as Mat[34]\b\|as Quat\b\|as Color\b'

# Use grep -r with --include and exclude patterns; capture output without
# failing the script on grep no-match (set -e otherwise kills us).
HITS=$(grep -rEn "${PATTERN}" \
  --include='*.ts' \
  --include='*.tsx' \
  --include='*.mts' \
  --include='*.cts' \
  packages/ apps/ 2>/dev/null \
  | grep -v '^packages/math/src/' \
  | grep -v '/dist/' \
  | grep -v '/node_modules/' \
  || true)

if [ -n "$HITS" ]; then
  echo "❌ brand cast lint 越界：业务代码不允许 'as Vec*/Mat*/Quat/Color'"
  echo "$HITS"
  exit 1
fi

echo "✅ brand cast lint clean (packages/math/src/ 外无 'as Vec*/Mat*/Quat/Color')"
exit 0
