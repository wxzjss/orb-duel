/* 「光球对决」v4.1 精准烟雾测试（Q-61 聚焦增量：三档特写 + 碎刃/打断）
 * S1 打断全链 / S2 碎刃全链 / S3 同帧取最高档 / S4 camera 逻辑零影响对拍 /
 * S5 联机 camera 房主/访客一致 / S0 权威端 camera 路由探针（QA 发现固化） */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

/* ---------- stub（与 smoke.js v4.0 基建同款） ---------- */
function makeEl(id) {
  const el = { id, style: {}, dataset: {}, title: '', innerHTML: '', textContent: '',
    _classes: new Set(), _listeners: {}, _children: [], appendChild(c) {},
    addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    querySelector() { return makeEl(id + 'x'); }, querySelectorAll() { return []; },
    closest() { return null; }, value: '' };
  el.classList = { _s: el._classes, add() {}, remove() {}, toggle() {}, contains() { return false; } };
  return el;
}
const els = {};
globalThis.window = { _winLs: {}, addEventListener() {}, fire() {}, innerWidth: 1280, innerHeight: 720,
  localStorage: { _d: {}, setItem() {}, getItem() { return null; }, removeItem() {} }, close() {}, closed: false };
globalThis.document = {
  getElementById: (id) => { if (!els[id]) els[id] = makeEl(id); if (id === 'game') els[id].getContext = () => ctxStub; return els[id]; },
  addEventListener() {}, createElement: (t) => makeEl(t), body: makeEl('body'), execCommand: () => true };
setTimeout = (fn, ms) => { if ((ms || 0) < 1000) fn(); return 0; };
globalThis.clearTimeout = () => {};
let rafCb = null, NOW = 1000;
globalThis.requestAnimationFrame = (fn) => { rafCb = fn; };
globalThis.performance = { now: () => NOW };
const ctxStub = new Proxy({}, { get: (t, p) => (p in t ? t[p] : () => {}), set: (t, p, v) => { t[p] = v; return true; } });

/* ---------- 提取 + 探针注入 ---------- */
const html = fs.readFileSync(process.env.SMOKE_HTML || path.join(__dirname, '..', 'index.html'), 'utf8');
const mm = html.match(/<script>([\s\S]*?)<\/script>/);
let src = mm[1];
src = src.replace("const app = new App(document.getElementById('game'));",
  "const app = new App(document.getElementById('game')); globalThis.__APP__ = app;");
src = src.replace("if (typeof document !== 'undefined') {",
  'globalThis.__EXPORTS__ = { CONFIG, Combat, CombatState, Match, Player, AIInput, FXSystem, CameraSystem, sectorOf, sectorHits, checkAttackHit, adjudicate, FXSystem, GhostPlayer, createBuiltinAI, PairingHost, PairingGuest, HostRoom, GuestClient, NetChannel, NetInputSource, NET };\nif (typeof document !== "undefined") {');
new Function(src)();
const E = globalThis.__EXPORTS__;
const { CONFIG, Match, AIInput, FXSystem, CameraSystem, CombatState, createBuiltinAI,
        PairingHost, PairingGuest, HostRoom, GuestClient, NET } = E;
const STEP = CONFIG.STEP;

const stubInput = () => ({ isDown: () => false, endFrame() {}, consumeBlade: () => false,
  consumeHammer: () => false, getMoveAxis: () => ({ x: 0, y: 0 }), getAim: () => ({ x: 0, y: 0 }) });
const idleAI = () => ({ name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } });
const mkDemo = (fx, a1, a2) => new Match({ input: stubInput(), fx, audio: { play() {} } },
  { mode: 'demo', opp: 'pvp', p1Input: new AIInput(a1 || idleAI(), 'P1'), p2Input: new AIInput(a2 || idleAI(), 'P2'),
    timeLimit: 300, onEnd() {} });
