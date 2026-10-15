# GDD · 防御系统（⚠ DEPRECATED v4.0）

> **v4.0 起防御系统整体废除**：右键改派重锤（见 attack.md v4.0）。v1.1~v3.3 的防御姿态、光晕、格挡、弹开 400ms、三分支冷却（防御 2s 还 2s 等）**全部作废**。
>
> - guard 相关代码置 dormant（参照 DRAW 处理：保留不删，运行时无触发源）。
> - 弹开语言（300ms/击退/硬直）由刀刀弹开继承（attack.md v4.0 §3），非防御遗产。
> - **Recorder 不再产生 guard_begin/guard_end 事件**；历史 replay 中的 guard 事件回放时静默跳过。
> 恢复此设计的唯一方式：用户新指令 + 主理人立项。
