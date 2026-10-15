/* 「光球对决」v4.0 刀与锤 烟雾测试（QA 独立编写，覆盖 v3.0+v4.0 合并回归）
 * 真实 bootstrap 驱动 + 合成播种
 * S1 TITLE 触屏修复回归 / S2 菜单五项 / S3 OrbAI / S4 触屏纯逻辑 / S5 联机协议 v2 / S6 视觉常量 */
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
    querySelector(sel) { return makeEl(id + '>' + sel); },
    querySelectorAll(sel) { return (this._qsa[sel] || []); },
    _qsa: {}, closest() { return null; },
    value: '',
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
  _winLs: {},
  addEventListener(ev, fn) { (this._winLs[ev] = this._winLs[ev] || []).push(fn); },
  fire(ev, e) { (this._winLs[ev] || []).forEach((f) => f(e)); },
  innerWidth: 1280, innerHeight: 720,
  localStorage: {
    _d: {},
    setItem(k, v) { this._d[k] = String(v); },
    getItem(k) { return k in this._d ? this._d[k] : null; },
    removeItem(k) { delete this._d[k]; },
  },
  close() {}, closed: false,
};
try { globalThis.navigator = { clipboard: null }; } catch (e) { /* Node22 navigator 只读：用默认 */ }
globalThis.document = {
  getElementById: (id) => {
    if (!els[id]) els[id] = makeEl(id);
    if (id === 'game') els[id].getContext = () => ctxStub;
    return els[id];
  },
  addEventListener: () => {},
  createElement: (tag) => makeEl('dyn-' + tag + '-' + Math.random().toString(36).slice(2)),
  body: makeEl('body'),
  execCommand: () => true,
};
/* setTimeout 可编程化：<1s 同步执行（ScreenStack._swap 130ms 屏切换即时完成）；
 * ≥1s 忽略（联机 whenDcOpen 10s 超时/waitIce 8s 等真异步定时器不触发，由 stub DC open 事件驱动） */
setTimeout = (fn, ms) => { if ((ms || 0) < 1000) fn(); return 0; };
globalThis.clearTimeout = () => {};

/* ---------- rAF 驱动 ---------- */
let rafCb = null, NOW = 1000;
globalThis.requestAnimationFrame = (fn) => { rafCb = fn; };
globalThis.performance = { now: () => NOW };
function frame(n) { for (let i = 0; i < n; i++) { NOW += 1000 / 60; const cb = rafCb; rafCb = null; if (cb) cb(NOW); } }

/* ctx 桩：方法 no-op；属性可写（S6 记录 fillStyle/strokeStyle 值验证增亮渲染） */
const ctxVals = new Set();
const ctxStub = new Proxy({}, {
  get: (t, p) => (p in t ? t[p] : () => {}),
  set: (t, p, v) => { if (p === 'fillStyle' || p === 'strokeStyle') ctxVals.add(v); t[p] = v; return true; },
});

/* ---------- 提取脚本 + 探针注入真实 bootstrap ---------- */
const HTML_PATH = process.env.SMOKE_HTML || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
let src = m[1];
const BOOTSTRAP = "const app = new App(document.getElementById('game'));";
if (!src.includes(BOOTSTRAP)) { console.log('FATAL: bootstrap 行未找到'); process.exit(1); }
src = src.replace(BOOTSTRAP, BOOTSTRAP + ' globalThis.__APP__ = app;');
const EXPORT_LINE = "if (typeof document !== 'undefined') {";
if (!src.includes(EXPORT_LINE)) { console.log('FATAL: 导出注入点未找到'); process.exit(1); }
src = src.replace(EXPORT_LINE,
  'globalThis.__EXPORTS__ = { CONFIG, Combat, CombatState, Recorder, GhostPlayer, Player, Dummy, Ball, checkAttackHit, sectorOf, sectorHits, adjudicate, resolveOverlap, Input, FXSystem, Match, TitleScreen, serializeReplay, deserializeReplay, LocalGhostStore, onSelfWin, onSelfLose, onBossSoloWin, onBossSoloLose, selfOutcome, bossSoloOutcome, isModeAvailable, hudLines, seedOnLevelWin, AIInput, createBuiltinAI, compileAICode, deepFreeze, VirtualJoystick, TouchButton, TouchSource, NET, NetChannel, PairingHost, PairingGuest, NetInputSource, HostRoom, GuestClient };\n' + EXPORT_LINE);
