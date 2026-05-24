# deploy-ldev/build-and-ship.ps1
#
# Build → tar → scp → load → up. End-to-end deploy of the timesheet
# app to the Lightsail ldev host (user.webilent.tm.ldev.acufy.ai).
#
# Run from the repo root:
#   .\deploy-ldev\build-and-ship.ps1
#
# Prereqs on this machine:
#   - Docker Desktop running
#   - ~/.ssh/lightsail.pem present and not chmod-readable-by-others
#   - deploy-ldev/.env.ldev exists (copy from .template and fill in)

[CmdletBinding()]
param(
    [string]$Host_     = '54.225.103.202',
    [string]$User      = 'ec2-user',
    [string]$SshKey   = "$HOME\.ssh\lightsail.pem",
    [string]$RemoteDir = '/home/ec2-user/timesheet-ldev',
    [switch]$SkipBuild,
    [switch]$SkipScp,
    [switch]$BackendOnly,
    [switch]$FrontendOnly
)

$ErrorActionPreference = 'Stop'

# Native commands (docker, scp, ssh) write progress to stderr. PowerShell
# would otherwise treat that as a terminating error under ErrorActionPreference
# = Stop. Use this helper to run a native command and trust $LASTEXITCODE only.
function Invoke-Native {
    param([string]$Description, [scriptblock]$Run)
    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Run 2>&1 | ForEach-Object { Write-Host $_ }
    } finally {
        $ErrorActionPreference = $oldEAP
    }
    if ($LASTEXITCODE -ne 0) { throw "$Description failed (exit $LASTEXITCODE)" }
}

# Resolve paths relative to this script.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$EnvFile   = Join-Path $ScriptDir '.env.ldev'
$Compose   = Join-Path $ScriptDir 'docker-compose.ldev.yml'
$ImagesDir = Join-Path $ScriptDir 'images'

if (-not (Test-Path $EnvFile)) {
    Write-Host "ERROR: $EnvFile not found." -ForegroundColor Red
    Write-Host "Copy .env.ldev.template -> .env.ldev and fill in __REPLACE_ME__ values." -ForegroundColor Yellow
    exit 1
}

# Parse .env.ldev into a hashtable. Skip comments + blank lines.
# Quoting: VAR=foo or VAR="foo" or VAR='foo' all work.
$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim()
    if ($val.StartsWith('"') -and $val.EndsWith('"')) { $val = $val.Substring(1, $val.Length - 2) }
    elseif ($val.StartsWith("'") -and $val.EndsWith("'")) { $val = $val.Substring(1, $val.Length - 2) }
    $envVars[$key] = $val
}

# Build args for the frontend image. Falls back to safe defaults if a
# template entry hasn't been filled in.
function Get-EnvOrDefault {
    param([string]$Key, [string]$Default = '')
    if ($envVars.ContainsKey($Key) -and $envVars[$Key] -ne '__REPLACE_ME__') {
        return $envVars[$Key]
    }
    return $Default
}

# Common build args. The legacy build overrides VITE_BASE_PATH and the
# switcher labels below so both UIs can coexist behind one origin.
$buildArgs = @{
    VITE_API_BASE_URL    = Get-EnvOrDefault 'VITE_API_BASE_URL' 'https://user.webilent.tm.ldev.acufy.ai'
    VITE_BASE_PATH       = Get-EnvOrDefault 'VITE_BASE_PATH' '/'
    VITE_AUTH0_DOMAIN    = Get-EnvOrDefault 'VITE_AUTH0_DOMAIN'
    VITE_AUTH0_CLIENT_ID = Get-EnvOrDefault 'VITE_AUTH0_CLIENT_ID'
    VITE_AUTH0_AUDIENCE  = Get-EnvOrDefault 'VITE_AUTH0_AUDIENCE'
    VITE_AUTH0_CONNECTION = Get-EnvOrDefault 'VITE_AUTH0_CONNECTION' 'Username-Password-Authentication'
}

$BackendImage        = 'acufy-timesheet-ldev-backend:latest'
$FrontendImage       = 'acufy-timesheet-ldev-frontend:latest'         # new UI = frontend2
$FrontendLegacyImage = 'acufy-timesheet-ldev-frontend-legacy:latest'  # classic UI = frontend
$BackendTar          = Join-Path $ImagesDir 'acufy-timesheet-ldev-backend.tar'
$FrontendTar         = Join-Path $ImagesDir 'acufy-timesheet-ldev-frontend.tar'
$FrontendLegacyTar   = Join-Path $ImagesDir 'acufy-timesheet-ldev-frontend-legacy.tar'

