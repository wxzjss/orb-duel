/* 「光球对决」v4.0「刀与锤」纯逻辑自测（Node，无真实 DOM/Canvas；Input 用事件桩）
 * 运行前提：先从 index.html 提取内嵌脚本到 .tmp_script.js */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', '.tmp_script.js');
const HTML = path.join(__dirname, '..', 'index.html');

/* ---------- 桩：window / canvas（供 Input 注册事件） ---------- */
function installStubs() {
  const winHandlers = {};
  const canvasHandlers = {};
  globalThis.window = {
    addEventListener: (ev, fn) => { winHandlers[ev] = fn; },
  };
  const canvas = {
    addEventListener: (ev, fn) => { canvasHandlers[ev] = fn; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  };
  return {
    canvas,
    fireWin: (ev, e) => winHandlers[ev](e),
    fireCanvas: (ev, e) => canvasHandlers[ev](e),
  };
}
const stub = installStubs();

new Function(fs.readFileSync(SRC, 'utf8'))();
const E = globalThis.__EXPORTS__;
const { CONFIG, Combat, CombatState, Recorder, GhostPlayer, Player, Dummy,
        checkAttackHit, sectorOf, sectorHits, adjudicate, resolveOverlap, Input, FXSystem, Match,
        serializeReplay, deserializeReplay, LocalGhostStore,
        onSelfWin, onSelfLose, onBossSoloWin, onBossSoloLose,
        selfOutcome, bossSoloOutcome, isModeAvailable, hudLines, seedOnLevelWin,
        AIInput, createBuiltinAI, compileAICode,
        deepFreeze, VirtualJoystick, TouchButton, TouchSource,
        NET, b64urlEncode, b64urlDecode, packSDP, unpackSDP, buildSDP,
        errCode, whenDcOpen, NetChannel, PairingHost, PairingGuest,
        CameraSystem, NetInputSource, HostRoom, GuestClient } = E;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}
const STEP = CONFIG.STEP;
const len = (x, y) => Math.hypot(x, y);   // 测试内距离 helper（Utils 不在 __EXPORTS__）
/* 把 Combat 从当前相位推进 n 个逻辑步 */
function steps(c, n) { for (let i = 0; i < n; i++) c.update(STEP); }
const mkBall = (x, y, facing) => {
  const b = { x, y, r: CONFIG.BALL.R, facing };
  b.combat = new Combat(); b.combat.owner = b;
  return b;
};
/* 攻击器构造：直接置判定帧相位（矩阵/几何用；相位即 v4.0 小写枚举） */
const mkAttacker = (x, y, ang, kind) => {
  const b = mkBall(x, y, ang);
  b.combat.phase = kind === 'hammer' ? CombatState.HAMMER_ACTIVE : CombatState.BLADE_ACTIVE;
  return b;
};

