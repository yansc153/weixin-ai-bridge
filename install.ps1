# ============================================================
# weixin-ai-bridge 一键安装脚本（Windows PowerShell）
# 作者：花椒
# 用法（PowerShell 管理员）：
#   irm https://cdn.jsdelivr.net/gh/yansc153/weixin-ai-bridge/install.ps1 | iex
# ============================================================

$ErrorActionPreference = "Stop"

function Write-OK   { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Info { param($msg) Write-Host "→ $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "! $msg" -ForegroundColor Yellow }
function Write-Fail { param($msg) Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   weixin-ai-bridge  一键安装             ║" -ForegroundColor Cyan
Write-Host "║   作者：花椒                              ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 辅助函数 ────────────────────────────────────────────────
function Has-Command { param($cmd) return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}

function Winget-Install {
  param($id, $name)
  if (Has-Command $name) {
    Write-OK "$name 已就绪"
    return
  }
  Write-Info "安装 $name..."
  try {
    winget install -e --id $id --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    Write-OK "$name 已安装"
  } catch {
    Write-Warn "$name 安装失败，请手动安装：winget install $id"
  }
}

# ── 1. 检测 winget ───────────────────────────────────────────
if (-not (Has-Command "winget")) {
  Write-Warn "未检测到 winget（Windows 程序包管理器）"
  Write-Warn "请从 Microsoft Store 安装【应用安装程序】后重新运行本脚本"
  Write-Host "正在打开 Microsoft Store..." -ForegroundColor Yellow
  Start-Process "ms-appinstaller:?source=https://aka.ms/getwinget"
  Read-Host "安装完成后按 Enter 继续"
  Refresh-Path
  if (-not (Has-Command "winget")) {
    Write-Fail "winget 仍未就绪，请重启 PowerShell 后重试"
  }
}
Write-OK "winget 已就绪"

# ── 2. Node.js ≥ 18 ─────────────────────────────────────────
$needNode = $false
if (Has-Command "node") {
  $nodeVer = (node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>&1)
  if ($LASTEXITCODE -ne 0) { $needNode = $true }
} else { $needNode = $true }

if ($needNode) {
  Write-Info "安装 Node.js LTS..."
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
  Write-OK "Node.js $(node --version) 已安装"
} else {
  Write-OK "Node.js $(node --version) 已就绪"
}

# ── 3. Python 3 ─────────────────────────────────────────────
if (-not (Has-Command "python") -and -not (Has-Command "python3")) {
  Write-Info "安装 Python 3..."
  winget install -e --id Python.Python.3 --accept-source-agreements --accept-package-agreements --silent
  Refresh-Path
  Write-OK "Python 已安装"
} else {
  Write-OK "Python 已就绪"
}

# ── 4. ffmpeg ────────────────────────────────────────────────
Winget-Install "Gyan.FFmpeg" "ffmpeg"

# ── 5. pandoc ────────────────────────────────────────────────
Winget-Install "JohnMacFarlane.Pandoc" "pandoc"

# ── 6. pdftotext（poppler）──────────────────────────────────
if (-not (Has-Command "pdftotext")) {
  Write-Info "安装 poppler（pdftotext）..."
  try {
    winget install -e --id oschwartz10612.poppler --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    Write-OK "pdftotext 已安装"
  } catch {
    Write-Warn "poppler 安装失败（可选）—— PDF 提取功能不可用"
    Write-Warn "手动安装：https://github.com/oschwartz10612/poppler-windows/releases"
  }
} else {
  Write-OK "pdftotext 已就绪"
}

# ── 7. npm 国内镜像 ──────────────────────────────────────────
Write-Info "配置 npm 镜像（npmmirror.com）..."
npm config set registry https://registry.npmmirror.com
Write-OK "npm 镜像已配置"

# ── 8. pip 国内镜像 ──────────────────────────────────────────
$pipCmd = if (Has-Command "pip") { "pip" } elseif (Has-Command "pip3") { "pip3" } else { $null }
if ($pipCmd) {
  Write-Info "配置 pip 镜像（清华 TUNA）..."
  & $pipCmd config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple 2>$null
  Write-OK "pip 镜像已配置"
}

# ── 9. 安装并启动 weixin-ai-bridge ───────────────────────────
Write-Host ""
Write-Host "环境准备完成，正在安装 weixin-ai-bridge..." -ForegroundColor Green
Write-Host ""

# Download tarball (pure HTTPS, no git/SSH needed), build, and install globally
$WabTmp = Join-Path $env:TEMP ("wab_" + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $WabTmp | Out-Null
try {
  $zipUrl = "https://github.com/yansc153/weixin-ai-bridge/archive/refs/heads/main.zip"
  $zipPath = Join-Path $WabTmp "wab.zip"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $WabTmp
  $srcDir = Join-Path $WabTmp "weixin-ai-bridge-main"
  Set-Location $srcDir
  npm install
  npm run build
  npm install -g --ignore-scripts .
} finally {
  Set-Location $HOME
  Remove-Item -Recurse -Force $WabTmp -ErrorAction SilentlyContinue
}

weixin-ai-bridge @args
