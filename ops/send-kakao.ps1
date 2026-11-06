# Types a message into an open PC KakaoTalk chat window and presses Enter.
# The chat room must be open in its own window (window title = room name).
# ponytail: relies on Kakao's RichEdit50W input box; breaks if Kakao changes its window layout.
param(
    [Parameter(Mandatory)][string]$Room,
    [Parameter(Mandatory)][string]$TextFile
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class KakaoWin {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@

$win = [KakaoWin]::FindWindow($null, $Room)
if ($win -eq [IntPtr]::Zero) { throw "Kakao chat window not found: open the room '$Room' in its own window" }
$edit = [KakaoWin]::FindWindowEx($win, [IntPtr]::Zero, 'RichEdit50W', $null)
if ($edit -eq [IntPtr]::Zero) { throw "Kakao input box (RichEdit50W) not found in '$Room'" }

$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
# WM_SETTEXT with SMTO_ABORTIFHUNG: a hung Kakao window fails here instead of blocking forever.
$r = [IntPtr]::Zero
if ([KakaoWin]::SendMessageTimeout($edit, 0x000C, [IntPtr]::Zero, $text, 0x2, 5000, [ref]$r) -eq [IntPtr]::Zero) { throw "Kakao did not accept the text (window hung or closed)" }
if (-not [KakaoWin]::PostMessage($edit, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero)) { throw "Enter key down failed" }   # WM_KEYDOWN Enter
Start-Sleep -Milliseconds 50
if (-not [KakaoWin]::PostMessage($edit, 0x0101, [IntPtr]0x0D, [IntPtr]::Zero)) { throw "Enter key up failed" }     # WM_KEYUP Enter
