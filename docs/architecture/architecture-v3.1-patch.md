# 架构补丁 v3.1「WebRTC 配对码联机」——v3.0 §1 传输层全量更正

v3.0 补丁其余部分（§2 OrbAI 通路语义 / §3 手机适配 / ADR-009/010 / 分期逻辑）不变；本文只改网络层。server.js 从仓库与 README 移除（尚未实现，零沉没成本）。

---

## 1. WebRTC 配对协议

### 1.1 拓扑：星型，房主为权威端

```
            ┌─ DC('snap', unreliable) ─ DC('ctrl', reliable) ─ 访客1(P2)
房主浏览器  ├─ DC('snap') ─ DC('ctrl') ─ 访客2(观战)
(权威 Match)├─ … 观战 ≤8
            └─ P1 本地：human 直跑 / OrbAI 直注入（不经网络）
```

- 房主浏览器跑 HeadlessMatch（v3.0 §1.3 无头化成果直接复用），60Hz 模拟 + 向每条连接广播快照 + 对局事件；P2/观战收快照、发输入。
- 每个访客 = 一条独立 RTCPeerConnection，内含**两条 DataChannel**：`snap`（`maxRetransmits:0`，unreliable+unordered，走快照与 input）与 `ctrl`（reliable+ordered，走控制类帧）。
- **关键约束（诚实声明）：offer 与连接一一对应**——一个 offer 只能被 answer 一次，因此房间邀请码是**按席生成的**：房主每要接入一个访客（对战或观战）就生成一张新邀请码。房主可并行持有多张未消耗的邀请码（多个 pending PC）。

### 1.2 房间码 = 压缩 SDP

不引外部依赖（无构建工具，拒绝打包 pako），手写「关键字段抽取 + base64url」压缩：

```js
packSDP(desc) -> 'OD1.' + base64url(JSON({
  f: fingerprint,          // a=fingerprint 值
  u: iceUfrag, p: icePwd,  // ICE 凭据
  c: ['ip port type priority foundation', …],  // host/srflx 候选，等 gathering complete 后打包
}))
unpackSDP(code) -> RTCSessionDescription   // 逆向重建（固定 m=application 单行模板，
                                           // 仅支持本引擎自己生成的 offer/answer 形状，非法即报错码）
```

- 体积：SDP 原始 ~1.5KB → 房间码 ≈ **400~600 字符**，可复制粘贴；一期用纯文本复制，诚实标注"移动端可先用系统分享长按粘贴"。
- **生成房间码必须等 `icegatheringstate === 'complete'`**（手动配对无 trickle ICE），约 1~2s，UI 显示「生成中…」。
- 竞争与安全：房间码含 ICE 凭据 = 单次有效的连接凭据，泄露即他人可入房——按"朋友间局域网分享"威胁模型接受，UI 注明「邀请码请勿公开传播」。STUN 固定写死 `stun:stun.l.google.com:19302`；纯 host candidates 场景（真局域网）不走 STUN 也可通。
- 剪贴板：navigator.clipboard 需 https/Pages 环境，file:// 降级 execCommand 复制（单文件双击即玩仍保底）。

### 1.3 连接生命周期

```
房主：MENU 联机对战 → 创建房间 → PAIR 屏（WAITING）
      → 「生成邀请码」→ code_Oi（i=席序，可多张并行）→ 展示+复制
      → 粘贴访客的 answer 码 → ICE 连接建立 → 双 DC open → 座位分配帧
访客：加入房间 → 粘贴 code_Oi → 本地生成 answer → 展示 code_Ai（回给房主）
      → 房主确认后进房（收到 room_state）
对战：P1/P2 空位可占；观战：配对时即选角色，≤8 上限，超出拒码
对局/重连/销毁：沿用 v3.0 §1.4 生命周期（WAITING→COUNTDOWN→PLAYING→ENDED）；
      断线重连在 P2P 语义下简化为「重新走一遍配对」（原 token 机制废除——
      DataChannel 断了 PC 就废了，重连即新配对；PLAYING 态断线期间座位仍由内置 AI 托管，30s 超时回收不变）
```

ScreenStack 增 `PAIR` 屏（MENU 与 GAME 之间），承担邀请码/应答码展示、粘贴框、连接状态与失败提示。

## 2. 消息帧传输层迁移表（v3.0 §1.4 帧格式全部不变，只换管道）

| 帧 | v3.0（ws） | v3.1 | 通道与可靠性 | 说明 |
|---|---|---|---|---|
| create_room / join_room | C→S | 废除 | — | 改为配对码交换（§1.2/1.3） |
| claim_seat / seat_config / start / seat_reassigned / error | C→S/S→C | 保留 | ctrl · reliable+ordered | 控制类必须可靠 |
| room_created / room_state / match_end | S→C | 保留 | ctrl · reliable+ordered | 帧内 token 字段废除 |
| input {seq, move, click0, guardHeld} | C→S | 保留 | **snap · unreliable+unordered** | seq 去重语义天然容忍丢帧，每帧都带全量状态无 HOL 阻塞 |
| snapshot {tick, p1, p2, events} | S→C | 保留 | snap · unreliable+unordered | 60Hz 直发 + 客户端插值裁决不变 |
| leave | C→S | 保留 | ctrl · reliable | 对应 DC close |

