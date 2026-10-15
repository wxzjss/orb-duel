# 架构补丁 v2.0「主菜单与多模式」

基于 v1.1（冲撞与格挡）的增量补丁。规则明细以 design-strategist 的 modes.md / progression.md 为准，本文接口先行；规则表落盘后做对齐复核（预计差异点已在 §7 标注）。

---

## 1. 屏幕栈：两层状态结构

**原则：屏幕层在外，对局层在内。** 现有 level 状态机（TUTORIAL→TUTORIAL_CLEAR→LEVEL1→VICTORY/DEATH/DRAW）原封不动降级为「对局内状态机」，由 GameScreen 持有；原 `BOOT` 态移除（启动引导归屏幕层），菜单/结算归屏幕层。

```js
class Screen {
  id                                  // 'MENU'|'BOSS_MENU'|'GAME'|'RESULT'
  enter(payload) / exit()             // payload 携带模式配置 / 对局结果
  update(dt) / renderGame(ctx)        // 仅 GAME 屏有 canvas 渲染，其余 renderGame 为空
  dom                                 // 各屏持有的 DOM overlay 节点（见 ADR-005），栈管理显隐
}
class ScreenStack {
  screens: []
  push(s) / pop() / replace(s)        // 切换统一走 120ms 淡入淡出（复用 timeScale 横幅通道）
  current
}
```

屏幕迁移图：

```
MENU ─单机挑战→ GAME({mode:'solo', opp:'dummy'})
     ─联机挑战/挑战自我/各 boss（经 BOSS_MENU 或直入）→ GAME({mode, opp:'ghost', store, ghostId})
     ─退出游戏→ 浏览器 close（DOM confirm）
BOSS_MENU（boss 子菜单：单机/联机/终极）
GAME ─VICTORY→ RESULT({win, replay, mode, ghostId?}) ─再来/返回→ GAME / MENU
     ─DEATH/DRAW→ 走现有对局内重开，不退屏
RESULT ──→ MENU（或按 progression 晋级提示 → BOSS_MENU）
```

**现有代码改造点（给 impl-worker）**：`Game` 类拆为 `App`（持有 ScreenStack、Input、FX、AudioBus、全局 tick）+ `Match`（原 Game 的对局部分：player/ghost/dummy、level FSM、HitResolver）。全局 tick 计数移到 App，Match 使用相对 tick（进屏清零）——Recorder/回放不受影响（tick 只在对局内消费）。

## 2. GhostLibrary 存储抽象

```js
// 模式 → 存储实现映射（单一真源，写在 CONFIG.MODES）：
const MODES = {
  solo:        { opp:'dummy', store:null },                          // 教学关，无资产
  self:        { opp:'ghost', store:'local',  counter:20   },        // 挑战自我
  online:      { opp:'ghost', store:'remote', counter:100  },        // 联机挑战
  boss_solo:   { opp:'ghost', store:'local',  counter:100  },        // 单机boss
  boss_online: { opp:'ghost', store:'remote', counter:100  },        // 联机boss
  boss_final:  { opp:'ghost', store:'remote', counter:1000 },        // 终极boss
};  // 计数器→替换/晋级的具体映射待 progression.md 对齐，此处为占位

interface GhostStore {                       // 双实现同接口，模式启动时按 MODES 注入
  list(mode) -> [{id, meta}]                 // meta: {duration, uploadedAt, alias?}
  pickRandom(mode) -> {id, replay} | null    // 池空返回 null（驱动置灰/提示）
  put(mode, id, replay, meta)
  replace(mode, id, replay)                  // 本地直写；远程走 CAS（§3）
  remove(mode, id)
  incProgress(mode, delta) -> newProgress    // 本地同步；远程必须走 §3 report 原子接口
  getProgress(mode) -> {progress, wins, losses}
}

class LocalGhostStore  { /* localStorage，key 前缀 'gd.<mode>.'，见序列化与容量 */ }
class RemoteGhostStore { /* HTTP → §3 端点，本地不做镜像缓存 */ }
```

**序列化格式（replay → 字符串）**：

```js
serializeReplay(replay) -> base64str
// 轨迹：Float32 → Uint16 量化（q = round(x/1280 * 65535)，分辨率 ≈0.02px，
//       远小于本体 r16/判定圈 r20，镜像回放无损），duration 2B 头 + 事件 JSON 尾
deserializeReplay(str) -> replay       // Recorder.finalize() 直接产出可序列化结构
```

