# 架构补丁 v3.0「联机对战 + OrbAI + 手机适配」

基于 v2.1/v2.2/v2.3 增量之上的架构补丁。**v2.0 的服务端幽灵池方案（RemoteGhostStore / 4 端点契约 / ADR-007 并发语义）随本版作废**：联机挑战/联机boss/终极boss 三个模式删除，RemoteGhostStore 相关代码移除；LocalGhostStore 保留（挑战自我/单机 boss 幽灵玩法不变）。设计明细以 design-strategist 的 menu/ai-interface/mobile 文档为准，落盘后做对齐复核。

---

## 1. 实时对战网络架构（本版最大增量）

### 1.1 总裁决：权威服务端，仓库自带 `server.js`

```
┌─ index.html（静态，GitHub Pages 可发）────────────┐
│  客户端：App + ScreenStack + 渲染 + 输入 + FX      │
│  Match 逻辑（无头运行时复用，见 §1.3）              │
└──────────────┬──────── ws(JSON) ────────┬─────────┘
        ┌──────┴──── server.js（Node + ws）──────┐
        │  RoomManager → Room → HeadlessMatch     │
        │  权威模拟：60Hz 固定步，逻辑与客户端同源   │
        └─────────────────────────────────────────┘
```

- Node + `ws` 库，单文件 server.js，`node server.js` 即起，零配置（与"仓库自带"约束一致）。
- 服务端跑完整 Match：输入裁决、HitResolver、对撞判定全部服务端权威，客户端不信任本地判定。
- 联机对战**纯 PVP，不带幽灵**（采纳建议）：Recorder/GhostPlayer 不进服务端 Match，幽灵玩法留在单机——服务端无录制/回放路径，复杂度砍半。

### 1.2 快照频率裁决（ADR-008 核心）

**60Hz 快照直发 + 客户端插值渲染，不做客户端预测。**

- 状态体积极小：每快照 ≈ 2 实体 × (x,y,phase,guard,t) + 事件数组 ≈ 150B JSON；60Hz × 9 连接（P1+P2+8 观战）≈ **1.4KB/s/房**，LAN 带宽完全无压力——30Hz 省流的意义不存在。
- 冲撞判定帧对延迟极敏感：30Hz 快照会让判定帧视觉延迟 up to 33ms；60Hz 直发在 LAN（RTT 1~5ms）下无感。
- **不做客户端预测**：预测是为 100ms+ 广域网设计的；LAN RTT 下输入→快照回显 < 1 帧，预测的回滚复杂度不划算。若未来跨广域网，再评估。
- 渲染插值：客户端保留最近两帧快照做位置插值（lerp by 渲染时间戳），消除 60Hz 快照与显示器刷新的相位差。

### 1.3 Match 无头化改造清单（给 impl-worker）

| 模块 | 服务端可用性 | 动作 |
|---|---|---|
| Config/Utils/Combat/HitResolver/Ball/Player | ✅ 直接用 | 审查确认零 DOM/canvas 引用即可 |
| Match（v2.0 拆出） | ⚠️ 改造 | 构造参数注入 Input 源与事件汇，删除对 App/FX 的直接引用 |
| Input | ❌ DOM | 抽接口；服务端用 NetInputAdapter（§1.4）实现同接口 |
| FX 队列 | ❌ 渲染 | 服务端剥离：Match 产生**对局事件** events[]（charge/guard/break/death/draw，含 tick+type+pos），随快照广播；客户端把事件翻译进 fx.queue + AudioBus |
| Recorder/GhostPlayer | — | 不进服务端（纯 PVP）；单机路径不动 |
| App/ScreenStack/DOM 菜单 | ❌ | 客户端专属，server.js 不引入 |
| AudioBus | ❌ | 客户端专属 |

判定"无头化完成"的验收标准：**Match + 战斗全家桶在 Node 里可实例化并可跑通一场双 AI 模拟对局（两个 AIInput 喂输入）到 match_end，全程零 DOM 引用**——这条同时是 OrbAI 本地双 AI 演示模式的测试路径，一石二鸟。

### 1.4 协议设计（JSON over WebSocket）

