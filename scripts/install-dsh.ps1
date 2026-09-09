<#
.SYNOPSIS
  oh-story -> dsh plugin-style install / check-update / update / uninstall.
.DESCRIPTION
  Sources (priority): -Package (npm, published) > -GitHub owner/repo[@tag] > local repo via link:.
  Uses the dsh plugin manager (dsh plugin --profile ...), so oh-story joins the profile's
  dsh.profile.bundles automatically (v2.5.0+ ships the dsh.bundle metadata and a root
  cordis.patch.yml that id-targets the base skill-filesystem to expose its skills) - no manual
  ~/.dsh/cordis.patch.yml edits needed; Remove-LegacyMountRow cleans stale v2.4.x rows.
  -CheckUpdate: compare local skills/story/VERSION against GitHub tags (git ls-remote).
  -Update: link: source -> git pull; GitHub/npm source -> re-add latest. Restart dsh after updates.
  -Uninstall: dsh plugin remove + legacy junction cleanup. Idempotent.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -GitHub cttailearn/oh-story
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -GitHub "cttailearn/oh-story@v2.5.1"
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -CheckUpdate
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -Update
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -Uninstall
#>
param(
  [string]$Profile = "web",
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$Package = "",       # npm package name (published); highest priority source
  [string]$GitHub = "",        # GitHub source: "owner/repo" or "owner/repo@tag"
  [switch]$CheckUpdate,        # compare local VERSION against GitHub tags, then exit
  [switch]$Update,             # update existing install (link: -> git pull; GitHub/npm -> re-add)
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$dshHome = Join-Path $env:USERPROFILE ".dsh"
$profileDir = Join-Path $dshHome (Join-Path "profiles" $Profile)
$junctionPath = Join-Path $dshHome "skills"
$absRepo = [System.IO.Path]::GetFullPath($Repo)
$repoUrl = "https://github.com/cttailearn/oh-story.git"

function Get-LatestTag {
  $raw = git ls-remote --tags $repoUrl 2>$null
  $tags = @()
  foreach ($line in $raw) {
    if ($line -match 'refs/tags/v?(\d+)\.(\d+)\.(\d+)$') {
      $tags += [PSCustomObject]@{ Tag = ($line -split 'refs/tags/')[1]; Key = [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3] }
    }
  }
  if ($tags.Count -eq 0) { return "" }
  return ($tags | Sort-Object Key | Select-Object -Last 1).Tag
}
function Get-LocalVersion {
  $vf = Join-Path $absRepo "skills\story\VERSION"
  if (Test-Path $vf) { return (Get-Content $vf -Raw).Trim() }
  return ""
}
function Get-VersionKey {
  param([string]$Tag)
  if ($Tag -match 'v?(\d+)\.(\d+)\.(\d+)') { return [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3] }
  return -1
}
function Invoke-DshPlugin {
  # dsh plugin forwards to pnpm in the profile and reconciles dsh.profile.bundles.
  param([string[]]$DshArgs)
  & dsh plugin --profile $Profile @DshArgs 2>&1 | ForEach-Object { Write-Host $_ }
  if ($LASTEXITCODE -ne 0) { Write-Error "dsh plugin failed (exit $LASTEXITCODE)" }
}
function Remove-LegacyMountRow {
  # v2.4.x-era manual mount row in the home patch is now redundant (the package bundle
  # mounts its own skills). Idempotently delete the "- insert:" block naming oh-story-skills.
  $patchFile = Join-Path $dshHome "cordis.patch.yml"
  if (-not (Test-Path $patchFile)) { return }
  $lines = Get-Content $patchFile
  $kept = @(); $i = 0
  while ($i -lt $lines.Length) {
    $l = $lines[$i]
    $isTarget = $false
    if ($l -match "^\s*- insert:\s*$") {
      $isTarget = ($lines[$i + 1] -match "oh-story-skills")
    }
    if ($isTarget) {
      $i++
      while ($i -lt $lines.Length) {
        $n = $lines[$i]
        if ($n -match "^- ") { break }
        if ($n -notmatch "^\s" -and $n.Trim() -ne "" -and $n -notmatch "^#") { break }
        $i++
      }
      continue
    }
    $kept += $l
    $i++
  }
  if ($kept.Count -ne $lines.Count) { Set-Content $patchFile -Value ($kept -join [Environment]::NewLine) -Encoding UTF8; Write-Host "[ok] removed old oh-story-skills mount row from $patchFile" }
}
if ($CheckUpdate) {
  $local = Get-LocalVersion
  $latest = Get-LatestTag
  Write-Host "[check] local version: $local | GitHub latest tag: $latest"
  if (-not $latest) { Write-Host "[warn] cannot read GitHub tags (network/git?)" -ForegroundColor Yellow }
  else {
    $lk = Get-VersionKey $local
    $tk = Get-VersionKey $latest
    if ($tk -eq $lk) { Write-Host "[ok] already up to date" }
    elseif ($tk -gt $lk) { Write-Host "[info] new version available: $latest (local $local). Run install-dsh.ps1 -Update" -ForegroundColor Green }
    else { Write-Host "[info] GitHub is behind local ($latest < $local): local changes not pushed yet" -ForegroundColor Cyan }
  }
  exit 0
}
if ($Update) {
  Remove-LegacyMountRow
  $spec = ""
  if ($Package) { $spec = $Package }
  elseif ($GitHub) { $spec = "github:" + $GitHub }
  else {
    Write-Host "[update] link: source -> git pull"
    Push-Location $absRepo
    try { git pull --ff-only 2>&1 | ForEach-Object { Write-Host $_ }; if ($LASTEXITCODE -ne 0) { Write-Host "[warn] git pull failed (uncommitted changes?)" -ForegroundColor Yellow } } finally { Pop-Location }
    $spec = "link:" + $absRepo.Replace("\", "/")
  }
  Invoke-DshPlugin -DshArgs @("add", $spec)
  Write-Host "[done] update finished; restart dsh session to load it"
  exit 0
}
if ($Uninstall) {
  Invoke-DshPlugin -DshArgs @("remove", "oh-story")
  Remove-LegacyMountRow
  if (Test-Path $junctionPath) {
    $item = Get-Item $junctionPath
    if ($item.LinkType -eq "Junction") { cmd /c rmdir "$junctionPath" | Out-Null; Write-Host "[ok] legacy junction removed: $junctionPath" }
  }
  Write-Host "[done] oh-story dsh plugin registration removed"
  exit 0
}

# install
if (-not (Test-Path $profileDir)) { Write-Error "profile not found: $profileDir" }
$ppj = Join-Path $profileDir "package.json"
$already = $false
if (Test-Path $ppj) {
  $pj = Get-Content $ppj -Raw | ConvertFrom-Json
  if ($pj.dependencies.PSObject.Properties.Name -contains "oh-story") { $already = $true }
}
if (-not $already) {
  Remove-LegacyMountRow
  $spec = $Package
  if (-not $spec -and $GitHub) { $spec = "github:" + $GitHub }
  if (-not $spec) { $spec = "link:" + $absRepo.Replace("\", "/") }
  Invoke-DshPlugin -DshArgs @("add", $spec)
  Write-Host "[ok] oh-story installed into profile $Profile (bundle registered by dsh reconcile)"
} else {
  Write-Host "[ok] oh-story already in profile $Profile dependencies"
  Remove-LegacyMountRow
}

# verify
$skillCount = (Get-ChildItem (Join-Path $absRepo "skills\*") -Directory | Where-Object { Test-Path (Join-Path $_ "SKILL.md") }).Count
$inBundles = $false
if (Test-Path $ppj) {
  $pj = Get-Content $ppj -Raw | ConvertFrom-Json
  $inBundles = $pj.dsh.profile.bundles -contains "oh-story"
}
Write-Host "[verify] profile: $Profile | skills in package: $skillCount | in dsh.profile.bundles: $inBundles"
Write-Host "[done] restart the dsh session; the $skillCount skills should be listed and the Plugins page should show oh-story as loaded/active; type /story to trigger."