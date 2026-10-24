# Captures the launcher screenshots used by README/ARCHITECTURE.
#
#   powershell -ExecutionPolicy Bypass -File scripts\capture-shots.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\capture-launcher.ps1
#
# scripts\capture-shots.ps1 is the entry point: it runs this file and then
# refreshes docs\media\* through tools\media.mjs (brief #3, U5). Run this file
# directly when you only touched the launcher UI.
#
# Replaces the old tools/screenshot.mjs, which drove a Playwright browser at the
# TypeScript launcher; the launcher is now a native window, so the shots are
# taken from the real thing:
#
#   * the launcher is restarted, so the capture owns exactly one window
#   * the window is resized until its *client* area is 1440x900 logical, and
#     PrintWindow (PW_RENDERFULLCONTENT, which works for the glow/OpenGL
#     surface) grabs the pixels
#   * the OS title bar and the 9 px window frame are cropped off, so the image
#     is the app UI alone, at the monitor's real scale
#   * the grid view is saved, then the "Table" nav label is located *in the
#     pixels* (the accent-filled nav cell plus the next bright text run) and
#     clicked, and the table view is saved
#
# Outputs docs/screenshot-launcher.png and docs/screenshot-table.png.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace W
{
    public class Api
    {
        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);

        public static string ClassOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string TitleOf(IntPtr h)
        {
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }
    }
}
'@

[void][W.Api]::SetProcessDPIAware()

$repo    = Split-Path -Parent $PSScriptRoot
$exe     = Join-Path $repo 'launcher-rs\target\release\nucleus-launcher.exe'
$docsDir = Join-Path $repo 'docs'
$accent  = @(109, 94, 248)   # brand violet #6D5EF8

if (-not (Test-Path -LiteralPath $exe)) {
    throw "build first: cargo build --release --manifest-path launcher-rs\Cargo.toml"
}

function Grab([IntPtr]$hwnd, [int]$left, [int]$top, [int]$right, [int]$bottom, [string]$path) {
    $wr = New-Object W.Api+RECT
    [void][W.Api]::GetWindowRect($hwnd, [ref]$wr)
    $w = $wr.Right - $wr.Left
    $h = $wr.Bottom - $wr.Top
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [W.Api]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    if (-not $ok) { throw "PrintWindow failed" }
    # Keep the client area only: drop the OS title bar and the window frame.
    $rect = New-Object System.Drawing.Rectangle($left, $top, ($w - $left - $right), ($h - $top - $bottom))
    $crop = $bmp.Clone($rect, $bmp.PixelFormat)
    $bmp.Dispose()
    $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $size = "{0}x{1}" -f $crop.Width, $crop.Height
    $crop.Dispose()
    return $size
}

function Violet-Band([string]$png) {
    # The active nav link is a rounded rect of accent (~63 px wide at 125%).
    # Frame corner brackets are accent too but only ~12 px long, so only the
    # longest *contiguous* run of a header row counts; the nav link lives in the
    # header band (48 logical px -> 60 physical). The result goes to
    # $script:band, because returning nested arrays unrolls them in PowerShell.
    $img = [System.Drawing.Bitmap]::FromFile($png)
    $top = -1; $bottom = -1; $bestFirst = -1; $bestLast = -1; $bestLen = 0
    for ($y = 0; $y -lt [Math]::Min(58, $img.Height); $y++) {
        $runFirst = -1; $runLast = -1; $bestRowFirst = -1; $bestRowLast = -1; $bestRowLen = 0
        for ($x = 0; $x -lt $img.Width; $x++) {
            $p = $img.GetPixel($x, $y)
            if ($p.R -eq $accent[0] -and $p.G -eq $accent[1] -and $p.B -eq $accent[2]) {
                if ($runFirst -lt 0) { $runFirst = $x }
                $runLast = $x
                if (($runLast - $runFirst + 1) -gt $bestRowLen) {
                    $bestRowLen = $runLast - $runFirst + 1
                    $bestRowFirst = $runFirst
                    $bestRowLast = $runLast
                }
            } else {
                $runFirst = -1; $runLast = -1
            }
        }
        if ($bestRowLen -gt 30) {
            if ($top -lt 0) { $top = $y }
            $bottom = $y
            if ($bestRowLen -gt $bestLen) {
                $bestLen = $bestRowLen; $bestFirst = $bestRowFirst; $bestLast = $bestRowLast
            }
        }
    }
    $img.Dispose()
    $script:band = $null
    if ($top -ge 0) { $script:band = @($top, $bottom, $bestFirst, $bestLast) }
}

function Find-Bright-Runs([string]$png, [int]$y, [int]$fromX) {
    # Clusters of bright pixels are glyphs: the inactive nav labels are ink on
    # the dark header. Result goes to $script:brightRuns (see the note above).
    $img = [System.Drawing.Bitmap]::FromFile($png)
    $runs = New-Object System.Collections.ArrayList
    $start = -1
    for ($x = $fromX; $x -lt $img.Width; $x++) {
        $p = $img.GetPixel($x, $y)
        $lum = 0.2126 * $p.R + 0.7152 * $p.G + 0.0722 * $p.B
        if (($lum -gt 150) -and $start -lt 0) { $start = $x }
        elseif (($lum -le 150) -and $start -ge 0) { [void]$runs.Add(@($start, ($x - 1))); $start = -1 }
    }
    if ($start -ge 0) { [void]$runs.Add(@($start, ($img.Width - 1))) }
    $img.Dispose()
    $script:brightRuns = $runs
}

