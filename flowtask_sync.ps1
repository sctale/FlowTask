# =====================================================================
#  FlowTask 共享盘同步引擎（PowerShell 版，与 flowtask_sync.js 逐条对等）
# ---------------------------------------------------------------------
#  定位：本地优先。本机数据永远先落在 $DataDir，共享盘只是镜像仓库。
#        未提供 -ShareDir / FLOWTASK_SHARE_DIR 时 $syncEnabled = $false，
#        服务端行为与没有这套机制时完全一致（回滚开关 = 灰度开关）。
#
#  目录契约：
#    <SHARE>\team\flowtask_auth.json | team\flowtask_shared.json
#    <SHARE>\users\<uid>\flowtask_data_<uid>.json     每人一份，唯一写者就是本人
#    <SHARE>\locks\<name>.lock                        跨机锁（独占创建 + 60s 超时抢占）
#    <SHARE>\conflict\                                真冲突时本机与对方各留一份底
#
#  三条不容妥协的规则（与 JS 版同文）：
#    1) 共享盘「读不到」分两种：明确的不存在 → 可以推；
#       其它错误（断开 / 无权限 / 超时）→ 不知道对面是什么，一律不动，绝不覆盖。
#    2) 版本比 meta.rev 高者胜；rev 相同而内容哈希不同 = 真冲突 →
#       双方都先复制到 conflict\ 再按 meta.lastSaved 定胜负，绝不静默丢数据。
#    3) 写 team\ 前先抢 locks\<name>.lock；超过 60s 视为持锁进程已死，可抢占。
#
#  用法：在 flowtask_server.ps1 里 dot-source 本文件（$DataDir 已就绪之后）。
# =====================================================================

$script:LOCK_TTL_MS   = [long]60000
$script:syncStateFile = Join-Path $DataDir 'flowtask_sync.json'
$script:syncState     = @{ files = @{}; lastError = ''; lastErrorAt = [long]0; lastSyncAt = [long]0; reachable = $true; blockReason = '' }
$script:syncBlockReason = ''
# 三路合并内核（与 flowtask_merge.js 对等）：本文件其余部分按名调用，运行时解析
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'flowtask_merge.ps1')

function Get-NowMs { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# 拉取会改写本地文件：调用方（服务端）应覆盖本函数，把那份文件的 rev/hash 缓存作废，
# 否则服务端拿旧指纹比对，会产生假冲突或漏判真冲突。这里只兜一个不报错的默认实现。
function Invoke-OnLocalChanged([string]$name) { }

# ---------- 读文件并区分「不存在」与「读不了」：防覆盖事故的关键 ----------
# 注意：PowerShell 会把 .NET 方法抛出的异常包成 MethodInvocationException，
# 类型化 catch（catch [System.IO.FileNotFoundException]）匹配并不稳定，
# 一旦误判就会把「读不到」当成「没有这份文件」，进而用旧数据覆盖对方——
# 所以这里显式剥内层异常拿真实类型，并额外识别「目录占住了这个位置」。
function Get-InnerException($e) {
    while ($e -and $e.InnerException) { $e = $e.InnerException }
    return $e
}
function Read-OrMissing([string]$path) {
    try { if (Test-Path -LiteralPath $path -PathType Container) { return @{ ok = $false; err = 'is-a-directory' } } } catch { }
    try {
        return @{ ok = $true; text = [System.IO.File]::ReadAllText($path, $utf8NoBom) }
    } catch {
        $inner = Get-InnerException $_.Exception
        $name = $(if ($inner) { $inner.GetType().Name } else { 'unreadable' })
        if ($name -eq 'FileNotFoundException' -or $name -eq 'DirectoryNotFoundException') {
            return @{ ok = $true; text = $null }        # 明确不存在 → 可以推
        }
        return @{ ok = $false; err = $name }            # 其它一律算「读不了」→ 绝不动
    }
}

function Write-AtomicText([string]$to, [string]$text) {
    $dir = Split-Path -Parent $to
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue) }
    $tmp = $to + '.tmp'
    [System.IO.File]::WriteAllText($tmp, $text, $utf8NoBom)
    # 目标是目录时 Move-Item 会「移进去」并静默成功——必须显式拦掉，否则改名等于没发生
    if (Test-Path -LiteralPath $to -PathType Container) { throw 'destination is a directory' }
    Move-Item -LiteralPath $tmp -Destination $to -Force
}