```js
// ── C→S 控制类 ──────────────────────────────
{t:'create_room', seats:{P1:'human'|'ai', P2:'human'|'ai'}}   // 创建者自动 P1
{t:'join_room', roomId, token?}      // token 为断线重连凭据（首次 join 由 S 下发）
{t:'claim_seat', seat:'P1'|'P2'}     // 观战者/空位入座（房主或先到先得）
{t:'seat_config', seat, kind}        // 仅房主，未开局时改 human/ai
{t:'start'}                          // 仅房主；S 广播 countdown 3s 后开局
{t:'input', seq, move:{x,y}, click0:bool, guardHeld:bool}  // human 座位 60Hz
{t:'leave'} / ws 断开
// ── S→C ────────────────────────────────────
{t:'room_created', roomId, yourSeat, token}
{t:'room_state', seats:{P1,P2}, spectators:n, phase:'WAITING'|'COUNTDOWN'|'PLAYING'|'ENDED'}
{t:'snapshot', tick, p1:{x,y,phase,guard}, p2:{...}, events:[{tick,type,x,y}]}
{t:'match_end', result:'P1'|'P2'|'DRAW', p1Wins, p2Wins}
{t:'seat_reassigned', seat, kind:'ai'|'empty'}   // 断线座位回退广播
{t:'error', code, msg}               // ROOM_FULL|ROOM_GONE|NOT_HOST|SEAT_TAKEN…
```

**房间生命周期**：`WAITING（配置座位）→ COUNTDOWN(3s) → PLAYING（60Hz 模拟+广播）→ ENDED（结算 10s 或全员 leave 后销毁）`。三局两胜由 Room 层计分（p1Wins/p2Wins），对局层 Match 不感知场次（服务端每局 new HeadlessMatch）。

**断线重连与座位回收**：
- join 成功即发 token；断线后客户端自动重试 `{t:'join_room', roomId, token}`，**30s 内重连恢复原座位与观战身份**（期间该座位在 PLAYING 态由服务端 AI 托管接管，人类回来无缝换回——AI 托管 = 给该座位挂内置默认 AI，见 §2）。
- 超过 30s：座位回收——对局中回退为 AI 托管、WAITING 态置 empty；观战席位（≤8）直接释放。
- 房主断线：房主权顺延给下一个 human 连接（含观战）。

### 1.5 网络下的输入语义

客户端 human 仍按 60Hz 本地采样（getMoveAxis/consumeClick0/guardHeld），打包进 `{t:'input'}` 上行；**seq 单调递增，服务端按 seq 去重乱序**。服务端每 tick 对每个 human 座位取"最新一条未消费 input"填充 NetInputAdapter（LAN 下无插值补偿必要）。AI 座位见 §2。

## 2. OrbAI 接口架构

### 2.1 编程接口（design 侧定语义，这里定管道）

```js
// 用户在菜单粘贴/编写的 AI 代码，最终形态是一个纯函数对象：
OrbAI = {
  name: 'my-ai',
  // 引擎每个逻辑 tick 调一次；返回即等价 sendInput
  think(state) -> {move:{x,y}, click0:bool, guardHeld:bool}
}
// state 为引擎提供的只读快照（冻结拷贝，防 AI 改状态作弊）：
state = {
  tick,                          // 对局内相对 tick
  self: {x,y,phase,guard,chargeDir,dashT},
  opp:  {x,y,phase,guard,chargeDir,dashT},
  arena: {W:1280, H:720},        // 含 v2.2 实体碰撞半径等常量
}
```

### 2.2 运行位置裁决（ADR-009 核心）

**AI 座位跟随该座位所在客户端运行，输入走与人类完全相同的通路。**

- 本地人机：AI 在本客户端，think() 结果直接填充该座位的 Input 实现（AIInput implements Input）——与人类 Input 同接口进 Match，服务端/Match 无法区分。
- 联机 AI 座位：跑在该座位绑定的客户端（入座者自己的机器），产生的输入经 `{t:'input'}` 上行，**与人类包完全同构**——服务端零 AI 逻辑、零区分，公平性由"同通路"结构性保证（反作弊边界：AI 也只能做人类能做的事，见 ADR-009）。
- 断线托管 AI：内置默认 AI（简单追踪+时机冲撞，实现为内置 OrbAI 一等公民）跑在服务端，同样以 AIInput 填 NetInputAdapter——复用同一条注入路径，不特判。
- AI 代码执行：`new Function` 包装用户代码，try/catch 捕获异常（AI 抛错该 tick 视为空输入 + console.warn），不发 forfeit。

