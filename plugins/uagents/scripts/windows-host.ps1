# windows-host.ps1
#
# Fixed, read-only Windows host actions for the uAgents agent locator (Gate 2.2).
# Contract:
#   - The action is selected with -Action (one of: discover-installations,
#     verify-installation, inspect-process, inspect-process-tree, inspect-listener).
#   - All other input arrives as a single JSON document on stdin.
#   - stdout carries exactly one JSON object (ConvertTo-Json -Compress -Depth 6).
#   - Any internal failure is reported as {ok:false,error:{code,message}} on stdout.
#   - No non-JSON text, no side effects, no command lines, environment dumps or
#     secrets are ever written to stdout.
#
# Windows PowerShell 5.1 compatible. No disk-wide scans, no .lnk traversal, no
# process start/stop/connect/navigate.

param([string]$Action = "")

Set-StrictMode -Version 2.0
$ErrorActionPreference = "SilentlyContinue"

function Read-InputJson {
    try {
        $stdin = [Console]::OpenStandardInput()
        $buffer = New-Object System.IO.MemoryStream
        $stdin.CopyTo($buffer)
        $text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return $text | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-Field {
    param($Payload, [string]$Name, $Default = $null)
    try {
        if ($null -eq $Payload) { return $Default }
        $property = $Payload.PSObject.Properties[$Name]
        if ($null -eq $property) { return $Default }
        if ($null -eq $property.Value) { return $Default }
        return $property.Value
    } catch {
        return $Default
    }
}

function Get-FieldList {
    param($Payload, [string]$Name)
    $value = Get-Field -Payload $Payload -Name $Name -Default $null
    if ($null -eq $value) { return @() }
    if ($value -is [string]) { return @([string]$value) }
    try { return @($value) } catch { return @() }
}

function To-NullIfEmpty {
    param($Value)
    if ($null -eq $Value) { return $null }
    $text = [string]$Value
    if ($text.Length -eq 0) { return $null }
    return $text
}

function ConvertTo-EpochMs {
    param($Value)
    try {
        if ($null -eq $Value) { return $null }
        return [long]([DateTimeOffset]$Value).ToUnixTimeMilliseconds()
    } catch {
        return $null
    }
}

function Get-FileCandidate {
    param([string]$Path, [string]$Source)
    $result = @{
        path            = $Path
        discovery_source = $Source
        exists          = $false
        product_name    = $null
        publisher       = $null
        file_version    = $null
        size            = $null
        mtime_ms        = $null
    }
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and -not $item.PSIsContainer) {
            if ($item -is [System.Array]) { $item = $item[0] }
            $versionInfo = $null
            try { $versionInfo = $item.VersionInfo } catch { $versionInfo = $null }
            $result['path'] = [string]$item.FullName
            $result['exists'] = $true
            $result['product_name'] = To-NullIfEmpty $(if ($null -ne $versionInfo) { $versionInfo.ProductName } else { $null })
            $result['publisher'] = To-NullIfEmpty $(if ($null -ne $versionInfo) { $versionInfo.CompanyName } else { $null })
            $result['file_version'] = To-NullIfEmpty $(if ($null -ne $versionInfo) { $versionInfo.FileVersion } else { $null })
            $result['size'] = [long]$item.Length
            $result['mtime_ms'] = ConvertTo-EpochMs $item.LastWriteTimeUtc
        }
    } catch {
        $result['exists'] = $false
    }
    return $result
}

function Add-Candidate {
    param($Candidates, $Seen, [string]$Path, [string]$Source)
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $trimmed = $Path.Trim().Trim('"')
    if ([string]::IsNullOrWhiteSpace($trimmed)) { return }
    $fullPath = $trimmed
    try { $fullPath = [System.IO.Path]::GetFullPath($trimmed) } catch { }
    $key = $fullPath.ToLowerInvariant()
    if ($Seen.Contains($key)) { return }
    [void]$Seen.Add($key)
    $null = $Candidates.Add((Get-FileCandidate -Path $fullPath -Source $Source))
}

