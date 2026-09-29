#!/usr/bin/env bash
# codex-ocfree installer — clone (if needed), put commands on PATH, run setup.
#
# Usage:
#   bash install.sh                 # 从 GitHub 安装并 setup
#   bash install.sh --no-probe      # 跳过首次模型探测（更快）
#   bash install.sh --shell bash    # 指定 shell 集成（默认按 $SHELL 自动选 bash/zsh）
#
# Env:
#   CODEX_OCFREE_REPO   覆盖仓库地址（默认 https://github.com/LiuSantu123/codex-ocfree.git）
#   CODEX_OCFREE_HOME   克隆目标（默认 ~/.local/share/codex-ocfree）
#   CODEX_OCFREE_NO_LINK=1  跳过命令链接
set -euo pipefail

REPO="${CODEX_OCFREE_REPO:-https://github.com/LiuSantu123/codex-ocfree.git}"
DEST="${CODEX_OCFREE_HOME:-$HOME/.local/share/codex-ocfree}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

say() { printf '  %s\n' "$*"; }
die() { printf '  ✗ %s\n' "$*" >&2; exit 1; }

printf 'codex-ocfree installer\n'

# 1. runtime checks -------------------------------------------------------
command -v node >/dev/null 2>&1 || die "需要 Node.js >= 22 — https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) 太旧，需要 >= 22（node:sqlite / fetch）"
say "node $(node -v)"
command -v codex >/dev/null 2>&1 || say "⚠ codex 不在 PATH — 稍后请安装: https://github.com/openai/codex"

# 2. source tree ----------------------------------------------------------
if [ -f "$HERE/package.json" ] && grep -q '"name": "codex-ocfree"' "$HERE/package.json"; then
  SRC="$HERE"
  say "使用当前目录: $SRC"
else
  SRC="$DEST"
  if [ -d "$DEST/.git" ]; then
    say "更新 $SRC"
    git -C "$SRC" pull --ff-only
  else
    command -v git >/dev/null 2>&1 || die "需要 git"
    say "克隆 $REPO -> $DEST"
    git clone --depth 1 "$REPO" "$DEST" || die "clone 失败（仓库还没发布？先本地跑: bash install.sh，或 CODEX_OCFREE_REPO=<地址>）"
  fi
fi

# 3. put commands on PATH -------------------------------------------------
if [ "${CODEX_OCFREE_NO_LINK:-0}" != "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "$SRC" && npm link) >/dev/null 2>&1
    say "npm link → codex-ocfree / ocfree"
  else
    mkdir -p "$HOME/.local/bin"
    ln -sf "$SRC/bin/codex-ocfree.mjs" "$HOME/.local/bin/codex-ocfree"
    chmod +x "$SRC/bin/codex-ocfree.mjs"
    ln -sf "$SRC/bin/codex-ocfree.mjs" "$HOME/.local/bin/ocfree"
    say "symlink → ~/.local/bin/{codex-ocfree,ocfree}"
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) say "⚠ 把 ~/.local/bin 加进 PATH:  echo 'export PATH=\$HOME/.local/bin:\$PATH' >> ~/.bashrc" ;;
    esac
  fi
fi

# 4. setup (profile + probe + catalog + isolation + shell wrapper) -------
node "$SRC/bin/codex-ocfree.mjs" setup "$@"

cat <<'EOF'
后续:
  1. source ~/.bashrc 或 ~/.zshrc（或开新终端）  # 让 codex() 包装生效
  2. codex-ocfree up                             # 起协议桥
  3. codex --profile opencode                    # 开聊（会话与裸 codex 隔离）
  体检: codex-ocfree doctor     换模型: codex-ocfree models
EOF
