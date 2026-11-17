# TraceCollector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Continue the learner's current inline teaching workflow.

**Goal:** 为本地session提供脱敏时间线、可查询摘要和有界批量JSONL追踪。

**Architecture:** Core定义事件信封、脱敏和摘要。Adapters实现批量文件写入、读取与目录管理。CLI装配同一AgentEvent消费者并分别显示任务结果和追踪保存结果。

**Tech Stack:** TypeScript strict、Node内置文件API、Zod边界校验、Vitest；使用现有依赖。

**Spec:** [确认的设计](../specs/2026-11-09-trace-collector-design.md)。下列接口为本轮实现选择，尚待计划审阅。

## Global Constraints

- 单进程本地CLI诊断模式；运行产物写入忽略的.agent/traces。
- Core保持无文件系统及Adapters依赖，跨包只用公开入口。
- 64KiB批次、100ms触发、1MiB普通在途及待写字节预算，另预留8KiB控制空间；单条记录64KiB。
- 终态槽与页脚各4KiB，单run首次终态享用保留槽，重复终态走普通队列。
- 目录0700、文件0600；保留7天，目录256MiB配额；活动文件受保护。
- 每run最多1024步摘要、4096工具摘要、256异常样例；超限计数并明确摘要截断。
- 5秒是关闭结果的报告期限，超时继续追踪同一个后台收尾Promise，普通文件IO可能延长进程退出。
- JSONL不含模型正文、工具参数或输出、错误message/stack，finishReason按允许值归一化。
- 状态、原因、错误码及文件协议类型集中定义枚举；外部数据unknown校验。
- 提交/推送/PR按用户后续授权，计划检查框不代表实现完成。

## Review Focus

- 队列按UTF-8字节计算，包含正在写入的批次，防止双缓冲突破上限。
- 缺失/重复/终态后事件留痕，首个有效结果不被覆盖。
- flush屏障必须覆盖调用前已接受记录；连续新事件不能饿死屏障。
- ENOSPC、部分写入和超时不能产生伪成功报告。
- 活动run持续增长仍要受目录配额限制；锁与文件名必须拒绝不安全输入。

## Task 1：脱敏信封与纯快照Collector（3–4h）

**Files:** 创建packages/core/src/trace/{types.ts,collector.ts,collector.test.ts}；修改packages/core/src/index.ts。

**Interfaces:** TraceCollector构造参数为runId与可选摘要上限，record(event: AgentEvent): TraceRecord | undefined，getSnapshot(): TraceSnapshot。一个实例拥有一个run，错run事件拒绝并计数；入站长度/数字约束按设计。TraceRecord包含schemaVersion=1、sequence、runId及脱敏事件。TraceSnapshot包含run、modelSteps、toolCalls、接收/拒绝计数、异常样例和summaryTruncated，所有状态用公开枚举。

- [ ] 先写测试：TEXT_DELTA中唯一敏感标记不出现在JSON.stringify(record/snapshot)中；修改调用方对象与快照不影响内部记录。
- [ ] 测试时间表A开始10、B开始12、B结束32、A结束110，断言duration为100/20，记录序号保持接收顺序。
- [ ] 测试READY后run取消为未执行，STARTED后缺结束为结果缺失；缺开始结束保留结果且duration为空；重复失败不能覆盖首次成功。
- [ ] 测试超长toolName、错误runId、NaN时间、摘要上限及异常样例上限，断言拒绝/截断可见，内存结构受限。
- [ ] 运行node node_modules/vitest/vitest.mjs run packages/core/src/trace/collector.test.ts，先观察缺少模块或断言失败，再实现并重跑。
- [ ] 学习者亲手补一项缺失事件的测试，并解释为什么不能推导精确耗时。

## Task 2：有界批处理与关闭屏障（4–6h）

**Files:** 创建packages/adapters/src/trace/{writer-types.ts,batch-writer.ts,batch-writer.test.ts}；修改公开入口。

**Interfaces:** TraceSink.write(bytes: Uint8Array): Promise<void>与close(): Promise<void>为内部可替换IO边界。BatchTraceWriter.enqueue(record: TraceRecord): TraceAdmission、flush(): Promise<TraceWriteReport>、close(): Promise<TraceWriteReport>、settled: Promise<TraceWriteReport>。Admission区分accepted/full/oversized/closed/failed；Report包含accepted/written/dropped/oversized及最后序号、状态和错误码。flush报告当次屏障统计，close报告最终统计。

