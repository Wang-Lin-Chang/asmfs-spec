# ASM-FS — Agent State Machine as File System

> An open, framework-agnostic protocol for agent/job state: **the directory structure is the state machine**. Any tool that can `ls`, `cat`, and `cp` can audit, snapshot, adopt, or replay it — in any language, on any OS, with zero runtime coupling.
>
> 一个与框架无关的开放协议：**目录结构就是状态机**。任何能 `ls`、`cat`、`cp` 的工具都能审计、快照、收养、回放它——跨语言、跨平台、零运行时耦合。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

## 定位 / Positioning

LangGraph checkpoints serialize in-memory state into SQLite/Postgres; OpenAI Agents SDK persists JSON blobs. Both are black boxes: external tools can't audit them, cross-language reads are impossible, and crash recovery requires the original runtime to deserialize.

ASM-FS is different: state lives as **plain files and directories with a fixed layout**. The reference implementation ([dsh-witness](https://github.com/Wang-Lin-Chang/dsh-witness)) proves it with 12 scenarios / 34 assertions and a measured adoption latency of **~10ms (p50, cold-start recovery after kill -9)**.

主流框架把状态序列化进数据库或 JSON blob——黑盒、难审计、换运行时即失效。ASM-FS 反过来：状态就是**固定布局的普通文件和目录**。参考实现（dsh-witness）以 12 场景/34 断言背书，实测冷启动收养延迟 **p50 ≈ 10ms（kill -9 后）**。

## 目录布局 / Directory layout

```
jobs/
└── <task-id>/                  # one task = one directory
    ├── state/
    │   ├── running             # five-state markers (exactly one primary at a time)
    │   ├── stopping
    │   ├── orphaned            # crash residue (adoption scene)
    │   ├── adopted             # adopted by a new session
    │   └── done                # terminal (content = exit code)
    ├── lock                    # coordination lock, content = pid:startSec
    ├── spec.json               # task spec (kind/label/startedAt)
    ├── out.log                 # output (cursor-based continued reading)
    ├── exit.txt                # exit protocol (EXIT:<code>)
    ├── autopsy.json            # autopsy report (generated at finalization)
    └── events/                 # event sourcing
        ├── 0001-started.jsonl
        ├── 0002-output.jsonl
        └── 0003-done.jsonl
```

状态五态：`running / stopping / orphaned / adopted / done`。任一时刻恰有一个主标记；标记转移用 tmp+rename 原子写。

Five states: `running / stopping / orphaned / adopted / done`. Exactly one primary marker at any moment; marker transitions are atomic tmp+rename writes.

## 核心语义 / Core semantics

### 1. 锁协议 / Lock protocol

- 创建：`lock` 以 **O_EXCL（wx）** 独占创建，内容 = `pid:startSec`（进程号:启动时间 epoch 秒）。
- 心跳：持有者每 60s touch 锁 mtime（观测式心跳，静默任务保护）。
- 完成信号：正常退出时删除锁；崩溃则锁残留但内容可读。
- 来源实验：dsh-witness EXP-1（detached node 托管判决 + pipe stdio 判决）。

### 2. 三证据收养 / Three-evidence adoption

收养判定 = ① 锁内容 `pid:startSec` 可解析 ② 进程存活（kill -9 假死排除） ③ 进程启动时间比对（防 PID 复用）。三项全过才收养，否则结案。

- 来源实验：dsh-witness EXP-2；12 项验收 B-04（伪造 lock 判定 failed）。
- 实测延迟：冷启动收养 p50 ≈ 10ms / p99 ≤ 17ms；活实例监控收养 ≈ 监控周期 + 十余毫秒（dsh-witness EXP-8，×3 复跑）。

### 3. 退出协议 / Exit protocol

- `exit.txt` 内容 = `EXIT:<code>`（每任务生命周期截断重写）。
- `EXIT:-998` = 沙箱施加失败，执行器 fail-closed 拒绝执行。
- `EXIT:-999` = 任务自救伪造证据被识破 → 显式 `tampered` 判决。
- 来源实验：dsh-witness EXP-5；dsh-cross-platform EXP-1/EXP-8。

### 4. 事件溯源 / Event sourcing

`events/NNNN-<change>.jsonl` append-only，序号无断号：started / output / done / adopted / tampered / stopping。

- 来源实验：dsh-witness EXP-7（C 组：事件日志完整有序）。

### 5. 尸检报告 / Autopsy report

终态时生成 `autopsy.json`（死因/主证据/判决/死因代码）——格式见 [autopsy-spec](https://github.com/Wang-Lin-Chang/autopsy-spec)。

## 跨平台沙箱映射 / Sandbox mapping

证据保护（防覆盖/防删/防伪造）的配方随平台变化，协议不变：

| 平台 | 配方 | 来源 |
|---|---|---|
| Windows | NTFS ACL 六维闭合 + 守卫句柄 + 留痕检测 | dsh-witness EXP-5 |
| Linux | chattr +i + bubblewrap 只读视图（--share-net）| dsh-cross-platform EXP-1/EXP-3 |
| macOS | chflags uchg + sandbox-exec deny 视图 | dsh-macos EXP-1/EXP-3 |

## 与实现的对照 / Conformance

本规范的每一条都在参考实现中有对应测试。对照表见 [CONFORMANCE.md](./CONFORMANCE.md)。

## 诚实边界 / Honest boundaries

- 单机协议：本规范不涉及跨机器共识/分布式协调。
- at-least-once：崩溃窗口可能重复终态写入（幂等 finalize 保证恰好一次落盘，但重复尝试可能发生）。
- 状态读取 = 任何文件系统操作；但**写入**必须遵循原子规则（tmp+rename / O_EXCL），否则破坏收养语义。
- 规范 v0.1.0：字段可能演进；演进以语义版本化，破坏性变更升大版本。
