# DESIGN.md — FlowTask 设计系统

> 本文件描述 FlowTask **当前已实现**的视觉与交互规范（从 `FlowTask_本地项目管理平台.html` 的
> `:root` 与组件样式中提取，未做任何视觉改动）。改样式前先来这里登记，避免同一概念出现第二套值。
>
> 版本：v2.0.0 · 提取日期：2026-09-25 · 风格定位：本地优先的团队任务台（深青品牌色 + 白底高密度信息）

---

## 1. Visual Theme & Atmosphere（整体基调）

- **气质**：干净、克制、信息优先。白底 + 细边框 + 极轻阴影，不靠装饰抢注意力。
- **密度**：面向"每天要看几十次"的工作列表，行高紧凑（任务行 9px 上下内边距），字号偏小（正文 13–14px）。
- **色彩策略**：界面本身接近无彩色（白 / 灰 / 浅灰边框），**颜色只用于表达语义**——品牌动作、状态、优先级、危险操作。
- **动效**：只服务于"东西从哪来、到哪去"。全部 ≤ 250ms，`ease` 缓动；`prefers-reduced-motion` 下关闭骨架动画。
- **字体**：系统字体栈，不加载任何外部资源（CSP `default-src 'none'`，零网络请求）。

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
font-size: 14px;   /* body 基准；组件内部按需下沉到字阶变量 */
color: #1f2430;    /* --text */
background: #ffffff;
```

---

## 2. Color Palette & Roles（色彩与用途）

### 2.1 品牌与中性色

| Token | 值 | 用途 |
|---|---|---|
| `--brand` | `#0F766E` | 主品牌色：主按钮、当前导航高亮、拖拽落点指示线、链接强调 |
| `--brand-dark` | `#0B5D56` | 主按钮 hover / 危险偏红的次级强调 |
| `--brand-light` | `#E9F2F0` | 品牌色的极浅底（未读通知、今日格、hover 染底） |
| `--bg` | `#ffffff` | 主表面 |
| `--bg-sub` | `#f7f8fa` | 次级表面（统计卡、代码块、侧栏 `#fbfbfc`） |
| `--bg-hover` | `#f2f3f5` | 通用 hover 底 |
| `--border` | `#e2e4e8` | 常规分隔线 / 卡片描边 |
| `--border-strong` | `#c9ccd2` | 输入框描边、次要按钮描边 |
| `--text` | `#1f2430` | 主文本 |
| `--text-sub` | `#6b7280` | 次文本（标签、说明） |
| `--text-faint` | `#9aa1ac` | 弱文本（计数、时间）——**只用于 ≥11px 的辅助信息，正文不得下沉到这里** |

### 2.2 状态语义色板（唯一真相源）

`待办 / 进行中 / 已完成` 三个状态在**行内 pill、状态选择器、小圆点、看板列头、日历、甘特**里必须是同一套值。
JS 侧由 `STATUS_DEF` 派生，CSS 侧只允许引用下列变量，**不允许再写死 hex**。

| 状态 | 文字 `--st-*-fg` | 底色 `--st-*-bg` | 圆点 `--st-*-dot` |
|---|---|---|---|
| 待办 todo | `#64748b` | `#eef1f5` | `#c3c9d3` |
| 进行中 doing | `#b45309` | `#fdf3e3` | `#e8850c` |
| 已完成 done | `#2e9e5b` | `#e7f6ed` | `#2e9e5b` |

### 2.3 优先级语义色板（与状态刻意区隔）

优先级**不使用实心填充**，只用「左侧 3px 色条 + 彩色文字」；实心 pill 是标签的专属形态。
这样红色标签「紧急」不会被误读成高优先级。

| 优先级 | 文字 `--prio-*-fg` | 色条 `--prio-*-bar` | 备用底 `--prio-*-bg` |
|---|---|---|---|
| 高 high | `#b91c1c` | `#dc2626` | `#fdecec` |
| 中 med | `#b45309` | `#e8850c` | `#fdf3e3` |
| 低 low | `#1d4ed8` | `#3b82f6` | `#eaf2fe` |

### 2.4 其他语义色

