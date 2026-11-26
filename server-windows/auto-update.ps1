# ALTAKA-ALWATANIYAH - automatic update of the host computer (gateway + accounting)
# Runs every hour as a scheduled task (SYSTEM). Downloads the latest release from GitHub,
# copies the new program files (data is never touched) and restarts only what changed.
param([switch]$Force, [switch]$NoRestart, [string]$Root = 'C:\ALTAKA-ALWATANIYAH')
$ErrorActionPreference = 'Stop'
$Up = Join-Path $Root 'updater'
$Repo = 'takaalwataniya-oos/altaka-alwataniyah-field'
New-Item -ItemType Directory -Force $Up | Out-Null
$Log = Join-Path $Up 'update.log'
function L($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Add-Content -Encoding UTF8 $Log }
function Status($o) { $o | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 (Join-Path $Up 'status.json') }
if ((Test-Path $Log) -and (Get-Item $Log).Length -gt 1MB) { Move-Item -Force $Log "$Log.old" }

$parts = @(
  @{ name = 'gateway';    asset = 'ALTAKA-ALWATANIYAH-Server-Windows.zip';            port = 8780; task = 'ALTAKA-ALWATANIYAH Gateway' },
  @{ name = 'accounting'; asset = 'ALTAKA-ALWATANIYAH-Accounting-Server-Windows.zip'; port = 8790; task = 'ALTAKA-ALWATANIYAH Accounting' }
)

function Restart-Part($p) {
  $dst = Join-Path $Root $p.name
  schtasks /End /TN $p.task 2>$null | Out-Null
  Get-NetTCPConnection -State Listen -LocalPort $p.port -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
  schtasks /Run /TN $p.task 2>$null | Out-Null
  for ($i = 0; $i -lt 15; $i++) { Start-Sleep 2; if (Get-NetTCPConnection -State Listen -LocalPort $p.port -ErrorAction SilentlyContinue) { return $true } }
  # nobody signed in: start it hidden directly
  $vbs = Join-Path $dst 'run-hidden.vbs'
  if (Test-Path $vbs) { Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WindowStyle Hidden }
  for ($i = 0; $i -lt 15; $i++) { Start-Sleep 2; if (Get-NetTCPConnection -State Listen -LocalPort $p.port -ErrorAction SilentlyContinue) { return $true } }
  return $false
}

$st = @{ lastCheck = (Get-Date).ToString('s'); release = ''; parts = @{} }
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rel = Invoke-RestMethod -UseBasicParsing -TimeoutSec 60 -Headers @{ 'User-Agent' = 'altaka-updater' } "https://api.github.com/repos/$Repo/releases/latest"
  $st.release = $rel.name
  foreach ($p in $parts) {
    $dst = Join-Path $Root $p.name
    if (-not (Test-Path (Join-Path $dst 'server.js'))) { continue }   # not installed on this computer
    $a = $rel.assets | Where-Object { $_.name -eq $p.asset } | Select-Object -First 1
    if (-not $a) { continue }
    $stampFile = Join-Path $Up ($p.name + '.version')
    $ver = "$($a.id)|$($a.updated_at)"
    if (-not $Force -and (Test-Path $stampFile) -and ((Get-Content $stampFile -Raw).Trim() -eq $ver)) { $st.parts[$p.name] = 'up to date'; continue }
    $zip = Join-Path $Up ($p.name + '.zip'); $ex = Join-Path $Up ($p.name + '-new')
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Headers @{ 'User-Agent' = 'altaka-updater' } $a.browser_download_url -OutFile $zip
    if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
    Expand-Archive -Force $zip $ex
    $src = Get-ChildItem $ex -Recurse -Directory | Where-Object { $_.Name -eq $p.name -and (Test-Path (Join-Path $_.FullName 'server.js')) } | Select-Object -First 1
    if (-not $src) { throw "$($p.asset): program folder not found in the zip" }
    # copy program files only (the data folder is never touched)
    robocopy $src.FullName $dst /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
    $rc = $LASTEXITCODE
    if ($rc -ge 8) { throw "robocopy failed ($rc) for $($p.name)" }
    # keep the updater and helper files up to date too
    $pkg = $src.Parent.FullName
    $au = Join-Path $pkg 'auto-update.ps1'; if (Test-Path $au) { Copy-Item -Force $au (Join-Path $Up 'auto-update.ps1') }
    $rg = Join-Path $pkg 'restart-gateway.bat'; if ($p.name -eq 'gateway' -and (Test-Path $rg)) { Copy-Item -Force $rg (Join-Path $dst 'restart-gateway.bat') }
    if ($rc -ge 1 -or $Force) {
      $ok = if ($NoRestart) { 'skipped (test)' } else { Restart-Part $p }
      L "$($p.name): updated to '$($rel.name)' - restarted: $ok"
      $st.parts[$p.name] = "updated to $($rel.name) (restarted: $ok)"
      $st.lastUpdate = (Get-Date).ToString('s')
    } else { $st.parts[$p.name] = 'up to date'; L "$($p.name): no file changes in '$($rel.name)'" }
    Set-Content -Encoding ASCII $stampFile $ver
    Remove-Item -Force $zip -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force $ex -ErrorAction SilentlyContinue
  }
} catch { $st.error = $_.Exception.Message; L ("ERROR: " + $_.Exception.Message) }
$prev = $null; try { $prev = Get-Content (Join-Path $Up 'status.json') -Raw | ConvertFrom-Json } catch {}
if (-not $st.lastUpdate -and $prev -and $prev.lastUpdate) { $st.lastUpdate = $prev.lastUpdate }
Status $st
