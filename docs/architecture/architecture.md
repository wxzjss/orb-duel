# 「光球对决」主架构文档

版本 v1.0 · 作者 程基岩 · 状态：已评审通过（lean）
引擎：HTML5 Canvas 2D + 原生 JS（无框架/无构建/无资产）
关联 GDD：concept / controls / attack / dodge / mirror-ai / level-flow / fx

---

## 1. 总览

单 HTML 文件，内嵌 `<script>` 分节组织为 8 个模块（见 ADR-002）。一个固定时间步长主循环驱动"逻辑 → 判定 → FX 事件 → 渲染"单向数据流。全局唯一 `Game` 实例持有全部子系统引用，模块间禁止隐式全局变量（IIFE 包裹，显式传引用）。

**行数预算**：总 ≤ 2500 行（含 HTML/CSS）。超出即警示设计漂移。

## 2. 模块划分

```
┌─ index.html
│   <style>     画布居中、黑底、缩放 CSS（~20 行）
│   <canvas id="game" width="1280" height="720">
│   <script>（IIFE 内按节组织）
│   §1 Config      全部数值常量（唯一真源，禁散落魔法数）
│   §2 Utils       clamp/lerp/len/norm/angleTo（纯函数）
│   §3 Input       键鼠输入系统
│   §4 Entities    Ball / Player / Dummy / GhostPlayer
│   §5 Combat      战斗状态机 + 命中判定
│   §6 Recorder    轨迹录制 / 回放数据
│   §7 FX          粒子池 + 特效播放器
│   §8 Audio       Web Audio 预留接口（Should 级，可为空实现）
│   §9 Game        主循环 + 关卡状态机 + 渲染
```

### 2.1 Config（§1）

```js
const CONFIG = {
  VIEW: { W: 1280, H: 720 },
  STEP: 1 / 60,               // 固定逻辑步长（秒）
  BALL: { R: 16, SPEED: 320 },
  ATTACK: { WINDUP: 0.080, ACTIVE: 0.070, RECOVERY: 0.120,
            DASH_SPEED: 900, HIT_R: 20, HIT_OFFSET: 18 },
  DODGE: { DASH_SPEED: 1200, DURATION: 0.110, COOLDOWN: 0.500 },
  SPAWN: { PLAYER: {x:230,y:360}, DUMMY: {x:1050,y:360} },
  FX: { POOL: 300 },
  BANNER: { CLEAR_DUR: 1.2, DRAW_DUR: 0.6 },
  HITSTOP: 0.120,
};
```

### 2.2 Input（§3）

```js
class Input {
  // 键盘：keydown/keyup 记入 held 集合；支持 WASD + 方向键
  // 鼠标：canvas 上监听 mousedown(button 0/2)、mousemove（记录屏幕坐标，
  //       经逆缩放换算为逻辑坐标）、contextmenu preventDefault
  isDown(code)          // e.g. KeyW / ArrowUp
  getMoveAxis()         // -> {x, y}，归一化对角
  consumeClick(btn)     // 帧内消费一次点击（0=左键攻击 2=右键闪避），返回 bool
  getAim()              // -> {x, y} 鼠标逻辑坐标（攻击方向）
}
```

要点：攻击/闪避用**帧内消费**（consume 语义），避免同帧重复触发；移动用 held 状态连续查询。

### 2.3 Entities（§4）

```js
class Ball {                       // 玩家/木桩/幽灵共用基类
  x, y, r                          // 位置与半径
  facing                           // 朝向角（攻击判定圈方向）
  state                            // 战斗状态机引用（见 §5）
  trail: Array<{x,y,life}>         // 移动拖尾采样点
}
class Player extends Ball {        // Input 驱动：移动/攻击/闪避意图 → Combat
  update(dt, input, game)
}
class Dummy extends Ball {         // 不 update 移动，无攻击；仅可被命中
}
class GhostPlayer extends Ball {   // 回放驱动，见 §3 接口
}
```

移动实现：无惯性——`pos += dir * SPEED * dt`，dir 为归一化输入轴。

### 2.4 Combat 战斗状态机（§5）

```js
const CombatState = { IDLE, WINDUP, ACTIVE, RECOVERY, DODGE, DEAD };
class Combat {
  phase, t                         // 当前阶段与阶段内计时
  dashFrom, dashTo                 // ACTIVE/DODGE 期间插值端点（保证位移精确）
  dodgeCd                          // 闪避冷却剩余
  startAttack(dirAngle)            // IDLE/WINDUP 才可进入（GDD 允许的连招边界）
  startDodge(dirAngle)             // 任意非 DEAD 相位可进入；冷却中拒绝
  update(dt, owner, game)          // 推进相位；WINDUP→ACTIVE→RECOVERY→IDLE
  canBeHit()                       // DEAD 或 DODGE（无敌帧全程）→ false
}
```

