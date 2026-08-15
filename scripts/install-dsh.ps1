<#
.SYNOPSIS
  oh-story -> dsh plugin-style install / check-update / update / uninstall.
.DESCRIPTION
  Sources (priority): -Package (npm, published) > -GitHub owner/repo[@tag] > local repo via link:.
  Mounts an isolated skill-filesystem provider in ~/.dsh/cordis.patch.yml (global layer, all profiles).
  -CheckUpdate: compare local skills/story/VERSION against GitHub tags (git ls-remote).
  -Update: link: source -> git pull; GitHub/npm source -> re-add latest. Restart dsh after updates.
  -Uninstall: remove mount row, profile dependency, legacy junction. Idempotent.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -GitHub cttailearn/oh-story
  powershell -ExecutionPolicy Bypass -File scripts/install-dsh.ps1 -GitHub "cttailearn/oh-story@v2.0.0"
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
$patchFile = Join-Path $dshHome "cordis.patch.yml"
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
function Remove-PatchBlock {
  $lines = Get-Content $patchFile
  $kept = @(); $i = 0
  while ($i -lt $lines.Length) {
    $l = $lines[$i]
    $isTarget = $l -match "^\s*- id: skill-filesystem\s*$"
    if (-not $isTarget -and $l -match "^\s*- insert:\s*$") {
      $isTarget = ($lines[$i + 1] -match "oh-story-skills")
    }
    if ($isTarget) {
      $i++;
      while ($i -lt $lines.Length) {
        $n = $lines[$i]
        if ($n -match "^- ") { break }
        if ($n -notmatch "^\s" -and $n.Trim() -ne "" -and $n -notmatch "^#") { break }
        $i++;
      }
      continue;
    }
    $kept += $l;
    $i++;
  }
  Set-Content $patchFile -Value ($kept -join [Environment]::NewLine) -Encoding UTF8
}

function Get-VersionKey {
  param([string]$Tag)
  if ($Tag -match 'v?(\d+)\.(\d+)\.(\d+)') { return [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3] }
  return -1
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
  $spec = ""
  if ($Package) { $spec = $Package }
  elseif ($GitHub) { $spec = "github:" + $GitHub }
  else {
    Write-Host "[update] link: source -> git pull"
    Push-Location $absRepo
    try { git pull --ff-only 2>&1 | ForEach-Object { Write-Host $_ }; if ($LASTEXITCODE -ne 0) { Write-Host "[warn] git pull failed (uncommitted changes?)" -ForegroundColor Yellow } } finally { Pop-Location }
  }
  if ($spec) {
    Push-Location $profileDir
    try { pnpm add $spec --ignore-scripts 2>&1 | ForEach-Object { Write-Host $_ }; if ($LASTEXITCODE -ne 0) { Write-Error "pnpm add failed (exit $LASTEXITCODE)" } } finally { Pop-Location }
  }
  Write-Host "[done] update finished; restart dsh session to load it"
  exit 0
}
if ($Uninstall) {
  if (Test-Path $patchFile) { Remove-PatchBlock }
  $ppj = Join-Path $profileDir "package.json"
  if (Test-Path $ppj) {
    $pj = Get-Content $ppj -Raw | ConvertFrom-Json
    if ($pj.dependencies.PSObject.Properties.Name -contains "oh-story") {
      $pj.dependencies.PSObject.Properties.Remove("oh-story")
      $json = $pj | ConvertTo-Json -Depth 10
      [System.IO.File]::WriteAllText($ppj, $json, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host "[ok] removed oh-story from $ppj"
      if (Test-Path (Join-Path $profileDir "node_modules\oh-story")) { Remove-Item (Join-Path $profileDir "node_modules\oh-story") -Force -Recurse }
    }
  }
  if (Test-Path $junctionPath) {
    $item = Get-Item $junctionPath
    if ($item.LinkType -eq "Junction") { cmd /c rmdir "$junctionPath" | Out-Null; Write-Host "[ok] legacy junction removed: $junctionPath" }
  }
  Write-Host "[done] oh-story dsh plugin registration removed"
  exit 0
}

if (-not (Test-Path $profileDir)) { Write-Error "profile not found: $profileDir" }
$ppj = Join-Path $profileDir "package.json"
$already = $false
if (Test-Path $ppj) {
  $pj = Get-Content $ppj -Raw | ConvertFrom-Json
  if ($pj.dependencies.PSObject.Properties.Name -contains "oh-story") { $already = $true }
}
if (-not $already) {
  $spec = $Package
  if (-not $spec -and $GitHub) { $spec = "github:" + $GitHub }
  if (-not $spec) { $spec = "link:" + $absRepo.Replace("\", "/") }
  Push-Location $profileDir
  try {
    $extra = if ($GitHub) { "--ignore-scripts" } else { "" }
    pnpm add $spec $extra 2>&1 | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { Write-Error "pnpm add failed (exit $LASTEXITCODE)" }
  } finally { Pop-Location }
  Write-Host "[ok] oh-story installed into profile $Profile"
} else {
  Write-Host "[ok] oh-story already in profile $Profile dependencies"
}

# mount row in home patch (merge, no duplicates)
if (-not (Test-Path $patchFile)) { Set-Content $patchFile -Value "" -Encoding UTF8 }
$content = Get-Content $patchFile -Raw
if ($content -match "oh-story-skills") {
  Write-Host "[ok] mount row already present in $patchFile"
} else {
  $blockLines = @(
    "",
    "# oh-story: plugin-style skill provider (isolated skill-filesystem instance, global layer)",
    "- insert:",
    "    - id: oh-story-skills",
    "      name: '@deepseek-ai/dsh-skill-filesystem'",
    "      config:",
    "        providerName: oh-story",
    "        includeDefaultRoots: false",
    "        customSkillDirs:",
    "          - !!js process.getBuiltinModule('node:url').fileURLToPath(new URL('node_modules/oh-story/skills/', baseUrl))"
  );
  $block = $blockLines -join [Environment]::NewLine
  $existing = ""
  if ((Get-Content $patchFile -Raw).Trim()) { $existing = (Get-Content $patchFile -Raw).TrimEnd() + [Environment]::NewLine }
  Set-Content $patchFile -Value ($existing + $block + [Environment]::NewLine) -Encoding UTF8
  Write-Host "[ok] mount row added to $patchFile"
}

# legacy cleanup: remove old user-dsh junction if it points at this repo
if (Test-Path $junctionPath) {
  $item = Get-Item $junctionPath
  if ($item.LinkType -eq "Junction" -and $item.Target -like ($absRepo + "*")) {
    cmd /c rmdir "$junctionPath" | Out-Null
    Write-Host "[ok] legacy junction removed: $junctionPath"
  } else {
    Write-Host "[skip] $junctionPath not ours, left untouched" -ForegroundColor Yellow
  }
}

# verify
$skillCount = (Get-ChildItem (Join-Path $absRepo "skills\*") -Directory | Where-Object { Test-Path (Join-Path $_ "SKILL.md") }).Count
$hasMount = (Get-Content $patchFile -Raw) -match "oh-story-skills"
Write-Host "[verify] profile: $Profile | skills in package: $skillCount | mount row: $hasMount"
Write-Host "[done] open/refresh a dsh session; the $skillCount skills should be listed; type /story to trigger."
