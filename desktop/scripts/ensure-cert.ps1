# FlowTask 自签代码证书（一次性，可重复执行）
# -----------------------------------------------------------------------------
# 用途：给本地构建的 exe / 安装包签名，消除「被篡改的 node.exe（签名残缺）」与
# 「完全未签名」两类杀软启发式误报的诱因。自签证书只在本机受信（写入当前用户
# 受信任根 + 受信任人），对外分发场景要换 OV/EV 证书——README 已注明。
# 产物：%USERPROFILE%\FlowTaskSign\flowtask-codegen.pfx（密码同目录 pass.txt）
# 注意：pfx 与密码绝不入库（已在 .gitignore 之外，位于用户目录）。
$ErrorActionPreference = 'Stop'
$dir  = Join-Path $env:USERPROFILE 'FlowTaskSign'
$pfx  = Join-Path $dir 'flowtask-codegen.pfx'
$pass = Join-Path $dir 'pass.txt'

New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (-not (Test-Path $pass)) {
    $pw = -join ((48..57)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
    Set-Content -Path $pass -Value $pw -NoNewline -Encoding ascii
}
$sec = ConvertTo-SecureString -String (Get-Content $pass -Raw) -Force -AsPlainText

# 已有未过期证书就复用
$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Subject -eq 'CN=FlowTask (Local Dev), O=FlowTask' -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1
if ($existing) {
    Write-Host "已存在证书 $($existing.Thumbprint)，复用"
    exit 0
}
$cert = New-SelfSignedCertificate -Subject 'CN=FlowTask (Local Dev), O=FlowTask' `
    -Type CodeSigningCert -CertStoreLocation Cert:\CurrentUser\My `
    -HashAlgorithm SHA256 -KeyLength 2048 -NotAfter (Get-Date).AddYears(5)
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $sec | Out-Null

# 本机信任链：受信任人 + 受信任根（当前用户级，无需管理员）
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\Root -Password $sec | Out-Null
Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\TrustedPeople -Password $sec | Out-Null
Write-Host "证书已生成并受信：$($cert.Thumbprint)（有效期至 $($cert.NotAfter.ToShortDateString())）"
