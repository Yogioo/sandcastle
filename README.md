<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-ondark_2x.png">
    <source media="(prefers-color-scheme: light)" srcset="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png">
    <img alt="Sandcastle" src="https://res.cloudinary.com/total-typescript/image/upload/v1775033787/readme-sandcastle-onlight_2x.png" height="200" style="margin-bottom: 20px;">
  </picture>
</div>

## Sandcastle 是什么？

一个在隔离沙箱中编排 AI 编程代理的 TypeScript 库：

1. 通过一次 `sandcastle.run()` 调用代理。
2. Sandcastle 负责将代理放入沙箱，并应用可配置的分支策略。
3. 分支上的提交会被合并回主仓库。

Sandcastle 与具体提供商无关——内置 Docker、Podman、Vercel 等提供商，你也可以自行实现。适合并行运行多个无人值守（AFK）代理、搭建审查流水线，或编排你自己的代理工作流。

## 前置条件

- [Git](https://git-scm.com/)
- 沙箱提供商——Sandcastle 需要隔离环境来运行代理。内置选项：
  - [Docker Desktop](https://www.docker.com/)——本地开发最常用
  - [Podman](https://podman.io/)——Docker 的无 root 替代方案
  - [Vercel](https://vercel.com/)——通过 `@vercel/sandbox` 使用云端 Firecracker 微虚拟机
  - 或使用 `createBindMountSandboxProvider` / `createIsolatedSandboxProvider` [自行创建](#自定义沙箱提供商)

## 快速开始

1. 安装 CLI：

```bash
npm install -g @yogioo/sandcastle
```

如果不想全局安装，也可以在下面的命令中使用 `npx @yogioo/sandcastle` 作为后备调用方式。

2. 在仓库中运行 `sandcastle init [path]`。工作流文件默认生成到用户缓存目录，而不是开发仓库：

```bash
sandcastle init
```

也可以初始化另一个仓库：`sandcastle init C:/projects/another-repo`。在 Windows 上，默认位置类似 `%LOCALAPPDATA%\Sandcastle\projects\<项目标识>\.sandcastle\`。`init` 会登记项目清单并输出实际状态目录和入口文件；若需要自定义位置，传入 `--state-dir`。之后可用 `sandcastle path`（或 `sandcastle path .`）再次打印该仓库关联的状态目录。

如果目标目录还不是 Git 仓库（或仓库里还没有任何 commit），`init` 会询问是否自动 `git init` 并创建一个空的初始 commit。选否会取消 `init`，等你自己处理好仓库后再跑。非交互模式用 `--init-git true|false`。

如果选择 beads 作为 issue 跟踪器，`init` 会先检查宿主机是否安装了 `bd`（未安装则报错退出），再检查仓库是否已有 beads 数据库。没有数据库时会询问是否运行 `bd init`；选否会取消 `init`。非交互模式用 `--init-beads true|false`。

3. `init` 会自动在输出的状态目录中创建 `.env`。如果需要自定义凭据，
   编辑该文件，填入 `CLAUDE_CODE_OAUTH_TOKEN`（在宿主机运行
   `claude setup-token` 获取）；若使用 Anthropic API Key，取消注释并填写
   `ANTHROPIC_API_KEY`。也可以使用系统环境变量或已有的 CLI 登录状态。

4. 运行 CLI。它会使用当前仓库的已登记项目；若当前目录不是已登记项目，则显示项目选择列表：

```bash
sandcastle
```

也可以直接指定仓库：`sandcastle C:/projects/another-repo`。不需要手动输入生成的入口文件路径；`npx @yogioo/sandcastle` 仍可作为未安装全局 CLI 时的后备方式。

```typescript
// 通过 JS API 运行代理
import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

await run({
  agent: claudeCode(), // 省略模型则使用 CLI 默认；也可传入字符串固定模型
  sandbox: docker(), // 或 podman()、vercel()、自定义提供商
  promptFile:
    "C:/Users/me/AppData/Local/Sandcastle/projects/my-project/.sandcastle/prompt.md",
});
```

## 在其他仓库中本地开发

当你在本仓库开发 Sandcastle，并希望在另一个 Git 仓库中本地试用时，使用此工作流。它直接在宿主机上运行 Codex，同时为代理分配独立的 Git worktree，无需 Docker。

前置条件：

- Node.js 与 npm
- Git
- 已通过 `codex login` 认证的 [Codex CLI](https://developers.openai.com/codex/cli/)，或配置 `OPENAI_API_KEY`

首先，构建并 link 本仓库：

```powershell
cd C:\projects\sandcastle
npm run build
npm link
```

然后在目标仓库中 link：

```powershell
cd C:\projects\your-project
npm link @yogioo/sandcastle
New-Item -ItemType Directory -Force C:\tools\unity-agent\your-project
@"
OPENAI_API_KEY=
"@ | Set-Content C:\tools\unity-agent\your-project\.env
```

若不使用 `codex login`，请在 `C:\tools\unity-agent\your-project\.env` 中设置
`OPENAI_API_KEY`。在 `C:\tools\unity-agent\your-project\local-task.ts` 创建项目特定任务：

```typescript
import { codex, createWorktree } from "@yogioo/sandcastle";
import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox";

const repoDir = "C:/projects/your-project";
const stateDir = "C:/tools/unity-agent/your-project";

await using worktree = await createWorktree({
  cwd: repoDir,
  stateDir,
  branchStrategy: { type: "branch", branch: "agent/local-task" },
});

const result = await worktree.run({
  agent: codex("gpt-5.6-terra"),
  sandbox: noSandbox(),
  prompt: "描述实现任务及所需验证步骤。",
});

console.log(result.commits);
```

从任意目录运行，Sandcastle 会把 `.env`、日志、worktree 和 patches 放入
`stateDir`，而 Git 操作仍针对 `cwd`：

```powershell
npx tsx --env-file="C:\tools\unity-agent\your-project\.env" "C:\tools\unity-agent\your-project\local-task.ts"
```

`noSandbox()` 表示代理直接在宿主机上执行命令。Git worktree 隔离的是分支与工作目录，不隔离宿主机凭据、网络访问或已安装工具。请使用专用分支，合并前审查提交。

### 外部状态目录

当外部工作流需要直接操作另一个仓库、且不想在其中添加 Sandcastle 文件时，使用 `stateDir`：

```typescript
import { codex, run } from "@yogioo/sandcastle";
import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox";

await run({
  cwd: "C:/projects/MyUnityGame",
  stateDir: "C:/tools/unity-agent/MyUnityGame",
  promptFile: "C:/tools/unity-agent/prompts/implement.md",
  agent: codex("gpt-5.6-terra"),
  sandbox: noSandbox(),
  branchStrategy: { type: "head" },
  maxIterations: 3,
});
```

`cwd` 仍是 Git 操作与代理命令的目标仓库。`stateDir` 是完整的 Sandcastle 状态根，包含 `.env`、默认日志、外部 worktree 和 patches。是否提交仍由提示词及外围 `main.mts` 工作流控制；Sandcastle 既不强制也不阻止提交。

## 沙箱提供商

Sandcastle 通过 `SandboxProvider` 创建隔离环境。`run()`、`interactive()`、`createSandbox()` 的 `sandbox` 选项可接受任意提供商，包括 `noSandbox()`——在不需要容器隔离时，可选择在宿主机上直接运行代理。内置提供商：

| 提供商 | 导入路径                                  | 类型     | 可用于                                      |
| ------ | ----------------------------------------- | -------- | ------------------------------------------- |
| Docker | `@yogioo/sandcastle/sandboxes/docker`     | 绑定挂载 | `run()`、`createSandbox()`、`interactive()` |
| Podman | `@yogioo/sandcastle/sandboxes/podman`     | 绑定挂载 | `run()`、`createSandbox()`、`interactive()` |
| Vercel | `@yogioo/sandcastle/sandboxes/vercel`     | 隔离     | `run()`、`createSandbox()`、`interactive()` |
| 无沙箱 | `@yogioo/sandcastle/sandboxes/no-sandbox` | 无       | `run()`、`createSandbox()`、`interactive()` |

Worktree 方法（`wt.run()`、`wt.interactive()`、`wt.createSandbox()`）接受与顶层对应方法相同的提供商。未指定沙箱时，`wt.interactive()` 默认为 `noSandbox()`。

```typescript
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { podman } from "@yogioo/sandcastle/sandboxes/podman";
import { vercel } from "@yogioo/sandcastle/sandboxes/vercel";
import { noSandbox } from "@yogioo/sandcastle/sandboxes/no-sandbox";

// Docker、Podman、Vercel 在 run() 与 createSandbox() 中可互换：
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "...",
});

// noSandbox() 在宿主机直接运行代理，跳过容器隔离：
await interactive({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: noSandbox(),
  prompt: "...", // 可选——省略则以无初始提示启动 TUI
  cwd: "/path/to/other-repo", // 可选——默认 process.cwd()
});
```

也可使用 `createBindMountSandboxProvider` 或 `createIsolatedSandboxProvider` [创建自定义提供商](#自定义沙箱提供商)。

## API

Sandcastle 导出程序化 `run()` 函数，供脚本、CI 流水线或自定义工具使用。以下示例使用 `docker()`，任意 `SandboxProvider` 均可替换。

```typescript
import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  promptFile: ".sandcastle/prompt.md",
});

console.log(result.iterations.length); // 已执行迭代次数
console.log(result.iterations); // 每轮迭代结果（含可选 sessionId）
console.log(result.commits); // 创建的提交 { sha } 数组
console.log(result.branch); // 目标分支名
```

### 全部选项

```typescript
import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

const result = await run({
  // 代理提供商——必填。向 claudeCode() 传入模型字符串。
  // 可选第二参数为提供商专属选项（如 effort 级别）。
  agent: claudeCode("claude-opus-4-8", { effort: "high" }),

  // 沙箱提供商——必填。任意 SandboxProvider（docker、podman、vercel 或自定义）。
  // 提供商专属配置（如 imageName、mounts）写在工厂函数调用内。
  sandbox: docker({
    imageName: "sandcastle:local",
    // 可选：覆盖 --user 使用的 UID/GID（默认宿主机 UID/GID）。
    // 须与镜像内 UID 一致。预检会捕获不匹配。
    // containerUid: 1000,
    // containerGid: 1000,
    // 可选：将宿主机目录挂载进沙箱（如包管理器缓存）
    // hostPath 支持绝对路径、~ 展开及相对路径（相对 cwd 解析）。
    // sandboxPath 支持绝对与相对路径（相对沙箱仓库目录解析）。
    mounts: [
      { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true },
      { hostPath: "data", sandboxPath: "data" }, // 挂载 <cwd>/data → <sandbox-repo>/data
    ],
    // 可选：SELinux 卷标签——"z"（默认，共享）、"Z"（私有）或 false（无）。
    // 非 SELinux 系统上无效（macOS/Windows 上的 Docker Desktop、无 SELinux 的 Linux）。
    selinuxLabel: "z",
    // 可选：启动时合并的提供商级环境变量
    env: { DOCKER_SPECIFIC: "value" },
    // 可选：将容器接入 Docker 网络——字符串或字符串数组
    network: "my-network",
    // 可选：通过 --group-add 将容器用户加入附加组。
    // 接受组名或数字 GID（如绑定挂载的 Docker socket）。
    groups: ["docker", 999],
    // 可选：通过 --device 暴露宿主机设备。每项为 host[:container[:permissions]] 形式（如 "/dev/kvm"）。
    devices: ["/dev/kvm"],
    // 可选：通过 --cpus 限制 CPU。允许小数（如 1.5）。
    // cpus: 2,
  }),

  // 宿主机仓库目录——替代 process.cwd()，作为
  // .sandcastle/ 产物（worktree、日志、env、补丁）与 git 操作的锚点。
  // 相对路径相对 process.cwd() 解析。默认 process.cwd()。
  cwd: "../other-repo",

  // Sandcastle 状态根：.env、日志、worktree 与 patches。
  // 默认使用用户缓存目录；可通过 stateDir 显式指定位置。
  stateDir: "../unity-agent-state",

  // 分支策略——控制代理改动与分支的关系。
  // 绑定挂载提供商默认 { type: "head" }，隔离提供商默认 { type: "merge-to-head" }。
  branchStrategy: { type: "branch", branch: "agent/fix-42" },

  // 提示词来源——二选一，不可同时提供。
  // 注意：promptFile 相对 process.cwd() 解析，而非 cwd。
  promptFile: ".sandcastle/prompt.md", // 提示词文件路径
  // prompt: "修复本仓库 issue #42", // 或内联提示词字符串

  // 替换提示词中 {{KEY}} 占位符的值。
  promptArgs: {
    ISSUE_NUMBER: "42",
  },

  // 停止前的最大代理迭代次数。默认：1
  maxIterations: 5,

  // 本次运行的显示名，作为日志输出前缀。
  name: "fix-issue-42",

  // 按运行位置分组的生命周期钩子：host 或 sandbox。
  hooks: {
    host: {
      onWorktreeReady: [{ command: "cp .env.example .env" }],
      onSandboxReady: [{ command: "echo setup done" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "npm install" }],
    },
  },

  // 容器启动前复制进沙箱的、相对宿主机路径的文件。
  // 不支持 branchStrategy: { type: "head" }。
  copyToWorktree: [".env"],

  // 覆盖内置生命周期步骤的默认超时。未设置的键保留默认值。
  timeouts: {
    copyToWorktreeMs: 120_000, // 默认：60_000
    gitSetupMs: 30_000, // 默认：10_000
    commitCollectionMs: 60_000, // 默认：30_000
    mergeToHostMs: 60_000, // 默认：30_000
  },

  // 如何记录进度。默认：写入用户缓存 stateDir/logs/ 下的文件
  logging: {
    type: "file",
    path: "../unity-agent-state/logs/my-run.log",
    // 可选：将代理输出流转发到自有可观测系统。
    // 每个文本块、工具调用及原始 stdout 行都会触发。
    // 回调抛错会被吞掉，避免转发器故障导致运行失败。
    onAgentStreamEvent: (event) => {
      // event 为 { type: "text" | "toolCall" | "raw", iteration, timestamp, ... }
      myLogger.info(event);
    },
    // 可选：将代理发出的每条原始 stdout 行追加到同一日志文件，
    // 与人类可读输出交错。包含提供商流解析器会丢弃的行。用于调试卡住或异常行为。
    verbose: true,
  },
  // logging: { type: "stdout", verbose: true }, // 或终端模式（verbose：原始行输出到 stdout）

  // 代理发出后提前结束迭代循环的字符串（或字符串数组）。
  // 默认："<promise>COMPLETE</promise>"
  completionSignal: "<promise>COMPLETE</promise>",

  // 空闲超时（秒）——代理每次产生输出时重置。默认：600（10 分钟）
  idleTimeoutSeconds: 600,

  // 代理已发出完成信号但进程尚未退出时的宽限窗口（秒）（“挂起进程”——
  // 通常是子进程 gh/git 或 MCP 服务器保持 stdout 打开）。每次后续输出行会重置，
  // 以便仍捕获尾部数据。默认：60
  completionTimeoutSeconds: 60,

  // 结构化输出——从代理 stdout 提取类型化负载。
  // 要求 maxIterations === 1，且提示词须包含配置的开标签。
  // output: Output.object({ tag: "result", schema: z.object({ answer: z.number() }) }),
  // output: Output.string({ tag: "summary" }),
});

console.log(result.iterations.length); // 已执行迭代次数
console.log(result.completionSignal); // 匹配到的信号字符串，未触发则为 undefined
console.log(result.commits); // 创建的提交 { sha } 数组
console.log(result.branch); // 目标分支名
```

### `createSandbox()`——可复用沙箱

需要在单个沙箱内运行多个代理（或同一代理多轮）时使用 `createSandbox()`。沙箱只创建一次，可多次调用 `sandbox.run()`，避免重复启动容器，且所有运行在同一分支上。

若只需单次调用，用 `run()` 即可——它会自动管理沙箱生命周期。

#### 基本单次用法

```typescript
import { createSandbox, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});