if (-not (Test-Path $ImagesDir)) { New-Item -ItemType Directory -Path $ImagesDir | Out-Null }

# ─── Build ──────────────────────────────────────────────────────
if (-not $SkipBuild) {
    if (-not $FrontendOnly) {
        Write-Host "==> Building backend image: $BackendImage" -ForegroundColor Cyan
        $backendCtx = (Join-Path $RepoRoot 'backend')
        Invoke-Native 'backend build' { docker build -t $BackendImage $backendCtx }
    }

    if (-not $BackendOnly) {
        # New UI (frontend2). Served at "/" on the ldev host. Switcher
        # in this build hops to /legacy/ on the same origin.
        Write-Host "==> Building NEW frontend image (frontend2): $FrontendImage" -ForegroundColor Cyan
        $newArgs = @('build', '-t', $FrontendImage)
        foreach ($k in $buildArgs.Keys) {
            $newArgs += '--build-arg'
            $newArgs += "$k=$($buildArgs[$k])"
        }
        # Switcher: same origin, hop to /legacy/, label as "Classic UI".
        $newArgs += '--build-arg'; $newArgs += 'VITE_FRONTEND_OTHER_URL='
        $newArgs += '--build-arg'; $newArgs += 'VITE_FRONTEND_OTHER_PATH=/legacy/'
        $newArgs += '--build-arg'; $newArgs += 'VITE_FRONTEND_OTHER_LABEL=Classic UI'
        $newArgs += (Join-Path $RepoRoot 'frontend2')
        Invoke-Native 'frontend2 build' { & docker @newArgs }

        # Legacy UI (frontend). Served at "/legacy/" on the ldev host.
        # Built with VITE_BASE_PATH=/legacy/ so its router and asset URLs
        # nest under that prefix. Switcher hops back to "/".
        Write-Host "==> Building LEGACY frontend image (frontend): $FrontendLegacyImage" -ForegroundColor Cyan
        $legacyOverrides = $buildArgs.Clone()
        $legacyOverrides['VITE_BASE_PATH'] = '/legacy/'
        $legArgs = @('build', '-t', $FrontendLegacyImage)
        foreach ($k in $legacyOverrides.Keys) {
            $legArgs += '--build-arg'
            $legArgs += "$k=$($legacyOverrides[$k])"
        }
        $legArgs += '--build-arg'; $legArgs += 'VITE_FRONTEND_OTHER_URL='
        $legArgs += '--build-arg'; $legArgs += 'VITE_FRONTEND_OTHER_PATH=/'
        $legArgs += '--build-arg'; $legArgs += 'VITE_FRONTEND_OTHER_LABEL=New UI'
        $legArgs += (Join-Path $RepoRoot 'frontend')
        Invoke-Native 'frontend (legacy) build' { & docker @legArgs }
    }

    # ─── Save to tar ────────────────────────────────────────────
    if (-not $FrontendOnly) {
        Write-Host "==> Saving backend image to $BackendTar" -ForegroundColor Cyan
        Invoke-Native 'backend save' { docker save -o $BackendTar $BackendImage }
    }
    if (-not $BackendOnly) {
        Write-Host "==> Saving new frontend image to $FrontendTar" -ForegroundColor Cyan
        Invoke-Native 'frontend save' { docker save -o $FrontendTar $FrontendImage }

        Write-Host "==> Saving legacy frontend image to $FrontendLegacyTar" -ForegroundColor Cyan
        Invoke-Native 'frontend-legacy save' { docker save -o $FrontendLegacyTar $FrontendLegacyImage }
    }
}

# ─── scp to host ────────────────────────────────────────────────
$sshTarget = "${User}@${Host_}"
$scpArgs   = @('-i', $SshKey, '-o', 'StrictHostKeyChecking=accept-new')
$sshArgs   = @('-i', $SshKey, '-o', 'StrictHostKeyChecking=accept-new', $sshTarget)

