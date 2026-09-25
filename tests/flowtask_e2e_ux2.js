/* FlowTask E2E · UX 场景集第二批（由 tests/flowtask_e2e.js 注入断言工具后执行）
 * 覆盖需要在真实浏览器里才能证明的行为：活动记录折叠、切换任务的滚动位置、
 * 快速添加的默认项目回落规则。
 * 约定：传给 evaluate/waitFor 的 IIFE 表达式一律以 ")()" 结尾，避免与宿主的函数字面量猜测冲突。
 */
module.exports = function defineUx2Scenarios(ctx){
  const { t, assertTruthy, assertEq, assertMatch, getPage, loginAs } = ctx;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  t('M6 活动记录默认折叠（创建 + 最近 3 条），点开展开；切换任务回到顶部', async () => {
    const page = getPage();
    /* 可见性只认成员名单后，场景要自己说清以谁的身份跑（上一场景留在页面上的可能是别的账户） */
    await loginAs('admin', 'admin123', 'admin');
    const prep = await page.evaluate(`(() => {
      const t = DB.tasks.find(x=>!x.completed) || DB.tasks[0];
      t.desc = Array(120).join('长描述段落\\n');            // 撑高内容，便于验证滚动位置
      t.activities = Array.from({length:8}, (_,i)=>({ id:'act_'+i, userId: ME.id, text:'E2E动态'+i, ts: 1700000000000 + i*1000 }));
      window.__m6tid = t.id;
      const other = DB.tasks.find(x=>x.id!==t.id);
      window.__m6other = other ? other.id : null;
      saveDB();
      return { id: t.id, hasOther: !!other };
    })()`);
    assertTruthy(prep.id, '应取到一条任务做实验');
    await page.evaluate(`(() => { openDrawer(window.__m6tid); })()`);
    await page.waitFor(`(() => document.querySelectorAll('#drawer-body .activity-item').length > 0)()`, { name:'活动记录已渲染' });

    const folded = await page.evaluate(`(() => ({
      rows: [...document.querySelectorAll('#drawer-body .activity-item')].map(e=>e.textContent),
      btn: (document.querySelector('#drawer-body [data-act-fold]')||{}).textContent || ''
    }))()`);
    assertEq(folded.rows.length, 4, '折叠时只应显示 4 条（创建 + 最近 3 条）：' + JSON.stringify(folded.rows.map(x=>x.slice(0,24))));
    assertTruthy(/E2E动态7/.test(folded.rows[0]), '第一行应是最近的动态：' + folded.rows[0]);
    assertTruthy(/E2E动态0/.test(folded.rows[folded.rows.length-1]), '最后一行应是最早的「创建」记录：' + folded.rows[folded.rows.length-1]);
    assertMatch(folded.btn, /显示全部 8 条动态/, '应给出展开入口：' + folded.btn);

    await page.evaluate(`(() => { document.querySelector('#drawer-body [data-act-fold]').click(); })()`);
    await page.waitFor(`(() => document.querySelectorAll('#drawer-body .activity-item').length === 8)()`, { timeout: 15000, name:'展开后应有 8 条' });
    const expandedBtn = await page.evaluate(`(() => (document.querySelector('#drawer-body [data-act-fold]')||{}).textContent || '')()`);
    assertMatch(expandedBtn, /收起动态/, '展开后按钮应变为收起：' + expandedBtn);

    /* 切到另一条任务：滚动位置必须回到顶部 */
    await page.evaluate(`(() => { const b = document.getElementById('drawer-body'); b.scrollTop = 260; })()`);
    const scrolled = await page.evaluate(`(() => document.getElementById('drawer-body').scrollTop)()`);
    assertTruthy(scrolled > 100, '前置条件：抽屉应已向下滚动（实际 ' + scrolled + '）');
    if(prep.hasOther){
      await page.evaluate(`(() => { openDrawer(window.__m6other); })()`);
      await page.waitFor(`(() => document.getElementById('drawer-body').scrollTop === 0)()`,
        { timeout: 15000, name:'切到另一条任务应回到顶部' });
    }

    /* 重开同一条：展开状态在会话内保留，不该被弹回折叠 */
    await page.evaluate(`(() => { openDrawer(window.__m6tid); })()`);
    await page.waitFor(`(() => document.querySelectorAll('#drawer-body .activity-item').length === 8)()`,
      { timeout: 15000, name:'同一条重开应保持展开' });

    /* 收起 + 还原数据 */
    await page.evaluate(`(() => {
      document.querySelector('#drawer-body [data-act-fold]').click();
      const t = DB.tasks.find(x=>x.id===window.__m6tid);
      if(t){ t.activities = []; t.desc = ''; }
      saveDB(); closeDrawer(); renderApp();
    })()`);
    const back = await page.evaluate(`(() => {
      openDrawer(window.__m6tid);
      return document.querySelectorAll('#drawer-body .activity-item').length;
    })()`);
    assertEq(back, 0, '实验数据应已还原（无活动记录）');
    await page.evaluate(`(() => { closeDrawer(); })()`);
  });

  t('M7 快速添加默认项目：项目内用当前项目，不在项目时用上次创建的项目', async () => {
    const page = getPage();
    /* 前置：保证当前账户名下有两个可写项目（套件跑到后段登录态可能是新建用户） */
    const prep = await page.evaluate(`(() => {
      const mine = DB.projects.filter(p=>!p.archived && p.memberIds && p.memberIds.includes(ME.id));
      const made = [];
      const mk = (id, name) => {
        DB.projects.push({ id, name, color:'#14b8a6', desc:'', ownerId:ME.id, memberIds:[ME.id],
          archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
        made.push(id); return id;
      };
      if(mine.length < 2){ mk('p_m7_a', 'E2E默认项目A'); mk('p_m7_b', 'E2E默认项目B'); }
      saveDB();
      const list = DB.projects.filter(p=>!p.archived && p.memberIds.includes(ME.id));
      return { first: list[0].id, second: (list.find(p=>p.id!==list[0].id)||list[0]).id, made };
    })()`);
    const inProj = await page.evaluate(`(() => {
      const p = DB.projects.find(x=>x.id===${JSON.stringify(prep.first)});
      nav('#/project/' + p.id + '/list');
      return { id: p.id, name: p.name };
    })()`);
    await page.waitFor(`(() => location.hash.indexOf('/list') !== -1)()`, { timeout: 15000, name:'已进入项目' });

    /* 项目内呼出快速添加（与 Tab+Q 同一条路径：不传参数） */
    await page.evaluate(`(() => { openQuickAddModal(); })()`);
    await page.waitForSelector('#qa-project');
    const defHere = await page.evaluate(`(() => ({
      sel: document.getElementById('qa-project').value,
      label: document.getElementById('qa-project').selectedOptions[0].textContent.trim()
    }))()`);
    assertEq(defHere.sel, inProj.id, '在项目里呼出快速添加，默认应是当前项目：' + JSON.stringify(defHere));
    assertTruthy(defHere.label.includes(inProj.name), '下拉显示的当前项目名应正确：' + defHere.label);

    /* 换到另一个「我参与的」项目创建一条任务 → 应记住这次用的项目 */
    const other = await page.evaluate(`(() => {
      const sel = document.getElementById('qa-project');
      const alt = [...sel.options].find(o=>o.value && o.value !== sel.value
        && (P.visibleProject(o.value)||{}).memberIds
        && (P.visibleProject(o.value)||{}).memberIds.includes(ME.id));
      if(!alt) return null;
      sel.value = alt.value;
      sel.dispatchEvent(new Event('change', { bubbles:true }));
      const ti = document.getElementById('qa-title');
      ti.value = 'M7默认项目记忆';
      ti.dispatchEvent(new Event('input', { bubbles:true }));
      const top = MODAL_STACK[MODAL_STACK.length-1];
      top.querySelector('.modal-ok').click();
      return { id: alt.value };
    })()`);
    if(other){
      await page.waitFor(`(() => DB.tasks.some(t=>t.title==='M7默认项目记忆' && t.projectId===${JSON.stringify(other.id)}))()`,
        { timeout: 15000, name:'任务应创建在选定的另一个项目里' });
      const last = await page.evaluate(`(() => UI.lastAddPid)()`);
      assertEq(last, other.id, '创建后应记住该项目作为下次默认值：' + last);

      /* 回到首页（不在任何项目上下文）→ 默认值回落到上次创建的项目 */
      await page.evaluate(`(() => { nav('#/'); })()`);
      await page.waitFor(`(() => ROUTE.page === 'home')()`, { timeout: 15000, name:'回到首页' });
      await page.evaluate(`(() => { openQuickAddModal(); })()`);
      await page.waitForSelector('#qa-project');
      const defHome = await page.evaluate(`(() => document.getElementById('qa-project').value)()`);
      assertEq(defHome, other.id, '不在项目中时应回落到上次创建任务的项目：' + defHome);
    }

    /* 清理实验数据（含本用例自建的项目） */
    await page.evaluate(`(() => {
      maskRemoveAll();
      DB.tasks = DB.tasks.filter(t=>t.title!=='M7默认项目记忆');
      DB.projects = DB.projects.filter(p=>p.id!=='p_m7_a' && p.id!=='p_m7_b');
      saveDB(); renderApp();
    })()`);
  });

  t('M8 首页「今天 / 未来7天」同时显示子任务，点开进子任务详情', async () => {
    const page = getPage();
    /* 前置：一个我是成员的项目 + 一条无截止任务，挂 3 个子任务（今天到期 / 3天后 / 今天已完成） */
    await page.evaluate(`(() => {
      if(!DB.projects.some(p=>p.id==='p_m8_home')){
        DB.projects.push({ id:'p_m8_home', name:'E2E首页子任务项目', color:'#8b5cf6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      }
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m8_home');
      DB.tasks.push({ id:'t_m8_home', projectId:'p_m8_home', title:'M8宿主任务', desc:'', assigneeId:ME.id,
        dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
        order:Date.now(), subtasks:[
          { id:'st_m8_today', title:'M8今天子任务', done:false, status:'todo', assigneeId:null,
            dueDate: todayStr(), startDate:null, priority:null, tags:[], followers:[], desc:'', comments:[], recurring:null,
            activities:[], createdAt:Date.now(), createdBy:ME.id },
          { id:'st_m8_soon', title:'M8三天子任务', done:false, status:'todo', assigneeId:null,
            dueDate: dateOffset(3), startDate:null, priority:null, tags:[], followers:[], desc:'', comments:[], recurring:null,
            activities:[], createdAt:Date.now(), createdBy:ME.id },
          { id:'st_m8_done', title:'M8已完成子任务', done:true, status:'done', assigneeId:null,
            dueDate: todayStr(), startDate:null, priority:null, tags:[], followers:[], desc:'', comments:[], recurring:null,
            activities:[], createdAt:Date.now(), createdBy:ME.id }
        ], comments:[], tags:[], followers:[], recurring:null,
        activities:[{id:uid('a_'), userId:ME.id, text:'创建了任务', ts:Date.now()}],
        createdAt:Date.now(), createdBy:ME.id });
      saveDB(); renderApp();
    })()`);
    await page.evaluate(`(() => { nav('#/'); })()`);
    await page.waitFor(`(() => ROUTE.page === 'home' && document.querySelectorAll('#content .mini-sub').length > 0)()`,
      { timeout: 15000, name:'首页应渲染子任务行' });
    const cards = await page.evaluate(`(() => {
      const q = sel => document.querySelector(sel);
      const cardText = sel => { const c = [...document.querySelectorAll(sel)]; return c.length ? c[0].textContent : ''; };
      return {
        todayRows: [...document.querySelectorAll('.home-card.home-primary .mini-task')].map(e=>e.textContent),
        soonRows: [...document.querySelectorAll('.home-grid .home-card .mini-task')].map(e=>e.textContent),
        hasDone: document.body.textContent.includes('M8已完成子任务')
      };
    })()`);
    const diag = await page.evaluate(`(() => {
      const visIds = new Set(P.visibleProjects().map(p=>p.id));
      const subs = DB.tasks.filter(t=>visIds.has(t.projectId) && !t.completed)
        .flatMap(t=>(t.subtasks||[]).filter(s=>s.dueDate && !s.done).map(s=>({t:t.id, s:s.id, due:s.dueDate, title:s.title})));
      const card = document.querySelector('.home-card.home-primary');
      return { today: todayStr(), subCount: subs.length, subs: subs.map(x=>x.title+'/'+x.due),
        cardExists: !!card, cardRows: card ? card.querySelectorAll('.mini-task').length : -1,
        cardLen: card ? card.innerHTML.length : 0, route: ROUTE.page,
        cardHTML: card ? card.innerHTML : '',
        miniSubInContent: document.querySelectorAll('#content .mini-sub').length,
        miniSubTexts: [...document.querySelectorAll('#content .mini-sub')].map(e=>({
          txt: e.textContent.trim().slice(0,60),
          inPrimary: !!e.closest('.home-card.home-primary'),
          inGrid: !!e.closest('.home-grid') })) };
    })()`);
    console.log('        M8 诊断=' + JSON.stringify(diag));
    /* 强制重绘后复测：区分「渲染数据错误」与「DOM 陈旧」 */
    const after2 = await page.evaluate(`(() => {
      renderApp();
      const card = document.querySelector('.home-card.home-primary');
      return { cardRows: card ? card.querySelectorAll('.mini-task').length : -1,
        cardIsEmpty: card ? /今天没有到期或逾期/.test(card.innerHTML) : null,
        miniSubInContent: document.querySelectorAll('#content .mini-sub').length };
    })()`);
    console.log('        M8 强制重绘后=' + JSON.stringify(after2));
    assertTruthy(cards.todayRows.some(x=>x.includes('M8今天子任务') && x.includes('子任务')), '今天卡片应含未完成的今天子任务（带子任务标记）：' + JSON.stringify(cards.todayRows) + ' 诊断=' + JSON.stringify(diag));
    assertTruthy(cards.soonRows.some(x=>x.includes('M8三天子任务') && x.includes('子任务')), '未来7天卡片应含子任务：' + JSON.stringify(cards.soonRows));
    assertTruthy(!cards.hasDone, '已完成子任务不应出现在首页：');
    /* 点子任务行 → 打开子任务详情抽屉 */
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('.mini-task[data-sub]')].find(e=>e.textContent.includes('M8今天子任务'));
      row.click();
    })()`);
    await page.waitFor(`(() => document.getElementById('drawer').classList.contains('on')
      && (CURRENT_SUB||{}).id === 'st_m8_today')()`, { timeout: 15000, name:'应打开子任务详情抽屉' });
    /* 清理 */
    await page.evaluate(`(() => {
      closeDrawer();
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m8_home');
      DB.projects = DB.projects.filter(p=>p.id!=='p_m8_home');
      saveDB(); renderApp();
    })()`);
  });

  t('M9 首页子任务行有完成圆圈：点击完成并从卡片消失', async () => {
    const page = getPage();
    await page.evaluate(`(() => {
      if(!DB.projects.some(p=>p.id==='p_m9_home')){
        DB.projects.push({ id:'p_m9_home', name:'E2E圆圈项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      }
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m9_home');
      DB.tasks.push({ id:'t_m9_home', projectId:'p_m9_home', title:'M9宿主任务', desc:'', assigneeId:ME.id,
        dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
        order:Date.now(), subtasks:[
          { id:'st_m9', title:'M9待完成子任务', done:false, status:'todo', assigneeId:null,
            dueDate: todayStr(), startDate:null, priority:null, tags:[], followers:[], desc:'', comments:[], recurring:null,
            activities:[], createdAt:Date.now(), createdBy:ME.id }
        ], comments:[], tags:[], followers:[], recurring:null,
        activities:[], createdAt:Date.now(), createdBy:ME.id });
      saveDB(); renderApp();
    })()`);
    await page.evaluate(`(() => { nav('#/'); })()`);
    await page.waitFor(`(() => ROUTE.page === 'home'
      && [...document.querySelectorAll('#content .mini-sub')].some(e=>e.textContent.includes('M9待完成子任务')))()`,
      { timeout: 15000, name:'首页应渲染 M9 子任务行' });
    /* 行首应有完成圆圈（与主任务行同款交互） */
    const hasCircle = await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#content .mini-sub')].find(e=>e.textContent.includes('M9待完成子任务'));
      return { circle: !!(row && row.querySelector('.check-circle')), done: false };
    })()`);
    assertTruthy(hasCircle.circle, '首页子任务行应有完成圆圈');
    /* 点圆圈 → 子任务完成并落盘，行从卡片消失 */
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#content .mini-sub')].find(e=>e.textContent.includes('M9待完成子任务'));
      row.querySelector('.check-circle').click();
    })()`);
    await page.waitFor(`(() => {
      const t = DB.tasks.find(x=>x.id==='t_m9_home');
      return t && t.subtasks[0].done === true;
    })()`, { timeout: 15000, name:'点击圆圈后子任务应完成并落盘' });
    await page.waitFor(`(() => !document.body.textContent.includes('M9待完成子任务'))()`,
      { timeout: 15000, name:'完成的子任务应从首页卡片消失' });
    /* 清理 */
    await page.evaluate(`(() => {
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m9_home');
      DB.projects = DB.projects.filter(p=>p.id!=='p_m9_home');
      saveDB(); renderApp();
    })()`);
  });

  t('M10 抽屉里子任务可拖拽排序，顺序落盘', async () => {
    const page = getPage();
    await page.evaluate(`(() => {
      if(!DB.projects.some(p=>p.id==='p_m10_drag')){
        DB.projects.push({ id:'p_m10_drag', name:'E2E拖拽项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      }
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m10_drag');
      DB.tasks.push({ id:'t_m10_drag', projectId:'p_m10_drag', title:'M10拖拽宿主', desc:'', assigneeId:ME.id,
        dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
        order:Date.now(), subtasks:['A','B','C'].map(x=>({ id:'st_m10_'+x, title:'M10子任务'+x, done:false, status:'todo',
          assigneeId:null, dueDate:null, startDate:null, priority:null, tags:[], followers:[], desc:'', comments:[], recurring:null,
          activities:[], createdAt:Date.now(), createdBy:ME.id })), comments:[], tags:[], followers:[], recurring:null,
        activities:[], createdAt:Date.now(), createdBy:ME.id });
      saveDB();
      openDrawer('t_m10_drag');
      return DB.tasks.find(x=>x.id==='t_m10_drag').subtasks.map(s=>s.id);
    })()`);
    await page.waitFor(`(() => document.querySelectorAll('#drawer-body .subtask-row[draggable]').length === 3)()`,
      { timeout: 15000, name:'三个子任务行应可拖拽' });
    /* 模拟拖拽：第 1 行拖到第 2 行下方 → A/B/C 变 B/A/C */
    const after = await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#drawer-body .subtask-row[draggable]')];
      const src = rows[0], dst = rows[1];
      const dt = new DataTransfer();
      const fire = (el, type, o) => el.dispatchEvent(new DragEvent(type, Object.assign({ bubbles:true, cancelable:true, dataTransfer:dt }, o)));
      fire(src, 'dragstart');
      const r = dst.getBoundingClientRect();
      fire(dst, 'dragover', { clientY: r.bottom - 2 });
      fire(dst, 'drop', { clientY: r.bottom - 2 });
      fire(src, 'dragend');
      return DB.tasks.find(x=>x.id==='t_m10_drag').subtasks.map(s=>s.title);
    })()`);
    assertTruthy(after[0] === 'M10子任务B' && after[1] === 'M10子任务A' && after[2] === 'M10子任务C',
      '拖拽后顺序应为 B/A/C，实际 ' + JSON.stringify(after));
    /* DOM 顺序与数据一致 */
    const domOrder = await page.evaluate(`(() => [...document.querySelectorAll('#drawer-body .subtask-row .st-title')].map(e=>e.textContent))()`);
    assertTruthy(domOrder[0].includes('M10子任务B') && domOrder[1].includes('M10子任务A'),
      '抽屉 DOM 顺序应与数据一致：' + JSON.stringify(domOrder));
    /* 清理 */
    await page.evaluate(`(() => {
      closeDrawer();
      DB.tasks = DB.tasks.filter(t=>t.id!=='t_m10_drag');
      DB.projects = DB.projects.filter(p=>p.id!=='p_m10_drag');
      saveDB(); renderApp();
    })()`);
  });

  t('M11 未配置共享盘时顶栏不出现同步指示（默认模式界面零变化）', async () => {
    const page = getPage();
    const r = await page.evaluate(`(() => {
      const el = document.getElementById('sync-status');
      const store = document.getElementById('store-status');
      return {
        exists: !!el,
        hidden: el ? !!el.hidden : null,
        display: el ? getComputedStyle(el).display : '',
        info: (typeof _syncInfo === 'undefined') ? 'UNDEF' : _syncInfo,
        viewHidden: (typeof _syncInfo === 'undefined' || _syncInfo === null) ? true : syncStatusView(_syncInfo) === null,
        api: typeof refreshSyncStatus === 'function' && typeof manualSync === 'function'
          && typeof syncStatusView === 'function' && typeof adoptRemoteIfNewer === 'function',
        storeText: store ? store.textContent : ''
      };
    })()`);
    assertTruthy(r.exists, '同步指示按钮应已写入顶栏 DOM（默认是隐藏，不是不存在）');
    assertTruthy(r.hidden === true || r.display === 'none',
      '未配置共享盘时这枚按钮必须不可见：' + JSON.stringify(r));
    /* 未配置时服务端会如实回 enabled:false（对象而非 null），关键是视图必须判成「不显示」 */
    assertTruthy(r.info === null || (r.info && r.info.enabled === false),
      '未开启共享盘时同步状态应为空或 enabled:false，实际 ' + JSON.stringify(r.info));
    assertTruthy(r.viewHidden === true, '视图函数对该状态必须返回 null：' + JSON.stringify(r.viewHidden));
    assertTruthy(r.api, '手动同步、状态刷新、纯函数视图都应已挂上');
    /* 同一屏上原有的「已保存」指示不能因为新按钮而消失或串位 */
    assertTruthy(/保存|文件存储/.test(r.storeText), '原有存储状态签应仍在：' + r.storeText);
  });

  t('M12 顶栏同步指示的四种取态（纯函数视图，不依赖服务端）', async () => {
    const page = getPage();
    const v = await page.evaluate(`(() => ({
      off:    syncStatusView({ enabled:false }),
      on:     syncStatusView({ enabled:true, reachable:true, pending:0, lastSyncAt:Date.now() }),
      pend:   syncStatusView({ enabled:true, reachable:true, pending:3 }),
      down:   syncStatusView({ enabled:true, reachable:false, lastError:'share-read:ECONNRESET' })
    }))()`);
    assertEq(v.off, null, '未配置共享盘 → 不显示');
    assertTruthy(v.on && v.on.cls === 'ok' && /已同步/.test(v.on.txt), '正常态应为绿色「已同步」：' + JSON.stringify(v.on));
    assertTruthy(v.pend && v.pend.cls === 'saving' && /3/.test(v.pend.txt), '排队态应显示项数：' + JSON.stringify(v.pend));
    assertTruthy(v.down && v.down.cls === 'err' && /断开/.test(v.down.txt), '断开态应转红并说明：' + JSON.stringify(v.down));
    assertTruthy(/本机数据仍在正常保存/.test(v.down.tip) && /ECONNRESET/.test(v.down.tip),
      '断开提示要先安抚本机数据安全，再给失败原因：' + v.down.tip);
  });

  /* ===== v1.9 数据导出：在真浏览器里验「界面选什么 → 文件里就有什么」 ===== */
  const seedExportFixture = async () => {
    const page = getPage();
    await page.evaluate(`(() => {
      if(!DB.projects.some(p=>p.id==='p_ex')){
        DB.projects.push({ id:'p_ex', name:'E2E导出项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      }
      DB.tasks = DB.tasks.filter(t=>String(t.projectId)!=='p_ex');
      var mk = function(id, title, extra){
        return Object.assign({ id:id, projectId:'p_ex', title:title, desc:'', assigneeId:ME.id,
          dueDate:null, startDate:null, priority:'low', status:'todo', completed:false, completedAt:null,
          order:Date.now(), subtasks:[], comments:[], tags:[], followers:[], recurring:null,
          activities:[], createdAt:Date.now(), createdBy:ME.id }, extra||{});
      };
      DB.tasks.push(mk('t_ex_1', '锁定供应商', { dueDate:'2026-01-05', status:'doing' }));
      DB.tasks.push(mk('t_ex_2', '含"引号",和逗号的标题', { status:'done', completed:true, completedAt:Date.now() }));
      DB.tasks.push(mk('t_ex_3', '=1+1 危险标题', { priority:'high', subtasks:[
        { id:'st_ex_a', title:'比价', done:true },
        { id:'st_ex_b', title:'回签', done:false, dueDate:'2026-01-06' }
      ]}));
      saveDB();
      return true;
    })()`);
    await page.evaluate(`(() => { nav('#/project/p_ex/list'); })()`);
    await page.waitFor(`(() => ROUTE.page==='project' && document.getElementById('proj-export-btn'))()`,
      { timeout: 15000, name:'项目页与导出按钮就绪' });
    await page.evaluate(`(() => {
      window.__dl = [];
      window.downloadText = function(name, text, mime){ window.__dl.push({ name:name, text:text, mime:mime }); return true; };
      return true;
    })()`);
  };
  const openExport = async () => {
    const page = getPage();
    /* 场景之间必须独立：前一个场景断言失败时弹层可能还开着，
       不清场就会让下一个场景的 waitFor 命中「上一个弹层」，报错信息完全误导 */
    await page.evaluate(`(() => {
      for(var i=0;i<6 && document.querySelector('.modal-mask');i++){ closeTopModal(false); }
      return document.querySelectorAll('.modal-mask').length;
    })()`);
    await page.evaluate(`(() => { document.getElementById('proj-export-btn').click(); return true; })()`);
    await page.waitFor(`(() => {
      var m = document.querySelector('.modal-mask');
      return !!(m && m.textContent.indexOf('导出数据') >= 0
        && m.querySelector('[data-ex="fmt:csv"]') && document.getElementById('ex-sum'));
    })()`, { timeout: 15000, name:'导出弹层打开且汇总区就绪' });
  };

  t('M14 项目页导出 CSV：中文表头带 BOM、危险字符被防注入、文件名带日期', async () => {
    await seedExportFixture();
    await openExport();
    const page = getPage();
    /* 从项目页进来时，默认范围就应是「本项目」，且带条数 */
    const head = await page.evaluate(`(() => {
      var m = document.querySelector('.modal-mask');
      var scopeOn = [...m.querySelectorAll('[data-ex^="scope:"].on')].map(e=>e.textContent.trim());
      return { scopeOn: scopeOn.join('|'), sum: document.getElementById('ex-sum').textContent,
               prevRows: document.querySelectorAll('#ex-body .ex-prev tbody tr').length };
    })()`);
    assertTruthy(/E2E导出项目/.test(head.scopeOn), '从项目页进入应默认选中本项目：' + head.scopeOn);
    assertTruthy(/\s3$/.test(head.scopeOn.trim()), '范围按钮上应直接显示条数：' + head.scopeOn);
    assertTruthy(/将导出/.test(head.sum) && /行/.test(head.sum), '实时汇总要说清几行几列：' + head.sum);
    assertTruthy(head.prevRows > 0, '预览必须真渲染出数据行，实际 ' + head.prevRows);
    await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
    await page.waitFor(`(() => window.__dl && window.__dl.length === 1)()`, { timeout: 15000, name:'CSV 已生成' });
    const csv = await page.evaluate(`(() => window.__dl[0])()`);
    assertMatch(csv.name, /^FlowTask-\d{8}-.+\.csv$/, '文件名应带日期与范围：' + csv.name);
    assertTruthy(/text\/csv/.test(csv.mime), 'MIME 要是 csv：' + csv.mime);
    assertEq(csv.text.charCodeAt(0), 0xFEFF, 'CSV 首字符必须是 UTF-8 BOM（否则 Excel 打开中文乱码）');
    assertTruthy(/^"任务","所属项目","状态","优先级","负责人","开始日期","截止日期","是否逾期","子任务进度","标签"$/
      .test(csv.text.replace(/^\uFEFF/, '').split('\r\n')[0]),
      '表头应是默认常用列的中文与顺序：' + csv.text.replace(/^\uFEFF/, '').split('\r\n')[0]);
    assertTruthy(csv.text.includes('"含""引号"",和逗号的标题"'), '引号与逗号必须按 RFC4180 转义');
    assertTruthy(csv.text.includes("\"'=1+1 危险标题\""),
      '以 = 开头的标题应被加前导单引号，防 Excel 公式注入');
    assertTruthy(csv.text.includes('"锁定供应商"') && /\r\n/.test(csv.text), '数据行存在且用 CRLF 分行');
    /* 逾期口径：锁定供应商 dueDate 2026-01-05 早于今天 → 该列应为「是」。
       标题本身就含逗号，按逗号切列会错位，所以只判整行的包含关系 */
    const lines = csv.text.split('\r\n');
    const lockLine = lines.find(l => l.includes('锁定供应商'));
    const doneLine = lines.find(l => l.includes('含""引号""'));
    assertTruthy(lockLine && /"是"/.test(lockLine), '逾期未完成的那行应出现「是」：' + lockLine);
    assertTruthy(doneLine && !/"是"/.test(doneLine), '已完成且无截止日期的那行不该标逾期：' + doneLine);
  });

  t('M15 导出选项真的改变产物：展开子任务增行、取消全部列被拦下', async () => {
    const page = getPage();
    await seedExportFixture();
    await openExport();
    const n1 = await page.evaluate(`(() => {
      var m = document.getElementById('ex-sum').textContent.match(/(\\d+)\\s*行/);
      return m ? Number(m[1]) : -1;
    })()`);
    assertTruthy(n1 > 0, '基线行数应能解析出来，实际 ' + n1);
    await page.evaluate(`(() => {
      document.querySelector('.modal-mask [data-ex-toggle="withSub"]').click(); return true;
    })()`);
    await page.waitFor(`(() => {
      var m = document.getElementById('ex-sum').textContent.match(/(\\d+)\\s*行/);
      return m && Number(m[1]) > ` + n1 + `;
    })()`, { timeout: 10000, name:'勾选展开子任务后行数应增加' });
    const after = await page.evaluate(`(() => ({
      n: Number((document.getElementById('ex-sum').textContent.match(/(\\d+)\\s*行/) || [])[1]),
      hasParent: document.getElementById('ex-body').textContent.indexOf('父任务') >= 0
    }))()`);
    assertTruthy(after.hasParent, '展开子任务后应出现「父任务」列');
    assertTruthy(after.n > n1, '展开子任务后行数应增加：' + n1 + ' → ' + after.n);
    await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
    await page.waitFor(`(() => window.__dl.length === 1)()`, { timeout: 10000, name:'展开子任务的导出完成' });
    const csv2 = await page.evaluate(`(() => window.__dl[0].text)()`);
    assertTruthy(csv2.includes('"比价"') && csv2.includes('"回签"'), '子任务应各自成行：' + csv2.slice(0, 220));
    assertTruthy(/^"任务".*"类型","父任务"$/.test(csv2.replace(/^\uFEFF/, '').split('\r\n')[0]),
      '展开子任务应自动带上「类型」「父任务」两列：' + csv2.replace(/^\uFEFF/, '').split('\r\n')[0]);
    /* 导出成功后弹层会正常关闭，所以后半段要重新打开再验「列全取消」的守卫 */
    await openExport();
    /* 点「全部列」是取反不是清空（默认勾 10 漏 8，全点反而剩 8 列）——只点当前已勾的 */
    const emptied = await page.evaluate(`(() => {
      var onKeys = [...document.querySelectorAll('.modal-mask [data-ex-col].on')].map(e => e.dataset.exCol);
      onKeys.forEach(function(k){
        var el = document.querySelector('.modal-mask [data-ex-col="' + k + '"]');
        if(el) el.click();
      });
      return { clicked: onKeys.length, still: document.querySelectorAll('.modal-mask [data-ex-col].on').length };
    })()`);
    assertTruthy(emptied.clicked > 0 && emptied.still === 0, '应能把列全部取消：' + JSON.stringify(emptied));
    const cleared = await page.evaluate(`(() => document.getElementById('ex-sum').textContent)()`);
    assertTruthy(/至少勾选/.test(cleared), '列全取消时汇总区要直接说明：' + cleared);
    await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
    await sleep(700);
    const guarded = await page.evaluate(`(() => ({
      still: !!document.querySelector('.modal-mask'),
      calls: window.__dl.length
    }))()`);
    assertTruthy(guarded.still, '没有列时不能把弹层关掉（否则用户以为导出成功了）');
    assertEq(guarded.calls, 1, '也不能真的下载');
    await page.evaluate(`(() => { closeTopModal(false); return true; })()`);
  });

  t('M16 Markdown 导出：按项目分组、任务态与逾期标注、可复制', async () => {
    const page = getPage();
    await seedExportFixture();
    await openExport();
    await page.evaluate(`(() => { document.querySelector('.modal-mask [data-ex="fmt:md"]').click(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('ex-mdtext'))()`, { timeout: 10000, name:'Markdown 文本框出现' });
    const md = await page.evaluate(`(() => ({
      text: document.getElementById('ex-mdtext').value,
      colsHidden: document.querySelector('.modal-mask [data-ex-row="cols"]').hidden,
      copyShown: !document.getElementById('ex-copy').hidden
    }))()`);
    assertTruthy(md.colsHidden, 'Markdown 不需要选列，该组应隐藏');
    assertTruthy(md.copyShown, 'Markdown 模式应出现「复制 Markdown」');
    assertTruthy(/^# 任务清单 · /m.test(md.text), '应有一级标题：' + md.text.slice(0, 80));
    assertTruthy(md.text.includes('## E2E导出项目'), '应按项目分组：' + md.text.slice(0, 200));
    assertTruthy(md.text.includes('- [ ] 锁定供应商'), '未完成任务用 - [ ]');
    assertTruthy(md.text.includes('- [x] 含"引号",和逗号的标题'), '已完成任务用 - [x]');
    assertTruthy(/截止 2026-01-05（已逾期）/.test(md.text), '逾期要就地标注');
    assertTruthy(md.text.includes('· 高'), '优先级只标非低：' + md.text.slice(0, 260));
    assertTruthy(md.text.includes('子任务 1/2'), '主任务应带子任务进度');
    await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
    await page.waitFor(`(() => window.__dl.length === 1)()`, { timeout: 10000, name:'md 文件已生成' });
    const last = await page.evaluate(`(() => window.__dl[0])()`);
    assertMatch(last.name, /^FlowTask-\d{8}-.+\.md$/, 'Markdown 文件名后缀应为 .md：' + last.name);
    assertTruthy(last.text.includes('## E2E导出项目'), '下载内容应与预览一致');
    await page.evaluate(`(() => { closeTopModal(false); return true; })()`);
  });

  t('M13 保存后自动进入同步过渡态（不需要点按钮）', async () => {
    const page = getPage();
    /* 伪装成「服务端已开启同步」的状态：E2E 不挂真共享盘（那是同步对等测试的职责），
       这里只验客户端接线——保存成功 → 顶栏自己转「同步中」，而不是停在旧时间等人点 */
    const before = await page.evaluate(`(() => {
      _syncInfo = { enabled:true, reachable:true, pending:0, lastSyncAt: Date.now() - 60000, files:[] };
      _syncSavedAt = 0;
      updateSyncStatus();
      const el = document.getElementById('sync-status');
      return { hidden: !!el.hidden, txt: el.textContent };
    })()`);
    assertTruthy(!before.hidden, '开启同步后状态签应显示出来');
    assertTruthy(/已同步/.test(before.txt), '空闲态应为「已同步」：' + before.txt);
    /* 真实改一次数据并保存（走 pushStoreSvc → 服务端写入 → 回包后 markLocalSavedForSync） */
    await page.evaluate(`(() => { DB.meta.e2e_m13 = Date.now(); saveDB(); })()`);
    const settled = await page.waitFor(`(() => _syncSavedAt > 0)()`, { timeout: 20000, name:'保存后应记录待镜像时刻' });
    assertTruthy(settled, '保存成功后应自动登记同步过渡态（全程没点过任何按钮）');
    const after = await page.evaluate(`(() => {
      const el = document.getElementById('sync-status');
      return { txt: el.textContent, saving: el.classList.contains('saving') };
    })()`);
    assertTruthy(/同步中/.test(after.txt) && after.saving,
      '顶栏应自动转入「同步中」而不是停在旧时间等用户点：' + JSON.stringify(after));
    /* 还原，避免影响其它场景 */
    await page.evaluate(`(() => {
      _syncInfo = null; _syncSavedAt = 0; updateSyncStatus();
      delete DB.meta.e2e_m13; saveDB();
    })()`);
  });

  t('M20 数据管理页可改同步文件夹：校验通过才切换、坏路径不落地、停用后回到未启用', async () => {
    const page = getPage();
    const fs = require('fs'), os = require('os'), path = require('path');
    const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-e2e-share-'));
    const ghostDir = path.join(os.tmpdir(), 'ft-e2e-ghost-' + Date.now());
    try{
      await page.evaluate(`(() => { nav('#/data'); return true; })()`);
      await page.waitFor(`(() => document.getElementById('sc-dir') && document.getElementById('sc-save'))()`,
        { timeout: 20000, name:'数据管理页出现同步设置卡片' });
      const initial = await page.evaluate(`(() => document.getElementById('share-body').textContent.replace(/\\s+/g,' '))()`);
      assertTruthy(/未启用/.test(initial), '默认（没配共享盘）应显示未启用：' + initial.slice(0, 90));

      /* 填一个打不开的路径：必须被拒绝，且不能在磁盘上造出这个目录 */
      await page.evaluate(`(() => { document.getElementById('sc-dir').value = ` + JSON.stringify(ghostDir) + `; return true; })()`);
      await page.evaluate(`(() => { document.getElementById('sc-save').click(); return true; })()`);
      await page.waitFor(`(() => document.getElementById('sc-msg').textContent.indexOf('用不了') >= 0)()`,
        { timeout: 15000, name:'坏路径应被拒绝并说明' });
      const badMsg = await page.evaluate(`(() => document.getElementById('sc-msg').textContent.replace(/\\s+/g,' '))()`);
      assertTruthy(/原设置未被改动/.test(badMsg), '拒绝时要说明原设置没被动过：' + badMsg.slice(0, 120));
      assertTruthy(!fs.existsSync(ghostDir), '被拒绝的路径没有被凭空创建');

      /* 填一个可用的目录：确认框 → 切换 → 卡片转「已连通」→ 磁盘上真出现镜像 */
      await page.evaluate(`(() => { document.getElementById('sc-dir').value = ` + JSON.stringify(goodDir) + `; return true; })()`);
      await page.evaluate(`(() => { document.getElementById('sc-save').click(); return true; })()`);
      await page.waitFor(`(() => {
        var m = document.querySelector('.modal-mask');
        return !!(m && m.textContent.indexOf('切换同步文件夹') >= 0);
      })()`, { timeout: 15000, name:'切换前应弹确认（换路径有后果）' });
      await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
      await page.waitFor(`(() => document.getElementById('share-body').textContent.indexOf('已连通') >= 0)()`,
        { timeout: 25000, name:'切换后卡片显示已连通' });
      const card = await page.evaluate(`(() => document.getElementById('share-body').textContent.replace(/\\s+/g,' '))()`);
      assertTruthy(card.indexOf(goodDir.replace(/\\/g,'/')) >= 0 || card.indexOf(goodDir) >= 0,
        '卡片应回显当前文件夹：' + card.slice(0, 140));
      const sawMirror = await (async () => {
        for(let i = 0; i < 60; i++){
          if(fs.existsSync(path.join(goodDir, 'team', 'flowtask_auth.json'))) return true;
          await new Promise(r => setTimeout(r, 250));
        }
        return false;
      })();
      assertTruthy(sawMirror, '共享盘 team\\ 下应出现账户表镜像');

      /* 停用：路径保留、状态回到未启用 */
      await page.waitFor(`(() => document.getElementById('sc-off'))()`, { timeout: 15000, name:'出现停用按钮' });
      await page.evaluate(`(() => { document.getElementById('sc-off').click(); return true; })()`);
      await page.waitFor(`(() => {
        var m = document.querySelector('.modal-mask');
        return !!(m && m.textContent.indexOf('停用共享盘同步') >= 0);
      })()`, { timeout: 15000, name:'停用前弹确认' });
      await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
      await page.waitFor(`(() => document.getElementById('share-body').textContent.indexOf('未启用') >= 0)()`,
        { timeout: 25000, name:'停用后回到未启用' });
      /* 「停用保留路径」的用户可见含义：不重敲长路径也能再开起来。
         只经服务端断言，绝不去拼本地文件路径 —— harness 的 FLOWTASK_DATA_DIR 只传给子进程，
         在本进程里它是空的，一旦当路径用就会读到仓库里真实的 flowtask_config.json（生产配置） */
      await page.waitFor(`(() => document.getElementById('sc-on'))()`, { timeout: 15000, name:'出现启用按钮' });
      const dirKept = await page.evaluate(`(() => document.getElementById('sc-dir').value)()`);
      assertTruthy(dirKept === goodDir, '停用后输入框仍保留原路径：' + dirKept);
      await page.evaluate(`(() => { document.getElementById('sc-on').click(); return true; })()`);
      await page.waitFor(`(() => document.getElementById('share-body').textContent.indexOf('已连通') >= 0)()`,
        { timeout: 25000, name:'不重敲路径即可再启用' });
      /* 收尾：把同步关掉，别把临时目录留在配置里给后面的场景 */
      await page.waitFor(`(() => document.getElementById('sc-off'))()`, { timeout: 15000, name:'出现停用按钮' });
      await page.evaluate(`(() => { document.getElementById('sc-off').click(); return true; })()`);
      await page.waitFor(`(() => {
        var m = document.querySelector('.modal-mask');
        return !!(m && m.textContent.indexOf('停用共享盘同步') >= 0);
      })()`, { timeout: 15000, name:'停用前弹确认' });
      await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
      await page.waitFor(`(() => document.getElementById('share-body').textContent.indexOf('未启用') >= 0)()`,
        { timeout: 25000, name:'收尾：回到未启用' });
      const chip = await page.evaluate(`(() => {
        var el = document.getElementById('sync-status');
        return { hidden: !!el.hidden, txt: el.textContent };
      })()`);
      assertTruthy(chip.hidden === true || /未启用|断开|同步/.test(chip.txt), '顶栏同步签应与新配置一致：' + JSON.stringify(chip));
    }finally{
      try{ fs.rmSync(goodDir, { recursive: true, force: true }); }catch(e){}
    }
  });

  /* ===== v1.9 管理员开号：建号 → 首登强制改密 → 管理员重置 ===== */
  t('M17 管理员建号 → 新人首登被要求改密 → 改完标记清除', async () => {
    const page = getPage();
    const UNAME = 'e2e_newbie';
    /* 上轮可能已把同名账户写到盘上（内存过滤不影响落盘），先经服务端删掉保证可重复跑 */
    await page.evaluate(`(async () => {
      const r = await fetchStore('flowtask_auth.json', 'GET');
      if(!r.ok) return true;
      const j = JSON.parse(await r.text());
      const keep = (j.users || []).filter(u => u.username !== '${UNAME}');
      if(keep.length !== (j.users || []).length){
        await fetchStore('flowtask_auth.json', 'POST', JSON.stringify({ meta:{ rev: (Number(j.meta && j.meta.rev)||0) + 1 }, users: keep }),
          (Number(j.meta && j.meta.rev)||0) + 1);
        await loadAccounts();
      }
      return true;
    })()`);
    await page.evaluate(`(() => { nav('#/members'); return true; })()`);
    await page.waitFor(`(() => document.getElementById('add-user-btn'))()`, { timeout: 20000, name:'成员管理页就绪' });
    await page.evaluate(`(() => { document.getElementById('add-user-btn').click(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('nu-password'))()`, { timeout: 15000, name:'新建账户弹窗打开' });
    /* 初始口令必须是随机生成的，而不是写死的 123456。
       注意别去扫界面文案——说明文字里就会出现「123456」这个词，那种断言只会误报 */
    const gen = await page.evaluate(`(() => ({
      pw: document.getElementById('nu-password').value,
      canRegen: !!document.getElementById('nu-gen'),
      canCopy: !!document.getElementById('nu-copy')
    }))()`);
    assertTruthy(gen.pw && gen.pw.length >= 10 && gen.pw !== '123456', '初始口令应随机生成：' + gen.pw);
    assertTruthy(gen.canRegen && gen.canCopy, '应给「重新生成」与「复制」两个动作：' + JSON.stringify(gen));
    const re = await page.evaluate(`(() => {
      var a = document.getElementById('nu-password').value;
      document.getElementById('nu-gen').click();
      return { a: a, b: document.getElementById('nu-password').value };
    })()`);
    assertTruthy(re.a !== re.b, '「↻」应换发一个新初始口令：' + JSON.stringify(re));
    /* 关键点：真正建出来的账户用的是重生成后的那个口令——后面登录必须用它，不能用最初捕获的 */
    const initPw = re.b;
    await page.evaluate(`(() => {
      document.getElementById('nu-username').value = '${UNAME}';
      document.getElementById('nu-name').value = 'E2E新同事';
      document.getElementById('nu-role').value = 'member';
      document.querySelector('.modal-mask .modal-ok').click();
      return true;
    })()`);
    await page.waitFor(`(() => {
      var rows = [...document.querySelectorAll('#content tbody tr')];
      return rows.some(r => r.textContent.indexOf('E2E新同事') >= 0);
    })()`, { timeout: 20000, name:'新账户出现在成员列表' });
    const rowTxt = await page.evaluate(`(() => {
      var r = [...document.querySelectorAll('#content tbody tr')].find(x => x.textContent.indexOf('E2E新同事') >= 0);
      return r ? r.textContent.replace(/\\s+/g,' ') : '';
    })()`);
    assertTruthy(/待改密/.test(rowTxt), '新账户应带「待改密」标记：' + rowTxt.slice(0, 120));

    /* 登出，用初始口令登录新人 */
    await page.evaluate(`(() => { logout(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('li-username') && document.getElementById('auth-page').style.display !== 'none')()`,
      { timeout: 15000, name:'回到登录页' });
    await page.fill('#li-username', UNAME);
    await page.fill('#li-password', initPw);
    await page.evaluate(`(() => { document.querySelector('#login-form button[type=submit], #login-form .btn-primary').click(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('mc-pw0'))()`, { timeout: 30000, name:'首登应弹「先改一下密码」' });
    /* 填错初始密码必须被拒——否则任何人都能免密替别人改密 */
    await page.evaluate(`(() => {
      document.getElementById('mc-pw0').value = ${JSON.stringify('wrong-password-xyz')};
      document.getElementById('mc-pw1').value = 'BrandNew#2026';
      document.getElementById('mc-pw2').value = 'BrandNew#2026';
      document.querySelector('.modal-mask .modal-ok').click();
      return true;
    })()`);
    await page.waitFor(`(() => {
      var e = document.getElementById('mc-pw0');
      return !!e && !!e.parentElement.textContent.match(/不正确|错误|失败/);
    })()`, { timeout: 15000, name:'错误初始密码应被拒' });
    await page.evaluate(`(() => {
      document.getElementById('mc-pw0').value = ${JSON.stringify(initPw)};
      document.getElementById('mc-pw1').value = 'BrandNew#2026';
      document.getElementById('mc-pw2').value = 'BrandNew#2026';
      document.querySelector('.modal-mask .modal-ok').click();
      return true;
    })()`);
    await page.waitFor(`(() => !document.getElementById('mc-pw0'))()`, { timeout: 20000, name:'改密成功并关闭弹窗' });
    const flag = await page.evaluate(`(() => ({ must: !!ME.pwMustChange, who: ME.username }))()`);
    assertTruthy(flag.who === UNAME, '当前登录者应是新人：' + flag.who);
    assertTruthy(flag.must === false, '改完密码后「待改密」标记应清除');
    /* 收尾：换回 admin，别让后面的场景没权限 */
    await page.evaluate(`(() => { logout(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('li-username'))()`, { timeout: 15000, name:'回到登录页' });
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.evaluate(`(() => { document.querySelector('#login-form .btn-primary').click(); return true; })()`);
    /* ME 是顶层 let 声明，不挂 window：必须用裸标识符 + typeof 守卫访问 */
    await page.waitFor(`(() => typeof ME !== 'undefined' && ME && ME.username === 'admin' && document.getElementById('app').classList.contains('on'))()`,
      { timeout: 30000, name:'恢复 admin 会话' }).catch(async () => {
        const diag = await page.evaluate(`(() => ({
          who: (typeof ME !== 'undefined' && ME) ? ME.username : null,
          appOn: document.getElementById('app').classList.contains('on'),
          authShown: getComputedStyle(document.getElementById('auth-page')).display !== 'none',
          toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
          modal: !!document.querySelector('.modal-mask')
        }))()`);
        throw new Error('恢复 admin 会话失败，现场 = ' + JSON.stringify(diag));
      });
  });

  t('M18 管理员重置密码后，旧口令立刻作废、新口令可用', async () => {
    const page = getPage();
    await page.evaluate(`(() => { nav('#/members'); return true; })()`);
    await page.waitFor(`(() => document.querySelector('[data-reset-pw]'))()`, { timeout: 20000, name:'成员列表出现重置按钮' });
    await page.evaluate(`(() => { document.querySelector('[data-reset-pw]').click(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('rp-pw'))()`, { timeout: 15000, name:'重置密码弹窗打开' });
    const newPw = await page.evaluate(`(() => document.getElementById('rp-pw').value)()`);
    assertTruthy(newPw && newPw.length >= 10, '重置弹窗也应给随机强口令：' + newPw);
    await page.evaluate(`(() => { document.querySelector('.modal-mask .modal-ok').click(); return true; })()`);
    await page.waitFor(`(() => !document.getElementById('rp-pw'))()`, { timeout: 20000, name:'重置完成并关窗' });
    /* 直接问服务端：重置后上一个密码应当立刻换不到会话 */
    const check = await page.evaluate(`(async () => {
      async function tryLogin(password){
        const r = await fetch(STORE_SVC + '/api/auth-challenge?username=e2e_newbie', { headers: storeHeaders() });
        if(!r.ok) return 'no-challenge';
        const c = await r.json();
        const v = c.algo === 'legacy' ? await legacyHash(password, c.salt) : await hashPassword(password, c.salt);
        const s = await fetch(STORE_SVC + '/api/session', { method:'POST',
          headers: Object.assign({ 'Content-Type':'application/json' }, storeHeaders()), body: JSON.stringify({ uid:c.uid, verifier:v }) });
        return s.status;
      }
      return { afterResetOld: await tryLogin('BrandNew#2026') };
    })()`);
    assertEq(check.afterResetOld, 401, '重置后上一个密码应当立刻失效');
    const marked = await page.evaluate(`(() => {
      /* adminResetPassword 内部会 loadAccounts() 换掉 AUTH 对象，DB.users 可能是旧引用，
         所以以 AUTH（账户表的当前视图）为准，再回退到 DB.users */
      const src = (typeof AUTH !== 'undefined' && AUTH && AUTH.users) || DB.users || [];
      const u = src.find(x => x.username === 'e2e_newbie');
      return u ? { must: !!u.pwMustChange } : { missing: true };
    })()`);
    assertTruthy(marked.must === true, '重置后应重新要求对方改密：' + JSON.stringify(marked));
  });

  t('M19 关闭自助注册时登录页不露注册入口', async () => {
    const page = getPage();
    const seen = await page.evaluate(`(() => ({ flag: _openRegistration, mode: AUTH_MODE }))()`);
    assertEq(seen.flag, false, 'E2E 环境未开自助注册，服务端应下发 false');
    await page.evaluate(`(() => { logout(); return true; })()`);
    await page.waitFor(`(() => document.getElementById('auth-page') && document.getElementById('auth-page').style.display !== 'none')()`,
      { timeout: 15000, name:'回到登录页' });
    const auth = await page.evaluate(`(() => ({
      link: !!document.getElementById('go-register'),
      registerFormShown: getComputedStyle(document.getElementById('register-form')).display !== 'none',
      switchText: document.getElementById('auth-switch').textContent
    }))()`);
    assertTruthy(!auth.link, '不应出现「注册新用户」链接');
    assertTruthy(!auth.registerFormShown, '注册表单不应可见');
    assertTruthy(/管理员/.test(auth.switchText), '应告诉用户找管理员开通：' + auth.switchText);
    await page.fill('#li-username', 'admin');
    await page.fill('#li-password', 'admin123');
    await page.evaluate(`(() => { document.querySelector('#login-form .btn-primary').click(); return true; })()`);
    await page.waitFor(`(() => typeof ME !== 'undefined' && ME && ME.username === 'admin')()`, { timeout: 30000, name:'恢复 admin 会话' });
  });

  t('M21 看板出现「已暂停」列；任务改为已暂停后不再被催办逾期', async () => {
    const page = getPage();
    await page.evaluate(`(() => {
      if(!DB.projects.some(p=>p.id==='p_pz')){
        DB.projects.push({ id:'p_pz', name:'E2E暂停项目', color:'#14b8a6', desc:'', ownerId:ME.id,
          memberIds:[ME.id], archived:false, scope:'personal', createdAt:Date.now(), statusUpdates:[] });
      }
      DB.tasks = DB.tasks.filter(t=>t.projectId!=='p_pz');
      DB.tasks.push({ id:'t_pz', projectId:'p_pz', title:'M21被搁置的任务', desc:'', assigneeId:ME.id,
        dueDate: dateOffset(-5), startDate:null, priority:'high', status:'todo', completed:false, completedAt:null,
        order: Date.now(), subtasks:[], comments:[], tags:[], followers:[], recurring:null,
        activities:[], createdAt:Date.now(), createdBy:ME.id });
      saveDB(); return true;
    })()`);
    await page.evaluate(`(() => { nav('#/project/p_pz/board'); return true; })()`);
    await page.waitFor(`(() => document.querySelectorAll('#proj-body .board-col').length >= 4)()`,
      { timeout: 20000, name:'看板应渲染四列' });
    const cols = await page.evaluate(`(() => ({
      n: document.querySelectorAll('#proj-body .board-col').length,
      heads: [...document.querySelectorAll('#proj-body .board-col .col-name')].map(e=>e.textContent.trim()),
      hasPausedCol: !!document.querySelector('#proj-body .board-col[data-st="paused"]'),
      overdueBefore: !!document.querySelector('#proj-body .board-card[data-task="t_pz"] .due-badge.overdue')
    }))()`);
    assertEq(cols.n, 4, '看板列数应为四列（待办/进行中/已暂停/已完成）');
    assertTruthy(cols.heads.join(',') === '待办,进行中,已暂停,已完成', '列顺序与命名：' + cols.heads.join(','));
    assertTruthy(cols.hasPausedCol, '应存在 data-st="paused" 的列');
    assertTruthy(cols.overdueBefore, '改状态前：逾期五天的高优任务应标逾期');
    await page.evaluate(`(() => { const t = DB.tasks.find(x=>x.id==='t_pz'); t.status='paused'; saveDB(); renderApp(); return t.status; })()`);
    await page.waitFor(`(() => {
      const card = document.querySelector('#proj-body .board-col[data-st="paused"] .board-card[data-task="t_pz"]');
      return !!card && !card.querySelector('.due-badge.overdue');
    })()`, { timeout: 20000, name:'任务应落在已暂停列且不再标逾期' });
    const after = await page.evaluate(`(() => ({
      inPaused: !!document.querySelector('#proj-body .board-col[data-st="paused"] .board-card[data-task="t_pz"]'),
      inTodo: !!document.querySelector('#proj-body .board-col[data-st="todo"] .board-card[data-task="t_pz"]'),
      cardCls: (document.querySelector('.board-card[data-task="t_pz"]')||{}).className || ''
    }))()`);
    assertTruthy(after.inPaused && !after.inTodo, '已暂停任务只应出现在已暂停列：' + JSON.stringify(after));
    assertTruthy(/is-paused/.test(after.cardCls), '卡片应带 is-paused 样式钩子：' + after.cardCls);
    /* 状态标签在列表视图上（看板卡片刻意不放 pill），所以切到列表再验 */
    await page.evaluate(`(() => { nav('#/project/p_pz/list'); return true; })()`);
    await page.waitFor(`(() => !!document.querySelector('.task-row[data-task="t_pz"]'))()`,
      { timeout: 20000, name:'列表视图应渲染该任务' });
    const nag = await page.evaluate(`(() => {
      const t = DB.tasks.find(x=>x.id==='t_pz');
      const row = document.querySelector('.task-row[data-task="t_pz"]');
      const circle = row && row.querySelector('.check-circle');
      return { actionable: isActionable(t), overdue: isOverdue(t, todayStr()),
               pausedClass: /is-paused/.test(row.className),
               circleCls: circle ? circle.className : '',
               circleTip: circle ? (circle.getAttribute('title') || '') : '',
               badgeOverdue: !!row.querySelector('.due-badge.overdue') };
    })()`);
    assertTruthy(!nag.actionable && !nag.overdue, '已暂停不应算待推进/逾期：' + JSON.stringify(nag));
    assertTruthy(nag.pausedClass, '列表行应带 is-paused 样式钩子');
    /* 列表行的状态由勾选圈的 st-* 类 + tooltip 表达（这里不放状态 pill），断言要对着真实控件 */
    assertTruthy(/st-paused/.test(nag.circleCls), '勾选圈应带 st-paused 类：' + nag.circleCls);
    assertTruthy(/已暂停/.test(nag.circleTip), '勾选圈提示应回显当前状态：' + nag.circleTip);
    assertTruthy(!nag.badgeOverdue, '列表行上的截止日期不应再标红为逾期');
    await page.evaluate(`(() => {
      DB.tasks = DB.tasks.filter(t=>t.projectId!=='p_pz');
      DB.projects = DB.projects.filter(p=>p.id!=='p_pz');
      saveDB(); nav('#/'); return true;
    })()`);
  });

  t('M22 管理员删除账户：确认框说明留底与停用替代，删除后列表移除且不可再登录', async () => {
    const page = getPage();
    const UNAME = 'e2e_delme';
    /* 清场：叠在 DOM 里的遗留弹窗会让 querySelector('.modal-mask .modal-ok') 命中底层那一只，
       于是"点了没反应"——上一场景（首次登录改密那类）留下的弹窗就是这么把本场景带偏的。
       这里先记下遗留弹窗标题（真出问题它就是线索），再全部关掉。 */
    const strays = await page.evaluate(`(() => {
      const titles = [...document.querySelectorAll('.modal-mask .modal-head h3')].map(h => h.textContent);
      let guard = 0;
      while(MODAL_STACK.length && guard++ < 8){ forceCloseModal(MODAL_STACK[MODAL_STACK.length - 1]); }
      return titles;
    })()`);
    await page.waitFor(`(() => document.querySelectorAll('.modal-mask').length === 0)()`, { timeout: 10000, name:'遗留弹窗已清场' });
    if(strays.length) console.log('        INFO  M22 进场前挂着上一场景没关的弹窗：' + JSON.stringify(strays));
    await page.evaluate(`(() => { nav('#/members'); return true; })()`);
    await page.waitFor(`(() => !!document.getElementById('add-user-btn'))()`, { timeout: 20000, name:'成员管理页就绪' });
    await page.evaluate(`(() => { document.getElementById('add-user-btn').click(); return true; })()`);
    await page.waitFor(`(() => !!document.getElementById('nu-username'))()`, { timeout: 15000, name:'建号弹窗打开' });
    /* 所有点击都限定在「装着 nu-username 的那只弹窗」里，不再赌 DOM 顺序 */
    const pre = await page.evaluate(`(() => {
      const m = document.getElementById('nu-username').closest('.modal-mask');
      const b = m && m.querySelector('.modal-ok');
      return { found: !!b, hasHandler: b ? (typeof b.onclick === 'function') : null,
               text: b ? b.textContent : '', masks: document.querySelectorAll('.modal-mask').length };
    })()`);
    await page.evaluate(`(() => {
      document.getElementById('nu-username').value = '${UNAME}';
      document.getElementById('nu-name').value = 'E2E待删同事';
      document.getElementById('nu-role').value = 'member';
      document.getElementById('nu-username').closest('.modal-mask').querySelector('.modal-ok').click();
      return true;
    })()`);
    await page.waitFor(`(() => [...document.querySelectorAll('#content tbody tr')]
      .some(r => r.textContent.indexOf('E2E待删同事') >= 0))()`, { timeout: 25000, name:'新账户出现在成员列表' }).catch(async () => {
      /* 建号这一步横跨「弹窗校验 → 写账户表 → 重渲染」三段，光报超时没法定位，把三段现场一次捞全 */
      const d = await page.evaluate(`(async () => {
        const m = document.getElementById('nu-username') ? document.getElementById('nu-username').closest('.modal-mask') : document.querySelector('.modal-mask');
        const r = await fetchStore('flowtask_auth.json', 'GET');
        const j = r.ok ? JSON.parse(await r.text()) : { users: [] };
        const okb = m ? m.querySelector('.modal-ok') : null;
        return { modalCount: document.querySelectorAll('.modal-mask').length,
                 modalTitle: m ? (m.querySelector('.modal-head h3') || {}).textContent : '',
                 okText: okb ? okb.textContent : '', okDisabled: okb ? !!okb.disabled : null,
                 modalOpen: !!m,
                 modalErr: m ? [...m.querySelectorAll('.fld-err-tip')].map(x => x.textContent).join(' | ') : '',
                 toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
                 serverHas: (j.users || []).some(u => u.username === '${UNAME}'),
                 serverCount: (j.users || []).length,
                 localHas: !!(AUTH && AUTH.users.some(u => u.username === '${UNAME}')),
                 localCount: (AUTH && AUTH.users || []).length,
                 dbHas: DB.users.some(u => u.username === '${UNAME}'),
                 authHealthy: _authHealthy, svc: SVC_MODE, saveState: _saveState,
                 pushErr: _lastAuthPushErr, rev: _revs.auth, meRole: ME && ME.role };
      })()`);
      throw new Error('新账户没进成员列表，遗留弹窗 = ' + JSON.stringify(strays) +
        '，点击前 = ' + JSON.stringify(pre) + '，现场 = ' + JSON.stringify(d));
    });
    /* 先确认它真的落盘了 —— 否则 M22 报的"删不掉"其实是"根本没建上"，会把定位带偏 */
    const landed = await page.evaluate(`(async () => {
      const r = await fetchStore('flowtask_auth.json', 'GET');
      if(!r.ok) return { ok:false, why:'读账户表失败 ' + r.status };
      const j = JSON.parse(await r.text());
      const u = (j.users || []).find(x => x.username === '${UNAME}');
      return { ok: !!u, id: u && u.id, serverCount: (j.users||[]).length,
               localCount: DB.users.filter(x=>x.username==='e2e_delme').length };
    })()`);
    assertTruthy(landed.ok, '新账户应先落盘（否则删除场景测的是别的问题）：' + JSON.stringify(landed));
    await page.waitFor(`(() => !!document.querySelector('[data-del-user]'))()`, { timeout: 15000, name:'列表里有删除按钮' });
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('[data-del-user]')].find(x => {
        const u = DB.users.find(y => y.id === x.dataset.delUser);
        return !!u && u.username === '${UNAME}';
      });
      b.click(); return true;
    })()`);
    /* 同样按内容锁定那一只确认框，不靠 DOM 顺序 */
    await page.waitFor(`(() => { const m = [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('删除这个账户') >= 0);
      return !!m; })()`, { timeout: 15000, name:'删除确认框弹出' });
    const dlg = await page.evaluate(`(() => {
      const m = [...document.querySelectorAll('.modal-mask')].find(x => x.textContent.indexOf('删除这个账户') >= 0);
      const txt = m.textContent.replace(/\\s+/g, ' ');
      return { txt: txt, danger: !!m.querySelector('.modal-ok.btn-danger'),
               mentionsBackup: /留底/.test(txt), mentionsDeactivate: /停用/.test(txt) };
    })()`);
    assertTruthy(dlg.danger, '删除不可逆，确认按钮必须是危险样式');
    assertTruthy(dlg.mentionsBackup, '确认框必须说明个人库会留底：' + dlg.txt.slice(0, 150));
    assertTruthy(dlg.mentionsDeactivate, '确认框要提示「只是暂时不让登录请用停用」：' + dlg.txt.slice(0, 150));
    await page.evaluate(`(() => { [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('删除这个账户') >= 0).querySelector('.modal-ok').click(); return true; })()`);
    const gone = await page.waitFor(`(() => ![...document.querySelectorAll('#content tbody tr')]
      .some(r => r.textContent.indexOf('E2E待删同事') >= 0))()`, { timeout: 25000, name:'账户应从列表消失' }).catch(async () => {
      /* 别只报超时：把 toast 的失败原因与直接调接口的返回码一起带出来 */
      const d = await page.evaluate(`(async () => {
        const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ');
        const u = DB.users.find(x => x.username === '${UNAME}');
        const probe = u ? await fetch(STORE_SVC + '/api/delete-user', { method:'POST',
          headers: Object.assign({ 'Content-Type':'application/json' }, storeHeaders()),
          body: JSON.stringify({ uid: u.id }) }) : null;
        return { toasts, stillInUsers: !!u, apiStatus: probe ? probe.status : 'skipped',
                 apiBody: probe ? String(await probe.text()).slice(0,120) : '' };
      })()`);
      throw new Error('账户未被删除，现场 = ' + JSON.stringify(d));
    });
    assertTruthy(!!gone, '账户应从列表消失');
    const chal = await page.evaluate(`(async () => {
      const r = await fetch(STORE_SVC + '/api/auth-challenge?username=${UNAME}', { headers: storeHeaders() });
      return r.status;
    })()`);
    assertEq(chal, 404, '被删账户不应再能发起登录挑战');
    const inDb = await page.evaluate(`(() => DB.users.some(u => u.username === '${UNAME}'))()`);
    assertTruthy(!inDb, '内存中的账户表也应同步移除该账户');
  });

  /* 真实事故回归：管理员建了个人项目、把同事加进 memberIds、也以为"共享了"，
     但个人项目的数据物理上在管理员自己的个人库文件里，服务端只发给他本人——
     同事登录后拿到的是"自己的空个人库 + 空的团队共享库"，于是"什么都看不到"。
     本场景走真实入口（成员弹窗勾选 + 保存），并到盘上取证，最后换成同事登录验证可见。 */
  t('M23 个人项目里加同事会自动共享，同事登录真能看到项目、任务与邀请', async () => {
    const page = getPage();
    /* loginAs 是骨架提供的共用登录封装（真实点击 + 落点取证 + requestSubmit 兜底），
       多账户场景别再各自抄一份——抄出来的副本只会越跑越脆 */
    await loginAs('admin', 'admin123', 'admin');

    const setup = await page.evaluate(`(() => {
      const other = DB.users.find(u => u.username === 'member');
      if(!other) return { skip:'演示账户里应有 member 供邀请' };
      DB.projects = DB.projects.filter(p => p.id !== 'p_m23');
      DB.tasks = DB.tasks.filter(t => t.projectId !== 'p_m23');
      DB.projects.push({ id:'p_m23', name:'M23协作项目', color:'#3b82f6', desc:'', ownerId: ME.id,
        memberIds:[ME.id], archived:false, scope:'personal', createdAt: Date.now(), statusUpdates:[] });
      DB.tasks.push({ id:'t_m23', projectId:'p_m23', title:'M23该被同事看到的任务', desc:'', assigneeId: ME.id,
        dueDate:null, startDate:null, priority:'medium', status:'todo', completed:false, completedAt:null,
        order: Date.now(), subtasks:[], comments:[], tags:[], followers:[], recurring:null,
        activities:[], createdAt: Date.now(), createdBy: ME.id });
      saveDB();
      return { otherName: other.name, scope: projectScopeOf(DB.projects.find(p => p.id === 'p_m23')),
               sharedRev: Number(_revs.shared) || 0 };
    })()`);
    assertTruthy(!setup.skip, setup.skip || '');
    assertEq(setup.scope, 'personal', '起点必须是个人项目，否则测不到这条链');

    /* 真实入口：打开成员弹窗 → 勾上同事 → 保存 */
    await page.evaluate(`(() => { openMemberModal(DB.projects.find(p => p.id === 'p_m23')); return true; })()`);
    const dlg = await page.waitFor(`(() => { const m = [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('管理项目成员') >= 0);
      return !!m && !!m.querySelector('.member-chip'); })()`, { timeout: 15000, name:'成员弹窗打开' });
    assertTruthy(!!dlg, '成员弹窗应打开');
    const hinted = await page.evaluate(`(() => {
      const m = [...document.querySelectorAll('.modal-mask')].find(x => x.textContent.indexOf('管理项目成员') >= 0);
      const chip = [...m.querySelectorAll('.member-chip')].find(c => {
        const u = DB.users.find(y => y.id === c.dataset.uid);
        return !!u && u.username === 'member';
      });
      chip.click();
      return { on: chip.classList.contains('on'),
               warns: /自动共享|共享给团队/.test(m.textContent.replace(/\\s+/g, ' ')) };
    })()`);
    assertTruthy(hinted.on, '勾选后成员卡片应为选中态');
    assertTruthy(hinted.warns, '个人项目的成员弹窗必须当场说清"加了同事会自动共享"');
    await page.evaluate(`(() => { const m = [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('管理项目成员') >= 0);
      m.querySelector('.modal-ok').click(); return true; })()`);

    /* 内存 → 项目自动变共享；版本号前进 → 真的写进了共享库文件（落盘有 400ms 防抖） */
    await page.waitFor(`(() => { const p = DB.projects.find(x => x.id === 'p_m23'); return p && p.scope === 'shared'; })()`,
      { timeout: 20000, name:'保存成员后项目应自动共享' });
    await page.waitFor(`(() => (Number(_revs.shared) || 0) > ${Number(setup.sharedRev)})()`,
      { timeout: 20000, name:'团队共享库已写入' });
    const disk = await page.evaluate(`(async () => {
      const s = await fetchStore('flowtask_shared.json', 'GET');
      const pj = s.ok ? JSON.parse(await s.text()) : null;
      const pf = await fetchStore(personalFileOf(), 'GET');
      const pp = pf.ok ? JSON.parse(await pf.text()) : null;
      return { sharedStatus: s.status,
        projInShared: !!(pj && (pj.projects || []).some(p => p.id === 'p_m23')),
        taskInShared: !!(pj && (pj.tasks || []).some(t => t.id === 't_m23')),
        inviteInShared: !!(pj && (pj.notifications || []).some(n => n.action === 'invite' && n.projectId === 'p_m23'
          && (DB.users.find(u => u.username === 'member') || {}).id === n.userId)),
        projStillInMine: !!(pp && (pp.projects || []).some(p => p.id === 'p_m23')) };
    })()`);
    assertTruthy(disk.projInShared, '项目应已落进团队共享库文件：' + JSON.stringify(disk));
    assertTruthy(disk.taskInShared, '项目下的任务要跟着一起搬过去，否则同事看到空项目：' + JSON.stringify(disk));
    assertTruthy(disk.inviteInShared, '邀请通知必须落在收件人读得到的共享库里：' + JSON.stringify(disk));
    assertTruthy(!disk.projStillInMine, '共享后不该还留在我的个人库里（否则两份副本会互相顶）：' + JSON.stringify(disk));

    /* 换同事登录：界面上真看得见（内存 + 侧栏），而不只是"盘上有" */
    await loginAs('member', 'member123', 'member');
    const seen = await page.evaluate(`(() => ({
      inStore: DB.projects.filter(p => p.id === 'p_m23').map(p => p.scope),
      visible: P.visibleProjects().some(p => p.id === 'p_m23'),
      tasks: DB.tasks.filter(t => t.projectId === 'p_m23').length,
      sidebar: (document.getElementById('sidebar') || {}).textContent
        ? document.getElementById('sidebar').textContent.indexOf('M23协作项目') >= 0 : false,
      unreadInvite: DB.notifications.filter(n => n.userId === ME.id && n.action === 'invite' && !n.read).length
    }))()`);
    assertTruthy(seen.visible, '同事的可见项目列表里应有这个项目：' + JSON.stringify(seen));
    assertTruthy(seen.tasks >= 1, '同事应能看到项目下的任务：' + JSON.stringify(seen));
    assertTruthy(seen.sidebar, '侧栏导航里应能看到这个项目（用户实际看见的位置）：' + JSON.stringify(seen));
    assertTruthy(seen.unreadInvite >= 1, '同事应有未读的邀请通知：' + JSON.stringify(seen));
    await page.screenshot('m23-member-sees-shared-project');

    /* 收尾：清掉本场景造的数据，别污染后面的场景 */
    await loginAs('admin', 'admin123', 'admin');
    await page.evaluate(`(() => {
      DB.projects = DB.projects.filter(p => p.id !== 'p_m23');
      DB.tasks = DB.tasks.filter(t => t.projectId !== 'p_m23');
      DB.notifications = DB.notifications.filter(n => n.projectId !== 'p_m23');
      saveDB(); renderApp(); return true;
    })()`);
    await page.waitFor(`(() => { const r = (DB.projects || []).some(p => p.id === 'p_m23'); return !r; })()`,
      { timeout: 15000, name:'M23 测试数据已清理' });
  });

  /* 用户实测反馈：sid 把 hao 从一个项目里移出，hao 登录仍然看得见——因为 hao 是管理员，
     而旧判定是 "isAdmin() || memberIds.includes(ME.id)"，管理员直接绕过成员名单。
     现在可见性只认成员名单（管理员也不例外），管理员要纵览得显式打开「显示全部项目」。
     这条场景专门用一个"被移出的管理员"来钉住它。 */
  t('M24 把人移出共享项目后他也看不到（管理员也不例外，除非显式打开显示全部）', async () => {
    const page = getPage();
    await loginAs('admin', 'admin123', 'admin');

    const seed = await page.evaluate(`(async () => {
      const old = DB.users.find(u => u.username === 'e2e_exadmin');
      if(old) await deleteUserAccount(old);                       // 可重复跑
      const r = await register('e2e_exadmin', '被移出的管理员', 'exadmin123', { role:'admin' });
      if(typeof r === 'string') return { err:'建号失败：' + r };
      DB.projects = DB.projects.filter(p => p.id !== 'p_m24');
      DB.tasks = DB.tasks.filter(t => t.projectId !== 'p_m24');
      DB.projects.push({ id:'p_m24', name:'M24移除可见性', color:'#0ea5e9', desc:'', ownerId: ME.id,
        memberIds:[ME.id, r.id], archived:false, scope:'shared', createdAt: Date.now(), statusUpdates:[] });
      DB.tasks.push({ id:'t_m24', projectId:'p_m24', title:'M24任务', desc:'', assigneeId: ME.id,
        dueDate:null, startDate:null, priority:'medium', status:'todo', completed:false, completedAt:null,
        order: Date.now(), subtasks:[], comments:[], tags:[], followers:[], recurring:null,
        activities:[], createdAt: Date.now(), createdBy: ME.id });
      saveDB(); renderApp();
      return { ok:true, exId: r.id, role: r.role, sRevAtSeed: Number(_revs.shared) || 0 };
    })()`);
    assertTruthy(!seed.err, seed.err || '');
    assertEq(seed.role, 'admin', '这个账户必须是管理员，否则测不到"管理员绕过名单"那条老路');
    /* 等共享库真的落盘再继续：下面要换成他的身份登录，读到的是盘上那份 */
    await page.waitFor(`(() => (Number(_revs.shared) || 0) > ${seed.sRevAtSeed})()`,
      { timeout: 20000, name:'种子数据已写入共享库' });

    /* 在名单里时：能看到项目也能看到任务 */
    await loginAs('e2e_exadmin', 'exadmin123', '被移出的管理员（移出前）');
    const before = await page.evaluate(`(() => ({
      seen: P.visibleProjects().some(p => p.id === 'p_m24'),
      tasks: DB.tasks.filter(t => t.projectId === 'p_m24').length,
      role: ME.role }))()`);
    const beforeWhy = await page.evaluate(`(async () => {
      const s = await fetchStore('flowtask_shared.json', 'GET');
      const j = s.ok ? JSON.parse(await s.text()) : null;
      const p = j ? (j.projects || []).find(x => x.id === 'p_m24') : null;
      return { status: s.status, diskHas: !!p, diskMembers: p ? p.memberIds : null,
               meId: ME.id, memIds: (DB.users || []).map(u => u.id + ':' + u.username),
               dbProjects: (DB.projects || []).map(x => x.id + '/' + x.scope),
               svc: SVC_MODE, sRev: Number(_revs.shared) || 0 };
    })()`);
    assertTruthy(before.seen, '加入名单期间应当看得到：' + JSON.stringify(before) + ' 现场=' + JSON.stringify(beforeWhy));
    assertTruthy(before.tasks >= 1, '加入名单期间看得到项目下的任务：' + JSON.stringify(before));

    /* 真实入口：成员弹窗里取消勾选 → 保存 */
    await loginAs('admin', 'admin123', 'admin（移出）');
    const sRevBefore = await page.evaluate(`(() => Number(_revs.shared) || 0)()`);
    await page.evaluate(`(() => { openMemberModal(DB.projects.find(p => p.id === 'p_m24')); return true; })()`);
    await page.waitFor(`(() => { const m = [...document.querySelectorAll('.modal-mask')]
        .find(x => x.textContent.indexOf('管理项目成员') >= 0);
      return !!m && !!m.querySelector('.member-chip'); })()`, { timeout: 15000, name:'成员弹窗打开' });
    await page.evaluate(`(() => {
      const m = [...document.querySelectorAll('.modal-mask')].find(x => x.textContent.indexOf('管理项目成员') >= 0);
      const chip = [...m.querySelectorAll('.member-chip')].find(c => {
        const u = DB.users.find(y => y.id === c.dataset.uid);
        return !!u && u.username === 'e2e_exadmin';
      });
      chip.click();                                    // 取消勾选 = 移出
      m.querySelector('.modal-ok').click();
      return true;
    })()`);
    await page.waitFor(`(() => { const p = DB.projects.find(x => x.id === 'p_m24');
      return p && !(p.memberIds || []).some(id => { const u = DB.users.find(y => y.id === id);
        return u && u.username === 'e2e_exadmin'; }); })()`, { timeout: 20000, name:'名单里已没有他' });
    /* 落盘有 400ms 防抖：等共享库版本号真的前进，再去盘上核对（不然读到的是上一版） */
    await page.waitFor(`(() => (Number(_revs.shared) || 0) > ${sRevBefore})()`,
      { timeout: 20000, name:'共享库已写入' });
    const onDisk = await page.evaluate(`(async () => {
      const s = await fetchStore('flowtask_shared.json', 'GET');
      const j = s.ok ? JSON.parse(await s.text()) : null;
      const p = j ? (j.projects || []).find(x => x.id === 'p_m24') : null;
      const ex = ((j && (DB.users || []).find(u => u.username === 'e2e_exadmin')) || {}).id;
      return { inShared: !!p, members: p ? p.memberIds : null, exStillListed: !!(p && p.memberIds.includes(ex)) };
    })()`);
    assertTruthy(onDisk.inShared && !onDisk.exStillListed,
      '盘上名单应确实移除了他：' + JSON.stringify(onDisk));

    /* 换他登录：移出即不可见（哪怕他是管理员） */
    await loginAs('e2e_exadmin', 'exadmin123', '被移出的管理员（移出后）');
    const after = await page.evaluate(`(() => ({
      seen: P.visibleProjects().some(p => p.id === 'p_m24'),
      role: ME.role,
      sidebarHas: (document.getElementById('sb-proj-list') || {}).textContent
        ? document.getElementById('sb-proj-list').textContent.indexOf('M24移除可见性') >= 0 : false,
      searchHas: DB.tasks.filter(t => t.id === 't_m24').length,
      seeAll: PREF().seeAllProjects }))()`);
    assertTruthy(after.seen === false, '移出后连管理员也不该看到（role=' + after.role + '）：' + JSON.stringify(after));
    assertTruthy(!after.sidebarHas, '侧栏里不该再出现这个项目：' + JSON.stringify(after));
    assertTruthy(after.seeAll === false, '「显示全部项目」默认必须是关：' + JSON.stringify(after));

    /* 管理员确实需要纵览时，显式打开开关就能看到 */
    const hasToggle = await page.evaluate(`(() => !!document.getElementById('sb-see-all'))()`);
    assertTruthy(hasToggle, '管理员侧栏应有「显示全部项目」开关');
    await page.evaluate(`(() => { document.getElementById('sb-see-all').click(); return true; })()`);
    const toggled = await page.evaluate(`(() => ({
      seen: P.visibleProjects().some(p => p.id === 'p_m24'), on: PREF().seeAllProjects,
      sidebarHas: (document.getElementById('sb-proj-list') || {}).textContent
        .indexOf('M24移除可见性') >= 0 }))()`);
    assertTruthy(toggled.on && toggled.seen && toggled.sidebarHas,
      '打开开关后管理员应能纵览该项目：' + JSON.stringify(toggled));
    /* 开关是本机偏好：关回去，别把状态留给后面的场景 */
    await page.evaluate(`(() => { setPref('seeAllProjects', false); renderApp(); return true; })()`);

    /* 收尾 */
    await loginAs('admin', 'admin123', 'admin（收尾）');
    await page.evaluate(`(async () => {
      const u = DB.users.find(x => x.username === 'e2e_exadmin');
      if(u) await deleteUserAccount(u);
      DB.projects = DB.projects.filter(p => p.id !== 'p_m24');
      DB.tasks = DB.tasks.filter(t => t.projectId !== 'p_m24');
      saveDB(); renderApp(); return true;
    })()`);
    await page.waitFor(`(() => !(DB.projects || []).some(p => p.id === 'p_m24'))()`,
      { timeout: 15000, name:'M24 测试数据已清理' });
  });
};