function Invoke-Discovery {
    param($Payload)
    $candidates = New-Object 'System.Collections.Generic.List[object]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'

    # 1. explicit absolute paths
    $explicit = Get-FieldList -Payload $Payload -Name 'explicit_paths'
    foreach ($entry in $explicit) {
        if ($entry -isnot [string]) { continue }
        Add-Candidate -Candidates $candidates -Seen $seen -Path $entry -Source 'explicit'
    }

    # 2. App Paths registry keys (HKCU then HKLM)
    $appNames = Get-FieldList -Payload $Payload -Name 'app_paths_names'
    foreach ($name in $appNames) {
        if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name)) { continue }
        foreach ($hiveName in @('CurrentUser', 'LocalMachine')) {
            try {
                $hive = $null
                if ($hiveName -eq 'CurrentUser') { $hive = [Microsoft.Win32.Registry]::CurrentUser }
                else { $hive = [Microsoft.Win32.Registry]::LocalMachine }
                $subKey = $hive.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\App Paths\$name")
                if ($null -ne $subKey) {
                    try {
                        $value = [string]$subKey.GetValue($null)
                        if (-not [string]::IsNullOrWhiteSpace($value)) {
                            Add-Candidate -Candidates $candidates -Seen $seen -Path $value -Source 'app_paths'
                        }
                    } finally { $subKey.Close() }
                }
            } catch { }
        }
    }

    # 3. Uninstall registry entries (HKCU/HKLM/WOW6432Node)
    $uninstall = Get-Field -Payload $Payload -Name 'uninstall' -Default $null
    $displayPatterns = @()
    $exeNames = @()
    if ($null -ne $uninstall) {
        $displayPatterns = @(Get-FieldList -Payload $uninstall -Name 'display_name_patterns')
        $exeNames = @(Get-FieldList -Payload $uninstall -Name 'executable_names')
    }
    if ($displayPatterns.Count -gt 0) {
        $roots = @(
            'HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
            'HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
        )
        foreach ($root in $roots) {
            $entries = Get-ChildItem -Path "Registry::$root" -ErrorAction SilentlyContinue
            foreach ($entry in $entries) {
                $props = $null
                try { $props = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue } catch { $props = $null }
                if ($null -eq $props) { continue }
                $displayName = [string](Get-Field -Payload $props -Name 'DisplayName' -Default '')
                $matched = $false
                foreach ($pattern in $displayPatterns) {
                    if ($pattern -is [string] -and $displayName -like $pattern) { $matched = $true; break }
                }
                if (-not $matched) { continue }
                $installLocation = [string](Get-Field -Payload $props -Name 'InstallLocation' -Default '')
                if (-not [string]::IsNullOrWhiteSpace($installLocation)) {
                    foreach ($exe in $exeNames) {
                        if ($exe -isnot [string]) { continue }
                        Add-Candidate -Candidates $candidates -Seen $seen -Path (Join-Path $installLocation $exe) -Source 'uninstall_registry'
                    }
                }
                $displayIcon = [string](Get-Field -Payload $props -Name 'DisplayIcon' -Default '')
                if (-not [string]::IsNullOrWhiteSpace($displayIcon)) {
                    $iconPath = $displayIcon.Split(',')[0].Trim().Trim('"')
                    Add-Candidate -Candidates $candidates -Seen $seen -Path $iconPath -Source 'uninstall_registry'
                }
            }
        }
    }

    # 4. known install locations (files directly, or directories joined with each executable name)
    $knownLocations = Get-FieldList -Payload $Payload -Name 'known_locations'
    foreach ($location in $knownLocations) {
        if ($location -isnot [string] -or [string]::IsNullOrWhiteSpace($location)) { continue }
        $expanded = [Environment]::ExpandEnvironmentVariables($location.Trim())
        $leaf = $null
        try { $leaf = Get-Item -LiteralPath $expanded -Force -ErrorAction SilentlyContinue } catch { $leaf = $null }
        if ($null -eq $leaf) { continue }
        if ($leaf -is [System.Array]) { $leaf = $leaf[0] }
        if ($leaf.PSIsContainer) {
            foreach ($exe in $exeNames) {
                if ($exe -isnot [string]) { continue }
                Add-Candidate -Candidates $candidates -Seen $seen -Path (Join-Path $expanded $exe) -Source 'known_locations'
            }
        } else {
            Add-Candidate -Candidates $candidates -Seen $seen -Path $expanded -Source 'known_locations'
        }
    }

    # 5. PATH lookup for declared command names (no .lnk traversal)
    $pathCommands = @(Get-FieldList -Payload $Payload -Name 'path_commands')
    if ($pathCommands.Count -gt 0) {
        $pathValue = [string]$env:PATH
        if (-not [string]::IsNullOrWhiteSpace($pathValue)) {
            $directories = $pathValue.Split(';')
            foreach ($directory in $directories) {
                if ([string]::IsNullOrWhiteSpace($directory)) { continue }
                foreach ($command in $pathCommands) {
                    if ($command -isnot [string] -or [string]::IsNullOrWhiteSpace($command)) { continue }
                    $candidatePath = Join-Path $directory.Trim().Trim('"') $command
                    if (Test-Path -LiteralPath $candidatePath -PathType Leaf -ErrorAction SilentlyContinue) {
                        Add-Candidate -Candidates $candidates -Seen $seen -Path $candidatePath -Source 'path'
                    }
                }
            }
        }
    }

    return @{ ok = $true; candidates = $candidates }
}

