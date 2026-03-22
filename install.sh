#!/usr/bin/env bash
# ============================================================
# weixin-ai-bridge 一键安装脚本（macOS / Linux）
# 作者：花椒
# 用法：curl -fsSL https://cdn.jsdelivr.net/gh/yansc153/weixin-ai-bridge/install.sh | bash
# ============================================================
set -euo pipefail

# ── 颜色 ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${CYAN}→${RESET} $*"; }
warn() { echo -e "${YELLOW}!${RESET} $*"; }
fail() { echo -e "${RED}✗${RESET} $*"; exit 1; }

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   weixin-ai-bridge  一键安装             ║${RESET}"
echo -e "${BOLD}║   作者：花椒                              ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${RESET}"
echo ""

OS="$(uname -s)"

# ── 1. macOS: Xcode Command Line Tools ──────────────────────
if [[ "$OS" == "Darwin" ]]; then
  if ! xcode-select -p &>/dev/null; then
    info "安装 Xcode Command Line Tools（弹出安装窗口后请点击安装）..."
    xcode-select --install 2>/dev/null || true
    echo "等待 Xcode CLT 安装完成，请在弹出窗口点击【安装】..."
    until xcode-select -p &>/dev/null; do
      sleep 5
    done
    ok "Xcode Command Line Tools 已安装"
  else
    ok "Xcode Command Line Tools 已就绪"
  fi
fi

# ── 2. macOS: Homebrew（国内镜像）───────────────────────────
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v brew &>/dev/null; then
    info "安装 Homebrew（使用国内 Gitee 镜像）..."
    export HOMEBREW_BREW_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git"
    export HOMEBREW_CORE_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git"
    export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
    /bin/bash -c "$(curl -fsSL https://gitee.com/cunkai/HomebrewCN/raw/master/Homebrew.sh)" || \
      fail "Homebrew 安装失败，请手动安装后重试"
    ok "Homebrew 已安装"
  else
    ok "Homebrew 已就绪 ($(brew --version | head -1))"
  fi

  # 配置 Homebrew 国内源（加速后续安装）
  export HOMEBREW_BREW_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git"
  export HOMEBREW_CORE_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git"
  export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
  export HOMEBREW_NO_AUTO_UPDATE=1
fi

# ── 3. Node.js ≥ 18 ─────────────────────────────────────────
need_node=false
if ! command -v node &>/dev/null; then
  need_node=true
else
  node_ver=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
  [[ "$node_ver" == "old" ]] && need_node=true
fi

if [[ "$need_node" == "true" ]]; then
  info "安装 Node.js LTS..."
  if [[ "$OS" == "Darwin" ]]; then
    brew install node
  elif command -v apt-get &>/dev/null; then
    # NodeSource LTS
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
    sudo yum install -y nodejs
  else
    fail "无法自动安装 Node.js，请手动安装 Node.js ≥ 18: https://nodejs.org"
  fi
  ok "Node.js $(node --version) 已安装"
else
  ok "Node.js $(node --version) 已就绪"
fi

# ── 4. npm 国内镜像 ──────────────────────────────────────────
info "配置 npm 镜像（npmmirror.com）..."
npm config set registry https://registry.npmmirror.com
ok "npm 镜像已配置"

# ── 5. pip 国内镜像 ──────────────────────────────────────────
PIP_CMD=""
if command -v pip3 &>/dev/null; then PIP_CMD="pip3"
elif command -v pip &>/dev/null;  then PIP_CMD="pip"
fi

if [[ -n "$PIP_CMD" ]]; then
  info "配置 pip 镜像（清华 TUNA）..."
  $PIP_CMD config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null || true
  ok "pip 镜像已配置"
fi

# ── 6. 安装并启动 weixin-ai-bridge ───────────────────────────
echo ""
echo -e "${BOLD}${GREEN}环境准备完成，正在安装 weixin-ai-bridge...${RESET}"
echo ""

# Install globally from GitHub (works without npm publish)
npm install -g yansc153/weixin-ai-bridge
exec weixin-ai-bridge "$@"
