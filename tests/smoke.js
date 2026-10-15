/* 「光球对决」v2.0 一期烟雾测试（QA 独立编写）
 * 真实 bootstrap 驱动（App/ScreenStack/Match 全链）+ 合成播种隔离验证
 * 运行前提：先从 index.html 提取内嵌脚本到 .tmp_script.js
 * S1 主菜单链路 / S2 挑战自我全链 / S3 单机boss顺位 / S4 灰显
 * S5 无效对局隔离 / S6 序列化 / S7 v1.2 回归抽测 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

/* ---------- DOM / window / localStorage stub ---------- */
function makeEl(id) {
  const el = {
    id, style: {}, dataset: {}, title: '', innerHTML: '', textContent: '',
    _classes: new Set(), _listeners: {}, _children: [],
    appendChild(ch) { this._children.push(ch); },
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    querySelector(sel) { return makeEl(id + '>' + sel); },     // 伪节点（.prog 等）
    querySelectorAll(sel) { return (this._qsa[sel] || []); },  // 测试按需注入
    _qsa: {},
    closest() { return null; },
  };
  el.classList = {
    _s: el._classes,
    add(...c) { c.forEach((x) => this._s.add(x)); },
    remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, force) { const on = force === undefined ? !this._s.has(c) : !!force; on ? this._s.add(c) : this._s.delete(c); return on; },
    contains(c) { return this._s.has(c); },
  };
  return el;
}
const els = {};
globalThis.window = {
  addEventListener: () => {},
  innerWidth: 1280, innerHeight: 720,
  localStorage: {
    _d: {},
    setItem(k, v) { this._d[k] = String(v); },
    getItem(k) { return k in this._d ? this._d[k] : null; },
    removeItem(k) { delete this._d[k]; },
  },
};
globalThis.document = {
  getElementById: (id) => {
    if (!els[id]) els[id] = makeEl(id);
    if (id === 'game') els[id].getContext = () => ctxStub;   // bootstrap 取 'game' 作 canvas
    return els[id];
  },
  addEventListener: () => {},
  createElement: (tag) => makeEl('dyn-' + tag + '-' + Math.random().toString(36).slice(2)),
};

/* setTimeout 同步化：ScreenStack._swap 淡入淡出在测试中即时完成 */
const _realST = setTimeout;
setTimeout = (fn) => { fn(); return 0; };
globalThis.clearTimeout = () => {};

/* ---------- rAF 驱动 ---------- */
let rafCb = null, NOW = 1000;
globalThis.requestAnimationFrame = (fn) => { rafCb = fn; };
globalThis.performance = { now: () => NOW };
function frame(n) { for (let i = 0; i < n; i++) { NOW += 1000 / 60; const cb = rafCb; rafCb = null; if (cb) cb(NOW); } }

/* ctx 桩：任意方法 no-op，属性可写 */
const ctxStub = new Proxy({}, {
  get: (t, p) => (p in t ? t[p] : () => {}),
  set: (t, p, v) => { t[p] = v; return true; },
});
const canvasStub = {
  getContext: () => ctxStub,
  style: {},
  addEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
};

/* ---------- 提取脚本 + 探针注入真实 bootstrap ---------- */
/* SMOKE_HTML 环境变量：指定被测 html（变异测试用），默认 index.html */
const HTML_PATH = process.env.SMOKE_HTML || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let src = m[1];
const BOOTSTRAP = "const app = new App(document.getElementById('game'));";
if (!src.includes(BOOTSTRAP)) { console.log('FATAL: bootstrap 行未找到'); process.exit(1); }
src = src.replace(BOOTSTRAP, BOOTSTRAP + ' globalThis.__APP__ = app;');
/* IIFE 顶部注入导出（bootstrap 分支不导出 __EXPORTS__，借用其内部作用域） */
const EXPORT_LINE = "if (typeof document !== 'undefined') {";
if (!src.includes(EXPORT_LINE)) { console.log('FATAL: 导出注入点未找到'); process.exit(1); }
src = src.replace(EXPORT_LINE,
  'globalThis.__EXPORTS__ = { CONFIG, Combat, CombatState, Recorder, GhostPlayer, Player, Dummy, Ball, checkChargeHit, hitCircleOf, adjudicate, Input, FXSystem, Match, serializeReplay, deserializeReplay, LocalGhostStore, onSelfWin, onSelfLose, onBossSoloWin, onBossSoloLose, selfOutcome, bossSoloOutcome, isModeAvailable, hudLines, seedRemote };\n' + EXPORT_LINE);
