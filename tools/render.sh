#!/bin/bash
# 用本地 Chromium 无头渲染 preview/theme-preview.html 并截图
# 可选工具：只影响预览图生成，不影响 npm run check 的校验
# 用法: bash tools/render.sh [宽] [高] [输出文件]
set -e
cd "$(dirname "$0")/.."
W="${1:-1460}"; H="${2:-1330}"; OUT="${3:-preview/shot.png}"
LOG="${TMPDIR:-/tmp}/misskey-theme-render.log"

# 浏览器路径优先级：$CHROME → PATH 里的 chromium/chrome → Playwright 下载的 chromium
if [ -z "$CHROME" ]; then
	for c in chromium chromium-browser google-chrome google-chrome-stable; do
		if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
	done
fi
if [ -z "$CHROME" ]; then
	CHROME="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -x "$CHROME" ] || { echo "找不到 Chromium/Chrome，请用 CHROME=/path/to/chrome 指定"; exit 1; }

# 精简容器里 Chromium 可能缺系统库/字体，可用 CHROME_DEPS 指向解压好的依赖目录
DEPS="${CHROME_DEPS:-$HOME/.local/chrome-deps}"
if [ -d "$DEPS" ]; then
	export LD_LIBRARY_PATH="$DEPS/usr/lib/x86_64-linux-gnu:$DEPS/lib/x86_64-linux-gnu:$DEPS/usr/lib"
	[ -f "$DEPS/fonts.conf" ] && export FONTCONFIG_FILE="$DEPS/fonts.conf"
fi

# 复用 profile 前必须清 Singleton* 锁：残留锁会让 Chromium 静默失败（exit 0 却不写文件）
PROFILE="${CHROME_PROFILE:-$HOME/.cache/misskey-theme-shot}"
mkdir -p "$PROFILE"
rm -f "$PROFILE"/Singleton* 2>/dev/null || true

rm -f "$OUT"
timeout 150 "$CHROME" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir="$PROFILE" --hide-scrollbars --virtual-time-budget=4000 \
  --window-size="$W,$H" --screenshot="$OUT" "file://$PWD/preview/theme-preview.html" \
  >"$LOG" 2>&1 || true

if [ -f "$OUT" ]; then
	ls -la "$OUT"
else
	echo "截图未生成，日志尾部（$LOG）："
	grep -v -E "dbus|DBus|GLib|Warning|at Check" "$LOG" | tail -5
	exit 1
fi