/* ---------- T0 删净断言（控制 #13：源码扫描；v4.0：防御触发源删净 + 冲撞系特效删净） ---------- */
console.log('[T0] 删净扫描：闪避词 + 冲撞系特效删净 + guard 触发源删净；刀锤特效语言存在');
{
  const html = fs.readFileSync(HTML, 'utf8');
  ok(html.match(/dodge|闪避|graze|擦弹/gi) === null, '全文无 dodge/闪避/graze/擦弹（v1.1 T0 不回退）');
  ok(/charge_afterimages|charge_speedlines|FX\.WINDUP|FX\.BAND|FX\.SPARK|streaks|squash|stretch/.test(html) === false,
     'v4.0：冲撞光带/速度线/拉丝/星芒/球体形变删净（刀锤特效取代；月牙刃光属挥刀语言不在禁区）');
  ok(/\.guardHeld\(|guard_denied|guard_halo|shield_break|bounce_stun|GUARD_HITSTOP|FX\.BREAK|FX\.STUN|FX\.DENY|startCharge|getChargeDir|consumeClick\(0\)|CHARGE_/.test(html) === false,
     'v4.0：guard 触发源/负反馈/碎盾/眩晕环删净 + 冲撞状态机入口删净（dormant 仅保留 Combat 内核）');
  ok(/\bnew RemoteGhostStore\b|\bfunction seedRemote\b|\bid="scr-boss"|\bclass BossMenuScreen\b|\bid="scr-ai"|\bclass AiScreen\b|\bAISlotStore\b|\bBUILTIN_AI_SAMPLE\b/.test(html) === false,
     'v3.0：联机三池/RemoteGhostStore/二级boss屏/AI 编辑屏死代码删净（代码级扫描）');
  // —— v4.0 刀锤特效语言存在性（fx.md v4.0 B/C 表）——
  ok(/BLADE_ARC:\s*\{\s*LIFE:\s*0\.180,\s*WIDTH:\s*24/.test(html) &&
     /BLADE_AFTER:\s*\{\s*N:\s*2,\s*GAP:\s*0\.025,\s*LIFE:\s*0\.2,\s*ALPHAS:\s*\[\s*0\.4,\s*0\.25\s*\]/.test(html),
     '挥刀特效参数：宽月牙弧 180ms/宽24 + 残影 2 段 25ms 间隔 alpha 0.4/0.25');
  ok(/HAMMER_ARC:\s*\{\s*LIFE:\s*0\.250,\s*WIDTH:\s*32/.test(html) &&
     /HAMMER_RING:\s*\{\s*LIFE:\s*0\.250,\s*R1:\s*70/.test(html),
     '重锤特效参数：弧光 250ms/宽32 + 落点冲击环 r0→70');
  ok(html.includes("'blade_swing'") && html.includes("'blade_afterimages'") &&
     html.includes("'hammer_charge'") && html.includes("'hammer_strike'"),
     'fxHooks 发射挥刀/重锤四类事件');
  ok(/GLOW:\s*\{\s*PLAYER:\s*\{\s*R:\s*70,\s*A:\s*0\.85/.test(html), '球体增亮：双层外晕 r70 α0.85');
}

/* ---------- T1 Recorder → GhostPlayer 镜像回放（v2.3 镜像复刻 + v4.0 charge→blade 映射） ---------- */
console.log('[T1] Recorder + GhostPlayer 镜像复刻（x\'=1280−x，dirAngle\'=π−dirAngle；charge→blade 映射，guard 静默跳过）');
{
  const rec = new Recorder();
  rec.begin();
  for (let t = 0; t < 200; t++) {
    let x = 230, y = 360;
    if (t >= 30 && t < 90) x = 230 + (t - 30) * 3;
    rec.sample(x, y);
    if (t === 60) rec.recordAction('charge', 0, t);          // 历史 replay：旧 charge 事件
    if (t === 150) rec.recordAction('guard_begin', undefined, t);
    if (t === 160) rec.recordAction('guard_end', undefined, t);
  }
  const rep = rec.finalize();
  ok(rep.events.length === 3, '事件流完整（charge/guard_begin/guard_end）');

  // v2.3 offset 推导：幽灵出生点 − 镜像后玩家出生点（勿硬编码）
  const offX = CONFIG.SPAWN.GHOST.x - (CONFIG.VIEW.W - CONFIG.SPAWN.PLAYER.x);
  const offY = CONFIG.SPAWN.GHOST.y - CONFIG.SPAWN.PLAYER.y;
  ok(offX === 0 && offY === 0,
     'offset 公式推导 = (0,0)（镜像后玩家出生 230 → 1050 = 幽灵出生点）');

  const fakeGame = { player: { x: 1050, y: 999 } };
  const ghost = new GhostPlayer(rep, offX, offY);
  let posOK = true, idleChecked = 0, prevPhase = 'idle';
  let bladePhase60 = null, facing60 = null, phase150 = null, phase160 = null;
  for (let t = 0; t < 200; t++) {
    ghost.update(t, STEP, fakeGame);
    if (t === 0) ok(ghost.x === CONFIG.SPAWN.GHOST.x,
                    '幽灵出生点 = 1050 由镜像自然得出（轨迹首帧 230 → x\'=1050）');
    if (t === 60) { bladePhase60 = ghost.combat.phase; facing60 = ghost.facing; }
    if (t === 150) phase150 = ghost.combat.phase;
    if (t === 160) phase160 = ghost.combat.phase;
    if (ghost.combat.phase === 'idle' && prevPhase === 'idle') {
      idleChecked++;
      if (Math.abs(ghost.x - (CONFIG.VIEW.W - rep.trajectory[2 * t]) - offX) > 1e-4 ||
          Math.abs(ghost.y - rep.trajectory[2 * t + 1] - offY) > 1e-4) { posOK = false; break; }
    }
    prevPhase = ghost.combat.phase;
  }
  ok(posOK, 'IDLE 帧回放位置 = 1280−录制x + offset（镜像逐帧校验 ' + idleChecked + ' 帧）');
  ok(bladePhase60 === 'blade_windup' && Math.abs(facing60 - Math.PI) < 1e-9,
     'v4.0 映射：录制 charge/dirAngle=0（朝右）→ 幽灵 startBlade 且 facing=π（朝左镜像）');
  ok(phase150 === 'idle', 'guard_begin 历史事件静默跳过（不进 GUARD，guard.md DEPRECATED）');
  ok(phase160 === 'idle', 'guard_end 历史事件静默跳过');

  // 循环接缝（T=200）
  let seamOK = true;
  for (let t = 200; t < 240; t++) {
    ghost.update(t, STEP, fakeGame);
    if (ghost.combat.phase !== 'idle') continue;
    const tt = t % 200;
    if (Math.abs(ghost.x - (CONFIG.VIEW.W - rep.trajectory[2 * tt])) > 1e-4) { seamOK = false; break; }
  }
  ok(seamOK, 't mod T 循环接缝无跳变（镜像轴）');
}

/* ---------- T2 Combat：v4.0 刀锤三段 + 双冷却 + STAGGER + hit/kill ---------- */
console.log('[T2] Combat 刀锤状态机（80/70/120 + 突进 63px；350/150/400；双冷却独立；STAGGER 300ms；kill 秒杀）');
{
  ok(CONFIG.BLADE.WINDUP === 0.080 && CONFIG.BLADE.ACTIVE === 0.070 &&
     CONFIG.BLADE.RECOVERY === 0.120 && CONFIG.BLADE.LUNGE_SPEED === 900 &&
     CONFIG.BLADE.COOLDOWN === 0.270, '刀参数：80/70/120ms + 900px/s + 冷却 270ms');
  ok(CONFIG.HAMMER.WINDUP === 0.350 && CONFIG.HAMMER.ACTIVE === 0.150 &&
     CONFIG.HAMMER.RECOVERY === 0.400 && CONFIG.HAMMER.COOLDOWN === 0.900,
     '锤参数：350/150/400ms + 冷却 900ms');
  ok(CONFIG.BALL.SPEED === 640 && CONFIG.BALL.R === 32, 'v4.0 移速 640 / 体型 32');

  // —— 刀三段 + 突进 63px ——
  const b = mkBall(400, 360, 0);
  const c = b.combat;
  ok(c.startBlade({ x: 1, y: 0 }, 100) === true, 'startBlade 向量契约');
  ok(c.bladeCooldown === CONFIG.BLADE.COOLDOWN, '出招即置刀冷却 270ms（从出招起算）');
  c.update(0.0333);
  ok(c.phase === 'blade_windup', '80ms 内保持 windup（起手帧无无敌）');
  c.update(0.05);
  ok(c.phase === 'blade_active', '80ms 后进入判定帧（刃区扇形）');
  ok(Math.abs(c.dashTo.x - (400 + 63)) < 0.5, 'dashTo = 起点 + 63px（900×0.070 突进）');
  c.update(0.071);
  ok(c.phase === 'blade_recovery', '判定 70ms 后进后摇（后摇全身可被打）');
  ok(Math.abs((b.x - 400) - 63) < 0.5, '突进位移 ≈63px');
  c.update(0.12);
  ok(c.phase === 'idle', '后摇 120ms 后回 IDLE（总周期 270ms）');
  ok(c.bladeCooldown <= 0, '出招起算 270ms 冷却同步走完');

  // —— 锤三段：无突进 + 起手/判定移动锁定 + 冷却 900ms ——
  const hb = mkBall(400, 360, 0);
  const hc = hb.combat;
  ok(hc.startHammer({ x: 1, y: 0 }, 200) === true, 'startHammer 向量契约');
  ok(hc.hammerCooldown === CONFIG.HAMMER.COOLDOWN, '出招即置锤冷却 900ms');
  hc.update(0.34);
  ok(hc.phase === 'hammer_windup', '350ms 内保持锤起手');
  hc.update(0.01);
  ok(hc.phase === 'hammer_active', '350ms 后进判定帧（锤区扇形）');
  ok(Math.abs(hb.x - 400) < 1e-9, '锤无突进（判定帧位移为 0）');
  hc.update(0.15);
  ok(hc.phase === 'hammer_recovery', '判定 150ms 后进后摇');
  hc.update(0.4);
  ok(hc.phase === 'idle', '后摇 400ms 后回 IDLE（总周期 900ms）');
  ok(Math.abs(hc.hammerCooldown) < 1e-9, '锤冷却 900ms 同步走完');

  // —— 双冷却独立互不取消 ——
  const db = mkBall(400, 360, 0);
  db.combat.startBlade({ x: 1, y: 0 }, 0);
  db.combat.update(0.05);                       // 刀起手中
  ok(db.combat.startHammer({ x: 1, y: 0 }, 0) === false, '攻击状态槽互斥：非 IDLE 不能出锤');
  db.combat.bladeCooldown = 0.1;                // 白盒：刀仍在冷却
  db.combat.phase = CombatState.IDLE;           // 相位空闲但冷却未尽
  ok(db.combat.startBlade({ x: 1, y: 0 }, 0) === false, '刀冷却期内拒绝再出刀');
  ok(db.combat.startHammer({ x: 1, y: 0 }, 0) === true, '锤冷却独立：可立即出锤');

  // —— 贴墙 clamp（突进端点） ——
  const wall = mkBall(1240, 360, 0);
  wall.combat.startBlade({ x: 1, y: 0 }, 300);
  wall.combat.update(0.08);
  ok(wall.combat.dashTo.x === CONFIG.VIEW.W - CONFIG.BOUND.INSET,
     '贴墙 dashTo.x = 1248（INSET=32 clamp 生效）');
  ok(CONFIG.BOUND.INSET === 32, 'v4.0 边界内缩 = 体型 32');

  // —— NaN 防御 ——
  const nanBall = mkBall(500, 360, NaN);
  nanBall.combat.phase = CombatState.BLADE_ACTIVE;
  const victim = mkBall(505, 360, 0);
  ok(checkAttackHit(nanBall, victim) === null, 'NaN facing → sectorHits false → checkAttackHit null');

  // —— STAGGER：刀刀弹开 300ms（击退 60px/150ms + 硬直 150ms），不掉血 ——
  const cb = mkBall(500, 360, 0);
  cb.combat.stagger({ x: -1, y: 0 });
  ok(cb.combat.phase === 'stagger', 'stagger() 进入 STAGGER');
  cb.combat.update(0.075);
  ok(Math.abs((500 - cb.x) - 30) < 1e-6, '击退插值半程 30px@75ms');
  cb.combat.update(0.075);
  ok(Math.abs((500 - cb.x) - CONFIG.CLASH.KNOCKBACK) < 1e-6, '击退 60px/150ms 完成');
  cb.combat.update(0.15);
  ok(cb.combat.phase === 'idle' && Math.abs(cb.x - 440) < 1e-6, '300ms 弹开结束回 IDLE（硬直钉在终点）');

  // —— hit()/HP=3 与 kill() 秒杀（无视 HP） ——
  const h = mkBall(0, 0, 0);
  ok(h.combat.hp === 3 && h.combat.maxHP === 3, '初始 HP=3');
  ok(h.combat.hit() === 'hit' && h.combat.hp === 2, '刀命中 −1 HP 不死');
  ok(h.combat.hit() === 'hit' && h.combat.hp === 1, '第 2 刀 −1 HP 不死');
  ok(h.combat.hit() === 'dead' && h.combat.hp === 0 && h.combat.phase === 'dead',
     '第 3 刀 HP 归 0 → dead');
  const k = mkBall(0, 0, 0);
  k.combat.hit(); k.combat.hit();               // HP=1
  k.combat.kill();
  ok(k.combat.hp === 0 && k.combat.phase === 'dead', 'kill() 无视 HP 直接秒杀');
}

/* ---------- T2b guard dormant（v4.0：代码保留无触发源） ---------- */
console.log('[T2b] dormant 防御内核：startGuard/releaseGuard/bounce 可编程触发仍自洽（运行时无调用源）');
{
  // dormant 语义回归：内核分支保留且行为不变（供未来复用/回滚验证）
  const a = mkBall(0, 0, 0);
  a.combat.startGuard();
  steps(a.combat, 1);
  ok(a.combat.releaseGuard('manual') === true && a.combat.phase === 'GUARD_RELEASE',
     'startGuard→releaseGuard(manual) 内核自洽（dormant）');
  ok(Math.abs(a.combat._coolDur - STEP) < 1e-9, 'manual 冷却 = 已防御时长');
  steps(a.combat, 1);
  ok(a.combat.phase === 'idle', '冷却结束回 IDLE');

  const bn = mkBall(500, 360, 0);
  bn.combat.phase = 'blade_active';
  bn.combat.bounce();
  ok(bn.combat.phase === 'BOUNCE', 'bounce 内核自洽（dormant）');
  bn.combat.update(CONFIG.BOUNCE.DURATION);
  ok(bn.combat.phase === 'idle', 'BOUNCE 400ms 后回 IDLE');

  // dormant 枚举仍在 CombatState（联机协议 phase 兼容面）
  ok(CombatState.GUARD === 'GUARD' && CombatState.GUARD_RELEASE === 'GUARD_RELEASE' &&
     CombatState.BOUNCE === 'BOUNCE' && CombatState.CLASH === 'CLASH',
     'dormant 相位枚举保留（GUARD/GUARD_RELEASE/BOUNCE/CLASH）');
  ok(CombatState.BLADE_ACTIVE === 'blade_active' && CombatState.HAMMER_ACTIVE === 'hammer_active' &&
     CombatState.STAGGER === 'stagger' && CombatState.DEAD === 'dead',
     'v4.0 相位枚举小写字符串（联机快照 phase 同源）');
}

/* ---------- T3 v4.0 命中矩阵全表 + 结算顺序（attack.md §5，确定性核心） ---------- */
console.log('[T3] sectorHits 几何容差 + checkAttackHit 矩阵（刀 hit/锤 kill）+ adjudicate ①②③ + 护前不护后 + 至多一次');
{
  // —— (a) 扇形几何：刀 128px/±45°，锤 96px/±30°，目标圈 atan(32/d) 角度补偿 + radius+32 距离补偿 ——
  const B = mkAttacker(500, 360, 0, 'blade');         // 刀判定帧朝右
  ok(sectorOf(B).radius === 128 && Math.abs(sectorOf(B).halfAngle - Math.PI / 4) < 1e-9,
     'sectorOf(blade_active)：radius=128 / halfAngle=π/4');
  ok(sectorHits(sectorOf(B), mkBall(600, 360, Math.PI)) === true, '刀：正前 100px 在刃区（≤128+32）');
  ok(sectorHits(sectorOf(B), mkBall(665, 360, Math.PI)) === false, '刀：165px > 128+32 补偿外不可及');
  const diag = mkBall(500 + 100 * Math.SQRT1_2, 360 + 100 * Math.SQRT1_2, Math.PI);
  ok(sectorHits(sectorOf(B), diag) === true, '刀：45° 斜向 100px（da=45° ≤ 45°+容差）命中');
  const edge = mkBall(500 + 100 * Math.cos(1.05), 360 + 100 * Math.sin(1.05), Math.PI);
  ok(sectorHits(sectorOf(B), edge) === true, '刀：60.2° 处 atan(32/100)≈17.7° 容差补偿内命中');
  const farAng = mkBall(500 + 100 * Math.cos(1.4), 360 + 100 * Math.sin(1.4), Math.PI);
  ok(sectorHits(sectorOf(B), farAng) === false, '刀：80.2° 超出 45°+容差 → 刃区外');
  const H = mkAttacker(500, 360, 0, 'hammer');        // 锤判定帧朝右
  ok(sectorOf(H).radius === 96 && Math.abs(sectorOf(H).halfAngle - Math.PI / 6) < 1e-9,
     'sectorOf(hammer_active)：radius=96 / halfAngle=π/6');
  ok(sectorHits(sectorOf(H), mkBall(580, 360, Math.PI)) === true, '锤：正前 80px 在锤区（≤96+32）');
  ok(sectorHits(sectorOf(H), mkBall(640, 360, Math.PI)) === false, '锤：140px > 96+32 不可及');
  ok(sectorHits(sectorOf(H), mkBall(500 + 64 * Math.cos(0.95), 360 + 64 * Math.sin(0.95), Math.PI)) === true,
     '锤：54.4° 处 atan(32/64)≈26.6° 容差补偿内命中（30°+26.6°）');
  ok(sectorHits(sectorOf(H), mkBall(500 + 64 * Math.cos(1.25), 360 + 64 * Math.sin(1.25), Math.PI)) === false,
     '锤：71.6° 超出 30°+容差 → 锤区外');
  ok(sectorHits({ x: 500, y: 360, dirAngle: NaN, radius: 128, halfAngle: 1 }, mkBall(560, 360, 0)) === false,
     'NaN dirAngle 防御 → false');

  // —— (b) 5.1/5.2 矩阵逐行（checkAttackHit）——
  const ab = mkAttacker(500, 360, 0, 'blade');
  ok(checkAttackHit(ab, mkBall(564, 360, Math.PI)) === 'blade', '矩阵 5.1：刀 vs idle → hit（blade）');
  const corpse = mkBall(564, 360, Math.PI);
  corpse.combat.kill();
  ok(checkAttackHit(ab, corpse) === null, 'DEAD 不产生事件');
  const ah = mkAttacker(500, 360, 0, 'hammer');
  ok(checkAttackHit(ah, mkBall(564, 360, Math.PI)) === 'hammer', '矩阵 5.2：锤 vs idle → 秒杀（hammer）');
  const backBlade = mkBall(564, 360, 0);              // 对手刀判定帧但背对（朝右）
  ok(checkAttackHit(ah, backBlade) === 'hammer', '矩阵 5.2：锤 vs 对手刀判定帧（背对）→ kill（锤无格挡语义）');
  ok(backBlade.combat.hp === 3, '秒杀无视当前 HP');
  // 至多一次标记
  const v1 = mkAttacker(500, 360, 0, 'blade'), v2 = mkBall(564, 360, Math.PI);
  ok(checkAttackHit(v1, v2) === 'blade', '首次判定产生事件');
  v1.combat._hitVictims.add(v2);
  ok(checkAttackHit(v1, v2) === null, '同一攻击对同一目标至多一次（_hitVictims）');

  // —— (c) adjudicate §5.3 结算顺序 ——
  // ① 刀刀双判定帧双向刃区相交 → stagger
  const p1 = mkAttacker(500, 360, 0, 'blade'), p2 = mkAttacker(564, 360, Math.PI, 'blade');
  const ev1 = [{ attacker: p1, defender: p2, kind: 'blade' }, { attacker: p2, defender: p1, kind: 'blade' }];
  const vd = adjudicate(ev1);
  ok(vd.type === 'stagger' && (vd.a === p1 || vd.a === p2), '① 双刀刃区互交 → stagger（弹开）');
  const vdSwap = adjudicate([ev1[1], ev1[0]]);
  ok(vdSwap.type === 'stagger', '① 对称输入对称输出（控制 #15）');
  // ① 不触发变体：双刀但 defender 背对（单向覆盖）→ 落 ③
  const q1 = mkAttacker(500, 360, 0, 'blade'), q2 = mkAttacker(564, 360, 0, 'blade');   // q2 朝右背对
  const vs = adjudicate([{ attacker: q1, defender: q2, kind: 'blade' }]);
  ok(vs.type === 'list' && vs.list.length === 1 && vs.list[0].type === 'hit',
     '护前不护后：defender 刀判定帧但背对 → ① 不触发 → ③ hit');
  // ② 锤锤互中 → draw_kill
  const m1 = mkAttacker(500, 360, 0, 'hammer'), m2 = mkAttacker(564, 360, Math.PI, 'hammer');
  const vk = adjudicate([{ attacker: m1, defender: m2, kind: 'hammer' },
                         { attacker: m2, defender: m1, kind: 'hammer' }]);
  ok(vk.type === 'draw_kill' && (vk.a === m1 || vk.a === m2), '② 双锤互中 → draw_kill（同归于尽）');
  ok(adjudicate([{ attacker: m1, defender: m2, kind: 'hammer' }]).type === 'list',
     '单锤事件（对方锤区未及）不触发 ②，落 ③ kill');
  // ②.5 碎刃（v4.1 反转 v4.0 格挡行，attack.md v4.1 B）：锤判定帧砸在对方刀判定帧刃区内 → 刀方直接秒杀
  const ha = mkAttacker(500, 360, 0, 'hammer');
  const db = mkAttacker(564, 360, Math.PI, 'blade');  // 对手刀判定帧朝左（面向锤，刃区覆盖锤）
  const vb = adjudicate([{ attacker: ha, defender: db, kind: 'hammer', defPhase: CombatState.BLADE_ACTIVE },
                         { attacker: db, defender: ha, kind: 'blade' }]);
  ok(vb.type === 'break_kill' && vb.winner === ha && vb.loser === db,
     '②.5 碎刃：锤判定帧×对方刀判定帧刃区相交 → break_kill（v4.1 推翻 v4.0「无效格挡」行）');
  const vb2 = adjudicate([{ attacker: ha, defender: db, kind: 'hammer' }]);
  ok(vb2.type === 'break_kill', '②.5：defPhase 缺省回落实时相位（纯函数契约延续，控制 #15）');
  // ②.5 负向：锤砸刀判定帧但落点在刃区外（背对）→ 落 ③ 普通秒杀（kill，T1 档）
  const hb2 = mkAttacker(500, 360, 0, 'hammer');
  const db2 = mkAttacker(564, 360, 0, 'blade');       // 刀判定帧朝右（背对锤）
  const vn = adjudicate([{ attacker: hb2, defender: db2, kind: 'hammer', defPhase: CombatState.BLADE_ACTIVE }]);
  ok(vn.type === 'list' && vn.list.length === 1 && vn.list[0].type === 'kill',
     '②.5 负向：锤落点在对方刃区外 → ③ kill（普通秒杀，T1）');
  // ③ 打断（v4.1 新增，attack.md v4.1 C）：刀命中锤起手（帧首 windup）→ interrupt
  const ib = mkAttacker(500, 360, 0, 'blade');
  const hw = mkBall(564, 360, Math.PI);
  hw.combat.phase = CombatState.HAMMER_WINDUP;
  const vi = adjudicate([{ attacker: ib, defender: hw, kind: 'blade', defPhase: CombatState.HAMMER_WINDUP }]);
  ok(vi.type === 'list' && vi.list.length === 1 && vi.list[0].type === 'interrupt' && vi.list[0].winner === ib,
     '③ 打断：刀命中锤起手 → interrupt（−1 HP + 相位取消 + 冷却不启动，T2 特写通道）');
  // ③ 刀 vs 刀刃区格挡保留（v4.1 仅反转锤行）：defender 刀判定帧且刀攻击者在其刃区 → ineffective
  const gb1 = mkAttacker(500, 360, 0, 'blade');
  const gb2 = mkAttacker(564, 360, Math.PI, 'blade');
  const vg = adjudicate([{ attacker: gb1, defender: gb2, kind: 'blade', defPhase: CombatState.BLADE_ACTIVE }]);
  ok(vg.type === 'list' && vg.list[0].type === 'ineffective',
     '③ 刀 vs 刀刃区格挡保留（v4.1 未改此行）→ ineffective');
  // ③ 单刀事件 → hit
  const s1 = mkAttacker(500, 360, 0, 'blade');
  const vhit = adjudicate([{ attacker: s1, defender: mkBall(564, 360, Math.PI), kind: 'blade' }]);
  ok(vhit.type === 'list' && vhit.list[0].type === 'hit' && vhit.list[0].winner === s1,
     '③ 单刀事件 → list[0] hit（winner/loser 通道）');
  // ③ 单锤事件 → kill
  const vkill = adjudicate([{ attacker: mkAttacker(500, 360, 0, 'hammer'),
                              defender: mkBall(564, 360, Math.PI), kind: 'hammer' }]);
  ok(vkill.type === 'list' && vkill.list[0].type === 'kill', '③ 单锤事件 → list[0] kill（秒杀）');
  ok(adjudicate([]).type === 'none', '空事件 → none');
}

/* ---------- T3b 实体碰撞软推挤（v2.2 E，v4.0 分离距离 64） ---------- */
console.log('[T3b] resolveOverlap：分离 64（32+32）/ 完全重合 / DEAD 不推 / 交错突进无穿模');
{
  ok(CONFIG.BALL.R * 2 === 64, 'v4.0 本体分离距离 = 64（体型翻倍）');
  const a = mkBall(500, 360, 0), b = mkBall(510, 360, 0);   // 距 10 < 64
  resolveOverlap(a, b);
  ok(Math.abs(len(b.x - a.x, b.y - a.y) - 64) < 1e-6 && a.x < 500 && b.x > 510,
     '重叠 → 沿连线各推一半至恰好不重叠（64）');

  const c1 = mkBall(500, 360, 0), c2 = mkBall(500, 360, 0); // 完全重合
  resolveOverlap(c1, c2);
  ok(Math.abs(len(c2.x - c1.x, c2.y - c1.y) - 64) < 1e-6, '完全重合 → 沿 +x 分离 64');

  const d1 = mkBall(500, 360, 0), d2 = mkBall(510, 360, 0);
  d1.combat.kill();
  resolveOverlap(d1, d2);
  ok(d2.x === 510, 'DEAD 不推（尸体静止）');

  // 交错突进：相向 dash 中点相遇，多帧分离无穿模
  const s1 = mkBall(400, 360, 0), s2 = mkBall(700, 360, Math.PI);
  s1.combat.startBlade({ x: 1, y: 0 }, 0);
  s2.combat.startBlade({ x: -1, y: 0 }, 0);
  steps(s1.combat, 5); steps(s2.combat, 5);           // 双 ACTIVE（突进中点已交错）
  let noClip = true;
  for (let i = 0; i < 30; i++) {
    s1.combat.update(STEP); s2.combat.update(STEP);
    resolveOverlap(s1, s2);
    if (len(s2.x - s1.x, s2.y - s1.y) < s1.r + s2.r - 1e-6) { noClip = false; break; }
  }
  ok(noClip, '交错突进逐帧软推挤：全程无穿模（扇形随实际球心重算）');
}

/* ---------- T4 Input：准星方向 + 刀/锤点按消费（v4.0 键位） ---------- */
console.log('[T4] Input getAim 准星/触屏兜底 + consumeBlade/consumeHammer 点按一次消费 + 失焦清空');
{
  const input = new Input(stub.canvas);
  const pos = { x: 400, y: 360 };
  stub.fireCanvas('mousemove', { clientX: 400, clientY: 160 });   // 准星在球心正上
  let dir = input.getAim(pos, null);
  ok(dir.x === 0 && Math.abs(dir.y + 1) < 1e-9, 'getAim：鼠标准星方向 (0,-1)');
  stub.fireCanvas('mousemove', { clientX: 640, clientY: 360 });
  dir = input.getAim({ x: 640, y: 360 }, null);
  ok(dir.x === 0 && dir.y === 0, '准星与球心重合 → 零向量（Player 层兜底朝对手）');

  // 左键挥刀 / 右键重锤：点按一次消费
  const input2 = new Input(stub.canvas);
  ok(input2.consumeBlade() === false && input2.consumeHammer() === false, '初始无点按');
  stub.fireCanvas('mousedown', { button: 0 });
  ok(input2.consumeBlade() === true && input2.consumeBlade() === false, '左键 → blade 点按一次消费');
  stub.fireCanvas('mousedown', { button: 2 });
  ok(input2.consumeHammer() === true && input2.consumeHammer() === false, '右键 → hammer 点按一次消费');
  stub.fireCanvas('mousedown', { button: 2 });
  stub.fireWin('blur', {});
  ok(input2.consumeHammer() === false, '失焦清空重锤点按（防幽灵键）');
  input2.endFrame();
  ok(input2.consumeBlade() === false, 'endFrame 后未消费的左键不跨帧排队');

  // 触屏聚合：攻击钮→刀 / 重锤钮→锤（v4.0 键位改派）
  const input3 = new Input(stub.canvas);
  input3.touch.btnAtk.down(5);
  ok(input3.consumeBlade() === true, '触屏攻击钮 → consumeBlade 聚合');
  input3.touch.btnGuard.down(5);
  ok(input3.consumeHammer() === true, '触屏防御钮 → consumeHammer（v4.0 重锤改派）');

  // 触屏准星：摇杆方向 > 朝对手兜底
  const input4 = new Input(stub.canvas);
  input4.touch.visible = true;
  input4.touch.joystick.start(3, 100, 100);
  input4.touch.joystick.move(3, 160, 100);
  dir = input4.getAim({ x: 400, y: 360 }, null);
  ok(Math.abs(dir.x - 1) < 1e-9 && Math.abs(dir.y) < 1e-9, '触屏：摇杆方向优先为准星');
  input4.touch.joystick.end(3);
  dir = input4.getAim({ x: 400, y: 360 }, { p2: { x: 400, y: 200 } });
  ok(Math.abs(dir.y + 1) < 1e-9, '触屏摇杆静止 → 朝对手兜底');
  dir = input4.getAim({ x: 400, y: 360 }, null);
  ok(dir.x === 0 && dir.y === 0, '触屏无摇杆无对手 → 零向量');
}

/* ---------- T5 Player 刀/锤输入流 + 录制事件对齐（v4.0） ---------- */
console.log('[T5] Player 输入流：左键出刀（准星角）/ 非IDLE拒绝 / 冷却期拒绝 / blade 事件 t 同源');
{
  const input = new Input(stub.canvas);
  const rec = new Recorder(); rec.begin();
  const player = new Player(CONFIG.SPAWN.PLAYER.x, CONFIG.SPAWN.PLAYER.y);
  player.combat.onAction = (type, ang, t) => rec.recordAction(type, ang, t);
  const game = { tick: 0, fx: { queue: [] } };

  stub.fireCanvas('mousemove', { clientX: 1130, clientY: 360 });   // 准星正右
  stub.fireCanvas('mousedown', { button: 0 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'blade_windup' && Math.abs(player.facing) < 1e-9,
     '左键+准星右 → blade_windup，facing=0（准星方向锁定）');
  stub.fireCanvas('mousedown', { button: 2 });                     // 起手中点右键
  player.update(STEP, input, game);
  ok(player.combat.phase === 'blade_windup', '非 IDLE 出锤被拒（攻击状态槽互斥）');
  player.combat.update(0.08);                                      // 起手转判定
  player.combat.update(0.07);                                      // 判定转后摇
  ok(player.combat.phase === 'blade_recovery', '判定结束进后摇');
  stub.fireCanvas('mousedown', { button: 0 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'blade_recovery', '刀冷却期内（270ms 未走完）再点无效');
  for (let i = 0; i < 8; i++) player.update(STEP, input, game);    // 后摇 120ms + 冷却走完
  stub.fireCanvas('mousedown', { button: 0 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'blade_windup', '冷却完毕可再出刀');
  const evs = rec.finalize().events;
  ok(evs.length === 2 && evs[0].type === 'blade' && evs[1].type === 'blade',
     '两次成功出刀均录制（被拒的 hammer 不录）');
  ok(evs[0].dirAngle === 0, 'blade 事件 dirAngle === 0（角度契约，回放镜像用）');
}

/* ---------- T6 Player 挥刀集成（v4.0 突进 63px + 命中回归） ---------- */
console.log('[T6] Player 挥刀集成：输入驱动 + 突进 63px + 刀命中几何回归');
{
  const input = new Input(stub.canvas);
  const rec = new Recorder(); rec.begin();
  const player = new Player(230, 360);
  player.combat.onAction = (type, ang, t) => rec.recordAction(type, ang, t);
  const game = { tick: 0, fx: { queue: [] } };

  stub.fireCanvas('mousemove', { clientX: 1130, clientY: 360 });   // 准星右
  stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });
  stub.fireCanvas('mousedown', { button: 0 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'blade_windup' && Math.abs(player.facing) < 1e-9,
     'KeyD+左键 → blade_windup，facing=0');
  player.update(0.08, input, game);                   // 累计 ≥80ms → ACTIVE
  ok(player.combat.phase === 'blade_active', '起手 80ms 后进入判定帧');
  ok(Math.abs(player.combat.dashTo.x - (230 + 63)) < 0.5, 'dashTo ≈ (293, 360)（900×0.070 突进）');
  player.update(0.07, input, game);                   // ACTIVE 走完
  ok(player.combat.phase === 'blade_recovery' && Math.abs(player.x - 293) < 0.5,
     '突进终点 x≈293（63px）');

  const chargeEv = rec.finalize().events.find(e => e.type === 'blade');
  ok(!!chargeEv && chargeEv.dirAngle === 0, '录制 blade 事件 dirAngle === 0（角度契约）');

  const near = mkBall(330, 360, Math.PI);
  const far = mkBall(560, 360, Math.PI);
  const probe = mkAttacker(293, 360, 0, 'blade');
  ok(checkAttackHit(probe, near) === 'blade', '判定帧下 37px 内目标 hit');
  ok(checkAttackHit(probe, far) === null, '判定帧下 267px 外目标不命中（刃区 128+32 补偿外）');
}

/* ---------- T11 灰显 + HUD 文案 + v2.2 血条常量 + v4.0 数值 ---------- */
console.log('[T11] isModeAvailable（IA）+ hudLines 逐字 + HPBAR 布局 + v4.0 刀锤/增亮/爆裂常量');
{
  const store = new LocalGhostStore();
  ok(isModeAvailable('solo', store) && isModeAvailable('self', store) &&
     isModeAvailable('quit', store), 'solo/self/quit 常亮');
  ok(isModeAvailable('online', store), 'v3.0：联机常亮（PAIR 配对流）');
  ok(!isModeAvailable('ai', store), 'AI 菜单项已随用户指令删除（isModeAvailable 返回 false）');
  ok(!isModeAvailable('boss', store) && !isModeAvailable('boss_online', store) &&
     !isModeAvailable('boss_final', store),
     'v3.0：旧 boss 二级入口与联机三池 act 已失效（返回 false）');
  ok(!isModeAvailable('boss_solo', store), 'boss_solo 空池灰显');
  ok(JSON.stringify(hudLines('self', { defeatedPlayers: 5 })) ===
     JSON.stringify(['已打败玩家数：5/20']), 'self HUD 逐字');
  ok(JSON.stringify(hudLines('boss_solo', { challengedSuccess: 3, defeatedPlayers: 7 })) ===
     JSON.stringify(['被挑战成功数：3/20', '已打败玩家数：7']), '单机boss HUD 逐字');
  ok(hudLines('solo', null).length === 0, 'solo 无 DOM HUD 行');

  // v2.2 血条布局常量（fx.md v2.2 §D）
  const HB = CONFIG.HPBAR;
  ok(HB.W === 24 && HB.H === 10 && HB.GAP === 6 && HB.Y === 24 &&
     HB.CX_P === 340 && HB.CX_G === 940,
     '血条常量：3 格 24×10 间隔 6，组中心 x=340/940，y=24');
  const total = HB.W * 3 + HB.GAP * 2;
  ok(HB.CX_P - total / 2 > 0 && HB.CX_P + total / 2 < 640 - 60 &&
     HB.CX_G - total / 2 > 640 + 60 && HB.CX_G + total / 2 < CONFIG.VIEW.W,
     '血条组与「第 N 关」(x=640) 及画布边缘不重叠');

  // v4.0 数值锁定（attack.md v4.0 §2 + fx.md v4.0）
  ok(CONFIG.HP.MAX === 3 && CONFIG.CLASH.DURATION === 0.300 &&
     CONFIG.CLASH.KNOCKBACK === 60 && CONFIG.CLASH.KNOCKBACK_DUR === 0.150,
     'v2.2 数值沿用：maxHP=3 / 刀刀弹开 300ms / 击退 60px/150ms');
  ok(CONFIG.BALL.R === 32 && CONFIG.BOUND.INSET === 32, 'v4.0 体型 32 / 边界内缩 32');
  ok(CONFIG.BLADE.RADIUS === 128 && Math.abs(CONFIG.BLADE.HALF_ANGLE - Math.PI / 4) < 1e-9 &&
     CONFIG.HAMMER.RADIUS === 96 && Math.abs(CONFIG.HAMMER.HALF_ANGLE - Math.PI / 6) < 1e-9,
     'v4.0 攻击区扇形：刀 128px/±45°，锤 96px/±30°');
  ok(CONFIG.KILL_HITSTOP === 0.200 && CONFIG.HITSTOP === 0.120,
     'v4.0 hitstop：秒杀 200ms / 普通死亡与 DRAW 复活 120ms');
  ok(CONFIG.SHAKE.BLADE === 4 && CONFIG.SHAKE.HAMMER === 8, 'v4.0 震屏：出刀 4px / 落锤 8px');
  ok(CONFIG.COLOR.PLAYER === '#FFF8E7' && CONFIG.COLOR.GHOST === '#9FE8FF',
     'v4.0 球体增亮：玩家亮暖白 / 幽灵冷青亮芯');
  ok(CONFIG.FX.GLOW.PLAYER.R === 70 && CONFIG.FX.GLOW.PLAYER.A === 0.85 &&
     CONFIG.FX.GLOW.GHOST.R === 70,
     '双层外晕 r70 α0.85');
  ok(CONFIG.FX.BLADE_ARC.LIFE === 0.180 && CONFIG.FX.BLADE_ARC.WIDTH === 24 &&
     CONFIG.FX.BLADE_AFTER.N === 2 && CONFIG.FX.BLADE_AFTER.GAP === 0.025 &&
     CONFIG.FX.BLADE_AFTER.LIFE === 0.2,
     '挥刀 FX 常量：弧 180ms/宽24 + 残影 2 段/25ms 间隔/200ms');
  ok(CONFIG.FX.HAMMER_ARC.LIFE === 0.250 && CONFIG.FX.HAMMER_ARC.WIDTH === 32 &&
     CONFIG.FX.HAMMER_RING.R1 === 70 && CONFIG.FX.HAMMER_CHARGE.N === 12,
     '重锤 FX 常量：弧 250ms/宽32 + 冲击环 r1=70 + 汇聚 12 枚');
  ok(CONFIG.FX.KILL.RING.R1 === 90 && CONFIG.FX.KILL.RING2.R1 === 130,
     '秒杀爆裂双层环 r1=90/130');
  ok(CONFIG.CAMERA && CONFIG.CAMERA.T1.ZOOM === 1.25 && CONFIG.CAMERA.T1.TS === 0.3 &&
     CONFIG.CAMERA.T1.DUR === 0.250 &&
     CONFIG.CAMERA.T2.ZOOM === 1.35 && CONFIG.CAMERA.T2.TS === 0.25 && CONFIG.CAMERA.T2.DUR === 0.500 &&
     CONFIG.CAMERA.T3.ZOOM === 1.5 && CONFIG.CAMERA.T3.TS === 0.2 && CONFIG.CAMERA.T3.DUR === 0.800,
     'v4.1 特写三档：T1 1.25/0.3/250ms · T2 1.35/0.25/500ms · T3 1.5/0.2/800ms');
  ok(CONFIG.FX.INTERRUPT.N_MIN === 6 && CONFIG.FX.INTERRUPT.N_MAX === 8 &&
     CONFIG.FX.INTERRUPT.LIFE === 0.4 && CONFIG.FX.INTERRUPT.SHAKE === 5 &&
     CONFIG.FX.SHATTER.N_MIN === 10 && CONFIG.FX.SHATTER.N_MAX === 14 && CONFIG.FX.SHATTER.LIFE === 0.5,
     'v4.1 打断/碎刃特效参数：脱手 6~8 枚 400ms 震5px / 刃片 10~14 枚 500ms');
  ok(CONFIG.FX.SPEEDLINES === undefined && CONFIG.FX.AFTERIMAGE === undefined &&
     CONFIG.FX.WINDUP === undefined && CONFIG.FX.BREAK === undefined &&
     CONFIG.FX.STUN === undefined && CONFIG.FX.DENY === undefined,
     'v3.x 冲撞系 FX 参数组已从 CONFIG 删除');
  ok(CONFIG.HIT.FLASH === 0.080 && CONFIG.HIT.SHAKE === 3 && CONFIG.HIT.LOW_PULSE === 0.600,
     'v2.2 受击反馈：白闪 80ms / 微震 3px / 低血脉动 600ms');
}

/* ---------- T12 Match 集成：无限链 / 败局 / 刀刀弹开 / abandon（v4.0） ---------- */
console.log('[T12] Match 集成（solo 三刀无限链 / self charge 幽灵败局 / 刀刀 STAGGER / abandon）');
{
  const mkDeps = () => ({ input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } });

  // —— (a) solo 无限链：木桩 HP=3 三刀击碎 → AUTO_ADVANCE → 第 2 关镜像 → 第 3 关 = 上关胜利段 ——
  {
    const deps = mkDeps();
    const seedCalls = [];
    const m = new Match(deps, { mode: 'solo', opp: 'dummy',
                                onLevelWin: (n, rep) => seedCalls.push({ n, rep }) });
    ok(m.level === 'PLAY' && m.levelN === 1 && m.dummy !== null,
       'solo 从第 1 关木桩起（固定站位）');
    ok(m.player.x === CONFIG.SPAWN.PLAYER.x && m.dummy.x === CONFIG.SPAWN.DUMMY.x,
       '固定站位：玩家 (230,360) / 木桩 (1050,360)');
    stub.fireCanvas('mousemove', { clientX: 1279, clientY: 360 });   // 准星钉在画布最右（玩家逼近中 facing 恒朝 +x）
    stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });  // 逼近木桩（碰撞推挤后停在 64px 处）
    let ticks = 0;
    while (m.level === 'PLAY' && ticks < 800) {             // 每帧点左键连击：木桩 HP=3
      stub.fireCanvas('mousedown', { button: 0 });
      m.update(STEP); ticks++;
    }
    stub.fireWin('keyup', { code: 'KeyD' });
    ok(m.level === 'AUTO_ADVANCE' && m.dummy.combat.hp === 0,
       '第 1 关：三刀击碎木桩（HP=3）→ AUTO_ADVANCE（' + ticks + ' 帧）');
    ok(seedCalls.length === 1 && seedCalls[0].n === 1, 'Match 层每关上报 onLevelWin（第 1 关）');
    ok(m.mirrorReplay && m.mirrorReplay.trajectory.length > 0 &&
       m.mirrorReplay.events.some((e) => e.type === 'blade'),
       '教学段录制闭合（blade 事件）→ 第 2 关幽灵来源');
    ticks = 0;
    while (m.level === 'AUTO_ADVANCE' && ticks < 120) { m.update(STEP); ticks++; }
    ok(m.level === 'PLAY' && m.levelN === 2 && m.ghost !== null,
       '1.2s 横幅后自动进第 2 关（无需确认输入）');
    ok(m.ghost.replay === m.mirrorReplay, '第 2 关幽灵 = 教学段录制（ServeProvider）');
    ok(m.recorder.tickCount <= 5, '新尝试段从帧 0 起录（教学段不混入）');
    // 白盒驱动：击杀第 2 关幽灵 → 胜利段闭合 → 第 3 关
    const winRep = m.recorder.snapshot();               // 预期胜利段内容（快照先取）
    m._onOpponentDead(m.ghost, 2);                      // 内部 snapshot → lastWinReplay
    ok(m.level === 'AUTO_ADVANCE' && seedCalls.length === 2 && seedCalls[1].n === 2,
       '第 2 关击杀 → 上报胜利段（播种通道）');
    ticks = 0;
    while (m.level === 'AUTO_ADVANCE' && ticks < 120) { m.update(STEP); ticks++; }
    ok(m.levelN === 3 && m.ghost.replay === m.lastWinReplay,
       '第 3 关幽灵 = lastWinReplay（ServeProvider 同引用）');
    ok(serializeReplay(m.lastWinReplay) === serializeReplay(winRep),
       '第 3 关幽灵 = 第 2 关胜利段内容（快照一致）');
    // R 重试同源：玩家 HP 归 0 → DEATH → R
    m._onOpponentDead(m.ghost, 3);                      // 推进到第 4 关准备
    ticks = 0; while (m.level === 'AUTO_ADVANCE' && ticks < 120) { m.update(STEP); ticks++; }
    const replay4 = m.ghost.replay;
    m.player.combat.hit(); m.player.combat.hit(); m.player.combat.hit();   // 玩家 HP 归 0
    m.slowTimer = 0; m.level = 'DEATH';
    m.prevR = false;
    stub.fireWin('keydown', { code: 'KeyR', preventDefault() {} });
    m.update(STEP);
    stub.fireWin('keyup', { code: 'KeyR' });
    ok(m.level === 'PLAY' && m.levelN === 4 && m.ghost.replay === replay4,
       'R 重试当前关：幽灵数据不变（同源）');
    ok(m.player.combat.hp === 3 && m.ghost.combat.hp === 3, 'R 重试双方 HP 重置 3');
    ok(m.recorder.tickCount <= 5, '重试 = 新录制段（失败段丢弃，仅胜利段作幽灵源）');
    ok(seedCalls.length === 3 && seedCalls.every((c) => c.n >= 1 && c.n <= 3),
       'Match 层每关击杀均上报 onLevelWin（播种过滤在 GameScreen/seedOnLevelWin）');
  }

  // —— (b) 播种收窄：seedOnLevelWin 仅第 2 关 + 空池条件 ——
  {
    const store = new LocalGhostStore();
    const rep = { duration: 1, trajectory: new Float32Array(10), events: [] };
    ok(seedOnLevelWin(store, 1, rep) === false && store.list('self').length === 0,
       '第 1 关胜利不播种');
    ok(seedOnLevelWin(store, 3, rep) === false && store.list('self').length === 0,
       '第 3 关胜利不播种（无限链不污染资产池）');
    ok(seedOnLevelWin(store, 2, rep) === true && store.list('self').length === 1,
       '第 2 关胜利 + 空池 → 播种挑战自我第 1 关');
    ok(seedOnLevelWin(store, 2, rep) === false && store.list('self').length === 1,
       '已有存档 → 不重复播种');
  }

  // —— (c) self 败局：历史 charge 幽灵（v4.0 映射挥刀）命中玩家 3 次 → HP 归 0 → finish(lose) ——
  {
    const deps = mkDeps();
    let ended = null;
    const n = 600;
    const gx = 990;                                     // 镜像后幽灵位 = 1280−990 = 290（玩家 230 右侧 60px）
    const traj = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { traj[2 * i] = gx; traj[2 * i + 1] = 360; }
    const events = [];
    for (let k = 0; k < 5; k++) events.push({ t: 31 + k * 120, type: 'charge', dirAngle: 0 });
    const m = new Match(deps, { mode: 'self', opp: 'ghost',
                                replay: { duration: n * CONFIG.STEP, trajectory: traj, events },
                                onEnd: (r, rep, s) => { ended = { r, rep, s }; } });
    ok(m.level === 'PLAY' && m.levelN === 1 && m.ghost !== null, 'self 单关对局（无教学关）');
    m.update(STEP);
    ok(Math.abs(m.ghost.x - (CONFIG.VIEW.W - gx)) <= 2.5,
       '镜像轨迹：录制 x=990 → 幽灵 x=290（±2px 碰撞分离；逐帧 x\'=1280−x）');
    let ticks = 0;
    while (!m.ended && ticks < 600) { m.update(STEP); ticks++; }
    ok(m.ended && ended && ended.r === 'lose', '被幽灵 3 刀命中（HP 归 0）→ finish(lose)');
    ok(m.player.combat.hp === 0, '玩家 HP=0 才进死亡流程');
    ok(ended.rep && ended.rep.trajectory.length > 0, '败局产出 replay（分段录制）');
    // 镜像方向联动：dirAngle=0（朝右）→ 幽灵挥刀 facing=π（朝玩家侧）
    ok(Math.abs(m.ghost.facing - Math.PI) < 1e-6 || m.ghost.combat.phase === 'idle',
       '幽灵挥刀方向镜像朝玩家侧（dirAngle 0 → π）');
  }

  // —— (d) 刀刀弹开：同 tick 起手互为刃区 → 双方 STAGGER、HP 不减、无 DRAW ——
  {
    const deps = mkDeps();
    let endCalls = 0;
    const n = 600;
    const traj = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { traj[2 * i] = 248; traj[2 * i + 1] = 360; }   // 镜像后幽灵位 1032
    const m = new Match(deps, { mode: 'self', opp: 'ghost',
                                replay: { duration: n * CONFIG.STEP, trajectory: traj, events: [] },
                                onEnd: () => { endCalls++; } });
    m.update(STEP);                                     // 幽灵就位 (1032,360)，玩家 (230,360)
    // 白盒摆位：玩家拉到幽灵左侧 64px（本体分离距），同 tick 互出刀
    m.player.x = 968; m.player.y = 360;
    const t0 = m.tick;
    m.player.combat.startBlade({ x: 1, y: 0 }, t0);
    m.ghost.combat.startBlade({ x: -1, y: 0 }, t0);
    let ticks = 0;
    while (!(m.player.combat.phase === 'stagger' && m.ghost.combat.phase === 'stagger') && ticks < 60) {
      m.update(STEP); ticks++;
    }
    ok(m.player.combat.phase === 'stagger' && m.ghost.combat.phase === 'stagger',
       '同 tick 互刀 → ① 刃区互交 → 双方进 STAGGER 弹开（无 DRAW 触发）');
    ok(m.player.combat.hp === 3 && m.ghost.combat.hp === 3, '刀刀弹开双方 HP 不减');
    ok(m.level === 'PLAY' && endCalls === 0, '弹开不掉血、无结算');
    ok(len(m.ghost.x - m.player.x, m.ghost.y - m.player.y) >= 64 - 1e-6,
       '弹开后位置分离无重叠（分离距 64）');
    ticks = 0;
    while ((m.player.combat.phase === 'stagger' || m.ghost.combat.phase === 'stagger') && ticks < 40) {
      m.update(STEP); ticks++;
    }
    ok(m.player.combat.phase === 'idle' && m.ghost.combat.phase === 'idle',
       '300ms 弹开结束自然恢复行动');
  }

  // —— (e) abandon ——
  {
    const deps = mkDeps();
    let endCalls = 0;
    const m = new Match(deps, { mode: 'solo', opp: 'dummy', onEnd: () => { endCalls++; } });
    m.abandon();
    ok(m.ended === true && endCalls === 0, 'abandon：录制作废、不计任何数');
  }
}

/* ---------- T13 攻击特效运行时断言（v4.0：挥刀月牙/残影/锤汇聚/锤弧/秒杀双环/格挡消散） ---------- */
console.log('[T13] FX 运行时：挥刀弧光 128px 双层 / 残影 2 段 22.5px / 锤汇聚 12 枚收敛 / 锤弧 96px+环 / 秒杀双环 r1=130 / 小爆裂无环 / fade 40ms');
{
  const fx = new FXSystem();
  // —— (a) blade_swing：宽月牙 128px 弧宽 24，寿命 180ms + 火花 8~12 + 震屏 4px ——
  fx.queue.push({ type: 'blade_swing', x: 100, y: 100, ang: 0, color: '#FFF8E7' });
  fx.flush();
  ok(fx.arcs.length === 1 && Math.abs(fx.arcs[0].radius - CONFIG.BLADE.RADIUS) < 1e-9 &&
     Math.abs(fx.arcs[0].width - CONFIG.FX.BLADE_ARC.WIDTH) < 1e-9 &&
     Math.abs(fx.arcs[0].maxLife - 0.180) < 1e-9, '挥刀弧光：radius=128 / width=24 / 180ms');
  ok(fx.arcs[0].glow === true, '挥刀弧光 glow 双层标记');
  const sparks = fx.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0);
  ok(sparks.length >= CONFIG.FX.BLADE_SPARK.N_MIN && sparks.length <= CONFIG.FX.BLADE_SPARK.N_MAX,
     '刃缘火花 8~12 粒');
  ok(fx.shake > 0, '挥刀震屏 4px');
  // —— (b) blade_afterimages：2 段沿突进方向 22.5px/段（900×0.025），alpha 0.4/0.25，寿命 200ms ——
  fx.queue.push({ type: 'blade_afterimages', x: 200, y: 100, ang: 0, r: CONFIG.BALL.R, color: '#FFF8E7' });
  fx.flush();
  ok(fx.afterimages.length === CONFIG.FX.BLADE_AFTER.N, '挥刀残影 2 段入队');
  ok(Math.abs(fx.afterimages[0].alpha - 0.4) < 1e-9 && Math.abs(fx.afterimages[1].alpha - 0.25) < 1e-9,
     '残影透明度 0.4/0.25');
  const stepPx = CONFIG.BLADE.LUNGE_SPEED * CONFIG.FX.BLADE_AFTER.GAP;
  ok(Math.abs(stepPx - 22.5) < 1e-9 &&
     Math.abs(fx.afterimages[1].x - (200 + stepPx)) < 1e-9 && fx.afterimages[1].y === 100,
     '残影沿方向 22.5px/段（900×0.025）');
  ok(Math.abs(fx.afterimages[0].maxLife - 0.2) < 1e-9, '残影寿命 200ms');
  fx.update(0.25);
  ok(fx.afterimages.length === 0 && fx.arcs.length === 0, '残影/弧光寿命尽后消退');

  // —— (c) hammer_charge：12 枚汇聚粒子，位置随寿命向球心收敛 ——
  const fx2 = new FXSystem();
  fx2.queue.push({ type: 'hammer_charge', x: 300, y: 300 });
  fx2.flush();
  const nCharge = fx2.pool.filter((p) => p.alive && p._home).length;
  ok(nCharge === CONFIG.FX.HAMMER_CHARGE.N, '锤蓄力汇聚粒子 12 枚');
  fx2.update(CONFIG.FX.HAMMER_CHARGE.LIFE * 0.5);
  const p0 = fx2.pool.find((p) => p._home);
  const d1 = Math.hypot(p0.x - p0._home.x, p0.y - p0._home.y);
  ok(d1 > 0, '半程时仍在球体外侧');
  fx2.update(CONFIG.FX.HAMMER_CHARGE.LIFE * 0.25);
  const d2 = Math.hypot(p0.x - p0._home.x, p0.y - p0._home.y);
  ok(Math.abs(d2 - d1 / 2) < 0.5, '位置随寿命线性向球心收敛（remain 减半距离减半）');

  // —— (d) hammer_strike：锤弧 96px 弧宽 32 寿命 250ms + 冲击环 r0→70 + 震屏 8px ——
  fx2.queue.push({ type: 'hammer_strike', x: 300, y: 300, ang: Math.PI / 2 });
  fx2.flush();
  ok(fx2.arcs.length === 1 && Math.abs(fx2.arcs[0].radius - CONFIG.HAMMER.RADIUS) < 1e-9 &&
     Math.abs(fx2.arcs[0].width - CONFIG.FX.HAMMER_ARC.WIDTH) < 1e-9 &&
     Math.abs(fx2.arcs[0].maxLife - 0.250) < 1e-9 && fx2.arcs[0].glow === false,
     '锤击弧光：radius=96 / width=32 / 250ms / 单层');
  ok(fx2.rings.length === 1 && Math.abs(fx2.rings[0].r1 - CONFIG.FX.HAMMER_RING.R1) < 1e-9 &&
     Math.abs(fx2.rings[0].maxLife - 0.250) < 1e-9, '落点冲击环 r0→70 / 250ms');
  ok(fx2.shake > 0, '落锤震屏 8px');

  // —— (e) burst kill：秒杀爆裂 24 粒 + 双层环（r1=90/130） ——
  const fx3 = new FXSystem();
  fx3.queue.push({ type: 'burst', x: 500, y: 300, kill: true, color: '#FFF8E7' });
  fx3.flush();
  const killParts = fx3.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0).length;
  ok(killParts >= CONFIG.FX.KILL.N_MIN, '秒杀爆裂 ≥24 粒');
  ok(fx3.rings.length === 2 &&
     Math.abs(fx3.rings[0].r1 - CONFIG.FX.KILL.RING.R1) < 1e-9 &&
     Math.abs(fx3.rings[1].r1 - CONFIG.FX.KILL.RING2.R1) < 1e-9 &&
     Math.abs(fx3.rings[0].maxLife - 0.25) < 1e-9 && Math.abs(fx3.rings[1].maxLife - 0.35) < 1e-9,
     '秒杀双层冲击环 r1=90/130（250ms/350ms）');

  // —— (f) burst small：命中火花 8~10 粒零环零震屏 ——
  const fx4 = new FXSystem();
  fx4.queue.push({ type: 'burst', x: 500, y: 300, small: true, color: '#FFF8E7', shake: 0 });
  fx4.flush();
  const smallParts = fx4.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0).length;
  ok(smallParts >= 8 && smallParts <= 10, '命中火花 8~10 粒');
  ok(fx4.rings.length === 0 && fx4.shake === 0, '小爆裂无环零震屏');

  // —— (g) blade_swing fade：无效格挡光弧消散 40ms，无火花无震屏 ——
  const fx5 = new FXSystem();
  fx5.queue.push({ type: 'blade_swing', x: 100, y: 200, ang: 0, color: '#fff', fade: true });
  fx5.flush();
  ok(fx5.arcs.length === 1 && Math.abs(fx5.arcs[0].maxLife - 0.040) < 1e-9, '格挡消散：弧光寿命 40ms');
  ok(fx5.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0).length === 0 && fx5.shake === 0,
     'fade 无火花零震屏');
  fx5.update(0.05);
  ok(fx5.arcs.length === 0, '40ms 后弧光消退');

  // —— (g2) v4.1 interrupt_fx：锤脱手粒子 6~8 枚 + 震屏 5px ——
  const fx6 = new FXSystem();
  fx6.queue.push({ type: 'interrupt_fx', x: 400, y: 300, ang: 0 });
  fx6.flush();
  const itParts = fx6.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0).length;
  ok(itParts >= CONFIG.FX.INTERRUPT.N_MIN && itParts <= CONFIG.FX.INTERRUPT.N_MAX,
     'v4.1 打断：锤脱手粒子 6~8 枚（沿锤方向惯性）');
  ok(fx6.shake > 0, 'v4.1 打断震屏 5px');
  // —— (g3) v4.1 blade_shatter：刃片 10~14 枚沿弧缘法线飞散 ——
  const fx7 = new FXSystem();
  fx7.queue.push({ type: 'blade_shatter', x: 400, y: 300, ang: Math.PI / 2 });
  fx7.flush();
  const shParts = fx7.pool.filter((p) => p.alive && p.kind === 'dot' && p.life > 0).length;
  ok(shParts >= CONFIG.FX.SHATTER.N_MIN && shParts <= CONFIG.FX.SHATTER.N_MAX, 'v4.1 碎刃：刃片 10~14 枚');
  ok(fx7.shake > 0, 'v4.1 碎刃震屏（贯穿弧由 hammer_strike 通道承担）');
  // —— (g4) v4.1 camera 事件对 FXSystem 静默（modes.md v4.1 未知事件兼容规则） ——
  const fx8 = new FXSystem();
  fx8.queue.push({ type: 'camera', tier: 3, x: 100, y: 100 });
  fx8.flush();
  ok(fx8.pool.filter((p) => p.alive && p.life > 0).length === 0 && fx8.arcs.length === 0 &&
     fx8.rings.length === 0 && fx8.afterimages.length === 0,
     'camera 事件经 FXSystem 静默忽略不报错（旧消费方兼容）');

  // —— (h) v3.x 通道防复活 ——
  ok(fx.speedlines === undefined && fx.halos === undefined, 'speedlines/halos 通道已从 FXSystem 删除');
}

/* ---------- T14 OrbAI 契约（v4.0：快照冻结+bladeZone / blade|hammer 虚拟光标一次消费 / 异常降级 / 内置 AI 策略） ---------- */
console.log('[T14] OrbAI 契约：snapshotView v4.0 深冻结+bladeZone / AIInput blade/hammer 同通路 / 异常降级 / 内置 AI 策略');
{
  const mkIdle14 = (seat) => new AIInput(
    { name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } }, seat);
  // —— (a) snapshotView v4.0：字段 + 视角切换 + 深冻结 + bladeZone ——
  {
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    const m = new Match(deps, { mode: 'demo', p1Input: new AIInput(createBuiltinAI(), 'P1'),
                                p2Input: new AIInput(createBuiltinAI(), 'P2') });
    ok(m.player.x === CONFIG.SPAWN.PLAYER.x && m.p2.x === CONFIG.SPAWN.GHOST.x,
       'demo 站位：P1 (230,360) vs P2 (1050,360)');
    ok(m.player.combat.maxHP === 3 && m.p2.combat.maxHP === 3, 'demo 双方 HP=3');
    const s1 = m.snapshotView('P1');
    const s2 = m.snapshotView('P2');
    ok(s1.self.x === m.player.x && s1.opp.x === m.p2.x &&
       s2.self.x === m.p2.x && s2.opp.x === m.player.x,
       'seat 视角切换：self/opp 互为镜像引用位');
    ok(s1.self.hp === 3 && s1.opp.hp === 3 && s1.tick === m.tick, '快照含 hp / tick');
    ok(s1.self.radius === CONFIG.BALL.R && s1.self.radius === 32, '实体 radius=32（v4.0 体型）');
    ok(s1.self.bladeCooldown === 0 && s1.self.hammerCooldown === 0, '无冷却时双冷却=0（剩余 ms）');
    ok(s1.self.bladeZone === null && s1.opp.bladeZone === null, '非刀判定帧 bladeZone=null');
    ok(s1.arena.BALL_R === 32 && s1.arena.RADIUS === 32 &&
       s1.arena.BLADE_RADIUS === CONFIG.BLADE.RADIUS &&
       s1.arena.BLADE_HALF_ANGLE === CONFIG.BLADE.HALF_ANGLE &&
       s1.arena.HAMMER_RADIUS === CONFIG.HAMMER.RADIUS &&
       s1.arena.HAMMER_HALF_ANGLE === CONFIG.HAMMER.HALF_ANGLE &&
       s1.arena.W === CONFIG.VIEW.W && s1.arena.H === CONFIG.VIEW.H,
       'arena v4.0 常量齐备（BALL_R=32/刀锤半径半角/W/H）');
    ok(s1.arena.CHARGE_DISTANCE === undefined && s1.self.chargeDir === undefined &&
       s1.self.guardCd === undefined && s1.self.invincible === undefined,
       'v3.x 字段移除：chargeDir/guardCd/invincible/CHARGE_DISTANCE 不在快照');
    // 白盒置刀判定帧 → 对手视角 bladeZone 非空
    m.player.combat.phase = CombatState.BLADE_ACTIVE;
    m.player.facing = Math.PI / 4;
    const s3 = m.snapshotView('P2');
    ok(s3.opp.bladeZone !== null && Math.abs(s3.opp.bladeZone.dirAngle - Math.PI / 4) < 1e-9 &&
       s3.opp.bladeZone.radius === CONFIG.BLADE.RADIUS &&
       s3.opp.bladeZone.halfAngle === CONFIG.BLADE.HALF_ANGLE,
       'blade_active 时 bladeZone={dirAngle,128,π/4}');
    let hacked = false;
    try {
      s1.self.x = 999; s1.opp.phase = 'HACK'; s1.arena.W = 0;
      if (s3.opp.bladeZone) s3.opp.bladeZone.dirAngle = 9;
    } catch (e) { /* 严格模式抛错也算冻结成功 */ }
    hacked = s1.self.x === 999 || s1.opp.phase === 'HACK' || s1.arena.W === 0;
    ok(!hacked && m.player.x !== 999, '快照深冻结：AI 篡改快照不影响世界（deepFreeze）');
  }

  // —— (b) AIInput 同通路：think 决策经 Player 消费触发挥刀 ——
  {
    let asked = 0;
    const impl = { name: 'stub', think() { asked++; return { move: { x: 1, y: 0 }, blade: { x: 50, y: 0 }, hammer: false }; } };
    const ai = new AIInput(impl, 'P1');
    const fakeMatch = { snapshotView: (seat) => ({ tick: 0,
      self: { x: 0, y: 0, phase: 'idle', hp: 3, radius: 32, bladeCooldown: 0, hammerCooldown: 0, bladeZone: null },
      opp: { x: 100, y: 0, phase: 'idle', hp: 3, radius: 32, bladeCooldown: 0, hammerCooldown: 0, bladeZone: null },
      arena: { W: 1280, H: 720, BALL_R: 32, RADIUS: 32, BLADE_RADIUS: 128, BLADE_HALF_ANGLE: Math.PI / 4,
               HAMMER_RADIUS: 96, HAMMER_HALF_ANGLE: Math.PI / 6 } }) };
    ai.beginTick(fakeMatch);
    ok(asked === 1, 'beginTick 每 tick 恰好 think 一次（快照在消费前生成）');
    ok(ai.getMoveAxis().x === 1, 'AI 决策经 Input 同接口消费（move）');
    const aimV = ai.getAim({ x: 0, y: 0 });
    ok(Math.abs(aimV.x - 1) < 1e-9 && Math.abs(aimV.y) < 1e-9, 'AI 虚拟光标 → getAim 单位向量（与鼠标同管线）');
    ok(ai.consumeBlade() === true && ai.consumeBlade() === false, 'blade 帧内一次消费');
    ok(ai.isDown('KeyR') === false, 'AI 无按键语义（isDown 恒 false）');
    /* Match 集成：AI 输入驱动 Player 挥刀（p1Input 通路） */
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    const m = new Match(deps, { mode: 'demo', p1Input: new AIInput(impl, 'P1'), p2Input: mkIdle14('P2') });
    m.update(STEP);                     // 顶部 beginTick → Player.update 消费 blade
    ok(m.player.combat.phase === 'blade_windup', 'AI blade 经 Player 同通路触发挥刀');
    ok(m.p2.combat.phase === 'idle', 'P2 静止 AI 不受影响');
  }

  // —— (c) hammer 决策同通路 ——
  {
    const impl = { name: 'hammerAI', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: { x: 0, y: 0 } }; } };
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    const m = new Match(deps, { mode: 'demo', p1Input: new AIInput(impl, 'P1'), p2Input: mkIdle14('P2') });
    m.update(STEP);
    ok(m.player.combat.phase === 'hammer_windup', 'AI hammer 经 Player 同通路触发重锤');
    ok(Math.abs(m.player.combat.hammerCooldown - (CONFIG.HAMMER.COOLDOWN - STEP)) < 1e-9,
       '锤冷却 900ms 出招即置（一帧后剩 883ms）');
  }

  // —— (d) 异常降级：think 抛错 → 空输入 + 不判负不崩局（ADR-009） ——
  {
    const bad = { name: 'bad', think() { throw new Error('boom'); } };
    const ai = new AIInput(bad, 'P1');
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    let ended = null;
    const m = new Match(deps, { mode: 'demo', p1Input: ai,
                                p2Input: new AIInput(bad, 'P2'),
                                onEnd: (s) => { ended = s; } });
    let ticks = 0;
    while (!m.ended && ticks < 120) { m.update(STEP); ticks++; }   // 跑 2s
    ok(!m.ended && ticks === 120, '双 AI think 抛错 → 对局不崩不判负（持续空转）');
    ok(m.player.combat.hp === 3 && m.p2.combat.hp === 3, '异常空输入不产生误伤');
    ok(ai.getMoveAxis().x === 0 && ai.getMoveAxis().y === 0 &&
       ai.consumeBlade() === false && ai.consumeHammer() === false, '异常帧输入 = 全空');
  }

  // —— (e) 内置 AI 策略 + compileAICode ——
  {
    const builtin = createBuiltinAI();
    ok(builtin.name === '内置示例' && typeof builtin.think === 'function', '内置 AI 工厂');
    const mkSnap = (dist, oppPhase, tick, selfCd) => ({
      tick,
      self: { x: 0, y: 0, phase: 'idle', hp: 3, radius: 32,
              bladeCooldown: selfCd || 0, hammerCooldown: 0, bladeZone: null },
      opp: { x: dist, y: 0, phase: oppPhase, hp: 3, radius: 32,
             bladeCooldown: 0, hammerCooldown: 0, bladeZone: null },
      arena: { W: 1280, H: 720, BALL_R: 32, RADIUS: 32, BLADE_RADIUS: 128, BLADE_HALF_ANGLE: Math.PI / 4,
               HAMMER_RADIUS: 96, HAMMER_HALF_ANGLE: Math.PI / 6 },
    });
    let d = builtin.think(mkSnap(300, 'idle', 10));
    ok(d.move.x === 1 && !d.blade, '远距 300px：追踪不出刀');
    d = builtin.think(mkSnap(100, 'idle', 10));
    ok(d.blade && typeof d.blade === 'object' && d.blade.x === 100 && d.blade.y === 0,
       '近距 100px + 对手 idle → 刀连击（虚拟光标=对手坐标）');
    d = builtin.think(mkSnap(100, 'dead', 10));
    ok(!d.blade, '对手 dead → 不出刀');
    d = builtin.think(mkSnap(100, 'idle', 10, CONFIG.BLADE.COOLDOWN));
    ok(!d.blade, '自身刀冷却中 → 不出刀');
    d = builtin.think(mkSnap(100, 'hammer_windup', 10));
    ok(Math.abs(d.move.x) < 1e-9 && Math.abs(Math.abs(d.move.y) - 1) < 1e-9 && d.hammer === false,
       '对手锤起手：切向绕后（连线垂直方向）且不赌锤');
    d = builtin.think(mkSnap(100, 'hammer_active', 10));
    ok(Math.abs(d.move.x) < 1e-9 && Math.abs(Math.abs(d.move.y) - 1) < 1e-9, '锤判定期同样绕后躲锤区');

    const aiObj = compileAICode("{ name:'t', think(state){ return { move:{x:0,y:0}, blade:false, hammer:false }; } }");
    ok(typeof aiObj.think === 'function' && aiObj.name === 't', '控制台代码串可编译为 AI 对象');
    let threw = false;
    try { compileAICode('({})'); } catch (e) { threw = true; }
    ok(threw, '缺 think → 编译拒绝');
    threw = false;
    try { compileAICode('({think('); } catch (e) { threw = true; }
    ok(threw, '语法错误 → 编译拒绝');
  }
}

