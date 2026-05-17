param(
  [string]$Root = "$env:USERPROFILE\.codex\html-artifacts",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 8787,
  [string]$Token = "",
  [string]$ReadToken = "",
  [switch]$Lan
)

$ErrorActionPreference = "Stop"

if ($Lan) {
  $HostName = "0.0.0.0"
  if (-not $Token) {
    $Token = "artifact-" + [guid]::NewGuid().ToString("N").Substring(0, 16)
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = Split-Path -Parent $scriptDir
$serverScript = Join-Path $scriptDir "artifact-server.mjs"

$argsList = @($serverScript, "--root", $Root, "--host", $HostName, "--port", [string]$Port)
if ($Token) {
  $argsList += @("--token", $Token)
}
if ($ReadToken) {
  $argsList += @("--read-token", $ReadToken)
}

Set-Location $repoDir
node @argsList