### 2.3 AI vs AI 本地演示模式

**单 Match 双 AI 输入源**（否决双 Match）：Match 构造注入 P1/P2 两个 AIInput，App 起 GAME 屏复用现有对局渲染与结算，菜单挂「演示」入口。零网络、零新增状态机，且正是 §1.3 无头化验收测试的客户端孪生版。

### 2.4 getState 实现位置

Match 暴露 `snapshotView(seat)`：返回该座位视角的冻结状态拷贝（Object.freeze + 坐标系以该座位为 self）——本地 AI 与联机快照共用此方法，保证 AI 在本地/联机看到的状态结构**完全一致**（用户 AI 无需感知联网）。

## 3. 手机适配架构

### 3.1 触摸输入抽象（映射进现有 Input 通路）

```js
class TouchSource {
  joystick: VirtualJoystick   // 左半屏 touchstart 处生成动态摇杆（origin=触点，r=60px，
                              // 死区 8px），输出归一化 move 轴
  btnAtk: TouchButton         // 右下圆钮，按下帧产生 click0 一次（consume 语义同鼠标）
  btnGuard: TouchButton       // 右上长按钮 → guardHeld
  // 三者输出汇入 Input 聚合层（§3.3），不经任何新状态机
}
```

Input 聚合改造：现有 Input 变为聚合器 `Input = KeyboardMouseSource ⊕ TouchSource`，getMoveAxis 取非零者优先、consumeClick 任一源可消费、guardHeld 按住或——**上层 Match/Combat 零改动**（v1.1 就把右键改成了 guardHeld 查询，此处直接受益）。

冲撞方向兜底：触屏无鼠标 aim，getChargeDir 的第三级兜底（鼠标方向）在触屏态退化为**上次非零移动方向，再无则默认朝向对手**——比"默认向右"更合理，一行裁定。

### 3.2 viewport 裁决

**横屏假定 + 竖屏遮罩提示**：`@media (orientation: portrait)` 显示全屏 DOM 遮罩「请横屏游玩」并暂停逻辑（App 检测 matchMedia 变化，GAME 屏内触发暂停）。不做竖屏布局——1280×720 横向玩法竖屏不可玩，遮罩是唯一诚实方案。缩放沿用现有 letterbox 等比方案，另加：`touch-action:none`、meta viewport、touchstart preventDefault 防滚动/双击缩放、iOS 音频解锁（首次 touchend resume AudioContext，替换现有 pointerdown 时机）。

### 3.3 触屏与键鼠并存规则

统一 pointer events；**双源常开**——检测到触摸即显示虚拟控件（DOM 按钮），键盘鼠标仍注册可用（笔记本触屏+外设场景）。无独占切换状态机，聚合层天然消解冲突。虚拟控件仅 GAME 屏内显示，菜单仍纯 DOM 按钮（触摸点击天然可用）。

## 4. ADR 增补

### ADR-008 权威服务端 + 60Hz 快照直发，否决 lockstep 与客户端预测
- **背景**：v3.0 联机为局域网实时对战，需选网络模型。
- **备选**：(a) lockstep（各端跑确定性模拟，只传输入）；(b) 权威服务端 + 30Hz 快照 + 预测；(c) 权威服务端 + 60Hz 快照 + 插值，无预测。
- **决策**：(c)。
- **理由**：项目已有无头可跑的确定性固定步 Match，权威服务端直接复用（lockstep 也要这份模拟，但还额外要求帧同步握手、丢包容忍差、观战插入复杂）；状态包极小（≈150B），60Hz × 9 观战 ≈ 1.4KB/s，带宽理由不成立；LAN RTT 1~5ms 下预测收益趋零而回滚代码成本不变——砍掉预测是本架构最省复杂度的一刀。
- **后果**：服务端必须完整跑 Match（§1.3 无头化）；观战席位零额外协议（收同一快照流）；若未来上广域网需补预测/回滚，接口预留（input seq 已带，快照含 tick）。

