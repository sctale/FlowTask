# =====================================================================
#  FlowTask 三路合并内核（PowerShell 版，与 flowtask_merge.js 逐条对等）
# ---------------------------------------------------------------------
#  共享盘只有存储、不跑代码，所以合并只能发生在每台客户端本地；
#  每台机器各自留一份「共同祖先」基线（<DATA_DIR>\<库名>.base.json，绝不上盘）。
#  同一份 (base, A, B) 在任意一台机器上算出的结果必须相同 —— 规则必须对称，
#  否则两台机器各自收敛到不同状态，合并本身就成了新的冲突源。
#  用法：在 flowtask_sync.ps1 里 dot-source 本文件。
# =====================================================================

# PSCustomObject → 有序字典树：PS 里 PSCustomObject 不能增删键，合并必须用字典
function Convert-ToTree($v) {
    if ($null -eq $v) { return $null }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
        $d = [ordered]@{}
        foreach ($p in $v.PSObject.Properties) { $d[$p.Name] = Convert-ToTree $p.Value }
        return $d
    }
    if ($v -is [System.Collections.IDictionary]) {
        $d = [ordered]@{}
        foreach ($k in $v.Keys) { $d[[string]$k] = Convert-ToTree $v[$k] }
        return $d
    }
    if ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) {
        # 空数组经函数 return 会被管道塌缩成 $null（建树阶段就把 [] 变成 null，
        # 合并后落盘成 null → 页面白屏），用逗号打包保证数组原样传出
        $arr = @($v | ForEach-Object { Convert-ToTree $_ })
        return ,$arr
    }
    return $v
}
function Test-PlainValue($v) { return ($v -is [string]) -or ($v -is [bool]) -or ($v -is [System.Management.Automation.PSObject]) }

# 稳定序列化：键排序后比较，用来判断「这侧到底改没改」
function Get-Canon($v) {
    if ($null -eq $v) { return 'null' }
    if ($v -is [System.Collections.IDictionary]) {
        $keys = @($v.Keys | ForEach-Object { [string]$_ } | Sort-Object)
        return '{' + (($keys | ForEach-Object { $_ + ':' + (Get-Canon $v[$_]) }) -join ',') + '}'
    }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
        $keys = @($v.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object)
        return '{' + (($keys | ForEach-Object { $_ + ':' + (Get-Canon ($v.PSObject.Properties[$_].Value)) }) -join ',') + '}'
    }
    if ($v -is [string]) { return '"' + $v + '"' }
    if ($v -is [System.Collections.IEnumerable]) { return '[' + (@($v | ForEach-Object { Get-Canon $_ }) -join ',') + ']' }
    if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
    return [string]$v
}

# 实体自身的时间戳：只用于「两边都改了同一处」时的确定性取舍
function Get-EntityStamp($v) {
    if ($null -eq $v) { return 0 }
    if ($v -is [System.Collections.IDictionary]) {
        $m = 0
        foreach ($k in @('ts','updatedAt','createdAt','completedAt','lastSaved','doneAt')) {
            if ($v.Contains($k) -and $v[$k] -is [valueType]) {
                $n = 0; if ([long]::TryParse([string]$v[$k], [ref]$n) -and $n -gt $m) { $m = $n }
            }
        }
        foreach ($k in @('activities','comments','statusUpdates')) {
            if ($v.Contains($k) -and $v[$k] -is [System.Collections.IEnumerable] -and $v[$k] -isnot [string]) {
                foreach ($x in $v[$k]) { $s = Get-EntityStamp $x; if ($s -gt $m) { $m = $s } }
            }
        }
        return $m
    }
    if ($v -is [System.Management.Automation.PSCustomObject]) {
        $m = 0
        foreach ($k in @('ts','updatedAt','createdAt','completedAt','lastSaved','doneAt')) {
            if ($v.PSObject.Properties[$k]) { $n = 0; if ([long]::TryParse([string]$v.$k, [ref]$n) -and $n -gt $m) { $m = $n } }
        }
        foreach ($k in @('activities','comments','statusUpdates')) {
            if ($v.PSObject.Properties[$k] -and $v.$k) { foreach ($x in @($v.$k)) { $s = Get-EntityStamp $x; if ($s -gt $m) { $m = $s } } }
        }
        return $m
    }
    if ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) {
        $m = 0; foreach ($x in $v) { $s = Get-EntityStamp $x; if ($s -gt $m) { $m = $s } }
        return $m
    }
    return 0
}

