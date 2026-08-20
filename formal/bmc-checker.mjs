#!/usr/bin/env node
// bmc-checker.mjs —— ASM-FS 有界模型检查器（BMC）
//
// 目标：在抽象模型层面证明/证伪 6 个定理 E-1~E-6。
// 纪律（与立项书一致）：
//   · 零第三方依赖：仅使用 node: 内置模块，本文件不 import 任何外部包。
//   · 抽象状态机：状态 = 五态标记 × 锁(pid,startSec) × exitCode × done 标记 × 事件列表。
//   · 单次 fs 调用 = 原子步：O_EXCL 独占创建、tmp+rename 原子重命名被当作公理
//     （OS 保证，属于代码外的假设，不在内部证明）。
//   · 有界穷举 ≠ 全称证明：每条定理标注有限域边界（N ≤ 4、状态空间有限）。
//   · 反例必须可重放：每个反例附带操作序列，replay() 可重新执行并复现违例。
//
// 状态编码（对应 brief 的抽象状态元组）：
//   state     ∈ { ⊥, running, stopping, orphaned, adopted, done }  —— 由 observe() 优先级唯一推导
//   lock      ∈ { ⊥, (pid, startSec) }                              —— 锁文件内容
//   exitCode  ∈ { ⊥, c }                                            —— 退出码文件内容
//   doneFile  ∈ { 0, 1 }                                            —— done 标记文件
//   events    ∈ [ (seq, e) ]                                        —— 事件日志（事件溯源）

import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// 基本工具
// ---------------------------------------------------------------------------

/** 深拷贝 task（状态机对象），避免 BFS 分支间共享引用。 */
function cloneTask(t) {
  return {
    markers: { ...t.markers },
    lock: t.lock === null ? null : { ...t.lock },
    exitCode: t.exitCode,
    events: t.events.map((e) => ({ ...e })),
    doneWins: t.doneWins,
    adoptWins: t.adoptWins,
    lastLiveness: t.lastLiveness,
  }
}

/** 深拷贝 world（进程表，Map<pid,{alive,startSec}>）。 */
function cloneWorld(w) {
  const n = new Map()
  for (const [k, v] of w) n.set(k, { ...v })
  return n
}

/** world 转可序列化对象（按 pid 升序，保证哈希稳定）。 */
function worldToObj(world) {
  const keys = [...world.keys()].sort((a, b) => a - b)
  const o = {}
  for (const k of keys) o[k] = world.get(k)
  return o
}

/** 状态哈希键（task + world + pos + localSeq）。 */
function sysKey(task, world, pos, localSeq) {
  return JSON.stringify([task, worldToObj(world), pos, localSeq])
}

function freshTask() {
  return {
    markers: { done: 0, running: 0, stopping: 0, adopted: 0, orphaned: 0 },
    lock: null,
    exitCode: null,
    events: [],
    doneWins: 0,
    adoptWins: 0,
    lastLiveness: null,
  }
}

function freshWorld() {
  return new Map()
}

// ---------------------------------------------------------------------------
// 抽象状态机：转移（单 fs 调用 = 原子步）
// ---------------------------------------------------------------------------

/**
 * liveness(pid, startSec, world)：三分全函数 alive / dead / pid_reused。
 *   - startSec === null（⊥）：退化为二证据（仅 pid 存活与否），此时永不出 pid_reused。
 *   - startSec 有定义：pid 存活且 startSec 恒等 => alive；pid 不存活 => dead；
 *     pid 存活但 startSec 不匹配 => pid_reused（pid 被复用）。
 */
function liveness(pid, startSec, world) {
  const p = world.get(pid)
  if (startSec === null) {
    // 退化前置条件：锁无 startSec 时只有二证据。
    return p !== undefined && p.alive ? 'alive' : 'dead'
  }
  if (p === undefined || !p.alive) return 'dead'
  if (p.startSec === startSec) return 'alive'
  return 'pid_reused'
}

/** 五态优先级：done > running > stopping > adopted > orphaned。 */
const MARKER_PRIORITY = ['done', 'running', 'stopping', 'adopted', 'orphaned']

/**
 * observe(markers)：按优先级返回唯一可观察标签；空集 => 'none'（即 ⊥）。
 * 这是 E-6 的核心：优先级全序保证对任意标记组合输出唯一标签。
 */
function observe(markers) {
  for (const m of MARKER_PRIORITY) {
    if (markers[m]) return m
  }
  return 'none'
}