const result = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "修复本仓库 issue #42。",
});

console.log(result.commits); // [{ sha: "abc123" }]
```

#### 多轮：实现后审查

```typescript
import { createSandbox, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// 步骤 1：实现
const implResult = await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// 步骤 2：同一分支、同一容器内审查
const reviewResult = await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "审查改动并修复问题。",
});
```

所有 `run()` 的提交会累积在同一分支。容器在运行间保持存活，依赖与构建产物得以保留。

`sandbox.exec()` 允许在温沙箱中直接执行 shell 命令——适合在启动审查前用快速验证门禁实现步骤：

```typescript
await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

await sandbox.run({
  agent: claudeCode("claude-opus-4-8"),
  promptFile: ".sandcastle/implement.md",
  maxIterations: 5,
});

// 审查前验证——非零 exitCode 会返回，不会抛出。
const tests = await sandbox.exec("npm test");
if (tests.exitCode !== 0) {
  throw new Error(`测试失败:\n${tests.stdout}\n${tests.stderr}`);
}

await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "审查改动并修复问题。",
});
```

`cwd` 默认为沙箱仓库路径，与 `interactive()` 一致。可传 `cwd` 覆盖。

#### 使用 `await using` 自动清理

`await using` 在块退出时自动调用 `sandbox.close()`。若有未提交改动，worktree 会保留在磁盘；若干净，则同时移除容器与 worktree。

#### 手动 `close()` 与 `CloseResult`

```typescript
const sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
});
// ... 运行代理 ...
const closeResult = await sandbox.close();
if (closeResult.preservedWorktreePath) {
  console.log(`Worktree 已保留于 ${closeResult.preservedWorktreePath}`);
}
```

#### `CreateSandboxOptions`

| 选项             | 类型            | 默认值          | 说明                                                        |
| ---------------- | --------------- | --------------- | ----------------------------------------------------------- |
| `branch`         | string          | —               | **必填。** 沙箱使用的显式分支                               |
| `sandbox`        | SandboxProvider | —               | **必填。** 沙箱提供商（如 `docker()`、`podman()`）          |
| `cwd`            | string          | `process.cwd()` | 宿主机仓库目录——相对路径相对 `process.cwd()` 解析           |
| `stateDir`       | string          | 用户缓存目录    | Sandcastle 状态根；可外置 `.env`、日志、worktree 与 patches |
| `hooks`          | SandboxHooks    | —               | 生命周期钩子（`host.*`、`sandbox.*`）——创建时执行一次       |
| `copyToWorktree` | string[]        | —               | 创建时复制进沙箱的、相对宿主机的文件路径                    |
| `timeouts`       | Timeouts        | —               | 覆盖内置生命周期超时（`copyToWorktreeMs`、`gitSetupMs` 等） |

#### `Sandbox`

| 属性 / 方法             | 类型                                                                     | 说明                                                                        |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `branch`                | string                                                                   | 沙箱所在分支                                                                |
| `worktreePath`          | string                                                                   | worktree 在宿主机上的路径                                                   |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                       | 在已有沙箱内调用代理                                                        |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>`       | 在沙箱内启动交互会话                                                        |
| `exec(cmd, options?)`   | `(command: string, options?: SandboxExecOptions) => Promise<ExecResult>` | 在沙箱中执行 shell 命令。`cwd` 默认沙箱仓库路径。非零 exitCode 返回，不抛出 |
| `close()`               | `() => Promise<CloseResult>`                                             | 销毁容器与沙箱                                                              |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                                    | 通过 `await using` 自动销毁                                                 |