# PS 函数 return 会把空数组经管道塌缩成 $null（嵌套字段落盘变 null → 页面白屏），
# 数组一律用逗号打包输出；标量/字典原样透传
function Emit-MergeValue($v) {
    if ($v -is [array]) { return ,@($v) }
    return $v
}

# 两侧都改了同一处：用「所属实体的时间戳」决胜；时间相同再按规范化字符串序，
# 关键是规则必须与主客无关 —— 用字段值自己的时间会退化成按字符序取胜，看着像随机丢改动
function Select-Deterministic($a, $b, $sa, $sb) {
    if ($null -eq $sa) { $sa = Get-EntityStamp $a }
    if ($null -eq $sb) { $sb = Get-EntityStamp $b }
    if ($sa -ne $sb) { if ($sa -gt $sb) { return Emit-MergeValue $a } else { return Emit-MergeValue $b } }
    # -le 对字符串大小写不敏感且随区域设置（中英文 Windows 会选出不同胜者）；必须按码元序，与 JS 版 <= 对齐
    if ([System.StringComparer]::Ordinal.Compare((Get-Canon $a), (Get-Canon $b)) -le 0) { return Emit-MergeValue $a } else { return Emit-MergeValue $b }
}
function Test-HasIds($arr) {
    if ($arr -isnot [System.Collections.IEnumerable] -or $arr -is [string]) { return $false }
    $list = @($arr); if ($list.Count -eq 0) { return $false }
    foreach ($x in $list) {
        $hasId = ($x -is [System.Collections.IDictionary] -and $x.Contains('id')) -or
                 ($x -is [System.Management.Automation.PSCustomObject] -and $x.PSObject.Properties['id'])
        if (-not $hasId) { return $false }
    }
    return $true
}
function Get-ItemId($x) {
    if ($x -is [System.Collections.IDictionary] -and $x.Contains('id')) { return [string]$x['id'] }
    if ($x -is [System.Management.Automation.PSCustomObject] -and $x.PSObject.Properties['id']) { return [string]$x.id }
    return $null
}

# 冲突累加：哈希表按引用传递，往里塞条目对调用方可见
function Add-Conflict($conflicts, $item) {
    if ($null -eq $conflicts) { return }
    $conflicts.items = @($conflicts.items) + $item
}
# 标量集合（followers / tags / memberIds）：谁加的都要留，两边都删才算删
function Merge-ScalarArray($base, $mine, $theirs) {
    $cur = @{}; foreach ($x in @($mine)) { $cur[(Get-Canon $x)] = $x }
    $oth = @{}; foreach ($x in @($theirs)) { $oth[(Get-Canon $x)] = $x }
    $out = @(); $seen = @{}
    # 顺序必须与主客无关（与 JS 版一致）：base 序为骨架，新增项按规范化字符串码元序追加。
    # 旧的「theirs 为主序」在两台机器上角色互换会算出不同顺序 → 内容哈希永不相同。
    foreach ($item in @($base)) {
        $k = Get-Canon $item
        if ($seen.ContainsKey($k)) { continue }
        if (-not $cur.ContainsKey($k) -and -not $oth.ContainsKey($k)) { continue }   # 两边都删了
        $seen[$k] = $true; $out += $item
    }
    $added = @{}
    foreach ($src in @(@($mine), @($theirs))) {
        foreach ($item in $src) {
            $k = Get-Canon $item
            if ($seen.ContainsKey($k) -or $added.ContainsKey($k)) { continue }
            if (-not $cur.ContainsKey($k) -and -not $oth.ContainsKey($k)) { continue }
            $added[$k] = $item
        }
    }
    $addedKeys = [array]@($added.Keys)
    [Array]::Sort($addedKeys, [System.StringComparer]::Ordinal)
    foreach ($k in $addedKeys) { $out += $added[$k] }
    return @{ items = @($out) }
}