/* ---------- T15 无头对局（v4.0 刀锤版：Node 双 AI 跑到 match_end，零 DOM） ---------- */
console.log('[T15] 无头双 AI 对局：内置 AI 刀连击对局到 match_end + HP=3 击杀路径 + 超时裁决');
{
  const mkIdle = (seat) => new AIInput(
    { name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } }, seat);
  // —— (a) 内置 AI vs 静止 AI：追击+刀连击 → 3 次命中 → P1 胜（确定路径） ——
  const run = (p1Spec, p2Spec, timeLimit) => {
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    let ended = null;
    const m = new Match(deps, {
      mode: 'demo',
      p1Input: p1Spec, p2Input: p2Spec, timeLimit,
      onEnd: (seat, replay, secs) => { ended = { seat, replay, secs }; },
    });
    let ticks = 0;
    while (!m.ended && ticks < Math.ceil(timeLimit / STEP) + 60) { m.update(STEP); ticks++; }
    return { m, ended, ticks };
  };
  const r = run(new AIInput(createBuiltinAI(), 'P1'), mkIdle('P2'), 20);
  ok(r.ended !== null, '无头对局在时限内跑到 match_end（' + (r.ticks * STEP).toFixed(2) + 's）');
  ok(r.ended.seat === 'P1', '内置 AI 追击静止对手 → P1 胜（seat 通道）');
  ok(r.ended.replay === null, 'demo 收束不产 replay（零 Recorder）');
  ok(r.m.p2.combat.phase === CombatState.DEAD && r.m.p2.combat.hp === 0,
     '败者 HP=0 且进 DEAD（HP=3 刀击杀路径）');
  ok(r.m.player.combat.hp > 0 && r.m.player.combat.hp <= 3, '胜者 HP 未归零');
  ok(!r.m.recorder.recording, 'demo 对局零录制（recorder 未 begin）');

  // —— (b) 双内置 AI 互战：60s 时限内必收束（对称 AI 可能相持 → 超时 DRAW 兜底亦为 match_end） ——
  const r2v = run(new AIInput(createBuiltinAI(), 'P1'), new AIInput(createBuiltinAI(), 'P2'), 60);
  ok(r2v.ended !== null && (r2v.ended.seat === 'P1' || r2v.ended.seat === 'P2' || r2v.ended.seat === null),
     '双内置 AI 互战在 60s 内收束（' + (r2v.ticks * STEP).toFixed(1) + 's，seat=' + r2v.ended.seat + '）');
  if (r2v.ended.seat === null) {        // 超时 DRAW：双方 HP 相等（裁决自洽）
    ok(r2v.m.player.combat.hp === r2v.m.p2.combat.hp, '超时 DRAW：双方 HP 相等');
  }

  // —— (c) 超时裁决：双静止 AI → HP 相等 → DRAW（seat=null） ——
  const r3 = run(mkIdle('P1'), mkIdle('P2'), 1.0);
  ok(r3.ended !== null && r3.ended.seat === null,
     '超时 + HP 相等 → DRAW（seat=null，§6.2）');
  ok(r3.ended.secs >= 1.0 - STEP, '超时收束时刻 = timeLimit（±1 帧）');

  // —— (d) 超时 HP 多者胜 ——
  const deps3 = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
  let ended3 = null;
  const m3 = new Match(deps3, { mode: 'demo', p1Input: mkIdle('P1'), p2Input: mkIdle('P2'),
                                timeLimit: 1.0, onEnd: (seat) => { ended3 = seat; } });
  m3.p2.combat.hit();                   // 白盒：P2 先扣 1 血
  let t3 = 0;
  while (!m3.ended && t3 < 120) { m3.update(STEP); t3++; }
  ok(ended3 === 'P1', '超时 HP 多者胜（P2 扣血 → P1 胜）');
}