# --- restart so the capture owns exactly one window -------------------------
Get-Process -Name 'nucleus-launcher' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Output ("stopping running launcher pid {0}" -f $_.Id)
    Stop-Process -Id $_.Id -Force
}
Start-Sleep -Milliseconds 600
$proc = Start-Process -FilePath $exe -WorkingDirectory $repo -PassThru
Write-Output ("launched pid {0}" -f $proc.Id)
Start-Sleep -Seconds 6

# --- pick the real window: largest visible top-level window of that pid -----
# winit also creates small helper windows, so Process.MainWindowHandle is not
# a reliable way to find the one we want to photograph.
$script:targetPid = [uint32]$proc.Id
$script:candidates = New-Object System.Collections.ArrayList
$cb = [W.Api+EnumProc] {
    param([IntPtr]$h, [IntPtr]$l)
    $winPid = [uint32]0
    [void][W.Api]::GetWindowThreadProcessId($h, [ref]$winPid)
    if ($winPid -eq $script:targetPid -and [W.Api]::IsWindowVisible($h)) {
        $r = New-Object W.Api+RECT
        [void][W.Api]::GetWindowRect($h, [ref]$r)
        [void]$script:candidates.Add([pscustomobject]@{
            Hwnd = $h; Area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
            Class = [W.Api]::ClassOf($h); Title = [W.Api]::TitleOf($h)
            W = ($r.Right - $r.Left); H = ($r.Bottom - $r.Top)
        })
    }
    return $true
}
[void][W.Api]::EnumWindows($cb, [IntPtr]::Zero)
foreach ($c in $script:candidates) {
    Write-Output ("  window {0} '{1}' class='{2}' {3}x{4}" -f $c.Hwnd, $c.Title, $c.Class, $c.W, $c.H)
}
$main = $script:candidates | Sort-Object Area -Descending | Select-Object -First 1
if (-not $main) { throw "no visible window for pid $($proc.Id)" }
$hwnd = $main.Hwnd

# --- resize so the *client* area is 1440x900 logical ------------------------
# The old shots were 2880x1800 (1440x900 at 2x); at the monitor's real scale we
# get 1800x1125 on a 125% display, which the README downscales to 820 anyway.
$wr = New-Object W.Api+RECT
$cr = New-Object W.Api+RECT
[void][W.Api]::GetWindowRect($hwnd, [ref]$wr)
[void][W.Api]::GetClientRect($hwnd, [ref]$cr)
$extraW = ($wr.Right - $wr.Left) - $cr.Right
$extraH = ($wr.Bottom - $wr.Top) - $cr.Bottom
$scale = [W.Api]::GetDpiForWindow($hwnd) / 96.0
[void][W.Api]::MoveWindow($hwnd, $wr.Left, $wr.Top, ([int](1440 * $scale) + $extraW), ([int](900 * $scale) + $extraH), $true)
[void][W.Api]::SetForegroundWindow($hwnd)
[void][W.Api]::SetCursorPos(4, 4)   # no hover tint in the shot
Start-Sleep -Milliseconds 1500

[void][W.Api]::GetWindowRect($hwnd, [ref]$wr)
[void][W.Api]::GetClientRect($hwnd, [ref]$cr)
$borderX = [int](($wr.Right - $wr.Left - $cr.Right) / 2)
$titleH = ($wr.Bottom - $wr.Top) - $cr.Bottom - $borderX
$borderBottom = ($wr.Bottom - $wr.Top) - $cr.Bottom - $titleH
Write-Output ("scale {0:0.00} client {1}x{2} frame {3}/{4}/{5}" -f $scale, $cr.Right, $cr.Bottom, $borderX, $titleH, $borderBottom)

# --- grid view --------------------------------------------------------------
$gridRaw = Join-Path $env:TEMP 'nucleus-grid-raw.png'
Write-Output ("grid: {0}" -f (Grab $hwnd $borderX $titleH $borderX $borderBottom $gridRaw))
Violet-Band $gridRaw
$box = $script:band
if (-not $box) { throw "no active nav cell found" }
$centerY = [int](($box[0] + $box[1]) / 2)

# --- click the next nav label (Table) ---------------------------------------
Find-Bright-Runs $gridRaw $centerY ($box[3] + 6)
$runs = $script:brightRuns
if ($runs.Count -eq 0) { throw "no nav label right of the active cell" }
$label = $runs[0]
$clickX = [int](($label[0] + $label[1]) / 2)
Write-Output ("grid nav cell x {0}..{1}; clicking client ({2},{3})" -f $box[2], $box[3], $clickX, $centerY)
[void][W.Api]::SetCursorPos(($wr.Left + $borderX + $clickX), ($wr.Top + $titleH + $centerY))
Start-Sleep -Milliseconds 250
[W.Api]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[W.Api]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 1200

$tableRaw = Join-Path $env:TEMP 'nucleus-table-raw.png'
Write-Output ("table: {0}" -f (Grab $hwnd $borderX $titleH $borderX $borderBottom $tableRaw))
Violet-Band $tableRaw
$box2 = $script:band
if (-not $box2) { throw "no active nav cell after the click" }
if ($box2[2] -eq $box[2]) { throw "the view did not switch (same active cell)" }
Write-Output ("table nav cell x {0}..{1} - view switched" -f $box2[2], $box2[3])

# --- publish ----------------------------------------------------------------
Move-Item -LiteralPath $gridRaw -Destination (Join-Path $docsDir 'screenshot-launcher.png') -Force
Move-Item -LiteralPath $tableRaw -Destination (Join-Path $docsDir 'screenshot-table.png') -Force
foreach ($n in @('screenshot-launcher.png', 'screenshot-table.png')) {
    $f = Get-Item -LiteralPath (Join-Path $docsDir $n)
    Write-Output ("wrote {0}  {1:N0} bytes" -f $f.Name, $f.Length)
}