# 通用值合并（递归）。$sm/$st 是两侧所属实体的时间戳，逐层往下传
function Merge-Value($b, $m, $t, $path, $conflicts, $depth, $sm, $st) {
    # canon 比较必须大小写敏感（-ceq）：JS 版用 ===，PS 的 -eq 把 "Bug"/"bug" 判成相等，
    # 会误认为「两边改成一样」而静默吞掉对方的改动
    $cm = Get-Canon $m; $ct = Get-Canon $t; $cb = Get-Canon $b
    if ($cm -ceq $ct) { return Emit-MergeValue $m }
    if ($cm -ceq $cb) { return Emit-MergeValue $t }                      # 只有对方改了
    if ($ct -ceq $cb) { return Emit-MergeValue $m }                      # 只有我方改了
    if ($null -eq $sm) { $sm = Get-EntityStamp $m }
    if ($null -eq $st) { $st = Get-EntityStamp $t }

    $mIsArr = $m -is [System.Collections.IEnumerable] -and $m -isnot [string] -and $m -isnot [System.Collections.IDictionary] -and $m -isnot [System.Management.Automation.PSCustomObject]
    $tIsArr = $t -is [System.Collections.IEnumerable] -and $t -isnot [string] -and $t -isnot [System.Collections.IDictionary] -and $t -isnot [System.Management.Automation.PSCustomObject]
    # 与 JS 版对齐：两侧都是数组才走数组合并（一侧数组一侧标量属于结构变化，走标量冲突）
    if ($mIsArr -and $tIsArr) {
        if ((Test-HasIds $m) -or (Test-HasIds $t)) {
            # base 非数组（null/缺失）按空数组处理（JS: Array.isArray(base) ? base : []，every 恒真）；
            # 旧版把空 base 判成不可按 id 合并 → 整个数组二选一，静默丢掉一方新增的实体
            $bAllId = $true
            if ($b -is [array]) { foreach ($x in $b) { if (Get-ItemId $x) { } else { $bAllId = $false; break } } }
            if ($bAllId -and (Test-HasIds $m) -and (Test-HasIds $t)) {
                $r = (Merge-ArrayById $b $m $t $path $conflicts $depth).items
                return Emit-MergeValue $r
            }
        }
        $mObj = $false; $tObj = $false
        if (@($m).Count -gt 0 -and (@($m)[0] -is [System.Collections.IDictionary] -or @($m)[0] -is [System.Management.Automation.PSCustomObject])) { $mObj = $true }
        if (@($t).Count -gt 0 -and (@($t)[0] -is [System.Collections.IDictionary] -or @($t)[0] -is [System.Management.Automation.PSCustomObject])) { $tObj = $true }
        if (-not $mObj -and -not $tObj) { $r = (Merge-ScalarArray $b $m $t).items; return Emit-MergeValue $r }
    }

    $mIsObj = $m -is [System.Collections.IDictionary]
    $tIsObj = $t -is [System.Collections.IDictionary]
    if ($mIsObj -and $tIsObj) {
        if ($depth -gt 6) { Add-Conflict $conflicts (@{ path = $path; kind = 'too-deep' }); return Select-Deterministic $m $t $sm $st }
        $out = [ordered]@{}
        $keys = @{}
        foreach ($src in @(@($b.Keys), @($m.Keys), @($t.Keys))) { foreach ($k in $src) { if ($k) { $keys[[string]$k] = $true } } }
        foreach ($k in ($keys.Keys | Sort-Object)) {
            $bv = if ($b -and $b.Contains($k)) { $b[$k] } else { $null }
            $hasM = $m.Contains($k); $hasT = $t.Contains($k)
            if (-not $hasM -and -not $hasT) { continue }
            if (-not $hasM -or -not $hasT) {
                # 一方删了这个字段、另一方改了它：改了的那侧优先，且必须记一条冲突
                $present = if ($hasM) { $m[$k] } else { $t[$k] }
                if ((Get-Canon $present) -cne (Get-Canon $bv)) {
                    Add-Conflict $conflicts (@{ path = ($path + '.' + $k); kind = 'field-vs-delete' })
                    $out[$k] = Merge-Value $bv $present $bv ($path + '.' + $k) $conflicts ($depth + 1) $sm $st
                }
                continue
            }
            if ($k -eq 'id') { $out[$k] = $t[$k]; continue }              # id 永远不动
            $out[$k] = Merge-Value $bv $m[$k] $t[$k] ($path + '.' + $k) $conflicts ($depth + 1) $sm $st
        }
        return $out
    }
    Add-Conflict $conflicts (@{ path = $path; kind = 'scalar'; base = $b; mine = $m; theirs = $t })
    return Select-Deterministic $m $t $sm $st
}