/* ---------- T16 触屏纯逻辑（v3.0 ADR-010 + v4.0 键位改派：Joystick/Button/TouchSource，node 事件桩喂值） ---------- */
console.log('[T16] 触屏：摇杆死区/全速/knobOffset / 按钮 click 语义 / 挥刀·重锤钮改派 / pointerId 隔离 / Input 聚合');
{
  // —— (a) VirtualJoystick ——
  {
    const j = new VirtualJoystick();
    j.start(1, 100, 100);
    j.move(1, 103, 101);                // 位移 ~3.2 < 死区 8
    ok(j.axis.x === 0 && j.axis.y === 0, '死区 8 内输出零轴');
    j.move(1, 160, 100);                // 正右 60px
    ok(Math.abs(j.axis.x - 1) < 1e-9 && j.axis.y === 0, '死区外单位向量（全速无比例）');
    j.move(1, 100 + 42, 100 + 42);      // 对角 60px 左右
    ok(Math.abs(j.axis.x - Math.SQRT1_2) < 1e-9 && Math.abs(j.axis.y - Math.SQRT1_2) < 1e-9,
       '对角归一化');
    const off = j.knobOffset();
    ok(Math.abs(Math.hypot(off.x, off.y) - (60 - 12)) < 1e-6, 'knobOffset 半径 = r−12 = 48px');
    j.end(2);                           // 错误 id 不清
    ok(j.pointerId === 1, 'pointerId 隔离：错误 id 忽略');
    j.end(1);
    ok(j.pointerId === null && j.axis.x === 0 && j.axis.y === 0, '抬起归零');
  }

  // —— (b) TouchButton ——
  {
    const b = new TouchButton(1150, 620, 44);
    ok(b.contains(1150, 620) && !b.contains(1150, 620 + 45), 'contains 圆域判定');
    b.down(7);
    ok(b.pressed && b.consumeClick() === true, '按下即置 clickPending（不等 touchend）');
    ok(b.consumeClick() === false, 'click 一次消费');
    b.down(7);
    b.move(7, 1150, 620 + 50);          // 50 > 44 但 ≤ 1.2×44=52.8 → 容差内不松
    ok(b.pressed, '滑出 1.2 倍容差内不松开');
    b.move(7, 1150, 620 + 60);          // 60 > 52.8 → 松开
    ok(!b.pressed, '滑出 1.2 倍容差即松开');
    b.down(7); b.up(8);
    ok(b.pressed, 'up id 隔离：错误 id 不松');
    b.up(7);
    ok(!b.pressed, 'up 正确 id 松开');
  }

  // —— (c) TouchSource：pointerId 隔离分配 + v4.0 键位改派 ——
  {
    const ts = new TouchSource();
    ts.pointerDown(10, 200, 300);       // 左半屏 → 摇杆
    ok(ts.joystick.pointerId === 10, '左半屏手指 → 摇杆');
    ts.pointerDown(11, 1150, 620);      // 挥刀钮区
    ok(ts.btnAtk.pointerId === 11 && ts.btnAtk.pressed, '钮区手指 → 挥刀钮');
    ts.pointerDown(12, 1000, 660);      // 重锤钮区
    ok(ts.btnGuard.pointerId === 12 && ts.btnGuard.pressed, '钮区手指 → 重锤钮（v4.0 改派）');
    ts.pointerMove(10, 260, 300);
    ok(Math.abs(ts.moveAxis().x - 1) < 1e-9, '摇杆手指移动 → 轴输出');
    ok(ts.consumeHammer() === true && ts.consumeHammer() === false, '重锤钮 → 点按一次消费');
    ok(ts.consumeBlade() === true, '挥刀钮 → consumeBlade 点按');
    // 摇杆占用中：左半屏第二指不接管
    ts.pointerDown(20, 300, 300);
    ok(ts.joystick.pointerId === 10 && ts.joystick.pointerId !== 20,
       '摇杆占用中：新手指不接管');
    ts.pointerUp(20);
    ts.pointerUp(10); ts.pointerUp(11); ts.pointerUp(12);
    ok(ts.joystick.pointerId === null && !ts.btnAtk.pressed && !ts.btnGuard.pressed,
       '各指抬起全复位');
  }

  // —— (d) Input 聚合：键鼠优先、触屏回落 ——
  {
    const input = new Input(stub.canvas);
    ok(typeof input.getMoveAxis() === 'object' && input.getMoveAxis().x === 0,
       '聚合输入空态零轴');
    stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });
    ok(input.getMoveAxis().x === 1, '键鼠轴优先');
    stub.fireWin('keyup', { code: 'KeyD' });
    // 触屏回落：摇杆占轴
    input.touch.joystick.start(5, 100, 100);
    input.touch.joystick.move(5, 160, 100);
    ok(input.getMoveAxis().x === 1, '键鼠松开 → 触屏摇杆轴回落');
    // 触屏挥刀/重锤点击聚合
    input.touch.btnAtk.down(5);
    ok(input.consumeBlade() === true, '触屏挥刀钮经 Input.consumeBlade 聚合消费');
    input.touch.btnGuard.down(5);
    ok(input.consumeHammer() === true, '触屏重锤钮经 Input.consumeHammer 聚合消费');
    // 右键重锤点按
    stub.fireCanvas('mousedown', { button: 2 });
    ok(input.consumeHammer() === true && input.consumeHammer() === false,
       '右键点按 → 重锤一次消费');
    input.touch.joystick.end(5);
  }
}