# ---------- 元信息：absent / bad / {rev,lastSaved,hash} ----------
function Get-SyncMeta($text) {
    if ($null -eq $text) { return @{ absent = $true } }
    try {
        $j = $text | ConvertFrom-Json
        if (-not $j) { return @{ bad = $true } }
        $rev = [long]0; $ls = [long]0
        if ($j.meta) {
            if ($j.meta.rev) { $rev = [long]$j.meta.rev }
            if ($j.meta.lastSaved) { $ls = [long]$j.meta.lastSaved }
        }
        return @{ rev = $rev; lastSaved = $ls; hash = (Get-Sha1Hex $text) }
    } catch { return @{ bad = $true } }
}

# ---------- 纯决策函数（与 JS 版 decideAction 完全同表） ----------
function Resolve-SyncAction($L, $S) {
    if ($L.absent -and $S.absent) { return 'noop' }
    if ($L.bad) { return 'invalid-local' }        # 本机坏了：既不推也不拉
    if ($S.bad) { return 'invalid-remote' }       # 对方坏了：不覆盖也不拉回
    if ($L.absent) { return 'pull' }              # 新电脑首次登录 → 拉回来
    if ($S.absent) { return 'push' }              # 共享盘还没这份 → 推上去建基线
    if ($L.rev -gt $S.rev) { return 'push' }
    if ($L.rev -lt $S.rev) { return 'pull' }
    if ($L.hash -ceq $S.hash) { return 'noop' }
    # 同版本不同内容 = 真冲突：谁写得晚谁赢，但两边都先留底
    if ($L.lastSaved -ge $S.lastSaved) { return 'conflict-push' } else { return 'conflict-pull' }
}

# ---------- 本地文件名 → 共享盘目标路径；$null 表示这份不参与同步 ----------
# 个人库文件名 → uid（三处共用一份正则）。负向前瞻排除冲突副本/损坏隔离件：
# 服务端把 flowtask_data_<uid>_conflict_<ts>.json 与 _corrupt_ 留底写在同一目录，
# 不排除会被误认成 uid → 共享盘出现幽灵 users\ 目录、留底文件被推上盘。
$script:PersonalRe = '^flowtask_data_(?!conflict_|corrupt_|.*_conflict_|.*_corrupt_)([a-z0-9_\-]{1,64})\.json$'
function Get-SharePathOf([string]$name) {
    if (-not $script:ShareDir) { return $null }
    if ($name -ceq 'flowtask_auth.json' -or $name -ceq 'flowtask_shared.json') {
        return (Join-Path (Join-Path $script:ShareDir 'team') $name)
    }
    if ($name -cmatch $script:PersonalRe) {
        return (Join-Path (Join-Path (Join-Path $script:ShareDir 'users') $matches[1]) $name)
    }
    return $null
}
function Get-TeamUid([string]$name) {
    if ($name -cmatch $script:PersonalRe) { return $matches[1] }
    return $null
}

