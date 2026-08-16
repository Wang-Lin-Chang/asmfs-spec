# ASM-FS 一致性对照表 / Conformance

规范条目 × 参考实现测试的逐条映射。每行：规范要求 → 实现仓库 → 测试证据。

| # | 规范条目 | 参考实现 | 测试证据 |
|---|---|---|---|
| 1 | state/ 五态标记，任一时刻恰一主标记 | dsh-witness | 12 项验收 A-01（重启存活）/ B-03（静默任务保护）|
| 2 | 标记转移 tmp+rename 原子 | dsh-witness | 12 项验收 B-01（50 进程竞争恰一终态）|
| 3 | lock 以 wx 独占创建，内容 pid:startSec | dsh-witness | 12 项验收 A-02（任务启动）/ B-04 |
| 4 | 三证据收养：锁 + 进程存活 + 启动时间比对 | dsh-witness | 12 项验收 B-02（跨会话收养）/ B-04（PID 复用防护）|
| 5 | 收养延迟 | dsh-witness | EXP-8 benchmark（p50 ≈ 10ms 冷启动，×3 复跑）|
| 6 | EXIT:<code> 协议 + 每生命周期截断重写 | dsh-witness / dsh-cross-platform / dsh-macos | 三包冒烟 9/9 与 12 项验收（EXIT:0 / EXIT:1）|
| 7 | EXIT:-998 fail-closed | dsh-witness / dsh-cross-platform / dsh-macos | witness EXP-5；三包 runner 施加失败路径 |
| 8 | EXIT:-999 tampered | dsh-witness | EXP-5 留痕检测 |
| 9 | events/*.jsonl append-only 序号无断号 | dsh-witness | 12 项验收 C-01 |
| 10 | autopsy.json 终态生成 | dsh-witness | 12 项验收 C-02 |
| 11 | out.log 游标续读（不重不漏、跨重启）| dsh-witness | 12 项验收 A-03 |
| 12 | 沙箱映射 Windows | dsh-witness | EXP-5（六维闭合）|
| 13 | 沙箱映射 Linux | dsh-cross-platform | EXP-1/EXP-3 + 12 项验收 34/34 ×3 |
| 14 | 沙箱映射 macOS | dsh-macos | EXP-1/EXP-3 + 12 项验收 34/34 ×3 |

维护规则：新规范条目必须先有实现测试，否则标"待实现"不得标"已实测"。
