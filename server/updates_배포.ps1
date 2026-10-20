<#
.SYNOPSIS
    dist\ 에 구운 설치본을 AWS 서버의 /updates 폴더로 올린다.

.DESCRIPTION
    electron-updater 는 서버의 latest.yml 에 적힌 version 이 실행 중인 앱보다
    높을 때에만 업데이트를 제안한다. 그래서 순서가 중요하다:

        package.json version 올림  →  npm run dist  →  이 스크립트

    한 단계라도 건너뛰면 "업데이트 없음"만 뜨고 아무 일도 일어나지 않는다.
    이 스크립트는 올리기 전에 세 가지를 먼저 확인한다.
      1) latest.yml 의 version 이 package.json 과 같은가
      2) latest.yml 이 가리키는 exe 가 실제로 있는가
      3) sha512 가 맞는가  ← 틀리면 직원 PC 가 다운로드까지 다 받고 마지막에 실패한다

.PARAMETER Server
    ssh 접속 대상. 예: ubuntu@43.200.45.152

.PARAMETER KeyFile
    (선택) pem 키 경로. 생략하면 ssh 기본 설정을 쓴다.

.PARAMETER RemoteDir
    서버의 updates 폴더. 기본 /home/ubuntu/veryup/admin/updates

.PARAMETER Restart
    올린 뒤 내부 서비스를 재시작한다. 파일만 바꾼 경우에는 불필요하다
    (FileResponse 는 요청 시점에 디스크를 읽는다). 코드까지 바꿨을 때만 쓴다.

.EXAMPLE
    .\updates_배포.ps1 -Server ubuntu@43.200.45.152 -KeyFile $HOME\.ssh\veryup

    KeyFile 은 '~\.ssh\veryup' 처럼 물결표+역슬래시로 주지 마라.
    ssh 가 '\.ssh\veryup.pem' 을 사용자 이름으로 읽어 'tilde_expand: No such user' 로 죽는다.
    $HOME\... 이나 전체 경로를 쓰면 된다(스크립트가 절대경로로 풀어서 넘긴다).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$KeyFile,
    [string]$RemoteDir = "/home/ubuntu/veryup/admin/updates",
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # 저장소 루트 (server\ 의 부모)
$dist = Join-Path $root "dist"

# ── 1. 버전 일치 확인 ─────────────────────────────────────────
$pkgVersion = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$latestYml  = Join-Path $dist "latest.yml"
if (-not (Test-Path $latestYml)) {
    throw "dist\latest.yml 이 없습니다. 먼저 'npm run dist' 로 빌드하세요."
}

$ymlText = Get-Content $latestYml -Raw
if ($ymlText -notmatch '(?m)^version:\s*(.+?)\s*$') { throw "latest.yml 에서 version 을 읽지 못했습니다." }
$ymlVersion = $Matches[1]

if ($ymlVersion -ne $pkgVersion) {
    throw "버전이 어긋납니다. package.json=$pkgVersion, dist\latest.yml=$ymlVersion`n" +
          "package.json 을 올린 뒤 'npm run dist' 를 다시 돌리세요."
}
Write-Host "[확인] 버전 $pkgVersion" -ForegroundColor Green

# ── 2. exe 존재 + 해시 확인 ───────────────────────────────────
if ($ymlText -notmatch '(?m)^path:\s*(.+?)\s*$') { throw "latest.yml 에서 path 를 읽지 못했습니다." }
$exeName = $Matches[1].Trim('"')
$exePath = Join-Path $dist $exeName
if (-not (Test-Path $exePath)) { throw "설치본이 없습니다: $exePath" }