if (-not $SkipScp) {
    Write-Host "==> Ensuring $RemoteDir exists on host" -ForegroundColor Cyan
    Invoke-Native 'remote mkdir' { & ssh @sshArgs "mkdir -p $RemoteDir/images $RemoteDir/data/uploads $RemoteDir/nginx" }

    Write-Host "==> Copying compose + env to host" -ForegroundColor Cyan
    Invoke-Native 'scp compose'  { & scp @scpArgs $Compose "${sshTarget}:${RemoteDir}/docker-compose.yml" }

    Write-Host "==> Copying nginx config(s) to host" -ForegroundColor Cyan
    $NginxDir = Join-Path $ScriptDir 'nginx'
    if (Test-Path $NginxDir) {
        Get-ChildItem -Path $NginxDir -Filter '*.conf' | ForEach-Object {
            $localConf = $_.FullName
            $remoteConf = "${sshTarget}:${RemoteDir}/nginx/$($_.Name)"
            Invoke-Native "scp nginx $($_.Name)" { & scp @scpArgs $localConf $remoteConf }
        }
    }
    Invoke-Native 'scp env'      { & scp @scpArgs $EnvFile "${sshTarget}:${RemoteDir}/.env" }

    if (-not $FrontendOnly) {
        Write-Host "==> Copying backend tar (this can take a minute)" -ForegroundColor Cyan
        Invoke-Native 'scp backend tar' { & scp @scpArgs $BackendTar "${sshTarget}:${RemoteDir}/images/" }
    }
    if (-not $BackendOnly) {
        Write-Host "==> Copying new frontend tar" -ForegroundColor Cyan
        Invoke-Native 'scp frontend tar' { & scp @scpArgs $FrontendTar "${sshTarget}:${RemoteDir}/images/" }

        Write-Host "==> Copying legacy frontend tar" -ForegroundColor Cyan
        Invoke-Native 'scp frontend-legacy tar' { & scp @scpArgs $FrontendLegacyTar "${sshTarget}:${RemoteDir}/images/" }
    }
}

# ─── Load + restart on host ─────────────────────────────────────
$remoteLoad = @"
set -e
cd $RemoteDir
echo '==> docker load backend'
docker load -i images/acufy-timesheet-ldev-backend.tar
echo '==> docker load frontend (new)'
docker load -i images/acufy-timesheet-ldev-frontend.tar
echo '==> docker load frontend (legacy)'
docker load -i images/acufy-timesheet-ldev-frontend-legacy.tar

# Sync nginx config to the live nginx conf.d if it changed. nginx -t
# validates first; only reload on success. Falls back silently when the
# repo's nginx folder isn't present (older deploys) so this stays safe.
if [ -d nginx ]; then
  for conf in nginx/*.conf; do
    [ -e "`$conf" ] || continue
    name=`$(basename "`$conf")
    target="/etc/nginx/conf.d/`$name"
    if [ ! -e "`$target" ] || ! sudo cmp -s "`$conf" "`$target"; then
      echo "==> Updating nginx config: `$name"
      sudo cp "`$conf" "`$target"
      if sudo nginx -t 2>&1; then
        sudo systemctl reload nginx
        echo "==> nginx reloaded"
      else
        echo "==> NGINX VALIDATION FAILED, NOT reloading. Inspect /etc/nginx/conf.d/`$name and revert if needed." >&2
        exit 1
      fi
    else
      echo "==> nginx config `$name unchanged"
    fi
  done
fi

echo '==> docker compose up -d'
docker compose up -d
echo '==> waiting for backend /health (up to 90s, alembic migrations run at startup)'
for i in `$(seq 1 30); do
  if curl -fsS http://127.0.0.1:18030/health >/dev/null 2>&1; then
    echo 'backend ready'
    break
  fi
  sleep 3
done
if ! curl -fsS http://127.0.0.1:18030/health >/dev/null 2>&1; then
  echo 'HEALTH FAILED'
  docker compose logs backend --tail 100
  exit 1
fi
echo '==> health body:'
curl -fsS http://127.0.0.1:18030/health
echo ''
echo '==> compose ps'
docker compose ps
"@

Write-Host "==> Running on host: docker load + compose up + health check" -ForegroundColor Cyan
# Write the script to a temp file with explicit LF line endings, scp it to
# the host, then execute it there. Piping a here-string into `ssh bash -s`
# on Windows reliably appends \r to each line which bash treats as part of
# the command literal ('docker compose ps\r' fails as unknown command).
$LocalRemoteScript  = Join-Path $env:TEMP "timesheet-ldev-remote-$([guid]::NewGuid()).sh"
$RemoteRemoteScript = "$RemoteDir/.deploy-remote.sh"
$remoteLoadLF = ($remoteLoad -replace "`r`n", "`n") + "`n"
[System.IO.File]::WriteAllText($LocalRemoteScript, $remoteLoadLF, [System.Text.UTF8Encoding]::new($false))
try {
    Invoke-Native 'scp remote script' { & scp @scpArgs $LocalRemoteScript "${sshTarget}:${RemoteRemoteScript}" }
    Invoke-Native 'remote docker load + compose up' { & ssh @sshArgs "bash $RemoteRemoteScript" }
} finally {
    Remove-Item -Path $LocalRemoteScript -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Deploy complete. https://user.webilent.tm.ldev.acufy.ai" -ForegroundColor Green
