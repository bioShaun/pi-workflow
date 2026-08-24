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

## 安装

**前置依赖**

- [Pi coding agent](https://github.com/nicobailon/pi-subagents)
- [pi-subagents](https://github.com/nicobailon/pi-subagents) ≥ 0.53.0 —— 工作流里所有 subagent 都由它负责启动：

```bash
pi install npm:pi-subagents
```

> **注意：**npm 上的 `pi-workflow` 这个名字已被一个无关的 VS Code 扩展占用——本项目请从 git 或本地路径安装，不要用 `npm:pi-workflow`。

**安装**

```bash
# 从 git
pi install git:github.com/bioShaun/pi-workflow

# 从本地 checkout
pi install /absolute/path/to/pi-workflow
```

`pi install` 默认写入用户配置（`~/.pi/agent/settings.json`）；加 `-l` 则写入项目配置（`.pi/settings.json`）。安装后重启 pi（或会话里执行 `/reload`）使扩展生效。

**所需 agent**

工作流的四个角色都通过 pi-subagents 的 agent 注册表解析：`scout`、`worker`、`reviewer` 是内置 agent；未定义 `planner` 时，`planner` 角色会自动回退到 `researcher` → `scout` → `oracle`。本仓库另在 `.agents/planner.md` 附带了一个专用的 `planner` agent（项目级）。

**验证**

```bash
pi list      # 应能看到 pi-workflow
```

再在 pi 会话里执行 `/work help`，应显示下文中的命令表。

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
| `/work tickets <spec-path> [--tickets <ticket-dir>] [--quick\|--normal\|--strict]` | Ticket 编排流程：通过校验后的不可变 Ticket 图与红绿验证，顺序执行史诗级规格 |
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

`/work spec <path>` 完全跳过 scout/planner，并把原始 UTF-8 文档冻结为 run 内不可变的 `requirement.md`。worker、每个 fresh reviewer 和 fixer 收到的是 run 相对路径与 SHA-256，而不是重复嵌入的全文；执行前必须完整读取快照。

```text
不可变快照 → implement → 变更范围门禁 → 引擎验证 → fresh review ↔ fix → completed
```

可选 front matter 可声明模式、有序验证命令和精确路径白名单：

```yaml
---
work:
  mode: strict
  verify:
    - npm test
    - npm run typecheck
  changes:
    allow:
      - src/engine/engine.ts
      - test/spec-flow.test.ts
---
```

- 模式优先级：显式 CLI 参数、`work.mode`、`defaultMode`。未知/非法策略、空命令或重复命令、不安全路径都会在创建 run 前失败。
- 引擎在实现及每次修复后，从项目根按声明顺序执行全部命令；真实退出码决定是否进入审查及能否完成。agent 自报检查仅作参考。
- 声明 `changes.allow` 后，引擎按初始工作树的精确哈希检查真实变更；越界修改进入修复，工作流自身产物不计入范围，源 spec 与快照不得修改。
- 预检只要求 `worker` 与 `reviewer`。恢复前校验不可变快照哈希；可恢复的旧式内嵌 spec 只迁移一次，变更发生后无法确认权威需求时安全失败。
- `/work status` 显示来源、需求短哈希/大小、验证 PASS/FAIL/PENDING 与范围 PASS/FAIL/NOT_DECLARED；完成输出把引擎命令及退出码与 agent 自报检查分开。

### Ticket 编排流程（`/work tickets`）

`/work tickets <spec-path> [--tickets <ticket-dir>]` 将大型/史诗规格拆解为窄而完整的贯穿线（tracer bullet），并在独立的全新上下文中按依赖前沿顺序执行。

```text
不可变快照 → Ticket 图（导入/生成） → 前沿执行（红 → 绿 → 审查 ↔ 修复） → 全局门禁（Spec 级验证 + 最终审查） → completed
```

- **显式选择**：单 context 可容纳的原子规格使用 `/work spec`，多 ticket 史诗规格使用 `/work tickets`；引擎绝不隐式猜测或自动切换。
- **导入 vs 生成**：传 `--tickets <ticket-dir>` 可直接导入预先编写的本地 ticket 目录（例如 `.scratch/<feature>/issues`）；省略时由专用有界 ticketizer agent 生成。二者生成统一的、校验过的不可变 `TicketGraph` 快照。
- **Skill 独立性**：运行时执行完全由引擎 contracts 驱动，不强依赖 `.agents/skills` 目录；skill 编写的 ticket 仅作为可选导入产物。
- **强制红绿门禁**：行为型 ticket（`tdd: required`）在实现前必须由引擎观察到符合预期的真实测试失败；非行为型 ticket 必须声明不可变且不可随意扩大的豁免理由（`tdd: exempt`）。
- **确定性顺序前沿**：所有阻塞项已完成的 pending ticket 构成就绪前沿；引擎按确定性顺序（图顺序优先、ID 其次）逐个执行。
- **Spec 级全局门禁**：所有 ticket 完成后触发全规格最终门禁，校验需求验收标准全覆盖、全局验证命令、父级范围与全新的最终独立审查。
- **检查点与恢复**：每个 ticket 阶段流转后持久化检查点；恢复时先行校验快照哈希、工作树基线与 ticket 状态一致性。

---
## 实时进度

工作流命令运行期间，有三个界面汇报进度：

1. **工作面包屑** — 屏幕底部一行 `[agent] action · tool · 8.4s · 142.0k tok`，跟随进行中的节点及其当前工具调用。
2. **实时 widget（仅 TUI）** — 单个树状 widget 锚定在编辑器上方（`pi-workflow-live`，`aboveEditor` 位置）：
   - **折叠心跳态** — 2-3 行，显示 spinner、工作流入口与模式（如 `spec/strict`）、人类可读阶段名、节点耗时、节点作用域 token 计数、活跃角色与当前动作（`Ctrl+O 查看最近活动`）。
   - **展开活动带（Activity Tape）** — 最近工具调用滚动历史（精简为 Read、Search、Edit、Run）、最新输出证据（最多 2 行）、遥测新鲜度（距上次更新时间，停滞时告警）、累计工具调用次数、后续工作流路线（Route），以及仅在故障/停滞时呈现的简明诊断行（`Ctrl+O 折叠`）。完整日志保留在底层 subagent/session 产物中。
   widget 按 500 ms 节拍刷新，仅在渲染 key 变化时重绘。RPC 模式下通过 UI port 挂载并同步更新；print/JSON 模式下不挂载可见 widget。
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