#### `SandboxRunOptions`

| 选项                       | 类型               | 默认值                        | 说明                                                                  |
| -------------------------- | ------------------ | ----------------------------- | --------------------------------------------------------------------- |
| `agent`                    | AgentProvider      | —                             | **必填。** 代理提供商（如 `claudeCode("claude-opus-4-8")`）           |
| `prompt`                   | string             | —                             | 内联提示词（与 `promptFile` 互斥）                                    |
| `promptFile`               | string             | —                             | 提示词文件路径（与 `prompt` 互斥）                                    |
| `promptArgs`               | PromptArgs         | —                             | `{{KEY}}` 占位符替换的键值映射                                        |
| `maxIterations`            | number             | `1`                           | 最大迭代次数                                                          |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | 代理发出后提前结束迭代循环的字符串                                    |
| `idleTimeoutSeconds`       | number             | `600`                         | 空闲超时（秒）——每次代理输出事件重置                                  |
| `completionTimeoutSeconds` | number             | `60`                          | 观察到完成信号但代理进程未退出后的宽限窗口                            |
| `name`                     | string             | —                             | 运行显示名                                                            |
| `logging`                  | object             | file（自动生成）              | `{ type: 'file', path }` 或 `{ type: 'stdout' }`                      |
| `resumeSession`            | string             | —                             | 按 ID 恢复先前会话。与 `maxIterations > 1` 不兼容。宿主机须有会话文件 |
| `signal`                   | AbortSignal        | —                             | 中止时取消运行；句柄之后仍可用                                        |

#### `SandboxRunResult`

| 字段                       | 类型                                                                                     | 说明                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `iterations`               | `IterationResult[]`                                                                      | 每轮迭代结果（用 `.length` 取数量）                                        |
| `completionSignal`         | string?                                                                                  | 匹配到的完成信号，未触发则为 `undefined`                                   |
| `stdout`                   | string                                                                                   | 所有迭代的合并代理输出                                                     |
| `commits`                  | `{ sha }[]`                                                                              | 运行期间创建的提交                                                         |
| `logFilePath`              | string?                                                                                  | 日志文件路径（仅文件日志时）                                               |
| `resume(prompt, options?)` | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | 在同一温沙箱内继续已捕获会话的一轮迭代。仅当提供商捕获了 session id 时存在 |
| `fork(prompt, options?)`   | `(prompt: string, options?: ResumeSandboxRunResultOptions) => Promise<SandboxRunResult>` | 在同一温沙箱内从已捕获会话分叉一轮迭代。父会话保持不变（ADR 0018）         |

#### `CloseResult`

| 字段                    | 类型    | 说明                                           |
| ----------------------- | ------- | ---------------------------------------------- |
| `preservedWorktreePath` | string? | 有未提交改动时保留的 worktree 在宿主机上的路径 |

### `createWorktree()`——独立 worktree 生命周期

需要将 git worktree 作为与沙箱无关的一等概念时使用 `createWorktree()`——例如先交互探索，再将同一 worktree 交给沙箱化 AFK 代理。

仅接受 `branch` 与 `merge-to-head` 策略；`head` 在类型层面为错误（表示不创建 worktree）。

传 `cwd` 可指向非 `process.cwd()` 的仓库。相对路径相对 `process.cwd()` 解析；绝对路径原样使用。路径不存在或不是目录时抛出 `CwdError`。

```typescript
import { createWorktree } from "@yogioo/sandcastle";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  copyToWorktree: ["node_modules"],
  cwd: "/path/to/other-repo", // 可选——默认 process.cwd()
});

console.log(wt.worktreePath); // worktree 在宿主机上的路径
console.log(wt.branch); // "agent/fix-42"

// 在 worktree 中运行交互会话（默认 noSandbox）
await wt.interactive({
  agent: claudeCode("claude-opus-4-8"),
  prompt: "探索代码库并理解该 bug。",
});

// 在 worktree 中运行 AFK 代理（必须提供沙箱）
const result = await wt.run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker({ imageName: "sandcastle:myrepo" }),
  prompt: "修复 issue #42。",
  maxIterations: 3,
});
console.log(result.commits); // 运行期间的提交

// 从 worktree 创建长生命周期沙箱
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

await using sandbox = await wt.createSandbox({
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// sandbox.close() 仅销毁容器——worktree 保留
await sandbox.close();

// wt.close() 清理 worktree
```

`wt.close()` 会检查未提交改动：worktree 脏则保留在磁盘；干净则删除。`await using` 会自动调用 `close()`。`run()`、`interactive()`、`createSandbox()` 完成后 worktree 仍存在，可交给其他代理或人工检查。

使用 `branchStrategy: { type: "merge-to-head" }` 时，每次 `wt.run()` / `wt.interactive()` 会在返回前将代理提交合并回宿主机当前分支，worktree 源分支跨调用保留。（与顶层 `run()` 不同——后者合并后会删除临时分支。）

**所有权拆分**：通过 `wt.createSandbox()` 创建沙箱时，`sandbox.close()` 只销毁容器，worktree 由 `wt.close()` 负责。顶层 `createSandbox()` 则 `sandbox.close()` 同时拥有容器与 worktree。

#### `CreateWorktreeOptions`

| 选项             | 类型                   | 默认值       | 说明                                                                   |
| ---------------- | ---------------------- | ------------ | ---------------------------------------------------------------------- |
| `branchStrategy` | WorktreeBranchStrategy | —            | **必填。** `{ type: "branch", branch }` 或 `{ type: "merge-to-head" }` |
| `stateDir`       | string                 | 用户缓存目录 | Sandcastle 状态根；worktree 与日志写入此目录                           |
| `copyToWorktree` | string[]               | —            | 创建时复制进 worktree 的、相对宿主机的文件路径                         |
| `timeouts`       | Timeouts               | —            | 覆盖内置生命周期超时                                                   |

#### `Worktree`

| 属性 / 方法              | 类型                                                                  | 说明                                  |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------- |
| `branch`                 | string                                                                | worktree 所在分支                     |
| `worktreePath`           | string                                                                | worktree 在宿主机上的路径             |
| `run(options)`           | `(options: WorktreeRunOptions) => Promise<WorktreeRunResult>`         | 在 worktree 中运行 AFK 代理（须沙箱） |
| `interactive(options)`   | `(options: WorktreeInteractiveOptions) => Promise<InteractiveResult>` | 在 worktree 中运行交互代理            |
| `createSandbox(options)` | `(options: WorktreeCreateSandboxOptions) => Promise<Sandbox>`         | 基于此 worktree 创建长生命周期沙箱    |
| `close()`                | `() => Promise<CloseResult>`                                          | 清理 worktree（脏则保留）             |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                                 | 通过 `await using` 自动清理           |