# ---------- 同步状态记账（本机 DATA_DIR 下的小文件，不参与 /api/db） ----------
function Save-SyncState {
    try { Write-AtomicText $script:syncStateFile ($script:syncState | ConvertTo-Json -Depth 10 -Compress) }
    catch { Write-Log ('⚠ 同步状态写入失败：' + $_.Exception.Message) }
}
function Load-SyncState {
    try {
        if (Test-Path -LiteralPath $script:syncStateFile) {
            $j = [System.IO.File]::ReadAllText($script:syncStateFile, $utf8NoBom) | ConvertFrom-Json
            if ($j) {
                $script:syncState.lastError   = [string]$j.lastError
                $script:syncState.lastErrorAt = [long]$j.lastErrorAt
                $script:syncState.lastSyncAt  = [long]$j.lastSyncAt
                $script:syncState.reachable   = [bool]$j.reachable
                $f = @{}
                if ($j.files) { foreach ($p in $j.files.PSObject.Properties) { $f[$p.Name] = $p.Value } }
                $script:syncState.files = $f
            }
        }
    } catch { }
    # 这三项以「本次启动的实测结果」为准，不能被上次留下的值覆盖：
    # 否则共享盘修好了界面还在报旧错，或者反过来假装正常
    $script:syncState.blockReason = $script:syncBlockReason
    $script:syncState.reachable   = (-not $script:syncBlockReason)
    if ($script:syncBlockReason) { $script:syncState.lastError = $script:syncBlockReason }
}
function Update-SyncError([string]$err) {
    $script:syncState.lastError = $err; $script:syncState.lastErrorAt = Get-NowMs
    $script:syncState.reachable = $false; Save-SyncState
}
function Mark-SyncOk {
    $script:syncState.reachable = $true; $script:syncState.lastSyncAt = Get-NowMs
    if ($script:syncState.blockReason) {
        $script:syncState.blockReason = ''; $script:syncState.lastError = ''; $script:syncBlockReason = ''
        Write-Log 'ⓘ 共享盘已恢复可写，同步继续'
    }
}
# 重新探测一次共享盘（改完配置或界面点「立即同步」后可调），返回原因串，空串代表可用
function Invoke-ShareCheck {
    if (-not $script:syncEnabled) { return '未配置共享盘目录' }
    $chk = Test-ShareDir $script:ShareDir
    $script:syncBlockReason = $(if ($chk.ok) { '' } else { $chk.reason })
    if ($chk.ok) { Mark-SyncOk } else { Update-SyncError $chk.reason }
    return $script:syncBlockReason
}

# ---------- 共享盘目录校验 ----------
# 必须「已经存在的目录 + 写得动」，引擎绝不为它创建根目录：
# 路径打错时若自动建目录，数据会静默落进一个谁都不知道的空目录，界面还显示「已同步」。
function Test-ShareRoot {
    if (-not $script:ShareDir) { return $false }
    try { return (Get-Item -LiteralPath $script:ShareDir -ErrorAction Stop).PSIsContainer } catch { return $false }
}
function Test-ShareDir([string]$dir) {
    if (-not $dir) { return @{ ok = $false; reason = '未配置共享盘目录' } }
    $item = $null
    try { $item = Get-Item -LiteralPath $dir -ErrorAction Stop }
    catch { return @{ ok = $false; reason = ('目录不存在或共享盘不可达——请核对 UNC 路径，或先在资源管理器里打开一次该共享') } }
    if (-not $item.PSIsContainer) { return @{ ok = $false; reason = '这个路径不是目录' } }
    $probe = Join-Path $dir '.flowtask-write-probe'
    try {
        $fs = [System.IO.File]::Open($probe, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        $fs.Close()
        try { Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue } catch { }
    } catch {
        if (Test-Path -LiteralPath $probe) { return @{ ok = $true; reason = '' } }   # 别人的探针在 → 写得动
        return @{ ok = $false; reason = ('这个目录写不进去（' + $_.Exception.GetType().Name + '）——请检查共享盘的写入权限') }
    }
    return @{ ok = $true; reason = '' }
}

# ---------- 跨机锁：独占创建 + 超时抢占 ----------
function Acquire-SyncLock([string]$name, [string]$owner) {
    $dir = Join-Path $script:ShareDir 'locks'
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue) }
    $f = Join-Path $dir ($name + '.lock')
    $body = '{"owner":"' + $owner + '","host":"' + $env:COMPUTERNAME + '","pid":' + $PID + ',"ts":' + (Get-NowMs) + '}'
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            # FileMode::CreateNew == Node 的 flag 'wx'：已存在就抛异常，跨机原子
            $fs = [System.IO.File]::Open($f, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
            $w = New-Object System.IO.StreamWriter($fs, $utf8NoBom); $w.Write($body); $w.Close(); $fs.Close()
            return @{ ok = $true; file = $f }
        } catch [System.IO.IOException] {
            $stale = $true
            try {
                $j = [System.IO.File]::ReadAllText($f, $utf8NoBom) | ConvertFrom-Json
                if ($j -and $j.ts -and ((Get-NowMs) - [long]$j.ts) -le $script:LOCK_TTL_MS) { $stale = $false }
            } catch { $stale = $true }              # 读不懂的锁当过期处理
            if (-not $stale) { return @{ ok = $false; err = 'locked' } }
            try { Remove-Item -LiteralPath $f -Force -ErrorAction Stop } catch { return @{ ok = $false; err = 'lock-stuck' } }
        } catch { return @{ ok = $false; err = $_.Exception.GetType().Name } }
    }
    return @{ ok = $false; err = 'locked' }
}
function Release-SyncLock($lk) {
    if ($lk -and $lk.file -and (Test-Path -LiteralPath $lk.file)) { try { Remove-Item -LiteralPath $lk.file -Force -ErrorAction SilentlyContinue } catch { } }
}