# 数组按 id 对齐合并；结果顺序与主客无关（base 序为骨架 + 新增按码元序），保证可复现。
# 注意：PowerShell 变量名大小写不敏感 —— 索引表必须用 $mapB/$mapM/$mapT 这种「不只差大小写」
# 的名字，否则会和逐条取出的 $b/$m/$t 撞成同一个变量，第一行赋值就把索引表毁掉。
function Merge-ArrayById($base, $mine, $theirs, $path, $conflicts, $depth) {
    $mapB = @{}; $mapM = @{}; $mapT = @{}
    foreach ($x in @($base))   { $id = Get-ItemId $x; if ($id) { $mapB[$id] = $x } }
    foreach ($x in @($mine))   { $id = Get-ItemId $x; if ($id) { $mapM[$id] = $x } }
    foreach ($x in @($theirs)) { $id = Get-ItemId $x; if ($id) { $mapT[$id] = $x } }
    # 顺序必须与主客无关（与 JS 版一致）：base 序为骨架，新增 id 按码元序追加。
    # 旧的「theirs 为主序」在两台机器上角色互换会算出不同顺序 → 内容哈希永不相同。
    $order = @(); $seen = @{}
    foreach ($x in @($base)) { $id = Get-ItemId $x; if ($id -and -not $seen.ContainsKey($id)) { $seen[$id] = $true; $order += $id } }
    $added = @{}
    foreach ($src in @(@($mine), @($theirs))) {
        foreach ($x in $src) { $id = Get-ItemId $x; if ($id -and -not $seen.ContainsKey($id) -and -not $added.ContainsKey($id)) { $added[$id] = $true } }
    }
    $addedIds = [array]@($added.Keys)
    [Array]::Sort($addedIds, [System.StringComparer]::Ordinal)
    foreach ($id in $addedIds) { $order += $id }
    $out = @()
    foreach ($id in $order) {
        $hasB = $mapB.ContainsKey($id); $valB = if ($hasB) { $mapB[$id] } else { $null }
        $hasM = $mapM.ContainsKey($id); $valM = if ($hasM) { $mapM[$id] } else { $null }
        $hasT = $mapT.ContainsKey($id); $valT = if ($hasT) { $mapT[$id] } else { $null }
        $p = $path + '#' + $id
        if (-not $hasM -and -not $hasT) { continue }
        if (-not $hasB) {
            if (-not $hasM) { $out += $valT; continue }
            if (-not $hasT) { $out += $valM; continue }
            if ((Get-Canon $valM) -ceq (Get-Canon $valT)) { $out += $valM; continue }
            Add-Conflict $conflicts (@{ path = $p; kind = 'both-added' })
            $out += (Select-Deterministic $valM $valT); continue
        }
        if (-not $hasM -or -not $hasT) {
            # 一方删了、另一方还在：只有「没动过」才尊重删除，否则编辑优先，避免误删同事的改动
            $kept = if ($hasM) { $valM } else { $valT }
            if ((Get-Canon $kept) -ceq (Get-Canon $valB)) { continue }
            Add-Conflict $conflicts (@{ path = $p; kind = 'deleted-vs-edited' })
            $out += $kept; continue
        }
        if ((Get-Canon $valM) -ceq (Get-Canon $valT)) { $out += $valM; continue }
        if ((Get-Canon $valM) -ceq (Get-Canon $valB)) { $out += $valT; continue }
        if ((Get-Canon $valT) -ceq (Get-Canon $valB)) { $out += $valM; continue }
        $out += (Merge-Value $valB $valM $valT $p $conflicts ($depth + 1) (Get-EntityStamp $valM) (Get-EntityStamp $valT))
    }
    return @{ items = @($out) }
}

