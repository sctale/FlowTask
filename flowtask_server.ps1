# FlowTask 本地文件存储服务（PowerShell 零依赖版 · v2.1.1）
# --------------------------------------------------------
# 作用：把 FlowTask 数据实时写入同目录的 JSON 文件，
#       无需安装 Node.js，Windows 10/11 自带 PowerShell 即可运行。
#
# v1.5 数据分区与账户会话（与 flowtask_server.js 完全对等）：
#   - 三份物理数据文件，全部 .json（公司电脑只放行 json/md/html/db 类文件）
#       flowtask_auth.json        账户表（注册表，全员共用一份）
#       flowtask_data_<uid>.json  个人库（每个账户一份，彼此物理隔离）
#       flowtask_shared.json      共享库（被设为「团队共享」的项目）
#   - HMAC-SHA256 会话令牌：登录/注册后签发，7 天有效；
#     读写个人库/共享库必须携带有效会话，未登录返回 401
#   - 假冲突修复：同版本号 + 内容一致 → 幂等 200；内容确实不同才是真冲突 409
#   - /api/ping 探活端点（免鉴权），供启动脚本判断服务是否就绪
#   - 兼容期：不带 file 参数时仍走旧版 flowtask_data.json（令牌即可）
#
# v1.6 会话可信与写盘可信（与 flowtask_server.js 完全对等）：
#   - /api/auth-challenge：登录挑战只回 uid/salt/算法，绝不下发哈希
#   - POST /api/session 必须携带密码证明（PBKDF2 结果），服务端常量时间比对
#   - POST /api/changepw：本人改密码（需会话 + 旧密码证明）
#   - 账户表写入按字段级守卫：防整表覆盖/删户/改角色/改他人密码
#   - 写盘失败回 500 且不推进版本；版本在写盘前同步推进（并发不再静默覆盖）
#   - 读取错误（除文件不存在）回 500，不再谎报 204「空库」
#
# 接口（与 flowtask_server.js 保持一致）：
#   GET /api/ping | GET /api/token | GET /api/auth-challenge?username=
#   GET|POST /api/session | POST /api/changepw
#   GET /api/version?file= | GET|POST /api/db?file= | POST /api/db-conflict?file= | GET /
#
# 启动：双击「启动 FlowTask.vbs」会自动调用本脚本；
#       也可命令行执行：powershell -ExecutionPolicy Bypass -File flowtask_server.ps1
# 停止：关闭 PowerShell 窗口，或任务管理器结束 powershell.exe。

param(
    [int]$Port = 5178,
    [string]$HostIP = '127.0.0.1',
    [string]$DataDir = '',
    [string]$ShareDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web

$baseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $baseDir) { $baseDir = (Get-Location).Path }
if (-not $DataDir) { $DataDir = $baseDir }
# 规范化路径：8.3 短名（SID~1.SHE）会让 Move-Item 报"对象不存在"
try { if (Test-Path -LiteralPath $DataDir) { $DataDir = (Get-Item -LiteralPath $DataDir).FullName } } catch { }
$authFile   = Join-Path $DataDir 'flowtask_auth.json'
$secretFile = Join-Path $DataDir 'flowtask_secret.json'
$legacyName = 'flowtask_data.json'
$backupDir  = Join-Path $DataDir 'backups'
$htmlFile   = Join-Path $baseDir 'FlowTask_本地项目管理平台.html'
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)

$script:VERSION = '2.1.1'
$script:TOKEN = [Guid]::NewGuid().ToString('N')
$script:allowedOrigins = @(("http://{0}:{1}" -f $HostIP, $Port), 'null')
$bodyLimit        = 8 * 1024 * 1024
$backupIntervalMs = 10 * 60 * 1000
$backupKeep       = 40
$sessionTtlMs     = 7 * 24 * 60 * 60 * 1000      # 记住 7 天
$script:fileState = @{}                          # name -> @{rev;hash;lastBackupAt}
$script:SECRET = $null

# 文件名白名单：只允许这三类，杜绝路径穿越
$filePattern = '^flowtask_(auth|shared|data_[a-z0-9_\-]{1,64})\.json$'

# ---------------- 共享盘同步（本地优先；不配置就是纯本机，行为与今天一致） ----------------
# 配置来源优先级：命令行参数 > 环境变量 FLOWTASK_SHARE_DIR > flowtask_config.json > 默认关闭。
# 配置文件与「数据目录」同处（跟着文件夹一起拷走），让不懂命令行的人也能开启，形如：
#   { "shareDir": "\\\\server\\share\\FlowTask", "syncEnabled": true }
# 刻意读 $DataDir 而不是程序目录：测试会把 -DataDir 重定向到临时目录，
# 这样跑回归就不会看到真机的配置、把测试数据写进生产共享盘。
$script:configPath = Join-Path $DataDir 'flowtask_config.json'
# 读配置：返回有序字典（保留用户手加的未知键），读不懂就返回空表并按纯本机启动
function Read-ConfigFile {
    $d = [ordered]@{}
    try {
        if (Test-Path -LiteralPath $script:configPath) {
            $cj = [System.IO.File]::ReadAllText($script:configPath, $utf8NoBom) | ConvertFrom-Json
            if ($cj) { foreach ($p in $cj.PSObject.Properties) { $d[$p.Name] = $p.Value } }
        }
    } catch {
        Write-Host '⚠ flowtask_config.json 读不懂，本次按纯本机模式启动' -ForegroundColor Yellow
        $d = [ordered]@{}
    }
    return $d
}
function Save-ConfigFile($patch) {
    foreach ($k in @($patch.Keys)) { $script:cfg[$k] = $patch[$k] }
    $json = ($script:cfg | ConvertTo-Json -Depth 6) + "`n"
    $tmp = $script:configPath + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $json, $utf8NoBom)
    # 目标是目录时 Move-Item 会「移进去」并静默成功——与数据文件同一套原子替换，必须先拦
    if (Test-Path -LiteralPath $script:configPath -PathType Container) { throw 'config destination is a directory' }
    Move-Item -LiteralPath $tmp -Destination $script:configPath -Force
    return $script:cfg
}
$script:cfg = Read-ConfigFile
$cfgShare = $(if ($script:cfg.Contains('shareDir')) { [string]$script:cfg['shareDir'] } else { '' })
$cfgOff = ($script:cfg.Contains('syncEnabled') -and ($script:cfg['syncEnabled'] -eq $false))
$fromCfg = $(if ($cfgOff) { '' } else { $cfgShare })
$script:ShareDir = ("" + $(if ($ShareDir) { $ShareDir } elseif ($env:FLOWTASK_SHARE_DIR) { $env:FLOWTASK_SHARE_DIR } else { $fromCfg })).Trim()
$script:syncEnabled = [bool]$script:ShareDir
$script:syncPendingPush = $null          # 回包之后要推送的那份文件
if ($script:ShareDir -and (Test-Path -LiteralPath $script:ShareDir)) {
    try { $script:ShareDir = (Get-Item -LiteralPath $script:ShareDir).FullName } catch { }
}
. (Join-Path $baseDir 'flowtask_sync.ps1')
# 覆盖同步引擎里的默认空实现：拉取改写本地文件后，必须让 rev/hash 缓存作废，
# 否则服务端拿旧指纹比对，会产生假冲突或漏判真冲突。
function Invoke-OnLocalChanged([string]$name) { if ($script:fileState.ContainsKey($name)) { [void]$script:fileState.Remove($name) } }
# 界面看到的同步配置。envOverride 必须报出来：环境变量优先级高于配置文件，
# 否则用户改了路径、重启后被环境变量顶回去，还以为自己配置丢了
function Open-RegistrationAllowed {
    return ($script:cfg.Contains('openRegistration') -and ($script:cfg['openRegistration'] -eq $true))
}
function Get-PublicConfig {
    # shareDir = 用户配的是什么（意图，关同步也留着）；activeShareDir = 此刻真正在用的
    # 两者合成一个值的话，停用后界面会把长路径从输入框抹掉，逼人重敲
    $intent = $(if ($script:cfg.Contains('shareDir')) { ("" + $script:cfg['shareDir']) } else { '' })
    if (-not $intent) { $intent = [string]$script:ShareDir }
    return @{
        shareDir         = $intent
        activeShareDir   = [string]$script:ShareDir
        syncEnabled      = [bool]$script:syncEnabled
        openRegistration = (Open-RegistrationAllowed)
        envOverride      = [bool]("" + $env:FLOWTASK_SHARE_DIR).Trim()
    }
}