| Token | 值 | 用途 |
|---|---|---|
| `--green` / `--green-light` | `#2e9e5b` / `#e7f6ed` | 成功、已完成、"已保存" |
| `--orange` / `--orange-light` | `#e8850c` / `#fdf3e3` | 警告、临近截止 |
| `--blue` / `--blue-light` | `#3b82f6` / `#eaf2fe` | 信息、归档横幅 |
| `--red` | `#dc2626` | 危险操作、逾期、校验错误 |
| `--purple` `#8b5cf6` / `--teal` `#14b8a6` | | 标签与项目配色池成员 |
| 项目 / 头像色池 | `#0F766E #3b82f6 #2e9e5b #e8850c #8b5cf6 #14b8a6 #ec4899 #f59e0b #06b6d4 #84cc16` | 按 id 哈希取色，同一实体颜色稳定 |
| Toast 底色 | 默认 `#2b2f3a` · 成功 `#155e33` · 错误 `#b91c1c` | 深底白字，浮在内容之上 |

---

## 3. Typography Rules（字体与字阶）

| Token | 值 | 用途 |
|---|---|---|
| `--fs-xs` | `11px` | 计数、徽标、状态 pill、关注人按钮 |
| `--fs-sm` | `12.5px` | 次要说明、筛选摘要、时间戳 |
| `--fs-base` | `13.5px` | 正文与列表标题（任务标题 13.5/500） |
| `--fs-md` | `15px` | 视图小标题、项目内导航 |
| `--fs-lg` | `19px` | 页面标题（h1） |
| `--fs-xl` | `24px` | 登录页品牌标题 |

- 字重：正文 `400/500`，标签与按钮 `600/700`，徽标与 pill `800`。
- 行高：正文 `1.5–1.6`，说明性长文本 `1.75–1.8`。
- 中文优先使用系统栈中的 `PingFang SC / Microsoft YaHei`，不做字体下载。
- **新增文字请从上面六档取值**；现存 9–10.5px 的极小字是历史遗留，只减不增。

---

## 4. Component Stylings（组件规范）

### 按钮 `.btn`
```
display:inline-flex; gap:6px; padding:7px 14px; border-radius:6px;
font-weight:600; font-size:13px; border:1px solid transparent; transition:all .15s
```
| 变体 | 样式 | 用在哪 |
|---|---|---|
| `.btn-primary` | 底 `--brand` / 字 `#fff`，hover `--brand-dark` | 每个弹窗**唯一**主行动 |
| `.btn-outline` | 描边 `--border-strong` / 字 `--text`，hover `--bg-hover` | 次级动作、取消 |
| `.btn-ghost` | 无底，字 `--text-sub` | 工具栏内的弱操作 |
| `.btn-danger` | 底 `#fdecec`，字 `--red`，hover `#f9d4d4` | 破坏性动作（提交前必须二次确认） |
| `.btn-sm` | `padding:4px 10px; font-size:12px` | 卡片内联操作 |
| `.btn-icon` | `padding:6px; border-radius:6px` | 纯图标按钮（**必须带 title**） |

规则：主按钮动词随对象走（创建项目 / 添加任务 / 保存设置 / 发布 / 移出项目），不允许裸"确定"；
提交中按钮 `disabled` 并显示"处理中…"；破坏性动作在对话框里改 `.btn-danger`。

### 卡片
| 组件 | 样式 |
|---|---|
| `.home-card` | `border:1px solid --border; border-radius:12px; padding:18px 20px; background:#fff` |
| `.stat-card` | `background:--bg-sub; border:1px solid --border; border-radius:10px; padding:16px; min-width:150px` |
| `.board-card` | `border-radius:8px; padding:11px 12px; box-shadow:--shadow`，hover 抬升 `0 3px 12px rgba(16,24,40,.12)`，拖拽中 `opacity:.45; rotate(2deg)` |

### 任务行 `.task-row`
`padding:9px 10px 9px 14px; border-radius:8px; border-top:1px solid #f0f1f3; gap:12px`，hover `--bg-hover`。
一行内**最多 2 个标签 + `+N` 收纳**；截止徽章是唯一允许的高饱和色块；头像出现时不再重复显示关注人计数。

