# 架构补丁 v1.1「冲撞与格挡」

基于 v1.0 架构（含 DRAW 修订）的增量补丁。规格以 E-11 任务消息为准；与 design-strategist 并行修订的 GDD 若有出入，以本补丁 §6 标注项对齐。

---

## 1. Combat 状态机改造（§2.4 替换）

```js
const CombatState = { IDLE, CHARGE_WINDUP, CHARGE_ACTIVE, CHARGE_RECOVERY,
                      GUARD, GUARD_RELEASE, BOUNCE, DEAD };
class Combat {
  phase, t                         // 相位与相位内计时
  startTick                        // 本次冲撞的起手帧号（Game.tick，裁决用）
  chargeDir                        // 冲撞方向（起手时锁定）
  dashFrom, dashTo                 // CHARGE_ACTIVE 端点插值（1400×0.120=168px 精确位移）
  guardDebounce                    // GUARD_RELEASE 剩余（200ms）
  // 相位迁移规则：
  // IDLE + 左键点击 + chargeDir 有效 → CHARGE_WINDUP（记录 startTick=当前tick, chargeDir）
  //   → 70ms → CHARGE_ACTIVE（计算 dashFrom/dashTo）→ 120ms → CHARGE_RECOVERY
  //   → 150ms → IDLE。注意 70+120+150=340ms 即"总冷却"本体，RECOVERY 结束后【不追加】额外冷却计时。
  // IDLE + guardReady() → GUARD（移动锁定、不可冲撞、无时限）
  // GUARD + 松开右键 → GUARD_RELEASE（200ms，防抖期可移动/可冲撞，但【不可再次进入 GUARD】）
  //   → 200ms → IDLE
  // 收到命中事件（见 HitResolver）：
  //   作为攻击者撞上防御者 GUARD → BOUNCE（400ms，dash 立即停在当前位置，不做击退 v1）
  //   作为防御者被命中且非 GUARD → DEAD
  // BOUNCE 可被对方正常命中（可反击窗口）；BOUNCE 结束 → IDLE
}
```

**旧相位迁移**：WINDUP/ACTIVE/RECOVERY → 一对一改名为 CHARGE_*，语义与插值机制不变；**DODGE 及其无敌帧、500ms 冷却、可取消判定帧的机制全部删除**，相关常量/特效（afterimage 中闪避触发路径）/输入路径不得留死代码。

**边界裁定（技术侧补全，已发 design-strategist 确认）**：
- GUARD 仅可从 IDLE 进入；CHARGE_* 各相位中按住右键无效，不做"后摇中抢盾"。
- GUARD 的格挡仅对"冲撞判定圈命中"生效，仅可挡第一次（格挡成功即姿态结束，无第二次）。
- GUARD 期间玩家不死不可能成立（唯一伤害源是冲撞且已被挡），无需额外无敌帧概念。

## 2. 对撞裁决与 HitResolver 改造（§3 数据流中"命中判定"环节替换）

```js
class HitResolver {
  // 每逻辑步原子流程（Game.update 内固定位置，tick 递增之后）：
  // Step1 收集：对每个处于 CHARGE_ACTIVE 的实体，检测判定圈命中对方本体圈。
  //   产出 events: [{attacker, defender, kind:'hit'|'guard'}]
  //   kind='guard' 当且仅当 defender.phase===GUARD（首挡即姿态结束，由裁决方统一处理）
  // Step2 裁决（本步内完成，禁止跨帧分判）：
  //   双方均 hit        → 比较 startTick：后起手者（startTick 大）胜，先起手者死；
  //                        startTick 相等 → 双方 DEAD → 走 DRAW（600ms 横幅自动重开，沿用 v1.0 修订）
  //   单方 hit + 对方 guard → 攻击者 → BOUNCE；防御者 → GUARD 结束（shield_break fx）
  //   单方 hit           → 防御者 DEAD
  //   无事件             → 无操作
  // Step3 分配：按裁决一次性写入双方相位（DEAD/BOUNCE/GUARD 退出），并推送 fx 事件。
}
```

数据结构：`startTick` 取自 Game 全局 tick 计数（整数），与 Recorder 事件 t 同源同轴——录制与裁决共用同一时间轴是本次改造的关键约束。
判定时序：先双实体 update（相位推进，本 tick 新进入 CHARGE_ACTIVE 的实体 startTick=本 tick）→ HitResolver → fx 队列 flush。
"先玩家判幽灵、后幽灵判玩家"的旧顺序规则**作废**，由 Step2 对称裁决取代；DRAW 规则保留但触发条件从"判定圈同帧相交"改为"startTick 相等的互撞"。

## 3. Recorder / GhostPlayer 接口变更（§2.5 增量）

```js
// Recorder.recordAction(type, dirAngle?) 事件类型变更：
//   {t, type:'charge', dirAngle}        // dirAngle = 起手锁定的冲撞方向
//   {t, type:'guard_begin'}             // 无方向参数
//   {t, type:'guard_end'}
// 'attack'/'dodge' 类型删除。guard 事件由 Player 在 GUARD 进入/退出迁移处上报：
//   guard_begin 记 IDLE→GUARD 那一 tick；guard_end 记 GUARD→GUARD_RELEASE 那一 tick（松开即记，非防抖结束）。

class GhostPlayer {
  // update(tick) 事件处理逻辑变更：
  //   'charge'      → 若 IDLE：进入 CHARGE_WINDUP，方向 = 录制 dirAngle【纯复刻，取消 atan2 实时瞄准】
  //                   若在 BOUNCE/GUARD/其他相位：事件【丢弃】（技术侧裁定：不做补发队列，
  //                     保证幽灵节奏确定可读；一次丢事件只损失一次进攻机会，不破坏镜像结构）
  //   'guard_begin' → 若 IDLE：进入 GUARD；否则丢弃
  //   'guard_end'   → 若 GUARD：退出（→GUARD_RELEASE，200ms 防抖与玩家一致）；否则幂等无操作
  //     （幂等是必须的：幽灵格挡成功破盾时相位已由 HitResolver 强制退出，后续录制 guard_end 不得报错）
  // 幽灵 BOUNCE：由 HitResolver 统一分配（与玩家同一条裁决路径），BOUNCE 结束回 IDLE 后
  //   事件指针从当前 tick 继续——不回溯、不快进，错过的事件按上述规则丢弃。
}
```

