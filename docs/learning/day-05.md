# Day 5 学习与验证记录

学习日期：2026-10-21 至 2026-10-27。关联 GitHub Issue #5，任务分支 codex/day-5-readonly-tools。实际总工时未统计，原编码 3.5 小时预估未覆盖后来加入的流式多行搜索、KMP 与逐行学习范围，不能作为实际耗时。

## 实现范围

- 新增 packages/code-agent，复用 Core ToolDefinition、ToolRegistry、ToolExecutor 和 AgentRunner，不在 Core 引入文件系统或 Git 实现。
- Workspace 真实路径解析及路径关系检查，拒绝父目录、相似前缀目录和指向外部的链接目标。
- read_file：有界读取、普通文件检查、UTF-8 尾部处理、截断标记、取消与句柄清理。
- list_directory：默认 BFS，可配置 DFS，目录优先及名称排序，深度和数量限制，跳过 .git/node_modules，不跟随后代链接。
- search_code：区分大小写的多行普通文本、增量 UTF-8、CRLF 归一化、KMP 跨块及重叠匹配、起始行列、扫描预算和不完整原因。匹配片段不是完整行或上下文。
- git_status：固定 Git 命令、输出限制、取消与进程清理，纯 porcelain v1 NUL 协议解析。当前只支持工作区为仓库根目录，不代表 Git 本身不能在子目录运行。
- repo-demo：四工具装配、工作区参数、10 次模型请求上限、上下文预算及可选 --trace-tools。当前目录深度为学习者调整后的 10 层；提示明确根目录使用 .，不使用 /。诊断不输出文件正文或搜索词。

## 学习者参与与验收

学习者参与路径边界函数及目录遍历实现，讨论相对路径、真实路径、符号链接、FIFO、文件句柄检查、BFS/DFS、UTF-8 截断、缓冲区复用和增量读取。辅导者补充测试及较复杂搜索实现。已有实现或测试通过不等于学习者已逐行掌握全部逻辑。

Git 概念验收已通过：完整输出与 close、双状态、clean 不等于测试通过、超限失败、取消收尾和重命名双路径。独立修改 Git 核心代码的动手实践尚未验收。

学习者决定推迟以下深入学习，均保持未验收：

- [Issue #40](https://github.com/BernardZhang/ts-code-agent/issues/40)：KMP 前缀表、回退、跨块与重叠匹配。
- [Issue #41](https://github.com/BernardZhang/ts-code-agent/issues/41)：环形行列表与位置定位。
- [Issue #42](https://github.com/BernardZhang/ts-code-agent/issues/42)：流式解码、换行及预算边界。
- [Issue #43](https://github.com/BernardZhang/ts-code-agent/issues/43)：Git 子目录工作区及状态查询范围设计，方案未最终确认，不在本次实现。

## 本次工程检查

实际验证环境：现有 /opt/homebrew/bin/node v26.11.1。终端默认 Node 为 v16.20.2，全局 pnpm 已漂移为 12.15.0；本次通过临时 npm 缓存运行项目固定的 pnpm 10.34.7，没有在仓库安装工具链或修改用户 shell 配置。

2026-10-27 实际执行固定版本 pnpm 的以下命令：

- pnpm typecheck：通过。
- pnpm test：21 个文件、223 项通过，包含 pnpm build。
- pnpm lint：通过。
- pnpm format:check：未全通过，仅现有未跟踪 .vscode/settings.json 格式问题，保留原样。

此前新增和修改文件的定向格式检查通过。离线测试包含路径越界、空目录、大文件截断、非仓库、Git 子进程模拟及 CLI 模拟 HTTP 集成；无需真实模型或外网。Git 集成测试使用临时本机仓库，不创建业务提交。

## 真实模型四工具验收

Ollama 服务实读版本 0.40.3；模型 qwen3:8b，digest：500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41。参数：contextLength 16384、think false、timeoutMs 120000；未指定温度和随机种子。未采集本次完整耗时和 token 使用量，不给出性能或成功率结论。

在当前真实仓库运行 repo-demo，任务要求依次使用 list_directory(.)、read_file(package.json)、search_code(packages/core/src, export class AgentRunner)、git_status({})，再解释项目用途、AgentRunner 文件与起始行、未提交变化，并列出目录前 10 项及说明截断。

执行结果：退出码 0、模型请求 2 次、工具调用 4 次；--trace-tools 显示四工具均 succeeded。模型正确定位 packages/core/src/agent/runner.ts 第 40 行，与本地源码核对一致；正确指出存在未提交变化，与 git status 核对一致；项目用途基本描述正确。

回答完整性未全通过：未按要求列出目录前 10 项，未说明目录工具的 truncated。单独以相同配置核对目录结果为 50 条且 truncated=true。因此四工具调用和基础事实分析通过，不声称全部任务指令遵循通过或模型会稳定正确分析仓库。

此前默认 8192 上下文的一次真实运行，在 list_directory/read_file 成功后触发 context_budget_exceeded；显式使用 16384 后两工具任务成功。路径边界未放宽，原始用户反馈的越界具体调用参数没有记录，不能断言当时必然使用了 /。

## 剩余边界与交付状态

- 单个长轮次超上下文预算时停止，不自动压缩；16K 不是永久默认值。
- 路径检查不提供对并发替换的 OS 级隔离；搜索目录读取与排序不构成严格内存上限。
- complete/退出码 0 不保证任务完成、事实全对或测试已运行。提示词不能替代任务结果验证。
- 记录初稿时未提交或创建 PR。学习者随后明确授权提交、推送、创建 PR 并更新 Issue；最终 Commit / PR 信息以 Issue #5 为准。模型回答完整性仍未全通过，不自动关闭该 Issue。
- Day 6 通用 TaskPlanner 最小执行集成按已有排期保留，未在本次提前实现。

## 模型回答完整性判断验收

学习者完成案例推演并经追问纠正后，能够区分：事实正确与要求全部覆盖、目录截断与完整结构、工具失败与没有变化、Git clean 与测试通过、已有提交与待提交变化。能识别缺少目录前 10 项、遗漏截断说明、对失败的 Git 查询误报 clean、虚构测试通过及缺乏依据的“可以安全提交”。这轮判断验收通过；不代表此前真实模型的遗漏已修复，也不替代代码修改实践。

Day 5 主线能力和上述基础概念已学习；后续算法 Issue 仍未验收。学习者已授权提交、推送和 PR 交付；不能仅凭学习问答通过关闭 Issue #5。
