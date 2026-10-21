import {
  ContextManager,
  EMessageRole,
  ETaskStepStatus,
  TaskPlanner,
  type ModelMessage,
} from '@ts-code-agent/core';

// ID 分配后保持稳定，与数组位置及后续重排无关。
const STEP_ID = {
  INVESTIGATE: 0,
  FIX: 1,
  VERIFY: 2,
} as const;

export function contextDemo() {
  const planner = new TaskPlanner();
  const initialPlan = planner.createPlan('修复失败测试', [
    {
      id: STEP_ID.INVESTIGATE,
      description: '定位原因',
      status: ETaskStepStatus.PENDING,
    },
    {
      id: STEP_ID.FIX,
      description: '修复实现',
      status: ETaskStepStatus.PENDING,
    },
    {
      id: STEP_ID.VERIFY,
      description: '运行测试验证',
      status: ETaskStepStatus.PENDING,
    },
  ]);
  const investigatedPlan = planner.updateStepStatus(
    initialPlan,
    STEP_ID.INVESTIGATE,
    ETaskStepStatus.COMPLETED,
  );
  const plan = planner.updateStepStatus(
    investigatedPlan,
    STEP_ID.FIX,
    ETaskStepStatus.IN_PROGRESS,
  );

  // 演示状态为预设值，不表示实际完成了代码修复或测试。
  const systemMessage: ModelMessage = {
    role: EMessageRole.SYSTEM,
    content: `以下是演示用的当前计划；步骤状态不等于任务已验证成功。\n${JSON.stringify(plan)}`,
  };
  const latestUserMessage: ModelMessage = {
    role: EMessageRole.USER,
    content: '继续修复',
  };
  const history: ModelMessage[] = [
    systemMessage,
    { role: EMessageRole.USER, content: '请先调查失败测试。' },
    {
      role: EMessageRole.ASSISTANT,
      content: '历史调查对话，当前任务进度见最新计划。',
    },
    latestUserMessage,
  ];

  // 使用序列化字符数模拟成本，不是模型 tokenizer 的真实 token 数。
  const estimateMessageTokens = (message: ModelMessage) =>
    JSON.stringify(message).length;
  const messageBudget =
    estimateMessageTokens(systemMessage) +
    estimateMessageTokens(latestUserMessage);
  const manager = new ContextManager(
    {
      contextWindow: messageBudget,
      reservedOutputTokens: 0,
      toolDefinitionTokens: 0,
    },
    estimateMessageTokens,
  );
  const context = manager.buildContext(history);

  process.stdout.write(
    `${JSON.stringify(
      {
        budgetUnit: '模拟 token 成本（JSON 序列化字符数，非真实 token）',
        messageBudget,
        estimatedContextCost: manager.estimateMessageTokens(context),
        plan,
        historyMessageCount: history.length,
        contextMessageCount: context.length,
        context,
      },
      null,
      2,
    )}\n`,
  );
}
