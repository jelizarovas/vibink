# Register Vibink once in the global Codex MCP configuration.
# The default is loopback-only; LAN access requires the explicit -AllowLan switch.

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)]
    [Alias('ExtensionIds')]
    [string[]] $ExtensionId,

    [string] $VibinkPath = 'C:\apps\vibink',

    [switch] $AllowLan,

    [switch] $Replace
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RequiredCommand {
    param([Parameter(Mandatory = $true)][string] $Name)

    $command = Get-Command $Name -ErrorAction Stop
    if (-not $command.Source) {
        throw "Could not resolve the executable path for $Name."
    }
    return $command.Source
}

function Invoke-CodexMcp {
    param(
        [Parameter(Mandatory = $true)][string] $CodexPath,
        [Parameter(Mandatory = $true)][string[]] $Arguments
    )

    & $CodexPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Codex MCP command failed with exit code $LASTEXITCODE."
    }
}

$normalizedIds = @(
    $ExtensionId |
        ForEach-Object { ([string] $_).Trim().ToLowerInvariant() } |
        Where-Object { $_ } |
        Select-Object -Unique
)

if ($normalizedIds.Count -eq 0) {
    throw 'Provide at least one Chrome extension ID.'
}
if ($normalizedIds.Count -gt 8) {
    throw 'Vibink accepts at most eight extension IDs.'
}
foreach ($id in $normalizedIds) {
    if ($id -notmatch '^[a-p]{32}$') {
        throw "Invalid Chrome extension ID: $id"
    }
}

$resolvedVibinkPath = (Resolve-Path -LiteralPath $VibinkPath -ErrorAction Stop).Path
$bridgePath = Join-Path $resolvedVibinkPath 'bridge\vibink-bridge.mjs'
if (-not (Test-Path -LiteralPath $bridgePath -PathType Leaf)) {
    throw "Vibink bridge not found at $bridgePath"
}

$nodePath = Resolve-RequiredCommand -Name 'node'
$nodeVersionText = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>\d+)\.') {
    throw 'Unable to determine the installed Node.js version.'
}
if ([int] $Matches.major -lt 22) {
    throw "Vibink requires Node.js 22 or newer; found $nodeVersionText."
}

$codexPath = Resolve-RequiredCommand -Name 'codex'

& $codexPath mcp get vibink *> $null
$registrationExists = $LASTEXITCODE -eq 0
if ($registrationExists -and -not $Replace) {
    throw 'A global MCP server named vibink already exists. Inspect it first, then rerun with -Replace only if it should be replaced.'
}

$scope = if ($AllowLan) { 'loopback and trusted private LAN' } else { 'this computer only (loopback)' }
$action = if ($registrationExists) { 'Replace global Vibink MCP registration' } else { 'Create global Vibink MCP registration' }
$target = "$resolvedVibinkPath; $scope; $($normalizedIds.Count) extension ID(s)"

if (-not $PSCmdlet.ShouldProcess($target, $action)) {
    return
}

$backupPath = $null
if ($registrationExists) {
    $profilePath = [Environment]::GetFolderPath('UserProfile')
    $configPath = Join-Path $profilePath '.codex\config.toml'
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backupPath = "$configPath.vibink-backup-$timestamp"
        Copy-Item -LiteralPath $configPath -Destination $backupPath
    }
    Invoke-CodexMcp -CodexPath $codexPath -Arguments @('mcp', 'remove', 'vibink')
}

$environmentName = if ($normalizedIds.Count -eq 1) {
    'VIBINK_EXTENSION_ID'
} else {
    'VIBINK_EXTENSION_IDS'
}
$environmentValue = $normalizedIds -join ','

$addArguments = @(
    'mcp',
    'add',
    'vibink',
    '--env',
    "$environmentName=$environmentValue",
    '--',
    $nodePath,
    $bridgePath
)
if ($AllowLan) {
    $addArguments += '--allow-lan'
}

try {
    Invoke-CodexMcp -CodexPath $codexPath -Arguments $addArguments
} catch {
    if ($backupPath) {
        Write-Warning "The prior Codex config backup remains at $backupPath. The script did not overwrite the current config automatically."
    }
    throw
}

Write-Host "Vibink is registered globally for $scope."
Write-Host 'Restart Codex, open any target repository, start a fresh task, and confirm vibink appears in the MCP server list.'
if ($backupPath) {
    Write-Host "Previous config backup: $backupPath"
}
