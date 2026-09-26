/*
 * FlowTask 测试公共工具（零依赖）
 * ============================================================================
 * 只放"所有套件都需要、且必须语义一致"的东西。刻意不在这里统一 ok()/req()——
 * 各个套件的断言器参数顺序不同（有的 ok(cond,label)，有的 ok(name,cond)），
 * 强行合并会同时改动 7 个文件的每一条断言，风险远大于收益；统一留作后续专项。
 *
 * 本文件解决的是一个真实缺陷：源码守卫靠字符串匹配，而 checkout 的行尾取决于
 * 机器上的 core.autocrlf 与仓库有没有 .gitattributes。同一段代码在一台机器上
 * 是 LF、另一台是 CRLF，守卫就一会儿绿一会儿红——测试结果取决于环境而不是代码。
 * 所有"把源码当文本读"的地方一律走 readSource()，行尾与 BOM 在这里归一，
 * 守卫从此与 checkout 无关。二进制（图标等）不要走这里。
 */
'use strict';
const fs = require('fs');

/* 读文本源码：统一去掉 BOM、把 CRLF / 单独 CR 归一成 LF。
   守卫要匹配的是"代码写了什么"，不是"磁盘上用什么行尾存的"。 */
function readSource(p){
  let t = fs.readFileSync(p, 'utf8');
  if(t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

module.exports = { readSource };
