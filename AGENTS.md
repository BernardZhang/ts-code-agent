# ts-code-agent：AI 开发协作规则

## 项目目标

通过 6 周、36 个学习日，以 TypeScript 自研可调用工具的 Agent Runtime，逐步形成可评测、可展示的 Code Agent。学习理解与可运行交付同等重要。

## 开始工作前

- 阅读 `docs/spec.md` 和 `docs/architecture.md`，确认当前阶段及对应 GitHub Issue。
- 先检查现有文件、分支和未提交修改，保留用户已有工作。
- 若当前目录不是目标仓库，先确认工作位置，不在其他目录初始化工程。
- 用户已确认开始 Day 1 工程初始化及实现。后续按当前学习日和用户授权范围执行，不重复请求同一项批准。
- 修改需求和架构时同步相关文档；需求冲突先说明并澄清。

## 学习与任务范围

- 每次围绕当前学习日交付最小可运行功能，不提前实现后续周能力。
- 简要说明关键机制、设计取舍及验证方法，让用户能理解并动手修改。
- 不用大型框架替代当前阶段要学习的核心机制；Agent Loop 与 Workflow 主线自研。
- LangGraph 和多 Agent 放在第 6 周对照实验中；按需使用官方 MCP SDK。
- 不创建 Web、API 或 contracts 包，直到用户明确扩展范围。
- 不引入与当前验收无关的依赖、抽象层、数据库或服务。

## 架构边界

- `apps/cli`：配置、依赖装配、命令和终端交互。
- `packages/core`：通用接口、消息、工具、Runtime、上下文和状态机制。
- `packages/adapters`：Ollama、MCP、存储等外部系统的具体接入。
- `packages/code-agent`：仓库探索、代码修改和验证等代码领域能力，按阶段创建。
- Core 不依赖 CLI、Adapters、Code Agent 或外部服务 SDK。
- Adapters 和 Code Agent 依赖 Core；CLI 装配具体实现。
- 跨包通过公开入口导入，不引用其他包的 `src` 内部路径；避免循环依赖。

## 工程约定

- TypeScript strict、ESM、Node.js LTS、pnpm workspace。
- 初始化时记录并固定实际 Node.js 与 pnpm 版本，提交 lockfile。
- 使用 `tsx` 开发运行、`tsc` 类型检查与构建、Vitest 测试、ESLint 与 Prettier 检查格式。
- 外部输入视为 `unknown`，在边界处校验；避免无理由的 `any` 和类型断言。
- 配置集中读取和校验；提供 `.env.example`，不提交真实密钥或个人路径。
- 使用 `AbortSignal` 贯穿请求和任务；错误应区分取消、网络、HTTP、协议与校验失败。
- 模型能力不足时明确报告，不静默改变执行语义。
- 日志不污染 CLI 正常输出；不记录密钥，默认不记录完整提示词和工具内容。
- 运行产物写入 `.agent/` 并忽略；精选评测报告可另行提交。

## 测试与验收

- 单元测试与实现相邻；跨模块测试放入根目录 `tests/`。
- 默认测试不访问真实模型或网络；使用固定响应的 Fake Provider 和模拟 HTTP 数据。
- 真实 Ollama 测试独立运行，记录服务版本、模型 ID、参数和耗时；没有环境时报告未执行。
- 测试重点覆盖边界行为、协议解析、取消和错误，避免仅复述实现。
- 初始化后建立统一命令：`pnpm typecheck`、`pnpm test`、`pnpm lint`、`pnpm format:check`、`pnpm build`。
- 以上命令在根 package.json 定义，使用方式见 README；仅在实际执行后报告检查结果。
- 每次交付说明：变更内容、设计理由、执行过的检查和未验证事项。

## Git 与外部操作

- 使用任务分支，不覆盖用户修改、不执行未经授权的破坏性操作。
- 提交、推送、创建或合并 PR 按用户授权执行；单纯代码编写不自动包含发布授权。
- PR 描述围绕最终行为、验收结果和限制，不堆积对话历史。