关键实现约定：
- 突进位移用**端点插值**而非速度积分：`pos = lerp(dashFrom, dashTo, t/dur)`，确保 900×0.07≈63px 精确、不随掉帧漂移。
- ACTIVE 期间每步做命中检测（见数据流）；DODGE 进入时若处于 ACTIVE，直接覆盖相位（即"闪避取消判定帧"）。
- dodgeCd 在 DODGE 结束时置 COOLDOWN，随 dt 递减。
- 攻击方向：`facing = atan2(aim.y - y, aim.x - x)`，在 startAttack 时锁定。

### 2.5 Recorder / 回放（§6）—— 技术核心

```js
class Recorder {
  frames: Float32Array             // 增长式缓冲：每逻辑帧 [x, y]
  events: [{t, type, dirAngle}]    // t=帧索引（tick number，非秒，避免浮点累积误差）
  tickCount: 0
  begin()                          // TUTORIAL 进入时调用：清空、开始逐帧采样
  recordAction(type, dirAngle)     // 由 Combat 状态迁移回调触发，记 {t: tickCount, ...}
  finalize() -> {
    duration,        // 秒，= tickCount * STEP
    trajectory: Float32Array,      // 长度 = 2*tickCount，偶位 x 奇位 y
    events: [...]                  // 按 t 升序
  }                                // TUTORIAL_CLEAR 时调用；平局/死亡重开不重录
}

class GhostPlayer extends Ball {
  constructor(replay, offsetX, offsetY)   // offset = 幽灵出生点 - 玩家出生点
  update(tick) {                   // 入参为关卡内逻辑帧号
    const T = replay.trajectory.length / 2
    const i = 2 * (tick % T)                  // t mod T 循环回放
    this.x = replay.trajectory[i]     + offsetX
    this.y = replay.trajectory[i+1]   + offsetY
    // 事件回放：维护 eventPtr，逐个推进 while(events[ptr].t <= tick%T)
    //   type 'attack' → 进入 WINDUP/ACTIVE，方向实时 = atan2(player - this)（每帧重算，不锁录制角）
    //   type 'dodge'  → 原样回放录制 dirAngle
  }
}
```

要点：事件 t 用整数帧号，杜绝浮点比较；幽灵攻击**实时瞄准**是镜像 AI 的难度来源，录制的只是时机。

### 2.6 FX（§7）

```js
class Particle { x,y,vx,vy,life,maxLife,size,hue,alive }
class FXSystem {
  pool: Particle[300]              // 预分配（ADR-004），freeList 索引栈
  emit(type, x, y, opt)            // type: 'trail'|'afterimage'|'crescent'|'burst'|'spark'
  queue: []                        // Game 帧末 flush：逻辑期只入队，渲染期统一播放
  update(dt)                       // 粒子推进，alive=false 回收
  render(ctx)                      // ctx.globalCompositeOperation='lighter'
}
```

月牙光刃（crescent）为路径绘制（arc 双弧夹成月牙形 + 渐隐），非粒子，但同样走 queue 统一调度。

### 2.7 Audio（§8，Should 级）

```js
class AudioBus {
  ctx: null                        // 首次用户交互后 lazy init（自动播放策略）
  play(name)                       // 'attack'|'dodge'|'death'|'clear'
  // v1 空实现或纯 Web Audio 振荡器合成（无资产）；接口先钉死
}
```

### 2.8 Game（§9）

```js
class Game {
  input, fx, audio
  player, dummy, ghost             // ghost 仅 LEVEL1 存在
  recorder
  level: 'BOOT'|'TUTORIAL'|'TUTORIAL_CLEAR'|'LEVEL1'|'DRAW'|'VICTORY'|'DEATH'
                                   // TUTORIAL_CLEAR 与 DRAW 共用 bannerTimer 计时通道
  timeScale = 1                    // hitstop/慢放：dt *= timeScale，全局唯一入口
  accumulator = 0
  loop(now)                        // rAF；见 §4 数据流
  update(dt)                       // 固定步逻辑
  render(alpha)                    // 直接渲染最新逻辑态（见 ADR-001）
  onDeath(victim)                  // 命中回调：hitstop → 切 DEATH/VICTORY
}
```

关卡状态机迁移（对应 level-flow GDD）：

