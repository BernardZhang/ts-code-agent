# Day 4 学习与验证记录

主题：ContextManager、消息裁剪、TaskPlanner。关联 GitHub Issue #4；当前任务分支 codex/day-4-context-planner。记录覆盖本次多轮学习，实际总工时未统计。

## 实现与设计

- Core/context 定义预算、消息成本估算接口、ContextManager 和 ContextError。消息预算为总容量减输出预留和工具定义成本。
- 保留所有 system 和最新用户轮次；历史从新到旧整轮保留，遇到放不下的轮次停止，不跳过中间轮次寻找更旧的小轮次。
- 轮次从 user 开始，包含后续 assistant 和 tool 消息。整轮裁剪不会拆散原有工具交互；当前不验证输入历史本身的工具配对完整性。
- 必须保留的消息超预算时明确报错，不请求模型。错误分类包括非法预算、预算不足、历史结构与非法估算。
- Runner 每轮构建请求上下文，回答和工具结果持续追加到完整历史；最终返回完整历史，裁剪不修改输入数组。当前无逐轮请求快照持久化。
- TaskPlanner 支持创建、按稳定 ID 更新状态、替换步骤。返回新计划与独立步骤对象，拒绝重复 ID、非法数字 ID 和空白目标或说明。
- CLI plan-demo 通过 JSON Schema 请求计划，用 Zod 校验 unknown JSON，再分配 ID 和 PENDING 状态。计划是任务状态，不是执行证据。
- context-demo 离线演示更新计划并在 system 中保留最新版本。实测完整历史 4 条、请求上下文 2 条，模拟成本 309；状态为预设，不代表修复已执行。
- Adapters 的启发式估算使用完整消息与公开工具描述的 UTF-8 JSON 字节数加固定开销。agent-demo 使用配置容量，输出预留 1024。

## 学习者参与

学习者实现预算计算、校验、按轮次分组和裁剪、Runner 接入、计划创建与更新，以及模型计划解析。共同讨论了连续历史、工具调用与结果关系、稳定 ID、完整历史与实际请求的区别、测试误通过及深浅拷贝。后续常规测试由辅导者自动补齐，避免过小步骤影响学习效率。

学习者指出 Runner 顺序模式和 Promise.all 均按原调用顺序保存结果，因此当前历史可以按位置关联；暂不引入无实际外部历史入口的额外工具配对校验器。

## 工程验证

本次实际环境：机器默认 Node.js v26.11.1、全局 pnpm 10.34.7。

- pnpm test：13 个文件、130 项通过；包含构建。
- pnpm typecheck、pnpm lint、pnpm format:check：通过。
- CLI 模拟 HTTP 验证覆盖计划请求 Schema 和输出、离线 context-demo、配置预算不足时请求前失败。
- 以上数字来自错误分类实现后的验证快照。后续文档更新单独检查格式。

## 真实 Ollama 冒烟验证

本次实际读取服务版本 0.40.3，模型 qwen3:8b，模型 digest 为 500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41。两次调用均为 contextLength 8192、think false、timeoutMs 60000。未指定温度或随机种子。

1. plan-demo：任务为修复 TypeScript 项目失败测试，定位、修复并验证。耗时 10.006 秒，退出码 0，输出通过解析的 8 步计划，所有状态为 pending。只验证计划生成，不证明任务已执行。
2. agent-demo：要求通过 add 计算 1 + 2，再加 4。耗时 2.639 秒，退出码 0，模型请求 2 次、工具调用 1 次；最终输出“当前结果为 3。现在将 3 加 4。”，没有完成第二次加法。本例任务效果未通过；complete 仅表示无后续工具调用。

完整本地输出位于忽略目录 .agent/day-04-smoke.json；未记录 token 使用量，不能由耗时推导吞吐量或成功率。

## 验收边界与剩余事项

- 预算按启发式成本控制，不是精确 tokenizer 或严格上界；1024 输出预留未绑定模型输出硬上限。
- 单个长任务的工具消息都属于当前用户轮次，当前不会压缩或裁剪这一轮次，超限时停止。因此支持跨轮历史增长控制，但未实现单个长任务自动摘要和持续运行。
- 裁剪后上下文可能失去语义依赖；保留计划不自动保留工具证据，也不保证模型按计划执行。计划自动推进、结果验证器、摘要、Checkpoint 不在当前实现中。
- 所有 system 消息被移至请求开头，当前按全局规则使用；不支持中途 system 消息的原位置语义。
- TaskPlanner 是程序内 typed API；模型输入在 CLI 校验，尚未提供外部持久化计划导入。
- 未提交、推送、创建 PR 或更新 Issue；按用户后续授权处理。Day 4 不应被描述为长任务持续执行和模型任务效果全部验收完成。

