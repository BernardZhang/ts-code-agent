import {
  ETaskStepStatus,
  ToolErrorCode,
  ToolExecutor,
  ToolRegistry,
} from '@ts-code-agent/core';
import { describe, expect, it } from 'vitest';
import {
  createUpdatePlanTool,
  EPlanUpdateOperation,
  UPDATE_PLAN_TOOL_NAME,
  type ActiveTaskPlan,
} from './update-plan-tool.js';

function setup() {
  const draft: ActiveTaskPlan = {
    plan: {
      goal: '分析 CLI',
      steps: [
        { id: 0, description: '定位入口', status: ETaskStepStatus.COMPLETED },
        { id: 1, description: '列出命令', status: ETaskStepStatus.PENDING },
      ],
    },
    evidence: [],
    nextStepId: 2,
  };
  const registry = new ToolRegistry();
  registry.register(createUpdatePlanTool(draft, () => draft.evidence));
  const executor = new ToolExecutor(registry);
  const execute = (input: unknown) =>
    executor.execute(UPDATE_PLAN_TOOL_NAME, input, {
      signal: new AbortController().signal,
    });
  return { draft, execute };
}

describe('update_plan', () => {
  it('替换步骤保留已有 ID 和状态，为改写和新增步骤分配新 ID', async () => {
    const { draft, execute } = setup();
    expect(
      await execute({
        operation: EPlanUpdateOperation.REPLACE_STEPS,
        steps: [
          { id: 0 },
          { id: 1, description: '列出交互命令' },
          { description: '确认帮助输出' },
        ],
      }),
    ).toMatchObject({ success: true });
    expect(draft.plan.steps).toEqual([
      { id: 0, description: '定位入口', status: ETaskStepStatus.COMPLETED },
      { id: 2, description: '列出交互命令', status: ETaskStepStatus.PENDING },
      { id: 3, description: '确认帮助输出', status: ETaskStepStatus.PENDING },
    ]);
    expect(draft.nextStepId).toBe(4);
  });

  it('拒绝非法状态、未知步骤、重复 ID 和无证据完成，保留草稿', async () => {
    const { draft, execute } = setup();
    const initial = structuredClone(draft);
    const results = await Promise.all([
      execute({
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 0,
        status: 'unknown',
      }),
      execute({
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 9,
        status: ETaskStepStatus.PENDING,
      }),
      execute({
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 1,
        status: ETaskStepStatus.COMPLETED,
      }),
      execute({
        operation: EPlanUpdateOperation.REPLACE_STEPS,
        steps: [{ id: 1 }, { id: 1 }],
      }),
      execute({
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 1,
        status: ETaskStepStatus.MODEL_REPORTED,
      }),
      execute({
        operation: EPlanUpdateOperation.SET_STATUS,
        stepId: 1,
        status: ETaskStepStatus.MODEL_REPORTED,
        summary: '已计算',
        evidence: [{ runId: 'not-an-actual-run', toolCallId: '1:1' }],
      }),
    ]);
    expect(results[0]).toMatchObject({
      success: false,
      error: { code: ToolErrorCode.INVALID_ARGUMENTS },
    });
    for (const result of results.slice(1)) {
      expect(result).toMatchObject({
        success: false,
        error: { code: ToolErrorCode.EXECUTION_FAILED },
      });
    }
    expect(draft).toEqual(initial);
  });
});