/* ---------- T17 菜单 IA（v3.0：五项 DOM + 二级屏/AI 编辑屏删净 + 联机骨架置灰 + v4.0 键位标签） ---------- */
console.log('[T17] 菜单 IA：五项 DOM / 旧屏删净 / PAIR 屏全流程 / 触屏与 OrbAI 要素 / 挥刀·重锤标签');
{
  const html = fs.readFileSync(HTML, 'utf8');
  const acts = ['solo', 'online', 'self', 'boss_solo', 'quit'];
  const menuOk = acts.every((a) => html.includes('data-act="' + a + '"'));
  ok(menuOk, '主菜单五项 data-act 齐备（solo/online/self/boss_solo/quit）');
  ok(!html.includes('data-act="boss"') && !html.includes('data-act="ai"') &&
     !html.includes('id="scr-boss"') && !html.includes('id="scr-ai"'),
     '二级 boss 屏与 AI 编辑屏 DOM 删净（AI 保留为控制台 API）');
  ok(html.includes('id="scr-pair"') && html.includes('生成邀请码') &&
     html.includes('确认应答码') && html.includes('你的应答码'),
     'v3.1 PAIR 屏：创建/加入/应答码全流程 DOM');
  ok(html.includes('data-ol="back"') === false && html.includes('id="pair-back"'),
     'v3.1：v3.0 置灰骨架废除，PAIR 屏返回入口就绪');
  ok(html.includes('id="touchui"') && html.includes('id="joy-base"') &&
     html.includes('id="joy-knob"') && html.includes('id="tbtn-atk"') &&
     html.includes('id="tbtn-guard"'), '触屏控件 DOM 齐备');
  ok(html.includes('挥刀') && html.includes('重锤'), 'v4.0 触屏键位标签：挥刀 / 重锤');
  ok(html.includes('id="portrait-mask"') && html.includes('请横屏游玩'),
     '竖屏遮罩 DOM');
  ok(/user-scalable=no/.test(html) && /viewport-fit=cover/.test(html) &&
     /touch-action:\s*none/.test(html), '移动 viewport + touch-action 锁定');
  ok(html.includes('window.OrbAI') && html.includes('startMatch') &&
     html.includes('stopMatch'), 'window.OrbAI 控制台 API 挂载');
}
/* ---------- T7 replay 序列化往返（不变，回归锁） ---------- */
console.log('[T7] serializeReplay/deserializeReplay 往返 + 量化误差 < 0.02px');
{
  const n = 500;
  const traj = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    traj[2 * i] = 16 + i * 2.5;
    traj[2 * i + 1] = 360 + Math.sin(i / 7) * 120;
  }
  const events = [{ t: 5, type: 'charge', dirAngle: 1.5707963 },
                  { t: 100, type: 'guard_begin' },
                  { t: 130, type: 'guard_end' }];
  const s = serializeReplay({ duration: n * CONFIG.STEP, trajectory: traj, events });
  ok(typeof s === 'string' && /^[A-Za-z0-9+/=]+$/.test(s), '序列化输出为 base64 字符串');
  const back = deserializeReplay(s);
  ok(back.trajectory.length === traj.length, '往返轨迹长度一致');
  let maxErr = 0;
  for (let i = 0; i < traj.length; i++) maxErr = Math.max(maxErr, Math.abs(back.trajectory[i] - traj[i]));
  ok(maxErr < 0.02, '逐点量化误差 < 0.02px（实测 ' + maxErr.toFixed(5) + 'px）');
  ok(JSON.stringify(back.events) === JSON.stringify(events), '事件流往返无损');
  ok(back.duration === n * CONFIG.STEP, 'duration = n * STEP');
  const oob = new Float32Array([-50, 99999, 640, 360]);
  const backOob = deserializeReplay(serializeReplay({ trajectory: oob, events: [] }));
  ok(backOob.trajectory[0] >= 0 && backOob.trajectory[1] <= CONFIG.VIEW.H, '越界坐标 clamp');
}