function New-CheckTable {
    return @{
        canonical_ok   = $false
        volume_ok      = $false
        signature_ok   = $false
        product_ok     = $false
        publisher_ok   = $false
        executable_ok  = $false
    }
}

function New-FailureResult {
    param([hashtable]$Checks, [string]$CanonicalPath, [string]$SignatureStatus, [string]$SignatureMessage)
    return @{
        ok             = $false
        canonical_path = $CanonicalPath
        signature      = @{ status = $SignatureStatus; status_message = $SignatureMessage }
        product_name   = $null
        publisher      = $null
        file_version   = $null
        size           = $null
        mtime_ms       = $null
        sha256         = $null
        checks         = $Checks
    }
}

function Invoke-Verification {
    param($Payload)
    $rawPath = [string](Get-Field -Payload $Payload -Name 'path' -Default '')
    $artifactKind = [string](Get-Field -Payload $Payload -Name 'artifact_kind' -Default 'desktop-exe')
    $checks = New-CheckTable

    if ([string]::IsNullOrWhiteSpace($rawPath)) {
        return New-FailureResult -Checks $checks -CanonicalPath $null -SignatureStatus 'None' -SignatureMessage 'path is required'
    }

    $expected = Get-Field -Payload $Payload -Name 'expected' -Default $null
    $productNames = @()
    $publishers = @()
    $exeNames = @()
    if ($null -ne $expected) {
        $productNames = @(Get-FieldList -Payload $expected -Name 'product_names')
        $publishers = @(Get-FieldList -Payload $expected -Name 'publishers')
        $exeNames = @(Get-FieldList -Payload $expected -Name 'executable_names')
    }
    # canonical path via system resolution (handles reparse/junction)
    $canonical = $null
    try {
        $resolved = Resolve-Path -LiteralPath $rawPath -ErrorAction SilentlyContinue
        if ($null -ne $resolved) {
            if ($resolved -is [System.Array]) { $canonical = [string]$resolved[0].ProviderPath }
            else { $canonical = [string]$resolved.ProviderPath }
        }
    } catch { $canonical = $null }

    $item = $null
    if (-not [string]::IsNullOrWhiteSpace($canonical)) {
        try {
            $item = Get-Item -LiteralPath $canonical -Force -ErrorAction SilentlyContinue
            if ($item -is [System.Array]) { $item = $item[0] }
        } catch { $item = $null }
    }
    if ($null -eq $item -or $item.PSIsContainer) {
        $item = $null
        $canonical = $null
    }
    $checks['canonical_ok'] = ($null -ne $item)
    if ($null -eq $item) {
        return New-FailureResult -Checks $checks -CanonicalPath $canonical -SignatureStatus 'None' -SignatureMessage 'path not resolvable to a file'
    }

    # local fixed volume only (PSDrive.DriveType is unreliable through the
    # PSObject adapter on some hosts; DriveInfo on the path root is not)
    try {
        $driveInfo = New-Object System.IO.DriveInfo([System.IO.Path]::GetPathRoot($item.FullName))
        $checks['volume_ok'] = ($driveInfo.DriveType -eq [System.IO.DriveType]::Fixed)
    } catch { $checks['volume_ok'] = $false }

    # authenticode signature (informational for cli-entry)
    $signatureStatus = 'NotSigned'
    $signatureMessage = ''
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName -ErrorAction SilentlyContinue
        if ($null -ne $signature) {
            $signatureStatus = [string]$signature.Status
            $signatureMessage = [string]$signature.StatusMessage
        }
    } catch { $signatureStatus = 'NotSigned'; $signatureMessage = '' }
    if ($artifactKind -eq 'cli-entry') {
        # CLI entries are not Authenticode-enforced (design 7.3); the check is informational.
        $checks['signature_ok'] = $true
    } else {
        $checks['signature_ok'] = ($signatureStatus -eq 'Valid')
    }

    # product / publisher / file version from VersionInfo
    $productName = $null
    $publisher = $null
    $fileVersion = $null
    try {
        $versionInfo = $item.VersionInfo
        if ($null -ne $versionInfo) {
            $productName = To-NullIfEmpty $versionInfo.ProductName
            $publisher = To-NullIfEmpty $versionInfo.CompanyName
            $fileVersion = To-NullIfEmpty $versionInfo.FileVersion
        }
    } catch { }

    $checks['product_ok'] = $true
    if ($productNames.Count -gt 0) {
        $checks['product_ok'] = $false
        foreach ($pattern in $productNames) {
            if ($pattern -is [string] -and -not [string]::IsNullOrEmpty($productName) -and $productName -like $pattern) {
                $checks['product_ok'] = $true
                break
            }
        }
    }

    $checks['publisher_ok'] = $true
    if ($publishers.Count -gt 0) {
        $checks['publisher_ok'] = $false
        foreach ($pattern in $publishers) {
            if ($pattern -is [string] -and -not [string]::IsNullOrEmpty($publisher) -and $publisher -like $pattern) {
                $checks['publisher_ok'] = $true
                break
            }
        }
    }

    $leafName = [System.IO.Path]::GetFileName($item.FullName)
    $checks['executable_ok'] = $true
    if ($exeNames.Count -gt 0) {
        $checks['executable_ok'] = $false
        foreach ($pattern in $exeNames) {
            if ($pattern -is [string] -and $leafName -like $pattern) {
                $checks['executable_ok'] = $true
                break
            }
        }
    }

    # SHA-256 is computed by the Node host locator after this identity check.
    # Keep this script independent of PowerShell profiles/modules: in particular,
    # do not rely on a profile-provided file-hash cmdlet in powershell.exe -NoProfile.
    $sha256 = $null

    $ok = $checks['canonical_ok'] -and $checks['volume_ok'] -and $checks['signature_ok'] -and $checks['product_ok'] -and $checks['publisher_ok'] -and $checks['executable_ok']

    return @{
        ok             = $ok
        canonical_path = [string]$item.FullName
        signature      = @{ status = $signatureStatus; status_message = $signatureMessage }
        product_name   = $productName
        publisher      = $publisher
        file_version   = $fileVersion
        size           = [long]$item.Length
        mtime_ms       = ConvertTo-EpochMs $item.LastWriteTimeUtc
        sha256         = $sha256
        checks         = $checks
    }
}

