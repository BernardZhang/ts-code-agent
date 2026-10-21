import { describe, expect, it } from 'vitest';
import {
  ETaskStepStatus,
  TaskPlanner,
  type TaskPlan,
  type TaskStep,
} from './task-planner.js';

const makeSteps = (): TaskStep[] => [
  { id: 0, description: '定位原因', status: ETaskStepStatus.PENDING },
  { id: 7, description: '修复问题', status: ETaskStepStatus.PENDING },
];

const makePlan = (): TaskPlan => ({ goal: '修复测试', steps: makeSteps() });

// 冻结输入，直接暴露方法对原计划或原步骤的写入。
const freezePlan = (plan: TaskPlan): TaskPlan => {
  plan.steps.forEach(Object.freeze);
  Object.freeze(plan.steps);
  return Object.freeze(plan);
};

describe('TaskPlanner.createPlan', () => {
  const planner = new TaskPlanner();

  it('保留目标、稳定 ID、顺序及已有状态，允许 ID 为 0', () => {
    const steps = makeSteps();
    steps.reverse();
    steps[0] = {
      id: 7,
      description: '修复问题',
      status: ETaskStepStatus.COMPLETED,
    };
    expect(planner.createPlan('修复测试', steps)).toEqual({
      goal: '修复测试',
      steps,
    });
  });

  it.each(['', '  \n\t'])('拒绝空白目标 %j', (goal) => {
    expect(() => planner.createPlan(goal, makeSteps())).toThrow(
      '目标不能是空字符串',
    );
  });

  it.each(['', ' \n\t'])('拒绝空白步骤说明 %j', (description) => {
    expect(() =>
      planner.createPlan('目标', [
        { id: 0, description, status: ETaskStepStatus.PENDING },
      ]),
    ).toThrow('步骤的说明不能为空字符串');
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    '拒绝非法步骤 ID %s',
    (id) => {
      expect(() =>
        planner.createPlan('目标', [
          { id, description: '步骤', status: ETaskStepStatus.PENDING },
        ]),
      ).toThrow('任务ID必须为安全非负整数');
    },
  );

  it('拒绝第二次出现的重复 ID', () => {
    expect(() =>
      planner.createPlan('目标', [
        { id: 1, description: '定位原因', status: ETaskStepStatus.PENDING },
        { id: 1, description: '修复问题', status: ETaskStepStatus.PENDING },
      ]),
    ).toThrow('任务 ID 1 重复');
  });

  it('复制数组和步骤对象，输入与返回值可独立修改', () => {
    const steps = makeSteps();
    const before = structuredClone(steps);
    const plan = planner.createPlan('目标', steps);
    expect(steps).toEqual(before);
    expect(plan.steps).not.toBe(steps);
    const inputStep = steps.at(0);
    const outputStep = plan.steps.at(0);
    if (!inputStep || !outputStep) throw new Error('测试需要一个步骤');
    expect(outputStep).not.toBe(inputStep);
    inputStep.description = '输入修改';
    expect(outputStep.description).toBe('定位原因');
    outputStep.status = ETaskStepStatus.COMPLETED;
    expect(inputStep.status).toBe(ETaskStepStatus.PENDING);
    steps.pop();
    expect(plan.steps).toHaveLength(2);
  });
});

describe('TaskPlanner.updateStepStatus', () => {
  const planner = new TaskPlanner();

  it('按稳定 ID 更新非连续编号的步骤，保留其他内容且不修改输入', () => {
    const plan = freezePlan(makePlan());
    const before = structuredClone(plan);
    const updated = planner.updateStepStatus(
      plan,
      7,
      ETaskStepStatus.IN_PROGRESS,
    );
    expect(updated).toEqual({
      goal: plan.goal,
      steps: [
        { id: 0, description: '定位原因', status: ETaskStepStatus.PENDING },
        { id: 7, description: '修复问题', status: ETaskStepStatus.IN_PROGRESS },
      ],
    });
    expect(plan).toEqual(before);
    expect(updated).not.toBe(plan);
    expect(updated.steps).not.toBe(plan.steps);
  });

  it('未知步骤 ID 明确报错', () => {
    expect(() =>
      planner.updateStepStatus(makePlan(), 99, ETaskStepStatus.COMPLETED),
    ).toThrow();
  });

  it('允许将已完成步骤重新打开', () => {
    const completed = planner.updateStepStatus(
      makePlan(),
      7,
      ETaskStepStatus.COMPLETED,
    );
    const reopened = planner.updateStepStatus(
      completed,
      7,
      ETaskStepStatus.IN_PROGRESS,
    );
    expect(reopened.steps.find((step) => step.id === 7)?.status).toBe(
      ETaskStepStatus.IN_PROGRESS,
    );
    expect(completed.steps.find((step) => step.id === 7)?.status).toBe(
      ETaskStepStatus.COMPLETED,
    );
  });

  it('返回步骤对象与原计划隔离，包括未更新的步骤', () => {
    const plan = makePlan();
    const before = structuredClone(plan);
    const updated = planner.updateStepStatus(
      plan,
      7,
      ETaskStepStatus.COMPLETED,
    );
    for (const step of updated.steps) step.description = '修改返回值';
    expect(plan).toEqual(before);
  });
});

describe('TaskPlanner.replaceSteps', () => {
  const planner = new TaskPlanner();

  it('支持追加、删除和重排，保留目标且不修改原计划', () => {
    const plan = freezePlan(makePlan());
    const before = structuredClone(plan);
    const steps: TaskStep[] = [
      {
        id: 8,
        description: '调查测试失败',
        status: ETaskStepStatus.IN_PROGRESS,
      },
      { id: 7, description: '修复问题', status: ETaskStepStatus.COMPLETED },
    ];
    const replaced = planner.replaceSteps(plan, steps);
    expect(replaced).toEqual({ goal: plan.goal, steps });
    expect(replaced).not.toBe(plan);
    expect(plan).toEqual(before);
  });

  it('拒绝替换步骤中的重复 ID', () => {
    const step = makeSteps()[0];
    if (!step) throw new Error('测试需要一个步骤');
    expect(() => planner.replaceSteps(makePlan(), [step, { ...step }])).toThrow(
      '任务 ID 0 重复',
    );
  });

  it('拒绝替换步骤中的非法 ID 和空白说明', () => {
    expect(() =>
      planner.replaceSteps(makePlan(), [
        { id: -1, description: '调查', status: ETaskStepStatus.PENDING },
      ]),
    ).toThrow('任务ID必须为安全非负整数');
    expect(() =>
      planner.replaceSteps(makePlan(), [
        { id: 8, description: ' ', status: ETaskStepStatus.PENDING },
      ]),
    ).toThrow('步骤的说明不能为空字符串');
  });

  it('复制替换数组和步骤对象，双方后续修改互不影响', () => {
    const steps = makeSteps();
    const replaced = planner.replaceSteps(makePlan(), steps);
    expect(replaced.steps).not.toBe(steps);
    const inputStep = steps.at(0);
    const outputStep = replaced.steps.at(0);
    if (!inputStep || !outputStep) throw new Error('测试需要一个步骤');
    expect(outputStep).not.toBe(inputStep);
    inputStep.description = '修改输入';
    expect(outputStep.description).toBe('定位原因');
    outputStep.status = ETaskStepStatus.COMPLETED;
    expect(inputStep.status).toBe(ETaskStepStatus.PENDING);
    steps.pop();
    expect(replaced.steps).toHaveLength(2);
  });
});