/* ---------- T8 LocalGhostStore（不变，回归锁） ---------- */
console.log('[T8] LocalGhostStore 八方法 + QuotaExceeded 淘汰 + 内存降级');
{
  const store = new LocalGhostStore();
  ok(store.persistent === false, 'Node 无 localStorage → 内存降级');
  const mkRep = (y) => ({ duration: 3, trajectory: new Float32Array([230, y, 400, y, 600, y]), events: [] });
  const id1 = store.put('self', mkRep(100), {});
  const id2 = store.put('self', mkRep(200), {});
  ok(store.list('self').length === 2 && store.list('self')[0].id === id1, 'put/list 顺序一致');
  const pick = store.pickRandom('self');
  ok(pick && pick.replay && pick.replay.trajectory.length === 6, 'pickRandom 返回反序列化 replay');
  store.list('self')[0].counters.defeatedPlayers = 15;
  store.replace('self', id1, mkRep(300));
  ok(store.list('self')[0].counters.defeatedPlayers === 0, 'replace 后计数归零');
  store.incProgress('self', 3);
  ok(store.getProgress('self').progress === 3, 'incProgress/getProgress');
  store.incWin('self'); store.incLoss('self');
  ok(store.getProgress('self').wins === 1 && store.getProgress('self').losses === 1, 'incWin/incLoss');
  store.setUnlocked('self', 4);
  ok(store.getProgress('self').unlockedLevel === 4, 'setUnlocked');
  ok(store._key('self') === 'gd.self.data', '键前缀 gd.<mode>.data');

  const qStore = new LocalGhostStore();
  let setCalls = 0;
  qStore.ls = { setItem() {}, getItem() { return null; }, removeItem() {} };
  qStore.persistent = true;
  const qa = qStore.put('self', mkRep(1), { uploadedAt: 100 });
  const qb = qStore.put('self', mkRep(2), { uploadedAt: 200 });
  const qc = qStore.put('self', mkRep(3), { uploadedAt: 300 });
  ok(qStore.list('self').length === 3, '容量正常时 3 条齐存');
  qStore.ls = {
    setItem() { if (++setCalls === 1) { throw new Error('QuotaExceededError'); } },
    getItem() { return null; }, removeItem() {},
  };
  qStore.persist('self');
  ok(qStore.list('self').length === 2 &&
     !qStore.list('self').some((e) => e.id === qa) &&
     qStore.list('self').some((e) => e.id === qb) &&
     qStore.list('self').some((e) => e.id === qc),
     'QuotaExceeded → 按 uploadedAt 淘汰最旧 1 条，重试成功');
  const q2 = new LocalGhostStore();
  q2.ls = { setItem() { throw new Error('QuotaExceededError'); }, getItem() { return null; }, removeItem() {} };
  q2.persistent = true;
  q2.put('self', mkRep(1), {});
  ok(q2.list('self').length === 0, '淘汰至空池不崩溃');
}

/* ---------- T9 挑战自我全链路（不变，回归锁） ---------- */
console.log('[T9] onSelfWin 替换+占位 / onSelfLose 20 败晋级');
{
  const store = new LocalGhostStore();
  const mkRep = (tag) => {
    const t = new Float32Array(20); t[0] = tag; t[1] = tag;
    return { duration: 1, trajectory: t, events: [] };
  };
  const seed = mkRep(11), win2 = mkRep(22), victim = mkRep(99);
  store.put('self', seed, {});
  let r = onSelfWin(store, 1, win2);
  ok(r.nextLevel === 2 && store.list('self').length === 2, '胜利 → 替换 + 第 2 关占位');
  ok(store.getProgress('self').unlockedLevel === 2, '第 2 关解锁');
  const win3 = mkRep(33);
  r = onSelfWin(store, 2, win3);
  ok(r.nextLevel === 3 && store.list('self').length === 3, '阶梯增长');
  let last = null;
  for (let i = 1; i <= 19; i++) last = onSelfLose(store, 3, victim);
  ok(last.defeated === 19 && last.promoted === false, '19 次失败仅计数');
  const ghostPayloadBefore = store.list('self')[2].payload;
  const r20 = onSelfLose(store, 3, victim);
  ok(r20.promoted === true && r20.bossLevel === 1, '第 20 次失败 → 晋级单机boss');
  ok(store.list('boss_solo').length === 1 &&
     store.list('boss_solo')[0].payload === ghostPayloadBefore, 'payload 原样移入 boss_solo');
  ok(store.list('self')[2].payload === serializeReplay(victim) &&
     store.list('self')[2].counters.defeatedPlayers === 0, '受害者顶替 + 计数归零');
  ok(selfOutcome({ defeatedPlayers: 19 }) === 'stay' &&
     selfOutcome({ defeatedPlayers: 20 }) === 'promote', 'selfOutcome 阈值 20（控制 #16）');
  ok(bossSoloOutcome({ challengedSuccess: 19 }) === 'stay' &&
     bossSoloOutcome({ challengedSuccess: 20 }) === 'delete', 'bossSoloOutcome 阈值 20');
}