new Function(src)();
const E = globalThis.__EXPORTS__;
const app = globalThis.__APP__;
const { CONFIG, Match, AIInput, createBuiltinAI, sectorOf, sectorHits, Input,
        deserializeReplay, serializeReplay, LocalGhostStore, isModeAvailable } = E;
const STEP = CONFIG.STEP;

/* ---------- 驱动助手 ---------- */
const cur = () => app.stack.current;
function curMatch() { const s = cur(); return s && s.match ? s.match : null; }
/* 玩家直调攻击（走 combat → recorder 录制链，回放一致） */
function blade(ent, dir) { return ent.combat.startBlade(dir || { x: 1, y: 0 }, curMatch().tick); }
function hammer(ent, dir) { return ent.combat.startHammer(dir || { x: 1, y: 0 }, curMatch().tick); }
function driveUntil(cond, maxFrames, label) {
  for (let i = 0; i < maxFrames; i++) { frame(1); if (cond()) return true; }
  console.log('    [driveUntil 超时] ' + label);
  return false;
}
/* 静态 ghost：固定点回放（600 帧周期无事件），供几何播种。
 * v2.3 镜像复刻：GhostPlayer.x = 1280 − traj.x + offX → 轨迹值按镜像反算，x 参数 = 期望实际位置 */
function resetGhostStatic(match, x, y) {
  const traj = [];
  for (let i = 0; i < 600; i++) { traj.push(CONFIG.VIEW.W - x, y); }
  match.ghost = new E.GhostPlayer({ duration: 10, trajectory: traj, events: [] }, match.offset.x, match.offset.y);
}
/* 静止 AI（零输入） */
function idleAI() { return { name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } }; }
/* 无头 Match 用人类输入桩（Player.update 全接口） */
function stubInput() {
  return { isDown: () => false, endFrame() {}, consumeBlade: () => false,
           consumeHammer: () => false, getMoveAxis: () => ({ x: 0, y: 0 }), getAim: () => ({ x: 0, y: 0 }) };
}

/* ============================================================
 * S1 TITLE 触屏修复回归：tap（touchstart→合成 click）→ MENU
 * 用户报：手机点屏幕无反应。实现：scr-title click 监听（index.html:3322）
 * smoke 模拟 tap 全链：window pointerdown（音频解锁路径）→ scr-title click
 * ============================================================ */
console.log('[S1] TITLE → MENU（tap 合成链）');
{
  ok(cur().constructor.name === 'TitleScreen', '启动后栈顶 = TitleScreen（v2.1 开机屏）');
  // 手机 tap = pointerdown + pointerup + 合成 click（pointerdown 走音频解锁路径不炸）
  window.fire('pointerdown', { pointerId: 1, clientX: 640, clientY: 360 });
  els['scr-title']._listeners['click'][0]();          // 合成 click 分发
  ok(cur().constructor.name === 'MenuScreen', 'TITLE 点击一次 → MENU（永不回 TITLE）');
  ok(!els['scr-title'].classList.contains('on') && els['scr-menu'].classList.contains('on'),
     'TITLE overlay 隐藏 / MENU overlay 显示');
  frame(5);                                           // MENU ambient 驱动不炸
  ok(cur().constructor.name === 'MenuScreen', 'MENU 氛围粒子驱动无异常');
}

/* ============================================================
 * S2 菜单五项：IA 逐字 + 灰显态 + 拦截
 * ============================================================ */
