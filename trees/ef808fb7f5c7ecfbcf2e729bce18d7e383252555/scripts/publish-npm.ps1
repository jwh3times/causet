#Requires -Version 7.0
# Publish a causet release's npm packages by hand, from the tarballs its GitHub
# release carries (#448).
#
#   pwsh -File scripts/publish-npm.ps1 -Version <x.y.z> [-DryRun] [-From <directory>]
#
# While npm/cli#9969 keeps the repository variable NPM_PUBLISH false (#139),
# npm is published by hand. Never run `npm publish` in a checkout: its
# package.json pins no platform package and carries no launcher checksums, so
# the package it publishes installs without `cst`. This script instead:
#
#   1. stops unless `npm whoami` succeeds;
#   2. downloads the release's three .tgz files and SHA256SUMS with `gh`, or
#      takes them from -From;
#   3. refuses a tarball whose SHA-256 is not the one SHA256SUMS lists;
#   4. refuses a main package that is not a release build: version <x.y.z>,
#      pinning both platform packages at <x.y.z> in optionalDependencies;
#   5. publishes the platform packages first, then the main package, skipping
#      any version npm already has, so a rerun after a partial failure is safe.
#
# Publishing under the default dist-tag moves npm's `latest` to this version,
# so run it for the version `promote.yml` made stable. -DryRun passes
# --dry-run to npm publish. PowerShell 7 is required: Windows PowerShell 5.1
# turns npm's redirected stderr into a terminating error.

param(
  [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [switch]$DryRun,
  [string]$From = ""
)

$ErrorActionPreference = "Stop"
$repository = "jwh3times/causet"
$platforms = @("@holland-vip/causet-win32-x64", "@holland-vip/causet-linux-x64-gnu")
$main = "@holland-vip/causet"
$packages = @($platforms + $main)

function Fail([string]$message) {
  [Console]::Error.WriteLine("publish-npm.ps1: $message")
  exit 1
}

# The tarball `npm pack` names for a package: @scope/name-x.y.z -> scope-name-x.y.z.tgz.
function Tarball([string]$name) {
  "$($name.TrimStart('@').Replace('/', '-'))-$Version.tgz"
}

# 1. Logged in?
$user = npm whoami 2>$null
if ($LASTEXITCODE -ne 0 -or -not $user) { Fail "npm is not logged in: run ``npm login``, then this script again." }
Write-Output "npm user: $user"

# 2. The release's own tarballs, in a directory of their own.
if ($From) {
  $dir = $From
} else {
  # Emptied first, so nothing an earlier run left can stand in for a missing asset. It stays
  # afterwards, for a rerun or a look at what was published.
  $dir = Join-Path ([IO.Path]::GetTempPath()) "causet-npm-$Version"
  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $dir | Out-Null
  gh release download "v$Version" --repo $repository --dir $dir --pattern "*.tgz" --pattern "SHA256SUMS" --clobber
  if ($LASTEXITCODE -ne 0) { Fail "could not download the v$Version release's assets" }
}

# 3. Every tarball is the one the release lists.
$listing = Join-Path $dir "SHA256SUMS"
if (-not (Test-Path -LiteralPath $listing)) { Fail "the release has no SHA256SUMS" }
$sums = @{}
foreach ($line in Get-Content -LiteralPath $listing) {
  if ($line -match '^([0-9a-f]{64})  (\S+)$') { $sums[$Matches[2]] = $Matches[1] }
}
foreach ($name in $packages) {
  $tgz = Tarball $name
  $path = Join-Path $dir $tgz
  if (-not (Test-Path -LiteralPath $path)) { Fail "the release has no $tgz" }
  if (-not $sums.ContainsKey($tgz)) { Fail "SHA256SUMS lists no digest for $tgz" }
  $actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $sums[$tgz]) { Fail "$tgz has SHA-256 $actual, not the $($sums[$tgz]) the release lists. Nothing was published." }
  Write-Output "digest ok  $tgz"
}

# 4. The main package is a release build: it pins both platform packages at this version.
$tar = if ($IsWindows) { "$env:SystemRoot\System32\tar.exe" } else { "tar" }
$json = & $tar -xzOf (Join-Path $dir (Tarball $main)) package/package.json
if ($LASTEXITCODE -ne 0) { Fail "could not read package/package.json from $(Tarball $main)" }
$manifest = $json | Out-String | ConvertFrom-Json
if ($manifest.version -ne $Version) { Fail "the main tarball is version $($manifest.version), not $Version" }
foreach ($name in $platforms) {
  if ($manifest.optionalDependencies.$name -ne $Version) {
    Fail "the main tarball does not pin $name at $Version; it is not a release build. Nothing was published."
  }
}
Write-Output "manifest ok  $main@$Version pins both platform packages"

# 5. Platform packages first, then the main package. A version npm already has is skipped.
foreach ($name in $packages) {
  $published = npm view "$name@$Version" version 2>$null
  if ($LASTEXITCODE -eq 0 -and $published) { Write-Output "already published  $name@$Version"; continue }
  $path = Join-Path $dir (Tarball $name)
  if ($DryRun) {
    npm publish $path --access public --dry-run
  } else {
    Write-Output "publishing  $name@$Version (approve npm's prompt in the browser)"
    npm publish $path --access public
  }
  if ($LASTEXITCODE -ne 0) { Fail "npm publish failed for $name@$Version; fix it and rerun: published packages are skipped" }
}

if ($DryRun) {
  Write-Output ""
  Write-Output "Dry run only: nothing was published."
  exit 0
}
Write-Output ""
Write-Output "Published. The registry can take 15-20 minutes to serve a new version (404 until then): wait, never republish."
Write-Output "Check with:"
Write-Output "  npm view $main dist-tags"
foreach ($name in $platforms) { Write-Output "  npm view $name@$Version version" }