/**
 * 单步转移。actor = { pid, startSec }；actorIdx 用于 per-actor 本地变量（E-4 朴素版）。
 * op = { op, code?, e? }。返回 { outcome }；outcome 用于记录到反例轨迹。
 */
function step(task, world, localSeq, actorIdx, actor, op) {
  let outcome = null
  switch (op.op) {
    case 'spawn': {
      // 进程登记 + （若锁空闲则）认领锁：running。
      world.set(actor.pid, { alive: true, startSec: actor.startSec })
      if (task.lock === null) {
        task.lock = { pid: actor.pid, startSec: actor.startSec }
        task.markers.running = 1
        outcome = 'claimed'
      } else {
        outcome = 'lock-held'
      }
      break
    }
    case 'stop': {
      // 持有者请求停止：running -> stopping。
      if (task.lock !== null && task.lock.pid === actor.pid && task.markers.running === 1) {
        task.markers.running = 0
        task.markers.stopping = 1
        outcome = 'stopping'
      } else {
        outcome = 'not-owner'
      }
      break
    }
    case 'crash': {
      // 进程崩溃：world 标记死亡；锁残留 => orphaned。
      const p = world.get(actor.pid)
      if (p !== undefined) p.alive = false
      if (task.lock !== null && task.lock.pid === actor.pid) {
        task.markers.running = 0
        task.markers.stopping = 0
        task.markers.orphaned = 1
        outcome = 'orphaned'
      } else {
        outcome = 'crashed'
      }
      break
    }
    case 'adopt': {
      // 三证据收养：liveness 三分；仅 dead 时允许 O_EXCL 认领；pid_reused/alive 均拒绝。
      if (task.lock === null) {
        outcome = 'no-lock'
        break
      }
      const lv = liveness(task.lock.pid, task.lock.startSec, world)
      task.lastLiveness = lv
      if (lv === 'alive') {
        outcome = 'owner-alive'
      } else if (lv === 'pid_reused') {
        outcome = 'reject'
      } else {
        // dead：O_EXCL 认领，恰一赢家。
        if (task.markers.adopted === 0 && task.markers.done === 0) {
          task.markers.orphaned = 0
          task.markers.adopted = 1
          task.lock = { pid: actor.pid, startSec: actor.startSec }
          task.adoptWins += 1
          outcome = 'win'
        } else {
          outcome = 'lose'
        }
      }
      break
    }
    case 'finalize': {
      // O_EXCL done 文件：恰一赢家；其余幂等 no-op。
      if (task.markers.done === 0) {
        task.markers.done = 1
        task.markers.running = 0
        task.markers.stopping = 0
        task.markers.adopted = 0
        task.markers.orphaned = 0
        task.exitCode = op.code
        task.doneWins += 1
        outcome = 'win'
      } else {
        outcome = 'lose'
      }
      break
    }
    case 'readSeq': {
      // E-4 朴素版（证伪对象）：seq = events.length + 1，读到本地变量，两步非原子。
      localSeq[actorIdx] = task.events.length + 1
      outcome = { seq: localSeq[actorIdx] }
      break
    }
    case 'writeEvent': {
      // E-4 朴素版：用本地 seq 追加（可与其他写者撞号）。
      task.events.push({ seq: localSeq[actorIdx], e: op.e })
      outcome = { seq: localSeq[actorIdx] }
      break
    }
    case 'event': {
      // E-4 修复版：单步原子追加（O_EXCL 或单追加日志），seq 单调唯一。
      const seq = task.events.length + 1
      task.events.push({ seq, e: op.e })
      outcome = { seq }
      break
    }
    case 'read': {
      outcome = observe(task.markers)
      break
    }
    default: {
      throw new Error(`未知操作: ${op.op}`)
    }
  }
  return { outcome }
}

// ---------------------------------------------------------------------------
// 穷举引擎：全交错 BFS（按状态去重 + 父指针回溯）
// ---------------------------------------------------------------------------

/**
 * search({ actors, initial, check, maxNodes })
 *   actors : [{ pid, startSec, script: [op,...] }]
 *   initial: { task, world }
 *   check  : (task, world, pos, isTerminal) => null | reason  （null = 该节点满足断言）
 * 返回 { found, counterexample, nodes, interleavings }
 *   counterexample = { trace: [...], finalTask, reason } 或 null
 *
 * BFS 按 (task, world, pos, localSeq) 去重。对安全性断言这是完备的：任何可违例状态都
 * 可由某条交错到达，父指针给出最短反例路径；去重只合并了等价状态，不丢路径。
 */