# ---------- 冲突留底：双方各存一份 ----------
function Get-Stamp { return (Get-Date).ToString('yyyyMMdd_HHmmss') }
function Stash-Conflict([string]$name, $localText, $remoteText) {
    $out = @()
    try {
        $dir = Join-Path $script:ShareDir 'conflict'
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue) }
        $stem = $name -replace '\.json$', ''
        $tag = Get-Stamp
        if ($null -ne $localText) {
            $p = Join-Path $dir ($stem + '_local_' + $tag + '.json')
            Write-AtomicText $p $localText; $out += (Split-Path -Leaf $p)
        }
        if ($null -ne $remoteText) {
            $p = Join-Path $dir ($stem + '_remote_' + $tag + '.json')
            Write-AtomicText $p $remoteText; $out += (Split-Path -Leaf $p)
        }
        return $out
    } catch { Write-Log ('⚠ 冲突留底失败：' + $_.Exception.Message); return $out }
}

# ---------- 单份文件的一次同步 ----------
#   $mode 只记录调用来源，不改变方向判断（方向永远由 Resolve-SyncAction 决定）
function Invoke-SyncFile([string]$name, [string]$mode) {
    $target = Get-SharePathOf $name
    if (-not $target) { return @{ name = $name; action = 'ignored' } }
    $localFile = Get-FileOf $name
    $lockNeeded = ($name -ceq 'flowtask_auth.json') -or ($name -ceq 'flowtask_shared.json')

    $lr = Read-OrMissing $localFile
    if (-not $lr.ok) { return @{ name = $name; action = 'hold'; err = ('local-read:' + $lr.err) } }
    # 根目录不在（路径打错 / 共享盘没连）时一律不写：
    # 否则 Write-AtomicText 会把打错的路径凭空建出来，数据静默落进没人知道的空目录
    if (-not (Test-ShareRoot)) {
        $why = '共享盘目录不存在或不可达：' + $script:ShareDir
        $script:syncBlockReason = $why; $script:syncState.blockReason = $why
        Update-SyncError $why
        return @{ name = $name; action = 'hold'; err = 'share-root-missing' }
    }
    $rr = Read-OrMissing $target
    if (-not $rr.ok) {                                                   # 不知道对面是什么 → 绝不动
        Update-SyncError ($name + ' share-read:' + $rr.err)
        return @{ name = $name; action = 'hold'; err = ('share-read:' + $rr.err) }
    }

    # 三路合并：双方都相对「共同祖先」改过时按实体合并，而不是整片二选一。
    # 基线只存本机 DATA_DIR（盘上没有协调者，合并只能在客户端各自算）；没有基线时沿用版本号规则，
    # 所以本功能是渐进生效的，不需要迁移任何历史数据。
    $baseFile = $localFile + '.base.json'
    $baseText = Get-BaseText $baseFile
    if (Test-NeedsMerge $baseText $lr.text $rr.text) {
        return (Invoke-MergeRound @{ name = $name; mode = $mode; lockNeeded = $lockNeeded; baseFile = $baseFile; localFile = $localFile; target = $target })
    }

    $action = Resolve-SyncAction (Get-SyncMeta $lr.text) (Get-SyncMeta $rr.text)
    if (-not $script:syncState.files.ContainsKey($name)) { $script:syncState.files[$name] = @{} }
    $rec = $script:syncState.files[$name]
    if ($rec -isnot [hashtable]) { $rec = @{ }; $script:syncState.files[$name] = $rec }
    $rec['lastMode'] = $mode
    if ($action -eq 'noop' -or $action -eq 'ignored' -or $action -eq 'hold') { return @{ name = $name; action = $action } }
    if ($action -eq 'invalid-local' -or $action -eq 'invalid-remote') {
        $rec['lastResult'] = $action; Update-SyncError ($name + ' ' + $action)
        return @{ name = $name; action = $action; err = $action }
    }

    # 真冲突：先双方留底，再定胜负。这一步必须在任何方向判断之前，且不受 mode 影响
    $conflicts = @()
    if ($action -eq 'conflict-push' -or $action -eq 'conflict-pull') { $conflicts = Stash-Conflict $name $lr.text $rr.text }
    $doPush = ($action -eq 'push') -or ($action -eq 'conflict-push')

    $lk = $null
    if ($lockNeeded) {
        $lk = Acquire-SyncLock $name $(if ($doPush) { $(if (Get-TeamUid $name) { Get-TeamUid $name } else { 'team' }) } else { 'puller' })
        if (-not $lk.ok) { $rec['lastResult'] = 'locked'; Save-SyncState; return @{ name = $name; action = 'locked'; err = $lk.err } }
    }
    $done = $false
    try {
        if ($doPush) {
            # 推之前复核一次远端：拿锁期间可能又有人写过（锁不是万能，复核更稳）
            $check = Read-OrMissing $target
            if (-not $check.ok) { $rec['lastResult'] = 'hold'; return @{ name = $name; action = 'hold'; err = ('share-read:' + $check.err) } }
            $decided = Resolve-SyncAction (Get-SyncMeta $lr.text) (Get-SyncMeta $check.text)
            if ($decided -eq 'pull' -or $decided -eq 'conflict-pull') {
                # 远端更新：这次不推，改成把对方版本拉下来，避免用旧数据盖掉新数据
                if ($null -ne $check.text) { Write-AtomicText $localFile $check.text; Invoke-OnLocalChanged $name }
                $cm = Get-SyncMeta $check.text
                $rec['lastResult'] = 'pull-instead'; $rec['lastPullAt'] = Get-NowMs; $rec['lastPullRev'] = $cm.rev
                $done = $true; Mark-SyncOk
                return @{ name = $name; action = 'pull'; rev = $cm.rev; note = 'recheck' }
            }
            Write-AtomicText $target $lr.text
            Write-BaseFile ($localFile + '.base.json') $lr.text        # 盘上现在就是我这份 → 它就是新的共同祖先
            $lm = Get-SyncMeta $lr.text
            $rec['lastPushAt'] = Get-NowMs; $rec['lastPushRev'] = $lm.rev; $rec['lastResult'] = 'push'
            $done = $true; Mark-SyncOk
            return @{ name = $name; action = 'push'; rev = $lm.rev; conflicts = $conflicts }
        }
        # 拉：共享盘那份覆盖本地
        if ($null -eq $rr.text) { $rec['lastResult'] = 'noop'; return @{ name = $name; action = 'noop' } }
        Write-AtomicText $localFile $rr.text
        Invoke-OnLocalChanged $name
        Write-BaseFile ($localFile + '.base.json') $rr.text             # 拉完两边一致 → 记为新的共同祖先
        $rm = Get-SyncMeta $rr.text
        $rec['lastPullAt'] = Get-NowMs; $rec['lastPullRev'] = $rm.rev; $rec['lastResult'] = 'pull'
        $done = $true; Mark-SyncOk
        return @{ name = $name; action = 'pull'; rev = $rm.rev; conflicts = $conflicts }
    } catch {
        $rec['lastResult'] = 'error'
        Update-SyncError ($name + ' ' + $_.Exception.Message)
        return @{ name = $name; action = 'error'; err = $_.Exception.Message }
    } finally {
        Release-SyncLock $lk
        if ($done -or $rec['lastResult'] -eq 'error' -or $rec['lastResult'] -eq 'pull-instead' -or $rec['lastResult'] -eq 'locked') { Save-SyncState }
    }
}