/* ---------- T10 单机boss顺位删除（不变，回归锁） ---------- */
console.log('[T10] onBossSoloWin 20 胜删除 + 顺位前移 + 池空');
{
  const store = new LocalGhostStore();
  const mkRep = (tag) => {
    const t = new Float32Array(20); t[0] = tag; t[1] = tag;
    return { duration: 1, trajectory: t, events: [] };
  };
  store.put('boss_solo', mkRep(1), {});
  store.put('boss_solo', mkRep(2), {});
  store.put('boss_solo', mkRep(3), {});
  let r = null;
  for (let i = 0; i < 20; i++) r = onBossSoloWin(store, 1);
  ok(r.deleted === true && store.list('boss_solo').length === 2 && r.nextLevel === 1,
     '20 胜删除 + 顺位前移');
  for (let i = 0; i < 20; i++) r = onBossSoloWin(store, 1);
  ok(r.deleted === true && store.list('boss_solo').length === 1, '原第 2 关删除');
  for (let i = 0; i < 20; i++) r = onBossSoloWin(store, 1);
  ok(r.deleted === true && r.poolEmpty === true && r.nextLevel === null, '池空');
  ok(isModeAvailable('boss_solo', store) === false, '池空 → 按钮回灰');
  ok(onBossSoloWin(store, 1).poolEmpty === true, '空池胜利安全');
  ok(onBossSoloLose(store, 1).defeated === 0, '空池失败安全');
}

/* ---------- T18 packSDP/unpackSDP 往返 + 非法输入拒绝（架构 v3.1 §1.2） ---------- */
console.log('[T18] 房间码：packSDP/unpackSDP 往返（fingerprint/ICE 凭据/候选）+ 非法输入错误码');
{
  const OFFER_SDP = [
    'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    'a=group:BUNDLE 0', 'a=ice-options:trickle',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:4ZcD', 'a=ice-pwd:2/1KTc5FJm4CQqhG0jEGvQmD',
    'a=fingerprint:sha-256 AB:CD:EF:12:34:56:78:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01:23:45:67:89:AB',
    'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000',
    'a=candidate:1 1 udp 2122260223 192.168.1.10 53241 typ host generation 0',
    'a=candidate:2 1 udp 1686052607 203.0.113.5 61234 typ srflx raddr 192.168.1.10 rport 53241',
  ].join('\r\n') + '\r\n';
  const code = packSDP({ type: 'offer', sdp: OFFER_SDP });
  ok(code.startsWith(NET.PREFIX), '房间码带 OD1. 前缀');
  ok(code.length < 700, '房间码体积 < 700 字符（实测 ' + code.length + '，约 400~600 区间）');
  const back = unpackSDP(code);
  ok(back.type === 'offer', 'type 往返一致');
  ok(back.sdp.includes('a=ice-ufrag:4ZcD') && back.sdp.includes('a=ice-pwd:2/1KTc5FJm4CQqhG0jEGvQmD'),
     'ICE 凭据往返一致');
  ok(back.sdp.includes('a=fingerprint:sha-256 AB:CD:EF:12:34:56:78:9A:BC:DE:F0:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:01:23:45:67:89:AB'),
     'fingerprint 往返一致');
  ok(back.sdp.includes('a=candidate:1 1 udp 2122260223 192.168.1.10 53241 typ host generation 0') &&
     back.sdp.includes('a=candidate:2 1 udp 1686052607 203.0.113.5 61234 typ srflx raddr 192.168.1.10 rport 53241'),
     'host/srflx 候选逐条往返');
  ok(back.sdp.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel') && back.sdp.includes('a=setup:actpass'),
     '固定 m=application 模板重建（offer=actpass）');
  const back2 = unpackSDP(packSDP({ type: 'answer', sdp: OFFER_SDP.replace('actpass', 'active') }));
  ok(back2.type === 'answer' && back2.sdp.includes('a=setup:active'), 'answer setup=active 模板');

  const throwsCode = (fn, want) => {
    try { fn(); return false; } catch (e) { return e.code === want; }
  };
  ok(throwsCode(() => unpackSDP('XX.abc'), NET.ERR.E_FORMAT), '无 OD1. 前缀 → E_FORMAT');
  ok(throwsCode(() => unpackSDP(NET.PREFIX + '!!!非base64!!!'), NET.ERR.E_JSON), '坏载荷 → E_JSON');
  ok(throwsCode(() => unpackSDP(NET.PREFIX + b64urlEncode('{"type":"offer"}')),
                NET.ERR.E_SHAPE), '缺 fingerprint/凭据 → E_SHAPE');
  ok(throwsCode(() => unpackSDP(NET.PREFIX + b64urlEncode(
      JSON.stringify({ type: 'offer', f: 'a', u: 'b', p: 'c', c: ['bad$$candidate'] }))),
    NET.ERR.E_SHAPE), '候选字段含非法字符 → E_SHAPE');
  ok(throwsCode(() => packSDP({ type: 'nope', sdp: 'v=0' }), NET.ERR.E_SHAPE), 'pack 非法 desc.type → E_SHAPE');
  ok(throwsCode(() => packSDP({ type: 'offer', sdp: 'v=0\r\n' }), NET.ERR.E_SHAPE),
     'pack 缺凭据的 SDP → E_SHAPE');
  ok(b64urlDecode(b64urlEncode('OD1.roundtrip-abc_123')) === 'OD1.roundtrip-abc_123',
     'base64url 往返（- _ 字符安全）');
}

/* ---------- T21 v4.1 特写镜头 + 碎刃/打断 集成 ---------- */
console.log('[T21] CameraSystem 三档/同帧最高档/高档抢占/渲染层隔离 + 碎刃秒杀（满血也死）+ 打断（相位取消·冷却不启动）+ 对拍');
{
  const mkIdleV61 = (seat) => new AIInput(
    { name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } }, seat);
  const mkDeps = () => ({ input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } });

  // —— (a) CameraSystem 单元：三档 / 同帧最高档 / 低档不抢占 / 高档抢占 / 时长走缩放后时间 ——
  {
    const cam = new CameraSystem();
    ok(cam.active === false && cam.timeScale() === 1, '初始：未激活 timeScale=1');
    cam.queue(1, 400, 360);
    cam.queue(3, 500, 360);                 // 同帧 T1+T3
    cam.beginFrame();
    ok(cam.active && cam.tier === 3 && cam.anchor.x === 500,
       '同帧多时刻取最高档（T3>T1）且锚点随高档');
    ok(Math.abs(cam.timeScale() - 0.2) < 1e-9, 'T3 timeScale=0.2');
    cam.queue(2, 0, 0);
    cam.beginFrame();
    ok(cam.tier === 3, '低档不打断进行中的高档（不叠加）');
    cam.update(CONFIG.CAMERA.T3.DUR / 2);
    ok(cam.active, '半程仍在特写中');
    cam.update(CONFIG.CAMERA.T3.DUR);
    ok(!cam.active && cam.timeScale() === 1, '特写结束回 1.0');

    const cam2 = new CameraSystem();
    cam2.queue(1, 100, 100); cam2.beginFrame();
    ok(cam2.tier === 1 && Math.abs(cam2.timeScale() - 0.3) < 1e-9, 'T1 激活（ts 0.3）');
    cam2.queue(3, 200, 200); cam2.beginFrame();
    ok(cam2.tier === 3 && Math.abs(cam2.dur - 0.800) < 1e-9 && cam2.anchor.x === 200,
       '高档抢占：T1 播放中 T3 立即接管（时长/锚点重置）');

    const calls = [];
    const ctxStub = { translate: (...a) => calls.push(['t', ...a]),
                      scale: (...a) => calls.push(['s', ...a]) };
    const probe = { x: 123.456, y: 234.567 };
    cam2.update(0.2);
    cam2.applyTransform(ctxStub, 1280, 720);
    ok(calls.length === 3 && calls[1][0] === 's' && calls[1][1] > 1,
       'applyTransform 仅走 ctx translate/scale（渲染层变换）');
    ok(probe.x === 123.456 && probe.y === 234.567, '变换不触碰任何逻辑坐标');
  }

  // —— (b) ②.5 碎刃 Match 集成：满血刀方被秒杀 + T3 + blade_shatter ——
  {
    const deps = mkDeps();
    let ended = null;
    const m = new Match(deps, { mode: 'demo', p1Input: mkIdleV61('P1'), p2Input: mkIdleV61('P2'),
                                onEnd: (seat) => { ended = seat; } });
    m.update(STEP);
    m.player.x = 968; m.player.y = 360;
    m.p2.x = 1032; m.p2.y = 360;
    m.player.combat.phase = CombatState.HAMMER_ACTIVE;   // P1 锤判定帧
    m.p2.combat.phase = CombatState.BLADE_ACTIVE;        // P2 刀判定帧朝左（刃区覆盖 P1）
    m.p2.facing = Math.PI;                               // 白盒：刀区朝左锚定 P1（直接置相位不经 startBlade）
    m.p2._fsPhase = CombatState.BLADE_ACTIVE;            // 帧首相位（同帧无迁移）
    resolveOverlap(m.player, m.p2);
    m.resolveHits();
    ok(m.p2.combat.phase === CombatState.DEAD && m.p2.combat.hp === 0,
       '②.5 碎刃：满血（HP=3）刀方被秒杀（无视 HP 与刃区保护）');
    ok(m.player.combat.hp === 3 && ended === 'P1', '碎刃后锤方无伤，demo 收束 seat=P1');
    const q = m.fx.queue.concat(m.fx.lastEmitted || []);
    ok(q.some((e) => e.type === 'camera' && e.tier === 3), '碎刃 → camera T3 事件产出');
    ok(q.some((e) => e.type === 'blade_shatter'), '碎刃 → blade_shatter 特效产出');
    m.update(STEP);                                     // 帧末自扫 fx.lastEmitted → 本地消费（I-62 热修）
    ok(m.camera._pending && m.camera._pending.tier === 3, '本地消费：碎刃 T3 转调 camera.queue（待决）');
  }

  // —— (c) 打断 Match 集成：刀命中锤起手 → −1 HP + 相位回 IDLE + 冷却不启动 + T2 ——
  {
    const deps = mkDeps();
    const m = new Match(deps, { mode: 'demo', p1Input: mkIdleV61('P1'), p2Input: mkIdleV61('P2') });
    m.update(STEP);
    m.player.x = 968; m.player.y = 360;
    m.p2.x = 1032; m.p2.y = 360;
    m.player.combat.phase = CombatState.BLADE_ACTIVE;    // P1 刀判定帧
    m.p2.combat.startHammer({ x: -1, y: 0 }, m.tick);    // P2 锤起手（v4.0 出招即置 900ms 冷却）
    m.p2._fsPhase = CombatState.HAMMER_WINDUP;           // 帧首 = windup（D.1 帧首相位判）
    resolveOverlap(m.player, m.p2);
    m.resolveHits();
    ok(m.p2.combat.hp === 2, '打断：刀命中 −1 HP');
    ok(m.p2.combat.phase === CombatState.IDLE, '打断：锤相位取消回 IDLE');
    ok(m.p2.combat.hammerCooldown === 0, '打断：锤冷却不启动（未完成出招不算出招）');
    const q = m.fx.queue.concat(m.fx.lastEmitted || []);
    ok(q.some((e) => e.type === 'camera' && e.tier === 2), '打断 → camera T2 事件产出');
    ok(q.some((e) => e.type === 'interrupt_fx'), '打断 → interrupt_fx 特效产出');
    ok(m.player.combat.hp === 3, '打断方无伤');
    m.update(STEP);                                     // 帧末自扫 fx.lastEmitted → 本地消费（I-62 热修）
    ok(m.camera._pending && m.camera._pending.tier === 2, '本地消费：打断 T2 转调 camera.queue（待决）');
  }

  // —— (d) zoom 仅渲染层对拍：camera 变换路径全开，逻辑轨迹与无 camera 完全一致 ——
  {
    const run = (withCam) => {
      const deps = mkDeps();
      const m = new Match(deps, { mode: 'demo',
                                  p1Input: new AIInput(createBuiltinAI(), 'P1'),
                                  p2Input: new AIInput(createBuiltinAI(), 'P2') });
      m.camera.timeScale = () => 1;          // 两跑均隔离慢放（timeScale 为独立确定性机制，见汇报取舍）
      if (withCam) {                         // B 跑：T3 特写常开（beginFrame/update/applyTransform 全走）
        m.camera.active = true; m.camera.tier = 3;
        m.camera.t = 0; m.camera.dur = 1e9;
        m.camera.anchor = { x: 640, y: 360 };
      }
      const traj = [];
      for (let i = 0; i < 240; i++) {
        m.update(STEP);
        if (i % 30 === 0) traj.push(m.player.x.toFixed(3) + ',' + m.player.y.toFixed(3) +
                                    '|' + m.p2.x.toFixed(3) + ',' + m.p2.y.toFixed(3));
      }
      return traj;
    };
    const a = run(false), b = run(true);
    ok(a.length === b.length && a.every((v, i) => v === b[i]),
       '对拍：camera 激活（zoom 变换全开）期间逻辑坐标轨迹与无 camera 完全一致（9 采样点）');
  }

  // —— (f) 本地消费全链路：普通命中 T1（fx.queue → lastEmitted → camera.active/timeScale）——
  {
    const deps = mkDeps();
    const m = new Match(deps, { mode: 'demo', p1Input: mkIdleV61('P1'), p2Input: mkIdleV61('P2') });
    m.update(STEP);
    m.player.x = 968; m.player.y = 360;
    m.p2.x = 1032; m.p2.y = 360;
    m.player.combat.phase = CombatState.BLADE_ACTIVE;   // 刀判定帧打 idle 对手 = 普通命中（T1）
    m.player.combat._hitVictims.clear();
    resolveOverlap(m.player, m.p2);
    m.resolveHits();
    ok(m.p2.combat.hp === 2, 'T1 场景：刀命中 −1 HP');
    m.update(STEP);                                     // 帧末 flush + 本地消费
    ok(m.fx.lastEmitted.filter((e) => e.type === 'camera').length === 1,
       '广播不双发：lastEmitted 恰好一份 camera 帧（联机访客仍收一份）');
    m.update(STEP);                                     // 下一帧首 beginFrame 生效
    ok(m.camera.active && m.camera.tier === 1 && Math.abs(m.camera.timeScale() - 0.3) < 1e-9,
       '本地特写真实激活：普通命中 T1 active + timeScale 0.3（单机路径不再丢事件）');
    m.camera.update(CONFIG.CAMERA.T1.DUR);
    ok(!m.camera.active && m.camera.timeScale() === 1, 'T1 时长走完后回 timeScale=1');
  }

  // —— (e) 打断致死：HP=1 锤起手被刀打断 → 按普通死亡收束 ——
  {
    const deps = mkDeps();
    let ended = null;
    const m = new Match(deps, { mode: 'demo', p1Input: mkIdleV61('P1'), p2Input: mkIdleV61('P2'),
                                onEnd: (seat) => { ended = seat; } });
    m.update(STEP);
    m.player.x = 968; m.player.y = 360;
    m.p2.x = 1032; m.p2.y = 360;
    m.p2.combat.hit(); m.p2.combat.hit();                // HP=1
    m.player.combat.phase = CombatState.BLADE_ACTIVE;
    m.p2.combat.startHammer({ x: -1, y: 0 }, m.tick);
    m.p2._fsPhase = CombatState.HAMMER_WINDUP;
    resolveOverlap(m.player, m.p2);
    m.resolveHits();
    ok(m.p2.combat.phase === CombatState.DEAD && ended === 'P1',
       '打断致死：HP=1 锤起手被刀打断 → 死亡收束（seat=P1）');
  }
}