function Invoke-ProcessInspection {
    param($Payload)
    $pidValue = Get-Field -Payload $Payload -Name 'pid' -Default $null
    $processId = 0
    try { $processId = [int]$pidValue } catch { $processId = 0 }
    if ($processId -le 0) {
        return @{ ok = $false; error = @{ code = 'invalid_input'; message = 'pid must be a positive integer' } }
    }

    # Command lines are opt-in and transient: callers use them for managed-
    # orphan ownership decisions and must never persist or log them.
    $includeCommandLine = $false
    $clFlag = Get-Field -Payload $Payload -Name 'include_command_line' -Default $false
    if ($clFlag -eq $true -or $clFlag -eq 'true') { $includeCommandLine = $true }

    $process = $null
    try {
        # A query failure is not evidence that the process is absent. Use a
        # terminating CIM error so callers can keep durable workspace guards
        # conservative instead of collapsing infrastructure failure to false.
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    } catch {
        return @{ ok = $false; error = @{ code = 'process_inspection_failed'; message = 'process inspection failed' } }
    }
    if ($null -eq $process) {
        return @{ ok = $true; exists = $false; pid = $processId; started_at_ms = $null; executable_path = $null; command_line = $null }
    }
    if ($process -is [System.Array]) { $process = $process[0] }

    $startedAtMs = $null
    try {
        $creationDate = Get-Field -Payload $process -Name 'CreationDate' -Default $null
        if ($null -ne $creationDate) {
            if ($creationDate -is [System.DateTime]) { $startedAtMs = ConvertTo-EpochMs $creationDate }
            else { $startedAtMs = ConvertTo-EpochMs ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationDate)) }
        }
    } catch { $startedAtMs = $null }

    $executablePath = Get-Field -Payload $process -Name 'ExecutablePath' -Default $null
    if ($null -ne $executablePath) { $executablePath = [string]$executablePath }

    $commandLine = $null
    if ($includeCommandLine) {
        $rawCommandLine = Get-Field -Payload $process -Name 'CommandLine' -Default $null
        if ($null -ne $rawCommandLine) { $commandLine = [string]$rawCommandLine }
    }

    return @{
        ok              = $true
        exists          = $true
        pid             = $processId
        started_at_ms   = $startedAtMs
        executable_path = $executablePath
        command_line    = $commandLine
    }
}