**体积结论**：
- 60s replay：轨迹 3600 帧 × 2 坐标 × 2B = 14.4KB → base64 ≈ **19.2KB/条**（事件流 <1KB 忽略）。
- 本地池上限 = self(20) + boss_solo(100) ≈ 120 条 ≈ 2.3MB，**在 localStorage 5MB 内但必须加护栏**：所有 setItem 包 try/catch，QuotaExceededError 时按 uploadedAt 淘汰最旧条目并 console.warn。
- **1000 条终极 boss 池 ≈ 19.2MB，客户端绝不存全池**：boss_final 走 RemoteGhostStore 且 pickRandom 每次只拉 1 条，客户端零池缓存——体积控制天然由"按需拉取"解决，服务端只需存二进制 payload。
- 结论一句话：**本地池靠量化+淘汰护栏够用；大池只在服务端，客户端按需单条拉取。**

## 3. 异步幽灵服务 API 契约（WorkBuddy 云服务：托管库 + HTTP）

**数据模型**（伪 SQL）：

```sql
CREATE TABLE ghost_pool (
  id          UUID PRIMARY KEY,
  mode        TEXT NOT NULL,            -- 'online' | 'boss_online' | 'boss_final'
  payload     BYTEA NOT NULL,           -- 序列化 replay 二进制（服务端不解析）
  duration_s  INT, alias TEXT, uploaded_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active'   -- active | replaced
);
CREATE TABLE player_counters (
  player_id   TEXT NOT NULL,            -- 匿名本地 UUID，首次访问服务端生成
  mode        TEXT NOT NULL,
  progress    INT DEFAULT 0, wins INT DEFAULT 0, losses INT DEFAULT 0,
  UNIQUE(player_id, mode)
);
```

**端点**：

| 端点 | 语义 | 并发要求 |
|---|---|---|
| `POST /init` | 注册/返回 player_id + 各模式 counters + 池活跃数（驱动置灰与进度条） | upsert 幂等 |
| `POST /pick` `{player_id, mode}` | 随机抽 1 条 active 幽灵，**同事务内 progress 计数预扣** | 单事务原子 |
| `POST /report` `{player_id, mode, ghost_id, result, replay?}` | 胜负上报；胜且带 replay → CAS 替换；查晋级阈值 | 单事务原子 + CAS |
| `GET /progress` `{player_id}` | 进度条轮询（菜单停留期 15s 一次） | 只读 |

**并发语义（关键）**——三个原语：**同事务、CAS、幂等**：

```sql
-- /pick：单事务。抽取与计数预扣原子，杜绝"抽到但没计数"的半状态
BEGIN;
  SELECT id, payload FROM ghost_pool
   WHERE mode=:mode AND status='active' ORDER BY random() LIMIT 1;
  UPDATE player_counters SET progress = progress + 1
   WHERE player_id=:pid AND mode=:mode;          -- 不存在则先 INSERT ... ON CONFLICT
COMMIT;
-- 注：跨玩家抽到同一条是【允许的】（池大重复率低）；竞争在替换侧用 CAS 消解 ↓

-- /report(win, replay)：单事务 + CAS
BEGIN;
  UPDATE player_counters SET progress=progress+1, wins=wins+1
   WHERE player_id=:pid AND mode=:mode;
  UPDATE ghost_pool SET payload=:new_payload, status='replaced',
                        replaced_by=:pid, replaced_at=now()
   WHERE id=:gid AND status='active';            -- ← CAS：只认第一个打破者
  -- rowcount=0 → 返回 {replaced:false, stale:true}，客户端提示
  --   「该记录已被他人更早打破，你的胜利计入进度但未替换资产」并自动重抽
  SELECT progress FROM player_counters WHERE player_id=:pid AND mode=:mode;
  -- progress ≥ 阈值(20/100/1000) → 标记晋级事件（progression.md 明细），同事务内返回
COMMIT;
-- /report(loss)：同事务只更新 losses，无 CAS 分支
```

幂等性：客户端对 /report 做请求去重键（player_id + ghost_id + 本地对局 tick 起点 hash），服务端收到重复上报直接返回上次结果——网络重试不会双计数。

## 4. 离线降级与置灰

- **探测时机**：App 启动与每次回到 MENU 时发 `/init`（超时 2s）；菜单停留期每 15s 重探。
- **置灰规则**：remote 模式按钮 = `池活跃数>0 && 探测成功`，任一不满足置灰 + tooltip（「暂无可用记录」/「网络不可用」）；local 模式按钮只看本地池，**永不因网络置灰**。
- **对局中断网**：异步幽灵对战已拿到 replay 后全程本地，不受影响；结算上报失败 → 进本地待发队列，下次探测成功重发（幂等键保证不双计），仍失败则 RESULT 页提示「上传失败，本次进度未计入」。
- 教学关/单机模式：零网络调用。