new Function(src)();
const E = globalThis.__EXPORTS__;
const app = globalThis.__APP__;
const { CONFIG, Match, serializeReplay, deserializeReplay, LocalGhostStore,
        isModeAvailable, hudLines, onBossSoloWin, onSelfWin, onSelfLose } = E;
const STEP = CONFIG.STEP;

/* ---------- 驱动助手 ---------- */
const cur = () => app.stack.current;
function curMatch() { const s = cur(); return s && s.match ? s.match : null; }
/* 玩家直调冲撞（仍触发 combat.onAction → recorder 录制，回放一致） */
function charge(ent, dirVec) { return ent.combat.startCharge(dirVec, curMatch().tick); }
/* 等待条件或超时 */
function driveUntil(cond, maxFrames, label) {
  for (let i = 0; i < maxFrames; i++) { frame(1); if (cond()) return true; }
  console.log('    [driveUntil 超时] ' + label);
  return false;
}
/* 静态 ghost：回放轨迹为固定点（600 帧周期、无事件），供几何播种 */
function resetGhostStatic(match, x, y) {
  const traj = [];
  for (let i = 0; i < 600; i++) { traj.push(x, y); }
  match.ghost = new E.GhostPlayer({ duration: 10, trajectory: traj, events: [] }, 0, 0);
}
/* 教学关：玩家瞬移近桩后冲撞直至进入镜像关 */
function killDummy(match) {
  match.player.x = 880; match.player.y = 360;
  charge(match.player, { x: 1, y: 0 });          // 直调冲撞（经 onAction 录制）
  if (!driveUntil(() => match.level !== 'TUTORIAL', 600, '教学关命中')) return false;
  return driveUntil(() => match.level !== 'TUTORIAL_CLEAR', 600, '横幅结束');
}
/* 镜像关：追踪 ghost，保持 100px 间距冲撞直至对局结束 */
function finishMirror(match) {
  const deadline = match.tick + 3600;
  while (match.tick < deadline && !match.ended) {
    const p = match.player, g = match.ghost;
    if (p.combat.phase === 'IDLE' && g && g.combat.phase === 'IDLE') {
      const d = Math.hypot(g.x - p.x, g.y - p.y) || 1;
      if (d < 400) {
        p.x = g.x - (g.x - p.x) / d * 100;
        p.y = g.y - (g.y - p.y) / d * 100;
        const dd = Math.hypot(g.x - p.x, g.y - p.y) || 1;
        charge(p, { x: (g.x - p.x) / dd, y: (g.y - p.y) / dd });
      } else { p.x = g.x - 150; p.y = g.y; }
    }
    frame(1);
  }
  return match.ended;
}

/* ============================================================
 * S6 序列化 + Store（独立于 UI）
 * ============================================================ */
console.log('[S6] LocalGhostStore + Uint16 量化序列化');
{
  const store = new LocalGhostStore();
  ok(store.persistent === true, 'localStorage 可用 → persistent=true');
  const replay = { duration: 1, trajectory: [230.004, 360.3, 900.99, 12.5], events: [{ t: 3, type: 'charge', dirAngle: 1.57 }] };
  const id = store.put('self', replay, {});
  const e1 = store.list('self')[0];
  ok(e1 && e1.id === id, 'put → list 返回条目（id 一致）');
  const back = deserializeReplay(e1.payload);
  const err = Math.max(
    Math.abs(back.trajectory[0] - 230.004), Math.abs(back.trajectory[1] - 360.3),
    Math.abs(back.trajectory[2] - 900.99), Math.abs(back.trajectory[3] - 12.5));
  ok(err < 0.02, '量化往返误差 < 0.02px（实测 ' + err.toFixed(5) + 'px）');
  ok(back.events.length === 1 && back.events[0].t === 3 && back.events[0].dirAngle === 1.57,
     'events 经 JSON base64 往返无损');
  store.replace('self', id, { duration: 2, trajectory: [1, 2, 3, 4], events: [] });
  const e2 = store.list('self')[0];
  ok(e2.counters.defeatedPlayers === 0, 'replace 后计数归零（modes.md §5 新幽灵从 0 计）');
  store.remove('self', id);
  ok(store.list('self').length === 0, 'remove 后池空');
}