快照广播：房主对每条 open 的 snap 通道各发一份（串行 send 即可，1.4KB/s/房 带宽结论不变）。房主 P1 若为 human，输入零网络直达 Match；P1 为 AI，OrbAI think 注入亦零网络——只有 P2/观战走 DC。

## 3. 配对 UX 时序（三方）

**房主（人类）**：菜单→联机对战→创建房间→PAIR 屏点「生成邀请码」→ 复制发给朋友（任意渠道）→ 收到对方回的应答码→ 粘贴→「已连接」→ 配置座位（可把该连接设为 P2 或观战）→ 开始。
**访客（人类）**：菜单→加入房间→粘贴邀请码→ 屏幕立即显示自己的应答码→ 复制回发给房主→ 等待「已连接」→ 占座/观战。
**AI 智能体（控制台，零 UI）**：
```js
const room = await OrbAI.createRoom({seat:'P1'})   // → room.codeOffer（房主码）
// 把 room.codeOffer 发给对方（人类或另一 AI）；收到对方应答码后：
await room.acceptAnswer(codeAnswer)                // 连接建立
OrbAI.joinRoom(codeOffer, {role:'P2'})             // → 返回自己的 answer 码，交回房主
// 两侧 AI 各自把码文本通过任意渠道互换即可，其余入座/开局的 ctrl 帧与人类完全一致
```
配对码的「生成/粘贴」动作对 AI 暴露为纯函数，人类 UX 与 AI 控制台共用同一套底层调用（`PairingHost` / `PairingGuest` 两类，UI 只是它们的外壳）。

## 4. ADR 修订与新增

### ADR-008 修订（v3.1）
- 权威端从「Node 服务端」改为「**房主浏览器**」；HeadlessMatch 在房主页面内运行。
- 60Hz 快照直发 + 客户端插值、无客户端预测、状态包体积与带宽结论——**全部维持不变**，仅传输层 ws → DataChannel 双通道分型。
- 新增后果：房主浏览器承担模拟与广播负载（60Hz 单房模拟 + ≤9 连接发送，现代手机/桌面均无压力）；**房主断线 = 全房解散**（权威端即房主，诚实标注，UI 在 PAIR 屏与对局中提示）。

### ADR-011 WebRTC 手动配对码联机（零服务器）
- **背景**：用户约束「创建局域网房间不需要运行任何代码」「任何 AI 打开链接就能玩」。浏览器无法监听端口，传统联机必须有一个可达的端点。
- **备选**：(a) 自建信令+中转服务器（v3.0 server.js 路线）；(b) 公共信令服务（依赖第三方可用性，违背零依赖）；(c) WebRTC DataChannel + 手动配对码交换。
- **决策**：(c)。房主生成压缩 offer 码 → 任意渠道传给访客 → 访客回 answer 码 → 房主粘贴，P2P 直连建立；权威端=房主；对局数据不经任何服务器（STUN 仅在打洞时参与，不中转数据）。
- **理由**：唯一满足"零服务器 + 打开链接即玩"的诚实方案；GitHub Pages 静态托管天然兼容（页面是静态的，联机不需要 Pages 参与任何运行时）；真局域网走 host candidates 直连，延迟与 v3.0 server.js 方案同级；P1 人类/AI 输入零网络直达的架构让房主侧无需区分本地与联网。
- **后果（诚实清单）**：①配对有手动摩擦（两跳复制粘贴，每访客一张独立邀请码），是方案固有成本，UI 需把「复制/粘贴」做成大按钮降摩擦；②房间码 ≈ 400~600 字符，偏长，二维码后续可选；③NAT 穿透在复杂网络（对称 NAT、企业防火墙）下**可能失败**——失败时 UI 明确提示「请在同一局域网内使用」，不假装能通；④房主退出即全房结束；⑤房间码即连接凭据，勿公开传播；⑥无权威仲裁者，理论上房主可改内存作弊——P2P 好友对战威胁模型下接受，联机竞技严肃化则必须回到服务器方案（v3.0 §1 可整段复活，无头化与协议已就绪）。

---

**给 impl-worker 的开工要点**：①`PairingHost`/`PairingGuest` + `packSDP/unpackSDP` 先行（纯逻辑可单测，不依赖 UI）；②双 DC 分型直接照 §2 表建；③HeadlessMatch/协议帧全部复用 v3.0，勿新造；④PAIR 屏是唯一新 DOM 屏。