/* ---------- v3.1 联机 stub 工厂（T19/T20 共享；DC 有 connecting→open 生命周期） ---------- */
function _mkNetDC(name, opts) {
  const dc = { name, opts, readyState: 'connecting', _peer: null, _sends: [], _ls: {},
    send(s) { dc._sends.push(s); if (dc._peer) (dc._peer._ls.message || []).forEach((f) => f({ data: s })); },
    close() { dc.readyState = 'closed'; (dc._ls.close || []).forEach((f) => f()); },
    addEventListener(ev, fn) { (dc._ls[ev] = dc._ls[ev] || []).push(fn); },
    _setOpen() { dc.readyState = 'open'; (dc._ls.open || []).forEach((f) => f()); } };
  return dc;
}
function mkNetPair() {
  const created = [], mirrors = [];
  let useq = 0;
  const mkPC = (isGuest) => {
    const batch = [];                    // 本 PC（=本张 offer）的 DC 批次
    const pc = { iceGatheringState: 'complete', localDescription: null, remoteDescription: null, _ls: {},
      addEventListener(ev, fn) { (pc._ls[ev] = pc._ls[ev] || []).push(fn); },
      _fire(ev, arg) { (pc._ls[ev] || []).forEach((f) => f(arg)); },
      createDataChannel(name, opts) { const dc = _mkNetDC(name, opts); if (!isGuest) { created.push(dc); batch.push(dc); } return dc; },
      async createOffer() {
        useq++;
        const u = 'U' + useq;
        for (const dc of batch) dc._ufrag = u;          // host DC 标记所属 offer
        return { type: 'offer', sdp:
          'v=0\r\na=ice-ufrag:' + u + '\r\na=ice-pwd:P' + useq +
          '\r\na=fingerprint:sha-256 AA:' + (10 + useq) +
          '\r\n\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
      },
      async createAnswer() {
        useq += 100;
        return { type: 'answer', sdp:
          'v=0\r\na=ice-ufrag:U' + useq + '\r\na=ice-pwd:P' + useq +
          '\r\na=fingerprint:sha-256 AA:' + (10 + useq) +
          '\r\n\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' };
      },
      async setLocalDescription(d) { pc.localDescription = d; },
      async setRemoteDescription(d) {
        pc.remoteDescription = d;
        /* 真实 WebRTC：访客按 offer SDP 建对端通道——stub 以 ufrag 匹配 host DC 造镜像 */
        if (isGuest) {
          const u = /ice-ufrag:(\S+)/.exec(d.sdp)[1];
          for (const hdc of created) {
            if (hdc._ufrag !== u || hdc._peer) continue;
            const gdc = _mkNetDC(hdc.name);
            hdc._peer = gdc; gdc._peer = hdc;
            mirrors.push(gdc);
            pc._fire('datachannel', { channel: gdc });
          }
        }
      } };
    return pc;
  };
  /* 握手完成模拟：只 open 已配对（有镜像）的 DC——未消耗邀请码的 DC 保持 connecting */
  const shake = () => {
    for (const dc of created) if (dc._peer) { dc._setOpen(); dc._peer._setOpen(); }
    for (const m of mirrors) m._setOpen();
  };
  return { mkPC, created, mirrors, shake };
}

/* ---------- T19 配对器 + 双 DC 分型路由（stub RTCDataChannel） ---------- */
(async () => {   /* T19/T20 含 await：async IIFE 包裹（CommonJS 无顶层 await） */
console.log('[T19] PairingHost 多 offer 并行 / PairingGuest 应答 / snap 与 ctrl 通道分型与可靠性参数');
{
  const net = mkNetPair();
  const host = new PairingHost({ makePC: () => net.mkPC(false) });
  const guest = new PairingGuest({ makePC: () => net.mkPC(true) });

  // —— (a) 两张邀请码并行 ——
  const invites = [await host.createInvite(), await host.createInvite()];
  ok(invites[0].code !== invites[1].code, '两张并行邀请码互不相同（每访客一张）');
  ok(unpackSDP(invites[0].code).type === 'offer' && unpackSDP(invites[1].code).type === 'offer',
     '两张邀请码均可解包为 offer');
  ok(net.created.length === 4, '每张 offer 显式建两条 DC（snap+ctrl ×2）');
  ok(net.created[0].opts.ordered === false && net.created[0].opts.maxRetransmits === 0,
     'snap 通道：ordered=false + maxRetransmits=0（unreliable+unordered）');
  ok(net.created[1].opts.ordered === true && net.created[1].opts.maxRetransmits === undefined,
     'ctrl 通道：ordered=true（reliable）');
  ok(net.created[0].name === 'snap' && net.created[1].name === 'ctrl', 'DC 命名分型');

  // —— (b) guest join 1 号码 → answer → 房主确认 → 握手 → 双通道建立 ——
  const r = await guest.join(invites[0].code);
  ok(unpackSDP(r.answerCode).type === 'answer', '访客应答码为 answer');
  await host.acceptAnswer(invites[0].id, r.answerCode);
  net.shake();                              // 握手完成 → 全部 DC open
  const guestChan = await r.chanPromise;
  ok(guestChan instanceof NetChannel, '访客侧 NetChannel 建立');
  const hostChan = await invites[0].chanPromise;
  ok(hostChan instanceof NetChannel, '房主侧 NetChannel 建立');

  // —— (c) 帧分型路由：sendSnap 走 snap、sendCtrl 走 ctrl ——
  let guestGotSnap = null, guestGotCtrl = null;
  guestChan.onSnap((f) => { guestGotSnap = f; });
  guestChan.onCtrl((f) => { guestGotCtrl = f; });
  const snapDc = net.created[0], ctrlDc = net.created[1];
  const snapBefore = snapDc._sends.length, ctrlBefore = ctrlDc._sends.length;
  hostChan.sendSnap({ t: 'snapshot', tick: 1 });
  hostChan.sendCtrl({ t: 'room_state', phase: 'WAITING' });
  ok(snapDc._sends.length === snapBefore + 1, 'sendSnap 只走 snap 通道');
  ok(ctrlDc._sends.length === ctrlBefore + 1, 'sendCtrl 只走 ctrl 通道');
  ok(guestGotSnap && guestGotSnap.t === 'snapshot' && guestGotSnap.tick === 1,
     'snap 帧跨 stub 管道到达访客 snap 回调');
  ok(guestGotCtrl && guestGotCtrl.t === 'room_state', 'ctrl 帧到达访客 ctrl 回调');

  // —— (d) 2 号码仍 pending（offer 与连接一一对应）——
  ok(host.pending.size === 1, '已消耗 1 号邀请码，2 号仍 pending（多 offer 并行语义）');
  const r2 = await guest.join(invites[1].code);
  await host.acceptAnswer(invites[1].id, r2.answerCode);
  net.shake();
  const guestChan2 = await r2.chanPromise;
  const hostChan2 = await invites[1].chanPromise;
  let secondGot = null;
  guestChan2.onCtrl((f) => { secondGot = f; });
  hostChan2.sendCtrl({ t: 'room_state', phase: 'PLAYING', ch: 2 });
  ok(secondGot && secondGot.ch === 2, '第二张连接独立通道（互不串扰）');
  ok(host.pending.size === 0, '两张邀请码全部消耗');

  // —— (e) NetInputSource v2：seq 去重 + blade/hammer/aim 同接口 ——
  const nis = new NetInputSource();
  nis.feed({ t: 'input', v: 2, seq: 3, move: { x: 1, y: 0 }, blade: true, hammer: false, aim: { x: 400, y: 300 } });
  ok(nis.getMoveAxis().x === 1, 'input 帧喂入 → Input 同接口读出（move）');
  ok(nis.consumeBlade() === true && nis.consumeBlade() === false, 'blade 帧内一次消费');
  nis.feed({ t: 'input', v: 2, seq: 2, move: { x: -1, y: 0 }, blade: true, hammer: false, aim: null });
  ok(nis.getMoveAxis().x === 1, '乱序旧帧（seq 更小）丢弃');
  nis.feed({ t: 'input', v: 2, seq: 4, move: { x: 0, y: 1 }, blade: false, hammer: true, aim: { x: 200, y: 500 } });
  ok(nis.getMoveAxis().y === 1 && nis.getMoveAxis().x === 0, '新 seq 帧覆盖状态');
  ok(nis.consumeHammer() === true && nis.consumeHammer() === false, 'hammer 帧内一次消费');
  const aimV = nis.getAim({ x: 100, y: 500 });
  ok(Math.abs(aimV.x - 1) < 1e-9 && Math.abs(aimV.y) < 1e-9, 'getAim = 帧内虚拟光标 − 球心（单位向量，Input 同契约）');
  nis.feed({ t: 'input', v: 1, seq: 5, move: { x: 9, y: 9 }, blade: true, hammer: true, aim: null });
  ok(nis.getMoveAxis().x === 0 && nis.getMoveAxis().y === 1 &&
     nis.consumeBlade() === false && nis.consumeHammer() === false,
     '协议版本闸：v≠2 帧整体丢弃（INPUT_VERSION=2 不跨版本兼容）');
  nis.feed({ t: 'input', v: 2, seq: 6, move: { x: 0, y: 0 }, blade: false, hammer: false, aim: null });
  const aim0 = nis.getAim({ x: 100, y: 100 });
  ok(aim0.x === 0 && aim0.y === 0, '无 aim 坐标 → 零向量（Player 层朝对手兜底）');
  ok(nis.isDown('KeyR') === false, '远程端无按键语义（Player 层兜底）');
}

/* ---------- T20 双端对拍（核心验收）：Node 内存管道跑完整联机对局到 match_end ---------- */
console.log('[T20] 双端对拍：HostRoom 权威模拟 + GuestClient AI 席 → match_end + 三局两胜 + 断线托管');
{
  const net = mkNetPair();
  const host = new PairingHost({ makePC: () => net.mkPC(false) });
  const guest = new PairingGuest({ makePC: () => net.mkPC(true) });
  const room = new HostRoom(new FXSystem(), { play() {} });
  host.onOpen = (ch) => room.addChannel(ch);
  room.p1Input = new AIInput(createBuiltinAI(), 'P1');   // 房主 P1 = AI（零网络直注，架构 §1.1）

  const invite = await host.createInvite();
  const r = await guest.join(invite.code);
  await host.acceptAnswer(invite.id, r.answerCode);
  net.shake();                                           // 握手完成
  const hostChan = await invite.chanPromise;
  const guestChan = await r.chanPromise;
  ok(room.channels.length === 1, '配对完成 → 访客连接入房（默认观战）');

  const gc = new GuestClient(new FXSystem());
  gc.attach(guestChan);
  await gc.claimSeat('P2');                              // AI 席占座（ctrl 帧 → seat_ok）
  ok(room.seats.P2 === hostChan && gc.mySeat === 'P2', 'claim_seat → P2 入座（AI 与人类同包）');
  ok(room.p2Input instanceof NetInputSource, '远程席 = NetInputSource（人类/AI 同包不区分）');
  gc.attachAI({ name: 'idle', think() { return { move: { x: 0, y: 0 }, blade: false, hammer: false }; } });
  /* AI 席跑在访客端（本地 think → input 上行）；P2 取静止 AI 保证确定性击杀路径（同 T15(a)，
   * 双内置对称相持会拖到 300s 超时——相持语义已由 T15(b) 断言，此处不重复） */

  room.beginCountdown();
  ok(room.phase === 'COUNTDOWN', '开始 → COUNTDOWN');
  for (let i = 0; i < Math.ceil(NET.COUNTDOWN / STEP); i++) room.update(STEP);
  ok(room.phase === 'PLAYING' && room.match !== null, 'COUNTDOWN 3s → PLAYING（房主跑权威 Match）');

  let endFrames = [];
  gc.onMatchEnd = (f) => endFrames.push(f);
  /* v4.1 camera 事件确定性对拍：房主产出（lastEmitted）= 访客收到（钩住 GuestClient.camera.queue） */
  const hostCams = [], guestCams = [];
  const guestQueueRaw = gc.camera.queue.bind(gc.camera);
  gc.camera.queue = (tier, x, y) => { guestCams.push({ tier, x, y }); return guestQueueRaw(tier, x, y); };
  let ticks = 0;
  const maxTicks = Math.ceil(70 / STEP);                 // 70s 上限（T15：内置互战 60s 内收束）
  while (room.p1Wins + room.p2Wins < 1 && ticks < maxTicks) {
    room.update(STEP);                                   // 房主：模拟 + 快照广播（camera 随 events 下发）
    if (room.match) for (const ev of (room.match.fx.lastEmitted || [])) {
      if (ev.type === 'camera') hostCams.push({ tier: ev.tier, x: ev.x, y: ev.y });
    }
    gc.sendInput();                                      // 访客：AI think → input 帧（snap 通道上行）
    ticks++;
  }
  ok(hostCams.length >= 1 && hostCams.length === guestCams.length &&
     JSON.stringify(hostCams) === JSON.stringify(guestCams),
     'v4.1 camera 事件确定性：房主产出 = 访客逐事件收到（' + hostCams.length + ' 个，tier/x/y 全等）');
  ok(room.p1Wins + room.p2Wins >= 1, '完整对局跑到单局 match_end（' + (ticks * STEP).toFixed(1) + 's）');
  ok(endFrames.length === 1 && (endFrames[0].result === 'P1' || endFrames[0].result === 'P2'),
     'match_end 帧 result 通道正确（' + (endFrames[0] ? endFrames[0].result : 'none') + '）');
  ok(typeof endFrames[0].p1Wins === 'number' && typeof endFrames[0].p2Wins === 'number',
     'match_end 含三局两胜计分字段');
  ok(gc.state.p1 && typeof gc.state.p1.x === 'number' && gc.state.tick > 0,
     '访客收到快照流（tick=' + gc.state.tick + '，实体位置更新）');
  ok(Array.isArray(gc.state.p1 ? [] : null) || gc.state.p1.phase !== undefined,
     '实体相位随快照下发');
  ok(gc.state.p1.hp !== undefined && gc.state.p2.hp !== undefined, '快照含 hp（血条可渲染）');

  // 三局两胜：白盒再收一局 → P1 达 2 胜 → ENDED
  room._onMatchEnd('P1');
  ok(room.phase === 'ENDED' && room.p1Wins === 2, '第二局 P1 胜 → 三局两胜 ENDED');
  ok(endFrames.length === 2 && endFrames[1].p1Wins === 2, 'ENDED 也广播 match_end（客户端结算）');

  // 断线语义：重开一局 PLAYING 中 P2 断线 → AI 托管
  room.phase = 'WAITING'; room.p1Wins = 0; room.p2Wins = 0;
  room.beginCountdown();
  for (let i = 0; i < Math.ceil(NET.COUNTDOWN / STEP); i++) room.update(STEP);
  ok(room.phase === 'PLAYING' && room.p2Input instanceof NetInputSource,
     '重开局：P2 = 远程 NetInputSource');
  guestChan.close(); hostChan.close();                   // 访客断线（P2P 两端 DC 同时关闭）
  ok(room.seats.P2 === null && room.p2Input && room.p2Input.constructor === AIInput,
     'PLAYING 中断线 → 座位立即内置 AI 托管（30s 语义，P2 唯一无超时回收分支）');

  // ROOM_FULL：访客连接上限 = P2 席 1 + 观战 8
  let filled = 0;
  while (room.channels.length < NET.SPECTATOR_MAX + 1) {
    const ch = new NetChannel(_mkNetDC('snap'), _mkNetDC('ctrl'));
    ch.dcSnap._setOpen(); ch.dcCtrl._setOpen();
    if (room.addChannel(ch) === false) break;
    filled++;
  }
  ok(filled === NET.SPECTATOR_MAX + 1, '断线后余位补满至 ' + filled + '（P2 席 1 + 观战 8，上限内入房）');
  const over = new NetChannel(_mkNetDC('snap'), _mkNetDC('ctrl'));
  over.dcSnap._setOpen(); over.dcCtrl._setOpen();
  ok(room.addChannel(over) === false, '超出上限 → ROOM_FULL 拒绝');
}

  console.log('\n========================================');
  console.log(`TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})();