### ADR-009 AI 输入与人类输入同通路（反作弊边界）
- **背景**：真人对真人/真人对 AI/AI 对 AI 三种对局形态 + 联机 AI 座位。
- **决策**：AI 座位跟随该座位客户端运行，think() 输出经与人类相同的 Input 接口/网络帧上行；服务端不做人与 AI 区分；state 快照冻结只读。
- **理由**：同通路使"AI 作弊"在结构上不可能（AI 拿到的状态人类也拿得到、AI 能发的输入人类也发得出）；服务端零 AI 代码缩小攻击面；本地/联机 AI 行为一致（snapshotView 双端共用）。
- **后果**：AI 代码在用户客户端 `new Function` 执行——只威胁用户自己（自担风险，联机房主粘贴 AI 由全房共用该座位，需 UI 提示）；断线托管 AI 在服务端跑是唯一服务端 AI 代码，限定为内置白名单实现，不执行用户代码。

### ADR-010 移动端输入抽象层：双源聚合，无模式切换
- **背景**：键鼠 + 触屏并存，虚拟摇杆/按钮需接入现有 Input 通路。
- **决策**：Input 改聚合器（KeyboardMouseSource ⊕ TouchSource），统一输出语义（move 轴/click0 消费/guardHeld）；虚拟控件触摸时显示、双源常开；横屏遮罩 + portrait 暂停。
- **理由**：v1.1 后 Match 只依赖 Input 语义接口，聚合层让手机适配**零侵入战斗代码**；模式切换状态机是经典 bug 源，聚合消解。
- **后果**：Input 内部多一路径需 QA 覆盖（触屏消费语义与帧内 consume 的交互）；iOS 音频解锁时机从 pointerdown 改 touchend/pointerup 兼容。

## 5. 实现分期

**一期（纯静态，GitHub Pages 直接可发）**：
1. 菜单改版：删联机挑战/联机boss/终极boss 三按钮 + RemoteGhostStore 代码清除（ADR-007 随之归档为"已作废"）
2. OrbAI 管道：snapshotView/AIInput/菜单 AI 编辑入口 + 人机对局 + AI-vs-AI 演示（**以 Node 无头双 AI 对局测试为先行验收**，倒逼 Match 无头化，为二期铺路）
3. 手机适配：TouchSource 聚合 + 虚拟控件 + 横屏遮罩 + iOS 音频
4. Pages 发布流程（纯静态，单文件架构不变）

**二期（LAN 实时对战）**：
5. server.js：RoomManager/Room/HeadlessMatch + ws 协议（§1.4 全集）
6. 客户端联网 UI：房间创建/加入/座位配置/观战席位 + 断线重连
7. 快照插值渲染 + 事件→FX 翻译

**切分理由**：AI 管道是两期的公共地基——一期把"非人类输入源注入 Match"跑通（本地形态），二期 NetInputAdapter/AI 托管只是换数据来源；无头化验收（§1.3）放一期完成，server.js 二期开工时 Match 已在 Node 验证过，联机只剩协议与房间层；Pages 约束天然把"带 Node 的功能"隔离在二期，一期交付物始终全量可玩。

## 6. 待对齐复核点（menu/ai-interface/mobile 落盘后）

1. OrbAI think() 状态字段集与 design 的 ai-interface 文档对齐（§2.1 为技术基线）。
2. AI 代码输入形态：粘贴框 / 多 slot 保存（localStorage？）/ 内置示例 AI 列表——影响菜单 DOM 结构。
3. 联机房间 UI 规格：房间号输入方式（4 位数字码？）、观战者列表显示、座位抢占交互。
4. 三局两胜计分与结算画面规格（Room 层需 result 呈现协议，§1.4 match_end 已预留 p1Wins/p2Wins）。
5. 移动端按钮布局参数（钮位/尺寸/摇杆半径）——§3.1 给的是机制，具体数值待 mobile.md。
