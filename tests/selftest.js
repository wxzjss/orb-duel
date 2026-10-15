/* 「光球对决」v2.1+v2.2+v2.3 纯逻辑自测（Node，无真实 DOM/Canvas；Input 用事件桩）
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
        checkChargeHit, hitCircleOf, adjudicate, resolveOverlap, Input, FXSystem, Match,
        serializeReplay, deserializeReplay, LocalGhostStore,
        onSelfWin, onSelfLose, onBossSoloWin, onBossSoloLose,
        selfOutcome, bossSoloOutcome, isModeAvailable, hudLines, seedOnLevelWin,
        AIInput, createBuiltinAI, compileAICode,
        deepFreeze, VirtualJoystick, TouchButton, TouchSource } = E;

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
  const b = { x, y, r: 16, facing };
  b.combat = new Combat(); b.combat.owner = b;
  return b;
};

/* ---------- T0 删净断言（控制 #13：源码扫描；I-40 更正：攻击特效 = v1.0 闪避风格残影+速度线） ---------- */
console.log('[T0] 删净扫描：闪避词 + 拉丝/光带/星芒/月牙/形变删净 + 死代码删净；残影+速度线存在');
{
  const html = fs.readFileSync(HTML, 'utf8');
  ok(html.match(/dodge|闪避|graze|擦弹/gi) === null, '全文无 dodge/闪避/graze/擦弹（v1.1 T0 不回退）');
  ok(/crescent|月牙|FX\.WINDUP|FX\.BAND|FX\.SPARK|'charge_windup'|'charge_band'|streaks|squash|stretch/g.test(html) === false,
     'I-40 更正：拉丝/光带/星芒/月牙/球体形变全部删净（残影+速度线取代）');
  ok(/RELEASE_DEBOUNCE|guardReady|debounceTimer/.test(html) === false,
     'v2.3：200ms 防抖通道废除干净');
  ok(/\bnew RemoteGhostStore\b|\bfunction seedRemote\b|\bid="scr-boss"|\bclass BossMenuScreen\b|\bid="scr-ai"|\bclass AiScreen\b|\bAISlotStore\b|\bBUILTIN_AI_SAMPLE\b/.test(html) === false,
     'v3.0：联机三池/RemoteGhostStore/二级boss屏/AI 编辑屏死代码删净（代码级扫描）');
  // —— 残影 + 速度线存在性（I-40 更正后的攻击特效语言）——
  ok(/AFTERIMAGE:\s*\{\s*N:\s*3,\s*GAP:\s*0\.025,\s*LIFE:\s*0\.25/.test(html) &&
     /ALPHAS:\s*\[\s*0\.5,\s*0\.35,\s*0\.2\s*\]/.test(html),
     '残影参数：3 段 / 25ms 间隔 / 250ms 寿命 / alpha 0.5/0.35/0.2');
  ok(/SPEEDLINES:\s*\{\s*LIFE:\s*2\s*\/\s*60/.test(html), '速度线：2 帧寿命');
  ok(/'charge_afterimages'/.test(html) && /'charge_speedlines'/.test(html),
     'fxHooks 发射残影 + 速度线事件');
}

/* ---------- T1 Recorder → GhostPlayer 镜像回放（v2.3 水平镜像复刻） ---------- */
console.log('[T1] Recorder + GhostPlayer 镜像复刻（x\'=1280−x，dirAngle\'=π−dirAngle）');
{
  const rec = new Recorder();
  rec.begin();
  for (let t = 0; t < 200; t++) {
    let x = 230, y = 360;
    if (t >= 30 && t < 90) x = 230 + (t - 30) * 3;
    rec.sample(x, y);
    if (t === 60) rec.recordAction('charge', 0, t);          // 玩家朝右撞
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
  let posOK = true, idleChecked = 0, prevPhase = 'IDLE';
  let chargePhase60 = null, facing60 = null, guardPhase150 = null, releasePhase160 = null;
  for (let t = 0; t < 200; t++) {
    ghost.update(t, STEP, fakeGame);
    if (t === 0) ok(ghost.x === CONFIG.SPAWN.GHOST.x,
                    '幽灵出生点 = 1050 由镜像自然得出（轨迹首帧 230 → x\'=1050）');
    if (t === 60) { chargePhase60 = ghost.combat.phase; facing60 = ghost.facing; }
    if (t === 150) guardPhase150 = ghost.combat.phase;
    if (t === 160) releasePhase160 = ghost.combat.phase;
    if (ghost.combat.phase === 'IDLE' && prevPhase === 'IDLE') {
      idleChecked++;
      if (Math.abs(ghost.x - (CONFIG.VIEW.W - rep.trajectory[2 * t]) - offX) > 1e-4 ||
          Math.abs(ghost.y - rep.trajectory[2 * t + 1] - offY) > 1e-4) { posOK = false; break; }
    }
    prevPhase = ghost.combat.phase;
  }
  ok(posOK, 'IDLE 帧回放位置 = 1280−录制x + offset（镜像逐帧校验 ' + idleChecked + ' 帧）');
  ok(chargePhase60 === 'CHARGE_WINDUP' && Math.abs(facing60 - Math.PI) < 1e-9,
     '录制 dirAngle=0（朝右）→ 幽灵 facing=π（朝左，镜像方向换算）');
  ok(guardPhase150 === 'GUARD', 'guard_begin 原样回放 → GUARD');
  ok(releasePhase160 === 'GUARD_RELEASE', 'guard_end 原样回放（v2.3 幽灵侧 manual 冷却）');

  // 循环接缝（T=200）
  let seamOK = true;
  for (let t = 200; t < 240; t++) {
    ghost.update(t, STEP, fakeGame);
    if (ghost.combat.phase !== 'IDLE') continue;
    const tt = t % 200;
    if (Math.abs(ghost.x - (CONFIG.VIEW.W - rep.trajectory[2 * tt])) > 1e-4) { seamOK = false; break; }
  }
  ok(seamOK, 't mod T 循环接缝无跳变（镜像轴）');
}

/* ---------- T2 Combat：v2.1 参数 50/100/50 + 168px + v2.2 CLASH + v2.3 防御冷却 ---------- */
console.log('[T2] Combat 状态机（200ms 周期/168px/贴墙/NaN 防御）+ CLASH + hit()/HP');
{
  const b = mkBall(400, 360, 0);
  const c = b.combat;
  ok(CONFIG.CHARGE.WINDUP === 0.050 && CONFIG.CHARGE.ACTIVE === 0.100 &&
     CONFIG.CHARGE.RECOVERY === 0.050 && CONFIG.CHARGE.DASH_SPEED === 1680,
     'v2.1 参数：50/100/50ms + 1680px/s');
  ok(CONFIG.BALL.SPEED === 640, 'v2.1 移速 640');
  ok(c.startCharge({ x: 1, y: 0 }, 100) === true, 'startCharge 向量契约');
  c.update(0.0333);                                   // 2 帧内
  ok(c.phase === 'CHARGE_WINDUP', '50ms 内保持 WINDUP（起手+判定帧无敌）');
  c.update(0.05);                                     // 累计 ≥50ms
  ok(c.phase === 'CHARGE_ACTIVE', '50ms 后进入 CHARGE_ACTIVE（判定帧无敌）');
  ok(Math.abs(c.dashTo.x - (400 + 168)) < 1e-6, 'dashTo = 起点+168px（1680×0.100 距离守恒）');
  c.update(0.095);                                    // ACTIVE 95ms < 100ms
  ok(c.phase === 'CHARGE_ACTIVE', 'ACTIVE 100ms 内保持');
  c.update(0.02);                                     // 累计 115ms ≥ 100ms
  ok(c.phase === 'CHARGE_RECOVERY', 'ACTIVE 100ms 后进入 RECOVERY（后摇可被打）');
  ok(Math.abs((b.x - 400) - 168) < 1e-6, '冲撞位移精确 168px');
  c.update(0.05);
  ok(c.phase === 'IDLE', 'RECOVERY 50ms 后回 IDLE（总周期 200ms）');

  // 贴墙 clamp
  const wall = mkBall(1240, 360, 0);
  wall.combat.startCharge({ x: 1, y: 0 }, 300);
  wall.combat.update(0.05);
  ok(wall.combat.dashTo.x === CONFIG.VIEW.W - CONFIG.BOUND.INSET,
     '贴墙 dashTo.x = 1264（clamp 生效）');
  wall.combat.update(0.1);
  ok(Math.abs(wall.x - 1264) < 1e-6, '贴墙冲撞实际终点不穿墙');

  // NaN 防御
  const nanBall = mkBall(500, 360, NaN);
  nanBall.combat.phase = 'CHARGE_ACTIVE';
  const victim = mkBall(505, 360, 0);
  ok(checkChargeHit(nanBall, victim) === null, 'NaN facing → checkChargeHit 返回 null');

  // v2.2 CLASH：击退 60px/150ms + 硬直 150ms = 300ms
  const cb = mkBall(500, 360, 0);
  cb.combat.clash({ x: -1, y: 0 });
  ok(cb.combat.phase === 'CLASH', 'clash() 进入 CLASH');
  cb.combat.update(0.075);
  ok(Math.abs((500 - cb.x) - 30) < 1e-6, '击退插值半程 30px@75ms');
  cb.combat.update(0.075);
  ok(Math.abs((500 - cb.x) - CONFIG.CLASH.KNOCKBACK) < 1e-6, '击退 60px/150ms 完成');
  cb.combat.update(0.15);
  ok(cb.combat.phase === 'IDLE' && Math.abs(cb.x - 440) < 1e-6, '300ms 弹开结束回 IDLE（硬直钉在终点）');

  // v2.2 hit()/HP=3：归 0 才死
  const h = mkBall(0, 0, 0);
  ok(h.combat.hp === 3 && h.combat.maxHP === 3, '初始 HP=3');
  ok(h.combat.hit() === 'hit' && h.combat.hp === 2, '第 1 次命中 −1 HP 不死');
  ok(h.combat.hit() === 'hit' && h.combat.hp === 1, '第 2 次命中 −1 HP 不死');
  ok(h.combat.hit() === 'dead' && h.combat.hp === 0 && h.combat.phase === 'DEAD',
     '第 3 次命中 HP 归 0 → DEAD');
}

/* ---------- T2b 防御冷却三分支（v2.3） ---------- */
console.log('[T2b] v2.3 防御重做：manual 等值冷却 / 格挡 3s / 满额 3s / 冷却期拒绝 / 格挡优先');
{
  // 分支 a：松开 → 冷却 = 已防御时长（无下限）
  const a = mkBall(0, 0, 0);
  a.combat.startGuard();
  steps(a.combat, 1);                                 // held ≈16.7ms
  ok(a.combat.releaseGuard('manual') === true && a.combat.phase === 'GUARD_RELEASE',
     '松开 → GUARD_RELEASE（冷却计时通道）');
  ok(Math.abs(a.combat._coolDur - STEP) < 1e-9, 'held 1 帧 → 冷却 = 已防御时长（无下限）');
  steps(a.combat, 1);
  ok(a.combat.phase === 'IDLE', '冷却结束回 IDLE');

  const a2 = mkBall(0, 0, 0);
  a2.combat.startGuard();
  steps(a2.combat, 120);                              // held 2s
  a2.combat.releaseGuard('manual');
  ok(Math.abs(a2.combat._coolDur - 2.0) < 1e-9, 'held 2s → 冷却 2s（等值）');
  steps(a2.combat, 121);
  ok(a2.combat.phase === 'IDLE', '2s 冷却走完');

  // 冷却期右键无效
  const a3 = mkBall(0, 0, 0);
  a3.combat.startGuard();
  a3.combat.releaseGuard('manual');                   // held 0 → 冷却 0
  a3.combat.startGuard();
  steps(a3.combat, 1);                                // 推进 1 帧脱离 0 冷却？0 冷却当帧即 IDLE
  // 重新构造非零冷却拒绝场景：
  const a4 = mkBall(0, 0, 0);
  a4.combat.startGuard();
  steps(a4.combat, 60);                               // held 1s
  a4.combat.releaseGuard('manual');                   // 冷却 1s
  ok(a4.combat.startGuard() === false && a4.combat.phase === 'GUARD_RELEASE',
     '冷却期内 startGuard 被拒绝');
  steps(a4.combat, 61);
  ok(a4.combat.phase === 'IDLE' && a4.combat.startGuard() === true, '冷却结束可再盾');

  // 分支 b：格挡成功 → 冷却 3s
  const g1 = mkBall(0, 0, 0);
  g1.combat.startGuard();
  steps(g1.combat, 12);                               // held 0.2s
  g1.combat.releaseGuard('block');
  ok(Math.abs(g1.combat._coolDur - 3.0) < 1e-9, '格挡成功（block）→ 冷却 3s');

  // 分支 c：满额 3s 自动结束 → 冷却 3s；满额帧格挡优先
  // （白盒逼近满额帧，规避 1/60 累加浮点边界）
  const g2 = mkBall(0, 0, 0);
  g2.combat.startGuard();
  g2.combat.t = CONFIG.GUARD.MAX_HOLD - 1e-6;         // 差 1µs 满 3s
  g2.combat.update(STEP);                             // 本帧跨过 3s
  ok(g2.combat.phase === 'GUARD' && g2.combat._expire === true,
     '满额帧保持 GUARD（不立即结束，格挡优先窗口）');
  ok(Math.abs(g2.combat.t - 3.0) < 1e-9, '满额帧 t 冻结于 3s');
  g2.combat.update(STEP);                             // 下一帧
  ok(g2.combat.phase === 'GUARD_RELEASE' && Math.abs(g2.combat._coolDur - 3.0) < 1e-9,
     '满额未被命中 → 下一帧自动结束，冷却 3s（分支 c）');
  ok(g2.combat.startGuard() === false, '冷却期拒绝再盾');

  // 满额瞬间恰被打 → 格挡优先（先到先结算）
  const g3 = mkBall(0, 360, 0);
  g3.combat.startGuard();
  g3.combat.t = CONFIG.GUARD.MAX_HOLD - 1e-6;
  g3.combat.update(STEP);                             // 满额帧（GUARD 保持）
  const atk = mkBall(0, 360, 0);                      // 探针球与 g3 重合（打击圈覆盖）
  atk.combat.phase = 'CHARGE_ACTIVE';
  ok(checkChargeHit(atk, g3) === 'guard', '满额帧被打 → 判定 guard（格挡优先，不掉血）');
  atk.combat.bounce();
  g3.combat.releaseGuard('block');
  ok(Math.abs(g3.combat._coolDur - 3.0) < 1e-9, '满额被打走 block 分支（冷却 3s，非 timeout）');
}

/* ---------- T3 命中矩阵四态 + adjudicate（v2.2：废除 startTick 裁决与 DRAW 触发） ---------- */
console.log('[T3] checkChargeHit 四态矩阵 + adjudicate（clash/ineffective 新通道，对称性）');
{
  const atk = mkBall(500, 360, 0);
  atk.combat.startCharge({ x: 1, y: 0 }, 100);
  atk.combat.update(0.05);                            // 恰转 ACTIVE（球未动，dashFrom=500）
  const hc = hitCircleOf(atk);
  ok(hc.x === 518 && hc.y === 360 && hc.r === 20, '打击圈 = 球心前方 18px, r=20');

  // 四态逐一（目标 548，圆心距 30 < 36）
  ok(checkChargeHit(atk, mkBall(548, 360, Math.PI)) === 'hit', '矩阵·普通（IDLE）→ hit');
  const rec = mkBall(548, 360, Math.PI);
  rec.combat.phase = 'CHARGE_RECOVERY';
  ok(checkChargeHit(atk, rec) === 'hit', '矩阵·后摇 → hit（可被打）');
  const bnc = mkBall(548, 360, Math.PI);
  bnc.combat.phase = 'BOUNCE';
  ok(checkChargeHit(atk, bnc) === 'hit', '矩阵·弹开 → hit（矩阵「普通」行含弹开）');
  const rel = mkBall(548, 360, Math.PI);
  rel.combat.phase = 'GUARD_RELEASE';
  ok(checkChargeHit(atk, rel) === 'hit', '矩阵·防御冷却 → hit（普通行）');
  const wind = mkBall(548, 360, Math.PI);
  wind.combat.startCharge({ x: -1, y: 0 }, 99);
  ok(checkChargeHit(atk, wind) === 'inv_windup', '矩阵·无敌起手 → inv_windup（无效命中）');
  const act = mkBall(548, 360, Math.PI);
  act.combat.startCharge({ x: -1, y: 0 }, 99);
  act.combat.update(0.05);                            // ACTIVE
  ok(checkChargeHit(atk, act) === 'clash', '矩阵·无敌判定帧 → clash（对撞弹开）');
  const grd = mkBall(548, 360, Math.PI);
  grd.combat.startGuard();
  ok(checkChargeHit(atk, grd) === 'guard', '矩阵·防御姿态 → guard（规则不变）');
  const dead = mkBall(548, 360, Math.PI);
  dead.combat.kill();
  ok(checkChargeHit(atk, dead) === null, 'DEAD 不产生事件');

  // 命中结算标记：同一冲撞对同一目标至多一次
  const v1 = mkBall(500, 360, 0), v2 = mkBall(548, 360, Math.PI);
  v1.combat.startCharge({ x: 1, y: 0 }, 100);
  steps(v1.combat, 4);
  checkChargeHit(v1, v2);
  v1.combat._hitVictims.add(v2);
  ok(checkChargeHit(v1, v2) === null, '已结算目标不再重复判定（矩阵 D）');

  // adjudicate：双 clash（含同 tick）→ 弹开，无 DRAW
  const p1 = mkBall(500, 360, 0), p2 = mkBall(548, 360, Math.PI);
  p1.combat.startCharge({ x: 1, y: 0 }, 100);
  p2.combat.startCharge({ x: -1, y: 0 }, 100);        // 同 tick 起手
  p1.combat.update(0.05); p2.combat.update(0.05);     // 双 ACTIVE（球未动）
  const ev = [];
  const r1 = checkChargeHit(p1, p2), r2 = checkChargeHit(p2, p1);
  if (r1) ev.push({ attacker: p1, defender: p2, kind: r1 });
  if (r2) ev.push({ attacker: p2, defender: p1, kind: r2 });
  ok(ev.length === 2 && ev[0].kind === 'clash' && ev[1].kind === 'clash',
     '同 tick 对撞：双方判定帧接触（双 clash 事件）');
  const v = adjudicate(ev);
  ok(v.type === 'clash' && (v.a === p1 || v.a === p2), '双 clash → 对撞弹开（废除 startTick 比较）');
  const vSwap = adjudicate([ev[1], ev[0]]);
  ok(vSwap.type === 'clash', '对称输入产出对称输出（控制 #15）');
  ok(adjudicate([{ attacker: p1, defender: p2, kind: 'clash' }]).type === 'clash',
     '单 clash（对方判定圈未及）同样弹开');

  // 单事件四态
  const e1 = mkBall(500, 360, 0), t1 = mkBall(548, 360, Math.PI);
  e1.combat.startCharge({ x: 1, y: 0 }, 100); e1.combat.update(0.05);
  ok(adjudicate([{ attacker: e1, defender: t1, kind: 'hit' }]).type === 'win',
     'hit → 有效命中通道');
  ok(adjudicate([{ attacker: e1, defender: t1, kind: 'inv_windup' }]).type === 'ineffective',
     'inv_windup → 无效命中通道（光刃消散，无白闪无震动）');
  const v3 = adjudicate([{ attacker: e1, defender: t1, kind: 'guard' }]);
  ok(v3.type === 'guard' && v3.attacker === e1 && v3.defender === t1, 'guard → 格挡通道');
}

/* ---------- T3b 实体碰撞软推挤（v2.2 E） ---------- */
console.log('[T3b] resolveOverlap：分离无重叠 / 完全重合 / DEAD 不推 / 交错冲撞无穿模');
{
  const a = mkBall(500, 360, 0), b = mkBall(510, 360, 0);   // 距 10 < 32
  resolveOverlap(a, b);
  ok(Math.abs(len(b.x - a.x, b.y - a.y) - 32) < 1e-6 && a.x < 500 && b.x > 510,
     '重叠 → 沿连线各推一半至恰好不重叠');

  const c1 = mkBall(500, 360, 0), c2 = mkBall(500, 360, 0); // 完全重合
  resolveOverlap(c1, c2);
  ok(Math.abs(len(c2.x - c1.x, c2.y - c1.y) - 32) < 1e-6, '完全重合 → 沿 +x 分离');

  const d1 = mkBall(500, 360, 0), d2 = mkBall(510, 360, 0);
  d1.combat.kill();
  resolveOverlap(d1, d2);
  ok(d2.x === 510, 'DEAD 不推（尸体静止）');

  // 交错冲撞：相向 dash 中点相遇，多帧分离无穿模
  const s1 = mkBall(400, 360, 0), s2 = mkBall(700, 360, Math.PI);
  s1.combat.startCharge({ x: 1, y: 0 }, 0);
  s2.combat.startCharge({ x: -1, y: 0 }, 0);
  steps(s1.combat, 4); steps(s2.combat, 4);           // 双 ACTIVE，dashTo 568 / 532（已交错）
  let noClip = true;
  for (let i = 0; i < 30; i++) {
    s1.combat.update(STEP); s2.combat.update(STEP);
    resolveOverlap(s1, s2);
    if (len(s2.x - s1.x, s2.y - s1.y) < s1.r + s2.r - 1e-6) { noClip = false; break; }
  }
  ok(noClip, '交错冲撞逐帧软推挤：全程无穿模（判定圈随实际球心）');
}

/* ---------- T4 Input：方向三级解析 + guardHeld（v2.3 无防抖） ---------- */
console.log('[T4] Input getChargeDir 三级回退 + guardHeld');
{
  const input = new Input(stub.canvas);
  const pos = { x: 400, y: 360 };

  stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });
  let dir = input.getChargeDir(pos);
  ok(dir.x === 1 && dir.y === 0, '三级1：移动输入方向 (1,0)');
  stub.fireWin('keyup', { code: 'KeyD' });
  dir = input.getChargeDir(pos);
  ok(dir.x === 1 && dir.y === 0, '三级2：lastMoveDir 记忆 (1,0)');
  const input2 = new Input(stub.canvas);
  stub.fireCanvas('mousemove', { clientX: 400, clientY: 160 });
  dir = input2.getChargeDir({ x: 400, y: 360 });
  ok(Math.abs(dir.y + 1) < 1e-9 && Math.abs(dir.x) < 1e-9, '三级3：鼠标方向兜底 (0,-1)');

  const input3 = new Input(stub.canvas);
  ok(input3.guardHeld() === false, '初始未按右键');
  stub.fireCanvas('mousedown', { button: 2 });
  ok(input3.guardHeld() === true, '右键按住 → guardHeld');
  stub.fireWin('mouseup', { button: 2 });
  ok(input3.guardHeld() === false, '松开 → guardHeld=false（冷却归 Combat，无 Input 防抖）');
  stub.fireCanvas('mousedown', { button: 2 });        // 立即再按：由 Combat 相位拒绝
  ok(input3.guardHeld() === true, '再按即上报 held（拒绝逻辑在 Combat 层）');
  stub.fireWin('blur', {});
  ok(input3.guardHeld() === false, '失焦清空 guard 按住状态');
}

/* ---------- T5 Player 防御输入流（v2.3：冷却负反馈）+ 录制事件对齐 ---------- */
console.log('[T5] Player 防御流：GUARD→manual 冷却→冷却期拒绝→负反馈');
{
  const input = new Input(stub.canvas);
  const rec = new Recorder(); rec.begin();
  const player = new Player(CONFIG.SPAWN.PLAYER.x, CONFIG.SPAWN.PLAYER.y);
  player.combat.onAction = (type, ang, t) => rec.recordAction(type, ang, t);
  const fxQ = [];
  const game = { tick: 0, fx: { queue: fxQ } };

  stub.fireCanvas('mousedown', { button: 2 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'GUARD' && player.x === CONFIG.SPAWN.PLAYER.x,
     '右键按住 → GUARD（移动锁定）');
  for (let i = 0; i < 4; i++) player.update(STEP, input, game);   // 帧内 startGuard+update：held 累计 5 帧
  stub.fireWin('mouseup', { button: 2 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'GUARD_RELEASE' &&
     Math.abs(player.combat._coolDur - STEP * 5) < 1e-9,
     '松开 → manual 冷却 = 已防御时长（5 帧）');
  // 冷却期再按 → 不进 GUARD + guard_denied 负反馈（冷却尚未走完）
  const q0 = fxQ.length;
  stub.fireCanvas('mousedown', { button: 2 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'GUARD_RELEASE' &&
     fxQ.length > q0 && fxQ[fxQ.length - 1].type === 'guard_denied',
     '冷却期按右键：拒绝 + 50ms 暗淡负反馈');
  stub.fireWin('keyup', { button: 2 });
  // 冷却期可移动（仍在 5 帧冷却内）
  stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });
  const x0 = player.x;
  player.update(STEP, input, game);
  ok(player.x > x0 && player.combat.phase === 'GUARD_RELEASE', 'GUARD_RELEASE 冷却期可移动');
  stub.fireWin('keyup', { code: 'KeyD' });

  const evs = rec.finalize().events;
  ok(evs.length >= 1 && evs[0].type === 'guard_begin' && evs[0].t === 0,
     'guard_begin 事件 t 与轨迹帧同源（首帧 t=0）');
  ok(evs.some(e => e.type === 'guard_end'), 'guard_end 已记录（松开帧）');
}

/* ---------- T6 Player 冲撞集成（v2.1 50ms 起手） ---------- */
console.log('[T6] Player 冲撞集成：输入驱动 + 录制角 + 命中回归');
{
  const input = new Input(stub.canvas);
  const rec = new Recorder(); rec.begin();
  const player = new Player(230, 360);
  player.combat.onAction = (type, ang, t) => rec.recordAction(type, ang, t);
  const game = { tick: 0, fx: { queue: [] } };

  stub.fireWin('keydown', { code: 'KeyD', preventDefault() {} });
  stub.fireCanvas('mousedown', { button: 0 });
  player.update(STEP, input, game);
  ok(player.combat.phase === 'CHARGE_WINDUP' && player.facing === 0,
     'KeyD+左键 → CHARGE_WINDUP，facing=0');
  player.update(0.05, input, game);                   // 累计 ≥50ms → ACTIVE
  ok(player.combat.phase === 'CHARGE_ACTIVE', '起手 50ms 后进入判定帧');
  ok(Math.abs(player.combat.dashTo.x - (230 + 168)) < 1e-6, 'dashTo = (398, 360)');
  player.update(0.1, input, game);                    // ACTIVE 走完
  ok(player.combat.phase === 'CHARGE_RECOVERY' && Math.abs(player.x - 398) < 1e-6,
     '冲撞终点 x=398（168px）');

  const chargeEv = rec.finalize().events.find(e => e.type === 'charge');
  ok(!!chargeEv && chargeEv.dirAngle === 0, '录制 charge 事件 dirAngle === 0（角度契约）');

  const near = mkBall(428, 360, Math.PI);
  const far = mkBall(493, 360, Math.PI);
  const probe = mkBall(398, 360, 0);
  probe.combat.startCharge({ x: 1, y: 0 }, 0);
  probe.combat.update(0.05);
  ok(checkChargeHit(probe, near) === 'hit', 'ACTIVE 下 30px 内目标 hit');
  ok(checkChargeHit(probe, far) === null, 'ACTIVE 下 95px 外目标不命中（NaN 假阳性回归）');
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

/* ---------- T11 灰显 + HUD 文案 + v2.2 血条常量 ---------- */
console.log('[T11] isModeAvailable（v3.0 六项 IA）+ hudLines 逐字 + HPBAR 布局常量');
{
  const store = new LocalGhostStore();
  ok(isModeAvailable('solo', store) && isModeAvailable('self', store) &&
     isModeAvailable('quit', store), 'solo/self/quit 常亮');
  ok(isModeAvailable('online', store), 'v3.0：联机常亮（进骨架屏，配对联机开发中）');
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
  ok(CONFIG.HP.MAX === 3 && CONFIG.CLASH.DURATION === 0.300 &&
     CONFIG.CLASH.KNOCKBACK === 60 && CONFIG.CLASH.KNOCKBACK_DUR === 0.150,
     'v2.2 数值：maxHP=3 / 弹开 300ms / 击退 60px/150ms');
  // I-40 更正后 FX 参数（v1.0 闪避风格：残影 + 速度线）
  ok(CONFIG.FX.AFTERIMAGE.N === 3 && CONFIG.FX.AFTERIMAGE.GAP === 0.025 &&
     CONFIG.FX.AFTERIMAGE.LIFE === 0.25 &&
     JSON.stringify(CONFIG.FX.AFTERIMAGE.ALPHAS) === JSON.stringify([0.5, 0.35, 0.2]),
     '残影：3 段 / 25ms 间隔 / 250ms / alpha 0.5/0.35/0.2');
  ok(Math.abs(CONFIG.FX.SPEEDLINES.LIFE - 2 / 60) < 1e-9, '速度线：2 帧寿命');
  ok(CONFIG.FX.WINDUP === undefined && CONFIG.FX.BAND === undefined &&
     CONFIG.FX.SPARK === undefined && CONFIG.FX.CRESCENT === undefined,
     'v1.1 FX 参数组已从 CONFIG 删除');
  ok(CONFIG.HIT.FLASH === 0.080 && CONFIG.HIT.SHAKE === 3 && CONFIG.HIT.LOW_PULSE === 0.600,
     'v2.2 受击反馈：白闪 80ms / 微震 3px / 低血脉动 600ms');
  ok(CONFIG.GUARD.MAX_HOLD === 3.0 && CONFIG.GUARD.BLOCK_COOLDOWN === 3.0,
     'v2.3 防御常量：最长 3s / 格挡与满额冷却 3s');
}

/* ---------- T12 Match 集成：无限链 / 败局 / clash / abandon ---------- */
console.log('[T12] Match 集成（solo 无限链 / self 败局 / 对撞弹开 / abandon）');
{
  const mkDeps = () => ({ input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } });

  // —— (a) solo 无限链：木桩 HP=3 → AUTO_ADVANCE → 第 2 关镜像 → 第 3 关 = 上关胜利段 ——
  {
    const deps = mkDeps();
    const seedCalls = [];
    const m = new Match(deps, { mode: 'solo', opp: 'dummy',
                                onLevelWin: (n, rep) => seedCalls.push({ n, rep }) });
    ok(m.level === 'PLAY' && m.levelN === 1 && m.dummy !== null,
       'solo 从第 1 关木桩起（固定站位）');
    ok(m.player.x === CONFIG.SPAWN.PLAYER.x && m.dummy.x === CONFIG.SPAWN.DUMMY.x,
       '固定站位：玩家 (230,360) / 木桩 (1050,360)');
    stub.fireCanvas('mousemove', { clientX: 1130, clientY: 360 });   // 鼠标兜底方向 = +x
    let ticks = 0;
    while (m.level !== 'AUTO_ADVANCE' && ticks < 800) {     // 每帧点左键连冲：木桩 HP=3
      stub.fireCanvas('mousedown', { button: 0 });
      m.update(STEP); ticks++;
    }
    ok(m.level === 'AUTO_ADVANCE' && m.dummy.combat.hp === 0,
       '第 1 关：命中 3 次击碎木桩（HP=3）→ AUTO_ADVANCE（' + ticks + ' 帧）');
    ok(seedCalls.length === 1 && seedCalls[0].n === 1, 'Match 层每关上报 onLevelWin（第 1 关）');
    ok(m.mirrorReplay && m.mirrorReplay.trajectory.length > 0 &&
       m.mirrorReplay.events.some((e) => e.type === 'charge'),
       '教学段录制闭合 → 第 2 关幽灵来源');
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

  // —— (c) self 败局：镜像幽灵冲向玩家，3 次命中 → HP 归 0 → finish(lose) ——
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
    ok(Math.abs(m.ghost.x - (CONFIG.VIEW.W - gx)) < 1e-6,
       '镜像轨迹：录制 x=990 → 幽灵 x=290（逐帧 x\'=1280−x）');
    let ticks = 0;
    while (!m.ended && ticks < 600) { m.update(STEP); ticks++; }
    ok(m.ended && ended && ended.r === 'lose', '被幽灵 3 次命中（HP 归 0）→ finish(lose)');
    ok(m.player.combat.hp === 0, '玩家 HP=0 才进死亡流程');
    ok(ended.rep && ended.rep.trajectory.length > 0, '败局产出 replay（分段录制）');
    // 镜像方向联动：dirAngle=0（朝右）→ 幽灵 facing=π（朝玩家侧）
    ok(Math.abs(m.ghost.facing - Math.PI) < 1e-6 || m.ghost.combat.phase === 'IDLE',
       '幽灵冲撞方向镜像朝玩家侧（dirAngle 0 → π）');
  }

  // —— (d) 对撞弹开：同 tick 起手 → 双方 CLASH、HP 不减、无 DRAW ——
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
    // 白盒摆位：玩家拉到幽灵左侧 32px，同 tick 互冲
    m.player.x = 1000; m.player.y = 360;
    const t0 = m.tick;
    m.player.combat.startCharge({ x: 1, y: 0 }, t0);
    m.ghost.combat.startCharge({ x: -1, y: 0 }, t0);
    let ticks = 0;
    while (!(m.player.combat.phase === 'CLASH' && m.ghost.combat.phase === 'CLASH') && ticks < 60) {
      m.update(STEP); ticks++;
    }
    ok(m.player.combat.phase === 'CLASH' && m.ghost.combat.phase === 'CLASH',
       '同 tick 对撞 → 双方进 CLASH 弹开（无 DRAW 触发）');
    ok(m.player.combat.hp === 3 && m.ghost.combat.hp === 3, '对撞双方 HP 不减');
    ok(m.level === 'PLAY' && endCalls === 0, '对撞不掉血、无 DRAW、无结算');
    ok(len(m.ghost.x - m.player.x, m.ghost.y - m.player.y) >= 32 - 1e-6,
       '弹开后位置分离无重叠');
    ticks = 0;
    while ((m.player.combat.phase === 'CLASH' || m.ghost.combat.phase === 'CLASH') && ticks < 40) {
      m.update(STEP); ticks++;
    }
    ok(m.player.combat.phase === 'IDLE' && m.ghost.combat.phase === 'IDLE',
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

/* ---------- T13 攻击特效运行时断言（I-40 更正：v1.0 闪避风格残影 + 速度线） ---------- */
console.log('[T13] FX 运行时：冲撞残影 3 段 / 起手速度线 / 对撞双环 / 无拉丝光带星芒月牙');
{
  const fx = new FXSystem();
  fx.queue.push({ type: 'charge_speedlines', x: 100, y: 100, ang: 0 });
  fx.queue.push({ type: 'charge_afterimages', x: 200, y: 100, ang: 0, r: 16, color: '#ffe9c4' });
  fx.queue.push({ type: 'clash_ring', x: 300, y: 200 });
  fx.queue.push({ type: 'clash_ring', x: 340, y: 200 });
  fx.flush();
  ok(fx.speedlines.length === CONFIG.FX.SPEEDLINES.N, '起手速度线 ' + CONFIG.FX.SPEEDLINES.N + ' 条入队');
  ok(Math.abs(fx.speedlines[0].maxLife - 2 / 60) < 1e-9, '速度线寿命 2 帧');
  ok(fx.afterimages.length === 3, '冲撞残影 3 段入队');
  ok(Math.abs(fx.afterimages[0].maxLife - 0.25) < 1e-9, '残影寿命 250ms');
  ok(fx.afterimages[0].alpha === 0.5 && fx.afterimages[1].alpha === 0.35 &&
     fx.afterimages[2].alpha === 0.2, '残影透明度 0.5/0.35/0.2');
  const step = CONFIG.CHARGE.DASH_SPEED * CONFIG.FX.AFTERIMAGE.GAP;   // 42px/段
  ok(Math.abs(fx.afterimages[1].x - (200 + step)) < 1e-9 &&
     Math.abs(fx.afterimages[2].x - (200 + step * 2)) < 1e-9 &&
     fx.afterimages[1].y === 100,
     '残影沿冲撞方向 42px/段排布（1680×0.025）');
  ok(fx.rings.length === 2 && Math.abs(fx.rings[0].r1 - 40) < 1e-9 &&
     Math.abs(fx.rings[0].maxLife - 0.200) < 1e-9, '对撞弹开双环 r0→40px 200ms');
  // 残影整体渐隐 + 250ms 消退
  fx.update(0.125);
  ok(fx.afterimages.length === 3 && fx.afterimages[0].life < fx.afterimages[0].maxLife,
     '残影随寿命渐隐（125ms 时仍在）');
  fx.update(0.13);
  ok(fx.afterimages.length === 0, '残影 250ms 后消退');
  ok(fx.speedlines.length === 0, '速度线 2 帧即消退');
  // 无 v1.1 通道（源码级断言在 T0，此处防运行时复活）
  ok(fx.streaks === undefined, 'streaks 通道已从 FXSystem 删除');
}

/* ---------- T14 OrbAI 契约（v3.0 ADR-009：快照冻结 / 异常空输入 / click0 一次消费 / 内置 AI 策略） ---------- */
console.log('[T14] OrbAI 契约：snapshotView 深冻结 / AIInput 同通路 / 异常降级 / 内置 AI 策略');
{
  /* 公共 helper：静止 AI（不移动不冲撞不举盾） */
  const mkStubIdle = (seat) => new AIInput(
    { name: 'idle', think() { return { move: { x: 0, y: 0 }, click0: false, guardHeld: false }; } }, seat);
  // —— (a) snapshotView：视角切换 + 深冻结 ——
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
    ok(s1.self.hp === 3 && s1.opp.hp === 3 && s1.tick === m.tick,
       '快照含 hp / tick');
    ok(s1.self.guardCd === 0 && s1.opp.guardCd === 0, '无冷却时 guardCd=0');
    ok(typeof s1.arena.CHARGE_DISTANCE === 'number' &&
       Math.abs(s1.arena.CHARGE_DISTANCE - CONFIG.CHARGE.DASH_SPEED * CONFIG.CHARGE.ACTIVE / 1000) < 1e-9,
       'arena.CHARGE_DISTANCE = 1680×0.100 = 168px');
    ok(s1.arena.BALL_R === CONFIG.BALL.R && s1.arena.HIT_R === CONFIG.CHARGE.HIT_R &&
       s1.arena.HIT_OFFSET === CONFIG.CHARGE.HIT_OFFSET &&
       s1.arena.W === CONFIG.VIEW.W && s1.arena.H === CONFIG.VIEW.H,
       'arena 常量齐备（BALL_R/HIT_R/HIT_OFFSET/W/H）');
    let frozen = true;
    try {
      s1.self.x = 999; s1.opp.phase = 'HACK'; s1.arena.W = 0; s1.self.chargeDir.x = 9;
    } catch (e) { /* 严格模式静默失败也算冻结成功 */ }
    frozen = s1.self.x !== 999 && s1.opp.phase !== 'HACK' && s1.arena.W !== 0;
    ok(frozen, '快照深冻结：AI 篡改快照不影响世界（Object.freeze）');
  }

  // —— (b) AIInput 同通路：think 决策经 Player 消费触发冲撞 ——
  {
    let asked = 0;
    const impl = { name: 'stub', think() { asked++; return { move: { x: 1, y: 0 }, click0: true, guardHeld: false }; } };
    const ai = new AIInput(impl, 'P1');
    /* 独立接口测试（fakeMatch 提供 snapshotView，隔离于 Match 集成） */
    const fakeMatch = { snapshotView: (seat) => ({ tick: 0,
      self: { x: 0, y: 0, phase: 'IDLE', hp: 3, guardCd: 0, chargeDir: { x: 1, y: 0 } },
      opp: { x: 100, y: 0, phase: 'IDLE', hp: 3, guardCd: 0, chargeDir: { x: -1, y: 0 } },
      arena: { W: 1280, H: 720, BALL_R: 16, HIT_R: 20, HIT_OFFSET: 18, CHARGE_DISTANCE: 168 } }) };
    ai.beginTick(fakeMatch);
    ok(asked === 1, 'beginTick 每 tick 恰好 think 一次（快照在消费前生成）');
    ok(ai.getMoveAxis().x === 1, 'AI 决策经 Input 同接口消费（move）');
    ok(ai.consumeClick(0) === true && ai.consumeClick(0) === false, 'click0 帧内一次消费');
    ok(ai.isDown('KeyR') === false, 'AI 无按键语义（isDown 恒 false）');
    /* Match 集成：AI 输入驱动 Player 冲撞（p1Input 通路） */
    const deps = { input: new Input(stub.canvas), fx: new FXSystem(), audio: { play() {} } };
    const m = new Match(deps, { mode: 'demo', p1Input: new AIInput(impl, 'P1'),
                                p2Input: mkStubIdle() });
    m.update(STEP);                     // 顶部 beginTick → Player.update 消费 click0
    ok(m.player.combat.phase === 'CHARGE_WINDUP', 'AI click0 经 Player 同通路触发冲撞');
    ok(m.p2.combat.phase === 'IDLE', 'P2 静止 AI 不受影响');
  }

  // —— (c) 异常降级：think 抛错 → 空输入 + 不判负不崩局（ADR-009） ——
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
    ok(ai.getMoveAxis().x === 0 && ai.getMoveAxis().y === 0 && ai.guardHeld() === false,
       '异常帧输入 = 全空');
  }

  // —— (d) 冷却期 guardHeld 忽略：Combat 层拒绝（AI 与人类同规则） ——
  {
    const p = new Player(100, 100);
    const T14_GAME = { fx: { queue: [] } };   // guard_denied 负反馈通道桩
    /* 可编程 AI：script 队列决定每帧决策（白盒驱动防御流；fakeMatch 供快照） */
    const script = [];
    const impl = { name: 'scripted', think() {
      return script.length ? script.shift()
                           : { move: { x: 0, y: 0 }, click0: false, guardHeld: false };
    } };
    const ai = new AIInput(impl, 'P1');
    const fakeMatch = { snapshotView: () => ({ tick: 0,
      self: { x: 0, y: 0, phase: 'IDLE', hp: 3, guardCd: 0, chargeDir: { x: 1, y: 0 } },
      opp: { x: 100, y: 0, phase: 'IDLE', hp: 3, guardCd: 0, chargeDir: { x: -1, y: 0 } },
      arena: { W: 1280, H: 720, BALL_R: 16, HIT_R: 20, HIT_OFFSET: 18, CHARGE_DISTANCE: 168 } }) };
    const G = () => ({ move: { x: 0, y: 0 }, click0: false, guardHeld: true });
    const R = () => ({ move: { x: 0, y: 0 }, click0: false, guardHeld: false });
    script.push(G());
    ai.beginTick(fakeMatch); p.update(STEP, ai, T14_GAME);
    ok(p.combat.phase === 'GUARD', 'AI guardHeld=true → 举盾');
    for (let i = 0; i < 5; i++) { script.push(G()); ai.beginTick(fakeMatch); p.update(STEP, ai, T14_GAME); }
    ok(p.combat.phase === 'GUARD' && p.combat.t > 0, '持续举盾 6 帧（t = 已防御时长）');
    script.push(R());                    // 松开 → manual 冷却 = 已防御时长
    ai.beginTick(fakeMatch); p.update(STEP, ai, T14_GAME);
    const cd = p.combat._coolDur;
    ok(p.combat.phase === 'GUARD_RELEASE' && cd > STEP, 'manual 松开进入冷却通道（cd = 举盾时长）');
    let rejected = true;
    for (let i = 0; i < 3 && p.combat.phase === 'GUARD_RELEASE'; i++) {
      script.push(G());                  // 冷却期内重新按住
      ai.beginTick(fakeMatch); p.update(STEP, ai, T14_GAME);
      if (p.combat.phase === 'GUARD') { rejected = false; break; }
    }
    ok(rejected, '冷却期 guardHeld=true 被 Combat 拒绝（AI 与人类同规则）');
  }

  // —— (e) 内置 AI 策略 + compileAICode + AISlotStore ——
  {
    const builtin = createBuiltinAI();
    ok(builtin.name === '内置示例' && typeof builtin.think === 'function', '内置 AI 工厂');
    const mkSnap = (dist, oppPhase, tick) => ({
      tick,
      self: { x: 0, y: 0, phase: 'IDLE', hp: 3, guardCd: 0, chargeDir: { x: 1, y: 0 } },
      opp: { x: dist, y: 0, phase: oppPhase, hp: 3, guardCd: 0, chargeDir: { x: -1, y: 0 } },
      arena: { W: 1280, H: 720, BALL_R: 16, HIT_R: 32, HIT_OFFSET: 40, CHARGE_DISTANCE: 168 },
    });
    let d = builtin.think(mkSnap(300, 'IDLE', 10));
    ok(d.move.x === 1 && d.click0 === false, '远距 300px：追踪不冲撞');
    d = builtin.think(mkSnap(200, 'IDLE', 10));
    ok(d.click0 === true, '近距 200px + 对手 IDLE → 冲撞');
    d = builtin.think(mkSnap(200, 'GUARD', 10));
    ok(d.click0 === false, '对手 GUARD → 不冲撞（防御态不列 vulnerable）');
    d = builtin.think(mkSnap(200, 'CHARGE_WINDUP', 10));
    // 30% 概率触发 30 tick 举盾；无论触发与否决策合法
    ok(d.move.x === 1 && typeof d.guardHeld === 'boolean', '对手起手：决策合法（举盾概率 30%）');

    const aiObj = compileAICode("{ name:'t', think(state){ return { move:{x:0,y:0}, click0:false, guardHeld:false }; } }");
    ok(typeof aiObj.think === 'function' && aiObj.name === 't', '控制台代码串可编译为 AI 对象');
    let threw = false;
    try { compileAICode('({})'); } catch (e) { threw = true; }
    ok(threw, '缺 think → 编译拒绝');
    threw = false;
    try { compileAICode('({think('); } catch (e) { threw = true; }
    ok(threw, '语法错误 → 编译拒绝');
  }
}

/* ---------- T15 无头对局（v3.0 §1.3：Node 双 AI 跑到 match_end，零 DOM） ---------- */
console.log('[T15] 无头双 AI 对局：内置 AI 对局到 match_end + HP=3 击杀路径 + 超时裁决');
{
  const mkIdle = (seat) => new AIInput(
    { name: 'idle', think() { return { move: { x: 0, y: 0 }, click0: false, guardHeld: false }; } }, seat);
  // —— (a) 内置 AI vs 静止 AI：追踪+冲撞 → 3 次命中 → P1 胜（确定路径） ——
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
  ok(r.ended.seat === 'P1', '内置 AI 追踪静止对手 → P1 胜（seat 通道）');
  ok(r.ended.replay === null, 'demo 收束不产 replay（零 Recorder）');
  ok(r.m.p2.combat.phase === 'DEAD' && r.m.p2.combat.hp === 0,
     '败者 HP=0 且进 DEAD（HP=3 击杀路径）');
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

/* ---------- T16 触屏纯逻辑（v3.0 ADR-010：Joystick/Button/TouchSource，node 事件桩喂值） ---------- */
console.log('[T16] 触屏：摇杆死区/全速/knobOffset / 按钮 click0/滑出松开 / pointerId 隔离 / Input 聚合');
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
    ok(b.consumeClick() === false, 'click0 一次消费');
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

  // —— (c) TouchSource：pointerId 隔离分配 ——
  {
    const ts = new TouchSource();
    ts.pointerDown(10, 200, 300);       // 左半屏 → 摇杆
    ok(ts.joystick.pointerId === 10, '左半屏手指 → 摇杆');
    ts.pointerDown(11, 1150, 620);      // 攻击钮区
    ok(ts.btnAtk.pointerId === 11 && ts.btnAtk.pressed, '钮区手指 → 攻击钮');
    ts.pointerDown(12, 1000, 660);      // 防御钮区
    ok(ts.btnGuard.pointerId === 12 && ts.btnGuard.pressed, '钮区手指 → 防御钮');
    ts.pointerMove(10, 260, 300);
    ok(Math.abs(ts.moveAxis().x - 1) < 1e-9, '摇杆手指移动 → 轴输出');
    ok(ts.guardHeld() === true, '防御钮按住 → guardHeld');
    ok(ts.consumeClick(0) === true, '攻击钮 → click0');
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
    // 触屏攻击点击聚合
    input.touch.btnAtk.down(5);
    ok(input.consumeClick(0) === true, '触屏点击经 Input.consumeClick 聚合消费');
    input.touch.joystick.end(5);
  }
}

/* ---------- T17 菜单 IA（v3.0：五项 DOM + 二级屏/AI 编辑屏删净 + 联机骨架置灰） ---------- */
console.log('[T17] 菜单 IA：五项 DOM / scr-boss+scr-ai 删净 / 联机骨架置灰 / 触屏与 OrbAI 要素');
{
  const html = fs.readFileSync(HTML, 'utf8');
  const acts = ['solo', 'online', 'self', 'boss_solo', 'quit'];
  const menuOk = acts.every((a) => html.includes('data-act="' + a + '"'));
  ok(menuOk, '主菜单五项 data-act 齐备（solo/online/self/boss_solo/quit）');
  ok(!html.includes('data-act="boss"') && !html.includes('data-act="ai"') &&
     !html.includes('id="scr-boss"') && !html.includes('id="scr-ai"'),
     '二级 boss 屏与 AI 编辑屏 DOM 删净（AI 保留为控制台 API）');
  ok(html.includes('id="scr-online"') && html.includes('配对联机开发中') &&
     /class="mi dis" data-ol="create"/.test(html) &&
     /class="mi dis" data-ol="join"/.test(html),
     '联机骨架：置灰按钮 + 「配对联机开发中」提示');
  ok(html.includes('data-ol="back"'), '联机屏返回入口');
  ok(html.includes('id="touchui"') && html.includes('id="joy-base"') &&
     html.includes('id="joy-knob"') && html.includes('id="tbtn-atk"') &&
     html.includes('id="tbtn-guard"'), '触屏控件 DOM 齐备');
  ok(html.includes('id="portrait-mask"') && html.includes('请横屏游玩'),
     '竖屏遮罩 DOM');
  ok(/user-scalable=no/.test(html) && /viewport-fit=cover/.test(html) &&
     /touch-action:\s*none/.test(html), '移动 viewport + touch-action 锁定');
  ok(html.includes('window.OrbAI') && html.includes('startMatch') &&
     html.includes('stopMatch'), 'window.OrbAI 控制台 API 挂载');
}

console.log('\n========================================');
console.log(`TOTAL: ${pass + fail} | PASS: ${pass} | FAIL: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