- [ ] 使用可控Promise和虚拟计时写测试：阈值及100ms触发、最多一个在途write、部分批次成功后再写下一批。
- [ ] 阻塞sink后塞满1MiB，断言在途也计费、普通事件拒绝、首次终态与固定页脚可接收、重复终态走普通预算；终态仍按序号排在已接收事件之后。
- [ ] 测试flush期间新入队，屏障返回只等待屏障前记录；flush并发、重复close与关闭后入队有确定结果。
- [ ] 测试sink失败、5秒报告超时、随后IO结束时settled收敛且close只执行一次；拒绝的记录不会被报告写入成功。
- [ ] 定向运行batch-writer.test.ts观察失败后实现，绿色后解释批处理和持久性区别。

## Task 3：文件、配额、读取与恢复（3–5h）

**Files:** 创建packages/adapters/src/trace/{file-store.ts,file-store.test.ts,reader.ts,reader.test.ts}；导出FileTraceStore及readTrace。

**Interfaces:** FileTraceStore.open({directory, runId}): Promise<TraceSink>，close(): Promise<void>；每批写入都通过同一store预留配额，sink负责处理FileHandle.write部分写入。readTrace(path, signal?): AsyncIterable<TraceReadItem>，item为校验记录或完整性诊断的判别联合。文件头含UTC启动时间，页脚保存最终计数，不伪装成AgentEvent。

- [ ] 临时目录测试独占创建、权限、安全runId与锁竞争；默认单writer进程拥有目录。
- [ ] 遗留锁测试通过PID存活探测判断是否可回收，权限不足或探测不确定时拒绝；PID复用保守拒绝，锁不自动覆盖。
- [ ] 模拟短写及ENOSPC/EACCES，验证偏移推进、失败报告、资源关闭。每批预留配额包含在途与控制空间。
- [ ] 配额很小的测试同时覆盖活动文件增长、已关闭旧文件回收、保留期限及无可回收文件时拒绝。
- [ ] reader测试正常文件、缺页脚、损坏尾行、中间坏行、未知版本、超长行、序号缺口、取消和缺run终态，报告完整前缀及诊断。
- [ ] 定向测试先失败后实现；公开入口构建验证Core/Adapters边界。

## Task 4：CLI实时展示与正常退出（2–3h）

**Files:** 修改apps/cli/src/{main.ts,commands/session.ts,session/console-session.ts}，创建session/session-trace.ts及相邻测试，扩展tests/integration/session-cli.test.ts，更新README。

**Interfaces:** session命令新增--trace布尔选项，默认关闭。启用时每run创建Collector，文件头必须完成初始化后再启动该run；已有同步事件分发依次交给终端展示和Collector/writer。任务结束后异步close并报告文件与完整性，完成收尾后释放该run摘要，下一轮继续可用。工具实时状态到stderr，模型文字到stdout。

- [ ] 子进程Fake HTTP测试正常流、工具失败、Provider断流、SIGINT后继续、EOF及/exit，验证文件、唯一终态和stdout正文兼容。
- [ ] 文件无权限、配额满与慢writer测试任务状态独立、保存失败提示明确，退出超时报告后后台收尾可结束。
- [ ] 测试关闭trace时无文件输出；trace开启后脱敏标记不进入文件，CLI仍实时显示原始文本。
- [ ] README写明--trace用法、目录、保留/配额、可丢失边界、关闭超时语义与查看方式。

## Task 5：故障矩阵、压测与学习交付（4–6h）

**Files:** 创建scripts/trace-benchmark.ts、tests/integration/trace-recovery.test.ts、docs/learning/trace-collector.md；同步spec/architecture的实际完成状态。

- [ ] 子进程被杀后读取JSONL，验证完整前缀和未结束状态；不把未flush尾部缺失报告为完整。
- [ ] 离线基准生成100000条脱敏TEXT_DELTA及完整run生命周期，记录事件吞吐、缓冲高水位、write次数、flush延迟与丢弃数；分别测正常sink和受控慢sink。
- [ ] 实测结果校准64KiB/100ms等默认参数，修改后只重跑相关测试及最终工程检查。
- [ ] 学习者亲手完成一个慢IO或损坏尾行测试，复述accepted/written/durable三种边界。
- [ ] 实际执行pnpm typecheck、pnpm test、pnpm lint、pnpm format:check、pnpm build；如pnpm启动受权限影响，记录失败及现有依赖入口替代命令。原格式问题单列。
- [ ] 真实Ollama演示--trace三轮与取消后继续，记录配置和实际结果，不把离线测试替代真实证据。
- [ ] 汇总实测小时、剩余工作与截止容量；只有通过的验收项标记完成。

## 自查与交接

每项验收均归属上述能力块。正常CLI与故障路径共用同一事件协议；Task 4只消费Task 1–3公开接口。估算合计16–24h，属于剩余工作初估，旧排期尚待按实际投入重算。

