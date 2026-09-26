# FlowTask 桌面版本地一键出包（构建 → 签名 → 汇总产物）
# -----------------------------------------------------------------------------
# 用法：
#   powershell -File desktop/build_release.ps1              # 完整链路
#   powershell -File desktop/build_release.ps1 -SkipSidecar # 服务端代码没改时跳过 88MB 重打
# 产物：desktop/dist/<version>/ —— 免安装三件套 + 安装包 + SHA256SUMS.txt，全部带签名。
# 签名策略：主程序与安装包交给 Tauri 内置的 certificateThumbprint 机制在正确时机签
# （tauri 打包时会 patch 主 exe，先签后打包会破坏签名，不能手工后置）；
# sidecar 是外部二进制 tauri 不管，由本脚本在交给 tauri 前手工签名。
# 上传：本地构建后直接取用 dist/<version>/（gh release upload / 共享盘均可）。
param([switch]$SkipSidecar)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot                        # desktop/

# 0) 版本一致性：tauri.conf == CHANGELOG 顶部 == 服务端三端
$conf = Get-Content 'src-tauri/tauri.conf.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $conf.version
$root = Split-Path -Parent $PSScriptRoot          # 仓库根
$changelogVer = (Select-String -Path (Join-Path $root 'CHANGELOG.md') -Pattern '^\#\# \[(.+)\]' | Select-Object -First 1).Matches.Groups[1].Value
$serverVer = (Select-String -Path (Join-Path $root 'flowtask_server.js') -Pattern "const VERSION = '(.+)'").Matches.Groups[1].Value
$htmlVer = (Select-String -Path (Get-ChildItem $root -Filter 'FlowTask_*.html').FullName -Pattern "APP_VERSION = '(.+)'").Matches.Groups[1].Value
if (-not ($ver -eq $changelogVer -and $ver -eq $serverVer -and $ver -eq $htmlVer)) {
    throw "版本不一致：tauri=$ver changelog=$changelogVer server=$serverVer html=$htmlVer"
}
Write-Host "== FlowTask v$ver 出包 ==" -ForegroundColor Cyan

# 1) 证书（幂等）+ 签名工具
& (Join-Path $PSScriptRoot 'scripts/ensure-cert.ps1')
$sig = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq 'CN=FlowTask (Local Dev), O=FlowTask' -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1
if (-not $sig) { throw '找不到代码签名证书' }
$thumb = $sig.Thumbprint
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter signtool.exe |
    Where-Object { $_.FullName -match 'x64' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw '找不到 Windows SDK 的 signtool.exe' }

