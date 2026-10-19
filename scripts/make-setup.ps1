# Builds the Windows installer (or a portable ZIP fallback) for Nucleus.
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-setup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\make-setup.ps1 -PortableOnly
#
# Reads the version from launcher-rs\Cargo.toml ([workspace.package]), makes
# sure the release launcher exists (building it with scripts\build-release.ps1
# when missing), then:
#
#   * with Inno Setup 6 (ISCC.exe) available  -> dist\NucleusSetup-<version>-win64.exe
#   * without Inno Setup (or -PortableOnly)   -> dist\Nucleus-<version>-win64-portable.zip
#
# The script exits 0 in both cases, so it is safe to call from CI or an agent
# even when Inno Setup is not installed. No network access, no new
# dependencies: only built-in PowerShell 5.1 cmdlets are used.
param(
    [switch]$PortableOnly
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $repo "launcher-rs\Cargo.toml"
$exe = Join-Path $repo "launcher-rs\target\release\nucleus-launcher.exe"
$iss = Join-Path $repo "scripts\nucleus.iss"
$uninstallScript = Join-Path $repo "scripts\uninstall-nucleus.ps1"
$dist = Join-Path $repo "dist"

# Reads `version = "..."` from the [workspace.package] table only, so a version
# under [workspace.dependencies] can never be mistaken for the app version.
function Get-WorkspaceVersion {
    param([string]$Path)

    $inSection = $false
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        $trimmed = $line.Trim()
        if ($trimmed -match '^\[\s*([^\]]+?)\s*\]$') {
            $inSection = ($matches[1] -eq 'workspace.package')
            continue
        }
        if ($inSection -and $trimmed -match '^version\s*=\s*"([^"]+)"') {
            return $matches[1]
        }
    }
    return $null
}

# Finds ISCC.exe in the usual Inno Setup 6 locations, then on PATH.
function Find-Iscc {
    $candidates = @()
    # A per-user install (the no-admin path: setup.exe /CURRENTUSER) lands here.
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    }
    $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
    if (-not [string]::IsNullOrWhiteSpace($pf86)) {
        $candidates += (Join-Path $pf86 "Inno Setup 6\ISCC.exe")
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    $onPath = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

# Stages nucleus-launcher.exe, uninstall-nucleus.ps1 and a README.txt, then
# zips them at the archive root. Returns the path to the ZIP.
function New-PortableZip {
    param([string]$Version)

    $zip = Join-Path $dist "Nucleus-$Version-win64-portable.zip"
    $staging = Join-Path $dist "portable-staging-$Version"
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $staging | Out-Null

    Copy-Item -LiteralPath $exe -Destination (Join-Path $staging "nucleus-launcher.exe") -Force
    Copy-Item -LiteralPath $uninstallScript -Destination (Join-Path $staging "uninstall-nucleus.ps1") -Force

    # Ship the native window shell + icon next to the launcher so Open starts
    # real WebView2 windows on machines without the repo checkout.
    foreach ($asset in @("nucleus-shell.exe", "nucleus.ico")) {
        $source = Join-Path $repo "assets\$asset"
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination (Join-Path $staging $asset) -Force
        }
    }

    $readme = @"
Nucleus $Version - portable (Windows x64)
=================================================

This ZIP is a portable build of the Nucleus launcher. No installer is
required: unzip it anywhere and run nucleus-launcher.exe.

  nucleus-launcher.exe      the launcher (native Rust, no runtime needed)
  uninstall-nucleus.ps1     removes shortcuts and, optionally, your data
  README.txt                this file

The apps Nucleus hosts are Node servers, so Node.js must be on your PATH
for them to run: https://nodejs.org  (the launcher itself does not need
Node.js.)

The launcher runs "catalogue-only" when there is no repository checkout:
it discovers installed apps under %APPDATA%\Nucleus\apps and can install
published app bundles from a catalogue.

To remove the portable build, just delete this folder. Run
uninstall-nucleus.ps1 if you also created Start Menu / desktop shortcuts
or want to remove your Nucleus data (%APPDATA%\Nucleus):

  powershell -ExecutionPolicy Bypass -File uninstall-nucleus.ps1

Want the real installer instead (NucleusSetup-$Version-win64.exe)? Install
Inno Setup 6 from https://jrsoftware.org/isdl.php and run
scripts\make-setup.ps1 from the repository.
"@
    Set-Content -LiteralPath (Join-Path $staging "README.txt") -Value $readme -Encoding ASCII

    if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -CompressionLevel Optimal
    Remove-Item -LiteralPath $staging -Recurse -Force

    return $zip
}

# --- version ---------------------------------------------------------------
$version = Get-WorkspaceVersion -Path $manifest
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "Could not read [workspace.package] version from $manifest"
}
Write-Host "Nucleus version: $version"

# --- release launcher ------------------------------------------------------
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "Release launcher not found; building it with scripts\build-release.ps1 ..."
    $build = Join-Path $repo "scripts\build-release.ps1"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $build
    if ($LASTEXITCODE -ne 0) { throw "build-release.ps1 failed with exit code $LASTEXITCODE" }
    if (-not (Test-Path -LiteralPath $exe)) { throw "build-release.ps1 produced no $exe" }
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null

# --- choose the output -----------------------------------------------------
$setup = $null
$zip = $null

if (-not $PortableOnly) {
    $iscc = Find-Iscc
    if ($iscc) {
        Write-Host "Using Inno Setup compiler: $iscc"
        & $iscc "/DAppVersion=$version" $iss
        if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
        $setup = Join-Path $dist "NucleusSetup-$version-win64.exe"
        if (-not (Test-Path -LiteralPath $setup)) { throw "ISCC did not produce $setup" }
    } else {
        Write-Warning "Inno Setup 6 (ISCC.exe) was not found."
        Write-Host "Install it from https://jrsoftware.org/isdl.php to build NucleusSetup-$version-win64.exe."
        Write-Host "Building the portable ZIP for now."
    }
}

if (-not $setup) {
    $zip = New-PortableZip -Version $version
}

# --- report ----------------------------------------------------------------
Write-Host ""
if ($setup) {
    $item = Get-Item -LiteralPath $setup
    Write-Host ("Setup    {0}" -f $item.FullName)
    Write-Host ("Size     {0:N0} bytes" -f $item.Length)
}
if ($zip) {
    $item = Get-Item -LiteralPath $zip
    Write-Host ("Portable {0}" -f $item.FullName)
    Write-Host ("Size     {0:N0} bytes" -f $item.Length)
}