function Invoke-ProcessTreeInspection {
    param($Payload)
    $rootPidValue = Get-Field -Payload $Payload -Name 'root_pid' -Default $null
    $rootPid = 0
    try { $rootPid = [int]$rootPidValue } catch { $rootPid = 0 }
    if ($rootPid -le 0) {
        return @{ ok = $false; error = @{ code = 'invalid_input'; message = 'root_pid must be a positive integer' } }
    }

    # root_started_at_ms is accepted as ownership context for the caller. The
    # v1 tree walk deliberately does not use command lines or executable text.
    # Parent PID reuse is therefore handled conservatively by attributing any
    # current descendant chain rooted at root_pid to the old execution.
    $all = $null
    try {
        $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -ErrorAction Stop)
    } catch {
        return @{ ok = $false; error = @{ code = 'process_tree_inspection_failed'; message = 'process tree inspection failed' } }
    }

    # Keep this deliberately simple for Windows PowerShell 5.1. With the
    # process list normally in the low hundreds, repeated array scans are
    # cheap and avoid relying on generic collection adapter behavior.
    $descendants = @()
    $seen = @{ ([string]$rootPid) = $true }
    $frontier = @($rootPid)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($entry in $all) {
            $entryPid = 0
            $parentPid = 0
            try { $entryPid = [int](Get-Field -Payload $entry -Name 'ProcessId' -Default 0) } catch { $entryPid = 0 }
            try { $parentPid = [int](Get-Field -Payload $entry -Name 'ParentProcessId' -Default 0) } catch { $parentPid = 0 }
            if ($entryPid -le 0 -or $parentPid -lt 0) { continue }
            if (-not ($frontier -contains $parentPid)) { continue }
            $entryKey = [string]$entryPid
            if ($seen.ContainsKey($entryKey)) { continue }
            $seen[$entryKey] = $true
            $next += $entryPid
            $creation = Get-Field -Payload $entry -Name 'CreationDate' -Default $null
            $startedAtMs = $null
            try {
                if ($null -ne $creation) {
                    if ($creation -is [System.DateTime]) { $startedAtMs = ConvertTo-EpochMs $creation }
                    else { $startedAtMs = ConvertTo-EpochMs ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creation)) }
                }
            } catch { $startedAtMs = $null }
            $descendants += @{
                pid = $entryPid
                parent_pid = $parentPid
                started_at_ms = $startedAtMs
            }
        }
        $frontier = $next
    }

    return @{ ok = $true; root_pid = $rootPid; descendants = $descendants }
}

