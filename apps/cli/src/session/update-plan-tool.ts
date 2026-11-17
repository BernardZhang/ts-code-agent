import {
  ETaskStepStatus,
  TaskPlanner,
  type TaskPlan,
  type TaskStep,
  type ToolDefinition,
} from '@ts-code-agent/core';
import { z } from 'zod';

export const UPDATE_PLAN_TOOL_NAME = 'update_plan';

export enum EPlanUpdateOperation {
  SET_STATUS = 'set_status',
  REPLACE_STEPS = 'replace_steps',
}

const stepId = z.number().int().nonnegative();
const stepDescription = z.string().trim().min(1);
const evidenceReference = z.strictObject({
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
});

const status = z.enum(ETaskStepStatus);
const evidence = z.array(evidenceReference).min(1);
const summary = z.string().trim().min(1);
const steps = z
  .array(
    z
      .strictObject({
        id: stepId.optional(),
        description: stepDescription.optional(),
      })
      .refine(
        (entry) => entry.id !== undefined || entry.description !== undefined,
      ),
  )
  .min(1);

// 发送给模型的是顶层对象 Schema。运行时再按 operation 校验必填字段。
const toolParameters = z.strictObject({
  operation: z.enum(EPlanUpdateOperation),
  stepId: stepId.optional().describe('set_status 要更新的已有步骤 ID'),
  status: status.optional().describe('set_status 要写入的状态'),
  evidence: evidence.optional().describe('completed 必须提供的工具调用引用'),
  summary: summary
    .optional()
    .describe('model_reported 必须提供可展示的结果或计算过程'),
  steps: steps.optional().describe('replace_steps 使用的完整步骤列表'),
});

const updatePlanInput = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal(EPlanUpdateOperation.SET_STATUS),
    stepId,
    status,
    evidence: evidence.optional(),
    summary: summary.optional(),
  }),
  z.strictObject({
    operation: z.literal(EPlanUpdateOperation.REPLACE_STEPS),
    steps,
  }),
]);

export const updatePlanToolDescription = {
  name: UPDATE_PLAN_TOOL_NAME,
  description:
    '显式更新当前任务计划。set_status 设置步骤状态，completed 必须引用足以支持结论的仓库工具调用。纯计算等可直接完成的步骤使用 model_reported，并提供 summary，省略 evidence。replace_steps 替换步骤列表，保留步骤时提供原 id，新增时只提供 description。',
  parameters: z.toJSONSchema(toolParameters),
};

interface PlanToolEvidence extends z.infer<typeof evidenceReference> {
  toolName: string;
}

export interface ActiveTaskPlan {
  plan: TaskPlan;
  evidence: PlanToolEvidence[];
  nextStepId: number;
}

export function createUpdatePlanTool(
  draft: ActiveTaskPlan,
  visibleEvidence: () => readonly PlanToolEvidence[],
): ToolDefinition<z.infer<typeof updatePlanInput>, unknown> {
  const planner = new TaskPlanner();

  return {
    ...updatePlanToolDescription,
    inputSchema: updatePlanInput,
    async execute(input, { signal }) {
      signal.throwIfAborted();

      if (input.operation === EPlanUpdateOperation.SET_STATUS) {
        // 模型可能用 completed 表达完成意图；只有有效工具证据才能支持该状态。
        const status =
          input.status === ETaskStepStatus.COMPLETED &&
          input.summary &&
          !input.evidence
            ? ETaskStepStatus.MODEL_REPORTED
            : input.status;
        if (status === ETaskStepStatus.MODEL_REPORTED) {
          if (!input.summary || input.evidence) {
            throw new Error('模型报告完成需要 summary，且应省略 evidence。');
          }
        } else if (status === ETaskStepStatus.COMPLETED && !input.evidence) {
          throw new Error(
            '依据工具完成步骤时必须提供有效证据；纯计算可用 model_reported 并提供 summary。',
          );
        }
        const available = visibleEvidence();
        for (const reference of input.evidence ?? []) {
          if (
            !available.some(
              ({ runId, toolCallId }) =>
                runId === reference.runId &&
                toolCallId === reference.toolCallId,
            )
          ) {
            throw new Error(
              '工具证据无效或尚未出现在当前模型请求中。只能引用已列出的 ID；纯计算可用 model_reported 并提供 summary。',
            );
          }
        }
        draft.plan = planner.updateStepStatus(draft.plan, input.stepId, status);
        return { ...input, status };
      }

      let nextStepId = draft.nextStepId;
      const usedIds = new Set<number>();
      const steps = input.steps.map((entry): TaskStep => {
        if (entry.id !== undefined) {
          if (usedIds.has(entry.id)) {
            throw new Error(`重复步骤 ID ${entry.id}`);
          }
          usedIds.add(entry.id);
          const existing = draft.plan.steps.find(({ id }) => id === entry.id);
          if (!existing) {
            throw new Error(`未知步骤 ID ${entry.id}`);
          }
          if (
            entry.description === undefined ||
            entry.description === existing.description
          ) {
            return existing;
          }
          return {
            id: nextStepId++,
            description: entry.description,
            status: ETaskStepStatus.PENDING,
          };
        }
        if (entry.description === undefined) {
          throw new Error('新增步骤必须提供描述。');
        }
        return {
          id: nextStepId++,
          description: entry.description,
          status: ETaskStepStatus.PENDING,
        };
      });
      draft.plan = planner.replaceSteps(draft.plan, steps);
      draft.nextStepId = nextStepId;
      return { operation: input.operation, steps };
    },
  };
}