console.log('[S2] 主菜单五项可达 + 联机/空池置灰');
{
  // stub 无法真实遍历 DOM（.mi 由静态 HTML 提供）——以 HTML 源逐字核对代替（诚实披露）
  const miActs = [...html.matchAll(/class="mi" data-act="(\w+)"/g)].map((x) => x[1]);
  ok(miActs.join(',') === 'solo,online,self,boss_solo,quit',
     '主菜单五项 data-act 逐字（' + miActs.join('/') + '）');
  ok(isModeAvailable('solo', app.store) === true, 'solo 常开');
  ok(isModeAvailable('online', app.store) === true, 'online 恒开（PVP 配对入口，v3.0 改版）');
  ok(isModeAvailable('self', app.store) === true, 'self 常开');
  ok(isModeAvailable('boss_solo', app.store) === false, 'boss_solo 空池灰显');
  ok(isModeAvailable('quit', app.store) === true, 'quit 常开');
  // 灰显拦截：boss_solo 空池点击不切屏
  const stackLen = app.stack.stack.length;
  app.onMenuAction('boss_solo');
  ok(app.stack.stack.length === stackLen && cur().constructor.name === 'MenuScreen',
     '灰显模式点击拦截（不切屏）');
  // solo 可进（随后 ESC 放弃复位）
  app.onMenuAction('solo');
  ok(cur().constructor.name === 'GameScreen' && curMatch() && curMatch().mode === 'solo',
     'onMenuAction(solo) → GameScreen + Match 启动');
  const match = curMatch();
  ok(match.opp === 'dummy' && match.level === 'PLAY' && match.levelN === 1,
     'solo：第 1 关木桩（HP=3，v2.1 无限链）');
  ok(app._el('hud').style.display === 'none', 'solo HUD 为空');
  cur().onEsc();
  app.hideConfirm(true);
  ok(cur().constructor.name === 'MenuScreen', 'ESC 放弃 → MENU');
}

console.log('PART1: ' + pass + ' pass / ' + fail + ' fail');

/* ============================================================
 * S3 OrbAI：startMatch 人机局接线 / 无头 AI 对局到 match_end /
 *          快照冻结 / bladeZone 一致性 / AI 抛错容错
 * ============================================================ */
console.log('[S3] OrbAI 管道（ADR-009）');
{
  // —— (a) window.OrbAI.startMatch 接线：demo GameScreen + onEnd 回调分发 ——
  let endInfo = null;
  const mid = window.OrbAI.startMatch({
    p1: { kind: 'builtin' },
    p2: { kind: 'code', code: '{ name:"idle", think(){ return { move:{x:0,y:0}, blade:false, hammer:false }; } }' },
    onEnd: (i) => { endInfo = i; },
  });
  const gs = cur();
  ok(typeof mid === 'number' && gs.constructor.name === 'GameScreen' && gs.cfg.mode === 'demo',
     'startMatch → GameScreen(mode=demo, matchId=' + mid + ')');
  const m = curMatch();
  ok(m && m.p1Input instanceof AIInput && m.p2Input instanceof AIInput,
     '双 AIInput 注入（人类/AI 同通路 ADR-009）');
  ok(m.player.x === CONFIG.SPAWN.PLAYER.x && m.p2.x === CONFIG.SPAWN.GHOST.x,
     'demo 固定站位 P1(230,360) vs P2(1050,360)');
  // 内置 vs 静止 AI：确定性击杀收束（双内置对称相持会拖到超时，selftest T15 同款结论）
  const ended = driveUntil(() => m.ended, Math.ceil(70 / STEP), 'demo 击杀收束');
  ok(ended && m.ended, '内置 AI 对局实战收束（<70s）');
  ok(cur().constructor.name === 'ResultScreen', 'demo 结束 → ResultScreen');
  ok(endInfo && (endInfo.winner === 'P1' || endInfo.winner === 'P2') &&
     endInfo.hp && typeof endInfo.duration === 'number',
     'onEnd info = {winner:' + (endInfo && endInfo.winner) + ', hp:{p1,p2}, duration}（ai-interface §6）');
  window.OrbAI.stopMatch(mid);                        // 清回调注册表

  // —— (b) 无头 Match：超时判定 + 静止 AI 对拍（确定性） ——
  const fx = new E.FXSystem();
  let endArgs = null;
  const hm = new Match({ input: { isDown: () => false, endFrame() {} }, fx, audio: { play() {} } }, {
    mode: 'demo', opp: 'pvp',
    p1Input: new AIInput(idleAI(), 'P1'), p2Input: new AIInput(idleAI(), 'P2'),
    timeLimit: 2,                                      // 2s 超时 → HP 同 → 平局 null
    onEnd: (seat, replay, secs) => { endArgs = { seat, replay, secs }; },
  });
  for (let i = 0; i < Math.ceil(2.5 / STEP) && !hm.ended; i++) hm.update(STEP);
  ok(hm.ended && endArgs && endArgs.seat === null && endArgs.replay === null,
     '无头超时收束：同 HP → winner=null（平局）、demo 零 replay 产出');

  // —— (c) 快照冻结：篡改即 throw（严格模式） ——
  const snap = hm.snapshotView('P1');
  let frozen = true;
  try { snap.self.hp = 99; } catch (e) { frozen = false; }
  ok(frozen === false, 'snapshotView 深冻结：篡改 self.hp throw（防作弊 §3）');
  let frozen2 = true;
  try { snap.arena.W = 1; } catch (e) { frozen2 = false; }
  ok(frozen2 === false, 'arena 字段同样冻结');
  ok(snap.self.radius === 32 && snap.opp.radius === 32, '快照 radius=32（v4.0 体型）');
  ok(typeof snap.self.bladeCooldown === 'number' && typeof snap.self.hammerCooldown === 'number',
     '快照含 bladeCooldown/hammerCooldown（ms）');
  ok(snap.self.bladeZone === null, '非 blade_active → bladeZone=null');
  // 白盒置刀判定帧 → bladeZone 与 CONFIG 一致
  hm.p2.combat.phase = 'blade_active';
  hm.p2.facing = Math.PI / 4;
  const snap2 = hm.snapshotView('P1');
  ok(snap2.opp.bladeZone !== null && snap2.opp.bladeZone.radius === CONFIG.BLADE.RADIUS &&
     snap2.opp.bladeZone.halfAngle === CONFIG.BLADE.HALF_ANGLE &&
     Math.abs(snap2.opp.bladeZone.dirAngle - Math.PI / 4) < 1e-9,
     'blade_active → bladeZone={dirAngle,128,π/4}（ai-interface v4.0 §3）');

  // —— (d) AI 抛错容错：空输入不判负不崩局 ——
  const boomAI = { name: 'boom', think() { throw new Error('boom'); } };
  const ai = new AIInput(boomAI, 'P1');
  ai.beginTick(hm);
  ok(ai.getMoveAxis().x === 0 && ai.consumeBlade() === false && ai.consumeHammer() === false,
     'think() 抛错 → 空输入（ADR-009 降级）');
  hm.p2.combat.phase = 'idle';
  for (let i = 0; i < 10; i++) hm.update(STEP);       // 抛错 AI 驱动 10 帧不崩
  ok(true, '异常 AI 驱动 10 帧无未捕获异常');
}