/* 白盒置刀判定帧（固定 dash 端点防 lerp 拉走） */
function setBladeActive(ent, facing) {
  ent.combat.phase = 'blade_active'; ent.combat.t = 0; ent.facing = facing;
  ent.combat.dashFrom = { x: ent.x, y: ent.y }; ent.combat.dashTo = { x: ent.x, y: ent.y };
}

/* ============================================================
 * S1 打断全链：刀命中锤起手 → −1 HP + 锤回 IDLE + 冷却不启动 + T2 事件
 * ============================================================ */
console.log('[S1] 打断（attack.md v4.1 C）');
{
  const fx = new FXSystem();
  const m = mkDemo(fx);
  m.player.x = 700; m.p2.x = 800; m.p2.y = 360; m.player.y = 360;
  m.p2.combat.startHammer({ x: -1, y: 0 }, m.tick);
  const cdBefore = m.p2.combat.hammerCooldown;
  m.player.combat.startBlade({ x: 1, y: 0 }, m.tick);
  for (let i = 0; i < 30 && m.p2.combat.hp === 3; i++) m.update(STEP);
  const evs = fx.lastEmitted.concat(fx.queue);   // 采集须在补推前（lastEmitted 是上一帧 flush 快照，补推会滚出）
  // I-62 复验：打断当帧末 camera.queue(T2) 入 pending，补推 2 帧让帧首 beginFrame 提交
  m.update(STEP); m.update(STEP);
  ok(m.p2.combat.hp === 2, '刀命中锤起手 → −1 HP');
  ok(m.p2.combat.phase === 'idle', '锤相位立即取消回 IDLE');
  ok(m.p2.combat.hammerCooldown === 0, '锤冷却不启动（0，未完成出招不算出招）');
  ok(evs.some((e) => e.type === 'camera' && e.tier === 2), 'T2 打断 → camera tier2 事件产出');
  ok(evs.some((e) => e.type === 'interrupt_fx'), 'interrupt_fx：锤脱手粒子事件（fx.md v4.1 §C）');
  ok(m.camera.active === true && m.camera.tier === 2,
     '【B1 已修·I-62 复验】打断 T2 → 本地 camera 真实激活（tier=2）');
  ok(Math.abs(m.camera.timeScale() - 0.25) < 1e-9,
     '【B1 已修·I-62 复验】T2 慢放 timeScale=0.25 本地生效');
}

/* ============================================================
 * S2 碎刃全链：锤砸刀判定帧刃区 → 刀方满血秒杀 + T3 + blade_shatter
 * ============================================================ */
