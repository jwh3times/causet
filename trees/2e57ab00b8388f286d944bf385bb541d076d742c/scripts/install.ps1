# Install the prebuilt `cst` executable of causet from a GitHub release
# (ADR-0038, amendment of 2026-10-08). Needs no Node.js and no npm.
#
#   .\install.ps1 [-Version <x.y.z>] [-Prefix <directory>]
#                 [-Target <rust-target>] [-From <url-or-directory>]
#
# It downloads SHA256SUMS and this host's archive, refuses an archive whose
# SHA-256 is not the listed one, and copies cst.exe (and a vlab.cmd alias) into
# the prefix, %LOCALAPPDATA%\Programs\causet by default. It changes no PATH and
# asks for no elevation. To upgrade, run it again. To uninstall, delete the two
# files it names when it finishes.

param(
  [string]$Version = "",
  [string]$Prefix = "",
  [string]$Target = "",
  [string]$From = ""
)

$ErrorActionPreference = "Stop"
$repository = "https://github.com/jwh3times/causet"

# A refusal is thrown, not an `exit`: piped into `iex`, `exit` would close the
# caller's own session.
function Fail([string]$message) {
  throw [System.InvalidOperationException]::new($message)
}

function Install-Causet {

  $Version = $script:Version -replace "^v", ""
  $Prefix = $script:Prefix
  $Target = $script:Target
  $From = $script:From
  if (-not $Prefix) {
    $Prefix = Join-Path $env:LOCALAPPDATA "Programs\causet"
  }
  if (-not $Target) {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    $machine = switch ($architecture) {
      "AMD64" { "x86_64" }
      "ARM64" { "aarch64" }
      default { "$architecture".ToLowerInvariant() }
    }
    $Target = "$machine-pc-windows-msvc"
  }
  if (-not $From) {
    $From = if ($Version) { "$repository/releases/download/v$Version" } else { "$repository/releases/latest/download" }
  }

  $work = Join-Path ([System.IO.Path]::GetTempPath()) ("causet-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    # Copy one release file into the work directory, from a directory or a URL.
    function Fetch([string]$name) {
      $destination = Join-Path $work $name
      if ($From -match "^https?://") {
        $previous = $ProgressPreference
        $ProgressPreference = "SilentlyContinue"
        try {
          Invoke-WebRequest -Uri "$From/$name" -OutFile $destination -UseBasicParsing
        } finally {
          $ProgressPreference = $previous
        }
      } else {
        Copy-Item -LiteralPath (Join-Path $From $name) -Destination $destination
      }
    }

    try { Fetch "SHA256SUMS" } catch { Fail "SHA256SUMS could not be read from $From." }
    $listed = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $work "SHA256SUMS")) {
      if ($line -match "^([0-9a-f]{64})  (.+)$") { $listed[$Matches[2]] = $Matches[1] }
    }

    # The archive for this target, at the requested version or the one listed.
    $suffix = "-$Target.zip"
    $archive = if ($Version) {
      $name = "cst-$Version$suffix"
      if ($listed.ContainsKey($name)) { $name } else { "" }
    } else {
      $listed.Keys | Where-Object { $_.StartsWith("cst-") -and $_.EndsWith($suffix) } | Select-Object -First 1
    }
    if (-not $archive) {
      $at = if ($Version) { " at version $Version" } else { "" }
      Fail ("This release lists no cst archive for $Target$at.`n" +
        "Prebuilt executables are published for a few platforms only. The npm package`n" +
        "@holland-vip/causet carries the JavaScript CLI for every other one:`n" +
        "  npm install -g @holland-vip/causet")
    }
    $expected = $listed[$archive]

    try { Fetch $archive } catch { Fail "$archive could not be read from $From." }
    $actual = (Get-FileHash -LiteralPath (Join-Path $work $archive) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "$archive has SHA-256 $actual, not the $expected its release lists. Nothing was installed."
    }

    $unpacked = Join-Path $work "unpacked"
    Expand-Archive -LiteralPath (Join-Path $work $archive) -DestinationPath $unpacked
    $executable = Join-Path $unpacked "cst.exe"
    if (-not (Test-Path -LiteralPath $executable)) { Fail "$archive holds no cst.exe." }

    $released = $archive.Substring(4, $archive.Length - 4 - $suffix.Length)
    $reported = (& $executable --version 2>$null | Out-String).Trim()
    if ($reported -ne "causet $released") {
      Fail "The executable in $archive reports '$reported', not 'causet $released'. Nothing was installed."
    }

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    $installed = Join-Path $Prefix "cst.exe"
    $alias = Join-Path $Prefix "vlab.cmd"
    # Copied beside its destination and renamed, so cst.exe is never half written.
    $staged = Join-Path $Prefix ".cst.new"
    Copy-Item -LiteralPath $executable -Destination $staged -Force
    Move-Item -LiteralPath $staged -Destination $installed -Force
    Set-Content -LiteralPath $alias -Value '@"%~dp0cst.exe" %*' -Encoding Ascii

    Write-Output "Installed causet $released ($Target):"
    Write-Output "  $installed"
    Write-Output "  $alias -> cst.exe"
    $onPath = ($env:PATH -split ";") | Where-Object { $_.TrimEnd("\") -ieq $Prefix.TrimEnd("\") }
    if (-not $onPath) {
      Write-Output ""
      Write-Output "$Prefix is not on PATH. Add it for this session with:"
      Write-Output "  `$env:PATH = `"$Prefix;`$env:PATH`""
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}

try {
  Install-Causet
} catch {
  [Console]::Error.WriteLine("install.ps1: $($_.Exception.Message)")
  # Run as a file, the failure is the exit status; piped into `iex`, the
  # session stays open.
  if ($PSCommandPath) { exit 1 }
}
