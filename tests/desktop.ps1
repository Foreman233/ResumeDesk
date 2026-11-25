param(
    [string]$Executable,
    [string]$TestRoot,
    [int]$Port = 19322,
    [switch]$Extended
)
$ErrorActionPreference = 'Stop'
$rdRepo = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $rdRepo 'src-tauri\target\debug\resumedesk.exe' }
$rdExe = (Resolve-Path -LiteralPath $Executable).Path
if (-not $TestRoot) { $TestRoot = Join-Path $rdRepo ('test-results\desktop-' + [guid]::NewGuid().ToString('N')) }
$rdTest = (New-Item -ItemType Directory -Path $TestRoot -Force).FullName
if (Test-Path -LiteralPath (Join-Path $rdTest 'store\workspace\workspace.sqlite3')) {
    throw 'Select a fresh test directory to avoid overwriting existing data.'
}
$env:RESUMEDESK_DATA_DIR = Join-Path $rdTest 'store'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $rdTest 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port --remote-debugging-address=127.0.0.1"
$rdScript = Join-Path $PSScriptRoot 'desktop.mjs'
$rdEndpoint = 'http://127.0.0.1:' + $Port
foreach ($rdPart in @('first','restart')) {
    $rdProcess = Start-Process -FilePath $rdExe -WorkingDirectory (Split-Path $rdExe) -WindowStyle Hidden -PassThru
    try {
        node $rdScript $rdPart $rdEndpoint $rdTest
        if ($LASTEXITCODE -ne 0) {
            $rdExit = if ($rdProcess.HasExited) { " (app exit: $($rdProcess.ExitCode))" } else { '' }
            throw "Desktop verification failed: $rdPart$rdExit"
        }
        if ($Extended) {
            if ($rdPart -eq 'first') {
                foreach ($extension in @('workspace-extension.mjs','chat-extension.mjs')) {
                    node (Join-Path $PSScriptRoot $extension) $rdEndpoint $rdTest
                    if ($LASTEXITCODE -ne 0) { throw "Desktop verification failed: $extension" }
                }
            }
            node (Join-Path $PSScriptRoot 'round-three.mjs') $rdPart $rdEndpoint $rdTest
            if ($LASTEXITCODE -ne 0) { throw "Round-three verification failed: $rdPart" }
            node (Join-Path $PSScriptRoot 'tool-hub.mjs') $rdPart $rdEndpoint $rdTest
            if ($LASTEXITCODE -ne 0) { throw "Tool Hub verification failed: $rdPart" }
        }
    } finally {
        if (!$rdProcess.HasExited) {
            $null = $rdProcess.CloseMainWindow()
            if (!$rdProcess.WaitForExit(5000)) { Stop-Process -Id $rdProcess.Id -Force }
        }
    }
}