/* ============================================================
 * S4 触屏纯逻辑桩：Joystick 死区/隔离、TouchButton 滑出、Input 聚合
 * ============================================================ */
console.log('[S4] TouchSource / Joystick / TouchButton / Input 聚合');
{
  const { VirtualJoystick, TouchButton, TouchSource } = E;
  // —— (a) Joystick：死区 8、全速无比例、pointerId 隔离 ——
  const j = new VirtualJoystick();
  j.start(7, 100, 100);
  j.move(7, 104, 100);                                // 4px < 死区 8
  ok(j.axis.x === 0 && j.axis.y === 0, 'Joystick 死区 8px 内输出零向量');
  j.move(7, 160, 100);                                // 60px
  ok(Math.abs(j.axis.x - 1) < 1e-9 && j.axis.y === 0, '死区外全速单位向量（无比例）');
  j.move(99, 0, 0);                                   // 异 pointerId
  ok(Math.abs(j.axis.x - 1) < 1e-9, '异 pointerId move 被忽略（隔离）');
  j.end(99);
  ok(j.axis.x === 1, '异 pointerId end 不复位');
  j.end(7);
  ok(j.pointerId === null && j.axis.x === 0 && j.axis.y === 0, '同 pointerId end 复位');
  const off = j.knobOffset();
  ok(off.x === 0 && off.y === 0, 'knobOffset 复位后零偏移');
  // —— (b) TouchButton：按下即生效、滑出 1.2 倍松开 ——
  const b = new TouchButton(1150, 620, 48);
  b.down(3);
  ok(b.pressed === true && b.consumeClick() === true && b.consumeClick() === false,
     'TouchButton 按下即 clickPending（一次消费）');
  b.move(3, 1160, 630);                               // 圆心距 ~14 < 48*1.2=57.6
  ok(b.pressed === true, '1.2 倍容差内不松开');
  b.move(3, 1000, 400);                               // 远超 57.6
  ok(b.pressed === false && b.pointerId === null, '滑出 1.2 倍命中区即松开（mobile.md §3）');
  b.down(5); b.up(6);
  ok(b.pressed === true, '异 pointerId up 不复位');
  b.up(5);
  ok(b.pressed === false, '同 pointerId up 复位');
  // —— (c) TouchSource：pointerId 分配（左半屏→摇杆，右半屏→按钮） ——
  const ts = new TouchSource();
  ts.pointerDown(11, 300, 360);                       // 左半屏
  ok(ts.joystick.pointerId === 11, '左半屏手指 → 摇杆');
  ts.pointerDown(12, ts.btnAtk.x, ts.btnAtk.y);       // 右半屏攻击钮
  ok(ts.btnAtk.pointerId === 12 && ts.btnAtk.pressed, '右半屏按钮命中 → btnAtk');
  ts.pointerUp(11); ts.pointerUp(12);
  ok(ts.joystick.pointerId === null && ts.btnAtk.pressed === false, 'pointerUp 双源复位');
  // —— (d) Input 聚合：键鼠优先 ⊕ 触屏；blade/hammer 双源帧内消费 ——
  const input = new Input({ addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }) });
  input.touch.visible = true;
  input.touch.joystick.start(1, 100, 100);
  input.touch.joystick.move(1, 100, 160);             // 摇杆朝 +y
  ok(input.getMoveAxis().y === 1 && input.getMoveAxis().x === 0, '无键鼠输入 → 触屏摇杆轴');
  input.held.add('KeyD');                             // 键鼠 +x
  const ax = input.getMoveAxis();
  ok(ax.x === 1 && ax.y === 0, '键鼠轴非零优先（聚合键鼠⊕触屏）');
  input.held.delete('KeyD');
  input.touch.btnAtk.down(2);
  ok(input.consumeBlade() === true && input.consumeBlade() === false, '触屏攻击钮 → consumeBlade（帧内一次）');
  input.touch.btnGuard.down(2);
  ok(input.consumeHammer() === true && input.consumeHammer() === false, '触屏防御钮改派重锤（v4.0 点按语义）');
  // 准星兜底链：摇杆方向 → 朝对手
  input.touch.joystick.move(1, 100, 100);             // 回死区 → 零轴
  const aim = input.getAim({ x: 230, y: 360 }, { dummy: { x: 1050, y: 360 } });
  ok(Math.abs(aim.x - 1) < 1e-9 && Math.abs(aim.y) < 1e-9, '触屏无摇杆输入 → 朝对手兜底（attack.md §6）');
}