console.log('[S2] 碎刃（attack.md v4.1 B：②.5 裁决）');
{
  const fx = new FXSystem();
  const m = mkDemo(fx);
  m.player.x = 700; m.player.y = 360; m.p2.x = 800; m.p2.y = 360;
  m.player.combat.startHammer({ x: 1, y: 0 }, m.tick);
  for (let i = 0; i < 20; i++) m.update(STEP);          // P1 windup 333ms（下帧转 ACTIVE）
  // 同帧竞争构造（attack.md v4.1 D.1/D.2）：P1 锤转 ACTIVE 与 P2 刀判定帧同帧——
  // 若 P2 判定帧早于 P1 ACTIVE，P2 刀会先打断锤起手（③ interrupt，规则行为）；②.5 优先级高于 ③
  setBladeActive(m.p2, Math.PI);                        // P2 刀判定帧面向 P1（刃区朝 -x 覆盖 P1 本体）
  m.update(STEP);                                       // 第 21 帧：P1 → ACTIVE，r1(hammer)+r2(blade) 同帧 → ②.5 碎刃
  ok(m.ended && m.p2.combat.phase === 'dead' && m.p2.combat.hp === 0,
     '锤砸刃区 → 刀方满血(3)直接秒杀（格挡承诺被碾碎，推翻 v4.0「无效格挡」行）');
  // ended=true 冻结 Match.update，相位停在 ACTIVE 帧首；直接驱动 Combat.update 验证「照常进后摇」：
  // 攻击方未被取消/未受伤，走完 150ms ACTIVE 段后正常转 hammer_recovery（attack.md v4.1 B.4）
  ok(m.player.combat.hp === 3 && m.player.combat.phase === 'hammer_active',
     '碎刃当帧锤方未被取消、无伤（满血 3，相位冻结在 ACTIVE 帧首——对局收束冻结）');
  let recov = false;
  for (let i = 0; i < 12; i++) { m.player.combat.update(STEP); if (m.player.combat.phase === 'hammer_recovery') { recov = true; break; } }
  ok(recov, '锤方照常转入后摇 400ms（脱离 Match 循环后 Combat 独立推进 ACTIVE→RECOVERY）');
  const evs = fx.lastEmitted.concat(fx.queue);
  ok(evs.some((e) => e.type === 'camera' && e.tier === 3), 'T3 碎刃击杀 → camera tier3 事件产出');
  ok(evs.some((e) => e.type === 'blade_shatter'), 'blade_shatter：刃片 10~14 枚事件（fx.md v4.1 §C）');
  ok(evs.some((e) => e.type === 'burst' && e.kill), '秒杀爆裂 kill 事件（T3 专属 24 粒+双层环）');
  // I-62 复验：补推 2 帧（ended 后 update 无早退）让帧首 beginFrame 提交第 21 帧末转调的 T3
  m.update(STEP); m.update(STEP);
  ok(m.camera.active === true && m.camera.tier === 3,
     '【B1 已修·I-62 复验】碎刃 T3 → 本地 camera 真实激活（tier=3，帧首提交）');
  ok(Math.abs(m.camera.timeScale() - 0.2) < 1e-9,
     '【B1 已修·I-62 复验】T3 慢放 timeScale=0.2 本地生效');
}

/* ============================================================
 * S3 同帧多时刻取最高档（T3>T2>T1，不叠加）
 * ============================================================ */
console.log('[S3] camera 同帧取最高档');
{
  const cam = new CameraSystem();
  cam.queue(1, 100, 100); cam.queue(3, 200, 200); cam.queue(2, 300, 300);
  cam.beginFrame();
  ok(cam.active && cam.tier === 3 && cam.anchor.x === 200, '同帧 T1+T3+T2 → 取 T3、锚点随高档');
  ok(Math.abs(cam.timeScale() - 0.2) < 1e-9, 'T3 timeScale=0.2');
  cam.update(0.4);                                       // 800ms 未满
  ok(cam.active, 'T3 时长内保持激活');
  cam.queue(1, 0, 0); cam.beginFrame();
  ok(cam.tier === 3, '低档不打断进行中的高档（不叠加）');
  cam.update(0.5);
  ok(!cam.active, '800ms（缩放后时间）走完 → 回 1.0');
  const cam2 = new CameraSystem();
  cam2.queue(2, 0, 0); cam2.beginFrame(); cam2.update(0.2);
  cam2.queue(3, 50, 50); cam2.beginFrame();
  ok(cam2.tier === 3 && cam2.t === 0, 'T2 进行中 T3 高档抢占（重置计时）');
}

/* ============================================================
 * S4 camera 期间逻辑坐标零影响（对拍：zoom+慢放全开 vs 关闭）
 * ============================================================ */
console.log('[S4] camera 仅渲染层：逻辑轨迹对拍');
{
  // 固定脚本 AI：前 10 帧移动，第 11 帧挥刀（确定性）
  const scriptedAI = () => {
    let i = 0;
    return { name: 'script', think() {
      i++;
      if (i === 11) return { move: { x: 0, y: 0 }, blade: { x: 1, y: 0 }, hammer: false };
      return { move: { x: 1, y: 0 }, blade: false, hammer: false };
    } };
  };
  const run = (withCam) => {
    const fx = new FXSystem();
    const m = mkDemo(fx, scriptedAI(), idleAI());
    if (withCam) { m.camera.active = true; m.camera.tier = 3; m.camera.t = 0; m.camera.dur = 1e9;
      m.camera.anchor = { x: 640, y: 360 }; m.camera.timeScale = () => 1; }   // 时制隔离：仅 zoom 变换路径全开
    const pts = [];
    for (let i = 0; i < 60; i++) { m.update(STEP); if (i % 6 === 0) pts.push(m.player.x.toFixed(3) + ',' + m.player.y.toFixed(3) + ':' + m.p2.x.toFixed(3)); }
    return pts.join('|');
  };
  ok(run(true) === run(false), 'zoom 变换全开（timeScale 隔离）逻辑轨迹与关闭完全一致（60 帧 10 采样）');
}

