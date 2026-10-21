import { describe, expect, it } from 'vitest';
import { ETaskStepStatus, ModelError } from '@ts-code-agent/core';
import { parseTaskPlan } from './plan-demo.js';

describe('parseTaskPlan', () => {
  it('将模型计划转换成带稳定 ID 和初始状态的 TaskPlan', () => {
    expect(
      parseTaskPlan(
        JSON.stringify({
          goal: '修复测试',
          steps: ['定位原因', '修复问题'],
        }),
      ),
    ).toEqual({
      goal: '修复测试',
      steps: [
        { id: 0, description: '定位原因', status: ETaskStepStatus.PENDING },
        { id: 1, description: '修复问题', status: ETaskStepStatus.PENDING },
      ],
    });
  });

  it('去除目标和步骤说明首尾空白', () => {
    expect(
      parseTaskPlan(
        JSON.stringify({ goal: '  修复测试  ', steps: [' \n定位原因\t '] }),
      ),
    ).toEqual({
      goal: '修复测试',
      steps: [
        { id: 0, description: '定位原因', status: ETaskStepStatus.PENDING },
      ],
    });
  });

  it('非法 JSON 返回明确的模型 JSON 错误', () => {
    expect(() => parseTaskPlan('{')).toThrow(ModelError);
    expect(() => parseTaskPlan('{')).toThrow('模型输出不是合法 JSON。');
  });

  it.each([
    null,
    [],
    '计划',
    { steps: ['定位'] },
    { goal: '目标' },
    { goal: '目标', steps: [] },
    { goal: '   ', steps: ['定位'] },
    { goal: '目标', steps: [' \n '] },
    { goal: 1, steps: ['定位'] },
    { goal: '目标', steps: [1] },
    { goal: '目标', steps: '定位' },
    { goal: '目标', steps: ['定位'], extra: true },
    { task: '旧字段', steps: ['定位'] },
  ])('拒绝不符合 Schema 的模型输出：%j', (raw) => {
    expect(() => parseTaskPlan(JSON.stringify(raw))).toThrow(ModelError);
    expect(() => parseTaskPlan(JSON.stringify(raw))).toThrow(
      '模型 JSON 不符合任务规划 Schema。',
    );
  });
});
