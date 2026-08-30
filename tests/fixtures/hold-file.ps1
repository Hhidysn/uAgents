param([string]$Path)
$taskHandle = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
try {
    [Console]::WriteLine('ready')
    Start-Sleep -Milliseconds 100
} finally { $taskHandle.Dispose() }