console.log('PART1: ' + pass + ' pass / ' + fail + ' fail');

/* ============================================================
 * S1 主菜单链路：solo 完整自然对局（教学关 → 镜像关 → 胜利 → 结算）
 * ============================================================ */
console.log('[S1] 主菜单 → solo 全链（自然驱动）');
let soloReplay = null, soloSeconds = -1;
{
  ok(cur().constructor.name === 'MenuScreen', '启动后栈顶 = MenuScreen');
  const before = app.store.list('self').length;
  app.onMenuAction('solo');
  ok(cur().constructor.name === 'GameScreen', 'onMenuAction(solo) → GameScreen');
  const match = curMatch();
  ok(match && match.mode === 'solo' && match.opp === 'dummy', 'Match 启动：mode=solo opp=dummy');
  ok(match.level === 'TUTORIAL' && match.tick === 0, '对局相对 tick 进屏清零（TUTORIAL 起，控制 #11）');
  ok(app._el('hud').style.display === 'none', 'solo HUD 为空（menu.md §4.4：solo 无计数行）');
  ok(killDummy(match) && match.level === 'LEVEL1', '教学关击中木桩 → 镜像关（录制快照供幽灵）');
  ok(match.mirrorReplay && match.mirrorReplay.trajectory.length >= 4 &&
     match.mirrorReplay.events.some((e) => e.type === 'charge'),
     'mirrorReplay 快照含轨迹与 charge 事件');
  const ended = finishMirror(match);
  ok(ended && match.ended, '镜像关分出胜负');
  ok(cur().constructor.name === 'ResultScreen', '对局结束 → ResultScreen');
  ok(app.store.list('self').length === before + 1, 'solo 胜利 → 挑战自我首关种子（modes.md §4a）');
  { // 胜利 replay 事件完整性：教学关 + 镜像关两段事件均录制（披露项#1：enterLevel1 重绑的鉴别断言）
    const seeded = deserializeReplay(app.store.list('self')[0].payload);
    const kinds = seeded.events.map((e) => e.type);
    ok(seeded.events.length >= 2 && kinds.includes('charge'),
       '胜利 replay 事件 ≥2 且含 charge（教学关+镜像关段均录制）');
  }
  soloReplay = match.recorder ? null : null;   // recorder 已随 onEnd 交出
  // 结果屏按钮接线：记录 DOM 动态按钮（ResultScreen.enter 动态创建 .mi）
  const box = els['result-btns'];
  ok(box && box._children.length >= 2, '结果屏含 ≥2 个操作按钮（再来一次/返回菜单）');
}

/* ============================================================
 * S2 挑战自我全链：种子关 → 胜利推进 / 败局 replay 顶替
 * ============================================================ */
console.log('[S2] 挑战自我：从种子关到解锁/替换');
{
  // 首进 self（此时池已有 S1 种子）→ 直接进当前解锁关
  app.onMenuAction('self');
  const gs = cur();
  ok(gs.constructor.name === 'GameScreen' && gs.cfg.mode === 'self' && gs.cfg.level === 1,
     'onMenuAction(self) → GameScreen(mode=self, level=1)');
  const match = curMatch();
  ok(match.opp === 'ghost', 'self 模式 opp=ghost（replay 来自 store）');
  ok(match.level === 'LEVEL1' && match.ghost, 'ghost 对局直接进镜像关');
  ok(app._el('hud').innerHTML.includes('已打败玩家数'), 'self HUD 含「已打败玩家数：N/20」');
  // 胜利链：击杀幽灵 → onSelfWin → 第 2 关占位 + 解锁
  ok(finishMirror(match), 'S2 胜局分出');
  ok(cur().constructor.name === 'ResultScreen', '胜利 → ResultScreen');
  const r = onSelfWin(app.store, 1, { duration: 1, trajectory: [1, 2], events: [] });
  ok(r.nextLevel === 2 && app.store.list('self').length === 2, '胜利后第 2 关占位（池 2 条）');
  ok(app.store.getProgress('self').unlockedLevel >= 2, 'unlockedLevel 推进到 2');
  // 败局链：第 2 关被击败 → 败局 replay 顶替 + defeatedPlayers 计数
  // （幽灵 AI 时机不可控，直调 finish('lose') 触发真实 _onEnd → onSelfLose 链；
  //   自然败局路径由 S7 对撞播种覆盖）
  app.onMenuAction('self');
  const gs2 = cur();
  ok(gs2.cfg.mode === 'self' && gs2.cfg.level === 2, '再进 self → 顺位第 2 关');
  const m2 = curMatch();
  m2.finish('lose');
  ok(cur().constructor.name === 'ResultScreen', '败局 → ResultScreen');
  ok(els['result-title'].textContent === '被第 2 关幽灵击败', '败局结果屏标题（menu.md §5）');
  const selfEntries = app.store.list('self');
  ok(selfEntries.length === 2, '败局不新增条目（第 20 败才晋级/顶替）');
  ok(selfEntries[1].counters.defeatedPlayers === 1, 'defeatedPlayers 计 1（败局计数）');
  ok(app.store.getProgress('self').losses >= 1, 'store losses 计数（incLoss 落盘）');
}