#### `WorktreeInteractiveOptions`

| 选项         | 类型                   | 默认值        | 说明                                                         |
| ------------ | ---------------------- | ------------- | ------------------------------------------------------------ |
| `agent`      | AgentProvider          | —             | **必填。** 代理提供商                                        |
| `sandbox`    | AnySandboxProvider     | `noSandbox()` | 沙箱提供商（默认无沙箱）                                     |
| `prompt`     | string                 | —             | 内联提示词（与 `promptFile` 互斥）                           |
| `promptFile` | string                 | —             | 提示词文件路径                                               |
| `name`       | string                 | —             | 可选会话名                                                   |
| `hooks`      | SandboxHooks           | —             | 生命周期钩子（`host.*`、`sandbox.*`）                        |
| `promptArgs` | PromptArgs             | —             | `{{KEY}}` 占位符替换                                         |
| `env`        | Record<string, string> | —             | 注入沙箱的环境变量                                           |
| `signal`     | AbortSignal            | —             | 中止时取消会话。worktree 保留在磁盘。以 `signal.reason` 拒绝 |

#### `WorktreeRunOptions`

| 选项                       | 类型                   | 默认值 | 说明                                                  |
| -------------------------- | ---------------------- | ------ | ----------------------------------------------------- |
| `agent`                    | AgentProvider          | —      | **必填。** 代理提供商                                 |
| `sandbox`                  | SandboxProvider        | —      | **必填。** 沙箱提供商（AFK 代理必须沙箱化）           |
| `prompt`                   | string                 | —      | 内联提示词（与 `promptFile` 互斥）                    |
| `promptFile`               | string                 | —      | 提示词文件路径                                        |
| `maxIterations`            | number                 | 1      | 最大迭代次数                                          |
| `completionSignal`         | string \| string[]     | —      | 提前结束迭代循环的子串                                |
| `idleTimeoutSeconds`       | number                 | 600    | 空闲超时（秒）                                        |
| `completionTimeoutSeconds` | number                 | 60     | 完成信号后、进程未退出时的宽限窗口                    |
| `name`                     | string                 | —      | 可选运行名                                            |
| `logging`                  | LoggingOption          | file   | 日志模式                                              |
| `hooks`                    | SandboxHooks           | —      | 生命周期钩子                                          |
| `promptArgs`               | PromptArgs             | —      | `{{KEY}}` 占位符替换                                  |
| `env`                      | Record<string, string> | —      | 注入沙箱的环境变量                                    |
| `resumeSession`            | string                 | —      | 恢复先前会话。与 `maxIterations > 1` 不兼容           |
| `signal`                   | AbortSignal            | —      | 中止时取消运行；终止进行中的代理子进程；worktree 保留 |

#### `WorktreeRunResult`

| 属性               | 类型                | 说明                           |
| ------------------ | ------------------- | ------------------------------ |
| `iterations`       | `IterationResult[]` | 每轮迭代结果                   |
| `completionSignal` | string              | 匹配到的完成信号，或 undefined |
| `stdout`           | string              | 所有代理迭代的合并 stdout      |
| `commits`          | { sha: string }[]   | 代理运行期间创建的提交列表     |
| `branch`           | string              | 代理工作的分支名               |
| `logFilePath`      | string              | 日志文件路径（若写入文件）     |

#### `WorktreeCreateSandboxOptions`

| 选项             | 类型            | 默认值 | 说明                                   |
| ---------------- | --------------- | ------ | -------------------------------------- |
| `sandbox`        | SandboxProvider | —      | **必填。** 沙箱提供商（如 `docker()`） |
| `hooks`          | SandboxHooks    | —      | 生命周期钩子                           |
| `copyToWorktree` | string[]        | —      | 创建时复制进 worktree 的文件路径       |
| `timeouts`       | Timeouts        | —      | 覆盖内置生命周期超时                   |

## 工作原理

Sandcastle 通过 **分支策略** 控制代理改动与分支的关系。有三种策略：

- **Head**（`{ type: "head" }`）——代理直接写入宿主机工作目录。无 worktree、无分支间接。绑定挂载提供商（如 `docker()`）的默认值。
- **Merge-to-head**（`{ type: "merge-to-head" }`）——在 git worktree 中创建临时分支，代理在临时分支上工作，完成后合并回 HEAD，临时分支在合并后清理。
- **Branch**（`{ type: "branch", branch: "foo" }`）——提交落在显式命名的 worktree 分支上。相同分支重复运行会复用已有 worktree，并在安全时从 `origin` fast-forward——见 [ADR 0003](docs/adr/0003-reuse-worktree-by-default.md)。

对绑定挂载提供商（如 Docker），worktree 目录挂载进容器——代理通过挂载直接写宿主机文件系统，无需同步。

对你而言，只需在 `run()` 上配置 `branchStrategy: { type: 'branch', branch: 'foo' }`，完成后即可在分支 `foo` 上得到提交。全程本地。

## 提示词

Sandcastle 使用灵活的提示词系统。你编写提示词，引擎执行——不强制工作流、任务管理或上下文来源。

### 提示词解析

必须且只能提供以下之一：

1. `prompt: "内联字符串"`——通过 `RunOptions` 直接传入
2. `promptFile: "./path/to/prompt.md"`——通过 `RunOptions` 指向文件

`prompt` 与 `promptFile` 互斥——同时提供会报错。两者都不提供时，`run()` 会要求你提供其一。

**内联提示词（`prompt: "..."`）会原样传给代理。** 不做 `{{KEY}}` 替换、不做 `` !`command` `` 展开、不注入内置 `{{SOURCE_BRANCH}}` / `{{TARGET_BRANCH}}`。若需在内联提示词中插值，在 JavaScript 中拼接字符串（`` `在分支 ${branch} 上工作…` ``）。内联提示词与 `promptArgs` 同时传入会报错——需替换请改用 `promptFile`。

以下替换与展开功能 **仅适用于** 来自 `promptFile` 的提示词。

> **约定**：`sandcastle init` 会脚手架 `.sandcastle/prompt.md`，模板通过 `promptFile: ".sandcastle/prompt.md"` 引用。这是约定，不是自动回退——除非你传入 `promptFile`，Sandcastle 不会读取 `.sandcastle/prompt.md`。

### 使用 `` !`command` `` 注入动态上下文

在提示词中使用 `` !`command` `` 拉取动态上下文。每个表达式在发送给代理前会被命令的 stdout 替换。同一提示词内所有表达式 **并行** 执行以加快展开。

命令在 `sandbox.onSandboxReady` 钩子完成后 **在沙箱内** 运行，因此与代理看到相同的仓库状态（含已安装依赖）。

```markdown
# 打开的 issue

!`gh issue list --state open --label Sandcastle --json number,title,body,comments,labels --limit 100`

# 最近提交

!`git log --oneline -10`
```

任一命令非零退出时，运行立即失败并报错。

### 使用 `{{KEY}}` 的提示词参数

在提示词中用 `{{KEY}}` 占位符，从 `promptArgs` 注入值。便于同一提示词文件在多轮运行中使用不同参数。

```typescript
import { run } from "@yogioo/sandcastle";

await run({
  promptFile: "./my-prompt.md",
  promptArgs: { ISSUE_NUMBER: 42, PRIORITY: "high" },
});
```

提示词文件中：

```markdown
处理 issue #{{ISSUE_NUMBER}}（优先级：{{PRIORITY}}）。
```

参数替换在宿主机上、shell 表达式展开之前执行，因此 `` !`command` `` 内的 `{{KEY}}` 会先被替换：

```markdown
!`gh issue view {{ISSUE_NUMBER}} --json body -q .body`
```

无对应 `promptArgs` 的 `{{KEY}}` 会报错。未使用的 `promptArgs` 会产生警告。

`` !`command` `` 展开仅对提示词文件中书写的 shell 块生效。参数值内出现的 `` !`…` `` 视为普通文本，不会对宿主机 shell 执行——可安全通过 `promptArgs` 传入用户内容（issue 标题、PR 描述、文档摘录）。

### 内置提示词参数

Sandcastle 自动向每个提示词注入两个内置参数：

| 占位符              | 值                               |
| ------------------- | -------------------------------- |
| `{{SOURCE_BRANCH}}` | 代理工作的分支（由分支策略决定） |
| `{{TARGET_BRANCH}}` | `run()` 时宿主机当前活动分支     |

无需通过 `promptArgs` 传入即可在提示词中使用：

```markdown
你正在 {{SOURCE_BRANCH}} 上工作。做 diff 时与 {{TARGET_BRANCH}} 比较。
```