# ---------- 批量入口 ----------
function Get-LocalPersonalUids {
    $uids = @()
    try {
        foreach ($f in [System.IO.Directory]::GetFiles($DataDir, 'flowtask_data_*.json')) {
            $n = Split-Path -Leaf $f
            if ($n -cmatch $script:PersonalRe) { $uids += $matches[1] }
        }
    } catch { }
    return $uids
}
function Invoke-SyncFor($names, [string]$mode, $budgetMs = 0) {
    if (-not $script:syncEnabled) { return @{ enabled = $false; results = @() } }
    $res = @()
    $t0 = Get-NowMs
    foreach ($n in $names) {
        # 文件之间检查预算（至少处理一个）：共享盘掉线时整轮巡检不至于无限期占住串行主循环
        if ($budgetMs -gt 0 -and $res.Count -gt 0 -and ((Get-NowMs) - $t0) -gt $budgetMs) { break }
        $res += (Invoke-SyncFile $n $mode)
    }
    return @{ enabled = $true; results = $res }
}
function Invoke-BootSync {
    if (-not $script:syncEnabled) { return @{ skipped = $true } }
    $names = @('flowtask_auth.json', 'flowtask_shared.json')
    foreach ($u in Get-LocalPersonalUids) { $names += ('flowtask_data_' + $u + '.json') }
    return (Invoke-SyncFor $names 'boot')
}
function Invoke-LoginSync([string]$uid) {
    if (-not $script:syncEnabled) { return @{ enabled = $false } }
    $names = @('flowtask_auth.json', 'flowtask_shared.json')
    if ($uid) { $names += ('flowtask_data_' + $uid + '.json') }
    return (Invoke-SyncFor $names 'login')
}
function Invoke-ManualSync([string]$mode, [string]$uid) {
    $names = @('flowtask_auth.json', 'flowtask_shared.json')
    if ($uid) { $names += ('flowtask_data_' + $uid + '.json') }
    else { foreach ($u in Get-LocalPersonalUids) { $names += ('flowtask_data_' + $u + '.json') } }
    return (Invoke-SyncFor $names $(if ($mode) { $mode } else { 'manual' }))
}
# PowerShell 版是单线程串行处理请求：没有 JS 里的去抖定时器，
# 由调用方在「响应已发出之后」同步执行一次推送，用户观感一致。
function Invoke-PushAfterWrite([string]$name) {
    if (-not $script:syncEnabled) { return }
    if (-not (Get-SharePathOf $name)) { return }
    try { $r = Invoke-SyncFile $name 'after-write'; Update-SyncRetry $name $r | Out-Null }
    catch { Update-SyncError ($name + ' push: ' + $_.Exception.Message); Update-SyncRetry $name @{ action = 'error' } | Out-Null }
}

