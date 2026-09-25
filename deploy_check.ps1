# FlowTask 环境检查与部署（部署到新电脑后运行一次即可）
# 由 环境检查与部署.bat 调用：检查运行环境 / 数据文件 / 端口，然后交给启动器完成部署。
# 运行环境：Windows 10/11 自带 PowerShell 即可，Node.js 为可选项。
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$utf8 = New-Object System.Text.UTF8Encoding($false)
$fail = $false

function OK($msg)   { Write-Host ("  [OK] " + $msg) }
function SKIP($msg) { Write-Host ("  [--] " + $msg) }
function BAD($msg)  { Write-Host ("  [X]  " + $msg); $script:fail = $true }

Write-Host '=============================================='
Write-Host '  FlowTask 环境检查与部署'
Write-Host '=============================================='
Write-Host ''

# ---- 1/6 核心文件 ----
Write-Host '[1/6] 核心文件'
if (Test-Path (Join-Path $root 'FlowTask_本地项目管理平台.html')) { OK 'FlowTask 页面文件存在' } else { BAD '缺少 FlowTask_本地项目管理平台.html，请重新拷贝完整文件夹' }
if (Test-Path (Join-Path $root 'flowtask_server.ps1')) { OK 'PowerShell 版存储服务存在（主用）' } else { BAD '缺少 flowtask_server.ps1' }
if (Test-Path (Join-Path $root '启动 FlowTask.vbs')) { OK '一键启动器存在' } else { BAD '缺少「启动 FlowTask.vbs」' }
Write-Host ''

# ---- 2/6 运行环境 ----
Write-Host '[2/6] 运行环境'
try { $v = $PSVersionTable.PSVersion.ToString(); OK ("Windows PowerShell 可用（当前 " + $v + "）") } catch { BAD 'Windows PowerShell 不可用' }
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { OK ('检测到 Node.js（' + (& node -v) + '），优先使用 Node 版存储服务') } else { SKIP '未检测到 Node.js：使用 PowerShell 版（Windows 自带，无需安装）' }
$edge = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edge) { OK '检测到 Edge 浏览器' } else { SKIP '未找到 Edge（任何现代浏览器打开 http://127.0.0.1:5178 均可）' }
Write-Host ''

# ---- 3/6 数据文件 ----
Write-Host '[3/6] 数据文件（accounts / 个人库 / 共享库，全部 .json）'
if (Test-Path (Join-Path $root 'flowtask_auth.json')) { OK '账户表 flowtask_auth.json 存在' } else { SKIP '账户表不存在（全新安装，首次注册自动创建）' }
$personal = @(Get-ChildItem -Path $root -Filter 'flowtask_data_*.json' | Where-Object { $_.Name -notmatch 'conflict|corrupt' })
if ($personal.Count -gt 0) { OK ('检测到 ' + $personal.Count + ' 份个人库：' + (($personal | ForEach-Object { $_.Name }) -join '、')) } else { SKIP '未检测到个人库（全新安装）' }
if (Test-Path (Join-Path $root 'flowtask_shared.json')) { OK '团队共享库 flowtask_shared.json 存在' } else { SKIP '共享库不存在（共享项目后自动创建）' }
if (Test-Path (Join-Path $root 'flowtask_data.json')) { SKIP '检测到旧版单文件 flowtask_data.json（其中未认领的项目会在对应账户登录时自动迁入）' }
Write-Host ''

# ---- 4/6 端口 5178 ----
Write-Host '[4/6] 端口 5178'
$conn = Get-NetTCPConnection -LocalPort 5178 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    OK '已有 FlowTask 存储服务在运行（不会重复启动）'
} else {
    OK '端口 5178 空闲'
}
Write-Host ''

# ---- 5/6 自动备份目录 ----
Write-Host '[5/6] 自动备份'
$bdir = Join-Path $root 'backups'
if (Test-Path $bdir) {
    $n = @(Get-ChildItem -Path $bdir -Filter '*.json').Count
    OK ('backups/ 存在，当前有 ' + $n + ' 份历史备份')
} else { SKIP 'backups/ 尚未创建（服务运行后自动生成，每 10 分钟备份一次）' }
Write-Host ''

# ---- 6/6 交给启动器（起服务 + 重建快捷方式 + 打开浏览器） ----
Write-Host '[6/6] 启动 FlowTask'
$vbs = Join-Path $root '启动 FlowTask.vbs'
if (Test-Path $vbs) {
    Write-Host '  交给一键启动器：启动存储服务（若未运行）→ 重建本机快捷方式 → 打开浏览器'
    Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"') -WorkingDirectory $root
    # 等待服务就绪（最多 30 秒；若之前已在运行会立即通过）
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $j = Invoke-RestMethod -Uri 'http://127.0.0.1:5178/api/ping' -TimeoutSec 2
            if ($j.ready) { OK ('存储服务就绪（v' + $j.version + '）'); $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { BAD '存储服务 30 秒内未就绪：请确认杀毒软件未拦截 flowtask_server.ps1，或手动运行「启动存储服务.bat」' }
} else {
    BAD '找不到一键启动器，无法自动完成部署'
}

Write-Host ''
if ($fail) {
    Write-Host '结论：环境检查发现问题，请按上方 [X] 提示处理后重试。'
    exit 1
} else {
    Write-Host '结论：环境就绪，FlowTask 已启动。所有数据保存在本文件夹的 .json 文件里。'
    exit 0
}