在 `promptArgs` 中传入 `SOURCE_BRANCH` 或 `TARGET_BRANCH` 会报错——内置参数不可覆盖。

### 使用 `<promise>COMPLETE</promise>` 提前结束

代理输出 `<promise>COMPLETE</promise>` 时，编排器提前结束迭代循环。这是你在提示词中约定给代理的规则——引擎不会自动注入。

适用于任务型工作流：代理完成后应停止，而非跑满剩余迭代。

可通过向 `run()` 传入 `completionSignal` 覆盖默认信号。接受单个字符串或字符串数组：

```ts
await run({
  // ...
  completionSignal: "DONE",
});

// 或多个信号——首个匹配即停止：
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

在提示词中要求代理输出所选字符串，编排器检测到任一匹配即停止。匹配的信号作为 `result.completionSignal` 返回。

#### 完成信号后的挂起进程

代理进程应在发出完成信号后很快退出。若其子进程（`gh`/git 子进程、长驻 MCP 服务器等）继承 stdout 管道并保持打开，父进程可能在逻辑结束后仍挂起。否则 Sandcastle 会等到完整 `idleTimeoutSeconds` 并以 `AgentIdleTimeoutError` 失败，丢弃代理已产生的提交。

观察到完成信号后，Sandcastle 会切换到较短的 **完成超时**（默认 60 秒）。超时后运行仍成功结束，并警告进程挂起；`result.commits` 与 `result.completionSignal` 与正常退出一致。每次后续输出行会重置计时器，以便捕获信号后的尾部数据（token 用量、终端 `result` 事件、结构化输出 `<tag>` 等）。

进程正常退出总是赢得竞态，健康运行无额外延迟。完成超时仅在进程挂起时生效。

通过 `completionTimeoutSeconds` 调整：

```ts
await run({
  // ...
  completionTimeoutSeconds: 30, // 更短宽限
});
```

与 `idleTimeoutSeconds` 独立：前者在 **看到信号之前**（真正卡死 → 失败）；后者在 **看到信号之后**（挂起进程 → 警告后成功）。见 [ADR 0019](docs/adr/0019-completion-timeout-for-hanging-process.md)。

### 结构化输出

使用 `Output.object()` 从代理 stdout 提取经 schema 校验的类型化 JSON。代理在你指定的 XML 标签内输出答案，Sandcastle 解析、校验并放在 `result.output`。schema 可为任意 [Standard Schema](https://standardschema.dev) 校验器——示例用 [Zod](https://zod.dev)，Valibot、ArkType 等同样适用。设计理由见 [ADR 0010](docs/adr/0010-structured-output.md)。

```ts
import { run, Output, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";
import { z } from "zod";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: `分析代码，在 <result> 标签内以 JSON 输出结果。
    结果须符合 schema：{ summary: string; score: string }
  `,
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
  }),
});

console.log(result.output.summary); // 类型为 string
console.log(result.output.score); // 类型为 number
```

`Output.string({ tag })` 将标签内容作为纯字符串提取（trim，不解析 JSON）。两者均要求 `maxIterations` 为 `1`（默认）。解析后的提示词须包含配置的开标签字面量。

提取或校验失败时，`run()` 抛出 `StructuredOutputError`。除 `tag`、`rawMatched`、`cause`、`commits`、`branch`、`preservedWorktreePath` 外，错误还携带产生错误输出的运行的 `sessionId`（及已捕获时的 `sessionFilePath`）。

传入 `maxRetries` 可由 Sandcastle 处理重试循环。每次重试恢复同一会话并反馈 token 高效的错误描述，代理可在不重复工作的前提下重新输出正确标签。重试要求支持会话恢复的提供商（`claudeCode`、`codex`、`pi`）——对不可恢复提供商（`cursor`、`opencode`、`copilot`）使用 `maxRetries > 0` 会立即抛出。

```ts
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "分析代码并在 <result> 标签内输出 JSON。",
  output: Output.object({
    tag: "result",
    schema: z.object({ summary: z.string(), score: z.number() }),
    maxRetries: 2, // 在首次尝试之外再重试 2 次
  }),
});
```

若需手动驱动重试循环——例如自定义反馈提示词或每轮轮换模型——将 `maxRetries` 保持默认 `0`，自行恢复失败会话：

```ts
import { run, Output, StructuredOutputError } from "@yogioo/sandcastle";