function Write-Log($msg) {
    Write-Host ("[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg)
}

function Get-TsTag {
    return (Get-Date).ToString('yyyyMMdd_HHmmss')
}

# 仅回显可信来源（同源 / file:// 的 Origin:null）
function Get-Acao($headers) {
    $o = ''
    if ($headers.ContainsKey('origin')) { $o = $headers['origin'] }
    if ($script:allowedOrigins -contains $o) { return $o }
    return $null
}

function Send-Response($stream, $code, $body, $contentType = 'text/plain; charset=utf-8', $headers = @{}) {
    $statusText = switch ($code) {
        200 { 'OK' }
        204 { 'No Content' }
        400 { 'Bad Request' }
        401 { 'Unauthorized' }
        403 { 'Forbidden' }
        404 { 'Not Found' }
        409 { 'Conflict' }
        413 { 'Payload Too Large' }
        500 { 'Internal Server Error' }
        default { 'OK' }
    }
    $bodyBytes = if ($body -is [byte[]]) { $body } else { [System.Text.Encoding]::UTF8.GetBytes([string]$body) }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("HTTP/1.1 $code $statusText`r`n")
    [void]$sb.Append("Content-Type: $contentType`r`n")
    [void]$sb.Append("Content-Length: $($bodyBytes.Length)`r`n")
    $acao = Get-Acao $script:reqHeaders
    if ($acao) {
        [void]$sb.Append("Access-Control-Allow-Origin: $acao`r`n")
        [void]$sb.Append("Vary: Origin`r`n")
    }
    [void]$sb.Append("X-Content-Type-Options: nosniff`r`n")
    foreach ($k in $headers.Keys) { [void]$sb.Append("$k`: $($headers[$k])`r`n") }
    [void]$sb.Append("Connection: close`r`n`r`n")
    $hb = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
    try {
        $stream.Write($hb, 0, $hb.Length)
        $stream.Write($bodyBytes, 0, $bodyBytes.Length)
        $stream.Flush()
    } catch { Write-Log ("Write response error: " + $_.Exception.Message) }
}

function Send-Json($stream, $code, $obj, $headers = @{}) {
    $h = @{}; foreach ($k in $headers.Keys) { $h[$k] = $headers[$k] }
    if (-not $h.ContainsKey('Cache-Control')) { $h['Cache-Control'] = 'no-store' }
    Send-Response $stream $code ($obj | ConvertTo-Json -Compress -Depth 20) 'application/json; charset=utf-8' $h
}

function Read-HttpRequest($stream) {
    $bufSize = 8192
    $buf = New-Object byte[] $bufSize
    # 头部解析：只在新增字节上找 CRLFCRLFCRLF（起点回退 3 字节防边界被拆），
    # 旧版每轮对全缓冲 ToArray+解码，大请求头是 O(n²)
    $acc = New-Object System.Collections.Generic.List[byte]
    $headerEnd = -1
    $scanFrom = 0
    while ($true) {
        $n = $stream.Read($buf, 0, $bufSize)
        if ($n -le 0) { break }
        for ($i = 0; $i -lt $n; $i++) { $acc.Add($buf[$i]) }
        $c = $acc.Count
        $from = [Math]::Max(0, $scanFrom - 3)
        for ($j = $from; $j -le $c - 4; $j++) {
            if ($acc[$j] -eq 13 -and $acc[$j + 1] -eq 10 -and $acc[$j + 2] -eq 13 -and $acc[$j + 3] -eq 10) { $headerEnd = $j; break }
        }
        $scanFrom = $c
        if ($headerEnd -ge 0) { break }
        if ($c -gt 65536) { break }
    }
    if ($headerEnd -lt 0) { return $null }

    $headerBytes = $acc.GetRange(0, $headerEnd + 4).ToArray()
    $headersText = [System.Text.Encoding]::ASCII.GetString($headerBytes)
    $lines = $headersText -split "`r`n"
    $reqParts = $lines[0] -split ' '
    if ($reqParts.Length -lt 2) { return $null }
    $method = $reqParts[0].ToUpper()
    $path = $reqParts[1]

    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
        $kv = $lines[$i] -split ':', 2
        if ($kv.Length -eq 2) {
            $headers[$kv[0].Trim().ToLower()] = $kv[1].Trim()
        }
    }

    # body 用 MemoryStream 直写：旧版 [byte[]]$chunk[0..($r-1)] 每块都要装箱成
    # Object[] 再强转回来，大请求体是百万级对象分配
    $bodyMs = New-Object System.IO.MemoryStream
    $already = $acc.Count - ($headerEnd + 4)
    if ($already -gt 0) {
        $rest = $acc.GetRange($headerEnd + 4, $already).ToArray()
        $bodyMs.Write($rest, 0, $rest.Length)
    }
    if ($headers.ContainsKey('content-length')) {
        $cl = 0
        if (-not [int]::TryParse([string]$headers['content-length'], [ref]$cl) -or $cl -lt 0) { try { $bodyMs.Close() } catch {}; return $null }
        $need = $cl - [int]$bodyMs.Length
        while ($need -gt 0) {
            $chunk = New-Object byte[] ([Math]::Min($bufSize, $need))
            $r = $stream.Read($chunk, 0, $chunk.Length)
            if ($r -le 0) { break }
            $bodyMs.Write($chunk, 0, $r)
            $need -= $r
        }
    }
    $body = [System.Text.Encoding]::UTF8.GetString($bodyMs.ToArray())
    try { $bodyMs.Close() } catch {}

    return @{ Method = $method; Path = $path; Headers = $headers; Body = $body }
}

# ---------------- 路径与查询串 ----------------
function Get-QueryParam($path, $key) {
    $q = $path.IndexOf('?')
    if ($q -lt 0) { return $null }
    foreach ($pair in (($path.Substring($q + 1)) -split '&')) {
        $kv = $pair -split '=', 2
        if ($kv.Length -eq 2 -and $kv[0] -eq $key) {
            return [System.Uri]::UnescapeDataString($kv[1])
        }
    }
    return $null
}
function Get-PathOnly($path) {
    $q = $path.IndexOf('?')
    if ($q -lt 0) { return $path }
    return $path.Substring(0, $q)
}
function Get-FileOf($name) { return Join-Path $DataDir $name }
# Windows 文件名不区分大小写，但状态键必须唯一：与 Node 版一致改用区分大小写匹配，
# 否则 FLOWTASK_DATA_<UID>.JSON 这类变体会落到同一物理文件却另起一个 rev/hash 基线
function Test-AuthFile($name) { return $name -ceq 'flowtask_auth.json' }
function Test-ValidShape($name, $obj) {
    # A14：显式数组判定——PowerShell 中字符串同样满足 IEnumerable，
    # 用 -is [System.Collections.IEnumerable] 会把 {"users":"x"} 放行（Node 用 Array.isArray 会拒绝）
    if ($null -eq $obj) { return $false }
    if (Test-AuthFile $name) { return ($obj.users -is [array]) }
    return ($obj.projects -is [array]) -and ($obj.tasks -is [array])
}

# ---------------- 内容指纹与每文件状态 ----------------
function Get-Sha1Hex([string]$text) {
    $alg = [System.Security.Cryptography.SHA1]::Create()
    $bytes = $alg.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
    return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}
function Get-FileState($name) {
    if ($script:fileState.ContainsKey($name)) { return $script:fileState[$name] }
    $st = @{ rev = 0; hash = ''; lastBackupAt = [long]0 }
    $f = Get-FileOf $name
    if (Test-Path $f) {
        try {
            $raw = [System.IO.File]::ReadAllText($f, $utf8NoBom)
            $st.hash = Get-Sha1Hex $raw
            $d = ConvertFrom-Json $raw
            if ($d -and $d.meta -and $d.meta.rev) { $st.rev = [int]$d.meta.rev }
        } catch { }
    }
    $script:fileState[$name] = $st
    return $st
}

