$ErrorActionPreference = "Stop"

function Write-OK   { param([string]$msg) Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Info { param([string]$msg) Write-Host "[..] $msg" -ForegroundColor Cyan }
function Write-Warn { param([string]$msg) Write-Host "[!!] $msg" -ForegroundColor Yellow }
function Write-Fail { param([string]$msg) Write-Host "[XX] $msg" -ForegroundColor Red; exit 1 }

function Has-Command {
  param([string]$cmd)
  return [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Ensure-UserPathContains {
  param([string]$pathToAdd)
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($current) { $parts = $current -split ";" }
  if ($parts -notcontains $pathToAdd) {
    $newPath = (($parts + $pathToAdd) | Where-Object { $_ } | Select-Object -Unique) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Refresh-Path
  }
}

function Winget-Install {
  param(
    [string]$id,
    [string]$commandName
  )

  if (Has-Command $commandName) {
    Write-OK "$commandName already installed"
    return $true
  }

  if (-not (Has-Command "winget")) {
    Write-Warn "winget not found; cannot install $commandName automatically"
    return $false
  }

  Write-Info "Installing $commandName via winget..."
  try {
    winget install -e --id $id --source winget --accept-source-agreements --accept-package-agreements --silent
    Refresh-Path
    if (Has-Command $commandName) {
      Write-OK "$commandName installed"
      return $true
    }
    Write-Warn "$commandName installation finished but command is still missing"
    return $false
  } catch {
    Write-Warn "$commandName install failed: $($_.Exception.Message)"
    return $false
  }
}

Write-Host ""
Write-Host "weixin-ai-bridge Windows installer" -ForegroundColor Cyan
Write-Host "workspace: $PSScriptRoot" -ForegroundColor DarkCyan
Write-Host ""

if (-not (Has-Command "node")) {
  if (-not (Winget-Install "OpenJS.NodeJS.LTS" "node")) {
    Write-Fail "Node.js is required"
  }
} else {
  Write-OK "Node.js $(node --version)"
}

if (-not (Has-Command "python")) {
  if (-not (Winget-Install "Python.Python.3" "python")) {
    Write-Fail "Python is required"
  }
} else {
  Write-OK "Python $(python --version 2>&1)"
}

if (Has-Command "npm") {
  Write-Info "Configuring npm registry..."
  npm config set registry https://registry.npmmirror.com | Out-Null
  Write-OK "npm registry configured"
}

if (Has-Command "python") {
  Write-Info "Configuring pip index..."
  python -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple | Out-Null
  Write-OK "pip index configured"

  $userBase = (python -m site --user-base).Trim()
  $pyVersion = python -c "import sys; print(f'Python{sys.version_info.major}{sys.version_info.minor}')"
  $scriptsDir = Join-Path $userBase $pyVersion
  $scriptsDir = Join-Path $scriptsDir "Scripts"
  Ensure-UserPathContains $scriptsDir

  Write-Info "Installing Python tools..."
  try {
    python -m pip install -U --index-url https://pypi.org/simple openai-whisper xlsx2csv
    Write-OK "Python tools installed"
  } catch {
    Write-Warn "Python tools install failed: $($_.Exception.Message)"
  }
}

Winget-Install "Gyan.FFmpeg" "ffmpeg" | Out-Null
Winget-Install "JohnMacFarlane.Pandoc" "pandoc" | Out-Null
Winget-Install "oschwartz10612.Poppler" "pdftotext" | Out-Null

Set-Location $PSScriptRoot

Write-Info "Installing npm dependencies..."
npm install

Write-Info "Building project..."
npm run build

Write-Info "Setting default config to codex if missing..."
$configDir = Join-Path $HOME ".weixin-ai-bridge"
$configPath = Join-Path $configDir "config.json"
if (-not (Test-Path $configPath)) {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  Set-Content -Path $configPath -Encoding UTF8 -Value "{`n  `"agent`": `"codex`"`n}"
  Write-OK "Created $configPath"
} else {
  Write-OK "Using existing $configPath"
}

Write-Host ""
Write-Host "Install finished." -ForegroundColor Green
Write-Host "Run the bot with one of these commands:" -ForegroundColor Green
Write-Host "  npm run dev -- --agent codex"
Write-Host "  npm run dev -- --agent gemini"
Write-Host "  npm run dev -- --agent claude-code"
Write-Host ""

if ($args.Count -gt 0) {
  Write-Info "Starting bot..."
  node .\dist\cli.js @args
}
