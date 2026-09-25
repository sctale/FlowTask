/* 语法自检：把 HTML 内联 <script> 全部抽出来做编译期校验（不执行）
 * 用途：单文件应用没有构建步骤，语法错误只能在浏览器里发现；这里补一道离线闸门。
 * 运行：node tests/syntax_check.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'FlowTask_本地项目管理平台.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, idx = 0;
while((m = re.exec(html)) !== null){
  idx++;
  const code = m[1];
  if(!code.trim()) continue;
  const line = html.slice(0, m.index).split('\n').length;
  try{
    new vm.Script(code, { filename: `inline-script-${idx}@L${line}` });
    console.log(`  PASS  内联脚本 #${idx}（起始 L${line}，${code.split('\n').length} 行）语法有效`);
    pass++;
  }catch(e){
    console.log(`  FAIL  内联脚本 #${idx}（起始 L${line}）语法错误：${e.message}`);
    // 从堆栈里取脚本内相对行号，回显出错行上下文（带文件绝对行号）
    const rel = +(String(e.stack).match(new RegExp(idx + '@L\\d+:(\\d+)')) || [, 0])[1]
             || +(String(e.stack).match(/:(\d+):\d+\n/)||[,0])[1];
    if (rel) {
      const lines = code.split('\n');
      for (let k = Math.max(0, rel - 3); k < Math.min(lines.length, rel + 2); k++) {
        console.log(`        L${line + k}${k === rel - 1 ? ' >>' : '   '} ${lines[k].slice(0, 120)}`);
      }
    }
    fail++;
  }
}
/* 重复定义检测：只看顶格（column 0）的 function / const / let 声明。
   同名函数会被静默覆盖——语法合法但行为错，这类问题必须被拦住。 */
{
  let all = '';
  const re2 = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m2;
  while((m2 = re2.exec(html)) !== null) all += '\n' + m2[1];
  const count = new Map();
  const pat = /^(?:async function|function|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  let m3;
  while((m3 = pat.exec(all)) !== null) count.set(m3[1], (count.get(m3[1]) || 0) + 1);
  const dups = [...count.entries()].filter(([, n]) => n > 1);
  if (dups.length){
    console.log('  FAIL  顶层无重复声明：' + dups.map(([n, c]) => n + ' ×' + c).join(', '));
    fail++;
  } else {
    console.log('  PASS  顶层无重复声明（检查 ' + count.size + ' 个顶层标识符）');
    pass++;
  }
}

// 服务端脚本与同步/合并相关脚本全部纳入闸门（测试脚本自身也要能被编译，
// 否则重复声明这类错误要等到跑起来才炸）
for(const f of ['flowtask_server.js', 'flowtask_sync.js', 'flowtask_merge.js', 'smoke_share.js',
                'tests/sync_test.js', 'tests/merge_test.js', 'tests/sync_integration.js',
                'tests/sync_parity.js', 'tests/sync_merge_e2e.js']){
  const p = path.join(__dirname, '..', f);
  if(!fs.existsSync(p)) continue;
  try{
    new vm.Script(fs.readFileSync(p, 'utf8'), { filename: f });
    console.log(`  PASS  ${f} 语法有效`); pass++;
  }catch(e){
    console.log(`  FAIL  ${f} 语法错误：${e.message}`); fail++;
  }
}
console.log(`\n== 语法自检：${pass} 通过，${fail} 失败 ==`);
if(fail) process.exitCode = 1;
