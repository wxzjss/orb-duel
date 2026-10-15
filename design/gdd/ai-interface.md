# GDD · OrbAI 接口（v3.0 新建）

> 架构管道以 architecture-v3.0-patch.md §2 / ADR-009 为准：AI 输入与人类输入同通路；AI 席跟随该座位所在客户端。本文定语义与数据契约。

## 1. 概述
`window.OrbAI` 是给 AI（智能体/脚本）玩的正式接口：直接函数调用读状态、发输入，逐逻辑帧驱动，零截屏零延迟。真人、AI 在引擎眼里是同一种「输入源」。

## 2. 接口规格
```js
window.OrbAI = {
  // —— 对局控制 ——
  startMatch({ p1:'human'|'ai', p2:'human'|'ai', aiP1?:OrbAI代码, aiP2?:OrbAI代码 })
    // 本地人机 / AI-vs-AI 演示；返回 matchId
  stopMatch(matchId)
  onEnd(matchId, cb)            // cb({winner:'P1'|'P2'|'DRAW', hp:{p1,p2}, duration})

  // —— AI 代码注册形态（写 AI 的人只写这个）——
  // OrbAI 代码 = 纯函数对象：
  // { name:'my-ai', think(state) -> {move:{x,y}, click0:bool, guardHeld:bool} }
}
```

## 3. 状态快照（think(state) 的 state）
- 冻结只读拷贝（Object.freeze，防 AI 改状态作弊）。
- 字段表：
| 字段 | 类型 | 说明 |
|---|---|---|
| tick | int | 对局内相对逻辑帧号（60Hz） |
| self.x / self.y | float | 己方光球坐标 |
| self.phase | enum | IDLE/CHARGE_WINDUP/CHARGE_ACTIVE/CHARGE_RECOVERY/GUARD/GUARD_RELEASE/BOUNCE/DEAD |
| self.hp | int | 剩余血量（1~3） |
| self.guardCd | float | 防御冷却剩余秒 |
| self.chargeDir | {x,y} | 冲撞方向（CHARGE 相位中有效） |
| opp.* | 同上 | 对方同构字段 |
| arena | {W,H,BALL_R,HIT_R,HIT_OFFSET,CHARGE_DISTANCE,...} | 场地与判定常量 |

- **视角约定**：self/opp 按座位视角给出（snapshotView(seat)），AI 无需关心 P1/P2。
- 快照在逻辑更新后、本 tick 输入消费前生成（AI 看到的是"刚发生完的上一帧世界"）。

## 4. 输入注入语义（与人类严格等价）
| OrbAI 输出 | 等价人类操作 | 引擎处理 |
|---|---|---|
| move:{x,y} | WASD 轴（归一化） | 进 getMoveAxis 聚合；攻击中按状态锁忽略 |
| click0:true | 左键点击（帧内一次） | consume 语义：仅 IDLE/WINDUP 边界生效；冷却中忽略 |
| guardHeld:bool | 右键按住 | guardHeld 聚合；防抖/冷却中忽略 |

- AI 抛异常 → 该 tick 视为空输入 + console.warn，不判负（ADR-009）。
- AI 输出与人类输入进入完全相同的 Input 通路，受同样的状态锁、命中矩阵、冷却约束——无作弊特权（结构性保证）。

## 5. 内置 AI
- 至少 1 个内置 AI（「追踪+时机冲撞」：朝对手移动，距离 < 220px 且对手处于非无敌相位时 click0；对手冲撞起手时 30% 概率举盾 500ms）——同时是断线托管的托管 AI（服务端白名单复用同一实现）。

## 6. 边界情况
1. AI 代码访问 window/document → 不禁止但无意义（沙箱即普通 JS，自担风险提示见 menu.md B 节）。
2. AI 对 AI：双方 think 各自独立运行于同一 Match 的两个 AIInput；单局上限 5 分钟（防死循环），超时判 HP 多者胜、同 HP 判 DRAW。
3. 人机对局中人类座位输入与 AI 座位互不干扰（Input 聚合层按座位隔离）。
4. 联机对局中 AI 代码跑在该座位客户端；观战者看到的行为与本地一致。

## 7. 验收标准
- [ ] 内置 AI vs 内置 AI 跑满 3 HP 对局到 match_end，全程零人工输入。
- [ ] 真人（键盘）vs 内置 AI：AI 行为符合 §5 策略描述。
- [ ] AI 代码故意抛错 → 对局继续、空输入生效、控制台有 warn。
- [ ] AI 在 GUARD 冷却期输出 guardHeld=true → 引擎忽略（无越权）。
- [ ] state 快照冻结：AI 尝试修改 self.x 不影响对局。