$script:MergeTopArrays = @('projects','tasks','notifications','tags','savedFilters','users')

# 主入口：三份 store 文本 → 合并后的文本 + 冲突清单
function Merge-StoreText([string]$baseText, [string]$mineText, [string]$theirsText) {
    # 冲突清单用哈希表累加器：函数参数里的数组会被复制（漏报），
    # 而 List[object] 在 PS5.1 被 @() 包裹会抛「参数类型不匹配」
    $conflicts = @{ items = @() }
    $b = Convert-ToTree ($baseText   | ConvertFrom-Json)
    $m = Convert-ToTree ($mineText   | ConvertFrom-Json)
    $t = Convert-ToTree ($theirsText | ConvertFrom-Json)
    if (-not $b) { $b = [ordered]@{} }
    if (-not $m) { $m = [ordered]@{} }
    if (-not $t) { $t = [ordered]@{} }
    $out = [ordered]@{}

    # meta 版本号取三方最大再 +1：合并结果必须比任何一侧都新，否则会被判成「更旧」而没人采纳
    $rev = 0
    foreach ($side in @($b, $m, $t)) {
        if ($side.Contains('meta') -and $side['meta'] -is [System.Collections.IDictionary] -and $side['meta'].Contains('rev')) {
            $n = 0; if ([long]::TryParse([string]$side['meta']['rev'], [ref]$n) -and $n -ge $rev) { $rev = $n }
        }
    }
    # 其余 meta 字段也必须与主客无关（与 JS 版一致）：旧版只留 rev/lastSaved 且用当前时间，
    # 两台机器对同一三元组算出的 meta 不同 → 内容哈希不同 → 反复触发冲突。
    # 规则：先比 rev、再比 lastSaved、最后比规范化字符串选出「较新一侧」；lastSaved 取两侧较大值。
    $mm = $null; $tm = $null
    if ($m.Contains('meta') -and $m['meta'] -is [System.Collections.IDictionary]) { $mm = $m['meta'] }
    if ($t.Contains('meta') -and $t['meta'] -is [System.Collections.IDictionary]) { $tm = $t['meta'] }
    $newer = $tm
    if ($mm -and -not $tm) { $newer = $mm }
    elseif ($mm -and $tm) {
        $ra = [long]0; $rb = [long]0
        [void][long]::TryParse([string]$mm['rev'], [ref]$ra)
        [void][long]::TryParse([string]$tm['rev'], [ref]$rb)
        if ($ra -gt $rb) { $newer = $mm }
        elseif ($ra -lt $rb) { $newer = $tm }
        else {
            $la = [long]0; $lb = [long]0
            [void][long]::TryParse([string]$mm['lastSaved'], [ref]$la)
            [void][long]::TryParse([string]$tm['lastSaved'], [ref]$lb)
            if ($la -gt $lb) { $newer = $mm }
            elseif ($la -lt $lb) { $newer = $tm }
            elseif ([System.StringComparer]::Ordinal.Compare((Get-Canon $mm), (Get-Canon $tm)) -le 0) { $newer = $mm }
        }
    }
    $meta = [ordered]@{}
    if ($newer) { foreach ($k in @($newer.Keys)) { if ($k) { $meta[[string]$k] = $newer[$k] } } }
    $maxLS = [long]0
    foreach ($side in @($mm, $tm)) {
        if ($side) { $v = [long]0; if ([long]::TryParse([string]$side['lastSaved'], [ref]$v) -and $v -gt $maxLS) { $maxLS = $v } }
    }
    $meta['rev'] = ($rev + 1)
    $meta['lastSaved'] = $maxLS
    $out['meta'] = $meta

    foreach ($k in $script:MergeTopArrays) {
        $hasAny = $m.Contains($k) -or $t.Contains($k)
        if (-not $hasAny) { continue }
        $mv = if ($m.Contains($k)) { $m[$k] } else { $null }
        $tv = if ($t.Contains($k)) { $t[$k] } else { $null }
        $bv = if ($b.Contains($k)) { $b[$k] } else { $null }
        if ((Test-HasIds $mv) -or (Test-HasIds $tv) -or (Test-HasIds $bv)) {
            $arr = Merge-ArrayById $bv $mv $tv $k $conflicts 0
            $out[$k] = @($arr.items)
        } elseif ($mv -is [System.Collections.IEnumerable] -or $tv -is [System.Collections.IEnumerable]) {
            $arr = Merge-ScalarArray $bv $mv $tv
            $out[$k] = @($arr.items)
        } else {
            $out[$k] = Merge-Value $bv $mv $tv $k $conflicts 0 $null $null
        }
    }

    if ($m.Contains('trash') -or $t.Contains('trash') -or $b.Contains('trash')) {
        $trash = [ordered]@{}
        $buckets = @{}
        foreach ($side in @($b['trash'], $m['trash'], $t['trash'])) {
            if ($side -is [System.Collections.IDictionary]) { foreach ($k in @($side.Keys)) { if ($k) { $buckets[[string]$k] = $true } } }
        }
        foreach ($k in ($buckets.Keys | Sort-Object)) {
            $bv = if ($b['trash'] -and $b['trash'].Contains($k)) { $b['trash'][$k] } else { $null }
            $mv = if ($m['trash'] -and $m['trash'].Contains($k)) { $m['trash'][$k] } else { $null }
            $tv = if ($t['trash'] -and $t['trash'].Contains($k)) { $t['trash'][$k] } else { $null }
            if ((Test-HasIds $mv) -or (Test-HasIds $tv)) {
                $arr = Merge-ArrayById $bv $mv $tv ('trash.' + $k) $conflicts 0
                $trash[$k] = @($arr.items)
            } else {
                $trash[$k] = Merge-Value $bv $mv $tv ('trash.' + $k) $conflicts 0 $null $null
            }
        }
        $out['trash'] = $trash
    }

    # 其它没列出的顶层键（老版本 / 将来新增的集合）也参与合并，避免静默丢字段
    $allKeys = @{}
    foreach ($side in @($m, $t)) { foreach ($k in @($side.Keys)) { if ($k) { $allKeys[[string]$k] = $true } } }
    foreach ($k in ($allKeys.Keys | Sort-Object)) {
        if ($k -eq 'meta' -or $k -eq 'trash' -or ($script:MergeTopArrays -contains $k)) { continue }
        if ($out.Contains($k)) { continue }
        $bv = $null
        if ($b.Contains($k)) { $bv = $b[$k] }
        $out[$k] = Merge-Value $bv $m[$k] $t[$k] $k $conflicts 0 $null $null
    }

    # ConvertTo-Json 会把空数组写成 null，而页面遇到 null 数组会整片白屏
    # （「项目缺 memberIds 直接 TypeError」就是同一类事故）→ 已知的数组键一律归一成 []
    foreach ($k in $script:MergeTopArrays) {
        if ($out.Contains($k) -and $null -eq $out[$k]) { $out[$k] = @() }
    }
    if ($out.Contains('trash') -and $out['trash'] -is [System.Collections.IDictionary]) {
        foreach ($k in @($out['trash'].Keys)) { if ($null -eq $out['trash'][$k]) { $out['trash'][$k] = @() } }
    }
    return @{ text = (($out | ConvertTo-Json -Depth 60 -Compress)); conflicts = @($conflicts.items) }
}

# 是否要走合并：三份都在、且双方相对祖先都改过（与 JS 版 needsMerge 同表）。
# 缺任何一份都不算分歧：本机没有 → 直接拉；盘上还没有 → 直接推。
# 拿 null 参与合并会把版本号再顶高一次，新电脑拉回来的就不是别人刚推的那一版。
function Test-NeedsMerge($baseText, $mineText, $theirsText) {
    if ([string]::IsNullOrEmpty($baseText) -or [string]::IsNullOrEmpty($mineText) -or [string]::IsNullOrEmpty($theirsText)) { return $false }
    if ($mineText -eq $theirsText) { return $false }
    if ($mineText -eq $baseText) { return $false }
    if ($theirsText -eq $baseText) { return $false }
    return $true
}