console.log('PART2: ' + pass + ' pass / ' + fail + ' fail');

/* ============================================================
 * S2M 命中矩阵实战驱动（attack.md §5：三刀杀 / 锤秒杀 / 刀刀弹开 /
 *         绕后砍 / 锤砸刃区无效 / 锤锤双杀 DRAW）
 * ============================================================ */
console.log('[S2M] 命中矩阵实战');
{
  // —— (a) 刀击杀 3 次：solo 第 1 关木桩 HP=3 ——
  app.onMenuAction('solo');
  let match = curMatch();
  match.player.x = 950; match.player.y = 360;
  for (let i = 1; i <= 3; i++) {
    ok(blade(match.player), '第 ' + i + ' 刀起手');
    driveUntil(() => match.player.combat.phase === 'idle' || match.level !== 'PLAY', 60, '刀后摇结束');
    if (i < 3) ok(match.dummy.combat.hp === 3 - i && match.levelN === 1, '木桩 HP=' + (3 - i) + '（未致死）');
  }
  ok(match.dummy.combat.hp === 0 && match.level === 'AUTO_ADVANCE',
     '三刀击杀木桩 → AUTO_ADVANCE（无限链）');
  // —— (b) 锤秒杀：solo 重进第 1 关 ——
  cur().onEsc(); app.hideConfirm(true);
  app.onMenuAction('solo');
  match = curMatch();
  match.player.x = 980; match.player.y = 360;
  ok(hammer(match.player), '锤起手（350ms 蓄力）');
  ok(driveUntil(() => match.level === 'AUTO_ADVANCE', 90, '锤判定秒杀'),
     '一锤秒杀木桩（无视 HP 直接击碎，attack.md §4）');
  cur().onEsc(); app.hideConfirm(true);
  // —— (c) 刀刀弹开 / 绕后砍 / 锤砸刃区：demo 无头播种（固定几何） ——
  const fx = new E.FXSystem();
  const mk = (ai1, ai2) => new Match({ input: stubInput(), fx, audio: { play() {} } },
    { mode: 'demo', opp: 'pvp', p1Input: new AIInput(ai1, 'P1'), p2Input: new AIInput(ai2, 'P2'), timeLimit: 300, onEnd() {} });
  // 刀刀弹开：双方相距 140（<160 刃区可达）同帧相向挥刀，windup 80ms 后同帧 ACTIVE
  let m2 = mk(idleAI(), idleAI());
  m2.player.x = 730; m2.p2.x = 870;
  m2.player.combat.startBlade({ x: 1, y: 0 }, m2.tick);
  m2.p2.combat.startBlade({ x: -1, y: 0 }, m2.tick);
  for (let i = 0; i < 8 && m2.player.combat.phase !== 'stagger'; i++) m2.update(STEP);
  ok(m2.player.combat.phase === 'stagger' && m2.p2.combat.phase === 'stagger',
     '刀刀刃区相交 → 双方 300ms 弹开（stagger）');
  ok(m2.player.combat.hp === 3 && m2.p2.combat.hp === 3, '刀刀弹开双方不掉血');
  // 绕后砍：目标刀判定帧面朝 +x，攻击者从背后（-x 侧）挥刀 → 有效命中
  // 时序：P1 startBlade → 推 4 帧（P1 windup 66.8ms）→ 白盒置 P2 判定帧 → 第 5 帧同 ACTIVE
  m2 = mk(idleAI(), idleAI());
  m2.p2.x = 800; m2.player.x = 700;
  m2.player.combat.startBlade({ x: 1, y: 0 }, m2.tick);
  for (let i = 0; i < 4; i++) m2.update(STEP);
  m2.p2.combat.phase = 'blade_active'; m2.p2.combat.t = 0; m2.p2.facing = 0;   // 朝 +x（背对 P1）
  m2.p2.combat.dashFrom = { x: m2.p2.x, y: m2.p2.y };                          // 固定插值端点（防 lerp 拉走）
  m2.p2.combat.dashTo = { x: m2.p2.x, y: m2.p2.y };
  m2.update(STEP);
  ok(m2.p2.combat.hp === 2, '绕后砍：命中落点在刀判定帧目标刃区外 → 有效 −1 HP（护前不护后）');
  // 锤砸刀刃区（正面）→ 无效：P1 windup 350ms=21 帧；19 帧后白盒置 P2 判定帧（70ms 窗口内结算）
  m2 = mk(idleAI(), idleAI());
  m2.p2.x = 800; m2.player.x = 700;
  m2.player.combat.startHammer({ x: 1, y: 0 }, m2.tick);
  for (let i = 0; i < 19; i++) m2.update(STEP);
  m2.p2.combat.phase = 'blade_active'; m2.p2.combat.t = 0; m2.p2.facing = Math.PI;  // 朝 -x（面对 P1）
  m2.p2.combat.dashFrom = { x: m2.p2.x, y: m2.p2.y };
  m2.p2.combat.dashTo = { x: m2.p2.x, y: m2.p2.y };
  m2.update(STEP); m2.update(STEP);   // 第 21 帧 P1 → ACTIVE → 同帧收集结算
  ok(m2.p2.combat.hp === 3 && m2.p2.combat.phase === 'blade_active',
     '锤落点在目标刃区内 → 无效（刃区无敌格挡）');
  // 绕后锤 → 秒杀
  m2 = mk(idleAI(), idleAI());
  m2.p2.x = 800; m2.player.x = 700;
  m2.player.combat.startHammer({ x: 1, y: 0 }, m2.tick);
  for (let i = 0; i < 19; i++) m2.update(STEP);
  m2.p2.combat.phase = 'blade_active'; m2.p2.combat.t = 0; m2.p2.facing = 0;   // 背对 P1
  m2.p2.combat.dashFrom = { x: m2.p2.x, y: m2.p2.y };
  m2.p2.combat.dashTo = { x: m2.p2.x, y: m2.p2.y };
  m2.update(STEP); m2.update(STEP);
  ok(m2.ended && m2.p2.combat.phase === 'dead',
     '绕后锤：落点在刃区外 → 直接秒杀（处刑，矩阵 5.2 行 3）');
  // 锤锤互中 → 双杀 DRAW 复活（相距 64 = 分离距离，锤区 128 可达）
  const m3 = new Match({ input: stubInput(), fx: new E.FXSystem(), audio: { play() {} } },
    { mode: 'self', opp: 'ghost', replay: { duration: 10, trajectory: [800, 360], events: [] },
      onEnd() {}, onLevelWin() {} });
  resetGhostStatic(m3, 764, 360);
  m3.player.x = 700;
  m3.player.combat.startHammer({ x: 1, y: 0 }, m3.tick);
  m3.ghost.combat.startHammer({ x: -1, y: 0 }, m3.tick);
  for (let i = 0; i < 24 && m3.level !== 'DRAW'; i++) m3.update(STEP);
  ok(m3.level === 'DRAW' && m3.player.combat.phase === 'dead' && m3.ghost.combat.phase === 'dead',
     '锤锤互中 → 双方秒杀 → DRAW（600ms 横幅 + recorder.reset）');
  ok(m3.ended === false, 'DRAW 不触发 onEnd（不计数不产 replay）');
}

