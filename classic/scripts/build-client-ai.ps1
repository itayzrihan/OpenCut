$ErrorActionPreference = 'Stop'
$classicRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $classicRoot 'apps\web'
$outputRoot = Join-Path $classicRoot 'apps\electron\dist\client-ai'
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
Push-Location $webRoot
try {
    & bun build src/ai/companion/main.ts --compile --target=bun-windows-x64 --env=disable "--outfile=$outputRoot\OpenCut-AI.exe"
    if ($LASTEXITCODE -ne 0) { throw 'Client AI build failed' }
} finally { Pop-Location }
@'
@echo off
"%~dp0OpenCut-AI.exe" "%~dp0OpenCut-AI-Pairing.json"
pause
'@ | Set-Content -LiteralPath (Join-Path $outputRoot 'Start-OpenCut-AI.cmd') -Encoding ascii
@'
OpenCut AI for Windows - internal testing

Extract this ZIP. In OpenCut's AI panel, download your account pairing file
and place OpenCut-AI-Pairing.json beside OpenCut-AI.exe. Run Start-OpenCut-AI.cmd.
Keep it running. Return to OpenCut, select Connect this device, then sign in
on OpenAI's website. OpenCut never asks for your OpenAI password.

The local app accepts only its paired website, OpenCut account and secret.
The pairing file is private; do not share it. Close the app to stop access.
OpenAI sessions are encrypted under %LOCALAPPDATA%\OpenCut Client AI,
separated by website and OpenCut account. They are never uploaded or synced.
An OpenAI model still runs at OpenAI; this app handles the local connection.
If you switch OpenCut accounts, close this app and use the new account's file.
If another pending Codex login uses port 1455, finish or close that login first.

No Node.js, Bun or Codex CLI installation is required. The app uses Bun's
runtime (MIT) and OpenCut's existing Codex OAuth/Responses transport.
'@ | Set-Content -LiteralPath (Join-Path $outputRoot 'README.txt') -Encoding utf8
$zip = Join-Path $classicRoot 'apps\electron\dist\OpenCut-AI-Windows.zip'
& tar.exe -a -c -f $zip -C $outputRoot OpenCut-AI.exe Start-OpenCut-AI.cmd README.txt
if ($LASTEXITCODE -ne 0) { throw 'Client AI packaging failed' }
$digest = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$digest  OpenCut-AI-Windows.zip" | Set-Content -LiteralPath "$zip.sha256" -Encoding ascii
Write-Output $zip