# 2) 把证书指纹注入 tauri 配置（本机构建期行为，脚本结束还原，绝不入库）
$confPath = Join-Path $PSScriptRoot 'src-tauri/tauri.conf.json'
$orig = Get-Content $confPath -Raw -Encoding UTF8
$patched = $orig -replace '"windows"\s*:\s*\{', ('"windows": { "certificateThumbprint": "' + $thumb + '", "digestAlgorithm": "sha256", "timestampUrl": "http://timestamp.digicert.com",')
if ($patched -eq $orig) { throw '未能在 tauri.conf.json 注入签名配置（bundle.windows 缺失？）' }
[System.IO.File]::WriteAllText((Resolve-Path $confPath), $patched, (New-Object System.Text.UTF8Encoding $false))
try {
    # 3) sidecar（Node SEA + 清残缺签名 + 手工签名）
    #    退出码必须显式判：构建失败却继续往下走，会拿上一轮的陈旧 exe 去签名出包，
    #    产物看起来"成功"、实际服务端是旧的（tauri build 那步有判，这里此前没有）。
    if (-not $SkipSidecar) {
        node (Join-Path $PSScriptRoot 'scripts/build-sidecar.cjs')
        if ($LASTEXITCODE -ne 0) { throw "sidecar 构建失败（node 退出码 $LASTEXITCODE），已中止出包" }
    }
    $sidecar = Join-Path $PSScriptRoot 'src-tauri/binaries/flowtask-server-x86_64-pc-windows-msvc.exe'
    # -SkipSidecar 没有新鲜度校验时，服务端源码改了却复用旧 sidecar 会静默发出版本不符的包
    if ($SkipSidecar) {
        $sidecarTime = (Get-Item $sidecar).LastWriteTimeUtc
        $newestSrc = Get-ChildItem $root -Filter 'flowtask_*.js' -File |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
        if ($newestSrc -and $newestSrc.LastWriteTimeUtc -gt $sidecarTime) {
            throw "-SkipSidecar 但服务端源码比 sidecar 新（$($newestSrc.Name) > $($sidecarTime.ToString('u'))）：请去掉 -SkipSidecar 重新构建"
        }
    }
    Write-Host '== 签名 sidecar =='
    & $signtool.FullName sign /fd SHA256 /sha1 $thumb /tr http://timestamp.digicert.com /td SHA256 $sidecar | Out-Null
    if ((Get-AuthenticodeSignature $sidecar).Status -ne 'Valid') { throw 'sidecar 签名失败' }
    Write-Host '  签名 OK：flowtask-server'

    # 4) 一次成型的 tauri build：编译 → patch → 签主程序 → NSIS → 签安装包
    Write-Host '== tauri build（内置签名接管主程序与安装包）=='
    npx tauri build
    if ($LASTEXITCODE -ne 0) { throw 'tauri build 失败' }

    # tauri 在打包阶段会对包内主程序/sidecar/安装包统一签名（装包实测全 Valid）；
    # target/release 的散件可能仍是 patch 后的未签版本——dist 一律取安装包解出的等价物：
    # 主程序与 sidecar 直接在 loose 文件上补签（与包内同字节源，签名等价）
    $mainExe = Join-Path $PSScriptRoot 'src-tauri/target/release/FlowTask.exe'
    $looseSidecar = Join-Path $PSScriptRoot 'src-tauri/target/release/flowtask-server.exe'
    foreach ($f in @($mainExe, $looseSidecar)) {
        if ((Get-AuthenticodeSignature $f).Status -ne 'Valid') {
            & $signtool.FullName sign /fd SHA256 /sha1 $thumb /tr http://timestamp.digicert.com /td SHA256 $f | Out-Null
        }
        if ((Get-AuthenticodeSignature $f).Status -ne 'Valid') { throw "散件签名失败：$f" }
    }
    $installer = Join-Path $PSScriptRoot "src-tauri/target/release/bundle/nsis/FlowTask_${ver}_x64-setup.exe"
    foreach ($f in @($installer)) {
        $st = (Get-AuthenticodeSignature $f).Status
        if ($st -ne 'Valid') { throw "签名校验失败：$f → $st" }
        Write-Host "  签名 OK：$(Split-Path -Leaf $f)"
    }

    # 5) 汇总产物 + 校验和（免安装三件套：主程序 + 平铺 sidecar + app.html）
    $dist = Join-Path $PSScriptRoot "dist/$ver"
    Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue   # 每次全量重建，不留旧残留
    New-Item -ItemType Directory -Force -Path $dist | Out-Null
    Copy-Item $mainExe $dist -Force
    Copy-Item $installer $dist -Force
    Copy-Item (Join-Path $PSScriptRoot 'src-tauri/target/release/flowtask-server.exe') (Join-Path $dist 'flowtask-server.exe') -Force
    Copy-Item (Join-Path $PSScriptRoot 'src-tauri/target/release/app.html') $dist -Force

    # 5b) 分发物里绝不允许出现运行时数据：在 exe 旁边双击跑一次，服务就会在**同目录**
    #     生成 flowtask_auth.json / flowtask_secret.json（含真实口令哈希与会话签名密钥）。
    #     dist 是拿去内网分发甚至打包上传的目录，混进这两个文件等于把凭据一起发出去。
    $leaked = Get-ChildItem $dist -File | Where-Object {
        $_.Name -match '^flowtask_(auth|shared|secret|sync)\.json$' -or
        $_.Name -match '^flowtask_data_' -or $_.Name -match '\.base\.json$'
    }
    if ($leaked) {
        throw ("dist 里混入了运行时数据文件，已中止出包：" + (($leaked | ForEach-Object { $_.Name }) -join ' , ') +
               "`n请删掉这些文件（它们记录的是你自己的账户与密钥），再重新汇总产物。")
    }

    Push-Location $dist
    Get-ChildItem -Exclude SHA256SUMS.txt | ForEach-Object {
        $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
        "$h  $($_.Name)"
    } | Set-Content SHA256SUMS.txt -Encoding ascii
    Pop-Location
    Write-Host "`n== 产物就绪：$dist ==" -ForegroundColor Green
    Get-ChildItem $dist | ForEach-Object { "  {0,10:N1} MB  {1}" -f ($_.Length/1MB), $_.Name }
}
finally {
    [System.IO.File]::WriteAllText((Resolve-Path $confPath), $orig, (New-Object System.Text.UTF8Encoding $false))   # 还原配置，指纹不入库
}