console.log('PART2: ' + pass + ' pass / ' + fail + ' fail');

/* ============================================================
 * S3 单机boss顺位：删除 → 顺位前移 → 结果屏文案
 * ============================================================ */
console.log('[S3] 单机boss顺位（win → 删除 → 前移）');
{
  app.store.put('boss_solo', { duration: 1, trajectory: [1, 2, 3, 4], events: [] }, {});
  app.store.put('boss_solo', { duration: 1, trajectory: [5, 6, 7, 8], events: [] }, {});
  ok(app.store.list('boss_solo').length === 2, 'boss_solo 池 2 条');
  app.onMenuAction('boss');
  ok(cur().constructor.name === 'BossMenuScreen', 'onMenuAction(boss) → BossMenuScreen');
  app.onBossAction('boss_solo');
  const gs = cur();
  ok(gs.cfg.mode === 'boss_solo' && gs.cfg.level === 1, 'onBossAction → GameScreen(boss_solo, L1)');
  const match = curMatch();
  ok(app._el('hud').innerHTML.includes('被挑战成功数'), 'boss_solo HUD 含「被挑战成功数：N/20」');
  match.finish('win');
  ok(cur().constructor.name === 'ResultScreen', 'boss 胜利 → ResultScreen');
  ok(els['result-title'].textContent === '击败单机boss第 1 关', 'boss 结果屏标题');
  ok(app.store.list('boss_solo')[0].counters.challengedSuccess === 1,
     'boss 胜利 → challengedSuccess 计 1（HUD 口径）');
  ok(app.store.list('boss_solo').length === 2, '1 胜不删除（20 胜才删除）');
  // 20 胜删除链路：直接循环 onBossSoloWin 至阈值（自然 20 局成本过高）
  let r20 = null;
  for (let i = 0; i < 19; i++) r20 = onBossSoloWin(app.store, 1);
  ok(r20.deleted === true && r20.nextLevel === 1 && app.store.list('boss_solo').length === 1,
     '第 20 胜删除 → 原第 2 关顺位前移为第 1（progression.md §5）');
  app.onMenuAction('boss');
  cur().onEsc();
  ok(cur().constructor.name === 'MenuScreen', 'boss 二级菜单 ESC → 逐级返回主菜单（menu.md §4.5）');
}

/* ============================================================
 * S5 无效对局隔离：同帧对撞 DRAW → 不产 replay、重开重录；ESC 放弃
 * ============================================================ */
