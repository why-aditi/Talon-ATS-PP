[CmdletBinding()]
param(
  [switch]$BootstrapOnly,
  [switch]$ResetDemo
)

$ErrorActionPreference = 'Stop'
$Bash = Get-Command bash -ErrorAction SilentlyContinue
$GitBash = 'C:\Program Files\Git\bin\bash.exe'
if (Test-Path $GitBash) {
  $BashPath = $GitBash
} elseif ($Bash) {
  $BashPath = $Bash.Source
} else {
  throw 'Bash is required. Install Git for Windows or run scripts/up.sh on Linux.'
}

$ScriptPath = (Join-Path $PSScriptRoot 'up.sh').Replace('\', '/')
$Arguments = @($ScriptPath)
if ($BootstrapOnly) { $Arguments += '--bootstrap-only' }
if ($ResetDemo) { $Arguments += '--reset-demo' }
& $BashPath @Arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