# ---------------- 会话令牌（HMAC-SHA256，密钥持久化，重启后旧会话仍有效） ----------------
function Get-Secret {
    if ($script:SECRET) { return $script:SECRET }
    if (Test-Path $secretFile) {
        try {
            $j = ConvertFrom-Json ([System.IO.File]::ReadAllText($secretFile, $utf8NoBom))
            if ($j -and $j.secret -and ($j.secret.Length -ge 32)) { $script:SECRET = $j.secret; return $script:SECRET }
        } catch { }
    }
    $script:SECRET = ([Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')).Substring(0, 48)
    try {
        [System.IO.File]::WriteAllText($secretFile, (@{ secret = $script:SECRET; createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress), $utf8NoBom)
    } catch { Write-Log '会话密钥无法落盘，本次启动的会话在重启后会失效' }
    return $script:SECRET
}
function Get-HmacB64Url([string]$data) {
    $h = New-Object System.Security.Cryptography.HMACSHA256
    $h.Key = [System.Text.Encoding]::UTF8.GetBytes((Get-Secret))
    $sig = $h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($data))
    return [Convert]::ToBase64String($sig).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function New-Session([string]$uid) {
    $exp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $sessionTtlMs
    return @{ session = ("{0}.{1}.{2}" -f $uid, $exp, (Get-HmacB64Url "$uid|$exp")); exp = $exp }
}
# ---------- 登录失败限速（与 Node 版对等） ----------
# key = uid + 来源 IP；连续失败 5 次起指数退避（1s/2s/4s…封顶 60s），成功即清零
$script:loginFails = @{}
function Get-LoginThrottleMs([string]$key) {
    if (-not $script:loginFails.ContainsKey($key)) { return 0 }
    $s = $script:loginFails[$key]
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($s.until -gt $now) { return [long]($s.until - $now) }
    return 0
}
function Add-LoginFailNote([string]$key) {
    if ($script:loginFails.ContainsKey($key)) { $s = $script:loginFails[$key] } else { $s = @{ n = 0; until = 0 } }
    $s.n = $s.n + 1
    if ($s.n -ge 5) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $s.until = $now + [Math]::Min(60000, [int](1000 * [Math]::Pow(2, $s.n - 5)))
    }
    if ($script:loginFails.Count -gt 4096) { $script:loginFails.Clear() }   # 防无界增长
    $script:loginFails[$key] = $s
}
function Clear-LoginFailNote([string]$key) { $script:loginFails.Remove($key) }
function Get-SessionUid([string]$tok) {
    if ([string]::IsNullOrEmpty($tok)) { return $null }
    $parts = $tok -split '\.'
    if ($parts.Length -ne 3) { return $null }
    $uid = $parts[0]; $exp = 0L
    # v1.10：与 Node 版同步收紧为大小写敏感（-cnotmatch）。旧版两侧都放宽 /i，
    # 但个人库文件名白名单 $filePattern 不含大写——放宽会签出「会话合法但库文件被拒」的死角账户
    if ($uid -cnotmatch '^[a-z0-9_\-]{1,64}$') { return $null }
    if (-not [Int64]::TryParse($parts[1], [ref]$exp)) { return $null }
    if ($exp -lt [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { return $null }
    $want = Get-HmacB64Url "$uid|$exp"
    $a = [System.Text.Encoding]::UTF8.GetBytes($parts[2]); $b = [System.Text.Encoding]::UTF8.GetBytes($want)
    if ($a.Length -ne $b.Length) { return $null }
    for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { return $null } }
    return $uid
}

# ---------------- 备份轮转（按文件各自保留） ----------------
# 轮转必须按「完整文件名 + 时间戳」匹配，不能用裸前缀：flowtask_data_ 同样是
# 每个个人库备份（flowtask_data_<uid>_时间戳.json）的前缀，裸 StartsWith 会把
# 别的账户的备份当成旧版单文件的备份删掉（v1.6 修复）
function Invoke-BackupRotation($name) {
    $f = Get-FileOf $name
    if (-not (Test-Path $f)) { return }
    $st = Get-FileState $name
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (($now - [long]$st.lastBackupAt) -lt $backupIntervalMs) { return }
    $st.lastBackupAt = $now
    $prefix = ($name -replace '\.json$', '') + '_'
    $tsRe = '^' + [regex]::Escape(($name -replace '\.json$', '')) + '_\d{8}_\d{6}\.json$'
    try {
        if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }
        Copy-Item -Path $f -Destination (Join-Path $backupDir ($prefix + (Get-TsTag) + '.json')) -Force
        $backs = @(Get-ChildItem -Path $backupDir -Filter '*.json' | Where-Object { $_.Name -match $tsRe } | Sort-Object Name)
        while ($backs.Count -gt $backupKeep) {
            try { Remove-Item -Path $backs[0].FullName -Force } catch { Write-Log ("Backup cleanup error: " + $_.Exception.Message) }
            $backs = $backs[1..($backs.Count - 1)]
        }
    } catch { Write-Log ("Backup rotation error: " + $_.Exception.Message) }
}

function Get-Hdr($req, $key) {
    if ($req.Headers.ContainsKey($key)) { return $req.Headers[$key] }
    return ''
}

# 鉴权：返回 @{ok;uid}；已发错误响应时 ok=false
# 被删除账户的 tombstone：会话是 HMAC 自证的、不查账户表，
# 不挡这一道就会出现「删了人还能继续用旧会话写他的库」
# 账户表带缓存读（热路径：每个鉴权请求都要查 tombstone，旧版每请求全表 read+parse）。
# 失效：mtime/大小变化 + 1 秒 TTL 兜底；写路径（Write-AuthObjWithRev / /api/db 账户表回写）主动作废。
$script:authCache = $null
function Read-AuthCached {
    if (-not (Test-Path -LiteralPath $authFile)) { $script:authCache = $null; return $null }
    $fi = New-Object System.IO.FileInfo $authFile
    $fi.Refresh()
    $now = Get-NowMs
    if ($script:authCache -and $script:authCache.mtime -eq $fi.LastWriteTimeUtc.Ticks -and $script:authCache.size -eq $fi.Length -and ($now - $script:authCache.at) -lt 1000) {
        return $script:authCache.obj
    }
    $obj = ConvertFrom-Json ([System.IO.File]::ReadAllText($authFile, $utf8NoBom))
    $script:authCache = @{ mtime = $fi.LastWriteTimeUtc.Ticks; size = $fi.Length; at = $now; obj = $obj }
    return $obj
}
function Test-DeletedUid([string]$uidVal) {
    try {
        $a = Read-AuthCached
        if (-not $a -or -not $a.PSObject.Properties['deleted']) { return $false }
        foreach ($d in @($a.deleted)) { if ($d -and [string]$d.uid -ceq [string]$uidVal) { return $true } }
        return $false
    } catch {
        # fail-closed（与 Node 版对等）：读不了 tombstone 时不能放行被删账户的残留会话
        return $true
    }
}
# 专用端点（改密 / 重置密码 / 删号）改账户表的统一落盘（与 Node 版 writeAuthObjWithRev 对等）。
# 关键：文件里的 meta.rev 必须和服务端记账一起推进。此前只 $st.rev + 1 而文件里的 rev 原地不动，
# 客户端 GET 到的 rev 就永远比记账小 1，整表回写必然 409、重试也永远追不上——
# 「管理员建号后成员列表刷不出新账户」就是这么来的（v1.10 修）。
# 写盘失败直接抛出，记账不动，由调用方决定回滚（删号那条要把留底改回原名）。
function Write-AuthObjWithRev($outMeta, $users, $extra) {
    $st = Get-FileState 'flowtask_auth.json'
    $nextRev = [int]$st.rev + 1
    $metaOut = @{}
    if ($outMeta -is [System.Collections.IDictionary]) {
        foreach ($k in $outMeta.Keys) { $metaOut[[string]$k] = $outMeta[$k] }
    } elseif ($outMeta) {
        foreach ($p in $outMeta.PSObject.Properties) { $metaOut[$p.Name] = $p.Value }
    }
    $metaOut['rev'] = $nextRev
    $pack = [ordered]@{ meta = $metaOut; users = $users }
    if ($extra -is [System.Collections.IDictionary]) {
        foreach ($k in $extra.Keys) { $pack[[string]$k] = $extra[$k] }
    }
    $body = $pack | ConvertTo-Json -Compress -Depth 40
    # 账户表是全系统最不能坏的文件：与 /api/db、Save-ConfigFile 同一套 tmp+move 原子替换。
    # 旧版直写最终路径，进程在写入中途被杀会截断账户表 → 全员无法登录
    $tmpAuth = $authFile + '.tmp'
    [System.IO.File]::WriteAllText($tmpAuth, $body, $utf8NoBom)
    if (Test-Path -LiteralPath $authFile -PathType Container) { throw 'auth destination is a directory' }
    Move-Item -LiteralPath $tmpAuth -Destination $authFile -Force
    $script:authCache = $null   # 刚写的表必须立刻可见
    $st.rev = $nextRev
    $st.hash = Get-Sha1Hex $body
    $script:syncPendingPush = 'flowtask_auth.json'      # 账户表变更同样要镜像到共享盘
    return $body
}
function Test-RequestAuth($req, $stream, $name) {
    if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) {
        Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }
        return @{ ok = $false }
    }
    if ($name -eq $legacyName) { return @{ ok = $true; uid = $null } }        # 兼容期
    if (Test-AuthFile $name) { return @{ ok = $true; uid = $null } }          # 注册/登录需要能读写账户表
    $sid = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
    if (-not $sid) {
        Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }
        return @{ ok = $false }
    }
    if (Test-DeletedUid $sid) {
        Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }
        return @{ ok = $false }
    }
    if ($name -ne ("flowtask_data_{0}.json" -f $sid) -and $name -ne 'flowtask_shared.json') {
        Send-Json $stream 403 @{ ok = $false; err = 'forbidden_file' }
        return @{ ok = $false }
    }
    return @{ ok = $true; uid = $sid }
}

function Test-UidKnown([string]$uid) {
    foreach ($f in @($authFile, (Get-FileOf $legacyName))) {
        if (-not (Test-Path $f)) { continue }
        try {
            $j = ConvertFrom-Json ([System.IO.File]::ReadAllText($f, $utf8NoBom))
            if ($j.users -and @($j.users | Where-Object { $_.id -eq $uid -and $_.active -ne $false }).Count -gt 0) { return $true }
        } catch { }
    }
    return $false
}