要点：幽灵冲撞方向纯复刻后，"实时瞄准"的镜像 AI 模糊性来源消失，镜像变为**全确定性**（轨迹+动作+方向全部来自录制）——ADR-003 中"不可用于完全确定性重放"的后果条目随之失效，回放严格镜像玩家教学关操作。难度调节改由 offset 与关卡参数承担（设计侧议题，不属本补丁）。

## 4. Input 变更（§2.2 增量）

```js
class Input {
  // 删除：consumeClick(2)（右键点击语义）
  // 保留：consumeClick(0)（左键冲撞仍为帧内消费）
  guardHeld()               // 右键原始按住状态
  guardReady()              // guardHeld && debounceTimer <= 0（Combat 入口调用）
  // 防抖计时在 Input.update(dt) 推进：右键松开瞬间 debounceTimer = 0.200；
  // 期间 guardReady() 返回 false，防抖结束后若仍按住可再次进入 GUARD
  getChargeDir()            // -> {x,y} 归一化：
                            //   当前移动输入 ≠0 → 用之，并刷新内部 lastMoveDir
                            //   否则 lastMoveDir 存在 → 用之
                            //   否则 → atan2(鼠标方向) 兜底（含静止起手场景）
}
```

## 5. CONFIG diff 与 FX 新类型

```js
// CONFIG diff：
//   ATTACK   → 改名 CHARGE: { WINDUP: 0.070, ACTIVE: 0.120, RECOVERY: 0.150,
//                             DASH_SPEED: 1400, HIT_R: 20, HIT_OFFSET: 18 }   // 位移 168px
//   DODGE    → 整块删除
//   GUARD:   { RELEASE_DEBOUNCE: 0.200 } 新增
//   BOUNCE:  { DURATION: 0.400 } 新增
//   BANNER / SPAWN / FX.POOL / VIEW / STEP / BALL 不变
// fx 队列新类型：
//   guard_halo     {attach:true, radius:26, breatheHz:2}   // GUARD 期间常驻附着光圈，
//                                                          // 呼吸调制，非粒子，随姿态结束消散
//   shield_break   {particles:24, speed:260, life:0.35, hue:青}  // 防御者破盾
//   bounce_stun    {ring:{r0:10, r1:40, life:0.30}}        // 攻击者 BOUNCE 起始的眩晕环
// 删除：afterimage 的闪避触发路径（若拖尾复用残影素材则保留拖尾，仅删闪避入口）
```

## 6. 控制清单增补（接 v1.0 第 9 条之后）

10. 对撞裁决必须在**同一逻辑步内原子完成**（collect → 裁决 → 分配三段不可拆帧），禁止跨帧分判；裁决写入相位前禁止任何 onDeath/fx 副作用先行。
11. startTick、Recorder 事件 t、GhostPlayer 回放 tick 三者必须同源（Game.tick 整数计数），禁止各自维护时间轴。
12. 总冷却 340ms = 70+120+150 相位和，CHARGE_RECOVERY 结束后不得追加独立冷却计时器。
13. DODGE 相关代码（相位/常量/输入路径/fx 触发）必须删净，合并前用全局搜索 'dodge|闪避' 验证为 0 命中（GDD 文案除外）。
14. 幽灵事件处理必须幂等：guard_end 在非 GUARD 相位、charge 在非 IDLE 相位一律安全丢弃，不得抛错或改相位。
15. HitResolver 收集阶段只读双方状态，不得因"先判谁"产生不对称结果——对称输入必须产出对称输出（QA 可测）。

## 7. v1 已知 bug 兼容说明

- 本补丁涉及区域：Combat 状态机（§2.4 全量改造）、命中判定路径（HitResolver 重写）、右键输入（Input）、FX emit 类型。QA v1 报告中落在以上区域的 bug **默认由 v1.1 重写吸收**，请 qa-worker 回归时以 v1.1 行为为准，勿单独立修复项。
- 不受影响区域（主循环/渲染缩放/Recorder 采样主体/关卡状态机主体/横幅流程）的 v1 bug 原样并入 I-11 修复清单。
- 接到 QA 报告后会在 I-11 开工前做一次冲突标注回传 team-lead。

## 8. 技术矛盾与裁定汇总（已发 design-strategist 确认）

1. GUARD 仅 IDLE 可进（CHARGE 相位中按右键无效）——规格未写，按最简裁定，如需"后摇抢盾"请明确。
2. GUARD_RELEASE 200ms 定义为"可移动可冲撞但不可再盾"——规格"结束后 200ms 防抖"未细化，按此落地。
3. 幽灵 BOUNCE 期间到达的冲撞事件丢弃不补发——规格未写，按确定性优先裁定。
4. BOUNCE 不做物理击退、dash 停在当前位置——"强后摇"按纯时间惩罚实现，如需位移表现请补充参数。