## 5. ADR 增补

### ADR-005 菜单 UI：DOM overlay，不用 Canvas 绘制
- **背景**：主菜单含按钮（含置灰态）、hover、进度条、确认弹窗、文本排版。
- **备选**：(a) 全 Canvas 自绘 UI；(b) DOM overlay 绝对定位覆盖 canvas。
- **决策**：(b)。菜单/子菜单/结算用 DOM（同一 index.html 内新增节点），canvas 保持纯对局渲染；ScreenStack 管理各屏 DOM 显隐。
- **理由**：(a) 等于手写一个 DOM 引擎（命中测试/焦点/无障碍/文字布局），单文件预算内不可行；DOM 天然获得 hover/禁用/换行，成本近零；现有单文件架构不受影响（仍是双击即玩）。
- **后果**：两条渲染路径并存（DOM 菜单 + Canvas 对局），需保证 ScreenStack 切换时 DOM 显隐与 canvas 清屏同步（enter/exit 钩子统一处理）；DOM 样式用内联 `<style>`，不引外部资源。

### ADR-006 引入 GhostStore 存储抽象
- **背景**：5 个模式横跨 localStorage 与服务端，且 v2.0 分两期交付（先本地后联机）。
- **决策**：统一 GhostStore 接口（§2），模式配置注入实现；调用方（GameScreen/RESULT）永远只面向接口。
- **理由**：分期交付的前提——第一期用 LocalGhostStore 交付本地模式，第二期加 RemoteGhostStore 时**零改动**消费方；pickRandom 的"池空→置灰"语义也在接口层统一。
- **后果**：接口需一次定准（list/pickRandom/put/replace/remove/incProgress/getProgress 八方法）；远程实现的 CAS/stale 语义映射到接口返回值（replace 返回 {ok, stale}）。

### ADR-007 计数与替换：服务端权威 + 单事务 + CAS
- **背景**：联机类计数器是经济系统核心，两玩家并发打破同一条 replay 会产生替换竞争。
- **决策**：remote 模式的 progress/wins 计数与幽灵替换只在服务端单事务内发生，替换用 status='active' CAS，只认第一个打破者，后来者记胜利进度 + stale 提示；客户端计数仅为展示缓存。
- **理由**：客户端原子性不可行（无锁、可篡改）；CAS 比"抽占锁定"简单且无死锁；"后打破者不替换"规则简单、可解释、防刷（重复打破同一条不能刷池）。
- **后果**：需要幂等键防重试双计（§3）；stale 分支需要 UI 文案（设计侧补）；本地模式计数不受此约束（localStorage 单用户无并发）。

## 6. 实现分期建议

**第一期（纯本地，零服务端依赖，可先行开工）**：
1. App/ScreenStack 拆分 + DOM 菜单骨架（MENU/BOSS_MENU/RESULT）
2. serialize/deserialize + LocalGhostStore（含量子化、淘汰护栏）
3. 模式接入：solo（教学）/ self（挑战自我）/ boss_solo（单机 boss）
4. 对局内状态机原样复用，Match 注入 store 配置

**第二期（接云服务）**：
5. RemoteGhostStore + /init /pick /report /progress 契约实现（WorkBuddy 云服务托管库）
6. online / boss_online / boss_final 三模式 + 置灰/探测/待发队列
7. 幂等键 + stale 分支 UI

**切分理由**：GhostStore 接口是两期的唯一接缝，第一期把接口消费方（菜单置灰判定、Match 注入、RESULT 上报路径）全部跑通后，第二期只是换实现加端点，无返工；服务端契约（§3）可与服务端建设并行，不阻塞第一期；用户可见价值（完整单机版）最早落地。

## 7. 待对齐复核点（modes.md / progression.md 落盘后核对）

1. 计数器 20/100/1000 与六模式的精确映射（§2 MODES 表为占位）——尤其"挑战自我 20"的语义是替换自己的旧记录还是别的。
2. 晋级链路：1000 计数是"终极 boss 的池规模"还是"玩家晋级进度"——影响 counters 表字段与 /report 返回结构。
3. stale 分支与「替换」的 UI 文案、晋级提示的横幅规格（预计复用 1.2s 横幅通道）。
4. 退出游戏的确认交互（DOM confirm vs 自绘弹窗——默认 DOM confirm，设计侧可改）。