# ---------------- v1.6 会话可信（与 flowtask_server.js 对等） ----------------
# 登录流程：页面先拿 /api/auth-challenge（只含 uid/salt/算法，绝不含哈希），
# 本地算出密码证明（PBKDF2 结果），POST /api/session 由服务端与存量 passHash 比对后签发。
# 只凭自报 uid 就换会话的口子（v1.5 的缺陷）已封死。
function Test-SafeEqualStr($a, $b) {
    $ba = [System.Text.Encoding]::UTF8.GetBytes([string]$a)
    $bb = [System.Text.Encoding]::UTF8.GetBytes([string]$b)
    if ($ba.Length -ne $bb.Length -or $ba.Length -eq 0) { return $false }
    for ($i = 0; $i -lt $ba.Length; $i++) { if ($ba[$i] -ne $bb[$i]) { return $false } }
    return $true
}
function Get-StoredUserById([string]$uid) {
    foreach ($f in @($authFile, (Get-FileOf $legacyName))) {
        if (-not (Test-Path $f)) { continue }
        try {
            $j = ConvertFrom-Json ([System.IO.File]::ReadAllText($f, $utf8NoBom))
            # D-2：uid 查表改为大小写敏感（-ceq），与 Node（x.id === uidVal）对齐、更严格。
            # 注意：用户名查表（Get-StoredUserByUsername）仍用 -eq 大小写不敏感，那是 A3 的对齐实现，勿改。
            $u = @($j.users | Where-Object { $_.id -ceq $uid -and $_.active -ne $false })
            if ($u.Count -gt 0) { return $u[0] }
        } catch { }
    }
    return $null
}
function Get-StoredUserByUsername([string]$uname) {
    foreach ($f in @($authFile, (Get-FileOf $legacyName))) {
        if (-not (Test-Path $f)) { continue }
        try {
            $j = ConvertFrom-Json ([System.IO.File]::ReadAllText($f, $utf8NoBom))
            # A3：用户名按大小写不敏感匹配，与 Node 版（trim().toLowerCase() 归一化后比较）对齐
            $u = @($j.users | Where-Object { $_.username -eq $uname -and $_.active -ne $false })
            if ($u.Count -gt 0) { return $u[0] }
        } catch { }
    }
    return $null
}
# 账户表写入守卫 + 脱敏合并：返回 @{ code=0; body=补齐哈希后的落盘文本 } 或 @{ code;err }
function Protect-AuthWrite($obj, [string]$sid, $isAdminSess) {
    $oldUsers = @()
    $delIds = @{}
    $keptDel = @()          # tombstone 原文（落盘时只并集、不丢弃）
    if (Test-Path $authFile) {
        try {
            $j = ConvertFrom-Json ([System.IO.File]::ReadAllText($authFile, $utf8NoBom))
            $oldUsers = @($j.users)
            # tombstone：已经删过的人不允许借某张过期标签页的整表回写复活
            if ($j.PSObject.Properties['deleted']) {
                foreach ($d in @($j.deleted)) {
                    if ($d -and $d.uid -and -not $delIds.ContainsKey([string]$d.uid)) {
                        $delIds[[string]$d.uid] = $true; $keptDel += ,$d
                    }
                }
            }
        } catch {
            # fail-closed（与 Node 版对等）：文件存在却读不了（EBUSY/损坏）绝不能当成空表——
            # 那会让 bootstrap 放行一张过期快照整片洗掉真实账户表
            return @{ code = 500; err = '账户表暂时读不了，请稍后重试' }
        }
    }
    $incUsers = @($obj.users | Where-Object { $_ -and $_.id -and -not $delIds.ContainsKey([string]$_.id) })
    $oldById = @{}
    foreach ($u in $oldUsers) { if ($u -and $u.id) { $oldById[[string]$u.id] = $u } }
    $incIds = @{}
    foreach ($u in $incUsers) { if ($u -and $u.id) { $incIds[[string]$u.id] = $true } }
    # 整表回写不做删除（与 Node 版一致）：存量有、请求里没有 → 原样补回存量。
    # v1.10 曾把「少一行」判成 403，但账户表读取是脱敏的、每个页面手里都可能是过期快照，
    # 「少一行」绝大多数时候只是别人的新账户还没进我的表——那样正常的建号会永远失败。
    # 真要删人只能走 /api/delete-user（留底个人库 + 作废会话 + 写 tombstone）。
    foreach ($u in $oldUsers) {
        if ($u -and $u.id -and -not $incIds.ContainsKey([string]$u.id)) { $incUsers += ,$u }
    }
    $seenName = @{}
    foreach ($u in $oldUsers) { if ($u -and $u.username) { $seenName[[string]$u.username] = $true } }
    # tombstone 并集（与 Node 版一致）：页面手里那份是脱敏表，多半连 deleted 都没有，
    # 照原样落盘等于把「谁被删过」全忘了，下一张过期快照就能把人救回来。
    $seenDel = @{}
    foreach ($d in $keptDel) { if ($d -and $d.uid) { $seenDel[[string]$d.uid] = $true } }
    if ($obj.PSObject.Properties['deleted']) {
        foreach ($d in @($obj.deleted)) {
            if ($d -and $d.uid -and -not $seenDel.ContainsKey([string]$d.uid)) { $keptDel += ,$d; $seenDel[[string]$d.uid] = $true }
        }
    }
    $merged = @()
    foreach ($u in $incUsers) {
        if (-not $u -or -not $u.id) { continue }
        $h = @{}
        foreach ($p in $u.PSObject.Properties) { $h[$p.Name] = $p.Value }
        $prev = $oldById[[string]$u.id]
        if (-not $prev) {
            # 新账户 id 必须匹配个人库文件名白名单（与 Node 版对等，v1.10 统一口径）
            if ([string]$u.id -cnotmatch '^[a-z0-9_\-]{1,64}$') { return @{ code = 400; err = '账户 id 格式不合法' } }
            $nm = ''
            if ($h.ContainsKey('username')) { $nm = ([string]$h['username']) }
            if ($nm -and $seenName.ContainsKey($nm)) { return @{ code = 400; err = ('用户名已被使用：' + $nm) } }
            $role = ''
            if ($h.ContainsKey('role')) { $role = [string]$h['role'] }
            $anyActive = @($oldUsers | Where-Object { $_ -and $_.active -ne $false }).Count -gt 0
            if ($role -eq 'admin' -and -not $isAdminSess -and $anyActive) {
                return @{ code = 403; err = '只有管理员可以创建管理员账户' }
            }
            # 账号由管理员开通：没有 admin 会话就不能往账户表里塞新人（与 Node 版对等）。
            # 两个豁免：① 表里还没有任何活跃账户（首启 bootstrap）；② 配置 openRegistration:true
            if (-not $isAdminSess -and -not (Open-RegistrationAllowed) -and -not $anyActive) {
                # bootstrap：第一个账户允许匿名建，否则没人能进来开号
            } elseif (-not $isAdminSess -and -not (Open-RegistrationAllowed)) {
                return @{ code = 403; err = '账号需由管理员创建（如需开放自助注册，请在数据管理里改设置）' }
            }
        } else {
            # 合并语义（与 Node 版对等）：请求里缺的字段 = 保持原值，不算变更
            $self = ($sid -eq [string]$u.id -and $sid)
            $eff = @{}
            foreach ($p in $prev.PSObject.Properties) { $eff[$p.Name] = $p.Value }
            foreach ($k in @($h.Keys)) { if ($null -ne $h[$k]) { $eff[$k] = $h[$k] } }
            $prevName = ''; if ($prev.PSObject.Properties['username']) { $prevName = [string]$prev.username }
            $effName = ''; if ($eff.ContainsKey('username')) { $effName = [string]$eff['username'] }
            if ($prevName -cne $effName -and -not $isAdminSess) { return @{ code = 403; err = '只有管理员可以修改账户用户名' } }
            $prevRole = ''; if ($prev.PSObject.Properties['role']) { $prevRole = [string]$prev.role }
            $effRole = ''; if ($eff.ContainsKey('role')) { $effRole = [string]$eff['role'] }
            if ($prevRole -cne $effRole -and -not $isAdminSess) { return @{ code = 403; err = '只有管理员可以修改账户角色' } }
            $prevActive = ($prev.active -ne $false)
            $effActive = (-not $eff['active'] -eq $false)
            if ($prevActive -ne $effActive -and -not $isAdminSess -and -not $self) { return @{ code = 403; err = '只有管理员可以停用/恢复账户' } }
            $prevHash = ''; if ($prev.PSObject.Properties['passHash']) { $prevHash = [string]$prev.passHash }
            $effHash = ''; if ($eff.ContainsKey('passHash')) { $effHash = [string]$eff['passHash'] }
            $prevSalt = ''; if ($prev.PSObject.Properties['salt']) { $prevSalt = [string]$prev.salt }
            $effSalt = ''; if ($eff.ContainsKey('salt')) { $effSalt = [string]$eff['salt'] }
            if ((($prevHash -cne $effHash) -or ($prevSalt -cne $effSalt)) -and -not $isAdminSess -and -not $self) {
                return @{ code = 403; err = '只有本人或管理员可以修改密码' }
            }
            if (($prevHash -cne $effHash) -and -not $isAdminSess -and ($effHash -cnotmatch '^p1\$[0-9a-f]{64}$')) {
                return @{ code = 400; err = '密码哈希格式不合法' }
            }
            # 把合并后的完整字段写回 $h：落盘内容 = 补齐了 salt/passHash 的版本
            foreach ($k in @($eff.Keys)) { $h[$k] = $eff[$k] }
        }
        # 脱敏透明补齐：页面写回的账户缺 salt/passHash 时沿用存量值，绝不落成空哈希
        if ($prev) {
            if (-not $h.ContainsKey('passHash') -or [string]$h['passHash'] -eq '') {
                if ($prev.PSObject.Properties['passHash']) { $h['passHash'] = $prev.passHash } else { $h['passHash'] = '' }
            }
            if (-not $h.ContainsKey('salt') -or [string]$h['salt'] -eq '') {
                if ($prev.PSObject.Properties['salt']) { $h['salt'] = $prev.salt } else { $h['salt'] = '' }
            }
        }
        $merged += ,$h
    }
    $metaObj = $null
    if ($obj.PSObject.Properties['meta']) { $metaObj = $obj.meta }
    $out = @{ users = $merged }
    if ($metaObj) { $out['meta'] = $metaObj }
    $out['deleted'] = @($keptDel)        # 空表也写成 []：哈希表里的空数组不会被 ConvertTo-Json 退化成 null
    $body = $out | ConvertTo-Json -Compress -Depth 40
    return @{ code = 0; body = $body }
}

