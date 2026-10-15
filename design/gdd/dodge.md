# GDD · 闪避系统（⚠ DEPRECATED）

> **v1.1 起本系统整体废弃。** 右键功能由「防御 Guard」替代，见 guard.md；右键闪避的输入、无敌帧、擦弹慢放机制均不再存在于运行时。
>
> 本文件仅作历史保留，其中仍有效的通用遗产：
> - 右键需屏蔽 contextmenu（guard.md 沿用）；
> - 「擦弹慢放」概念转移为格挡命中的 60ms hitstop（fx.md）；
> - 冷却负反馈手感语言（闪灰 50ms）转移为 guard.md 防抖反馈。
>
> **实现侧不得再引用本文件的任何数值参数（dashSpeed / dashDuration / iFrames / cooldown 已全部失效）。**
> 恢复此设计的唯一方式：用户新指令 + 主理人立项。