if ($ymlText -match '(?m)^sha512:\s*(.+?)\s*$') {
    $expected = $Matches[1].Trim()
    $sha = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($exePath)
    try { $actual = [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose() }
    if ($actual -ne $expected) {
        # 흔한 원인은 '빌드가 깨진 것'이 아니라 **빌드와 경주한 것**이다.
        # electron-builder 는 exe 를 먼저 쓰고 → 해시를 계산하고 → latest.yml 을 나중에 쓴다.
        # 그 사이(보통 1~3초)에 이 스크립트를 돌리면 새 exe + 옛 latest.yml 을 읽게 되고,
        # 버전은 둘 다 같아서 버전 검사는 통과한 채 해시만 어긋난다.
        # 그래서 두 값과 파일 시각을 반드시 함께 보여 준다 — 없으면 진단이 불가능하다.
        $ymlTime = (Get-Item $latestYml).LastWriteTime
        $exeTime = (Get-Item $exePath).LastWriteTime
        $ymlSize = if ($ymlText -match '(?m)^\s*size:\s*(\d+)\s*$') { $Matches[1] } else { "(없음)" }
        $exeSize = (Get-Item $exePath).Length
        throw @"
sha512 불일치 — latest.yml 과 exe 가 서로 다른 빌드입니다.

  latest.yml 기대 : $expected
  exe 실제        : $actual

  latest.yml : $ymlTime  (size 기록: $ymlSize)
  exe        : $exeTime  (실제 크기: $exeSize)

원인 판단:
  · exe 시각이 latest.yml 보다 **나중**이면 → 빌드가 아직 안 끝났거나, 빌드 도중에 이 스크립트를 돌린 것.
    빌드가 완전히 끝난 뒤 이 스크립트를 **다시 실행**하면 된다(재빌드 불필요).
  · 크기까지 다르면 → 정말 다른 빌드다. 'npm run dist' 를 다시 돌려라.
"@
    }
    Write-Host "[확인] sha512 일치" -ForegroundColor Green
}

# dist 에 옛 설치본이 남아 있으면 알려 준다. 업로드 대상은 latest.yml 이 가리키는 것 하나뿐이지만,
# 옛 exe 가 섞여 있으면 사람이 엉뚱한 파일을 손으로 올리는 사고가 난다.
$staleExes = @(Get-ChildItem $dist -Filter *.exe | Where-Object { $_.Name -ne $exeName })
if ($staleExes.Count -gt 0) {
    Write-Warning "dist 에 이전 설치본이 남아 있습니다(업로드 대상 아님): $($staleExes.Name -join ', ')"
}

$blockmap = "$exePath.blockmap"
$files = @($latestYml, $exePath)
if (Test-Path $blockmap) { $files += $blockmap }
else { Write-Warning "blockmap 이 없습니다. 업데이트는 되지만 차등 다운로드가 꺼져 전체를 받습니다." }

# ── 3. 업로드 ─────────────────────────────────────────────────
$sshArgs = @()
if ($KeyFile) {
    # ⚠ ssh 에 넘기는 경로는 **PowerShell 이 먼저 풀어서** 절대경로로 준다.
    #   ssh 의 ~ 확장은 Unix 규칙이라 '~' 뒤 첫 '/' 까지를 사용자 이름으로 읽는다.
    #   그래서 Windows 식 '~\.ssh\veryup' 을 그대로 넘기면 슬래시가 없어
    #   '\.ssh\veryup.pem' 전체를 사용자 이름으로 보고 이렇게 죽는다:
    #       tilde_expand: No such user \.ssh\veryup.pem
    #   Resolve-Path 가 '~' 와 상대경로를 모두 풀어 주므로 여기서 끝낸다.
    $resolved = $null
    try { $resolved = (Resolve-Path -LiteralPath $KeyFile -ErrorAction Stop).Path }
    catch { throw "pem 키를 찾을 수 없습니다: $KeyFile`n  (예: -KeyFile `$HOME\.ssh\veryup  또는 전체 경로)" }

    # OpenSSH 는 키 파일 권한이 느슨하면 거부한다. 원인을 미리 알려 준다.
    Write-Host "[키] $resolved" -ForegroundColor DarkGray
    $sshArgs += @("-i", $resolved)
}

# 원격 경로에 공백이 있으면 위의 scp 가 경로를 두 인자로 쪼개 조용히 엉뚱한 곳에 올린다.
# 따옴표로 감싸는 방법은 scp 의 SFTP 모드에서 통하지 않으므로(아래 주석), 아예 막는다.
if ($RemoteDir -match '\s') {
    throw "RemoteDir 에 공백이 들어 있습니다: '$RemoteDir'`n" +
          "공백 없는 경로를 쓰세요(예: /home/ubuntu/veryup/admin/updates)."
}

Write-Host "[업로드] $RemoteDir 로 $($files.Count) 개 파일" -ForegroundColor Cyan
& ssh @sshArgs $Server "mkdir -p '$RemoteDir'"
if ($LASTEXITCODE -ne 0) { throw "원격 폴더를 만들지 못했습니다(ssh 실패)." }

foreach ($f in $files) {
    Write-Host "  → $(Split-Path -Leaf $f)"
    # ⚠ 원격 경로에 따옴표를 붙이지 마라.
    #   ssh 로 보내는 **명령 문자열**은 원격 셸이 해석하므로 '...' 이 먹지만(위 mkdir),
    #   scp 의 **목적지 경로**는 다르다. OpenSSH 9.0 부터 scp 는 기본적으로 SFTP 프로토콜을
    #   쓰고 원격 셸을 거치지 않아, 따옴표가 경로 글자 그대로 남는다. 그래서 예전 코드의
    #       "${Server}:'$RemoteDir/'"
    #   는 이런 오류를 냈다:
    #       dest open "'/home/ubuntu/veryup/admin/updates/'": No such file or directory
    #   로컬 파일명의 공백("VERY UP VER2 Setup 2.0.1.exe")은 PowerShell 이 $f 를 인자 하나로
    #   넘기므로 이미 안전하다 — 따옴표가 필요했던 쪽은 원격이 아니라 로컬이었다.
    & scp @sshArgs $f "${Server}:$RemoteDir/"
    if ($LASTEXITCODE -ne 0) { throw "업로드 실패: $f" }
}

# ── 4. 확인 ───────────────────────────────────────────────────
Write-Host "[확인] 서버 파일 목록" -ForegroundColor Cyan
& ssh @sshArgs $Server "ls -la '$RemoteDir'"

if ($Restart) {
    Write-Host "[재시작] veryup-admin" -ForegroundColor Cyan
    & ssh @sshArgs $Server "sudo systemctl restart veryup-admin && sleep 2 && sudo systemctl is-active veryup-admin"
}

Write-Host ""
Write-Host "완료. 남은 것:" -ForegroundColor Green
Write-Host "  1) 서버 UPDATE_TOKEN 과 직원 PC 의 veryup.env 값이 같은지"
Write-Host "  2) curl -H 'X-Update-Token: <토큰>' https://admin.veryup-domain.duckdns.org/updates"
Write-Host "     -> {`"ready`":true} 가 나와야 한다. 404 면 라우트가 없거나 nginx 가 막은 것이다."