function Handle-Request($client) {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 5000
    $req = Read-HttpRequest $stream
    if ($null -eq $req) { try { $client.Close() } catch {}; return }

    $method = $req.Method
    $path = Get-PathOnly $req.Path
    $script:reqHeaders = $req.Headers
    Write-Log ("$method $($req.Path)")

    # A4：body 上限对所有 POST 生效（Node 在 readBody 里统一检查；此前 PS1 只在 /api/db 查一处）
    # D-3：超限状态码与 Node 对齐为 413（此前 PS1 回 400）
    if ($method -eq 'POST' -and $req.Body.Length -gt $bodyLimit) {
        Send-Json $stream 413 @{ ok = $false; err = 'too large' }
        try { $client.Close() } catch {}
        return
    }

    if ($method -eq 'OPTIONS') {
        Send-Response $stream 204 '' 'text/plain; charset=utf-8' @{
            'Access-Control-Allow-Methods' = 'GET, POST, DELETE, OPTIONS'
            'Access-Control-Allow-Headers' = 'Content-Type, X-FlowTask-Token, X-FlowTask-Rev, X-FlowTask-Session'
            'Access-Control-Max-Age' = '600'
        }
        try { $client.Close() } catch {}
        return
    }

    # ---- 探活（免鉴权，供启动脚本判断服务就绪） ----
    if ($method -eq 'GET' -and $path -eq '/api/ping') {
        # openRegistration 随免鉴权的 ping 下发：登录页要在登录前就知道该不该露注册入口。
        # 真正的约束在 Protect-AuthWrite，这里只是少露一个必然失败的入口
        Send-Json $stream 200 @{ ok = $true; app = 'FlowTask'; version = $script:VERSION; ready = $true
                                 ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); openRegistration = (Open-RegistrationAllowed) }
        try { $client.Close() } catch {}
        return
    }

    # ---- 令牌发放（仅可信来源） ----
    if ($method -eq 'GET' -and $path -eq '/api/token') {
        if (Get-Acao $req.Headers) {
            Send-Json $stream 200 @{ ok = $true; token = $script:TOKEN; version = $script:VERSION }
        } else {
            Send-Response $stream 403 'forbidden'
        }
        try { $client.Close() } catch {}
        return
    }

    # ---- 登录挑战 / 会话签发 / 校验 / 改密码（v1.6，与 Node 版对等） ----
    if ($method -eq 'GET' -and $path -eq '/api/auth-challenge') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        # 同源 GET 请求浏览器不携带 Origin 头：只在「带了 Origin 且不可信」时拒绝
        if ($req.Headers.ContainsKey('origin') -and -not (Get-Acao $req.Headers)) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden origin' }; try { $client.Close() } catch {}; return }
        $uname = ''
        # A3：与 Node 版一致，用户名先 trim + 转小写归一化再比较（此前只 Trim，大小写不同就登不上）
        try { $uname = ([string](Get-QueryParam $req.Path 'username')).Trim().ToLower() } catch { }
        $u = Get-StoredUserByUsername $uname
        if (-not $u -and $script:syncEnabled) {
            # 本机找不到这个账户：很可能是管理员刚在别处建的。先补拉账户表再认一次，
            # 否则新机器 / 一直开着的机器都要重启才能登录（而 /api/sync 需要会话，成了死循环）
            try { [void](Update-AuthFromShare) }
            catch { Write-Log ('登录前补拉账户表失败：' + $_.Exception.Message) }
            $u = Get-StoredUserByUsername $uname
        }
        if (-not $u) { Send-Json $stream 404 @{ ok = $false; err = 'unknown user' }; try { $client.Close() } catch {}; return }
        $algo = 'legacy'
        if ($u.PSObject.Properties['passHash'] -and ([string]$u.passHash).StartsWith('p1$')) { $algo = 'p1' }
        Send-Json $stream 200 @{ ok = $true; uid = [string]$u.id; salt = [string]$u.salt; algo = $algo }
        try { $client.Close() } catch {}
        return
    }
    if ($method -eq 'POST' -and $path -eq '/api/session') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $uid = ''; $verifier = ''
        try {
            $o = ConvertFrom-Json $req.Body
            $uid = [string]$o.uid
            if ($o.PSObject.Properties['verifier']) { $verifier = [string]$o.verifier }
        } catch { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        # v1.10：与 Node 版同步收紧为大小写敏感（账户 id 一律小写，写入侧已校验格式）
        if ($uid -cnotmatch '^[a-z0-9_\-]{1,64}$') { Send-Json $stream 400 @{ ok = $false; err = 'bad uid' }; try { $client.Close() } catch {}; return }
        if (-not $verifier) { Send-Json $stream 400 @{ ok = $false; err = 'verifier required' }; try { $client.Close() } catch {}; return }
        # 登录失败限速（与 Node 版对等）：按 uid+来源 IP，5 次起指数退避封顶 60s，成功清零
        $tKey = $uid + '|' + [string]$client.Client.RemoteEndPoint.Address
        $waitMs = Get-LoginThrottleMs $tKey
        if ($waitMs -gt 0) { Send-Json $stream 429 @{ ok = $false; err = 'too many failed attempts'; retryAfterMs = $waitMs }; try { $client.Close() } catch {}; return }
        $u = Get-StoredUserById $uid
        if (-not $u) { Add-LoginFailNote $tKey; Send-Json $stream 404 @{ ok = $false; err = 'unknown uid' }; try { $client.Close() } catch {}; return }
        $storedHash = ''
        if ($u.PSObject.Properties['passHash']) { $storedHash = [string]$u.passHash }
        if (-not (Test-SafeEqualStr $storedHash $verifier)) { Add-LoginFailNote $tKey; Send-Json $stream 401 @{ ok = $false; err = 'bad credentials' }; try { $client.Close() } catch {}; return }
        Clear-LoginFailNote $tKey
        $s = New-Session $uid
        # 本地优先：先把这个人的数据从共享盘拉回来（拉不到就照常放行，不卡登录）
        try { Invoke-LoginSync $uid }
        catch { Write-Log ('⚠ 登录同步异常（已忽略，不影响登录）：' + $_.Exception.Message) }
        Send-Json $stream 200 @{ ok = $true; session = $s.session; exp = $s.exp; ttlDays = ($sessionTtlMs / 86400000) }
        try { $client.Close() } catch {}
        return
    }
    if ($method -eq 'POST' -and $path -eq '/api/changepw') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $sid = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if (-not $sid) { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }; try { $client.Close() } catch {}; return }
        $oldVerifier = ''; $newSalt = ''; $newHash = ''
        try {
            $o = ConvertFrom-Json $req.Body
            if ($o.PSObject.Properties['oldVerifier']) { $oldVerifier = [string]$o.oldVerifier }
            if ($o.PSObject.Properties['newSalt']) { $newSalt = [string]$o.newSalt }
            if ($o.PSObject.Properties['newHash']) { $newHash = [string]$o.newHash }
        } catch { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        if (-not $oldVerifier -or -not $newSalt -or ($newHash -cnotmatch '^p1\$[0-9a-f]{64}$')) {
            Send-Json $stream 400 @{ ok = $false; err = 'invalid payload' }; try { $client.Close() } catch {}; return
        }
        if (-not (Test-Path $authFile)) { Send-Json $stream 500 @{ ok = $false; err = 'auth file unreadable' }; try { $client.Close() } catch {}; return }
        try {
            $auth = ConvertFrom-Json ([System.IO.File]::ReadAllText($authFile, $utf8NoBom))
            $target = $null
            foreach ($u in @($auth.users)) { if ($u -and $u.id -eq $sid) { $target = $u; break } }
            if (-not $target) { Send-Json $stream 404 @{ ok = $false; err = 'unknown uid' }; try { $client.Close() } catch {}; return }
            $storedHash = ''
            if ($target.PSObject.Properties['passHash']) { $storedHash = [string]$target.passHash }
            if (-not (Test-SafeEqualStr $storedHash $oldVerifier)) { Send-Json $stream 401 @{ ok = $false; err = 'bad credentials' }; try { $client.Close() } catch {}; return }
            # PSCustomObject 不能直接改字段值以外的结构，这里整表重建
            $users = @()
            foreach ($u in @($auth.users)) {
                if ($u -and $u.id -eq $sid) {
                    $h = @{}
                    foreach ($p in $u.PSObject.Properties) { $h[$p.Name] = $p.Value }
                    $h['salt'] = $newSalt; $h['passHash'] = $newHash
                    $h['pwMustChange'] = $false      # 本人改过密，首登改密提示就该消失
                    $users += ,$h
                } else {
                    $h2 = @{}
                    foreach ($p in $u.PSObject.Properties) { $h2[$p.Name] = $p.Value }
                    $users += ,$h2
                }
            }
            [void](Write-AuthObjWithRev $auth.meta $users $null)
            Send-Json $stream 200 @{ ok = $true }
        } catch {
            Write-Log ("changepw error: " + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'save failed' }
        }
        try { $client.Close() } catch {}
        return
    }
    # ---- 管理员重置他人密码（仅管理员会话）：忘密/交接/初始口令没送出去都得有路可走 ----
    if ($method -eq 'POST' -and $path -eq '/api/resetpw') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $sidR = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if (-not $sidR) { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }; try { $client.Close() } catch {}; return }
        $meR = Get-StoredUserById $sidR
        if (-not $meR -or [string]$meR.role -ne 'admin') {
            Send-Json $stream 403 @{ ok = $false; err = '只有管理员可以重置他人密码' }; try { $client.Close() } catch {}; return
        }
        $ruid = ''; $rSalt = ''; $rHash = ''
        try {
            $o = ConvertFrom-Json $req.Body
            $ruid = [string]$o.uid
            if ($o.PSObject.Properties['newSalt']) { $rSalt = [string]$o.newSalt }
            if ($o.PSObject.Properties['newHash']) { $rHash = [string]$o.newHash }
        } catch { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        if ($ruid -cnotmatch '^[a-z0-9_\-]{1,64}$') { Send-Json $stream 400 @{ ok = $false; err = 'bad uid' }; try { $client.Close() } catch {}; return }
        if (-not $rSalt -or ($rHash -cnotmatch '^p1\$[0-9a-f]{64}$')) {
            Send-Json $stream 400 @{ ok = $false; err = 'invalid payload' }; try { $client.Close() } catch {}; return
        }
        if (-not (Test-Path -LiteralPath $authFile)) { Send-Json $stream 500 @{ ok = $false; err = 'auth file unreadable' }; try { $client.Close() } catch {}; return }
        try {
            $auth = ConvertFrom-Json ([System.IO.File]::ReadAllText($authFile, $utf8NoBom))
            $hit = $false
            $users = @()
            foreach ($u in @($auth.users)) {
                $h = @{}
                if ($u) { foreach ($p in $u.PSObject.Properties) { $h[$p.Name] = $p.Value } }
                if ($u -and [string]$u.id -eq $ruid) {
                    $h['salt'] = $rSalt; $h['passHash'] = $rHash; $h['pwMustChange'] = $true
                    $hit = $true
                }
                $users += ,$h
            }
            if (-not $hit) { Send-Json $stream 404 @{ ok = $false; err = 'unknown uid' }; try { $client.Close() } catch {}; return }
            [void](Write-AuthObjWithRev $auth.meta $users $null)
            Write-Log ('管理员 ' + $sidR + ' 重置了 ' + $ruid + ' 的密码（下次登录须改密）')
            Send-Json $stream 200 @{ ok = $true; uid = $ruid; pwMustChange = $true }
        } catch {
            Write-Log ('resetpw error: ' + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'save failed' }
        }
        try { $client.Close() } catch {}
        return
    }
    # ---- 删除账户（仅管理员；不可逆，故强制留底）----
    # 三道硬约束与 Node 版一致：① 个人库改名留底不 unlink；② 写 tombstone 让旧会话立刻失效；
    # ③ 只走专用端点，删人的动作绝不放进「整表回写」里（过期标签页会误删）
    if ($method -eq 'POST' -and $path -eq '/api/delete-user') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $sidD = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if (-not $sidD) { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }; try { $client.Close() } catch {}; return }
        $meD = Get-StoredUserById $sidD
        if (-not $meD -or [string]$meD.role -ne 'admin') {
            Send-Json $stream 403 @{ ok = $false; err = '只有管理员可以删除账户' }; try { $client.Close() } catch {}; return
        }
        $tgt = ''
        try { $o = ConvertFrom-Json $req.Body; $tgt = [string]$o.uid } catch { $tgt = '' }
        if ($tgt -cnotmatch '^[a-z0-9_\-]{1,64}$') { Send-Json $stream 400 @{ ok = $false; err = 'bad uid' }; try { $client.Close() } catch {}; return }
        if ($tgt -eq [string]$sidD) {
            Send-Json $stream 400 @{ ok = $false; err = '不能删除自己当前登录的账户，请改用退出登录' }; try { $client.Close() } catch {}; return
        }
        $auth = $null
        try { $auth = ConvertFrom-Json ([System.IO.File]::ReadAllText($authFile, $utf8NoBom)) } catch { $auth = $null }
        if (-not $auth) { Send-Json $stream 500 @{ ok = $false; err = 'auth file unreadable' }; try { $client.Close() } catch {}; return }
        $users = @($auth.users | Where-Object { $_ })
        $victim = $users | Where-Object { [string]$_.id -eq $tgt }
        if (-not $victim) { Send-Json $stream 404 @{ ok = $false; err = 'unknown uid' }; try { $client.Close() } catch {}; return }
        # 删掉最后一个管理员 = 全组失去开号与重置密码的入口，必须挡住
        $otherAdmins = @($users | Where-Object { [string]$_.id -ne $tgt -and $_.role -eq 'admin' -and $_.active -ne $false }).Count
        if ($victim.role -eq 'admin' -and $otherAdmins -eq 0) {
            Send-Json $stream 400 @{ ok = $false; err = '这是最后一个管理员：请先指定其他管理员再删除' }; try { $client.Close() } catch {}; return
        }
        # 留底：个人库改名保存，绝不当场删；改名失败就让本次删除整体失败，不留「人没了数据也没了」
        $preserved = ''
        $pf = Get-FileOf ("flowtask_data_{0}.json" -f $tgt)
        if (Test-Path -LiteralPath $pf) {
            $preserved = "deleted_flowtask_data_$($tgt)_$(Get-TsTag).json"
            try { Move-Item -LiteralPath $pf -Destination (Join-Path $DataDir $preserved) -ErrorAction Stop }
            catch {
                Write-Log ('删除账户前留底失败：' + $_.Exception.Message)
                Send-Json $stream 500 @{ ok = $false; err = 'backup failed' }; try { $client.Close() } catch {}; return
            }
        }
        try {
            $kept = @($users | Where-Object { [string]$_.id -ne $tgt })
            $del = @($auth.deleted | Where-Object { $_ })
            $del += [pscustomobject]@{ uid = $tgt; username = [string]$victim.username; name = [string]$victim.name;
                                       at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); by = [string]$sidD }
            $out = [ordered]@{ deleted = $del }
            [void](Write-AuthObjWithRev $auth.meta $kept $out)
            Write-Log ('管理员 ' + $sidD + ' 删除了账户 ' + $tgt + $(if ($preserved) { '（个人库已留底为 ' + $preserved + '）' } else { '' }))
            Send-Json $stream 200 @{ ok = $true; uid = $tgt; preserved = $preserved }
        } catch {
            # 账户表没写成：把留底改回原名，避免出现「人还在、数据不见了」
            if ($preserved) {
                try { Move-Item -LiteralPath (Join-Path $DataDir $preserved) -Destination $pf -Force -ErrorAction SilentlyContinue } catch { }
            }
            Write-Log ('delete-user 失败：' + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'save failed' }
        }
        try { $client.Close() } catch {}
        return
    }

    if ($method -eq 'GET' -and $path -eq '/api/session') {
        $sid = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if ($sid) { Send-Json $stream 200 @{ ok = $true; uid = $sid } } else { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' } }
        try { $client.Close() } catch {}
        return
    }

    # ---- 共享盘同步：状态查询与手动「立即同步」（未配置时返回 enabled:false） ----
    # ---- 同步配置读写（仅管理员）：界面里就能改同步文件夹，校验不过就退回原路径 ----
    if ($path -eq '/api/sync/config') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $sidC = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if (-not $sidC) { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }; try { $client.Close() } catch {}; return }
        $su = Get-StoredUserById $sidC
        if (-not $su -or [string]$su.role -ne 'admin') {
            Send-Json $stream 403 @{ ok = $false; err = '只有管理员可以修改同步设置' }; try { $client.Close() } catch {}; return
        }
        if ($method -eq 'GET') {
            Send-Json $stream 200 @{ ok = $true; config = Get-PublicConfig; status = Get-SyncStatus }
            try { $client.Close() } catch {}; return
        }
        if ($method -ne 'POST') {
            Send-Json $stream 405 @{ ok = $false; err = 'method not allowed' }
            try { $client.Close() } catch {}; return
        }
        $o = $null
        try { $o = ConvertFrom-Json $req.Body } catch { $o = $null }
        if (-not $o) { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        $prevDir = $script:ShareDir; $prevOn = $script:syncEnabled
        # 关同步时运行时会把路径清空但配置文件留着；只传 syncEnabled:true 要能从配置补回，否则用户得重敲长 UNC 路径
        $savedDir = $(if ($script:cfg.Contains('shareDir')) { ("" + $script:cfg['shareDir']).Trim() } else { '' })
        $nextDir = $(if ($o.PSObject.Properties['shareDir']) { ("" + $o.shareDir).Trim() } else { $(if ($prevDir) { $prevDir } else { $savedDir }) })
        $nextOn  = $(if ($o.PSObject.Properties['syncEnabled']) { (($o.syncEnabled -ne $false) -and [bool]$nextDir) } else { ([bool]$nextDir -and ($o.syncEnabled -ne $false)) })
        $applied = Set-ShareConfig $nextDir $nextOn
        # validateOnly：只做一次无副作用探测（随后一律退回原设置、绝不落盘），
        # 让界面能「先告诉用户路径行不行，再让他确认切换」，而不是确认完才报错
        if ($o.PSObject.Properties['validateOnly'] -and ($o.validateOnly -eq $true)) {
            $why = $(if (-not $applied.enabled) { $(if ($nextDir) { '同步已关闭' } else { '' }) } else { $applied.blockReason })
            [void](Set-ShareConfig $prevDir $prevOn)
            if ($why) { Send-Json $stream 400 @{ ok = $false; err = 'share unusable'; reason = $why } }
            else { Send-Json $stream 200 @{ ok = $true; valid = $true; shareDir = $nextDir } }
            try { $client.Close() } catch {}; return
        }
        if ($applied.enabled -and $applied.blockReason -and ($o.force -ne $true)) {
            [void](Set-ShareConfig $prevDir $prevOn)              # 退回原值，且不落盘
            Send-Json $stream 400 @{ ok = $false; err = 'share unusable'; reason = $applied.blockReason; config = Get-PublicConfig }
            try { $client.Close() } catch {}; return
        }
        try {
            [void](Save-ConfigFile @{ shareDir = $nextDir; syncEnabled = $script:syncEnabled })
        } catch {
            [void](Set-ShareConfig $prevDir $prevOn)
            Write-Log ('同步配置写入失败：' + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'config write failed' }
            try { $client.Close() } catch {}; return
        }
        # 立刻双向同步一次：新位置马上有本机数据，新位置已有的更新也拿回来
        $res = @()
        try { $res = (Invoke-ManualSync 'auto' $sidC).results } catch { Write-Log ('切换后首次同步异常：' + $_.Exception.Message) }
        Write-Log ('同步设置已更新：' + $(if ($script:syncEnabled) { $script:ShareDir } else { '已停用' }) + '（操作者 ' + $sidC + '）')
        Send-Json $stream 200 @{ ok = $true; config = Get-PublicConfig; status = Get-SyncStatus; results = $res }
        try { $client.Close() } catch {}; return
    }

    if ($path -eq '/api/sync') {
        if ((Get-Hdr $req 'x-flowtask-token') -ne $script:TOKEN) { Send-Json $stream 403 @{ ok = $false; err = 'forbidden' }; try { $client.Close() } catch {}; return }
        $sid = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
        if (-not $sid) { Send-Json $stream 401 @{ ok = $false; err = 'unauthorized' }; try { $client.Close() } catch {}; return }
        if ($method -eq 'GET') {
            Send-Json $stream 200 @{ ok = $true; enabled = [bool]$script:syncEnabled; status = Get-SyncStatus }
        } elseif ($method -eq 'POST') {
            $mode = 'auto'
            try {
                $o = ConvertFrom-Json $req.Body
                if ($o -and $o.PSObject.Properties['mode']) {
                    if ([string]$o.mode -eq 'pull') { $mode = 'pull' } elseif ([string]$o.mode -eq 'push') { $mode = 'push' }
                }
            } catch { }
            $out = Invoke-ManualSync $mode $sid
            # 拉取可能改写了本地文件 → 告诉页面「本机这份变了」，页面据此重读
            $changed = @(); foreach ($r in $out.results) { if ($r.action -eq 'pull') { $changed += $r.name } }
            Send-Json $stream 200 @{ ok = $true; enabled = [bool]$script:syncEnabled; mode = $mode; changedLocal = $changed; results = $out.results; status = Get-SyncStatus }
        } else {
            Send-Json $stream 405 @{ ok = $false; err = 'method not allowed' }
        }
        try { $client.Close() } catch {}
        return
    }

    # ---- 解析并校验目标文件名 ----
    $name = Get-QueryParam $req.Path 'file'
    if ([string]::IsNullOrEmpty($name)) { $name = $legacyName }
    if ($name -cne $legacyName -and ($name -cnotmatch $filePattern)) {
        Send-Json $stream 400 @{ ok = $false; err = 'bad file' }
        try { $client.Close() } catch {}
        return
    }

    if ($method -eq 'GET' -and $path -eq '/api/version') {
        Send-Json $stream 200 @{ ok = $true; rev = (Get-FileState $name).rev; file = $name }
        try { $client.Close() } catch {}
        return
    }

    # ---- 数据读取（损坏自动隔离） ----
    # v1.6：只有 ENOENT 才等于「文件不存在/空库」；被占用、无权限等读取错误回 500——
    # 谎报 204 会让客户端把「读不到」当成「没有数据」，界面凭空变空甚至触发迁移/演示注入
    if ($method -eq 'GET' -and $path -eq '/api/db') {
        $a = Test-RequestAuth $req $stream $name
        if (-not $a.ok) { try { $client.Close() } catch {}; return }
        $f = Get-FileOf $name
        if (-not (Test-Path $f)) {
            Send-Response $stream 204 ''
            try { $client.Close() } catch {}
            return
        }
        $raw = ''
        try {
            $raw = [System.IO.File]::ReadAllText($f, $utf8NoBom)
        } catch {
            Write-Log ("Read error: $name → " + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'read failed'; detail = 'read error'; file = $name }
            try { $client.Close() } catch {}
            return
        }
        $okShape = $false
        try { $okShape = Test-ValidShape $name (ConvertFrom-Json $raw) } catch { $okShape = $false }
        if ($okShape) {
            if (Test-AuthFile $name) {
                # 账户表读取脱敏：盐与密码哈希不再下发给任何页面。
                # fail-closed：脱敏一旦失败绝不能把含 salt/passHash 的原文发出去
                try {
                    $j = ConvertFrom-Json $raw
                    $users = @()
                    foreach ($u in @($j.users)) {
                        $h = @{}
                        if ($u) { foreach ($p in $u.PSObject.Properties) { if ($p.Name -ne 'passHash' -and $p.Name -ne 'salt') { $h[$p.Name] = $p.Value } } }
                        $users += ,$h
                    }
                    $out = @{ meta = $j.meta; users = $users }
                    $raw = $out | ConvertTo-Json -Compress -Depth 40
                } catch {
                    Write-Log ("auth sanitize failed: " + $_.Exception.Message)
                    Send-Json $stream 500 @{ ok = $false; err = 'read failed'; detail = 'sanitize error'; file = $name }
                    try { $client.Close() } catch {}
                    return
                }
            }
            Send-Response $stream 200 ([System.Text.Encoding]::UTF8.GetBytes($raw)) 'application/json; charset=utf-8' @{ 'Cache-Control' = 'no-store' }
            try { $client.Close() } catch {}
            return
        }
        $q = Join-Path $DataDir (($name -replace '\.json$', '') + '_corrupt_' + (Get-TsTag) + '.json')
        $script:fileState.Remove($name)
        try {
            Move-Item -Path $f -Destination $q -Force
            Write-Log ("$name 损坏，已自动隔离为 " + (Split-Path $q -Leaf))
            Send-Response $stream 204 '' 'text/plain; charset=utf-8' @{ 'X-FlowTask-Quarantined' = (Split-Path $q -Leaf) }
        } catch {
            # 隔离失败时绝不能谎报「文件不存在」：那份损坏文件是唯一可人工抢救的副本
            Write-Log ("Quarantine error: " + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'quarantine failed'; detail = 'rename error'; file = $name }
        }
        try { $client.Close() } catch {}
        return
    }

    # ---- 冲突副本保存 ----
    if ($method -eq 'POST' -and $path -eq '/api/db-conflict') {
        $a = Test-RequestAuth $req $stream $name
        if (-not $a.ok) { try { $client.Close() } catch {}; return }
        $obj = $null
        try { $obj = ConvertFrom-Json $req.Body } catch { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        # D-1：与 Node /api/db-conflict 对齐——补形状校验（与 /api/db 用同一处 Test-ValidShape），非法回 400
        if (-not (Test-ValidShape $name $obj)) { Send-Json $stream 400 @{ ok = $false; err = 'invalid shape' }; try { $client.Close() } catch {}; return }
        $f = Join-Path $DataDir (($name -replace '\.json$', '') + '_conflict_' + (Get-TsTag) + '.json')
        # P0-2：写盘失败必须回 500，不能无视异常照回 200「已留底」
        try {
            [System.IO.File]::WriteAllText($f, $req.Body, $utf8NoBom)
        } catch {
            Write-Log ("Conflict save error: " + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = 'save failed' }
            try { $client.Close() } catch {}
            return
        }
        Send-Json $stream 200 @{ ok = $true; file = (Split-Path $f -Leaf) }
        try { $client.Close() } catch {}
        return
    }

    # ---- 数据保存（鉴权 + 版本校验 + 幂等 + 备份轮转 + 原子替换） ----
    if ($method -eq 'POST' -and $path -eq '/api/db') {
        $a = Test-RequestAuth $req $stream $name
        if (-not $a.ok) { try { $client.Close() } catch {}; return }
        # D-3：超限状态码与 Node 对齐为 413（此前 PS1 回 400）
        if ($req.Body.Length -gt $bodyLimit) { Send-Json $stream 413 @{ ok = $false; err = 'too large' }; try { $client.Close() } catch {}; return }

        $obj = $null
        try { $obj = ConvertFrom-Json $req.Body } catch { Send-Json $stream 400 @{ ok = $false; err = 'invalid json' }; try { $client.Close() } catch {}; return }
        if (-not (Test-ValidShape $name $obj)) { Send-Json $stream 400 @{ ok = $false; err = 'invalid shape' }; try { $client.Close() } catch {}; return }

        $st = Get-FileState $name
        # TryParse：非数字的 rev 头按 0 处理（与 Node 的 Number(...)||0 对等），
        # 旧版 [int] 强转在 ErrorActionPreference=Stop 下会抛异常打崩本次请求
        $incRev = 0
        if ($req.Headers.ContainsKey('x-flowtask-rev')) { [void][int]::TryParse([string]$req.Headers['x-flowtask-rev'], [ref]$incRev) }
        elseif ($obj.meta -and $obj.meta.rev) { [void][int]::TryParse([string]$obj.meta.rev, [ref]$incRev) }

        # 账户表写入守卫 + 脱敏透明补齐（v1.6，与 Node 版对等）；
        # 守卫可能给缺哈希的账户补回存量 passHash，落盘内容以补齐后的文本为准
        $bodyToStore = $req.Body
        if (Test-AuthFile $name) {
            $sid = Get-SessionUid (Get-Hdr $req 'x-flowtask-session')
            $isAdminSess = $false
            if ($sid) { $au = Get-StoredUserById $sid; if ($au -and $au.role -eq 'admin') { $isAdminSess = $true } }
            $g = Protect-AuthWrite $obj $sid $isAdminSess
            if ($g.code -ne 0) {
                Send-Json $stream $g.code @{ ok = $false; err = $g.err }
                try { $client.Close() } catch {}
                return
            }
            $bodyToStore = $g.body
        }
        $incHash = Get-Sha1Hex $bodyToStore

        # 同版本或更旧：内容一致 = 重复提交（幂等成功）；内容不同才是真冲突
        if ($incRev -gt 0 -and $st.rev -gt 0 -and $incRev -le $st.rev) {
            if ($incHash -eq $st.hash) {
                Send-Json $stream 200 @{ ok = $true; rev = $st.rev; noop = $true; file = $name }
            } else {
                Send-Json $stream 409 @{ ok = $false; err = 'conflict'; rev = $st.rev; file = $name }
            }
            try { $client.Close() } catch {}
            return
        }

        # 版本/指纹在写盘前同步推进：并发写会立刻看到新版本而被判 409/幂等；写失败则回滚
        $prevRev = [int]$st.rev; $prevHash = [string]$st.hash
        $st.rev = if ($incRev -gt 0) { $incRev } else { $prevRev }
        $st.hash = $incHash
        Invoke-BackupRotation $name
        $f = Get-FileOf $name
        $tmp = $f + '.tmp'
        try {
            # Move-Item 对「目标是目录」会把文件移进目录里而不是报错——必须显式拦截，
            # 否则写盘失败会被误报成 200「已保存」（与 Node 版行为对齐）
            if (Test-Path -LiteralPath $f -PathType Container) { throw 'destination is a directory' }
            [System.IO.File]::WriteAllText($tmp, $bodyToStore, $utf8NoBom)
            Move-Item -Path $tmp -Destination $f -Force
            if ($name -ceq 'flowtask_auth.json') { $script:authCache = $null }   # 账户表缓存随写作废
            Send-Json $stream 200 @{ ok = $true; rev = $st.rev; file = $name }
            $script:syncPendingPush = $name
        } catch {
            $st.rev = $prevRev; $st.hash = $prevHash
            Write-Log ("Save error: " + $_.Exception.Message)
            Send-Json $stream 500 @{ ok = $false; err = ('save failed: ' + $_.Exception.Message) }
        }
        try { $client.Close() } catch {}
        return
    }

    # ---- 页面托管（注入令牌） ----
    if ($method -eq 'GET' -and ($path -eq '/' -or $path -eq '/index.html')) {
        if (Test-Path $htmlFile) {
            $html = [System.IO.File]::ReadAllText($htmlFile, $utf8NoBom)
            $html = $html -replace '__FLOWTASK_TOKEN__', $script:TOKEN
            Send-Response $stream 200 ([System.Text.Encoding]::UTF8.GetBytes($html)) 'text/html; charset=utf-8' @{ 'Cache-Control' = 'no-store' }
        } else {
            Send-Response $stream 500 '未找到 FlowTask_本地项目管理平台.html，请与本文件放在同一目录'
        }
        try { $client.Close() } catch {}
        return
    }

    Send-Response $stream 404 'not found'
    try { $client.Close() } catch {}
}