/* ============================================================
 * S3L 无限关卡链推进：L1 三刀 → L2 镜像幽灵 → L3（lastWinReplay）
 * ============================================================ */
console.log('[S3L] 无限关卡链');
{
  app.onMenuAction('solo');
  const match = curMatch();
  // L1：三刀杀木桩
  match.player.x = 950;
  for (let i = 0; i < 3; i++) {
    blade(match.player);
    driveUntil(() => match.player.combat.phase === 'idle', 60, 'L1 刀后摇');
  }
  ok(driveUntil(() => match.levelN === 2 && match.ghost, 200, 'L2 进入'),
     'L1 胜 → 自动推进 L2（幽灵 = 教学段 mirrorReplay）');
  ok(match.mirrorReplay && match.ghost.replay === match.mirrorReplay,
     'L2 幽灵来源 = mirrorReplay（播种通道）');
  // L2：静态化幽灵后三刀杀
  resetGhostStatic(match, 800, 360);
  match.player.x = 700;
  for (let i = 0; i < 3; i++) {
    blade(match.player);
    driveUntil(() => match.player.combat.phase === 'idle', 60, 'L2 刀后摇');
  }
  ok(driveUntil(() => match.levelN === 3, 200, 'L3 进入'),
     'L2 胜 → 自动推进 L3（幽灵 = L2 胜利段 lastWinReplay）');
  ok(match.lastWinReplay !== null, 'lastWinReplay 播种通道（N≥2 关幽灵来源）');
  cur().onEsc(); app.hideConfirm(true);
  ok(cur().constructor.name === 'MenuScreen', '无限链中途 ESC 放弃 → MENU');
}