function search({ actors, initial, check, maxNodes = 2_000_000 }) {
  const N = actors.length
  const startPos = new Array(N).fill(0)
  const startLocalSeq = new Array(N).fill(null)

  const startTask = cloneTask(initial.task)
  const startWorld = cloneWorld(initial.world)

  const isTerm = (pos) => pos.every((p, i) => p === actors[i].script.length)

  const seen = new Set()
  const queue = []
  let interleavings = 0

  const root = {
    task: startTask,
    world: startWorld,
    pos: startPos,
    localSeq: startLocalSeq,
    parent: null,
    stepDesc: null,
  }
  const rKey = sysKey(startTask, startWorld, startPos, startLocalSeq)
  seen.add(rKey)
  queue.push(root)

  const rootViolation = check(startTask, startWorld, startPos, isTerm(startPos))
  if (rootViolation !== null) {
    return {
      found: true,
      counterexample: { trace: [], finalTask: startTask, finalWorld: startWorld, reason: rootViolation },
      nodes: 1,
      interleavings: 0,
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()
    if (isTerm(node.pos)) {
      interleavings += 1
      continue
    }
    if (seen.size > maxNodes) {
      throw new Error(`状态数超出上限 ${maxNodes}`)
    }
    // 枚举下一个可推进的 actor（每个 actor 最多一步 => 保留 per-actor 程序序）。
    for (let i = 0; i < N; i++) {
      if (node.pos[i] >= actors[i].script.length) continue
      const op = actors[i].script[node.pos[i]]
      const task = cloneTask(node.task)
      const world = cloneWorld(node.world)
      const localSeq = node.localSeq.slice()
      const pos = node.pos.slice()
      const { outcome } = step(task, world, localSeq, i, actors[i], op)
      pos[i] += 1
      const key = sysKey(task, world, pos, localSeq)
      if (seen.has(key)) continue
      seen.add(key)
      const child = {
        task,
        world,
        pos,
        localSeq,
        parent: node,
        stepDesc: { actor: actors[i].pid, op: op.op, code: op.code, e: op.e, outcome },
      }
      const violation = check(task, world, pos, isTerm(pos))
      if (violation !== null) {
        // 回溯构造反例轨迹。
        const trace = []
        let cur = child
        while (cur.parent !== null) {
          trace.unshift(cur.stepDesc)
          cur = cur.parent
        }
        return {
          found: true,
          counterexample: { trace, finalTask: task, finalWorld: world, reason: violation },
          nodes: seen.size,
          interleavings,
        }
      }
      queue.push(child)
    }
  }

  return { found: false, counterexample: null, nodes: seen.size, interleavings }
}

/** 反例重放：从初始态按轨迹重新执行，返回最终态并复检断言。 */
function replay({ actors, initial, trace, check }) {
  const task = cloneTask(initial.task)
  const world = cloneWorld(initial.world)
  const localSeq = new Array(actors.length).fill(null)
  const byPid = new Map(actors.map((a, i) => [a.pid, { a, i }]))
  for (const d of trace) {
    const { a, i } = byPid.get(d.actor)
    step(task, world, localSeq, i, a, { op: d.op, code: d.code, e: d.e })
  }
  const pos = actors.map((a) => a.script.length)
  const violation = check(task, world, pos, true)
  return { finalTask: task, finalWorld: world, reason: violation }
}

// ---------------------------------------------------------------------------
// 断言 E-1 ~ E-6
// ---------------------------------------------------------------------------

function checkE1() {
  const boundary = 'N ∈ {2,3,4} 并发 finalize，每进程 2 步（幂等 + O_EXCL）；状态空间有限'
  const evidence = []
  const details = []
  for (const N of [2, 3, 4]) {
    const actors = []
    for (let i = 0; i < N; i++) {
      actors.push({
        pid: 1000 + i,
        startSec: 9000 + i,
        script: [
          { op: 'finalize', code: i },
          { op: 'finalize', code: i },
        ],
      })
    }
    const initial = { task: freshTask(), world: freshWorld() }
    // 预置：任务处于 running（锁被一个不参与 finalize 的占位进程持有）。
    initial.world.set(999, { alive: true, startSec: 1 })
    initial.task.lock = { pid: 999, startSec: 1 }
    initial.task.markers.running = 1

    const check = (task, _world, _pos, isTerminal) => {
      if (task.doneWins > 1) return `doneWins=${task.doneWins}，超过 1（终态非恰一次）`
      if (task.markers.done === 1 && task.exitCode === null) return 'done 标记存在但无退出码'
      if (isTerminal) {
        if (task.doneWins !== 1) return `终态 doneWins=${task.doneWins}（应为 1）`
        if (task.exitCode === null) return '终态缺退出码'
        if (task.markers.done !== 1) return '终态缺 done 标记'
      }
      return null
    }

    const r = search({ actors, initial, check })
    evidence.push(`N=${N}: ${r.found ? 'FAIL ' + r.counterexample.reason : 'PASS'}（交错数 ${r.interleavings}，去重状态 ${r.nodes}）`)
    details.push({ N, pass: !r.found, interleavings: r.interleavings, nodes: r.nodes })
  }
  const ok = details.every((d) => d.pass)
  return {
    id: 'E-1',
    title: '恰一终态：N 并发 finalize，可观察终态 done 恰好一次 + 退出码唯一',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? 'N=2/3/4 全部交错穷举下，done 标记恰写一次、退出码单值不覆盖；幂等第二次 finalize 一律 no-op。'
      : '存在终态违反恰一终态或退出码唯一。',
    evidence,
    counterexample: null,
    details,
  }
}

function checkE2() {
  const boundary = 'N ∈ {2,3,4} 并发 adopt 同一孤儿（持有者已死）；O_EXCL 认领，状态空间有限'
  const evidence = []
  const details = []
  for (const N of [2, 3, 4]) {
    const actors = []
    for (let i = 0; i < N; i++) {
      actors.push({ pid: 2000 + i, startSec: 8000 + i, script: [{ op: 'adopt' }] })
    }
    const initial = { task: freshTask(), world: freshWorld() }
    // 孤儿：锁持有者 pid 777 已死（world 中不存在 => dead），orphaned 标记存在。
    initial.task.lock = { pid: 777, startSec: 42 }
    initial.task.markers.orphaned = 1

    const check = (task, _world, _pos, isTerminal) => {
      if (task.adoptWins > 1) return `adoptWins=${task.adoptWins}，收养互斥被破坏`
      if (task.adoptWins === 1 && task.markers.adopted !== 1) return '恰一赢家但 adopted 标记缺失'
      if (isTerminal) {
        if (task.adoptWins !== 1) return `终态 adoptWins=${task.adoptWins}（应为 1）`
        if (task.markers.adopted !== 1) return '终态未 adopted'
        if (task.markers.orphaned !== 0) return '终态 orphaned 与 adopted 并存'
        if (task.lock === null) return '终态无锁'
      }
      return null
    }

    const r = search({ actors, initial, check })
    evidence.push(`N=${N}: ${r.found ? 'FAIL ' + r.counterexample.reason : 'PASS'}（交错数 ${r.interleavings}，去重状态 ${r.nodes}）`)
    details.push({ N, pass: !r.found, interleavings: r.interleavings, nodes: r.nodes })
  }
  const ok = details.every((d) => d.pass)
  return {
    id: 'E-2',
    title: '收养互斥：N 并发 adopt 同一孤儿，恰一赢家',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? 'N=2/3/4 全部交错下恰一个 adopt 胜者（O_EXCL 认领），其余全部 lose；终态 adopted 且锁唯一。'
      : '存在并发收养多赢家或终态不一致。',
    evidence,
    counterexample: null,
    details,
  }
}

function checkE3() {
  const boundary = 'pid ∈ {0,1,2}，startSec ∈ {⊥,100,200}，活死/复用全枚举；三分支单步收养判定 + 复用态 N 并发全拒绝'
  const evidence = []

  // —— 第 1 部分：liveness 三分全函数（域全枚举） ——
  let totalCases = 0
  const cases = []
  let ok1 = true
  for (const pid of [0, 1, 2]) {
    for (const startSec of [null, 100, 200]) {
      for (const alive of [false, true]) {
        for (const liveSec of [100, 200]) {
          totalCases++
          const world = new Map()
          if (alive) world.set(pid, { alive: true, startSec: liveSec })
          const got = liveness(pid, startSec, world)
          let expect
          if (startSec === null) {
            expect = alive ? 'alive' : 'dead'
          } else if (!alive) {
            expect = 'dead'
          } else if (liveSec === startSec) {
            expect = 'alive'
          } else {
            expect = 'pid_reused'
          }
          cases.push({ pid, startSec, alive, liveSec, got, expect })
          if (got !== expect) ok1 = false
          // 退化前置条件：startSec=⊥ 永不出 pid_reused。
          if (startSec === null && got === 'pid_reused') ok1 = false
        }
      }
    }
  }
  evidence.push(`三分全函数域枚举：${totalCases} 例，${ok1 ? '全部唯一且正确' : '存在偏差'}；退化前提（startSec=⊥）下永不出 pid_reused`)

  // —— 第 2 部分：三分支单步收养判定（直接构造状态 + 单 adopt，逐分支验证映射） ——
  const branchOk = []
  // 分支 alive：持有者存活（pid 存活且 startSec 恒等）=> owner-alive，收养不成立。
  {
    const task = freshTask()
    const world = freshWorld()
    task.lock = { pid: 1, startSec: 100 }
    task.markers.running = 1
    world.set(1, { alive: true, startSec: 100 })
    const { outcome } = step(task, world, [null], 0, { pid: 9, startSec: 900 }, { op: 'adopt' })
    const okA = outcome === 'owner-alive' && task.adoptWins === 0 && task.lastLiveness === 'alive' && task.markers.running === 1
    branchOk.push(okA)
    evidence.push(`分支 alive（存活 => owner-alive 拒绝）: ${okA ? 'PASS' : `FAIL outcome=${outcome}`}`)
  }

  // 分支 dead：持有者已死且 pid 未复用 => win，收养成立。
  {
    const task = freshTask()
    const world = freshWorld()
    task.lock = { pid: 1, startSec: 100 }
    task.markers.orphaned = 1
    // world 中无 pid 1 => dead。
    const { outcome } = step(task, world, [null], 0, { pid: 9, startSec: 900 }, { op: 'adopt' })
    const okB = outcome === 'win' && task.adoptWins === 1 && task.lastLiveness === 'dead' && task.markers.adopted === 1
    branchOk.push(okB)
    evidence.push(`分支 dead（已死 => win 收养）: ${okB ? 'PASS' : `FAIL outcome=${outcome}`}`)
  }

  // 分支 pid_reused：持有者已死、pid 被复用（存活但 startSec 不匹配）=> reject，收养不成立。
  {
    const task = freshTask()
    const world = freshWorld()
    task.lock = { pid: 1, startSec: 100 }
    task.markers.orphaned = 1
    world.set(1, { alive: true, startSec: 200 }) // pid 复用：同 pid 不同 startSec
    const { outcome } = step(task, world, [null], 0, { pid: 9, startSec: 900 }, { op: 'adopt' })
    const okC =
      outcome === 'reject' &&
      task.adoptWins === 0 &&
      task.lastLiveness === 'pid_reused' &&
      task.markers.orphaned === 1 &&
      task.markers.adopted === 0 &&
      task.lock.startSec === 100
    branchOk.push(okC)
    evidence.push(`分支 pid_reused（pid 复用 => reject 拒绝收养）: ${okC ? 'PASS' : `FAIL outcome=${outcome}`}`)
  }

  // —— 第 3 部分：复用态下 N 并发 adopter 全拒绝（固定前置 + 全交错） ——
  // 固定前置：spawn(pid=1,100) -> crash -> 复用 spawn(pid=1,200)，构造 orphaned+pid_reused 态。
  function reusedPrelude() {
    const task = freshTask()
    const world = freshWorld()
    const localSeq = [null]
    step(task, world, localSeq, 0, { pid: 1, startSec: 100 }, { op: 'spawn' })
    step(task, world, localSeq, 0, { pid: 1, startSec: 100 }, { op: 'crash' })
    step(task, world, localSeq, 0, { pid: 1, startSec: 200 }, { op: 'spawn' })
    return { task, world }
  }
  let okConcurrent = true
  const concurrentEvidence = []
  for (const N of [2, 3, 4]) {
    const initial = reusedPrelude()
    const actors = []
    for (let i = 0; i < N; i++) {
      actors.push({ pid: 5000 + i, startSec: 4000 + i, script: [{ op: 'adopt' }] })
    }
    const check = (task, _w, _p, isTerminal) => {
      if (task.adoptWins > 0) return `pid_reused 态下出现收养赢家（adoptWins=${task.adoptWins}）`
      if (isTerminal) {
        if (task.lastLiveness !== 'pid_reused') return `终态 lastLiveness=${task.lastLiveness}（应 pid_reused）`
        if (task.markers.orphaned !== 1 || task.markers.adopted !== 0) return '孤儿态被错误改变'
      }
      return null
    }
    const r = search({ actors, initial, check })
    if (r.found) okConcurrent = false
    concurrentEvidence.push(`N=${N}: ${r.found ? 'FAIL ' + r.counterexample.reason : 'PASS（全拒绝，0 赢家）'}（交错数 ${r.interleavings}）`)
  }
  evidence.push(`复用态 N 并发全拒绝：${concurrentEvidence.join('；')}`)

  const ok = ok1 && branchOk.every(Boolean) && okConcurrent
  return {
    id: 'E-3',
    title: '三证据健全性：liveness 三分全函数 + pid_reused 拒绝收养',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? 'liveness 为三分全函数（36 例域枚举全对，⊥ 退化为二证据）；三分支映射正确（alive=>owner-alive、dead=>win、pid_reused=>reject）；复用态下 N=2/3/4 并发 adopter 全拒绝。'
      : 'liveness 三分或 pid_reused 拒绝收养存在违反。',
    evidence,
    counterexample: null,
    details: { cases },
  }
}

function checkE4() {
  const boundary = 'N ∈ {2,3,4} 并发事件写入；朴素版 seq=length+1 两步非原子，修复版单步原子追加'
  const evidence = []
  const details = {}

  // —— 第 1 阶段：证伪（朴素模型）—— 必须先输出反例 ——
  const naive = {}
  {
    const N = 2
    const actors = []
    for (let i = 0; i < N; i++) {
      actors.push({
        pid: 3000 + i,
        startSec: 7000 + i,
        script: [
          { op: 'readSeq' },
          { op: 'writeEvent', e: `ev-${i}` },
        ],
      })
    }
    const initial = { task: freshTask(), world: freshWorld() }
    const check = (task) => {
      const seqs = task.events.map((e) => e.seq)
      if (new Set(seqs).size !== seqs.length) return `事件 seq 冲突：${JSON.stringify(seqs)}`
      return null
    }
    const r = search({ actors, initial, check })
    if (!r.found) {
      throw new Error('E-4 朴素版应发现 seq 冲突反例（证伪优先），但未发现——模型有误')
    }
    // 重放验证。
    const rep = replay({ actors, initial, trace: r.counterexample.trace, check })
    const seqs = rep.finalTask.events.map((e) => e.seq)
    naive.status = 'fail'
    naive.counterexample = {
      trace: r.counterexample.trace.map((d) => ({
        actor: d.actor,
        op: d.op,
        e: d.e,
        outcome: d.outcome,
      })),
      finalEvents: rep.finalTask.events,
      reason: r.counterexample.reason,
      replayedReason: rep.reason,
      replayedSeq: seqs,
    }
    evidence.push(`证伪阶段（朴素模型 N=2）: 发现反例 —— ${r.counterexample.reason}`)
    evidence.push(`反例可重放：replay 复现 seq=${JSON.stringify(seqs)}，复检=${rep.reason}`)
  }

  // —— 第 2 阶段：修复（单步原子追加）—— 全绿 ——
  const fixed = {}
  {
    let allPass = true
    for (const N of [2, 3, 4]) {
      const actors = []
      for (let i = 0; i < N; i++) {
        actors.push({ pid: 4000 + i, startSec: 6000 + i, script: [{ op: 'event', e: `ev-${i}` }] })
      }
      const initial = { task: freshTask(), world: freshWorld() }
      const check = (task) => {
        const seqs = task.events.map((e) => e.seq)
        if (new Set(seqs).size !== seqs.length) return `事件 seq 冲突：${JSON.stringify(seqs)}`
        return null
      }
      const r = search({ actors, initial, check })
      const pass = !r.found
      allPass = allPass && pass
      evidence.push(`修复阶段（单步原子追加 N=${N}）: ${pass ? 'PASS' : 'FAIL'}（交错数 ${r.interleavings}）`)
    }
    fixed.status = allPass ? 'pass' : 'fail'
    fixed.boundary = boundary
  }

  details.naive = naive
  details.fixed = fixed

  const ok = naive.status === 'fail' && fixed.status === 'pass'
  return {
    id: 'E-4',
    title: '事件溯源追加性：seq 唯一（证伪优先：朴素版先出反例，修复版全绿）',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? '证伪优先纪律达成：朴素模型 seq=length+1 两步非原子在并发下 seq 冲突（反例可重放）；修复为单步原子追加后 N=2/3/4 全绿。'
      : 'E-4 证伪或修复阶段未达预期。',
    evidence,
    counterexample: naive.counterexample,
    details,
  }
}

function checkE5() {
  const boundary = '能力原语域 = {read,stat,write,create,delete,rename,staticCall,execute,net}；模式 = {read-only, workspace-write, danger-full-access}'
  const evidence = []

  const CAPS = ['read', 'stat', 'write', 'create', 'delete', 'rename', 'staticCall', 'execute', 'net']
  const MODES = ['read-only', 'workspace-write', 'danger-full-access']
  const MODE_ORDER = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

  // deny 集（抽象自文档化语义：read-only 为受限语言环境，禁止写/静态调用/反射/执行/网络等；
  // workspace-write 为完整语言但在工作区内，禁止任意执行/网络；danger-full-access 全放行）。
  const denyOf = {
    'read-only': ['write', 'create', 'delete', 'rename', 'staticCall', 'execute', 'net'],
    'workspace-write': ['execute', 'net'],
    'danger-full-access': [],
  }
  const asSet = (arr) => new Set(arr)

  // 1) 单调性：mode 升序 => deny 集单调不增（等价 allow 集单调不减）。
  let monotone = true
  const chain = []
  for (let i = 0; i < MODES.length - 1; i++) {
    const m1 = MODES[i]
    const m2 = MODES[i + 1]
    const d1 = asSet(denyOf[m1])
    const d2 = asSet(denyOf[m2])
    const subset = [...d2].every((c) => d1.has(c))
    const strict = subset && d1.size > d2.size
    chain.push({ lower: m1, upper: m2, 'deny(upper)⊆deny(lower)': subset, strict })
    if (!subset || !strict) monotone = false
  }
  evidence.push(`保序链：${chain.map((c) => `${c.lower}≤${c.upper}: deny(${c.upper})⊆deny(${c.lower}) = ${c['deny(upper)⊆deny(lower)']}（严格 ${c.strict}）`).join('；')}`)

  // 2) 逐原语全枚举：对每对 m1 ≤ m2，凡 m1 允许者 m2 必允许（allow 单调不减），等价 deny 不增。
  let perCap = true
  for (const c of CAPS) {
    for (let i = 0; i < MODES.length - 1; i++) {
      const m1 = MODES[i]
      const m2 = MODES[i + 1]
      const a1 = asSet(CAPS.filter((x) => !denyOf[m1].includes(x)))
      const a2 = asSet(CAPS.filter((x) => !denyOf[m2].includes(x)))
      if (a1.has(c) && !a2.has(c)) perCap = false
    }
  }
  evidence.push(`逐原语单调性（allow 不减）：${perCap ? 'PASS' : 'FAIL'}`)

  // 3) 嵌入非同构：三个 deny 集两两互异（单射嵌入），且存在非模式的 deny 子集（非满射 => 非同构）。
  const sets = MODES.map((m) => JSON.stringify([...denyOf[m]].sort()))
  const injective = new Set(sets).size === MODES.length
  const aSubset = ['write'] // {write} 是 read-only deny 集的真子集，但不等于任何模式的 deny 集。
  const notSurjective = !sets.includes(JSON.stringify([...aSubset].sort()))
  evidence.push(`嵌入非满射（非同构）：三 deny 集互异 = ${injective}；存在非模式 deny 子集 ${JSON.stringify(aSubset)} = ${notSurjective}`)

  const ok = monotone && perCap && injective && notSurjective
  return {
    id: 'E-5',
    title: '能力格保序嵌入：mode 序 => deny 集随许可度升序单调不增（allow 单调不减）',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? 'read-only ≤ workspace-write ≤ danger-full-access 下 deny 集严格单调不增（deny(read-only) ⊇ deny(workspace-write) ⊇ deny(danger-full-access)）；嵌入单射但非满射（非同构）。'
      : '能力格保序或嵌入性质存在违反。',
    evidence,
    counterexample: null,
    details: { denyOf, chain },
  }
}

function checkE6() {
  const boundary = '标记组合全集 2^5 = 32 个子集 + 空集 = 33 例穷举'
  const evidence = []

  // 全枚举：所有 marker 子集 => observe 输出唯一标签。
  const MARKERS = MARKER_PRIORITY
  let ok = true
  let count = 0
  const labelsSeen = new Set()
  for (let mask = 0; mask < (1 << MARKERS.length); mask++) {
    const markers = {}
    MARKERS.forEach((m, i) => {
      markers[m] = (mask >> i) & 1
    })
    count++
    const label = observe(markers)
    labelsSeen.add(label)
    // 唯一性：label 必须等于优先级最高的在场标记（全序 => 唯一）。
    const expected = MARKERS.find((m) => markers[m]) ?? 'none'
    if (label !== expected) ok = false
    // 全函数：label 必须是合法标签之一。
    if (!MARKERS.includes(label) && label !== 'none') ok = false
  }
  evidence.push(`2^5=32 子集 + 空集：${count} 例，observe 全部唯一且等于最高优先级标记 = ${ok ? 'PASS' : 'FAIL'}`)

  // 五态各自唯一标签（单标记映射）。
  for (const m of MARKERS) {
    const markers = { done: 0, running: 0, stopping: 0, adopted: 0, orphaned: 0 }
    markers[m] = 1
    if (observe(markers) !== m) ok = false
  }
  evidence.push(`五态单标记映射：done/running/stopping/adopted/orphaned 各自映射到自身 = PASS`)

  // 共存组合仍唯一（证伪"恰一主标记"虚假不变量：多标记可共存）。
  const coex = { done: 1, running: 0, stopping: 0, adopted: 1, orphaned: 1 }
  const coexLabel = observe(coex)
  const coexExpect = 'done'
  evidence.push(`共存组合 {done, adopted, orphaned} => 唯一标签 "${coexLabel}"（优先级 done 最高） = ${coexLabel === coexExpect ? 'PASS' : 'FAIL'}`)
  if (coexLabel !== coexExpect) ok = false

  return {
    id: 'E-6',
    title: '五态优先级唯一标签：observe 优先级对任意标记组合输出唯一标签',
    status: ok ? 'pass' : 'fail',
    boundary,
    summary: ok
      ? 'observe 优先级（done>running>stopping>adopted>orphaned）对全部 32 个标记组合 + 空集输出唯一且确定的标签；多标记共存时仍唯一（修正"恰一主标记"虚假不变量）。'
      : 'observe 存在标签不唯一或违反优先级。',
    evidence,
    counterexample: null,
    details: { priority: MARKER_PRIORITY, coex: { markers: coex, label: coexLabel } },
  }
}

// ---------------------------------------------------------------------------
// 运行器与 CLI
// ---------------------------------------------------------------------------

const THEOREMS = {
  'E-1': checkE1,
  'E-2': checkE2,
  'E-3': checkE3,
  'E-4': checkE4,
  'E-5': checkE5,
  'E-6': checkE6,
}

function runAll() {
  return ['E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'E-6'].map((id) => THEOREMS[id]())
}

function humanSummary(results) {
  const lines = []
  lines.push('=== ASM-FS 有界模型检查器（BMC）结果 ===')
  lines.push('')
  for (const r of results) {
    lines.push(`[${r.status === 'pass' ? 'PASS' : 'FAIL'}] ${r.id} ${r.title}`)
    lines.push(`  边界: ${r.boundary}`)
    if (r.status === 'fail' && r.counterexample) {
      lines.push(`  反例: ${r.counterexample.reason}`)
    }
    for (const e of r.evidence) lines.push(`  · ${e}`)
    lines.push('')
  }
  const pass = results.filter((r) => r.status === 'pass').length
  lines.push(`合计: ${pass}/${results.length} 条通过`)
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const wantJson = argv.includes('--json')
  const ids = argv.filter((a) => !a.startsWith('--'))

  let results
  if (ids.length === 0) {
    results = runAll()
  } else {
    const unknown = ids.filter((i) => !THEOREMS[i])
    if (unknown.length > 0) {
      console.error(`未知定理: ${unknown.join(', ')}；可用: ${Object.keys(THEOREMS).join(', ')}`)
      process.exit(2)
    }
    results = ids.map((id) => THEOREMS[id]())
  }

  const payload = {
    engine: 'ASM-FS bounded model checker (BMC)',
    zeroDeps: true,
    note: '有界穷举 ≠ 全称证明；O_EXCL 与 rename 原子性为公理（OS 保证，代码外假设）。',
    runAt: new Date().toISOString(),
    theorems: results,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
    },
  }

  if (wantJson) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(humanSummary(results))
    console.log('--- 结构化 JSON ---')
    console.log(JSON.stringify(payload, null, 2))
  }

  const allPass = payload.summary.fail === 0
  process.exit(allPass ? 0 : 1)
}

// 作为模块被 import 时不执行 CLI（便于测试/复用）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}

export {
  liveness,
  observe,
  step,
  search,
  replay,
  MARKER_PRIORITY,
  checkE1,
  checkE2,
  checkE3,
  checkE4,
  checkE5,
  checkE6,
  runAll,
}
