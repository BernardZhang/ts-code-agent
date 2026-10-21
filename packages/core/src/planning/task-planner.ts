export enum ETaskStepStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export interface TaskStep {
  id: number;
  description: string;
  status: ETaskStepStatus;
}

export interface TaskPlan {
  goal: string;
  steps: TaskStep[];
}

export class TaskPlanner {
  createPlan(goal: string, steps: TaskStep[]): TaskPlan {
    this.checkPlanValid(goal, steps);

    return {
      goal,
      steps: steps.map((step) => ({ ...step })),
    };
  }

  updateStepStatus(plan: TaskPlan, stepId: number, status: ETaskStepStatus) {
    if (!plan.steps.find((step) => step.id === stepId)) {
      throw new Error(`未知步骤 ID ${stepId}`);
    }

    return {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        status: stepId === step.id ? status : step.status,
      })),
    };
  }

  replaceSteps(plan: TaskPlan, steps: TaskStep[]) {
    this.checkPlanValid(plan.goal, steps);

    return {
      ...plan,
      steps: steps.map((step) => ({ ...step })),
    };
  }

  private checkPlanValid(goal: string, steps: readonly TaskStep[]) {
    if (!goal.trim()) {
      throw new Error('目标不能是空字符串');
    }

    // steps id重复、description空校验
    const idsSet = new Set<number>();

    for (const step of steps) {
      const { id, description } = step;

      if (idsSet.has(id)) {
        throw new Error(`任务 ID ${id} 重复`);
      }

      if (!Number.isSafeInteger(id) || id < 0) {
        throw new Error('任务ID必须为安全非负整数');
      }

      if (!description.trim()) {
        throw new Error('步骤的说明不能为空字符串');
      }

      idsSet.add(id);
    }

    return true;
  }
}
