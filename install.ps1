#Requires -Version 5.1
<#
.SYNOPSIS
  安装 / 卸载 wb-switch 桌面应用（启动 NSIS 安装程序）

.DESCRIPTION
  找到 wb-switch-Setup-*.exe 并启动标准 Windows 安装向导。
  安装向导会处理：选目录、创建快捷方式、注册控制面板条目。
  卸载也从控制面板「设置 → 应用」或本脚本 -Uninstall 触发。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Say($msg) {
  if (-not $Quiet) { Write-Host $msg }
}

# ── 卸载 ──
if ($Uninstall) {
  $reg = @(Get-ItemProperty "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -match "wb-switch" })
  if ($reg.Count -gt 0) {
    $entry = $reg[0]
    $uninstaller = ($entry.UninstallString -replace ' /allusers','').Trim('"')
    Write-Say "正在卸载…"
    Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait
    Write-Say "卸载完成。"
  } else {
    Write-Say "未找到已安装的 wb-switch。"
    Write-Say "（如果用的是免安装版 portable exe，直接删除文件即可。）"
  }
  return
}

# ── 找安装包 ──
$setup = $null
foreach ($dir in @($root, (Join-Path $root 'dist-app'))) {
  $setup = Get-ChildItem -Path $dir -Filter "wb-switch-Setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($setup) { break }
}

if (-not $setup) {
  Write-Host "找不到安装程序 wb-switch-Setup-*.exe" -ForegroundColor Red
  Write-Host "请先构建：npm run build:win" -ForegroundColor Yellow
  exit 1
}

Write-Say "启动安装程序：$($setup.Name)"
Start-Process -FilePath $setup.FullName