try {
  return await run({ ...opts, output });
} catch (e) {
  if (e instanceof StructuredOutputError && e.sessionId) {
    return await run({
      ...opts,
      output,
      resumeSession: e.sessionId,
      prompt: `上次输出失败：${e.message}。请在 <${e.tag}> 标签内重新输出。`,
    });
  }
  throw e;
}
```

### 模板

`sandcastle init` 会提示选择沙箱提供商（Docker、Podman 或不使用沙箱）、issue 跟踪器（GitHub Issues、Beads 或自定义）及模板，并将适合特定工作流的提示词与 `main.mts` 写入用户缓存状态目录。若项目 `package.json` 含 `"type": "module"`，文件名为 `main.ts`。选择 **自定义** 会生成故意未配置完成的状态，外加 `SETUP_ISSUE_TRACKER.md` 提示词，供编码代理接线你自己的跟踪器。Git 模式由模板决定（`*-head` 为直接写当前工作树；默认模板使用 worktree / `merge-to-head`）。共七种模板：

| 模板                           | 说明                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| `blank`                        | 空白脚手架——自行编写提示词与编排                            |
| `simple-loop`                  | 逐个选取 issue 并关闭（worktree / merge-to-head）           |
| `simple-loop-head`             | 同上，但 `branchStrategy: { type: "head" }`，无 worktree    |
| `sequential-reviewer`          | 逐个实现 issue，每步后代码审查（独立 worktree 分支）        |
| `sequential-reviewer-head`     | 同上，但在当前 checkout 上实现→审查；审查看本轮 commit 范围 |
| `parallel-planner`             | 规划可并行 issue，分分支执行后合并                          |
| `parallel-planner-with-review` | 规划可并行 issue，每分支审查后合并                          |

在 `sandcastle init` 提示时选择模板，或在新仓库重新 init 尝试其他模板。使用 `--state-dir` 可以显式指定状态目录；CLI 不会因为找不到外部项目而回退到仓库内的旧 `.sandcastle`。

选择 `no-sandbox` 会使用 `noSandbox()`，代理命令直接在宿主机执行。需要 head 模式时选择 `simple-loop-head` 或 `sequential-reviewer-head`（直接修改当前工作目录）。`sequential-reviewer`、`parallel-planner` 和 `parallel-planner-with-review` 依赖独立 worktree，程序化传入 `useWorktree: false` 仍会被拒绝。

`sequential-reviewer` 与 `sequential-reviewer-head` 默认每 30 秒在宿主机上轮询 `LIST_TASKS_COMMAND`：没有可接工单时等待而不启动代理；有工单时才进入实现→审查。空转不计入 `MAX_ITERATIONS`。把生成的 `main` 里的 `IDLE_POLL_SECONDS` 设为 `0` 可改回 backlog 为空即退出。

## CLI 命令

### `sandcastle init`

脚手架用户缓存中的 `.sandcastle/` 状态目录并按选择构建容器镜像。新仓库的第一步命令。init 时选择沙箱提供商（Docker、Podman 或 `no-sandbox`）。选 Podman 会写 `Containerfile` 而非 `Dockerfile`；选 `no-sandbox` 则不生成容器文件，也不会构建镜像，代理直接在宿主机运行。

目标目录如果还不是 Git 仓库，或仓库里还没有任何 commit，init 会先询问是否自动创建仓库并写入一个空的初始 commit。选否会取消 init。非交互模式用 `--init-git true|false`。

选择 beads 时，init 会校验宿主机 `bd` CLI 是否在 PATH 上（没有则报错），并在仓库尚未初始化 beads 数据库时询问是否运行 `bd init`。选否会取消 init。非交互模式用 `--init-beads true|false`。

init 从 `packageManager` 字段或锁文件检测宿主机包管理器（npm、pnpm、yarn、bun），默认 npm。模板 `main` 若导入宿主机依赖——规划模板的 `<plan>` 与 sequential-reviewer 模板的 `<outcome>` 输出 schema 导入 [Zod](https://zod.dev)——会在 `package.json` 中尚未存在时提示用该包管理器安装，避免首次运行缓存目录中的 `main.ts` 出现 `ERR_MODULE_NOT_FOUND`。

init 的主要选项会在交互界面中选择；同时保留已有的 `--flag` 以支持 CI 和脚本。Git 模式不再作为独立交互选项——通过模板选择（`*-head` vs 默认）。stdin 非 TTY 且缺少必填 flag 时，init 快速失败并给出明确错误，而非卡在提示上。

| 选项                      | 必填 | 默认值                       | 说明                                                                                      |
| ------------------------- | ---- | ---------------------------- | ----------------------------------------------------------------------------------------- |
| `--image-name`            | 否   | `sandcastle:<repo-dir-name>` | Docker 镜像名                                                                             |
| `--agent`                 | 否   | 交互提示                     | 代理（`claude-code`、`pi`、`codex`、`cursor`、`opencode`、`copilot`）                     |
| `--model`                 | 否   | 省略（CLI 默认模型）         | 写入 `main.mts` 的模型（如 `claude-sonnet-4-6`）；省略则生成 `pi()` / `claudeCode()`      |
| `--sandbox`               | 否   | 交互提示                     | 沙箱提供商（`docker`、`podman`、`no-sandbox`）                                            |
| `--template`              | 否   | 交互提示                     | 模板（如 `blank`、`simple-loop`、`sequential-reviewer-head`）                             |
| `--issue-tracker`         | 否   | 交互提示                     | issue 跟踪器（`github-issues`、`beads`、`custom`）                                        |
| `--create-label`          | 否   | 交互提示                     | `true` / `false`——是否创建 `Sandcastle` GitHub 标签（仅 `github-issues`）                 |
| `--build-image`           | 否   | 交互提示                     | `true` / `false`——是否立即构建沙箱镜像（`custom` 或 `no-sandbox` 时静默忽略）             |
| `--install-template-deps` | 否   | 交互提示                     | `true` / `false`——是否安装模板宿主机依赖（如规划模板的 `zod`）                            |
| `--init-git`              | 否   | 交互提示                     | `true` / `false`——目标没有可用 Git 仓库时，是否自动 `git init` 并创建初始 commit          |
| `--init-beads`            | 否   | 交互提示                     | `true` / `false`——选择 beads 且仓库没有数据库时，是否自动 `bd init`（未安装 `bd` 则报错） |
| `--state-dir`             | 否   | 用户缓存目录                 | 覆盖 Sandcastle 状态目录；CLI 不会自动回退到仓库内 `.sandcastle`                          |

默认在用户缓存状态目录创建以下文件：

```
.sandcastle/
├── Dockerfile      # 沙箱环境（使用 no-sandbox 时不会生成）
├── main.ts         # 代理工作流入口（非 ESM 项目为 main.mts）
├── prompt.md       # 代理说明
├── .env            # 令牌占位（默认注释，取消注释后填写）
├── .dockerignore   # 防止凭据和运行时文件进入构建上下文
└── .gitignore      # 忽略 .env、logs/、worktrees/、patches/
```

若 `.sandcastle/` 已存在会报错，防止覆盖自定义内容。

### `sandcastle path`

打印当前目录（或指定仓库）已登记的 Sandcastle 状态目录，便于打开并编辑工作流文件（`main.ts`、`prompt.md`、`.env` 等）。成功时只在 stdout 输出一行路径，可直接复制或交给脚本使用。

```bash
sandcastle path
sandcastle path .
sandcastle path C:/projects/another-repo
```

| 选项          | 必填 | 默认值     | 说明                 |
| ------------- | ---- | ---------- | -------------------- |
| `path`        | 否   | 当前目录   | 要查询状态的仓库路径 |
| `--state-dir` | 否   | 已登记位置 | 显式指定状态目录     |

若该仓库尚未 `init`，命令会失败并提示先运行 `sandcastle init`。

### `sandcastle delete`

删除当前目录（或指定仓库）已登记的 Sandcastle 状态目录，便于重新 `init`。默认删用户缓存中的项目状态，不改仓库源码。交互模式会确认；非交互模式必须加 `--yes`。

```bash
sandcastle delete
sandcastle delete --yes
sandcastle delete C:/projects/another-repo --yes
```

| 选项           | 必填 | 默认值     | 说明                 |
| -------------- | ---- | ---------- | -------------------- |
| `path`         | 否   | 当前目录   | 要删除状态的仓库路径 |
| `--state-dir`  | 否   | 已登记位置 | 显式指定状态目录     |
| `--yes` / `-y` | 否   | 交互确认   | 跳过确认并立即删除   |

### `sandcastle docker build-image`

从已有 `.sandcastle/` 重建 Docker 镜像。修改 Dockerfile 后使用。Linux/macOS 上构建自动传入 `--build-arg AGENT_UID=$(id -u)` 与 `AGENT_GID=$(id -g)`，使镜像内 `agent` 用户与宿主机 UID 一致，避免镜像内构建文件的权限问题。

| 选项           | 必填 | 默认值                       | 说明                                           |
| -------------- | ---- | ---------------------------- | ---------------------------------------------- |
| `--image-name` | 否   | `sandcastle:<repo-dir-name>` | Docker 镜像名                                  |
| `--dockerfile` | 否   | —                            | 自定义 Dockerfile 路径（构建上下文为状态目录） |
| `--state-dir`  | 否   | 自动解析                     | 覆盖状态目录                                   |

### `sandcastle docker remove-image`

删除 Docker 镜像。

| 选项           | 必填 | 默认值                       | 说明          |
| -------------- | ---- | ---------------------------- | ------------- |
| `--image-name` | 否   | `sandcastle:<repo-dir-name>` | Docker 镜像名 |

### `sandcastle podman build-image`

从已有 `.sandcastle/` 构建 Podman 镜像。修改 Containerfile 后使用。

| 选项              | 必填 | 默认值                       | 说明                                              |
| ----------------- | ---- | ---------------------------- | ------------------------------------------------- |
| `--image-name`    | 否   | `sandcastle:<repo-dir-name>` | Podman 镜像名                                     |
| `--containerfile` | 否   | —                            | 自定义 Containerfile 路径（构建上下文为状态目录） |
| `--state-dir`     | 否   | 自动解析                     | 覆盖状态目录                                      |

### `sandcastle podman remove-image`

删除 Podman 镜像。

| 选项           | 必填 | 默认值                       | 说明          |
| -------------- | ---- | ---------------------------- | ------------- |
| `--image-name` | 否   | `sandcastle:<repo-dir-name>` | Podman 镜像名 |

### `RunOptions`

| 选项                       | 类型               | 默认值                        | 说明                                                                                 |
| -------------------------- | ------------------ | ----------------------------- | ------------------------------------------------------------------------------------ |
| `agent`                    | AgentProvider      | —                             | **必填。** 代理提供商（如 `claudeCode(...)`、`codex(...)`、`cursor(...)` 等）        |
| `sandbox`                  | SandboxProvider    | —                             | **必填。** 沙箱提供商                                                                |
| `cwd`                      | string             | `process.cwd()`               | 宿主机仓库目录——Git 操作的锚点；Sandcastle 状态由 `stateDir` 管理                    |
| `stateDir`                 | string             | 用户缓存目录                  | Sandcastle 状态根：`.env`、日志、worktree 与 patches                                 |
| `prompt`                   | string             | —                             | 内联提示词（与 `promptFile` 互斥）                                                   |
| `promptFile`               | string             | —                             | 提示词文件路径。相对 `process.cwd()`，**非** `cwd`                                   |
| `maxIterations`            | number             | `1`                           | 最大迭代次数                                                                         |
| `hooks`                    | SandboxHooks       | —                             | 生命周期钩子（`host.*`、`sandbox.*`）                                                |
| `name`                     | string             | —                             | 运行显示名                                                                           |
| `promptArgs`               | PromptArgs         | —                             | `{{KEY}}` 占位符替换                                                                 |
| `branchStrategy`           | BranchStrategy     | 按提供商默认                  | `{ type: 'head' }`、`{ type: 'merge-to-head' }` 或 `{ type: 'branch', branch: '…' }` |
| `copyToWorktree`           | string[]           | —                             | 启动前复制进沙箱的文件路径（不支持 `head` 策略）                                     |
| `logging`                  | object             | file（自动生成）              | `{ type: 'file', path }` 或 `{ type: 'stdout' }`                                     |
| `completionSignal`         | string \| string[] | `<promise>COMPLETE</promise>` | 提前结束迭代的完成信号                                                               |
| `idleTimeoutSeconds`       | number             | `600`                         | 空闲超时（秒）                                                                       |
| `completionTimeoutSeconds` | number             | `60`                          | 完成信号后挂起进程的宽限窗口。见[挂起进程](#完成信号后的挂起进程)                    |
| `resumeSession`            | string             | —                             | 恢复先前会话。与 `maxIterations > 1` 不兼容                                          |
| `signal`                   | AbortSignal        | —                             | 中止时取消运行；worktree 保留                                                        |
| `timeouts`                 | Timeouts           | —                             | 覆盖内置生命周期超时                                                                 |
| `output`                   | OutputDefinition   | —                             | 结构化输出定义。要求 `maxIterations === 1`。见[结构化输出](#结构化输出)              |

### `RunResult`

| 字段               | 类型                | 说明                                       |
| ------------------ | ------------------- | ------------------------------------------ |
| `iterations`       | `IterationResult[]` | 每轮迭代结果                               |
| `completionSignal` | string?             | 匹配到的完成信号，未触发则为 undefined     |
| `stdout`           | string              | 代理输出                                   |
| `commits`          | `{ sha }[]`         | 运行期间创建的提交                         |
| `branch`           | string              | 目标分支名                                 |
| `logFilePath`      | string?             | 日志文件路径（仅文件日志）                 |
| `output`           | T?                  | 类型化结构化输出（仅设置 `output` 选项时） |

### `IterationResult`

| 字段              | 类型              | 说明                                  |
| ----------------- | ----------------- | ------------------------------------- |
| `sessionId`       | string?           | 提供商流中的会话 ID，无则为 undefined |
| `sessionFilePath` | string?           | 已捕获会话 JSONL 的宿主机绝对路径     |
| `usage`           | `IterationUsage`? | 最后一条助手消息的 token 用量快照     |

### `IterationUsage`

| 字段                       | 类型   | 说明                   |
| -------------------------- | ------ | ---------------------- |
| `inputTokens`              | number | 消耗的输入 token       |
| `cacheCreationInputTokens` | number | 创建提示缓存的 token   |
| `cacheReadInputTokens`     | number | 从提示缓存读取的 token |
| `outputTokens`             | number | 生成的输出 token       |

### 会话捕获

每个可恢复提供商迭代后，Sandcastle 自动将代理会话文件从沙箱捕获到宿主机。Claude Code：`~/.claude/projects/<encoded-path>/<session-id>.jsonl`；Codex：`~/.codex/sessions/YYYY/MM/DD/rollout-*-<session-id>.jsonl`；Pi：`~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`。提供商专属的 `cwd` 字段会改写为宿主机仓库根，以便原生恢复命令可用。

Claude Code 下，`<session-id>/subagents/agent-*.jsonl` 中的子代理转录会尽力与主会话一并捕获；单条失败仅警告，主会话捕获失败仍导致运行失败。

`claudeCode()`、`codex()`、`pi()` 默认启用，可通过 `captureSessions: false` 关闭。无 `sessionStorage` 的提供商不尝试捕获。

### 会话恢复

向 `run()` 传入 `resumeSession`，在新沙箱内继续先前的 Claude Code、Codex 或 Pi 对话：

```typescript
const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "从上次停下的地方继续",
  resumeSession: "abc-123-def",
});
```

也可从结果继续最后捕获的会话：

```typescript
const first = await run({
  agent: codex("gpt-5.4"),
  sandbox: docker(),
  prompt: "起草计划",
});