console.log('PART3: ' + pass + ' pass / ' + fail + ' fail');

/* ============================================================
 * S6 视觉常量 + portrait 遮罩（mobile.md §5）
 * ============================================================ */
console.log('[S6] 视觉常量 / 增亮渲染 / portrait 暂停恢复');
{
  ok(CONFIG.BALL.R === 32 && CONFIG.BOUND.INSET === 32, '体型 32 + 边界内缩 32（v4.0 §2）');
  ok(CONFIG.COLOR.PLAYER === '#FFF8E7' && CONFIG.COLOR.GHOST === '#9FE8FF',
     '增亮配色：玩家暖白 / 幽灵冷青（fx.md v4.0 §A）');
  ok(CONFIG.FX.GLOW.PLAYER.R === 70 && CONFIG.FX.GLOW.PLAYER.A === 0.85, '双层外晕 r70 a0.85');
  ok(CONFIG.HPBAR.W === 24 && CONFIG.HPBAR.Y === 24 && CONFIG.HPBAR.CX_P === 340 && CONFIG.HPBAR.CX_G === 940,
     '血条 3 格布局常量（v2.2 沿用）');
  ok(CONFIG.KILL_HITSTOP === 0.2 && CONFIG.HITSTOP === 0.12 && CONFIG.BANNER.DRAW_DUR === 0.6,
     '秒杀 hitstop 200ms / 普通 120ms / DRAW 横幅 600ms');
  ok(CONFIG.FX.KILL.RING.R1 === 90 && CONFIG.FX.KILL.RING2.R1 === 130, '秒杀双层环 90/130');
  // 渲染冒烟：进 solo 驱动 30 帧 → ctx 收集到增亮填充色
  app.onMenuAction('solo');
  frame(30);
  ok(ctxVals.has('#FFF8E7') && ctxVals.has('#9FE8FF'), '渲染管线出现增亮双色（ctx fillStyle 实录）');
  // portrait 遮罩：竖屏 → 对局冻结；恢复横屏 → 继续
  const m = curMatch();
  const tickBefore = m.tick;
  window.innerHeight = 1920; window.innerWidth = 1080;
  window.fire('resize');
  ok(app.portrait === true, '竖屏 → app.portrait=true');
  frame(20);
  ok(m.tick === tickBefore, '遮罩期间对局暂停（tick 不推进）');
  window.innerHeight = 720; window.innerWidth = 1280;
  window.fire('resize');
  ok(app.portrait === false, '恢复横屏 → portrait=false');
  frame(20);
  ok(m.tick > tickBefore, '恢复后对局继续（tick 推进）');
  cur().onEsc(); app.hideConfirm(true);
}

