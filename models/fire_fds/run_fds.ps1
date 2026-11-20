# run_fds.ps1 -- run fire_entrance_smoke_v1.fds with the local FDS install.
#
# The Windows FDS build needs the Intel MPI runtime DLLs that ship in
#   <FDS bin>\mpi\impi.dll
# so that folder must be on PATH before fds.exe is started. Without it,
# fds.exe exits with 0xC0000135 (STATUS_DLL_NOT_FOUND).
#
# Usage:  pwsh -File run_fds.ps1
# Produces (in this directory): fire_entrance_smoke_v1_devc.csv, _hrr.csv, .out, .smv, run.log

$ErrorActionPreference = 'Stop'

$BinDir = 'E:\GeoRelay\.tools\fds\firemodels\FDS6\bin'
$FdsExe = Join-Path $BinDir 'fds.exe'
$Case   = 'fire_entrance_smoke_v1.fds'

if (-not (Test-Path $FdsExe)) { throw "fds.exe not found at $FdsExe" }

$env:PATH       = "$BinDir\mpi;$BinDir;$env:PATH"
$env:I_MPI_ROOT = "$BinDir\mpi"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

$Start  = Get-Date
$Clock  = [System.Diagnostics.Stopwatch]::StartNew()
$Output = & $FdsExe $Case 2>&1
$Code   = $LASTEXITCODE
$Clock.Stop()
$End = Get-Date

$Output | Set-Content -Path (Join-Path $Here 'run.log') -Encoding utf8

"fds exit code : $Code"
"startedAt     : $($Start.ToString('o'))"
"finishedAt    : $($End.ToString('o'))"
"wallClockS    : $([math]::Round($Clock.Elapsed.TotalSeconds,1))"