function Invoke-ListenerInspection {
    param($Payload)
    $portValue = Get-Field -Payload $Payload -Name 'port' -Default $null
    $port = -1
    try { $port = [int]$portValue } catch { $port = -1 }
    if ($port -lt 0 -or $port -gt 65535) {
        return @{ ok = $false; error = @{ code = 'invalid_input'; message = 'port must be an integer between 0 and 65535' } }
    }

    $connections = $null
    try {
        $connections = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    } catch { $connections = $null }
    if ($null -eq $connections -or @($connections).Count -eq 0) {
        return @{ ok = $true; listening = $false; port = $port; listener_pid = $null; started_at_ms = $null; executable_path = $null }
    }

    $listener = @($connections)[0]
    $ownerPid = 0
    try { $ownerPid = [int]$listener.OwningProcess } catch { $ownerPid = 0 }

    $startedAtMs = $null
    $executablePath = $null
    if ($ownerPid -gt 0) {
        $process = $null
        try { $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue } catch { $process = $null }
        if ($null -ne $process) {
            if ($process -is [System.Array]) { $process = $process[0] }
            try {
                $creationDate = Get-Field -Payload $process -Name 'CreationDate' -Default $null
                if ($null -ne $creationDate) {
                    if ($creationDate -is [System.DateTime]) { $startedAtMs = ConvertTo-EpochMs $creationDate }
                    else { $startedAtMs = ConvertTo-EpochMs ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$creationDate)) }
                }
            } catch { $startedAtMs = $null }
            $executablePath = Get-Field -Payload $process -Name 'ExecutablePath' -Default $null
            if ($null -ne $executablePath) { $executablePath = [string]$executablePath }
        }
    }

    return @{
        ok              = $true
        listening       = $true
        port            = $port
        listener_pid    = $ownerPid
        started_at_ms   = $startedAtMs
        executable_path = $executablePath
    }
}

function Invoke-HostAction {
    param([string]$SelectedAction, $Payload)
    switch ($SelectedAction) {
        'discover-installations' { return Invoke-Discovery -Payload $Payload }
        'verify-installation'    { return Invoke-Verification -Payload $Payload }
        'inspect-process'        { return Invoke-ProcessInspection -Payload $Payload }
        'inspect-process-tree'   { return Invoke-ProcessTreeInspection -Payload $Payload }
        'inspect-listener'       { return Invoke-ListenerInspection -Payload $Payload }
        default {
            return @{ ok = $false; error = @{ code = 'invalid_input'; message = 'unsupported action' } }
        }
    }
}

$hostPayload = Read-InputJson
$output = $null
try {
    $output = Invoke-HostAction -SelectedAction $Action -Payload $hostPayload
    if ($null -eq $output) {
        $output = @{ ok = $false; error = @{ code = 'host_script_error'; message = 'host action produced no result' } }
    }
} catch {
    $output = @{ ok = $false; error = @{ code = 'host_script_error'; message = 'host action failed' } }
}

$json = $null
try {
    $json = ConvertTo-Json -InputObject $output -Compress -Depth 6
} catch {
    $json = '{"ok":false,"error":{"code":"host_script_error","message":"host action failed"}}'
}
try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $stdout = [Console]::OpenStandardOutput()
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
} catch { }

exit 0