/* ============================================================
 * S5 联机协议 v2（复用 impl mkNetPair stub 基建 → tests/nethelp.js）：
 * 配对握手 / snap+ctrl 分型 / input 帧 blade|hammer|aim / match_end
 * ============================================================ */
(async () => {
console.log('[S5] 联机协议 v2：配对 → 对局 → match_end（Node 内存管道）');
{
  const { mkNetPair } = require('./nethelp.js');
  const { PairingHost, PairingGuest, HostRoom, GuestClient, NetChannel, NetInputSource, NET, FXSystem } = E;
  const net = mkNetPair();
  const host = new PairingHost({ makePC: () => net.mkPC(false) });
  const guest = new PairingGuest({ makePC: () => net.mkPC(true) });
  const room = new HostRoom(new FXSystem(), { play() {} });
  host.onOpen = (ch) => room.addChannel(ch);
  room.p1Input = new AIInput(createBuiltinAI(), 'P1');
  const invite = await host.createInvite();
  const r = await guest.join(invite.code);
  await host.acceptAnswer(invite.id, r.answerCode);
  net.shake();
  const hostChan = await invite.chanPromise;
  const guestChan = await r.chanPromise;
  ok(room.channels.length === 1, '配对完成 → 访客入房');
  // snap/ctrl 通道分型（传输层迁移表 v3.1 §2）
  ok(net.created[0].name === 'snap' && net.created[1].name === 'ctrl', 'DC 命名分型 snap/ctrl');
  ok(net.created[0].opts.ordered === false && net.created[1].opts.ordered === true,
     'snap 通道 unreliable / ctrl 通道 reliable');
  const gc = new GuestClient(new FXSystem());
  gc.attach(guestChan);
  await gc.claimSeat('P2');
  ok(room.seats.P2 === hostChan && room.p2Input instanceof NetInputSource, 'AI 席 claim_seat P2 → NetInputSource');
  gc.attachAI(idleAI());
  // input 帧字段验证（协议 v2：t/v/seq/move/blade/hammer/aim）
  const snapDc = net.mirrors[0];               // 访客侧 snap 上行通道
  const before = snapDc._sends.length;
  gc.sendInput();
  const sent = snapDc._sends.slice(before).map((s) => JSON.parse(s)).filter((f) => f.t === 'input');
  ok(sent.length >= 1, '访客上行 input 帧（snap 通道）');
  if (sent.length) {
    const f = sent[sent.length - 1];
    ok(f.v === 2 && typeof f.seq === 'number' && 'move' in f && 'blade' in f && 'hammer' in f && 'aim' in f,
       'input 帧字段 v:2 seq move blade hammer aim（协议 v2，token 已废除）');
  }
  // 完整对局 → match_end（内置 vs 静止 = 确定性击杀；70s 上限）
  room.beginCountdown();
  for (let i = 0; i < Math.ceil(NET.COUNTDOWN / STEP); i++) room.update(STEP);
  ok(room.phase === 'PLAYING' && room.match, 'COUNTDOWN → PLAYING（房主权威 Match）');
  let endFrames = [];
  gc.onMatchEnd = (f) => endFrames.push(f);
  let ticks = 0;
  const maxTicks = Math.ceil(70 / STEP);
  while (room.p1Wins + room.p2Wins < 1 && ticks < maxTicks) { room.update(STEP); gc.sendInput(); ticks++; }
  ok(room.p1Wins + room.p2Wins >= 1, '完整联机对局跑到单局 match_end（' + (ticks * STEP).toFixed(1) + 's）');
  ok(endFrames.length === 1 && (endFrames[0].result === 'P1' || endFrames[0].result === 'P2') &&
     typeof endFrames[0].p1Wins === 'number' && typeof endFrames[0].p2Wins === 'number',
     'match_end 帧 result + 三局两胜计分字段');
}

console.log('========================================');
console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
})();