/* ============================================================
 * S5 联机 camera 事件：房主产出 = 访客逐事件收到（modes.md v4.1）
 * ============================================================ */
(async () => {
console.log('[S5] 联机 camera 同步（权威事件流）');
{
  const { mkNetPair } = require('./nethelp.js');
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
  const gc = new GuestClient(new FXSystem());
  gc.attach(guestChan);
  await gc.claimSeat('P2');
  gc.attachAI(idleAI());
  const hostCams = [], guestCams = [];
  const rawQ = gc.camera.queue.bind(gc.camera);
  gc.camera.queue = (tier, x, y) => { guestCams.push({ tier, x, y }); return rawQ(tier, x, y); };
  room.beginCountdown();
  for (let i = 0; i < Math.ceil(NET.COUNTDOWN / STEP); i++) room.update(STEP);
  let ticks = 0;
  let hostCamActiveEver = false;
  let dupCam = false;   // 「广播不双发」探针：单帧 lastEmitted 内同键 camera 事件重复即违规
  while (room.p1Wins + room.p2Wins < 1 && ticks < Math.ceil(70 / STEP) && room.match) {
    room.update(STEP);
    const mf = room.match;
    if (mf) {
      const frameKeys = new Set();
      for (const ev of (mf.fx.lastEmitted || [])) if (ev.type === 'camera') {
        const k = ev.tier + ':' + ev.x + ':' + ev.y;
        if (frameKeys.has(k)) dupCam = true;
        frameKeys.add(k);
        hostCams.push({ tier: ev.tier, x: ev.x, y: ev.y });
      }
      if (mf.camera.active) hostCamActiveEver = true;
    }
    gc.sendInput(); ticks++;
  }
  ok(room.p1Wins + room.p2Wins >= 1, '联机对局跑到 match_end');
  ok(hostCams.length === guestCams.length,
     'camera 事件确定性：房主产出 ' + hostCams.length + ' = 访客收到 ' + guestCams.length);
  const same = hostCams.length === guestCams.length &&
    hostCams.every((h, i) => h.tier === guestCams[i].tier && h.x === guestCams[i].x && h.y === guestCams[i].y);
  ok(same, '逐事件 tier/x/y 全等（观战端与对战者同一特写含时序）');
  // 未知事件兼容：camera 事件对旧 FXSystem 静默
  const fxOld = new FXSystem();
  fxOld.queue.push({ type: 'camera', tier: 3, x: 1, y: 1 });
  let threw = false;
  try { fxOld.flush(); } catch (e) { threw = true; }
  ok(!threw, 'camera 事件对旧消费方（FXSystem）静默忽略不报错');
  // 【I-62 复验】房主本地 camera 真实激活（方案 B 自扫路由生效）
  ok(hostCams.length > 0 && hostCamActiveEver,
     '【B1 已修·I-62 复验】房主权威端产出了 ' + hostCams.length + ' 个 camera 事件且本地 camera.active 真实激活');
  // 【I-62 新增】广播不双发：本地自扫只读 lastEmitted，单帧无重复 camera 事件、访客仍恰收一份（上断言 length 相等）
  ok(!dupCam, '广播不双发：lastEmitted 单帧 camera 事件无重复（本地转调不改广播源）');
}

console.log('========================================');
console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail > 0 ? 1 : 0);
})();
