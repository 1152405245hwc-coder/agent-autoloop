#!/bin/sh
# 装 Agent 自动化中台：克隆到 ~/.agent-hub/app，不用构建，也不装任何依赖。
set -e
REPO="${AGENT_HUB_REPO:-https://github.com/KKKKhazix/agent-hub.git}"
ROOT="${AGENT_HUB_HOME:-$HOME/.agent-hub}"
APP="$ROOT/app"

command -v git >/dev/null || { echo "需要 git。"; exit 1; }
command -v node >/dev/null || { echo "需要 Node.js 24 或更新：brew install node@24，或 nvm install 24。"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "需要 Node.js 24 或更新，现在是 $(node -v)。"; exit 1; }

mkdir -p "$ROOT"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only --quiet; else git clone --quiet --depth 1 "$REPO" "$APP"; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$APP/bin/agent-hub.ts" "$HOME/.local/bin/agent-hub"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "把 ~/.local/bin 加进 PATH：export PATH=\"\$HOME/.local/bin:\$PATH\"" ;; esac

if [ -f "$ROOT/config.json" ]; then
  echo "更新好了。"
  "$APP/bin/agent-hub.ts" service install
else
  "$APP/bin/agent-hub.ts" init "$@"
fi