const second = await first.resume?.("现在实现该计划");
```

`resume` 仅存在于可恢复提供商的结果上——故使用可选链。

沙箱启动前，Sandcastle 校验宿主机会话文件存在，并将其传入沙箱且改写 `cwd`。Claude Code 收到 `--resume <id>`；Codex 收到 `codex exec resume <id>` 且提示词经 stdin 管道；Pi 收到 `--session <id>`。

约束：

- `resumeSession` 与 `maxIterations > 1` 不兼容（沙箱创建前抛出）。
- 提供商宿主机会话文件必须存在。
- 仅第 1 轮迭代带恢复标志；后续迭代（若有）重新开始。
- 不支持恢复的提供商会拒绝 `resumeSession`。

### 会话分叉

`RunResult.fork(prompt, options?)` 是 `.resume()` 的兄弟：从最后捕获的会话继续，但父会话 JSONL 不动，子会话写入新 id。机制为代理原生分叉标志——Claude Code 为 `claude --resume <id> --fork-session`，Codex 为 `codex exec fork <id>`。

分叉支持单次父运行扇出为多个独立子运行：

```typescript
const parent = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "阅读代码库并总结数据模型",
});

const [reviewA, reviewB] = await Promise.all([
  parent.fork?.("审查迁移计划", {
    branchStrategy: { type: "branch", branch: "review-a" },
  }),
  parent.fork?.("审计鉴权层", {
    branchStrategy: { type: "branch", branch: "review-b" },
  }),
]);
```

**分叉仅隔离会话。** `--fork-session` 与 `codex exec fork` 只隔离代理会话 JSONL——**不**隔离分支、worktree 或沙箱。安全并发扇出（`Promise.all([r.fork(a), r.fork(b)])`）要求调用方为每个子运行通过 `branchStrategy: { type: "branch", branch: "..." }` 指定不同分支。默认 `head` 与 `merge-to-head` **不**适合并发分叉：`head` 共享宿主机工作目录，`merge-to-head` 对同一 HEAD 竞态 `git merge`。见 [ADR 0018](docs/adr/0018-fork-is-session-only.md)。

`fork` 仅存在于带 `sessionStorage` 的提供商结果上。与 `.resume()` 相同的单迭代与会话文件约束适用。

### `ClaudeCodeOptions`

`claudeCode()` 工厂的模型字符串可选；省略则不传 `--model`，由 Claude Code CLI 自己选默认模型。也可只传 options：

```typescript
agent: claudeCode();
agent: claudeCode("claude-opus-4-8", { effort: "high" });
agent: claudeCode({ effort: "high" });
```

| 选项              | 类型                                                                                           | 默认值 | 说明                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"`                                      | —      | Claude Code 推理力度（`max` 仅 Opus）                                                       |
| `env`             | `Record<string, string>`                                                                       | `{}`   | 本代理提供商注入的环境变量                                                                  |
| `captureSessions` | `boolean`                                                                                      | `true` | 捕获会话 JSONL 到宿主机以供 `claude --resume`                                               |
| `permissionMode`  | `"default"` \| `"acceptEdits"` \| `"plan"` \| `"auto"` \| `"dontAsk"` \| `"bypassPermissions"` | —      | 映射 Claude `--permission-mode`。设置后替换 AFK 运行默认的 `--dangerously-skip-permissions` |

### `CodexOptions`

`codex()` 工厂的模型字符串可选；省略则不传 `-m`，由 Codex CLI 自己选默认模型。也可只传 options：

```typescript
agent: codex();
agent: codex("gpt-5.4", { effort: "high" });
agent: codex({ effort: "high" });
```

| 选项                | 类型                                           | 默认值 | 说明                                                                          |
| ------------------- | ---------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `effort`            | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —      | 通过 `model_reasoning_effort` 设置 Codex 推理力度                             |
| `env`               | `Record<string, string>`                       | `{}`   | 本代理提供商注入的环境变量                                                    |
| `captureSessions`   | `boolean`                                      | `true` | 捕获 Codex rollout JSONL 以供恢复                                             |
| `approvalsReviewer` | `"user"` \| `"auto_review"`                    | —      | 映射 Codex `approvals_reviewer`。`"auto_review"` 时用审查代理评估每次批准提示 |

### `PiOptions`

`pi()` 工厂的模型字符串可选；省略则不传 `--model`，由 Pi CLI 自己选默认模型。也可只传 options：

```typescript
agent: pi();
agent: pi("claude-sonnet-4-6", { thinking: "high" });
agent: pi({ thinking: "high" });
```

| 选项              | 类型                                                                     | 默认值 | 说明                                        |
| ----------------- | ------------------------------------------------------------------------ | ------ | ------------------------------------------- |
| `thinking`        | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —      | 通过 `--thinking` 设置 Pi 推理力度          |
| `env`             | `Record<string, string>`                                                 | `{}`   | 本代理提供商注入的环境变量                  |
| `captureSessions` | `boolean`                                                                | `true` | 捕获 pi 会话 JSONL 以供 `pi --session <id>` |

### 提供商 `env`

**代理提供商** 与 **沙箱提供商** 均可在选项中传入 `env: Record<string, string>`，启动时与 `.sandcastle/.env` 解析结果合并：

```typescript
await run({
  agent: claudeCode("claude-opus-4-8", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { DOCKER_SPECIFIC_VAR: "value" },
  }),
  prompt: "修复 issue #42",
});
```

**合并规则：**

- 提供商 env（代理 + 沙箱）覆盖 `.sandcastle/.env` 解析结果中的同名键
- 代理与沙箱提供商 env **不得重叠**——同名键会导致 `run()` 抛出
- 未提供 `env` 时默认为 `{}`

环境变量也会自动从 `.sandcastle/.env` 与 `process.env` 解析——无需在 API 中重复传入。所需变量取决于 **代理提供商**（见 `sandcastle init` 输出）。

## 自定义沙箱提供商

Sandcastle 内置 Docker、Podman、Vercel，也可自行实现。沙箱提供商告诉 Sandcastle 如何在隔离环境中执行命令。两类：