拟继续采用当前会话内逐块实现与讲解。先审阅计划，再从Task 1开始，保留学习者动手题。当前已有事件代码修改继续保留，后续提交仅按授权执行。

## 实施记录

2026-11-09：Task 1代码与8项测试已实现，学习者动手验收待完成。真实Runner事件接入、脱敏、快照隔离、并行耗时、缺失/重复/迟到、摘要上限及异常元数据均有离线证据。实际执行现有依赖入口tsc构建、测试类型检查、全仓ESLint、26文件/288项Vitest和新增文件Prettier通过。

Ruling：finishReason在第一版脱敏记录中完全省去，使用MODEL_FINISHED表达完成事实，避免把开放的Provider字符串写入轨迹。后续若需要该字段，应增加允许值映射及测试。

Ruling：Collector每个实例只拥有一个run，getSnapshot无需runId参数；事件时间线由返回的TraceRecord交给后续writer，Collector内部仅保存有界摘要。文件存储、批处理和CLI尚待Task 2–4。

学习者下一步补一项模型STARTED后run取消的断言，检查state=incomplete、finishedAtMs/durationMs缺失。该练习完成前，Task 1学习验收仍待确认。

Task 1学习者练习已完成：在MODEL_STARTED回调里触发真实Runner取消，验证run=cancelled、模型=incomplete、开始时间保留、结束时间与duration缺失，并确认3条事件及无异常。定向9项测试、构建、测试类型检查及该文件lint/格式检查通过。此取消发生在Provider调用前，测试覆盖的是模型步骤开始通知后的取消边界。Task 1学习验收通过，进入Task 2批处理设计与实现。

Task 2实施更新：按学习者确认继续使用同步enqueue及满队列拒绝。新增BatchTraceWriter、TraceSink公开接口、Admission/Report枚举和8项离线测试。覆盖在途预算、UTF-8字节数、首次终态保留槽、序号缺口、100ms批次触发、并发flush屏障、关闭幂等、写入/关闭失败、关闭超时与后台settled。

实际执行现有依赖入口tsc构建、测试类型检查、全仓ESLint、27文件/297项Vitest及新增文件Prettier通过。Task 3文件sink负责部分写入、目录配额及磁盘权限；当前Task 2通过受控内存sink验证协议，尚未接入实际文件或CLI。普通字节预算包含在途原始记录，合并批次还需要至多一个批次的临时编码缓冲，属于固定额外内存开销。

2026-11-10 Ruling：按学习者要求先整体再局部，Task 3 拆出单文件 FileTraceSink 学习交付，不提前合并目录管理和CLI实现。采用已审阅的 open/write/close 草案与独立 writeFully；首次失败通知钩子保留为后续装配任务。新增13项测试覆盖部分写入/非法进度/底层异常、排他创建/权限/关闭状态、Writer真实文件顺序及footer；加现有Writer共22项定向测试通过。无自动提交。

2026-11-10 Task 3目录学习增量：实现FileTraceStore.open/close及目录权限、独占锁、所有权核对。6项测试覆盖真实目录、同名锁、并发竞争、符号链接、权限过宽及锁替换。Ruling：本次仅实现目录生命周期，已有锁保守拒绝；PID检测和自动回收仍未完成，避免把简单删除遗留锁误当成安全恢复。配额、Writer工厂、读取和CLI任务继续保留为未完成。

2026-11-12全链路交付记录：Task 3文件管理、配额、PID锁恢复、读取诊断与Task 4 CLI --trace/trace-read已实现；Task 5离线故障、SIGKILL恢复、10万事件压测和真实Ollama四轮冒烟已执行。调用关系与准确边界集中在docs/learning/trace-collector.md。旧实施记录按时间保留，不再代表当前未完成项。

Ruling：磁盘容量在同步入队前预留而非等到批次写入时才校验，才能对普通事件返回FULL并保留终态/footer空间。清理在启动/创建/真实关闭时执行，当前不在每次enqueue中异步清理。初始化文件头在Runner运行前完成。新增安全外部分配runId，避免关联ID不一致。

Review：最终只读审查发现reserve异常可导致在途write尚未结束就关闭；已通过gated sink测试复现，并增加独立drainPromise等待及失败后停止队列消费，回归通过。flush超时等待项清理也已实现。空事件Writer通过初始runId保持合法footer；目录扫描增加条数和深度上限。

限制：未知恢复门锁需人工核查、无fsync、磁盘IO可能超过报告超时；真实投入工时没有连续记录，不据此宣称总截止容量满足。没有自动提交/推送。

最终验证（2026-11-12）：pnpm typecheck/test/lint/build通过，34文件354项测试通过。format:check仅既有.vscode/settings.json失败；未修改该文件，git diff --check通过。真实Ollama和压测证据见学习文档。
