$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This key-saving script requires Windows.' }
$taskSecret = Read-Host 'Paste your NVIDIA API key (hidden)' -AsSecureString
try {
    if ($taskSecret.Length -eq 0) { throw 'No key entered; nothing was saved.' }
    $taskApiKey = [System.Net.NetworkCredential]::new('', $taskSecret).Password
    [Environment]::SetEnvironmentVariable('NVIDIA_API_KEY', $taskApiKey, 'User')
    $env:NVIDIA_API_KEY = $taskApiKey
    Write-Host 'NVIDIA_API_KEY saved for your Windows user.'
} finally {
    $taskSecret.Dispose()
    $taskApiKey = $null
}
