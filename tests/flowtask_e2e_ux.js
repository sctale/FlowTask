/* FlowTask E2E · UX 场景集（由 tests/flowtask_e2e.js 注入断言工具后执行）
 * 只覆盖"必须在真实浏览器里才能证明"的行为：渲染结果、计算样式、键盘、视口、版本冲突。
 * 约定：传给 evaluate/waitFor 的 IIFE 表达式一律以 ")()" 结尾，避免与宿主的函数字面量猜测冲突。
 */
module.exports = function defineUxScenarios(ctx){
  const { t, assertTruthy, assertEq, assertMatch, getPage, getBrowser, getBase, loginAs } = ctx;
  const Q = v => JSON.stringify(v);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const toList = `(() => { const p = DB.projects.filter(x=>!x.archived)[0] || DB.projects[0]; nav('#/project/' + p.id + '/list'); })()`;

  t('U1 分组头「＋」预选对应状态列（v1.3 取值 bug 回归）', async () => {
    const page = getPage();
    await page.evaluate(toList);
    await page.waitForSelector('.task-row');
    assertTruthy(await page.evaluate(`(() => !!document.querySelector('[data-st-add="doing"]'))()`), '列表视图应有「进行中」分组头的＋按钮');
    await page.evaluate(`(() => { document.querySelector('[data-st-add="doing"]').click(); })()`);
    await page.waitForSelector('#qa-status');
    const st = await page.evaluate(`(() => document.querySelector('#qa-status .sec-preset.on').dataset.st)()`);
    assertEq(st, 'doing', '从「进行中」分组点＋，快速添加应预选「进行中」');
    await page.evaluate(`(() => { maskRemoveAll(); })()`);
  });

  t('U2 抽屉删除按钮文案与真实行为一致（回收站可恢复）', async () => {
    const page = getPage();
    await page.evaluate(`(() => { openDrawer(DB.tasks[0].id); })()`);
    await page.waitForSelector('#dt-del');
    const info = await page.evaluate(`(() => ({
      text: document.getElementById('dt-del').textContent.trim(),
      title: document.getElementById('dt-del').getAttribute('title') || '',
      hint: (document.querySelector('.dt-danger-hint') || {}).textContent || ''
    }))()`);
    assertTruthy(!/永久删除/.test(info.text), '按钮不应再写"永久删除"：' + info.text);
    assertTruthy(/删除任务/.test(info.text), '按钮文案应为「删除任务」：' + info.text);
    assertTruthy(/回收站/.test(info.title) && /回收站/.test(info.hint), 'title 与说明应提到回收站/可恢复：' + JSON.stringify(info));
    await page.evaluate(`(() => { closeDrawer(); })()`);
  });

  t('U3 弹窗未保存守卫 + Esc 只关栈顶一层', async () => {
    const page = getPage();
    await page.evaluate(`(() => { openProjectModal(); })()`);
    await page.waitForSelector('#np-name');
    await page.type('#np-name', '写到一半的名字');
    await page.key('Escape');
    await page.waitFor(`(() => MODAL_STACK.length === 2)()`, { name:'应弹出挽留确认（栈深 2）' });
    const topText = await page.evaluate(`(() => document.querySelector('.modal-mask:last-of-type .modal-head h3').textContent)()`);
    assertMatch(topText, /放弃已输入/, '顶层应是挽留确认，实际：' + topText);
    await page.screenshot('guard-unsaved-confirm');
    await page.evaluate(`(() => { closeTopModal(true); })()`);
    assertEq(await page.evaluate(`(() => MODAL_STACK.length)()`), 1, '关闭只应去掉一层，剩下的仍是新建项目弹窗');
    await page.evaluate(`(() => { maskRemoveAll(); })()`);
    assertEq(await page.evaluate(`(() => MODAL_STACK.length)()`), 0, '清理后栈应为空');
  });

  t('U4 勾选任务后顶栏出现「已保存 + 时间」且时间戳前进', async () => {
    const page = getPage();
    await page.evaluate(`(() => { nav('#/'); })()`);
    const before = await page.evaluate(`(() => ({ ts: Number(_lastSavedAt) || 0, text: document.getElementById('store-status').textContent.trim() }))()`);
    await page.evaluate(`(() => { toggleTaskDone(DB.tasks[0].id); })()`);
    await page.waitFor(`(() => /已保存 \\d\\d:\\d\\d:\\d\\d/.test(document.getElementById('store-status').textContent))()`,
      { timeout: 15000, name:'等待「已保存 HH:MM:SS」' });
    const after = await page.evaluate(`(() => ({ ts: Number(_lastSavedAt) || 0, text: document.getElementById('store-status').textContent.trim(),
      ok: document.getElementById('store-status').classList.contains('ok'), stored: !!JSON.parse(localStorage.getItem(DB_KEY)) }))()`);
    assertTruthy(after.ts > before.ts, `时间戳应前进：${before.ts} → ${after.ts}`);
    assertTruthy(/已保存 \d{2}:\d{2}:\d{2}/.test(after.text), '保存态应带时间：' + after.text);
    assertTruthy(after.ok, '已保存态应有 ok 样式');
    assertTruthy(after.stored, 'localStorage 里应有数据');
    await page.evaluate(`(() => { toggleTaskDone(DB.tasks[0].id); })()`);   // 复原
  });

  t('U5 快速添加一句话解析端到端（@人 / 日期 / 优先级）', async () => {
    const page = getPage();
    const me = await page.evaluate(`(() => ({ id: ME.id, name: ME.name }))()`);
    await page.evaluate(`(() => { openQuickAddModal(); })()`);
    await page.waitForSelector('#qa-title');
    await page.type('#qa-title', 'E2E报价核对 @' + me.name + ' 明天 !高');
    await page.waitFor(`(() => document.getElementById('qa-parse').textContent.includes('已识别'))()`, { name:'识别回显出现' });
    const preview = await page.evaluate(`(() => document.getElementById('qa-parse').textContent)()`);
    assertTruthy(preview.includes('负责人 ' + me.name) && /优先级 高/.test(preview), '预览应列出识别结果：' + preview);
    assertEq(await page.evaluate(`(() => document.getElementById('qa-assignee').value)()`), String(me.id), '负责人控件应被回填');
    assertTruthy(await page.evaluate(`(() => !!document.getElementById('qa-due').value)()`), '截止日期控件应被回填');
    await page.click('.modal-ok');
    /* v1.7.4：主按钮「添加」创建后即关闭弹窗（此前"添加完不关"是 bug） */
    await page.waitFor(`(() => {
      const t = DB.tasks.filter(x => x.title === 'E2E报价核对').pop();
      return MODAL_STACK.length === 0 && !!t;
    })()`, { name:'点「添加」应创建任务并关闭弹窗' });
    const task = await page.evaluate(`(() => {
      const list = DB.tasks.filter(t => t.title === 'E2E报价核对');
      const x = list[list.length - 1];
      return x ? { title:x.title, assigneeId:x.assigneeId, priority:x.priority, dueDate:x.dueDate, today: todayStr() } : null;
    })()`);
    assertTruthy(task, '应创建出标题已剥离 token 的任务「E2E报价核对」');
    assertEq(task.assigneeId, String(me.id), '负责人应写入数据');
    assertEq(task.priority, 'high', '优先级应为 high');
    assertTruthy(/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) && task.dueDate !== task.today, '截止日期应写入且不是今天：' + task.dueDate);
    /* 「＋ 添加并继续」才是连续录入路径：创建后弹窗保持打开、标题清空、上下文保留 */
    await page.evaluate(`(() => { openQuickAddModal(); })()`);
    await page.waitForSelector('#qa-title');
    await page.type('#qa-title', 'E2E连续录入第二条');
    await page.evaluate(`(() => { document.getElementById('qa-again').click(); })()`);
    await page.waitFor(`(() => {
      const t = DB.tasks.filter(x => x.title === 'E2E连续录入第二条').pop();
      const inp = document.getElementById('qa-title');
      return !!t && MODAL_STACK.length === 1 && inp && inp.value === '';
    })()`, { timeout: 15000, name:'「添加并继续」应创建任务并保持弹窗打开、清空标题' });
    await page.evaluate(`(() => { maskRemoveAll(); })()`);
    await page.evaluate(`(() => {
      const ids = DB.tasks.filter(t=>t.title==='E2E报价核对' || t.title==='E2E连续录入第二条').map(t=>t.id);
      trashTaskIds(ids); saveDB(); renderApp();
    })()`);
  });

  t('U6 纯键盘可完成任务：Tab 聚焦任务行 → Enter 打开抽屉 → Esc 关闭', async () => {
    const page = getPage();
    await page.evaluate(toList);
    await page.waitForSelector('.task-row');
    const attrs = await page.evaluate(`(() => {
      const row = document.querySelector('.task-row');
      row.focus();
      return { tabindex: row.getAttribute('tabindex'), role: row.getAttribute('role'), focused: document.activeElement === row };
    })()`);
    assertEq(attrs.tabindex, '0', '任务行应可 Tab 聚焦（tabindex=0）');
    assertEq(attrs.role, 'button', '任务行应有 role=button');
    assertTruthy(attrs.focused, 'focus() 后应成为 activeElement');
    await page.key('Enter');
    await page.waitFor(`(() => document.getElementById('drawer').classList.contains('on'))()`, { name:'Enter 应打开任务详情' });
    await page.key('Escape');
    await page.waitFor(`(() => !document.getElementById('drawer').classList.contains('on'))()`, { name:'Esc 应关闭详情' });
  });

  t('U7 390px 窄屏：汉堡菜单 + 抽屉式侧栏 + 内容不横向溢出', async () => {
    const page = getPage();
    await page.setViewport(390, 844, true);
    await page.evaluate(`(() => { document.body.classList.remove('side-open'); nav('#/'); })()`);
    // 侧栏 transform 带 .2s 过渡，等它落位后再量（否则读到过渡起点的 identity）
    await page.waitFor(`(() => document.getElementById('sidebar').getBoundingClientRect().left <= -200)()`, { timeout: 5000, name:'侧栏过渡落位到画布外' });
    const probe = await page.evaluate(`(() => { const sb = document.getElementById('sidebar'); const cs = getComputedStyle(sb);
      return { w: window.innerWidth, hit: matchMedia('(max-width:900px)').matches, pos: cs.position,
        tf: cs.transform, left: Math.round(sb.getBoundingClientRect().left),
        toggle: getComputedStyle(document.getElementById('side-toggle')).display }; })()`);
    assertEq(probe.hit, true, '390px 视口应命中窄屏断点：' + JSON.stringify(probe));
    assertTruthy(probe.w <= 430, '390px 视口下布局视口不应被顶栏撑宽（顶栏需可收缩）：' + JSON.stringify(probe));
    assertTruthy(probe.toggle !== 'none', '汉堡按钮应显示：' + JSON.stringify(probe));
    assertEq(probe.pos, 'fixed', '窄屏下侧栏应改为浮层定位：' + JSON.stringify(probe));
    assertTruthy(probe.left <= -200, '默认侧栏应藏在画布外：' + JSON.stringify(probe));
    await page.click('#side-toggle');
    await page.waitFor(`(() => document.body.classList.contains('side-open'))()`, { name:'点汉堡应展开侧栏' });
    await page.waitFor(`(() => document.getElementById('sidebar').getBoundingClientRect().left >= 0)()`, { timeout: 5000, name:'侧栏展开过渡落位' });
    const on = await page.evaluate(`(() => Math.round(document.getElementById('sidebar').getBoundingClientRect().left))()`);
    assertTruthy(on >= 0, '展开后侧栏应进入画布，实际 left=' + on);
    await page.evaluate(`(() => { document.body.classList.remove('side-open'); })()`);
    const box = await page.evaluate(`(() => { const c = document.getElementById('content');
      return { sw: c.scrollWidth, cw: c.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth }; })()`);
    assertTruthy(box.sw <= box.cw + 2, '首页内容不应横向溢出：' + JSON.stringify(box));
    assertTruthy(box.doc <= 2, '整页不应出现横向滚动：' + JSON.stringify(box));
    await page.screenshot('narrow-390-home');
    await page.setViewport(1440, 900);
  });

  t('U8 状态色板单一真相源（计算样式与 :root 令牌一致）', async () => {
    const page = getPage();
    const got = await page.evaluate(`(() => {
      const rs = getComputedStyle(document.documentElement);
      const read = v => rs.getPropertyValue(v).trim();
      const toRgb = hex => { const h = hex.replace('#',''); return 'rgb(' + [0,2,4].map(i => parseInt(h.slice(i,i+2),16)).join(', ') + ')'; };
      const pick = (cls, prop) => { const el = document.createElement('span'); el.className = cls; document.body.appendChild(el);
        const v = getComputedStyle(el)[prop]; el.remove(); return v; };
      return {
        pillBg: pick('status-pill s-doing', 'backgroundColor'),
        pillFg: pick('status-pill s-doing', 'color'),
        dotBg:  pick('status-chip s-doing', 'backgroundColor'),
        wantBg: toRgb(read('--st-doing-bg')), wantFg: toRgb(read('--st-doing-fg')), wantDot: toRgb(read('--st-doing-dot'))
      };
    })()`);
    assertEq(got.pillBg, got.wantBg, '进行中 pill 背景应来自 --st-doing-bg');
    assertEq(got.pillFg, got.wantFg, '进行中 pill 文字应来自 --st-doing-fg');
    assertEq(got.dotBg, got.wantDot, '进行中圆点应来自 --st-doing-dot（与状态选择器同源）');
  });

  t('U9 个人库真冲突：弹窗可选，「保留我的改动」能找回数据', async () => {
    const page = getPage();
    // 把本地版本号人为退到"服务端前一版"，再改一次数据 → 推送必然撞上更高版本（真冲突）
    await page.evaluate(`(async () => {
      _bcSuppress = true;
      const r = await fetch(STORE_SVC + '/api/version?file=' + encodeURIComponent(personalFileOf()),
        { cache:'no-store', headers: storeHeaders() });
      const serverRev = Number((await r.json()).rev) || 0;
      _revs.personal = Math.max(0, serverRev - 1);
      _wrote.personal = '';
      // 冲突要发生在个人库：任务必须落在 scope 非 shared 的项目里
      let p = DB.projects.filter(x => x.scope !== 'shared' && !x.archived)[0];
      if(!p){
        p = { id:'p_e2e_conflict', name:'E2E冲突项目', color:'#8b5cf6', desc:'', ownerId: ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt: Date.now(), statusUpdates:[] };
        DB.projects.push(p);
      }
      createTask(p.id, 'todo', 'A页的改动标记', {});
    })()`);
    await page.waitFor(`(() => !!document.querySelector('#cf-mine'))()`, { timeout: 25000, name:'等待冲突对话框' });
    const dlg = await page.evaluate(`(() => ({
      head: document.querySelector('.modal-mask:last-of-type .modal-head h3').textContent,
      body: document.querySelector('.modal-mask:last-of-type .modal-body').textContent,
      hasDl: !!document.querySelector('#cf-dl'),
      copies: JSON.parse(localStorage.getItem('flowtask_conflict_copies') || '[]').length,
      lostNow: !DB.tasks.some(t => t.title === 'A页的改动标记')
    }))()`);
    assertMatch(dlg.head, /数据冲突/, '应出现冲突对话框：' + dlg.head);
    assertTruthy(/个人库/.test(dlg.body), '对话框要说明发生在哪个库：' + dlg.body.slice(0, 70));
    assertTruthy(dlg.hasDl, '应提供「下载我的副本」');
    assertTruthy(dlg.copies >= 1, '冲突副本应被登记，可在数据管理页找回');
    assertTruthy(dlg.lostNow, '采用对方版本后本页应暂时看不到自己的改动');
    await page.evaluate(`(() => { document.querySelector('#cf-mine').click(); })()`);
    await page.waitFor(`(() => MODAL_STACK.length === 2)()`, { name:'二次确认（会覆盖对方改动）' });
    await page.evaluate(`(() => { document.querySelector('.modal-mask:last-of-type .modal-ok').click(); })()`);
    await page.waitFor(`(() => DB.tasks.some(t => t.title === 'A页的改动标记'))()`, { timeout: 20000, name:'改动应被恢复' });
    assertTruthy(await page.evaluate(`(() => Number(_revs.personal) > 1)()`), '恢复后个人库版本号应前进');
    await page.evaluate(`(() => { _bcSuppress = false;
      trashTaskIds(DB.tasks.filter(t=>t.title==='A页的改动标记').map(t=>t.id)); saveDB(); renderApp(); })()`);
    await page.evaluate(`(() => { DB.projects = DB.projects.filter(x=>x.id!=='p_e2e_conflict');
      DB.tasks = DB.tasks.filter(t=>t.projectId!=='p_e2e_conflict'); saveDB(); renderApp(); })()`);
  });

  t('V1 未登录拿不到任何任务数据（只剩登录页）', async () => {
    const page = getPage();
    await page.evaluate(`(() => { clearSessionLocal(); })()`);
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'启动完成' });
    const st = await page.evaluate(`(() => ({
      auth: getComputedStyle(document.getElementById('auth-page')).display !== 'none',
      appOn: document.getElementById('app').classList.contains('on'),
      dbNull: (typeof DB === 'undefined') || DB === null,
      sess: loadSessionLocal()
    }))()`);
    assertTruthy(st.auth, '应停在登录页');
    assertTruthy(!st.appOn, '不应进入应用壳');
    assertTruthy(st.dbNull, '未登录时内存里不该有任何任务数据');
    assertTruthy(!st.sess, '会话应已清空');
    await page.screenshot('logged-out');
  });

  t('V2 两个账户数据互相看不见，共享项目双方可见', async () => {
    const page = getPage();
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'admin 登录' });
    await page.evaluate(`(() => {
      const p = { id:'p_e2e_private', name:'E2E私密项目', color:'#3b82f6', desc:'', ownerId: ME.id,
        memberIds:[ME.id], archived:false, scope:'personal', createdAt: Date.now(), statusUpdates:[] };
      DB.projects.push(p); saveDB();
    })()`);
    const adminView = await page.evaluate(`(() => DB.projects.map(p=>p.name))()`);
    assertTruthy(adminView.includes('E2E私密项目'), 'admin 应看到自己的私密项目：' + JSON.stringify(adminView));
    const sharedSeen = await page.evaluate(`(() => DB.projects.filter(p=>p.scope==='shared').map(p=>p.name))()`);
    assertTruthy(sharedSeen.length >= 1, 'admin 应看到团队共享项目：' + JSON.stringify(sharedSeen));

    await page.evaluate(`(() => { logout(); })()`);
    await page.waitFor(`(() => getComputedStyle(document.getElementById('auth-page')).display !== 'none')()`, { name:'回到登录页' });
    await page.fill('#li-username', 'member');
    await page.fill('#li-password', 'member123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'member 登录' });
    const memberView = await page.evaluate(`(() => DB.projects.map(p=>p.name))()`);
    assertTruthy(!memberView.includes('E2E私密项目'), 'member 不该看到 admin 的私密项目：' + JSON.stringify(memberView));
    assertTruthy(memberView.length >= 1, 'member 应有自己可见的项目（至少共享项目）');
    const leak = await page.evaluate(`(() => DB.tasks.filter(t=>t.projectId==='p_e2e_private').length)()`);
    assertEq(leak, 0, '私密项目下的任务也不该泄漏');
    await page.screenshot('account-isolation-member');
  });

  t('V3 共享与收回：项目归属切换会在两个物理库之间移动', async () => {
    const page = getPage();
    const before = await page.evaluate(`(() => {
      const p = { id:'p_e2e_share', name:'E2E待共享', color:'#2e9e5b', desc:'', ownerId: ME.id,
        memberIds:[ME.id], archived:false, scope:'personal', createdAt: Date.now(), statusUpdates:[] };
      DB.projects.push(p); saveDB();
      return { mine: DB.projects.filter(x=>x.id==='p_e2e_share').length, sharedRev: Number(_revs.shared) || 0 };
    })()`);
    assertEq(before.mine, 1, 'member 先建好自己的个人项目');
    await page.evaluate(`(() => { const p = DB.projects.find(x=>x.id==='p_e2e_share'); setProjectScope(p, 'shared'); })()`);
    await page.waitFor(`(() => MODAL_STACK.length === 1)()`, { name:'归属确认框' });
    await page.evaluate(`(() => { document.querySelector('.modal-mask:last-of-type .modal-ok').click(); })()`);
    await page.waitFor(`(() => { const p=(DB.projects||[]).find(x=>x.id==='p_e2e_share'); return p && p.scope==='shared'; })()`, { timeout: 20000, name:'项目变为共享' });
    assertEq(await page.evaluate(`(() => DB.projects.find(x=>x.id==='p_e2e_share').scope)()`), 'shared', '项目应已标记为共享');
    // 落盘是 400ms 防抖后的异步动作：等共享库版本号真正前进
    await page.waitFor(`(() => (Number(_revs.shared) || 0) > ${Number(before.sharedRev)})()`, { timeout: 20000, name:'共享库已写入' });
    const after = await page.evaluate(`(() => ({ sharedRev: Number(_revs.shared) || 0, personalRev: Number(_revs.personal) || 0 }))()`);
    assertTruthy(after.sharedRev > before.sharedRev, '共享库版本号应前进（说明真写进了 shared 文件）');
    assertTruthy(after.personalRev > 0, '个人库也应因项目移出而前进');

    const onDiskAfterShare = await page.evaluate(`(async () => {
      const r = await fetchStore('flowtask_shared.json','GET');
      const j = r.ok ? await r.json() : null;
      return { status: r.status, projects: j ? (j.projects||[]).map(p=>p.id) : null, rev: j && j.meta && j.meta.rev };
    })()`);
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'admin 登录' });
    const adminNow = await page.evaluate(`(async () => {
      const r = await fetchStore('flowtask_shared.json','GET');
      const j = r.ok ? await r.json() : null;
      return { view: DB.projects.filter(p=>p.id==='p_e2e_share').map(p=>p.scope),
               readStatus: r.status, disk: j ? (j.projects||[]).map(p=>p.id) : null, diskRev: j && j.meta && j.meta.rev,
               myRev: Number(_revs.shared) || 0, me: ME && ME.username, sess: !!(loadSessionLocal&&loadSessionLocal()),
               authN: AUTH?AUTH.users.length:-1, sharedInMem: DB.projects.filter(p=>p.scope==='shared').map(p=>p.id) };
    })()`);
    const sess = await page.evaluate(`(async () => {
      const ls = loadSessionLocal();
      const r = await fetch(STORE_SVC + '/api/session', { cache:'no-store', headers: storeHeaders() });
      const body = (await r.text()).slice(0, 60);
      const q = await fetchStore('flowtask_auth.json', 'GET');
      const authFile = q.ok ? (await q.json()).users.map(u=>u.username) : ('HTTP' + q.status);
      return { lsUid: ls && ls.uid, lsSess: ls && String(ls.session).slice(0, 26), meId: ME && ME.id,
               checkStatus: r.status, body, authFile, svc: SVC_MODE, tok: String(_svcToken).slice(0,6) };
    })()`);
    assertTruthy(adminNow.view.length === 1 && adminNow.view[0] === 'shared',
      'admin 应看到刚共享的项目。共享后盘上=' + JSON.stringify(onDiskAfterShare) + ' 现在=' + JSON.stringify(adminNow) + ' 会话=' + JSON.stringify(sess));

    /* ---- 标题里的另一半：收回。过去这条场景只测了"共享出去"，"收回"一个字都没断言，
       等于测试没在保护它却让人以为在保护。收回只能由创建人（这里是 member）执行——
       管理员收回别人的项目会把整项目划进管理员自己的个人库，原创建人从此哪都看不到。 ---- */
    await loginAs('member', 'member123', 'member（收回）');
    const asOwner = await page.evaluate(`(() => {
      const p = (DB.projects || []).find(x => x.id === 'p_e2e_share');
      return { seen: !!p, scope: p && p.scope, me: ME.username,
               pRev: Number(_revs.personal) || 0, sRev: Number(_revs.shared) || 0 };
    })()`);
    assertTruthy(asOwner.seen && asOwner.scope === 'shared',
      '创建人应仍能看到自己共享出去的项目：' + JSON.stringify(asOwner));
    await page.evaluate(`(() => { setProjectScope(DB.projects.find(x => x.id === 'p_e2e_share'), 'personal'); return true; })()`);
    const askBox = await page.waitFor(`(() => !![...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('收回为个人项目') >= 0))()`, { timeout: 15000, name:'收回要二次确认' });
    assertTruthy(!!askBox, '收回是不可逆地影响别人可见性，必须有确认框');
    await page.evaluate(`(() => { [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('收回为个人项目') >= 0).querySelector('.modal-ok').click(); return true; })()`);
    await page.waitFor(`(() => { const p = (DB.projects || []).find(x => x.id === 'p_e2e_share');
      return p && p.scope === 'personal'; })()`, { timeout: 20000, name:'项目收回为个人' });
    /* 两个库都要被重写：共享库少了它、个人库多了它，版本号都必须前进 */
    await page.waitFor(`(() => (Number(_revs.personal) || 0) > ${asOwner.pRev} && (Number(_revs.shared) || 0) > ${asOwner.sRev})()`,
      { timeout: 20000, name:'收回后两个库都前进' });
    const onDiskAfterPull = await page.evaluate(`(async () => {
      const s = await fetchStore('flowtask_shared.json', 'GET');
      const sj = s.ok ? JSON.parse(await s.text()) : null;
      const pf = await fetchStore(personalFileOf(), 'GET');
      const pj = pf.ok ? JSON.parse(await pf.text()) : null;
      return { file: personalFileOf(),
               stillInShared: !!(sj && (sj.projects || []).some(p => p.id === 'p_e2e_share')),
               backInMine: !!(pj && (pj.projects || []).some(p => p.id === 'p_e2e_share')) };
    })()`);
    assertTruthy(!onDiskAfterPull.stillInShared,
      '收回后共享库文件里不该再留着这个项目：' + JSON.stringify(onDiskAfterPull));
    assertTruthy(onDiskAfterPull.backInMine,
      '收回后项目应回到创建人自己的个人库文件：' + JSON.stringify(onDiskAfterPull));
    /* 收尾（先清掉本场景造的数据，避免污染后面的场景） */
    await page.evaluate(`(() => {
      DB.projects = DB.projects.filter(p => p.id !== 'p_e2e_share');
      DB.tasks = DB.tasks.filter(t => t.projectId !== 'p_e2e_share');
      saveDB(); renderApp(); return true;
    })()`);
    await loginAs('admin', 'admin123', 'admin（收回后）');
    const adminBlind = await page.evaluate(`(() => (DB.projects || []).filter(p => p.id === 'p_e2e_share').length)()`);
    assertEq(adminBlind, 0, '收回后 admin 的库里不该再有这个项目');
    await page.evaluate(`(() => { DB.projects = DB.projects.filter(p=>p.id!=='p_e2e_share' && p.id!=='p_e2e_private');
      DB.tasks = DB.tasks.filter(t=>t.projectId!=='p_e2e_share' && t.projectId!=='p_e2e_private'); saveDB(); renderApp(); })()`);
  });

  t('V4 记住 7 天免登录：刷新后直接进应用，会话有效期约 7 天', async () => {
    const page = getPage();
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重启完成' });
    const st = await page.evaluate(`(() => {
      const s = loadSessionLocal();
      return { appOn: document.getElementById('app').classList.contains('on'),
        days: s ? Math.round((Number(s.exp) - Date.now()) / 86400000) : -1, uid: s ? s.uid : null,
        sess: s ? String(s.session).slice(0,18) : null, cur: !!currentSessionUser(),
        authUsers: AUTH ? AUTH.users.length : -1, svc: SVC_MODE };
    })()`);
    assertTruthy(st.appOn, '会话未过期时应免登录直接进入：' + JSON.stringify(st));
    assertTruthy(st.days >= 6 && st.days <= 7, '会话应约 7 天有效，实际 ' + st.days + ' 天');
    assertTruthy(!!st.uid, '会话应绑定账户 id');
  });

  t('V5 反复进入不再弹数据冲突（假冲突回归）', async () => {
    const page = getPage();
    for(let i = 0; i < 3; i++){
      await page.goto(getBase() + '/');
      await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'第 ' + (i+1) + ' 次启动完成' });
      await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'进入应用' });
      await sleep(1600);
      const bad = await page.evaluate(`(() => ({
        conflict: !!document.querySelector('#cf-mine'),
        stack: MODAL_STACK.length,
        toasts: Array.prototype.map.call(document.querySelectorAll('.toast'), t=>t.textContent).join('|')
      }))()`);
      assertTruthy(!bad.conflict, '第 ' + (i+1) + ' 次进入不该弹冲突：' + bad.toasts);
      assertEq(bad.stack, 0, '第 ' + (i+1) + ' 次进入不该有遗留弹窗');
    }
  });

  t('U10 筛选按视图记住，并可存为团队筛选视图', async () => {
    const page = getPage();
    const pid = await page.evaluate(`(() => (DB.projects.filter(x=>!x.archived)[0] || DB.projects[0]).id)()`);
    await page.evaluate(`(() => { nav('#/project/' + ${Q(pid)} + '/list'); })()`);
    await page.waitForSelector('.task-row');
    await page.evaluate(`(() => { FILTER.prio = 'high'; rememberFilter(ROUTE.pid, ROUTE.view); renderApp(); })()`);
    await page.waitFor(`(() => FILTER.prio === 'high')()`);
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'刷新后回到应用' });
    await page.evaluate(`(() => { nav('#/project/' + ${Q(pid)} + '/list'); })()`);
    await page.waitForSelector('.task-row');
    assertEq(await page.evaluate(`(() => FILTER.prio)()`), 'high', '刷新后同一视图的筛选应被记住');
    await page.evaluate(`(() => { saveCurrentFilter(P.visibleProject(ROUTE.pid), ROUTE.view, 'E2E高优视图'); })()`);
    await page.waitFor(`(() => (DB.savedFilters || []).some(f => f.name === 'E2E高优视图'))()`, { name:'视图已保存' });
    await page.evaluate(`(() => { clearFilter(); renderApp(); })()`);
    await page.waitFor(`(() => !!document.querySelector('[data-sf]'))()`, { name:'已存视图 chip 出现' });
    await page.evaluate(`(() => { document.querySelector('[data-sf]').click(); })()`);
    await page.waitFor(`(() => FILTER.prio === 'high')()`, { name:'套用已存视图' });
    assertTruthy(await page.evaluate(`(() => document.querySelector('.f-summary').textContent.includes('优先级'))()`), '筛选摘要应显示优先级条件');
    await page.evaluate(`(() => { DB.savedFilters = DB.savedFilters.filter(f => f.name !== 'E2E高优视图');
      clearFilter(); saveDB(); renderApp(); })()`);
    assertEq(await page.evaluate(`(() => (DB.savedFilters || []).length)()`), 0, '测试数据应清理干净');
  });

  t('U11 300 条任务下勾选一次渲染不卡顿（性能回归）', async () => {
    const page = getPage();
    const pid = await page.evaluate(`(() => (DB.projects.filter(x=>!x.archived)[0] || DB.projects[0]).id)()`);
    await page.evaluate(`(() => {
      const base = Date.now();
      for(let i = 0; i < 300; i++){
        DB.tasks.push({ id:'perf_' + i, projectId: ${Q(pid)}, title:'压测任务 ' + i, desc:'', assigneeId: ME.id,
          dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
          order: base + i, subtasks:[], comments:[], tags:[], followers:[], recurring:null,
          activities:[], createdAt: base, createdBy: ME.id });
      }
      saveDB();
      nav('#/project/' + ${Q(pid)} + '/list');
    })()`);
    await page.waitFor(`(() => document.querySelectorAll('#proj-body .task-row').length > 250)()`, { timeout: 25000, name:'300 条任务渲染' });
    const ms = await page.evaluate(`(() => {
      const t0 = performance.now();
      toggleTaskDone(DB.tasks[DB.tasks.length - 1].id);
      return Math.round(performance.now() - t0);
    })()`);
    assertTruthy(ms < 1200, '一次勾选 + 重渲染应 < 1200ms，实际 ' + ms + 'ms');
    assertTruthy(await page.evaluate(`(() => tasksOfProject(${Q(pid)}).length > 300)()`), '渲染索引应覆盖压测数据');
    await page.screenshot('perf-300-list');
    await page.evaluate(`(() => { DB.tasks = DB.tasks.filter(t => String(t.id).indexOf('perf_') !== 0); saveDB(); renderApp(); })()`);
    assertEq(await page.evaluate(`(() => DB.tasks.filter(t => String(t.id).indexOf('perf_') === 0).length)()`), 0, '压测数据应清理干净');
  });

  t('U12 任务级复制：副本剥离评论/活动且可撤销', async () => {
    const page = getPage();
    const src = await page.evaluate(`(() => {
      const p = DB.projects.filter(x=>!x.archived)[0] || DB.projects[0];
      const t = createTask(p.id, 'todo', '待复制的任务', {});
      t.comments.push({ id:'c1', userId: ME.id, text:'一条评论', ts: Date.now() });
      saveDB(); renderApp();
      return t.id;
    })()`);
    await page.evaluate(`(() => { openDrawer(${Q(src)}); })()`);
    await page.waitForSelector('#dt-dup');
    await page.evaluate(`(() => { document.getElementById('dt-dup').click(); })()`);
    await page.waitFor(`(() => DB.tasks.some(t => t.title === '待复制的任务（副本）'))()`, { name:'副本已创建' });
    const info = await page.evaluate(`(() => {
      const c = DB.tasks.filter(t => t.title === '待复制的任务（副本）').pop();
      const o = DB.tasks.filter(t => t.title === '待复制的任务').pop();
      return { comments: c.comments.length, acts: c.activities.length, status: c.status,
        done: c.completed, sameProject: c.projectId === o.projectId, srcComments: o.comments.length };
    })()`);
    assertEq(info.comments, 0, '副本不应带原评论');
    assertEq(info.srcComments, 1, '原任务评论应保持（说明是副本而非移动）');
    assertEq(info.acts, 1, '副本活动记录应只有一条"复制自…"');
    assertEq(info.status, 'todo', '副本状态应为待办');
    assertEq(info.done, false, '副本不应是已完成');
    assertTruthy(info.sameProject, '副本应在同一项目');
    await page.evaluate(`(() => { document.querySelector('.toast button') && document.querySelector('.toast button').click(); })()`);
    await page.waitFor(`(() => !DB.tasks.some(t => t.title === '待复制的任务（副本）'))()`, { name:'撤销应删除副本' });
    await page.evaluate(`(() => { trashTaskIds(DB.tasks.filter(t=>t.title==='待复制的任务').map(t=>t.id)); saveDB(); renderApp(); })()`);
  });

  t('U14 应用内帮助面板：四段可切换且含快捷键', async () => {
    const page = getPage();
    await page.evaluate(`(() => { document.body.classList.remove('side-open'); openHelpModal('keys'); })()`);
    await page.waitFor(`(() => document.querySelectorAll('#hp-tabs .help-tab').length === 4)()`, { name:'四个标签页' });
    assertTruthy((await page.evaluate(`(() => document.getElementById('hp-body').textContent)()`)).includes('命令面板'), '默认应显示快捷键说明');
    for(const id of ['store', 'roles', 'link']){
      const sel = '[data-ht="' + id + '"]';
      await page.evaluate(`(() => { document.querySelector(${Q(sel)}).click(); })()`);
      await page.waitFor(`(() => document.querySelector('#hp-tabs .help-tab.on').dataset.ht === ${Q(id)})()`, { name:'切换到 ' + id });
    }
    await page.evaluate(`(() => { document.querySelector('[data-ht="store"]').click(); })()`);
    const store = await page.evaluate(`(() => document.getElementById('hp-body').textContent)()`);
    assertTruthy(store.includes('flowtask_auth.json') && store.includes('flowtask_shared.json'), '备份说明应讲清账户表与共享库两个文件');
    assertTruthy(store.includes('个人库') && store.includes('冲突副本'), '备份说明应提到个人库与冲突副本入口');
    assertTruthy(!store.includes('flowtask_data.json'), '帮助里不应再出现旧版单文件名');
    await page.screenshot('help-panel');
    await page.evaluate(`(() => { maskRemoveAll(); })()`);
  });

  t('U14b 命令面板（v2.0 Ctrl+K）：合成按键可呼出、输入过滤、Enter 执行', async () => {
    const page = getPage();
    await page.evaluate(`(() => { document.body.classList.remove('side-open'); maskRemoveAll(); })()`);
    await page.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'k', ctrlKey:true, bubbles:true, cancelable:true })); })()`);
    await page.waitFor(`(() => document.getElementById('cmdk').classList.contains('on'))()`, { name:'Ctrl+K 应呼出命令面板' });
    const withQuery = await page.evaluate(`(() => {
      const inp = document.getElementById('cmdk-input');
      inp.value = '新建项目';
      inp.dispatchEvent(new Event('input', { bubbles:true }));
      return { n: document.querySelectorAll('#cmdk-list [data-cmdk]').length, first: (document.querySelector('#cmdk-list .search-item')||{}).textContent || '' };
    })()`);
    assertTruthy(withQuery.n >= 1 && withQuery.first.includes('新建项目'), '输入「新建项目」应过滤出对应命令：' + JSON.stringify(withQuery));
    await page.evaluate(`(() => {
      document.getElementById('cmdk-input').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    })()`);
    await page.waitFor(`(() => !document.getElementById('cmdk').classList.contains('on') && !!document.getElementById('np-name'))()`, { name:'Enter 应执行命令并打开新建项目弹窗' });
    await page.evaluate(`(() => { maskRemoveAll(); })()`);
  });

  t('U13 列表行降噪：标签最多 2 个 + "+N" 收纳，项目内不重复项目名', async () => {
    const page = getPage();
    const pid = await page.evaluate(`(() => {
      const p = DB.projects.filter(x=>!x.archived)[0] || DB.projects[0];
      const ids = (DB.tags||[]).slice(0,4).map(g=>g.id);
      const t = createTask(p.id, 'todo', '四个标签的任务', { tags: ids });
      saveDB(); renderApp();
      return p.id;
    })()`);
    await page.evaluate(`(() => { nav('#/project/' + ${Q(pid)} + '/list'); })()`);
    await page.waitForSelector('.task-row');
    const row = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.task-row')].filter(r => r.textContent.includes('四个标签的任务'));
      const el = rows[0];
      return { found: !!el, tags: el ? el.querySelectorAll('.tag-chip.mini').length : 0,
        more: el ? (el.querySelector('.tag-more')||{}).textContent || '' : '',
        projChip: el ? el.querySelectorAll('.proj-chip').length : 0 };
    })()`);
    assertTruthy(row.found, '应能找到刚建的任务行');
    assertEq(row.tags, 2, '行内最多展示 2 个标签');
    assertMatch(row.more, /^\+2$/, '其余标签应收纳为 +2，实际：' + row.more);
    assertEq(row.projChip, 0, '项目视图内不应再重复显示项目名 chip');
    await page.evaluate(`(() => { trashTaskIds(DB.tasks.filter(t=>t.title==='四个标签的任务').map(t=>t.id)); saveDB(); renderApp(); })()`);
  });
  t('W1 老用户升级：旧版单文件的数据会被搬进新账户的个人库', async () => {
    const page = getPage();
    // 1) 造一份"旧版单文件"数据（v1.4 及之前的 flowtask_data.json）
    const legacy = await page.evaluate(`(async () => {
      const old = {
        meta: { rev: 42, lastSaved: Date.now() },
        users: AUTH.users,
        projects: [{ id: 'p_legacy_one', name: '升级前建的项目', color: '#e8850c', desc: '',
          ownerId: 'u_upgrade', memberIds: ['u_upgrade'], archived: false, createdAt: Date.now(), statusUpdates: [] }],
          // ↑ 属于即将注册的新账户：迁移按创建人分配
        tasks: [{ id: 't_legacy_one', projectId: 'p_legacy_one', title: '升级前的任务', desc: '',
          assigneeId: ME.id, dueDate: null, startDate: null, priority: 'low', status: 'todo', completed: false,
          completedAt: null, order: Date.now(), subtasks: [], comments: [], tags: [], followers: [],
          recurring: null, activities: [], createdAt: Date.now(), createdBy: ME.id }],
        notifications: [], trash: { tasks: [], projects: [] }, tags: DEFAULT_TAGS()
      };
      const r = await fetchStore('flowtask_data.json', 'POST', JSON.stringify(old), 42);
      return { status: r.status };
    })()`);
    assertEq(legacy.status, 200, '旧版单文件应可写入（回归用的前置条件）');

    // 2) 注册一个全新账户（个人库还不存在）
    await page.evaluate(`(async () => {
      const salt = uid('s_');
      if(!AUTH.users.some(u=>u.id==='u_upgrade'))
      AUTH.users.push({ id: 'u_upgrade', username: 'upg', name: '升级测试员', role: 'member',
        salt, passHash: await hashPassword('upg123456', salt), color: '#14b8a6', active: true, createdAt: Date.now() });
      saveAuth();
    })()`);
    await page.evaluate(`(() => { logout(); })()`);
    await page.waitFor(`(() => getComputedStyle(document.getElementById('auth-page')).display !== 'none')()`, { name:'回到登录页' });

    // 3) 用新账户登录 → 应把旧版单文件里的项目搬进他的个人库
    await page.fill('#li-username', 'upg');
    await page.fill('#li-password', 'upg123456');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'新账户登录' });
    await page.waitFor(`(() => DB.projects.some(p=>p.id==='p_legacy_one'))()`, { timeout: 20000, name:'旧数据应被迁入个人库' });
    const got = await page.evaluate(`(() => {
      const p = DB.projects.find(x=>x.id==='p_legacy_one');
      const t = DB.tasks.find(x=>x.id==='t_legacy_one');
      return { proj: p && p.name, scope: p && p.scope, task: t && t.title,
        personalRev: Number(_revs.personal) || 0, migratedFrom: DB.meta && DB.meta.migratedFrom };
    })()`);
    assertEq(got.proj, '升级前建的项目', '项目名应原样保留');
    assertEq(got.task, '升级前的任务', '任务应原样保留');
    assertEq(got.scope, 'personal', '迁移进来的项目默认归属个人库');
    assertEq(got.migratedFrom, 'flowtask_data.json', '应记录数据来源是旧版单文件');
    // 落盘走 400ms 防抖，等它真正写进个人库文件
    await page.waitFor(`(() => (Number(_revs.personal) || 0) > 0)`, { timeout: 20000, name:'个人库应已落盘' });
    const onDisk = await page.evaluate(`(async () => {
      const r = await fetchStore(personalFileOf(), 'GET');
      if(!r.ok) return { status: r.status };
      const j = await r.json();
      return { status: r.status, projects: (j.projects||[]).map(p=>p.id), rev: j.meta && j.meta.rev };
    })()`);
    assertTruthy(onDisk.projects && onDisk.projects.indexOf('p_legacy_one') >= 0,
      '迁移结果应写进个人库文件，实际 ' + JSON.stringify(onDisk));

    // 4) 回到 admin，避免影响后续人工查看
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'回到 admin' });
  });
  t('W2 迁移按创建人分配：先登录的人不会把别人的项目认领走', async () => {
    const page = getPage();
    // 两个全新账户 + 一份"旧库"：两个项目分别属于他们
    await page.evaluate(`(async () => {
      for(const [id, uname] of [['u_x1','xone'], ['u_x2','xtwo']]){
        if(AUTH.users.some(u=>u.id===id)) continue;
        const salt = uid('s_');
        AUTH.users.push({ id, username: uname, name: uname, role: 'member', salt,
          passHash: await hashPassword('pass1234', salt), color: '#8b5cf6', active: true, createdAt: Date.now() });
      }
      saveAuth();
      const old = {
        meta: { rev: 77, lastSaved: Date.now() }, users: AUTH.users,
        projects: [
          { id:'p_own_x1', name:'属于 xone 的项目', color:'#e8850c', desc:'', ownerId:'u_x1',
            memberIds:['u_x1'], archived:false, createdAt: Date.now(), statusUpdates: [] },
          { id:'p_own_x2', name:'属于 xtwo 的项目', color:'#14b8a6', desc:'', ownerId:'u_x2',
            memberIds:['u_x2'], archived:false, createdAt: Date.now(), statusUpdates: [] }
        ],
        tasks: [
          { id:'t_own_x1', projectId:'p_own_x1', title:'xone 的任务', desc:'', assigneeId:'u_x1', dueDate:null,
            startDate:null, priority:'low', status:'todo', completed:false, completedAt:null, order: Date.now(),
            subtasks:[], comments:[], tags:[], followers:[], recurring:null, activities:[], createdAt: Date.now(), createdBy:'u_x1' },
          { id:'t_own_x2', projectId:'p_own_x2', title:'xtwo 的任务', desc:'', assigneeId:'u_x2', dueDate:null,
            startDate:null, priority:'low', status:'todo', completed:false, completedAt:null, order: Date.now(),
            subtasks:[], comments:[], tags:[], followers:[], recurring:null, activities:[], createdAt: Date.now(), createdBy:'u_x2' }
        ],
        notifications: [], trash: { tasks: [], projects: [] }, tags: []
      };
      await fetchStore('flowtask_data.json', 'POST', JSON.stringify(old), 77);
      return true;
    })()`);
    // 重新加载页面：让"刚写完的旧库"被当作首次升级场景重新读取
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重载完成' });

    // xone 先登录：只该拿到自己的项目
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'xone');
    await page.fill('#li-password', 'pass1234');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'xone 登录' });
    await page.waitFor(`(() => DB.projects.some(p=>p.id==='p_own_x1'))()`, { timeout: 20000, name:'xone 认领自己的项目' });
    const x1 = await page.evaluate(`(() => ({
      own: DB.projects.some(p=>p.id==='p_own_x1'),
      steal: DB.projects.some(p=>p.id==='p_own_x2'),
      hasMine: DB.tasks.some(t=>t.id==='t_own_x1'),
      hasTheirs: DB.tasks.some(t=>t.id==='t_own_x2'),
      sharedVisible: DB.projects.filter(p=>p.scope==='shared').length
    }))()`);
    assertTruthy(x1.own, 'xone 应拿到自己的旧项目');
    assertTruthy(!x1.steal, 'xone 不该拿到 xtwo 的项目');
    assertTruthy(x1.hasMine, 'xone 自己的任务应被搬进来');
    assertTruthy(!x1.hasTheirs, 'xtwo 的任务不该被 xone 认领');
    assertTruthy(x1.sharedVisible >= 1, '共享项目对每个账户都可见（这是设计而非泄漏）');

    // xtwo 后登录：仍然能拿到自己的（旧文件未被消耗掉）
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'xtwo');
    await page.fill('#li-password', 'pass1234');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'xtwo 登录' });
    await page.waitFor(`(() => DB.projects.some(p=>p.id==='p_own_x2'))()`, { timeout: 20000, name:'xtwo 认领自己的项目' });
    const x2 = await page.evaluate(`(() => ({
      own: DB.projects.some(p=>p.id==='p_own_x2'),
      other: DB.projects.some(p=>p.id==='p_own_x1'),
      hasMine: DB.tasks.some(t=>t.id==='t_own_x2'),
      hasTheirs: DB.tasks.some(t=>t.id==='t_own_x1')
    }))()`);
    assertTruthy(x2.own, 'xtwo 也应能认领属于自己的项目（迁移不是一次性消耗）');
    assertTruthy(!x2.other, 'xtwo 看不到 xone 的个人项目');
    assertTruthy(x2.hasMine, 'xtwo 自己的任务应被搬进来');
    assertTruthy(!x2.hasTheirs, 'xone 的任务不该出现在 xtwo 这里');

    // 回到 admin
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'回到 admin' });
  });

  t('X1 任务在列表内上下拖动可排序（同组换位 + 顺序落盘）', async () => {
    const page = getPage();
    // 播种一个自带 3 个待办任务的项目，保证「同组至少两项」的前提一定成立
    await page.evaluate(`(() => {
      const pid = 'p_e2e_sort';
      if(!DB.projects.some(p=>p.id===pid)){
        DB.projects.push({ id:pid, name:'E2E排序项目', color:'#8b5cf6', desc:'', ownerId: ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt: Date.now(), statusUpdates:[] });
        for(let i=0;i<3;i++) DB.tasks.push({ id:'t_sort_'+i, projectId:pid, title:'排序任务'+i,
          desc:'', assigneeId:ME.id, dueDate:null, startDate:null, priority:'low', status:'todo', completed:false,
          completedAt:null, order: Date.now() + i, subtasks:[], comments:[], tags:[], followers:[], recurring:null,
          activities:[], createdAt:Date.now(), createdBy:ME.id });
        saveDB();
      }
      nav('#/project/' + pid + '/list');
    })()`);
    // nav 走 hashchange 是异步的，必须等分组渲染出来
    await page.waitFor(`(() => {
      const b = document.querySelector('.section-block[data-st="todo"]');
      return !!b && b.querySelectorAll('.task-row').length >= 2;
    })()`, { timeout: 20000, name:'排序项目已渲染出至少两个任务' });

    const before = await page.evaluate(`(() => Array.from(
      document.querySelectorAll('.section-block[data-st="todo"] .task-row')).map(r=>r.dataset.task))()`);
    assertTruthy(before.length >= 2, '前提：分组内至少两个任务，实际 ' + before.length);

    const after = await page.evaluate(`(() => {
      const block = document.querySelector('.section-block[data-st="todo"]');
      const rows = Array.from(block.querySelectorAll('.task-row'));
      const src = rows[0], dst = rows[1];
      const dt = new DataTransfer();
      const fire = (el, type, o) => el.dispatchEvent(new DragEvent(type, Object.assign({ bubbles:true, cancelable:true, dataTransfer:dt }, o)));
      fire(src, 'dragstart');
      const r = dst.getBoundingClientRect();
      fire(dst, 'dragover', { clientY: r.bottom - 2 });        // 放到第二项下方 = 两项互换
      fire(dst, 'drop', { clientY: r.bottom - 2 });
      fire(src, 'dragend');
      return Array.from(document.querySelectorAll('.section-block[data-st="todo"] .task-row')).map(x=>x.dataset.task);
    })()`);
    assertTruthy(after[0] === before[1] && after[1] === before[0],
      '前两项应互换位置，实际 ' + JSON.stringify(after.slice(0,2)) + '，期望 ' + JSON.stringify([before[1], before[0]]));

    // 顺序必须落盘：重载后仍在
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重载完成' });
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'回到应用' });
    await page.evaluate(`(() => { nav('#/project/p_e2e_sort/list'); })()`);
    await page.waitFor(`(() => document.querySelectorAll('.section-block[data-st="todo"] .task-row').length >= 2)`, { timeout: 20000, name:'列表重新渲染' });
    const persisted = await page.evaluate(`(() => Array.from(
      document.querySelectorAll('.section-block[data-st="todo"] .task-row')).map(r=>r.dataset.task).slice(0,2))()`);
    assertEq(persisted.join(','), after.slice(0,2).join(','), '刷新后顺序应保持（说明 order 已写入个人库文件）');

    await page.evaluate(`(() => {
      DB.projects = DB.projects.filter(p=>p.id!=='p_e2e_sort');
      DB.tasks = DB.tasks.filter(t=>t.projectId!=='p_e2e_sort');
      saveDB(); renderApp();
    })()`);
  });

  t('X2 侧栏项目可上下拖动排序，且只改本机偏好不动数据文件', async () => {
    const page = getPage();
    const names0 = await page.evaluate(`(() => Array.from(document.querySelectorAll('#sb-proj-list .proj-item')).map(el=>el.textContent.trim()))()`);
    assertTruthy(names0.length >= 2, '侧栏至少要有两个项目才能测排序，实际 ' + names0.length);
    const revBefore = await page.evaluate(`(() => Number(_revs.personal) || 0)()`);

    const moved = await page.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('#sb-proj-list .proj-item'));
      const src = items[1], dst = items[0];            // 把第二项拖到第一项上方 = 真正换位
      const dt = new DataTransfer();
      const fire = (el, type, o) => el.dispatchEvent(new DragEvent(type, Object.assign({ bubbles:true, cancelable:true, dataTransfer:dt }, o)));
      fire(src, 'dragstart');
      const r = dst.getBoundingClientRect();
      fire(dst, 'dragover', { clientY: r.top + 2 });
      fire(dst, 'drop', { clientY: r.top + 2 });
      fire(src, 'dragend');
      return Array.from(document.querySelectorAll('#sb-proj-list .proj-item')).map(el=>el.textContent.trim());
    })()`);
    assertEq(moved[0], names0[1], '第二个项目应被顶到第一位');
    assertEq(moved[1], names0[0], '原第一个项目应落到第二位');

    const revAfter = await page.evaluate(`(() => Number(_revs.personal) || 0)()`);
    assertEq(revAfter, revBefore, '拖项目顺序不该写数据文件（顺序是个人偏好，只存本机 UI）');

    // 刷新后顺序保持
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重载完成' });
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 30000, name:'回到应用' });
    const after = await page.evaluate(`(() => Array.from(document.querySelectorAll('#sb-proj-list .proj-item')).map(el=>el.textContent.trim()))()`);
    assertEq(after.slice(0,2).join('|'), moved.slice(0,2).join('|'), '刷新后侧栏顺序应保持');

    // 撤销按钮可还原
    await page.evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('#sb-proj-list .proj-item'));
      const dt = new DataTransfer();
      const fire = (el, type, o) => el.dispatchEvent(new DragEvent(type, Object.assign({ bubbles:true, cancelable:true, dataTransfer:dt }, o)));
      fire(items[1], 'dragstart');
      const r = items[0].getBoundingClientRect();
      fire(items[0], 'dragover', { clientY: r.top + 2 });
      fire(items[0], 'drop', { clientY: r.top + 2 });
    })()`);
    const undone = await page.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('.toast button')).find(b=>b.textContent==='撤销');
      if(btn) btn.click();
      return Array.from(document.querySelectorAll('#sb-proj-list .proj-item')).map(el=>el.textContent.trim());
    })()`);
    assertEq(undone.slice(0,2).join('|'), moved.slice(0,2).join('|'), '撤销应还原到这一次拖动之前的顺序');
  });

  t('X3 弹窗里点「放弃并关闭」必须真的关掉原弹窗（回归：曾只关掉确认框）', async () => {
    const page = getPage();
    await page.evaluate(`(() => { openProjectModal(); })()`);
    await page.waitForSelector('#np-name');
    await page.type('#np-name', '随便写点没要的内容');
    await page.click('.modal-mask:last-of-type .modal-x');           // 用户真实路径：点右上角 ×
    await page.waitFor(`(() => MODAL_STACK.length === 2)()`, { name:'应出现挽留确认' });
    const okBtn = await page.evaluate(`(() => {
      const m = document.querySelector('.modal-mask:last-of-type');
      return { head: m.querySelector('.modal-head h3').textContent, label: m.querySelector('.modal-ok').textContent };
    })()`);
    assertMatch(okBtn.head, /放弃已输入/, '顶层应是挽留确认：' + okBtn.head);
    await page.click('.modal-mask:last-of-type .modal-ok');           // 点「放弃并关闭」
    await page.waitFor(`(() => MODAL_STACK.length === 0)()`, { timeout: 5000, name:'两层都该关掉' });
    assertTruthy(await page.evaluate(`(() => !document.querySelector('.modal-mask'))()`), '页面上不该残留任何弹窗或遮罩');
  });

  t('Y1 管理员通过界面添加用户：账户要真的落盘并能在刷新后登录', async () => {
    const page = getPage();
    await page.evaluate(`(() => { logout(); })()`);
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on'))()`, { timeout: 40000, name:'admin 登录' });

    const before = await page.evaluate(`(() => ({
      users: AUTH.users.length,
      rev: Number(_revs.auth) || 0,
      file: (async () => { const r = await fetchStore('flowtask_auth.json','GET'); return r.ok ? (await r.json()).users.length : -1; })
    }))()`);
    const onDiskBefore = await page.evaluate(`(async () => {
      const r = await fetchStore('flowtask_auth.json','GET');
      return r.ok ? (await r.json()).users.length : -1;
    })()`);

    await page.evaluate(`(() => { nav('#/members'); })()`);
    await page.waitFor(`(() => !!document.getElementById('add-user-btn'))()`, { timeout: 15000, name:'成员管理页应可达' });
    await page.click('#add-user-btn');
    await page.waitForSelector('#nu-username');
    await page.type('#nu-username', 'e2euser');
    await page.evaluate(`(() => { document.getElementById('nu-name').value = 'E2E 新同事'; })()`);
    await page.evaluate(`(() => { const sel = document.getElementById('nu-role'); sel.value = 'admin'; })()`);
    /* 初始口令现在是随机生成的（不再全组共用 123456），要当场捕获 */
    const initPw = await page.evaluate(`(() => document.getElementById('nu-password').value)()`);
    assertTruthy(initPw && initPw.length >= 10 && initPw !== '123456',
      '新建账户应给随机强口令，实际：' + initPw);
    await page.click('.modal-mask:last-of-type .modal-ok');
    await page.waitFor(`(() => MODAL_STACK.length === 0)()`, { timeout: 15000, name:'弹窗应关闭' });

    const justAfter = await page.evaluate(`(() => {
      const u = AUTH.users.find(x=>x.username==='e2euser');
      return { exists: !!u, role: u && u.role };
    })()`);
    assertTruthy(justAfter.exists, '新账户应出现在账户表里');
    assertEq(justAfter.role, 'admin', '下拉里选的角色应生效（曾经被 saveDB 吞掉）');
    await page.waitFor(`(async () => {
      const r = await fetchStore('flowtask_auth.json','GET');
      if(!r.ok) return false;
      const j = await r.json();
      return (j.users||[]).some(u=>u.username==='e2euser') && (j.users.find(x=>x.username==='e2euser')||{}).role === 'admin';
    })()`, { timeout: 15000, name:'新账户连同角色应写入 flowtask_auth.json' });

    // 刷新后仍要能用它登录（证明真的落盘了，不只是内存里有）
    await page.evaluate(`(() => { logout(); })()`);
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重启完成' });
    await page.waitFor(`(() => getComputedStyle(document.getElementById('auth-page')).display !== 'none')()`, { timeout: 20000, name:'停在登录页' });
    await page.fill('#li-username', 'e2euser');
    await page.fill('#li-password', initPw);
    await page.click('#login-form button[type=submit]');
    await page.waitFor(`(() => document.getElementById('app').classList.contains('on') && ME && ME.username==='e2euser')()`,
      { timeout: 40000, name:'新账户应能登录' });
    /* 引导是进入后延时 500ms 弹的（不阻塞使用），所以必须等，不能同步断言 */
    const guided = await page.evaluate(`(() => ({ must: !!ME.pwMustChange, usable: document.getElementById('app').classList.contains('on') }))()`);
    assertTruthy(guided.must, '用初始口令登录应标记待改密：' + JSON.stringify(guided));
    assertTruthy(guided.usable, '引导不该阻止进入应用');
    await page.waitFor(`(() => !!document.getElementById('mc-pw0'))()`, { timeout: 10000, name:'应弹「先改一下密码」引导' });
    await page.evaluate(`(() => { closeTopModal(false); return true; })()`);
    const who = await page.evaluate(`(() => ({ name: ME.name, role: ME.role, users: AUTH.users.length }))()`);
    assertEq(who.role, 'admin', '登录后角色应从账户表读回');
    assertTruthy(who.users >= onDiskBefore + 1, '账户数应比新建前多，实际 ' + who.users + '（之前 ' + onDiskBefore + '）');
  });

  t('Z1 偏好设置：项目默认页面与标签数量真的生效且能持久', async () => {
    const page = getPage();
    /* 可见性改成"只认成员名单"后，场景必须明确自己是谁：
       上一场景登录的是 e2euser（不在演示项目名单里），侧栏项目本来就是空的 */
    await loginAs('admin', 'admin123', 'admin');
    await page.evaluate(`(() => { nav('#/settings'); })()`);
    await page.waitFor(`(() => !!document.getElementById('pf-projview'))()`, { timeout: 15000, name:'偏好设置卡片应存在' });

    // 默认页面改成"看板"
    await page.evaluate(`(() => {
      const sel = document.getElementById('pf-projview');
      sel.value = 'board';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    })()`);
    await page.waitFor(`(() => PREF().projView === 'board')()`, { timeout: 10000, name:'偏好已写入' });

    // 点侧栏项目应直接落到看板
    await page.evaluate(`(() => { document.querySelector('#sb-proj-list .proj-item').click(); })()`);
    await page.waitFor(`(() => location.hash.indexOf('/board') !== -1)`, { timeout: 15000, name:'应进入看板视图' });
    assertTruthy(await page.evaluate(`(() => !!document.querySelector('.board-col'))()`), '应渲染出看板列');

    // 标签数量设为"不显示"
    await page.evaluate(`(() => { nav('#/settings'); })()`);
    await page.waitFor(`(() => !!document.getElementById('pf-taglimit'))()`, { timeout: 15000, name:'标签设置项存在' });
    await page.evaluate(`(() => {
      const sel = document.getElementById('pf-taglimit');
      sel.value = '0';
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    })()`);
    const tagInfo = await page.evaluate(`(() => {
      nav('#/project/' + (DB.projects[0] && DB.projects[0].id) + '/list');
      return { limit: PREF().tagLimit, chips: document.querySelectorAll('#proj-body .task-row .tag-chip').length };
    })()`);
    assertEq(tagInfo.limit, 0, '标签上限偏好应生效');
    assertEq(tagInfo.chips, 0, '设为不显示后任务行不该有标签 chip');

    // 刷新后偏好仍在（证明存进了本机 UI 而不是数据文件）
    /* 先让在途的防抖推送落地再取基线版本号：否则上一条用例排队的写入会被误算成
       「改偏好顶高了任务数据版本」（该断言要测的是偏好只写 localStorage） */
    await page.waitFor(`(() => {
      const el = document.getElementById('store-status');
      return _svcSaveTimer === null && (!el || !/保存中/.test(el.textContent));
    })()`, { timeout: 15000, name:'等待在途保存落地' });
    await page.waitFor(`(() => new Promise(r=>setTimeout(()=>r(true), 700)))()`, { timeout: 15000, name:'等待防抖窗口结束' });
    const revBefore = await page.evaluate(`(() => Number(_revs.personal) || 0)()`);
    await page.goto(getBase() + '/');
    await page.waitFor(`(() => !document.body.classList.contains('booting'))()`, { timeout: 30000, name:'重启完成' });
    const after = await page.evaluate(`(() => ({ view: PREF().projView, limit: PREF().tagLimit,
      hash: location.hash, rev: Number(_revs.personal) || 0 }))()`);
    assertEq(after.view, 'board', '刷新后默认页面偏好应仍在');
    assertEq(after.limit, 0, '刷新后标签数量偏好应仍在');
    assertEq(after.rev, revBefore, '改偏好不该写任务数据文件（不产生新版本号）');

    // 复原，避免影响其它用例
    await page.evaluate(`(() => { setPref('projView','overview'); setPref('tagLimit',2); renderApp(); })()`);
  });


  t('Z2 首页"今天要处理"空态里的「＋ 添加一个任务」必须真的能点开', async () => {
    const page = getPage();
    await loginAs('admin', 'admin123', 'admin');
    /* 下面用 MODAL_STACK.length === 1 判断"是我们点开的弹窗"，起手必须先清干净：
       单独 --grep 跑本场景时没有前序场景帮忙收尾，否则会数到残留弹窗 */
    await page.evaluate(`(() => { maskRemoveAll(); return true; })()`);
    /* 造出空态：把「今天要处理」可能计入的每一处日期都清掉——任务级 + 子任务级
       （首页会把子任务一起算进今天要处理，只清任务级会剩几条子任务，空态永远出不来）。
       可见性改成"只认成员名单"后，本场景以 admin 身份跑，演示数据里有真任务，必须清干净。 */
    const backup = await page.evaluate(`(() => {
      const snap = [];
      DB.tasks.forEach(t => {
        if(!t || t.completed) return;
        if(t.dueDate){ snap.push({ kind:'t', id:t.id, dueDate:t.dueDate }); t.dueDate = null; }
        (t.subtasks || []).forEach(s => {
          if(s && !s.done && s.dueDate){ snap.push({ kind:'s', id:s.id, pid:t.id, dueDate:s.dueDate }); s.dueDate = null; }
        });
      });
      saveDB(); nav('#/');
      return snap;
    })()`);
    await page.waitFor(`(() => !!document.querySelector('[data-home-qa]'))()`, { timeout: 15000, name:'应出现"今天要处理"空态按钮' });

    // v2.0：今天页只剩空态一个入口（顶栏是全局常驻入口）；空态 CTA 必须真的绑上——
    // 历史上统计行按钮的存在会短路掉空态 CTA 的绑定（点了没反应）
    await page.evaluate(`(() => { document.querySelector('[data-home-qa]').click(); })()`);
    await page.waitFor(`(() => MODAL_STACK.length === 1 && !!document.getElementById('qa-title'))()`,
      { timeout: 15000, name:'点空态按钮应打开快速添加' });
    await page.evaluate(`(() => { maskRemoveAll(); nav('#/'); })()`);

    // 还原数据（任务级与子任务级各回各的）
    await page.evaluate(`(() => {
      const snap = ${JSON.stringify(backup)};
      snap.forEach(x => {
        const t = DB.tasks.find(y => y.id === (x.kind === 's' ? x.pid : x.id));
        if(!t) return;
        if(x.kind === 's'){ const s = (t.subtasks || []).find(y => y.id === x.id); if(s) s.dueDate = x.dueDate; }
        else t.dueDate = x.dueDate;
      });
      saveDB(); renderApp();
    })()`);
    const restored = await page.evaluate(`(() => {
      const snap = ${JSON.stringify(backup)};
      if(!snap.length) return true;                       // 演示数据本来就没有日期，无可还原也算通过
      return snap.every(x => {
        const t = DB.tasks.find(y => y.id === (x.kind === 's' ? x.pid : x.id));
        if(!t) return false;
        if(x.kind === 's'){ const s = (t.subtasks || []).find(y => y.id === x.id); return !!s && s.dueDate === x.dueDate; }
        return t.dueDate === x.dueDate;
      });
    })()`);
    assertTruthy(restored, '用例应把清掉的日期原样还原');
  });

  t('M1 任务可在项目间移动：所属项目按钮 + 可搜索切换器（含撤销）', async () => {
    const page = getPage();
    await loginAs('admin', 'admin123', 'admin');
    // 准备第二个可写项目（若无则由管理员创建）
    await page.evaluate(`(async () => {
      if(!DB.projects.some(p=>p.id==='p_e2e_move')){
        DB.projects.push({ id:'p_e2e_move', name:'E2E移动目标项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
        saveDB();
      }
    })()`);
    await page.evaluate(toList);
    await page.waitForSelector('.task-row');
    await page.evaluate(`(() => { openDrawer(DB.tasks[0].id); })()`);
    await page.waitForSelector('#dt-move-btn');
    const before = await page.evaluate(`(() => ({
      tid: DB.tasks[0].id, fromPid: DB.tasks[0].projectId, toPid: 'p_e2e_move',
      fromName: DB.projects.find(p=>p.id===DB.tasks[0].projectId).name,
      btnText: (document.getElementById('dt-move-btn')||{}).textContent || '',
      hasBtn: !!document.getElementById('dt-move-btn'),
      hasSelect: !!document.getElementById('dt-move'),
      subtasks: DB.tasks[0].subtasks.length
    }))()`);
    assertTruthy(before.hasBtn, '抽屉应有「所属项目」按钮（显示当前项目）');
    assertTruthy(!before.hasSelect, '不应再使用下拉选择器（v1.7.1 改为可搜索切换器）');
    assertTruthy(before.btnText.includes(before.fromName), '按钮应显示当前项目名：' + before.btnText);
    // 点击按钮 → 弹出可搜索项目切换器 → 输入过滤 → Enter 选中
    await page.evaluate(`(() => { document.getElementById('dt-move-btn').click(); })()`);
    await page.waitForSelector('#pp-search');
    const pickerOk = await page.evaluate(`(() => {
      const inp = document.getElementById('pp-search');
      if(!inp || document.activeElement !== inp) return { focus:false };
      inp.value = 'E2E移动目标项目';
      inp.dispatchEvent(new Event('input', { bubbles:true }));
      const vis = [...document.querySelectorAll('#popover .po-item')].filter(x=>x.style.display!=='none');
      return { focus:true, vis: vis.length, hit: vis.length===1 && vis[0].dataset.po==='p_e2e_move' };
    })()`);
    console.log('        M1 picker=' + JSON.stringify(pickerOk));
    assertTruthy(pickerOk.focus, '切换器打开后搜索框应自动聚焦');
    assertTruthy(pickerOk.hit, '输入名称应过滤出唯一目标项目');
    await page.evaluate(`(() => {
      const inp = document.getElementById('pp-search');
      inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
    })()`);
    await page.waitFor(`(() => (DB.tasks.find(x=>x.id===${JSON.stringify(before.tid)})||{}).projectId === 'p_e2e_move')()`,
      { timeout: 15000, name:'任务应移动到目标项目' });
    const moved = await page.evaluate(`(() => {
      const t = DB.tasks.find(x=>x.id===${JSON.stringify(before.tid)});
      return { link: document.getElementById('drawer-project-link').textContent,
        act: (t.activities[t.activities.length-1]||{}).text || '',
        drawerOn: document.getElementById('drawer').classList.contains('on') };
    })()`);
    assertMatch(moved.act, /移动到「E2E移动目标项目」/, '活动记录应记下移动：' + moved.act);
    assertEq(moved.link, 'E2E移动目标项目', '抽屉的项目链接应跟随到新项目');
    assertTruthy(moved.drawerOn, '移动后抽屉应保持打开');
    // 撤销：点 toast 上的「撤销」
    await page.evaluate(`(() => { const b = document.querySelector('#toast-wrap button'); if(b) b.click(); })()`);
    await page.waitFor(`(() => (DB.tasks.find(x=>x.id===${JSON.stringify(before.tid)})||{}).projectId === ${JSON.stringify(before.fromPid)})()`,
      { timeout: 15000, name:'撤销后任务应回到原项目' });
    // 清理
    await page.evaluate(`(() => {
      DB.projects = DB.projects.filter(p=>p.id!=='p_e2e_move');
      saveDB(); renderApp();
    })()`);
  });

  t('M2 批量条「移到项目…」与键盘排序可用', async () => {
    const page = getPage();
    await loginAs('admin', 'admin123', 'admin');
    assertTruthy(await page.evaluate(`(() => typeof moveTaskToProject === 'function' && typeof keyboardMoveTask === 'function' && typeof keyboardMoveProject === 'function')()`),
      '移动与键盘排序函数应存在');
    /* 键盘排序：按 keyboardMoveTask 自己的口径取样本（同项目 + 同状态 + 按 order 排序），
       而不是拿 DOM 前两行猜——order 相等时两者会错位，这就是 M2 之前偶发挂掉的根因。
       同时取消「凑不到样本就 skip」：那等于什么都不验也算过。 */
    await page.evaluate(toList);
    await page.waitForSelector('.task-row');
    const r = await page.evaluate(`(() => {
      var groups = {};
      DB.tasks.forEach(t => {
        const k = t.projectId + '|' + t.status;
        (groups[k] = groups[k] || []).push(t);
      });
      for(const k in groups){
        const peers = groups[k].slice().sort((a,b)=>(Number(a.order)||0)-(Number(b.order)||0));
        if(peers.length >= 2){
          const row = document.querySelector('.task-row[data-task="' + peers[0].id + '"]');
          if(row) row.focus();
          return { aId:peers[0].id, bId:peers[1].id, aOrder:peers[0].order, bOrder:peers[1].order };
        }
      }
      return { none:true };
    })()`);
    assertTruthy(!r.none, '应能找到一个有 ≥2 个同状态任务的项目来做排序验证');
    /* 只验用户看得见的事实：换了之后 a 确实排到 b 后面，换回来又回到前面。
       不比较具体 order 值——相等 order 也应当能移动（产品对此有 tie-break），
       拿值相等当"样本不合格"反而会把真缺陷藏起来 */
    const posAB = await page.evaluate(`(() => {
      const a = DB.tasks.find(x=>x.id===${JSON.stringify(r.aId)});
      const peers = DB.tasks.filter(x=>x.projectId===a.projectId && x.status===a.status)
        .sort((x,y)=>(Number(x.order)||0)-(Number(y.order)||0) || (x.id<y.id?-1:1));
      return { i:peers.findIndex(x=>x.id===${JSON.stringify(r.aId)}),
               j:peers.findIndex(x=>x.id===${JSON.stringify(r.bId)}) };
    })()`);
    assertTruthy(posAB.i < posAB.j, '样本本身应先 a 后 b，实际 ' + JSON.stringify(posAB));
    {
      await page.evaluate(`(() => { keyboardMoveTask(${JSON.stringify(r.aId)}, 1); return true; })()`);
      const after = await page.evaluate(`(() => {
        const a = DB.tasks.find(x=>x.id===${JSON.stringify(r.aId)});
        const peers = DB.tasks.filter(x=>x.projectId===a.projectId && x.status===a.status)
          .sort((x,y)=>(Number(x.order)||0)-(Number(y.order)||0) || (x.id<y.id?-1:1));
        return { i:peers.findIndex(x=>x.id===${JSON.stringify(r.aId)}),
                 j:peers.findIndex(x=>x.id===${JSON.stringify(r.bId)}) };
      })()`);
      assertTruthy(after.i > after.j, 'Alt+↓ 后 a 应排到 b 之后（相等 order 也要能动）：' + JSON.stringify(after));
      await page.evaluate(`(() => { keyboardMoveTask(${JSON.stringify(r.aId)}, -1); return true; })()`);
      const back = await page.evaluate(`(() => {
        const a = DB.tasks.find(x=>x.id===${JSON.stringify(r.aId)});
        const peers = DB.tasks.filter(x=>x.projectId===a.projectId && x.status===a.status)
          .sort((x,y)=>(Number(x.order)||0)-(Number(y.order)||0) || (x.id<y.id?-1:1));
        return { i:peers.findIndex(x=>x.id===${JSON.stringify(r.aId)}),
                 j:peers.findIndex(x=>x.id===${JSON.stringify(r.bId)}) };
      })()`);
      assertTruthy(back.i < back.j, 'Alt+↑ 应能换回来（撤销是同一对交换）：' + JSON.stringify(back));
    }
  });

  t('M3 新建任务默认指派当前用户（可在成员中时）', async () => {
    const page = getPage();
    const me = await page.evaluate(`(() => ({ id: ME.id, name: ME.name }))()`);
    // 选一个我是成员的项目；当前账户不属于任何项目时现场建一个
    const pid = await page.evaluate(`(() => {
      let p = DB.projects.find(x=>!x.archived && x.memberIds.includes(ME.id));
      if(!p){
        p = { id:'p_e2e_me', name:'E2E默认指派项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] };
        DB.projects.push(p); saveDB();
      }
      openQuickAddModal(p.id); return p.id;
    })()`);
    assertTruthy(pid, '应存在我是成员的项目');
    await page.waitForSelector('#qa-assignee');
    const def = await page.evaluate(`(() => ({ v: document.getElementById('qa-assignee').value }))()`);
    assertEq(def.v, String(me.id), '负责人应默认为当前用户（我）');
    // 创建后应写入 assigneeId = 我
    await page.type('#qa-title', 'M3默认指派任务');
    await page.evaluate(`(() => { const top = MODAL_STACK[MODAL_STACK.length-1]; const b = top && top.querySelector('.modal-ok'); b.click(); })()`);
    await page.waitFor(`(() => DB.tasks.some(t=>t.title==='M3默认指派任务' && t.assigneeId===${Q(me.id)}))()`,
      { timeout: 15000, name:'任务应创建且负责人=我' });
    // 清理（连续录入模式下关闭弹窗）
    await page.evaluate(`(() => {
      maskRemoveAll();
      DB.tasks = DB.tasks.filter(t=>t.title!=='M3默认指派任务');
      DB.projects = DB.projects.filter(p=>p.id!=='p_e2e_me');
      saveDB(); renderApp();
    })()`);
  });

  t('M4 回收站清空按管理权分范围：成员可清自己的条目', async () => {
    const page = getPage();
    // 先清空回收站，保证计数场景自洽（此前的条目都是本套件产生的测试残余）
    await page.evaluate(`(() => { DB.trash = { tasks:[], projects:[] }; saveDB(); })()`);
    // 准备：建个人项目 + 任务，随后移入回收站
    await page.evaluate(`(() => {
      DB.projects.push({ id:'p_e2e_trash', name:'E2E清空测试项目', color:'#14b8a6', desc:'', ownerId:ME.id,
        memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      DB.tasks.push({ id:'t_e2e_trash', projectId:'p_e2e_trash', title:'M4待清空任务', desc:'', assigneeId:null,
        dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
        order:Date.now(), subtasks:[], comments:[], tags:[], followers:[], recurring:null, activities:[],
        createdAt:Date.now(), createdBy:ME.id });
      saveDB(); renderApp();
    })()`);
    await page.evaluate(`(() => { trashProjectById('p_e2e_trash'); saveDB(); })()`);
    await page.evaluate(`(() => { location.hash = '#/trash'; ROUTE = parseRoute(); })()`);
    // 以成员视角（isAdmin 打桩为 false）：按钮应可见，走「范围清空」
    const seen = await page.evaluate(`(() => {
      P.isAdmin = () => false; renderApp();
      const out = { page: ROUTE.page, btn: !!document.getElementById('trash-empty'),
                    okText: '' };
      const b = document.getElementById('trash-empty');
      if(b){ b.click(); const top = MODAL_STACK[MODAL_STACK.length-1];
        out.confirmTitle = (top.querySelector('.modal-head h3')||{}).textContent || '';
        out.bodyText = (top.querySelector('.modal-body')||{}).textContent || '';
        out.okText = (top.querySelector('.modal-ok')||{}).textContent || '';
      }
      return out;
    })()`);
    console.log('        M4 成员视角=' + JSON.stringify(seen));
    assertTruthy(seen.page === 'trash' && seen.btn, '成员应看到「清空回收站」按钮：' + JSON.stringify(seen));
    assertMatch(seen.bodyText || '', /你有管理权/, '确认框应说明只清自己管理范围内的条目');
    assertMatch(seen.okText || '', /彻底删除 1 项/, '应只彻底删除 1 项（项目本身；其任务仍在任务列表，清空时一并物理清除）');
    // 确认执行（保持打桩状态，onOk 会走成员分支）
    await page.evaluate(`(() => {
      const top = MODAL_STACK[MODAL_STACK.length-1];
      top.querySelector('.modal-ok').click();
      P.isAdmin = () => ME.role === 'admin';   // 恢复
    })()`);
    await page.waitFor(`(() => !DB.trash.projects.some(p=>p.id==='p_e2e_trash') && !DB.tasks.some(t=>t.id==='t_e2e_trash'))()`,
      { timeout: 15000, name:'条目应被彻底删除（含遗留任务）' });
    await page.evaluate(`(() => { nav('#/'); })()`);
  });

  t('M5 评论时间按日期显示（不再「几天前」），悬浮给完整时间戳', async () => {
    const page = getPage();
    await loginAs('admin', 'admin123', 'admin');
    await page.evaluate(`(() => {
      const t = DB.tasks.find(x=>!x.completed) || DB.tasks[0];
      t.comments.push({ id:'cm_e2e_old', userId: ME.id, text:'E2E旧评论', ts: Date.now() - 86400000*10 });
      t.comments.push({ id:'cm_e2e_now', userId: ME.id, text:'E2E新评论', ts: Date.now() - 5*60000 });
      window.__m5tid = t.id; saveDB();
    })()`);
    await page.evaluate(`(() => { openDrawer(window.__m5tid); })()`);
    await page.waitFor(`(() => document.querySelectorAll('#drawer-body .c-time').length >= 2)()`,
      { timeout: 15000, name:'抽屉应渲染两条测试评论' });
    const r = await page.evaluate(`(() => {
      const times = [...document.querySelectorAll('#drawer-body .c-time')].map(e=>({
        txt: e.textContent.trim(), title: e.getAttribute('title') || '' }));
      return {
        times,
        hasDate: times.some(x=>/\\d+月\\d+日 \\d{2}:\\d{2}/.test(x.txt)),
        hasRel:  times.some(x=>/分钟前/.test(x.txt)),
        nDaysAgo: times.filter(x=>/天前/.test(x.txt)).length,
        datedTitle: (times.find(x=>/\\d+月/.test(x.txt))||{}).title || ''
      };
    })()`);
    console.log('        M5 时间=' + JSON.stringify(r.times));
    assertTruthy(r.hasDate, '10 天前的评论应显示「M月D日 HH:MM」：' + JSON.stringify(r.times));
    assertTruthy(r.hasRel, '5 分钟前的评论仍应显示相对时间');
    assertEq(r.nDaysAgo, 0, '任何时间都不应再出现「N天前」');
    assertMatch(r.datedTitle, /评论于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '悬浮提示应给出完整时间戳：' + r.datedTitle);
    // 清理
    await page.evaluate(`(() => {
      const t = DB.tasks.find(x=>x.id===window.__m5tid);
      if(t) t.comments = t.comments.filter(c=>c.id!=='cm_e2e_old' && c.id!=='cm_e2e_now');
      saveDB(); closeDrawer(); renderApp();
    })()`);
  });

};