## 学习总结修正：TaskPlanner 尚未接入执行主流程

今天的准确成果是：ContextManager 已接入 AgentRunner；TaskPlanner 完成独立状态管理、模型生成入口及离线演示，尚未完成计划驱动执行。此前“Day 4 主要实现完成”的总结不能理解为规划执行闭环完成。

| 能力                                               | 当前状态                           |
| -------------------------------------------------- | ---------------------------------- |
| 创建计划、按 ID 更新状态、替换步骤                 | 已实现，离线测试通过               |
| plan-demo 通过模型生成并校验计划                   | 已实现，真实模型冒烟通过           |
| context-demo 将最新计划放入上下文                  | 离线预设演示，不是实际任务执行     |
| ContextManager 接入 AgentRunner 每轮请求           | 已实现                             |
| TaskPlanner 接入 agent-demo / AgentRunner 执行流程 | 未实现                             |
| 根据执行结果更新步骤、失败后调整计划               | 未实现；仅有可供调用的状态管理方法 |
| 验证任务完成、防止模型提前结束                     | 未实现；真实计算实验已暴露提前结束 |

当前 agent-demo 仍执行“用户任务 → 模型 → 工具 → 模型”，没有运行前生成计划、每轮携带最新计划、依据工具结果推进状态的集成。下一步范围应单独明确，不能因 TaskPlanner 单元测试通过就宣称整体完成。

## TaskPlanner 接入排期核对

本次已重新读取 GitHub Issue #4、#6、#19–#24；以下为远端当前文字及本地判断，不修改 GitHub 排期。

- [Day 4 / Issue #4](https://github.com/BernardZhang/ts-code-agent/issues/4)：包含 ContextManager、消息裁剪、TaskPlanner、计划更新测试，并要求“将当天能力接入 ts-code-agent 主项目，保留可运行示例”。没有明确写出按计划驱动 AgentRunner 执行的接口或验收；当前独立示例不能作为该执行集成已完成的证据。
- [Day 6 / Issue #6](https://github.com/BernardZhang/ts-code-agent/issues/6)：CLI、日志、超时取消、基础测试与周验收，要求自主调用工具分析真实 TS 项目。适合作为通用 TaskPlanner 最小集成的建议落点，但原 Issue 未明确安排该工作。
- [Day 20 / Issue #20](https://github.com/BernardZhang/ts-code-agent/issues/20)：学习目标提到 Task Planning，编码主项为 EditTool、PatchEngine、Diff；不是明确的通用规划执行集成日。
- [Day 22 / Issue #22](https://github.com/BernardZhang/ts-code-agent/issues/22)：VerificationRunner、失败反馈、自动修复，负责 Edit → Test → Fix 与防止假成功。
- [Day 23 / Issue #23](https://github.com/BernardZhang/ts-code-agent/issues/23)：明确实现 CodeTaskPlanner、文件相关性分析、多文件依赖，验收跨文件开发任务。这是代码领域规划能力，不能据此断言通用 TaskPlanner 要一直等到 Day 23 才接入。
- [Day 24 / Issue #24](https://github.com/BernardZhang/ts-code-agent/issues/24)：完整 Code Agent CLI 与五类真实任务，作为第 4 周集成验收。

结论：现有计划没有明确指定通用 TaskPlanner 接入 Agent 执行主流程的准确日期，属于需要补清的集成排期。建议 Day 4 保留当前基础能力及未完成项，Day 6 周集成补“生成计划 → 携带最新计划执行 → 显式更新状态”的最小链路；Day 22–24 再完成验证反馈、代码任务规划及端到端验收。此建议尚未变更为远端承诺，也未提前启动实现。

学习方式同步：后续按完整能力块推进；常规测试由辅导者补齐，学习者聚焦机制、实现及关键取舍。补充理解包括 ContextError 的 code/message/name/cause，以及 CLI 在 main.ts 中手动将错误格式化为 [code] message；默认 Error.toString 不包含自定义 code。

### 排期确认更新

学习者已明确确认采用上述建议：通用 TaskPlanner 最小执行集成正式排入 Day 6。已更新 [Issue #6](https://github.com/BernardZhang/ts-code-agent/issues/6) 的标题、P0 集成任务与验收补充，以及本地 [Day 6 任务范围](../day-06-plan.md)、需求和架构文档。此前“仅为建议，尚未变更远端”的描述是核对时的历史状态，以本段为准。计划已排期不代表实现完成；原 Target Date 与工时未改。