```
BOOT ─点击开始→ TUTORIAL(recorder.begin)
TUTORIAL ─木桩死亡→ TUTORIAL_CLEAR {recorder.finalize, timeScale=0 hitstop 120ms,
                                     横幅 1.2s} ─→ LEVEL1(spawn GhostPlayer(replay, …))
LEVEL1 ─幽灵死→ VICTORY                          ─R→ LEVEL1（重开沿用同一 replay，不重录）
LEVEL1 ─玩家死→ DEATH                            ─R→ LEVEL1（同上）
LEVEL1 ─同帧互杀→ DRAW {双方死亡爆裂 + 120ms hitstop,
                        横幅「同归于尽」600ms，期间输入忽略、实体冻结渲染（尸体粒子照播）}
DRAW ─600ms 到→ LEVEL1（自动重进，replay 不重录、offset 不变）
```

出生点与 offset 推导（主理人汇编时已裁定，实现必须按 Config 推导，勿硬编码）：
- 教学关：玩家出生 (230,360)，木桩 (1050,360)。
- 第一关（主客互换）：玩家重生 (1050,360)，幽灵出生 (230,360)。
- offset = 幽灵出生点 − 玩家教学关出生点 = (230−230, 360−360) = **(0, 0)**——幽灵原样重走你走过的路。

## 3. 数据流图

```
rAF(now)
  │
  ├─ accumulator += min(now - last, 0.25)     ← 防死亡螺旋钳制
  │  while (accumulator >= STEP):
  │   ┌──────────────── 一次逻辑更新（dt = STEP × timeScale）────────────────┐
  │   │ Input.consumeClick / getMoveAxis                                    │
  │   │        ↓                                                           │
  │   │ Player.update ──意图──→ Combat.update（相位推进/取消/冷却）            │
  │   │ GhostPlayer.update(tick)（轨迹回放 + 实时瞄准攻击）                    │
  │   │        ↓                                                           │
  │   │ HitResolver: 遍历攻击方 ACTIVE →                                    │
  │   │   hitCircle(r20 @ 前方18px偏移) vs target.bodyCircle(r16)           │
  │   │   相交 && target.canBeHit() → onDeath（仅判一次，标记 DEAD）          │
  │   │        ↓                                                           │
  │   │ fx.queue.push(事件)   ← 逻辑期不直接碰粒子                            │
  │   └────────────────────────────────────────────────────────────────────┘
  │
  ├─ FXSystem.flush(queue) → emit 粒子；FXSystem.update(dt)；AudioBus.play
  ├─ render()：clear → 'lighter' 粒子层 → 光球/拖尾/残影/月牙 → UI 横幅
  └─ Canvas 缩放：外层 CSS 等比 letterbox，内部逻辑坐标恒 1280×720
```

## 4. 目录/文件结构与分发方案

**决策：单文件 `index.html`，无其他文件**（详见 ADR-002）。仓库结构：

```
/ 光球对决/
  index.html          # 全部代码
  docs/architecture/  # 本文档 + adrs.md
  design/gdd/         # 已有
```

## 5. 控制清单（程序员可立即执行的一页规则）

1. 所有数值**只写 CONFIG**，禁止在逻辑代码里出现 320/900/0.080 等裸常量。
2. 逻辑更新只读 Input、只写自身与 fx.queue；**禁止在逻辑期调用渲染/粒子生成**。
3. 事件 t 一律用整数 tick，禁止用秒做录制时间轴。
4. 突进类位移（攻击/闪避）必须端点插值，禁止速度积分。
5. timeScale 只在 Game.update 入口乘一次，任何子系统不得自行缩放 dt。
6. 敌我双方同帧互杀时，判定顺序固定：先玩家判幽灵，后幽灵判玩家，不短路；双方同死 → 标记 DEAD → 走 DRAW 自动重开（600ms 横幅，输入忽略，尸体粒子照播，replay 数据不重录）。单人被杀才走 DEATH 等 R。禁止在 DRAW 期间发生任何 Combat 相位迁移（断言）。
7. `contextmenu` 在 canvas 上 preventDefault；音频 ctx 必须在首次 pointerdown 后创建。
8. 每个 Combat 相位边界写 console.assert（开发期），提交前由断言无失败确认。
9. 渲染前必须 `ctx.save()/restore()` 配对；'lighter' 用完立刻还原。

## 6. 实现顺序（六步，每步可玩可测）

1. 主循环 + 输入 + 光球移动（能看到动）
2. 战斗状态机 + 命中判定（能杀木桩）
3. Recorder + TUTORIAL_CLEAR 流程
4. GhostPlayer 回放（镜像 AI）
5. FX 粒子池全套特效
6. 横幅 / 音频 / 打磨

每步可玩、可测，出问题回退到上一步。
