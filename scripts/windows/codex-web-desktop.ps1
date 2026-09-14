[CmdletBinding()]
param(
    [ValidateSet('Configure', 'Check', 'Run', 'InstallStartup', 'RemoveStartup', 'Status')]
    [string]$Action = 'Status',
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')]
    [string]$Backend = 'windows-desktop',
    [string]$Gateway,
    [string]$TokenEnv = 'CODEX_WEB_DESKTOP_AGENT_TOKEN',
    [string]$CaCertificate,
    # Configure only: keep Desktop's ChatGPT token on this computer. The remote
    # renderer then shows its sign-in gate while Codex threads keep working.
    [switch]$PrivateAccount,
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'codex-web\desktop')
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Run this connector on the Windows account running Codex Desktop.' }
# A parent PowerShell 7 process can pass its module search path to Windows
# PowerShell 5. Load the matching built-in modules from this process's PSHOME.
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security')) {
    Import-Module (Join-Path $PSHOME "Modules\$moduleName\$moduleName.psd1") -ErrorAction Stop
}
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$connectorRoot = [IO.Path]::GetFullPath((Join-Path $DataRoot $Backend))
$configPath = Join-Path $connectorRoot 'connection.json'
$secretPath = Join-Path $connectorRoot 'bridge-token.dpapi'
$runtimeRoot = Join-Path $connectorRoot 'runtime'
$installedScript = Join-Path $runtimeRoot 'scripts\windows\codex-web-desktop.ps1'
$logPath = Join-Path $connectorRoot 'bridge.log'
$taskName = "CodexWeb-Desktop-$Backend"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Read-Connection {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'Configure this Desktop connection first.'
    }
    $connection = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($connection.version -ne 1 -or $connection.backend -ne $Backend) {
        throw 'Unsupported Desktop connection configuration.'
    }
    return $connection
}

function Assert-Gateway([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) { throw 'Provide the HTTPS or WSS gateway base URL.' }
    if ($uri.Scheme -notin @('https', 'wss') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Use an HTTPS or WSS gateway base URL without credentials, query or fragment.'
    }
    $builder = [UriBuilder]::new($uri)
    $builder.Scheme = 'wss'
    return $builder.Uri.AbsoluteUri.TrimEnd('/')
}

function Quote-Literal([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }

if ($Action -eq 'Configure') {
    $gatewayUrl = Assert-Gateway $Gateway
    $sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $nodePath -p 'process.versions.node'
    if ([version]$nodeVersion -lt [version]'22.13.0') { throw 'Install Node.js 22.13 or later first.' }
    $wsRoot = Join-Path $sourceRoot 'node_modules\ws'
    if (-not (Test-Path -LiteralPath (Join-Path $wsRoot 'package.json'))) {
        throw 'Install repository dependencies first (npm ci --ignore-scripts).'
    }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($connectorRoot))
    if ($connectorRoot.StartsWith('\\') -or $drive.DriveType -eq [IO.DriveType]::Network) {
        throw 'Store the Windows connector on a local disk so sign-in startup does not depend on a network drive.'
    }
    $secureToken = $null
    $environmentToken = [Environment]::GetEnvironmentVariable($TokenEnv, 'Process')
    if ($environmentToken) {
        if ($environmentToken.Length -lt 32) { throw 'The bridge token must have at least 32 characters.' }
        $secureToken = ConvertTo-SecureString $environmentToken -AsPlainText -Force
        $environmentToken = $null
    } else {
        $secureToken = Read-Host 'Bridge token configured on the gateway (hidden)' -AsSecureString
        if ($secureToken.Length -lt 32) { throw 'The bridge token must have at least 32 characters.' }
    }
    New-Item -ItemType Directory -Path $connectorRoot -Force | Out-Null
    # Set only the DACL. Reapplying Get-Acl's owner/audit sections can require
    # SeSecurityPrivilege when configuring an already-protected directory.
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.SetAccessRule($rule)
    $directory = [IO.DirectoryInfo]::new($connectorRoot)
    if ($PSVersionTable.PSEdition -eq 'Core') {
        [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
    } else {
        $directory.SetAccessControl($acl)
    }

    # Copy only the connector runtime to local storage. No Desktop files are touched.
    New-Item -ItemType Directory -Path (Join-Path $runtimeRoot 'scripts\windows'), (Join-Path $runtimeRoot 'scripts\desktop\native'), (Join-Path $runtimeRoot 'node_modules') -Force | Out-Null
    if ($sourceRoot -ne $runtimeRoot) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\codex_web_desktop_bridge.cjs') -Destination (Join-Path $runtimeRoot 'scripts') -Force
        Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'scripts\desktop') -Filter '*.cjs' | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $runtimeRoot 'scripts\desktop') -Force
        }
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\desktop\native\contract.cjs') -Destination (Join-Path $runtimeRoot 'scripts\desktop\native') -Force
        Copy-Item -LiteralPath $PSCommandPath -Destination $installedScript -Force
        $installedWs = Join-Path $runtimeRoot 'node_modules\ws'
        New-Item -ItemType Directory -Path $installedWs -Force | Out-Null
        Get-ChildItem -LiteralPath $wsRoot | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $installedWs -Recurse -Force
        }
    }
    $caPath = $null
    if ($CaCertificate) {
        $caPath = Join-Path $connectorRoot 'gateway-ca.pem'
        $sourceCa = (Resolve-Path -LiteralPath $CaCertificate).Path
        if ($sourceCa -ne $caPath) { Copy-Item -LiteralPath $sourceCa -Destination $caPath -Force }
    }
    $secureToken | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath -Encoding UTF8
    $secureToken.Dispose()
    [ordered]@{ version = 1; backend = $Backend; gateway = $gatewayUrl; node = $nodePath; caCertificate = $caPath; privateAccount = [bool]$PrivateAccount } |
        ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
    Write-Output "Configured $Backend. Token protected for this Windows user. Local runtime: $runtimeRoot"
    Write-Output 'Use -Action Check to verify the connection, then -Action Run or -Action InstallStartup.'
    return
}