### 输入与表单
```
.field{ display:flex; flex-direction:column; gap:6px; margin-bottom:16px }
.field label{ font-size:13px; font-weight:600; color:--text-sub }
input/select/textarea{ border:1px solid --border-strong; border-radius:6px; padding:8px 12px; width:100% }
:focus{ border-color:--brand; box-shadow:0 0 0 3px rgba(226,77,92,.12) }
```
错误态：`.fld-err`（红边 + `0 0 0 3px rgba(220,38,38,.1)`）+ 字段下方 `.fld-err-tip`（12px `--red`，前面一个 `!` 圆点）+ `aria-invalid`，并自动聚焦到第一个出错字段。**不用 toast 报字段错误。**

### 选择器 chip
| 组件 | 样式 |
|---|---|
| `.f-chip`（筛选） | `padding:3px 11px; border-radius:16px; border:1px solid --border-strong`；**选中态为深底白字**（`--text` 底） |
| `.tag-chip`（标签） | `border-radius:14px; font-weight:800`；未选=白底描边，选中=标签色实心 + 白字 |
| `.status-pill` | `font-size:--fs-xs; font-weight:800; padding:1px 8px; border-radius:--radius-pill`，取 `--st-*` |
| `.prio-pill` | `border-left:3px solid --prio-*-bar; color:--prio-*-fg`，**无背景填充** |

### 浮层
| 组件 | 样式 |
|---|---|
| `.modal` | `width:440px; max-width:92vw; border-radius:12px; box-shadow:--shadow-lg`，入场 `translateY(14px) scale(.98) → none` 180ms；遮罩 `rgba(20,24,32,.45)` |
| `#drawer`（详情抽屉） | `width:--detail-w(480px); max-width:96vw; box-shadow:--shadow-lg`，`translateX(100%) → 0` 220ms |
| `.toast` | `background:#2b2f3a; padding:10px 20px; border-radius:8px; box-shadow:--shadow-lg`，入场 250ms；普通 2.6s、带撤销 6s |
| `.batch-bar` | 深色浮底（`#2b2f3a` 系），白字按钮，删除项用 `#fca5a5` |

### 空态 / 三态
- 空态：一句状态 + 一句"为什么是空" + 一个主动作按钮（`.empty-hint` 12px `--text-faint`）。
- 筛选后为空：必须区分"真没有"与"被筛选藏起来（本状态共 N 项）"，并给「清除筛选」`.link-btn`。
- 加载：启动探测期显示骨架（侧栏 + 卡片灰块，1.15s 呼吸），不闪登录页。
- 错误：说人话 + 下一步动作，不出现 HTTP 码、英文异常原文、内部字段名。

---

## 5. Layout Principles（布局与间距）

| 区域 | 尺寸 |
|---|---|
| 顶栏 `--topbar-h` | `52px`，`padding:0 16px; gap:14px`，白底 + 下边框 |
| 侧栏 `--sidebar-w` | `248px`（`#fbfbfc` 底，右描边），导航项 `padding:8px 12px` |
| 详情抽屉 `--detail-w` | `480px`（窄屏降为 `min(480px,100vw)`） |
| 内容区 | `padding:0 32px 80px`，无最大宽度限制（宽屏利用空间） |
| 今天页栅格 `.home-grid` | `1fr 1fr`，`gap:18px`；`≤640px` 降为单列 |
| 统计条 `.ov-stats` | 4 列 → `≤640px` 单列 |
| 间距节奏 | 8px 基准：`4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 20 / 24` |

层级顺序（今天页）：**今天要处理（唯一主焦点，全宽）→ 未来 7 天 + 最近讨论（次要栅格）→ 项目概览（列表）**。
统计数字降级为一行内联文字，不做四张大数字卡。

---

## 6. Depth & Elevation（层级与阴影）

| 层级 | 值 | 用在 |
|---|---|---|
| 平面 | 无阴影 + `--border` 描边 | 卡片、列表、输入框 |
| 浮起 | `--shadow` `0 1px 3px rgba(16,24,40,.08), 0 1px 2px rgba(16,24,40,.04)` | 看板卡片、静态小卡 |
| 高层 | `--shadow-lg` `0 12px 32px rgba(16,24,40,.14), 0 2px 8px rgba(16,24,40,.08)` | 弹窗、抽屉、toast、下拉 |
| z-index | 顶栏 50 → 遮罩 600 → 抽屉 610 → 侧栏浮层 640 → 弹窗 900 → 浮层菜单 950 → toast 1000 | 严格分层，不得插队 |

---

## 7. Do's and Don'ts（设计护栏）

