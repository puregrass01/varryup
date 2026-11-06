# Saves the admin-server login for the ops worker (ops/notify.mjs).
# The password is encrypted with Windows DPAPI: only this Windows user on this PC can read it.
$dir = Join-Path $env:APPDATA "veryup-ops"
New-Item -ItemType Directory -Force $dir | Out-Null
$user = Read-Host "Admin server ID (ops-worker)"
$pass = Read-Host "Password" -AsSecureString | ConvertFrom-SecureString
$file = Join-Path $dir "login.json"
[IO.File]::WriteAllText($file, (@{ username = $user; password = $pass } | ConvertTo-Json))
Write-Host "Saved: $file"