# 绑定监听
$endpoint = [System.Net.IPEndPoint]::new([System.Net.IPAddress]::Parse($HostIP), $Port)
$listener = [System.Net.Sockets.TcpListener]::new($endpoint)
try {
    $listener.Start()
} catch {
    Write-Log ("Failed to bind ${HostIP}:${Port}: " + $_.Exception.Message)
    throw
}

Write-Log ("Service started on {0}:{1}（v{2}：账户表 + 个人库 + 共享库 · 会话鉴权 · 假冲突已修）" -f $HostIP, $Port, $script:VERSION)
# 先拉后服务：把本机服务过的那些人的数据从共享盘续下来（拉不到就用本地，不阻塞启动）
if ($script:syncEnabled) {
    try {
        $boot = Invoke-BootSync
        $pulled = @($boot.results | Where-Object { $_.action -eq 'pull' })
        if ($pulled.Count) { Write-Log ('ⓘ 共享盘同步：开机拉回 ' + (($pulled | ForEach-Object { $_.name }) -join '、')) }
    } catch { Write-Log ('⚠ 开机同步异常（已忽略，用本地数据继续）：' + $_.Exception.Message) }
}
Write-Host ""
Write-Host "  ✅ FlowTask 存储服务已启动（PowerShell 零依赖版 · v$($script:VERSION)）"
Write-Host "  ------------------------------------------------"
Write-Host "  数据目录 : $DataDir"
Write-Host "  账户表   : flowtask_auth.json$(if(Test-Path $authFile){'（已存在）'}else{'（首次注册时创建）'})"
Write-Host "  共享库   : flowtask_shared.json"
Write-Host "  个人库   : flowtask_data_<账户id>.json（每账户一份，互相隔离）"
Write-Host "  备份目录 : $backupDir（间隔≥10 分钟自动备份，每类保留最近 $backupKeep 份）"
Write-Host "  共享盘   : $(if($script:syncEnabled){$script:ShareDir}else{'未配置（仅本机存储，行为与旧版一致）'})"
Write-Host "  请从浏览器打开 : http://${HostIP}:${Port}"
Write-Host "  停止服务 : 关闭本窗口或按 Ctrl+C"
Write-Host "  ------------------------------------------------"
Write-Host ""

# 主循环：单线程串行处理请求，足够本地个人使用
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        # finally 兜底关连接：Handle-Request 只在正常路径 Close，
        # 慢客户端 ReadTimeout / 非数字 rev 头等异常上抛时，不关就是句柄泄漏
        try { Handle-Request $client } catch { Write-Log ("Handler error: " + $_.Exception.Message) } finally { try { $client.Close() } catch {} }
        # 响应已发出、连接已关闭之后才往共享盘推：保存请求不会被 SMB 往返拖住
        # （Node 版用 3s 去抖定时器，PS 版是串行模型，等价做法是「先回包再同步」）
        if ($script:syncPendingPush) {
            $pending = $script:syncPendingPush; $script:syncPendingPush = $null
            Invoke-PushAfterWrite $pending
        }
        # 串行模型没有定时器：用请求驱动「该重试的推送」与「定期拉取」
        try { Invoke-SyncHousekeeping } catch { Write-Log ('同步巡检异常：' + $_.Exception.Message) }
    }
} catch {
    Write-Log ("Listener loop error: " + $_.Exception.Message)
} finally {
    $listener.Stop()
    Write-Log "Service stopped"
}