**Do**
- 颜色只表达语义；同一语义只允许一个来源（状态 → `--st-*`，优先级 → `--prio-*`）。
- 圆角只用 `--radius-sm(4) / --radius(8) / --radius-lg(12) / --radius-pill`；字号只用第 3 节六档。
- 每个纯图标按钮必须有 `title`（并在渲染后由 `enhanceA11y` 补 `aria-label`）。
- 破坏性动作：确认框 + 说明后果（会连带什么、能不能恢复、保留多久）+ 尽量给 6 秒撤销。
- 删除统一两级词汇：**删除**（进回收站，30 天可恢复）/ **彻底删除**（不可恢复）。
- 术语以 README 的术语表为准：任务 / 子任务 / 负责人 / 项目创建人 / 关注人 / 状态 / 优先级（高·中·低）；导航叫 今天 / 我的任务 / 通知，项目视图叫 详情 / 列表 / 看板 / 日历 / 排期，项目层播报叫「项目播报」。
- 新组件先在此登记样式契约，再写代码。

**Don't**
- 不要在组件里写死 hex 颜色、圆角、字号——一律取变量。
- 不要用实心 pill 表达优先级（那是标签的形态）。
- 不要用 `alert/confirm/prompt` 原生弹窗承载业务确认（用 `openConfirm`）。
- 不要让一个弹窗出现两个实心主按钮；危险动作永远不是默认按钮。
- 不要用 `--text-faint` 承载正文，也不要新增 <11px 的文字。
- 不要用 emoji 当功能图标（尺寸颜色不可控）；emoji 只允许出现在问候语等纯文本里。
- 不要把内部词汇漏给用户：`rev / token / conflict / JSON / users / 数组 / id`。

---

## 8. Responsive Behavior（响应式）

| 断点 | 行为 |
|---|---|
| `> 1024px` | 三栏：侧栏 248 + 内容 + 抽屉 480（覆盖在右侧） |
| `≤ 900px` | 侧栏改为**浮层抽屉**（`position:fixed`，默认移出画布），顶栏出现汉堡按钮；展开时加半透明遮罩；点导航后自动收起；`html,body{overflow-x:clip}` 防止收起态元素撑大布局视口 |
| `≤ 640px` | 顶栏隐藏品牌文字 / 快速添加按钮 / 用户名，存储胶囊截断；今天页与详情栅格降单列；`.field-row2` 降单列；内容左右内边距降到 16px |
| 触控 | 勾选圈、分组头加号、状态/优先级 pill 用伪元素把热区撑到 ≥28px（视觉尺寸不变） |

- 视口 meta：`width=device-width, initial-scale=1`。
- 键盘：所有 div/span 型可点元素渲染后补 `tabindex=0` + `role=button`，Enter/Space 可激活；焦点环统一 `outline:2px solid --brand`。
- 动效：`prefers-reduced-motion: reduce` 下关闭骨架呼吸。

---

## 9. Agent Prompt Guide（给 AI 的即用清单）

**核心色**
```
品牌 #0F766E · 品牌深 #0B5D56 · 品牌浅 #E9F2F0
文本 #1f2430 / #6b7280 / #9aa1ac   背景 #fff / #f7f8fa / #f2f3f5   描边 #e2e4e8 / #c9ccd2
状态：待办 #64748b on #eef1f5 · 进行中 #b45309 on #fdf3e3（点 #e8850c）· 已完成 #2e9e5b on #e7f6ed
优先级：高 #b91c1c（条 #dc2626）· 中 #b45309（条 #e8850c）· 低 #1d4ed8（条 #3b82f6）—— 只用色条不用底色
危险 #dc2626 on #fdecec   成功 #2e9e5b   警告 #e8850c
```

**改 UI 时必须遵守**
1. 单文件、零外部资源（CSP `default-src 'none'`），不引入 CDN 字体或图标库。
2. 新颜色先进 `:root` 再使用；组件里只写 `var(--…)`。
3. 状态相关的一切从 `STATUS_DEF` 取，禁止再写第二套状态名或状态色。
4. 文案遵循 README 术语表；错误提示说人话并给下一步。
5. 每个可点元素要能键盘到达，每个图标按钮要有 `title`。
6. 改完跑：`node tests/syntax_check.js` → `node tests/flowtask_test.js` → `node tests/flowtask_e2e.js`。
