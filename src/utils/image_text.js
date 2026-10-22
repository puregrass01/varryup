// 이미지에 글자가 들어 있는지 — 아마존 메인 이미지는 글자·로고 없는 사진이어야 한다(아마존 일본 초안, amazon_jp_draft.js).
// Windows 내장 OCR(Windows.Media.Ocr)을 PowerShell 5.1 로 부른다. 새 의존성 없음: 묶음마다 PowerShell 한 번,
// 경로는 stdin(JSON), 결과는 stdout(JSON). 2026-10-21 이 PC 실측: 1,000장에 2분쯤(내려받기 제외).
// 한계: 설치된 인식기(이 PC 는 ko)만 쓴다 — 일본어는 글자가 크면 '있음'으로 잡히지만 작은 글자·글자 하나('L'·'R')·
// 글자 없는 로고는 놓친다. 그래서 OCR 은 메인 후보를 '빼는' 데만 쓰고, 고른 메인은 사람이 한 번 본다.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// PowerShell 쪽. String.raw 라 정규식 역슬래시가 그대로 간다 — 안에 백틱이나 '$' + '{' 를 쓰면 안 된다.
// 투명 PNG 는 흰 바탕에 깔고(투명이 검게 읽혀 어두운 로고 글자가 사라진다), 작은 이미지는 1500px 로 키운다.
const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Drawing
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' } | Select-Object -First 1
function Await($op, [type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); [void]$task.Wait(-1); $task.Result }
$paths = (New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)).ReadToEnd() | ConvertFrom-Json
$engines = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($_) })
# 인식기가 없으면 모든 이미지가 '글자 없음' 으로 나와 글자 든 이미지가 메인이 된다 — 통째로 실패시킨다.
if (-not $engines.Count) { [Console]::Error.Write('NO_OCR_ENGINE'); exit 3 }
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$out = foreach ($p in @($paths)) {
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ("$($dec.BitmapAlphaMode)" -ne 'Ignore') {
      # transparent pixels decode as black and hide dark logo text: flatten onto white (GDI+: PNG/GIF/BMP/TIFF)
      try {
        $img = [System.Drawing.Image]::FromFile($p); $flat = New-Object System.Drawing.Bitmap $img.Width, $img.Height
        $g = [System.Drawing.Graphics]::FromImage($flat); $g.Clear([System.Drawing.Color]::White)
        $g.DrawImage($img, 0, 0, $img.Width, $img.Height); $g.Dispose(); $img.Dispose()
        $ms = New-Object System.IO.MemoryStream; $flat.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $flat.Dispose(); $ms.Position = 0
        $stream.Dispose(); $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
        $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      } catch { }
    }
    $long = [double][Math]::Max($dec.PixelWidth, $dec.PixelHeight)
    # upscale small images so badge-size text is read; cap at the engine limit
    $s = if ($long -lt 1500) { 1500 / $long } else { [Math]::Min(1.0, $max / $long) }
    $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
    $tf.ScaledWidth = [uint32][Math]::Floor($dec.PixelWidth * $s); $tf.ScaledHeight = [uint32][Math]::Floor($dec.PixelHeight * $s)
    $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Cubic
    $bmp = Await ($dec.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied, $tf,
      [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
      [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $lines = @(foreach ($e in $engines) { (Await ($e.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])).Lines | ForEach-Object { $_.Text } })
    $stream.Dispose(); $bmp.Dispose()
    $hit = @($lines | Where-Object { ($_ -replace '[^\p{L}\p{N}]', '').Length -ge 2 })
    [ordered]@{ path = $p; hasText = ($hit.Count -gt 0); text = ($lines -join ' | ') }
  } catch { [ordered]@{ path = $p; hasText = $null; text = ''; error = $(for ($x = $_.Exception; $x.InnerException; $x = $x.InnerException) {}; $x.Message) } }
}
$bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @($out) -Compress))
$o = [Console]::OpenStandardOutput(); $o.Write($bytes, 0, $bytes.Length); $o.Flush()
`;

/** 로컬 이미지 경로 → [{ path, hasText, text, error? }]. hasText null = 읽지 못함(메인으로 쓰지 않는다). */
export function detectImageText(paths) {
  if (!paths.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = execFile(POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, timeout: 30000 + paths.length * 3000 },
      (err, stdout, stderr) => {
        // stderr 는 CLIXML·CP949 라 깨져 보인다 — 원인은 종료 코드로만 알린다.
        if (err) return reject(new Error('이미지 글자 판별(OCR) 실패: ' + (/NO_OCR_ENGINE/.test(stderr) ? 'Windows OCR 인식기가 설치돼 있지 않습니다'
          : err.killed ? '시간 초과' : 'PowerShell 종료 코드 ' + (err.code ?? err.message))));
        try { const r = JSON.parse(stdout); resolve(Array.isArray(r) ? r : [r]); }
        catch { reject(new Error('이미지 글자 판별(OCR) 결과를 읽지 못했습니다: ' + stdout.slice(0, 200))); }
      });
    child.stdin.on('error', () => {});   // PowerShell 이 먼저 끝나면 EPIPE — 실패는 위 콜백이 종료 코드로 알린다
    child.stdin.end(JSON.stringify(paths.map(p => path.resolve(p))));
  });
}

/**
 * https 이미지 URL → [{ url, hasText, text, error? }] (넣은 순서 그대로). 파일은 %TEMP%/veryup-ocr/<sha1(url)> 에 두고 다시 쓴다 —
 * 아마존 이미지 URL(/images/I/<id>.jpg)은 내용이 바뀌면 주소도 바뀐다. 못 받은 URL 만 hasText null 이 되고 나머지는 계속한다.
 */
export async function detectUrlText(urls, { dir = path.join(os.tmpdir(), 'veryup-ocr'), fetchImpl = fetch, detect = detectImageText, width = 6 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const files = new Array(urls.length), failed = new Map();
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++, url = urls[i];
      try {
        const ext = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
        const file = path.join(dir, crypto.createHash('sha1').update(url).digest('hex') + ext);
        if (!fs.existsSync(file)) {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          // 다 받은 뒤에만 이름을 붙인다 — 잘린 파일이 캐시에 남으면 OCR 이 '글자 없음'(메인 후보)으로 읽는다.
          const body = Buffer.from(await res.arrayBuffer());
          if (!body.length) throw new Error('빈 응답');
          fs.writeFileSync(file + '.part', body);
          fs.renameSync(file + '.part', file);
        }
        files[i] = file;
      } catch (e) { failed.set(i, '이미지를 내려받지 못함: ' + e.message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, urls.length) }, worker));
  const ok = urls.map((_, i) => i).filter(i => files[i]);
  const found = await detect(ok.map(i => files[i]));
  const byIndex = new Map(ok.map((i, k) => [i, found[k]]));
  return urls.map((url, i) => failed.has(i) ? { url, hasText: null, text: '', error: failed.get(i) }
    : { url, hasText: byIndex.get(i)?.hasText ?? null, text: byIndex.get(i)?.text || '', ...(byIndex.get(i)?.error ? { error: byIndex.get(i).error } : {}) });
}
