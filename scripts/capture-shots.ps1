# Refreshes every screenshot the README and the docs point at (brief #3, U5).
#
#   powershell -ExecutionPolicy Bypass -File scripts\capture-shots.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\capture-shots.ps1 -AppsOnly
#   powershell -ExecutionPolicy Bypass -File scripts\capture-shots.ps1 -LauncherOnly
#   powershell -ExecutionPolicy Bypass -File scripts\capture-shots.ps1 -Only notes
#
# Two sources, because the launcher is a native window and the apps are pages:
#
#   * scripts\capture-launcher.ps1 grabs the real launcher (grid + table view)
#     with PrintWindow; it needs a release build, so it is skipped by -AppsOnly.
#   * tools\media.mjs drives Edge over CDP for the three app screenshots
#     (docs/media/notes.png, pdf-workbench.png, image-editor.png) and the social
#     card (docs/media/social-preview.png + .github/social-preview.png).
#     -Only notes|pdf|image|social forwards to it.
#
# Nothing is committed here: the script only writes files under docs/ and
# .github/, so `git status` shows exactly what a reader will see.

param(
    [switch]$AppsOnly,      # skip the launcher window capture
    [switch]$LauncherOnly,  # skip the app screenshots + social card
    [string]$Only = ''      # notes | pdf | image | social
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if ($Only -and $LauncherOnly) {
    throw '-Only selects an app screenshot; drop -LauncherOnly.'
}
if ($Only) {
    # -Only implies "apps only": the launcher shots have no per-app granularity.
    $AppsOnly = $true
}

if (-not $AppsOnly) {
    Write-Output '=== launcher (grid + table) ==='
    & (Join-Path $PSScriptRoot 'capture-launcher.ps1')
    if ($LASTEXITCODE -ne 0) { throw "capture-launcher.ps1 failed ($LASTEXITCODE)" }
}

if (-not $LauncherOnly) {
    Write-Output '=== apps + social card ==='
    $arguments = @((Join-Path $repo 'tools\media.mjs'))
    if ($Only) { $arguments += @('--only', $Only) }
    Push-Location $repo
    try {
        & node @arguments
        if ($LASTEXITCODE -ne 0) { throw "node tools/media.mjs failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

Write-Output '=== refreshed ==='
foreach ($file in @(
        'docs\screenshot-launcher.png',
        'docs\screenshot-table.png',
        'docs\media\notes.png',
        'docs\media\pdf-workbench.png',
        'docs\media\image-editor.png',
        'docs\media\social-preview.png',
        '.github\social-preview.png'
    )) {
    $path = Join-Path $repo $file
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path
        Write-Output ('  {0,-38} {1,9:N0} bytes  {2:yyyy-MM-dd HH:mm}' -f $file, $item.Length, $item.LastWriteTime)
    }
}