# 路径表示必须全程一致：启动时会规范化成 FullName，热切换若不做同一件事，
# 同一个目录会以两种字符串出现（8.3 短名 / 长名），状态显示与实际写入路径就可能不是同一个东西
function Resolve-ShareDir([string]$p) {
    $t = ("" + $p).Trim()
    if (-not $t) { return '' }
    try { if (Test-Path -LiteralPath $t) { return (Get-Item -LiteralPath $t).FullName } } catch { }
    return $t
}
# 界面改路径 / 启停同步时热切换：重设路径并立刻重新校验（本文件其余部分都读 $script:ShareDir，改一处即全局生效）
function Set-ShareConfig([string]$dir, $enabledFlag) {
    $script:ShareDir = Resolve-ShareDir $dir
    if ($null -ne $enabledFlag) { $script:syncEnabled = (([bool]$enabledFlag) -and ([bool]$script:ShareDir)) }
    else { $script:syncEnabled = [bool]$script:ShareDir }
    if (-not $script:syncEnabled) { $script:ShareDir = '' }
    $script:syncBlockReason = ''
    if ($script:syncEnabled) {
        $chk = Test-ShareDir $script:ShareDir
        if (-not $chk.ok) { $script:syncBlockReason = $chk.reason }
    }
    $script:syncState.blockReason = $script:syncBlockReason
    $script:syncState.reachable = (-not $script:syncBlockReason)
    return @{ enabled = [bool]$script:syncEnabled; shareDir = [string]$script:ShareDir; blockReason = [string]$script:syncBlockReason }
}

# ---------- 合并基线（只存本机，绝不上共享盘） ----------
function Write-BaseFile([string]$baseFile, [string]$text) {
    try { Write-AtomicText $baseFile (@{ writtenAt = (Get-NowMs); text = $text } | ConvertTo-Json -Depth 4 -Compress) }
    catch { Write-Log ('⚠ 合并基线写入失败（下次同步退回版本号规则）：' + $_.Exception.Message) }
}
function Get-BaseText([string]$baseFile) {
    $r = Read-OrMissing $baseFile
    if (-not $r.ok -or $null -eq $r.text) { return $null }
    try {
        $j = $r.text | ConvertFrom-Json
        if ($j -and $j.PSObject.Properties['text']) { return [string]$j.text }
        return $null
    } catch { return $null }
}

