#!/bin/sh
# Installs Agent 自动化中台: a clone in ~/.agent-hub/app, with nothing to build and nothing else to install.
set -e
REPO="${AGENT_HUB_REPO:-https://github.com/KKKKhazix/agent-hub.git}"
ROOT="${AGENT_HUB_HOME:-$HOME/.agent-hub}"
APP="$ROOT/app"
PROGRAM="$APP/bin/agent-hub.ts"

need_node() {
  echo "$1"
  cat <<'END'
用 Homebrew 的话，node@24 装好后默认不在 PATH 上，这三行都要运行（用 bash 就把 ~/.zshrc 换成 ~/.bashrc）：
  brew install node@24
  echo "export PATH=\"$(brew --prefix node@24)/bin:\$PATH\"" >> ~/.zshrc
  source ~/.zshrc
用 nvm 的话：
  nvm install 24
  nvm alias default 24
装好后再运行一遍这个安装命令。
END
  exit 1
}

command -v git >/dev/null || { echo "需要 git。"; exit 1; }
command -v node >/dev/null || need_node "需要 Node.js 24 或更新，这台电脑上没找到。"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || need_node "需要 Node.js 24 或更新，现在是 $(node -v)。"

mkdir -p "$ROOT"
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only --quiet; else git clone --quiet --depth 1 -- "$REPO" "$APP"; fi

# Only a folder that's on PATH makes `agent-hub` work, and an agent-hub that isn't this one is someone else's to keep.
place_link() {
  case ":$PATH:" in *":$1:"*) ;; *) return 1 ;; esac
  case "$1" in /*) ;; *) return 1 ;; esac
  if [ "$1" = "$HOME/.local/bin" ]; then mkdir -p "$1" 2>/dev/null || return 1; fi
  [ -d "$1" ] && [ -w "$1" ] || return 1
  if [ -e "$1/agent-hub" ] || [ -L "$1/agent-hub" ]; then
    [ -L "$1/agent-hub" ] && [ "$1/agent-hub" -ef "$PROGRAM" ] || return 1
  fi
  ln -sf "$PROGRAM" "$1/agent-hub"
}

usual_ifs=$IFS
IFS=:
set -f
for place in "$HOME/.local/bin" $PATH; do
  if place_link "$place"; then break; fi
done
set +f
IFS=$usual_ifs

if [ -f "$ROOT/config.json" ]; then
  echo "更新好了。"
  case " $* " in *" --no-service "*) ;; *) "$PROGRAM" service install ;; esac
else
  "$PROGRAM" init "$@"
fi

if ! [ "$(command -v agent-hub)" -ef "$PROGRAM" ]; then
  echo
  echo "直接打 agent-hub 运行不了这个程序：PATH 上没有能放它的目录，或者排在前面的是另一个同名程序。"
  echo "要写完整路径 $PROGRAM，或者把这一行加进 ~/.zshrc（用 bash 就是 ~/.bashrc）："
  echo "  alias agent-hub='$PROGRAM'"
fi
