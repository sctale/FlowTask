# PowerShell 语法解析检查：不执行，只做 Parser 层面的语法校验。
# 覆盖仓库根目录下所有 .ps1（新增文件自动纳入，不必再改这里）。
# 用法： powershell -File tests/_ps1_parse_check.ps1 [额外的 .ps1 路径...]
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $root
$targets = @(Get-ChildItem -Path $root -Filter '*.ps1' -File | ForEach-Object { $_.FullName })
foreach ($extra in $args) { if ($extra) { $targets += (Resolve-Path $extra).Path } }
$targets = $targets | Select-Object -Unique

$bad = 0
foreach ($f in $targets) {
    $errs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs)
    if ($errs -and $errs.Count) {
        $bad++
        Write-Output ("FAIL  " + (Split-Path -Leaf $f))
        $errs | Select-Object -First 6 | ForEach-Object {
            Write-Output ("      " + $_.Extent.StartLineNumber + ": " + $_.Message)
        }
    } else {
        Write-Output ("PASS  " + (Split-Path -Leaf $f) + ' 语法可解析')
    }
}
# 编码闸门。三条都必须过，缺一即红：
#   1) 带中文的 .ps1 必须有 UTF-8 BOM，否则 PowerShell 5.1 会按 GBK 解码成乱码；
#   2) 只能有一个 BOM。重复 BOM（EF BB BF EF BB BF）会让首行变成一条语句，
#      param(...) 不再是脚本的第一条语句 → 参数块解析失败、整个服务起不来。
#      而"前三字节是 EF BB BF"这个判据对它恰好为真，所以必须单独查；
#   3) 不得是 UTF-16。仓库约定 .ps1 一律 UTF-8 BOM。
$noBom = @()
$multiBom = @()
$utf16 = @()
foreach ($f in $targets) {
    $b = [System.IO.File]::ReadAllBytes($f)
    $hasBom = ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF)
    $txt = [System.Text.Encoding]::UTF8.GetString($b)
    if (-not $hasBom -and $txt -match '[一-鿿]') { $noBom += (Split-Path -Leaf $f) }
    if ($b.Length -ge 6 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF -and
        $b[3] -eq 0xEF -and $b[4] -eq 0xBB -and $b[5] -eq 0xBF) { $multiBom += (Split-Path -Leaf $f) }
    if ($b.Length -ge 2 -and $b[0] -eq 0xFF -and $b[1] -eq 0xFE) { $utf16 += (Split-Path -Leaf $f) }
}
if ($noBom.Count) {
    $bad++
    Write-Output ("FAIL  这些含中文的 .ps1 缺 UTF-8 BOM（PS5.1 会读成乱码）：" + ($noBom -join ' , '))
} else {
    Write-Output 'PASS  含中文的 .ps1 均带 UTF-8 BOM'
}
if ($multiBom.Count) {
    $bad++
    Write-Output ("FAIL  这些 .ps1 有重复 BOM（PowerShell 无法解析，param 块会失效）：" + ($multiBom -join ' , '))
} else {
    Write-Output 'PASS  无 .ps1 带重复 BOM'
}
if ($utf16.Count) {
    $bad++
    Write-Output ("FAIL  这些 .ps1 是 UTF-16 编码（约定为 UTF-8 BOM）：" + ($utf16 -join ' , '))
} else {
    Write-Output 'PASS  无 .ps1 使用 UTF-16'
}
if ($bad) { Write-Output ("== PS1 解析检查：发现 " + $bad + " 个问题 =="); exit 1 }
Write-Output ("== PS1 解析检查：全部通过（" + $targets.Count + " 个脚本）==")