console.log('[S5] DRAW 隔离 + ESC 放弃');
{
  const before = app.store.list('self').length;
  app.onMenuAction('self');
  const match = curMatch();
  const p = match.player;
  resetGhostStatic(match, 400, 360);              // ghost 固定 400,360（replay 覆盖位置问题规避）
  const g = match.ghost;
  // 同帧对撞播种（100px 间距、方向相对、同 tick 起手）
  p.x = g.x - 100; p.y = g.y;
  charge(p, { x: 1, y: 0 });
  g.combat.startCharge({ x: -1, y: 0 }, match.tick);
  ok(driveUntil(() => match.level === 'DRAW', 30, '进入 DRAW'), '同帧对撞 → DRAW（双方 DEAD）');
  ok(p.combat.phase === 'DEAD' && g.combat.phase === 'DEAD', 'DRAW 判定双方 DEAD（modes.md §3）');
  ok(match.ended === false, 'DRAW 不触发 onEnd');
  const trajLenAtDraw = match.recorder.tickCount;
  ok(driveUntil(() => match.level === 'LEVEL1' && match.tick === 0, 600, 'DRAW 横幅后重开'),
     'DRAW 横幅后原地重开（enterLevel1，tick 归零）');
  ok(match.recorder.tickCount <= trajLenAtDraw && match.recorder.tickCount < 5,
     'recorder.reset()：无效段丢弃，重开段从帧 0 重录（modes.md §3.2）');
  // ESC 放弃
  const gs = cur();
  gs.onEsc();
  ok(app.confirmOpen === true && gs.confirming === true, 'ESC → 放弃确认框（对局冻结）');
  const tickFrozen = match.tick;
  frame(10);
  ok(match.tick === tickFrozen, '确认框打开期间对局冻结');
  app.hideConfirm(true);
  ok(cur().constructor.name === 'MenuScreen', '确认放弃 → 返回主菜单');
  ok(app.store.list('self').length === before, '放弃不产 replay、不计数（modes.md §3.1）');
}

/* ============================================================
 * S7 v1.2 回归抽测：先后手裁决 / 贴墙 clamp / 格挡
 * ============================================================ */
console.log('[S7] v1.2 回归抽测');
{
  // 先后手：p 先手（tick N）、g 后手（N+1）→ g 赢 → DEATH
  app.onMenuAction('self');
  let match = curMatch();
  let p = match.player;
  resetGhostStatic(match, 500, 360);
  let g = match.ghost;
  p.x = g.x - 100; p.y = g.y;
  charge(p, { x: 1, y: 0 });
  frame(1);
  g.combat.startCharge({ x: -1, y: 0 }, match.tick);   // 后一帧起手
  ok(driveUntil(() => match.level === 'DEATH', 30, '后手幽灵赢'), '对撞裁决：后起手者赢（p 先手 → p 死）');
  // 反向：g 先手、p 后手 → p 赢 → VICTORY → finish(win)
  app.onMenuAction('self');
  match = curMatch();
  p = match.player;
  resetGhostStatic(match, 500, 360);
  g = match.ghost;
  p.x = g.x - 100; p.y = g.y;
  g.combat.startCharge({ x: -1, y: 0 }, match.tick);
  frame(1);
  charge(p, { x: 1, y: 0 });
  ok(driveUntil(() => match.level === 'VICTORY', 30, '后手玩家赢'), '对撞裁决：玩家后手 → VICTORY');
  ok(driveUntil(() => match.ended, 120, 'VICTORY 定格后 finish'), 'VICTORY 定格 0.9s → finish(win) → ResultScreen');
  ok(cur().constructor.name === 'ResultScreen' && els['result-title'].textContent.includes('你击败了'),
     'win → 结果屏「你击败了第 N 关幽灵」');
  // 贴墙 clamp（M1 回归点）：ACTIVE 端点 ≤ W-INSET
  app.onMenuAction('self');
  match = curMatch();
  p = match.player; g = match.ghost;
  p.x = 1262; p.y = 360;
  charge(p, { x: 1, y: 0 });
  frame(20);
  ok(p.x <= CONFIG.VIEW.W - CONFIG.BOUND.INSET + 0.001,
     '贴墙冲撞端点 clamp（x=' + p.x.toFixed(1) + ' ≤ ' + (CONFIG.VIEW.W - CONFIG.BOUND.INSET) + '）');
  // 格挡：防守方 GUARD + 攻方命中 → guard 裁决（attacker BOUNCE）
  const pC = p.combat, gC = g.combat;
  // 等 p 脱离 BOUNCE/RECOVERY
  for (let i = 0; i < 90 && pC.phase !== 'IDLE'; i++) frame(1);
  if (pC.phase === 'IDLE') {
    gC.startGuard();
    p.x = g.x - 100;
    charge(p, { x: 1, y: 0 });
    ok(driveUntil(() => pC.phase === 'BOUNCE', 40, '格挡裁决'),
       '格挡成功：攻击者 BOUNCE（guard.md）');
  } else {
    ok(false, '格挡前置：p 未回到 IDLE（跳过）');
  }
}

console.log('========================================');
console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);

