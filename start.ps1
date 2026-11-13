param([switch]$Presentation, [switch]$Check)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$pythonPath = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Environnement Python absent. Suivez les étapes Installation du README.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
    throw 'Dépendances JavaScript absentes. Exécutez npm ci.'
}
$apiProcess = $null
$runtimePath = Join-Path $PSScriptRoot 'backend\runtime'
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdoutPath = Join-Path $runtimePath "startup-$logStamp.out.log"
$stderrPath = Join-Path $runtimePath "startup-$logStamp.err.log"
try {
    $ports = if ($Presentation) { @(8000) } else { @(8000, 5173) }
    $occupied = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -in $ports }
    if ($occupied) { throw "Un port nécessaire est déjà utilisé : $((@($occupied.Port) | Sort-Object -Unique) -join ', '). Arrêtez le serveur concerné, puis relancez." }
    if ($Presentation) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'La compilation a échoué. Corrigez les erreurs avant la présentation.' }
    }
    $apiProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', '8000') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    Write-Host "Démarrage de l’API et chargement du modèle…"
    $ready = $false
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        if ($apiProcess.HasExited) { throw "L’API s’est arrêtée. Consultez $stderrPath" }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8000/api/health' -TimeoutSec 2
            if ($health.status -eq 'ok' -and $health.demo -eq $true -and $health.app_version) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "L’API ne répond pas après 120 secondes. Consultez $stderrPath" }
    if ($Check) {
        if ($Presentation) {
            $frontend = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/' -UseBasicParsing -TimeoutSec 5
            if ($frontend.StatusCode -ne 200 -or $frontend.Content -notmatch 'id="root"') { throw "L’interface compilée ne répond pas correctement." }
        }
        Write-Host 'Vérification du démarrage réussie.'
        return
    }
    if ($Presentation) {
        Write-Host 'AccessiVoice prêt : http://127.0.0.1:8000 — Ctrl+C pour arrêter.'
        while (-not $apiProcess.HasExited) { Start-Sleep -Seconds 1 }
        throw "L’API s’est arrêtée. Consultez $stderrPath"
    } else {
        Write-Host 'AccessiVoice prêt : http://127.0.0.1:5173 — Ctrl+C pour arrêter.'
        & npm.cmd run dev -- --port 5173 --strictPort
        if ($LASTEXITCODE -ne 0) { throw "L’interface n’a pas démarré correctement. Consultez les messages ci-dessus." }
    }
}
finally {
    if ($apiProcess -and -not $apiProcess.HasExited) {
        # The Windows venv launcher can own a child Python process. Stop both.
        & taskkill.exe /PID $apiProcess.Id /T /F | Out-Null
    }
}