- **绑定挂载**——沙箱可挂载宿主机目录。Sandcastle 在宿主机创建 worktree，提供商挂载进去。无需文件同步。适用于 Docker、Podman 等本地容器运行时。
- **隔离**——沙箱自有文件系统（如云端 VM）。提供商通过 `copyIn` 与 `copyFileOut` 同步代码。适用于无法访问宿主机文件系统的场景。

### 沙箱句柄约定

两类提供商的 `create()` 均返回 **沙箱句柄**，暴露：

| 方法           | 必填     | 说明                                                |
| -------------- | -------- | --------------------------------------------------- |
| `exec`         | 两者     | 执行命令，可选通过 `options.onLine` 逐行流式 stdout |
| `close`        | 两者     | 销毁沙箱                                            |
| `copyFileIn`   | 绑定挂载 | 从宿主机复制单个文件进沙箱                          |
| `copyFileOut`  | 两者     | 从沙箱复制单个文件到宿主机                          |
| `copyIn`       | 隔离     | 从宿主机复制文件或目录进沙箱                        |
| `worktreePath` | 两者     | 沙箱内仓库目录的绝对路径                            |

### `ExecResult`

每次 `exec` 返回 `ExecResult`：

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### 绑定挂载提供商示例

最小绑定挂载提供商，通过本地进程执行（无容器）：

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@yogioo/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile as fsCopyFile, mkdir as fsMkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    create: async (
      options: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath;

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line); // 将每行转发给 Sandcastle
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyFileIn: async (hostPath: string, sandboxPath: string) => {
          await fsMkdir(dirname(sandboxPath), { recursive: true });
          await fsCopyFile(hostPath, sandboxPath);
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await fsMkdir(dirname(hostPath), { recursive: true });
          await fsCopyFile(sandboxPath, hostPath);
        },

        close: async () => {
          // 本地进程无需销毁
        },
      };
    },
  });
```

### 隔离提供商示例

使用临时目录的最小隔离提供商：

```typescript
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type ExecResult,
} from "@yogioo/sandcastle";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const tempDir = () =>
  createIsolatedSandboxProvider({
    name: "temp-dir",
    create: async (): Promise<IsolatedSandboxHandle> => {
      const root = await mkdtemp(join(tmpdir(), "sandbox-"));
      const worktreePath = join(root, "workspace");
      await mkdir(worktreePath, { recursive: true });

      return {
        worktreePath,

        exec: (
          command: string,
          opts?: { onLine?: (line: string) => void; cwd?: string },
        ): Promise<ExecResult> => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });

              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];

              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });

              proc.stderr!.on("data", (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
              });

              proc.on("error", (err) => reject(err));
              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        copyIn: async (hostPath: string, sandboxPath: string) => {
          const info = await stat(hostPath);
          if (info.isDirectory()) {
            await cp(hostPath, sandboxPath, { recursive: true });
          } else {
            await mkdir(dirname(sandboxPath), { recursive: true });
            await copyFile(hostPath, sandboxPath);
          }
        },

        copyFileOut: async (sandboxPath: string, hostPath: string) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async () => {
          await rm(root, { recursive: true, force: true });
        },
      };
    },
  });
```

### 分支策略

分支策略控制代理提交落在何处。在 `run()` 上配置：

| 策略            | 行为                                  | 绑定挂载 | 隔离   |
| --------------- | ------------------------------------- | -------- | ------ |
| `head`          | 直接写宿主机工作目录。不创建 worktree | 默认     | 不适用 |
| `merge-to-head` | 临时分支工作，完成后合并回 HEAD       | 支持     | 默认   |
| `branch`        | 提交落在显式命名分支                  | 支持     | 支持   |

**选用建议：**

- **`head`**——开发时快速迭代。无分支间接、无合并。仅绑定挂载提供商（需直接访问宿主机文件系统）。
- **`merge-to-head`**——自动化安全默认。代理在临时分支工作；出错时 HEAD 不受影响。适合 CI 或无人值守运行。
- **`branch`**——需要特定分支上的提交（如 PR）。传入 `{ type: "branch", branch: "agent/fix-42" }`。

分支策略现配置在 `run()` 上，而非提供商上：

```typescript
import { run, claudeCode } from "@yogioo/sandcastle";
import { docker } from "@yogioo/sandcastle/sandboxes/docker";

// head——直接写入，仅绑定挂载（绑定挂载提供商默认）
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  prompt: "…",
});
// merge-to-head——临时分支，合并回去（隔离提供商默认）
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: tempDir(),
  prompt: "…",
});
// branch——显式命名分支
await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "…",
});
```

### 传给 `run()`

通过 `sandbox` 选项传入自定义提供商——与内置 `docker()` 用法相同：

```typescript
import { run, claudeCode } from "@yogioo/sandcastle";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: localProcess(), // 你的自定义提供商
  prompt: "修复本仓库 issue #42。",
});
```

### 参考实现

- [`src/sandboxes/docker.ts`](src/sandboxes/docker.ts)——Docker 绑定挂载（含 SELinux 标签）
- [`src/sandboxes/vercel.ts`](src/sandboxes/vercel.ts)——Vercel Firecracker 隔离提供商
- [`src/sandboxes/podman.ts`](src/sandboxes/podman.ts)——Podman 绑定挂载
- [`src/sandboxes/test-isolated.ts`](src/sandboxes/test-isolated.ts)——临时目录隔离（测试用）

## 配置

### 状态目录（`.sandcastle/`）

每个项目的 Sandcastle 工作流与运行时状态均在外部 `.sandcastle/` 状态目录。
`sandcastle init` 默认在用户缓存中创建；`--state-dir` 可显式指定其他位置。CLI 只运行带有有效外部项目清单的状态目录，不会自动消费仓库内的旧 `.sandcastle`。

### 自定义 Dockerfile

状态目录中的 `Dockerfile` 控制沙箱环境。默认模板安装：

- **Node.js 22**（基础镜像）
- **git**、**curl**、**jq**（系统依赖）
- **GitHub CLI**（`gh`）
- **Claude Code CLI**
- 非 root 用户 `agent`（必需——Claude 以此用户运行）

自定义 Dockerfile 时请保留：

- 非 root 用户（默认 `agent`）
- `git`（提交与分支操作）
- `gh`（拉取 issue）
- Claude Code CLI 已安装且在 PATH 中

按需添加项目依赖（语言运行时、构建工具等）。

### 钩子

钩子按 **运行位置** 分组——`host`（开发者机器）或 `sandbox`（容器内）：

```ts
hooks: {
  host: {
    onWorktreeReady: [{ command: "cp .env.example .env" }],
    onSandboxReady:  [{ command: "echo sandbox is up" }],
  },
  sandbox: {
    onSandboxReady: [
      { command: "npm install", timeoutMs: 300_000 },
      { command: "apt-get install -y ffmpeg", sudo: true },
    ],
  },
}
```

| 钩子                     | 运行于 | 时机                              | 工作目录                                 |
| ------------------------ | ------ | --------------------------------- | ---------------------------------------- |
| `host.onWorktreeReady`   | 宿主机 | `copyToWorktree` 之后、沙箱启动前 | worktree 路径（`head` 下为宿主机仓库根） |
| `host.onSandboxReady`    | 宿主机 | 沙箱就绪后                        | worktree 路径                            |
| `sandbox.onSandboxReady` | 沙箱   | 沙箱就绪后                        | 沙箱仓库目录                             |

**顺序：** `copyToWorktree` → `host.onWorktreeReady`（顺序）→ 创建沙箱 → `host.onSandboxReady` 与 `sandbox.onSandboxReady`（并行）。

- **宿主机钩子** 接受 `{ command: string; timeoutMs?: number }`——无 `sudo`、无 `cwd`。在命令字符串中用 `cd` 或内联环境变量。
- **沙箱钩子** 接受 `{ command: string; sudo?: boolean; timeoutMs?: number }`——`sudo: true` 提权。
- **`timeoutMs`** 覆盖默认每钩子 60 秒超时。长耗时安装可设如 `timeoutMs: 300_000`（5 分钟）。
- 同一点内沙箱钩子并行；`onSandboxReady` 的宿主机钩子与沙箱钩子并行。`host.onWorktreeReady` 按声明顺序顺序执行。
- 任一脚本非零退出则快速失败。
- 向 `run()` 传入 `signal` 时，会传递给所有钩子——中止信号会取消进行中的钩子命令。

## 开发

```bash
npm install
npm run build    # 使用 tsup 打包
npm test         # 使用 vitest 运行测试
npm run typecheck # 类型检查
```

发布 npm 包、触发 CI / Release 的流程见 [`docs/releasing.md`](docs/releasing.md)。

## 许可证

MIT
