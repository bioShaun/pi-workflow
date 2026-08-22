# pi-workflow

📖 **语言：** [English](README.md) | 中文

面向 [Pi Coding Agent](https://github.com/nicobailon/pi-subagents) 的确定性编码工作流编排器。

通过一个持久化、可检查、可恢复的状态机，协调彼此隔离的 subagent 完成编码任务。

```text
User
  │
  ▼
Planner
  │
  ▼
Implementation
  │
  ▼
Test Gate
  │
  ▼
Fresh Reviewer
  │
  ├── PASS ─────────────► Final
  │
  └── REQUEST_CHANGES
            │
            ▼
        Fix Worker
            │
            ▼
      Regression Test
            │
            ▼
      Fresh Reviewer
```

---

## 核心不变量

> **审查者的上下文必须永远是全新的。**

每一次审查都是一次全新的隔离 agent 调用（`context: "fresh"`）。审查会话绝不被恢复，也绝不沾染实现方的辩解与理由。

---

## 特性

- **状态机编排**：代码驱动的状态转移与确定性质量门禁。
- **自主与分步两种模式**：`/work auto` 端到端一次跑完；或分步执行 `/work plan`、`/work implement`、`/work review`、`/work fix`。不带模式标志的 `/work auto` 会按计划的复杂度自动路由模式（low → quick，medium → normal，high/strict 触发条件 → strict）。
- **质量门禁**：显式的 Plan Gate、Test Gate、Review Gate、Completion Gate。
- **实时进度 UI**：任何节点运行期间，编辑器上方渲染一个树状实时 widget（当前活跃节点、进行中的工具调用、一行输出预览、token/耗时计数器）；每个完成的节点落为一条紧凑的里程碑 trace 行（`✓` 附带耗时与 token 用量；review 要求修改时为 `⚠️`；fix 节点报告测试失败时为 `✗`）。见[实时进度](#实时进度)与 [`docs/spec-workflow-output-widget.md`](docs/spec-workflow-output-widget.md)。
- **持久化与恢复**：原子化状态快照（`state.json`）、append-only 事件日志（`events.jsonl`），可从任何中断处恢复（包括对执行中被中断的变更型节点做安全失败处理）。
- **审查循环预算**：可配置、有界的审查循环（默认 3 轮，quick 模式 2 轮），防止无限修复循环；strict 模式每轮跑两个专职审查者（先 correctness，再 tests/quality），外加一个只有在两者都通过后才会运行的最终 fresh 审查者——其中任何一个要求修改，该轮直接进入修复阶段，不再跑最终审查者。
- **单活跃 run 锁**：防止并发的冲突 run 互相打架，同时保持完全安全；已终态的 run 自动释放锁。
- **自主性约束**：每个节点的 prompt 都禁用会使子 run 脱钩的协作/intercom 工具；detach 类失败会带明确禁令重试一次，而零编辑的 worker「拒绝」立即判节点失败，不消耗重试预算。
- **仓库安全**：保留用户自己的改动；未经用户明确指令，绝不自动 reset、stash、commit 或 push。

---

## 命令

| 命令 | 说明 |
|---|---|
| `/work auto <task> [--quick\|--normal\|--strict]` | 端到端跑完整个自动化工作流 |
| `/work plan <task> [--quick\|--normal\|--strict]` | 生成并校验结构化实现计划 |
| `/work spec <spec-path> [--quick\|--normal\|--strict]` | 规格驱动流程：从一份现成的规格文档直接走 实现 → 审查 → 修复（不派 scout/planner agent） |
| `/work implement [runId]` | 对已批准的计划执行实现 worker |
| `/work review [runId]` | 启动全新独立的审查者 |
| `/work fix [runId]` | 针对审查发现执行修复 worker |
| `/work status [runId]` | 查看当前活跃 run 或指定 run 的结构化状态 |
| `/work resume [runId]` | 从最后一个持久化检查点恢复工作流 |
| `/work abort [runId]` | 中止当前活跃的工作流（保留全部代码改动） |
| `/work list` | 列出所有历史工作流 run |
| `/work help` | 显示使用说明 |

单独输入 `/work` 会显示帮助。第一个参数若不是已识别的子命令，则整行按 `/work auto <task>` 处理（整行即任务描述）。

### 规格驱动流程（`/work spec`）

针对「需求已经写好了」的常见场景（例如 `.scratch/<feature>/spec.md`），`/work spec <path>` 完全跳过 scout 和 planner agent：

```text
spec 文档 ──(确定性合成计划，无 LLM)──► implement → test gate → fresh review ↔ fix loop → completed
```

- spec 文件从磁盘读取（相对项目根或绝对路径），原样嵌入 run 请求，worker、每个 fresh 审查者、fixer 看到的是同一份权威需求。
- `PlanResult` 由引擎确定性合成（`synthesizeSpecPlan`），天然通过 plan gate，并像其他 run 一样持久化为 `plan.json`。
- 预检只需要 `worker` 和 `reviewer` 两个 agent——无需配置 scout/planner。
- 审查预算、fresh 审查者隔离、修复循环、持久化与恢复行为均与 `/work auto` 完全一致（状态机入口：`created → plan_ready`）。

---

## 实时进度

工作流命令运行期间，有三个界面汇报进度：

1. **工作面包屑** — 屏幕底部一行 `[agent] action · tool · 8.4s · 142.0k tok`，跟随进行中的节点及其当前工具调用。
2. **实时 widget（仅 TUI）** — 单个树状 widget 锚定在编辑器上方（`pi-workflow-live`，`aboveEditor` 位置），显示 spinner、运行模式、当前活跃节点/agent/动作、进行中的工具及参数、一行 stdout 预览、token/耗时计数器。`Ctrl+O` 展开/收起详细块（fresh context、run id，以及工具在途时的 `status: in-flight I/O · mode`）。widget 在第一个节点事件时创建，在命令结束（成功、失败或中止）时销毁，因此不会残留过期进度。它按 500 ms 的 spinner 节拍刷新，仅在渲染 key 变化时重新渲染。RPC 模式下同一个纯渲染器在 attach 时安装一次为静态纯文本快照（之后的进度改由面包屑与里程碑界面输出）；print/JSON 模式下不调用任何外部 UI、不挂载可见 widget（notifier 仍会按每个 run 实例化一个 no-op 的内部 widget 和 timer）。
3. **里程碑 trace 行** — 每个完成的节点输出一条常驻 transcript 行，例如 `✓ [planner] Plan approved (4 steps, low complexity) · 3.2s · 65.2k tok`；要求修改的 review 渲染为 `⚠️`、测试失败的 fix 节点渲染为 `✗`，均带 `↳` 缩进的细节子行。节点执行失败时不输出终端行——run 的失败改为以 workflow error 形式呈现。

引擎通过类型化的 `WorkflowUI` 端口（`src/commands/ui-port.ts`）驱动上述全部界面，事件源为 `WorkflowProgressEvent`（`node_start` / `node_update` / `node_end`）；该端口还会守护所有 UI 调用，防止 `/reload` 或会话替换之后出现过期 extension 上下文错误。

---

## 架构

```text
pi-workflow/
├── index.ts
├── src/
│   ├── extension.ts
│   ├── commands/
│   │   ├── parser.ts
│   │   ├── renderer.ts
│   │   ├── work.ts
│   │   ├── ui-port.ts
│   │   ├── widget.ts
│   │   └── widget-renderer.ts
│   ├── engine/
│   │   ├── engine.ts
│   │   ├── state-machine.ts
│   │   ├── transitions.ts
│   │   ├── node-execution.ts
│   │   └── errors.ts
│   ├── agents/
│   │   ├── executor.ts
│   │   ├── pi-subagents-executor.ts
│   │   └── preflight.ts
│   ├── contracts/
│   │   ├── workflow.ts
│   │   ├── scout.ts
│   │   ├── plan.ts
│   │   ├── implementation.ts
│   │   ├── review.ts
│   │   └── fix.ts
│   ├── gates/
│   │   ├── plan-gate.ts
│   │   ├── test-gate.ts
│   │   ├── review-gate.ts
│   │   └── completion-gate.ts
│   ├── policies/
│   │   ├── complexity.ts
│   │   ├── context.ts
│   │   ├── retry.ts
│   │   ├── fork.ts
│   │   ├── intercom.ts
│   │   └── refusal.ts
│   ├── prompts/
│   │   ├── common.ts
│   │   ├── scout.ts
│   │   ├── planner.ts
│   │   ├── worker.ts
│   │   ├── reviewer.ts
│   │   └── fixer.ts
│   ├── repository/
│   │   └── baseline.ts
│   └── storage/
│       ├── paths.ts
│       ├── store.ts
│       └── events.ts
└── test/
    ├── state-machine.test.ts
    ├── gates.test.ts
    ├── context-policy.test.ts
    ├── workflow-auto.test.ts
    ├── spec-flow.test.ts
    ├── recovery.test.ts
    ├── lock.test.ts
    ├── commands.test.ts
    ├── audit-remediation.test.ts
    ├── progress.test.ts
    ├── ui-port.test.ts
    ├── widget.test.ts
    ├── widget-renderer.test.ts
    ├── node-execution.test.ts
    └── fake-executor.ts
```

模块说明：

- `src/commands/ui-port.ts` — 基于 `ctx.ui` 的类型化 `WorkflowUI` 端口（notify、工作面包屑、widget、终端输入）；在 `/reload` 之后抑制过期上下文错误。
- `src/commands/widget.ts` — `WorkflowLiveWidget` 生命周期：500 ms spinner 节拍、渲染 key diff、`Ctrl+O` 展开/收起、RPC `string[]` 兜底、销毁。
- `src/commands/widget-renderer.ts` — 纯函数 `renderLiveWidget(state, width, theme)` 树状渲染器（spinner 帧、token/耗时格式化、窄宽度截断）。
- `src/policies/fork.ts` — 检测 planner 确定性的 `fork` 不可用失败；引擎降级为 `fresh` 上下文（spec §52 Finding 1）。
- `src/policies/intercom.ts` — 检测 intercom-detach 子任务失败并补充重试提醒；引擎带明确禁令重试一次（§52 Finding 13）。
- `src/policies/refusal.ts` — 检测并包装零编辑的 worker 完成；引擎立即判节点失败，不消耗重试预算（§52 Finding 14）。
- `src/prompts/common.ts` — 附加在每个节点 prompt 末尾的自主性约束（防止协作工具导致的脱钩，§52 Finding 13）。

---

## License

MIT