# 一次合并回合：拿锁后重读两侧，合并结果同时写本机 / 共享盘 / 基线。
# 三方都落成同一份，下一次各自都比得出「没有改动」，不会反复冲突。
function Invoke-MergeRound($c) {
    $name = $c.name; $target = $c.target; $localFile = $c.localFile; $baseFile = $c.baseFile
    if (-not $script:syncState.files.ContainsKey($name)) { $script:syncState.files[$name] = @{} }
    $rec = $script:syncState.files[$name]
    if ($rec -isnot [hashtable]) { $rec = @{ }; $script:syncState.files[$name] = $rec }
    $rec['lastMode'] = 'merge'

    $lk = $null
    if ($c.lockNeeded) {
        $lk = Acquire-SyncLock $name 'merger'
        if (-not $lk.ok) { $rec['lastResult'] = 'locked'; Save-SyncState; return @{ name = $name; action = 'locked'; err = $lk.err } }
    }
    $done = $false
    try {
        $mine = Read-OrMissing $localFile
        $theirs = Read-OrMissing $target
        if (-not $mine.ok -or -not $theirs.ok) {
            $err = $(if (-not $mine.ok) { 'local-read:' + $mine.err } else { 'share-read:' + $theirs.err })
            Update-SyncError ($name + ' ' + $err)
            return @{ name = $name; action = 'hold'; err = $err }
        }
        $baseText = Get-BaseText $baseFile
        if (-not (Test-NeedsMerge $baseText $mine.text $theirs.text)) {
            $rec['lastResult'] = 'merge-skipped'      # 拿锁期间对方又同步过：这轮不合并，交给下轮常规判断
            return @{ name = $name; action = 'noop'; note = 'merge-not-needed' }
        }
        $r = Merge-StoreText $baseText $mine.text $theirs.text
        $merged = $r.text
        Write-AtomicText $localFile $merged
        Invoke-OnLocalChanged $name
        Write-AtomicText $target $merged
        Write-BaseFile $baseFile $merged
        $nc = @($r.conflicts).Count
        $files = @()
        if ($nc -gt 0) { $files = Stash-Merge $name $baseText $mine.text $theirs.text $merged $r.conflicts }
        $rev = 0; try { $rev = [long]((ConvertFrom-Json $merged).meta.rev) } catch { }
        $rec['lastResult'] = 'merged'; $rec['lastPushAt'] = Get-NowMs; $rec['lastPullAt'] = Get-NowMs; $rec['lastPushRev'] = $rev
        $rec['lastMergeConflicts'] = ([long]$rec['lastMergeConflicts']) + $nc
        $done = $true; Mark-SyncOk
        return @{ name = $name; action = 'merged'; rev = $rev; autoResolved = $true; divergences = $nc; conflicts = $files }
    } catch {
        $rec['lastResult'] = 'error'
        Update-SyncError ($name + ' ' + $_.Exception.Message)
        return @{ name = $name; action = 'error'; err = $_.Exception.Message }
    } finally {
        Release-SyncLock $lk
        if ($done -or $rec['lastResult'] -eq 'error' -or $rec['lastResult'] -eq 'locked' -or $rec['lastResult'] -eq 'merge-skipped') { Save-SyncState }
    }
}

# 无法自动裁决的部分：三份原文 + 合并结果一起留底，人能看懂也能手工并回去
function Stash-Merge([string]$name, $baseText, $mineText, $theirsText, $mergedText, $conflicts) {
    try {
        $dir = Join-Path $script:ShareDir 'conflict'
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force -ErrorAction SilentlyContinue) }
        $f = Join-Path $dir (($name -replace '\.json$', '') + '_merge_' + (Get-Stamp) + '.json')
        $payload = [ordered]@{
            at = (Get-Date).ToString('o'); host = $env:COMPUTERNAME
            divergences = @($conflicts)
            base = ($baseText   | ConvertFrom-Json); mine = ($mineText   | ConvertFrom-Json)
            theirs = ($theirsText | ConvertFrom-Json); merged = ($mergedText | ConvertFrom-Json)
        }
        Write-AtomicText $f ($payload | ConvertTo-Json -Depth 30)
        return @(Split-Path -Leaf $f)
    } catch { Write-Log ('⚠ 合并留底写入失败：' + $_.Exception.Message); return @() }
}

