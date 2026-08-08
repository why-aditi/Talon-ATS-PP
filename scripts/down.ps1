[CmdletBinding()]
param([switch]$All)
$ErrorActionPreference = 'Stop'
$GitBash = 'C:\Program Files\Git\bin\bash.exe'
$Bash = if (Test-Path $GitBash) { $GitBash } else { (Get-Command bash -ErrorAction Stop).Source }
$ScriptPath = (Join-Path $PSScriptRoot 'down.sh').Replace('\', '/')
$Arguments = @($ScriptPath)
if ($All) { $Arguments += '--all' }
& $Bash @Arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