if ($Action -eq 'Status') {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    [ordered]@{
        backend = $Backend
        configured = (Test-Path -LiteralPath $configPath)
        startup = $(if ($task) { [string]$task.State } else { 'Not installed' })
        log = $logPath
        note = 'Startup task state is not proof of a live Desktop connection. Use Check when the bridge is stopped, or inspect the gateway backend status.'
    } | ConvertTo-Json
    return
}

if ($Action -eq 'RemoveStartup') {
    # Disable future sign-in launches; an existing run is deliberately left alive.
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Write-Output 'Sign-in startup removed. Existing connections and saved configuration remain available.'
    return
}

$connection = Read-Connection
$null = Assert-Gateway $connection.gateway
if ($Action -eq 'InstallStartup') {
    # MSIX-packaged parents can virtualize AppData. Task Scheduler runs outside
    # that virtualization, so persist the actual filesystem paths in its action.
    $physicalScript = & $connection.node -e 'process.stdout.write(require("fs").realpathSync.native(process.argv[1]))' $installedScript
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the installed connector path.' }
    $physicalDataRoot = & $connection.node -e 'process.stdout.write(require("fs").realpathSync.native(process.argv[1]))' $DataRoot
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the connector data path.' }
    $startupLog = Join-Path (Join-Path $physicalDataRoot $Backend) 'startup.log'
    $command = '& ' + (Quote-Literal $physicalScript) + ' -Action Run -Backend ' + (Quote-Literal $Backend) + ' -DataRoot ' + (Quote-Literal $physicalDataRoot) + ' *> ' + (Quote-Literal $startupLog)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    # Task Scheduler validates its working directory before user impersonation.
    # Use the system directory; the connector and its state use absolute paths.
    $taskAction = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded" -WorkingDirectory (Join-Path $env:WINDIR 'System32')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Output 'Windows sign-in startup installed and started. The connector waits for Desktop if it is closed.'
    return
}

$lock = $null
try {
    # The OS releases this file lock after a crash. A check never displaces a running bridge.
    $lock = [IO.File]::Open((Join-Path $connectorRoot 'running.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
} catch { throw 'This connection is already running. Inspect the gateway or bridge.log; a second bridge would be rejected.' }
$oldToken = [Environment]::GetEnvironmentVariable('CODEX_WEB_DESKTOP_AGENT_TOKEN', 'Process')
$oldCa = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'Process')
try {
    $secureToken = (Get-Content -LiteralPath $secretPath -Raw).Trim() | ConvertTo-SecureString
    $credential = [Management.Automation.PSCredential]::new('bridge', $secureToken)
    $env:CODEX_WEB_DESKTOP_AGENT_TOKEN = $credential.GetNetworkCredential().Password
    if ($connection.caCertificate) { $env:NODE_EXTRA_CA_CERTS = $connection.caCertificate }
    $bridgeArgs = @((Join-Path $runtimeRoot 'scripts\codex_web_desktop_bridge.cjs'), '--gateway', $connection.gateway, '--backend', $Backend, '--state', (Join-Path $connectorRoot 'commands.sqlite'))
    if ($Action -eq 'Check') { $bridgeArgs += '--check' } else { $bridgeArgs += '--wait-for-desktop' }
    if ($connection.privateAccount -eq $true) { $bridgeArgs += '--private-account' }
    # Windows PowerShell represents native stderr as ErrorRecords; diagnostic output is not a launch failure.
    $ErrorActionPreference = 'Continue'
    & $connection.node @bridgeArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()
        if ($Action -eq 'Check') { Write-Output $line } else {
            if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 5MB) {
                Move-Item -LiteralPath $logPath -Destination (Join-Path $connectorRoot 'bridge.previous.log') -Force
            }
            Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' ' + $line) -Encoding UTF8
        }
    }
    $bridgeExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally {
    [Environment]::SetEnvironmentVariable('CODEX_WEB_DESKTOP_AGENT_TOKEN', $oldToken, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', $oldCa, 'Process')
    if ($secureToken) { $secureToken.Dispose() }
    $credential = $null
    $lock.Dispose()
}
exit $bridgeExit