# 登录找不到人时按需补拉账户表（与 Node 版 pullAuth 对等）：
# 新机器开机时盘上可能还没有账户表，而 /api/sync 需要会话、会话需要账户表，不补这一刀就是死循环
function Update-AuthFromShare {
    if (-not $script:syncEnabled) { return @{ enabled = $false } }
    return (Invoke-SyncFor @('flowtask_auth.json') 'login-refresh')
}
# 拿不到锁 / 盘暂时读不到 ≠ 可以丢掉这次改动：必须退避重试，否则同事正好在推时
# 我的改动会一直躺在本地，直到下一次本地写入才顺带带出去
$script:syncRetryDelay = @(1500, 4000, 9000, 20000)
$script:syncRetryState = @{}          # name -> @{ tries; due }
function Update-SyncRetry([string]$name, $result){
    $act = if ($result) { [string]$result.action } else { 'error' }
    if ($act -ne 'locked' -and $act -ne 'hold' -and $act -ne 'error') { $script:syncRetryState.Remove($name); return $false }
    $st = $null
    if ($script:syncRetryState.ContainsKey($name)) { $st = $script:syncRetryState[$name] } else { $st = @{ tries = 0; due = 0 } }
    if ($st.tries -ge $script:syncRetryDelay.Count) { $script:syncRetryState.Remove($name); return $false }
    $st.due = (Get-NowMs) + $script:syncRetryDelay[$st.tries]
    $st.tries = $st.tries + 1
    $script:syncRetryState[$name] = $st
    return $true
}
# 串行模型没有定时器：每处理完一个请求就顺手看一遍「该重试的」与「该拉的」，
# 页面本身每 30 秒会来问一次同步状态，这个流量足以驱动它
function Invoke-SyncHousekeeping {
    if (-not $script:syncEnabled) { return }
    $now = Get-NowMs
    $budget = 2000   # 单轮总预算：共享盘抖动时下一个请求不该在 listen 队列里干等 SMB 超时
    foreach ($name in @($script:syncRetryState.Keys)) {
        if (((Get-NowMs) - $now) -gt $budget) { break }
        $st = $script:syncRetryState[$name]
        if ($st.due -le $now) {
            $r = $null
            try { $r = Invoke-SyncFile $name 'retry' } catch { $r = @{ action = 'error' } }
            Update-SyncRetry $name $r | Out-Null
        }
    }
    if ($null -eq $script:syncLastPullAt) { $script:syncLastPullAt = 0 }
    if (($now - $script:syncLastPullAt) -ge 30000) {
        $script:syncLastPullAt = $now
        try { [void](Invoke-SyncFor @(@('flowtask_auth.json','flowtask_shared.json') + (Get-LocalPersonalUids | ForEach-Object { 'flowtask_data_' + $_ + '.json' })) 'periodic' $budget) }
        catch { Write-Log ('定期同步异常：' + $_.Exception.Message) }
    }
}
function Get-SyncStatus {
    $files = @()
    foreach ($p in $script:syncState.files.GetEnumerator()) {
        $v = $p.Value
        $files += @{ name = $p.Name
                     lastResult  = [string]$v['lastResult']
                     lastPushAt  = [long]$v['lastPushAt']
                     lastPushRev = [long]$v['lastPushRev']
                     lastPullAt  = [long]$v['lastPullAt']
                     lastPullRev = [long]$v['lastPullRev'] }
    }
    return @{
        enabled     = [bool]$script:syncEnabled
        reachable   = [bool]$script:syncState.reachable
        lastSyncAt  = [long]$script:syncState.lastSyncAt
        lastError   = [string]$script:syncState.lastError
        lastErrorAt = [long]$script:syncState.lastErrorAt
        blockReason = [string]$script:syncState.blockReason
        shareDir    = [string]$script:ShareDir
        files       = $files
    }
}

# 启动时先校验一次共享盘；不通过也保持启用意图（可能只是暂时没连上），
# 但把原因记下来供界面显示，并在每次同步前复查根目录是否存在
if ($script:syncEnabled) {
    $chk = Test-ShareDir $script:ShareDir
    if (-not $chk.ok) { $script:syncBlockReason = $chk.reason }
    Load-SyncState
}
