import { ContextError, EContextErrorCode } from './errors.js';
import { EMessageRole, type ModelMessage } from '../model/messages.js';

export interface ContextBudget {
  contextWindow: number;
  reservedOutputTokens: number;
  toolDefinitionTokens: number;
}

export type MessageTokenEstimator = (message: ModelMessage) => number;

export interface MessageGroups {
  systemMessages: ModelMessage[];
  turns: ModelMessage[][];
}

const getMessageTokenBudget = (budget: ContextBudget): number => {
  return (
    budget.contextWindow -
    budget.reservedOutputTokens -
    budget.toolDefinitionTokens
  );
};

export function groupMessagesByTurn(
  messages: readonly ModelMessage[],
): MessageGroups {
  let turnIndex = 0;

  return messages.reduce<MessageGroups>(
    (messageGroups, message) => {
      const { systemMessages, turns } = messageGroups;
      const { role } = message;

      if (role === EMessageRole.SYSTEM) {
        systemMessages.push(message);
        return messageGroups;
      }

      // 用户消息开始为一轮次开始，下次用户消息之前的消息属于统一轮次
      if (role === EMessageRole.USER) {
        // 轮次开始
        if (!turns[turnIndex]) {
          turns[turnIndex] = [message];
        } else {
          // 当前轮次消息结束，下个轮次开始
          turnIndex++;
          turns[turnIndex] = [message];
        }

        return messageGroups;
      }

      if ([EMessageRole.ASSISTANT, EMessageRole.TOOL].includes(role)) {
        const currentTurn = turns[turnIndex];

        if (!currentTurn) {
          throw new ContextError(
            EContextErrorCode.INVALID_HISTORY,
            `当前轮次 ${turnIndex} 没有 ${EMessageRole.USER} 消息，却遇到 ${role} 消息`,
          );
        }

        currentTurn.push(message);
      }

      return messageGroups;
    },
    { systemMessages: [], turns: [] },
  );
}

export class ContextManager {
  constructor(
    private readonly contextBudget: ContextBudget,
    private readonly messageTokenEstimator: MessageTokenEstimator,
  ) {
    const { contextWindow, reservedOutputTokens, toolDefinitionTokens } =
      contextBudget;

    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw new ContextError(
        EContextErrorCode.INVALID_BUDGET,
        'contextWindow 必须是正的安全整数',
      );
    }

    if (
      !Number.isSafeInteger(reservedOutputTokens) ||
      reservedOutputTokens < 0
    ) {
      throw new ContextError(
        EContextErrorCode.INVALID_BUDGET,
        'reservedOutputTokens 必须是非负的安全整数',
      );
    }

    if (
      !Number.isSafeInteger(toolDefinitionTokens) ||
      toolDefinitionTokens < 0
    ) {
      throw new ContextError(
        EContextErrorCode.INVALID_BUDGET,
        'toolDefinitionTokens 必须是非负的安全整数',
      );
    }
  }

  getMessageTokenBudget() {
    const messageBudget = getMessageTokenBudget(this.contextBudget);

    if (messageBudget < 0) {
      throw new ContextError(
        EContextErrorCode.BUDGET_EXCEEDED,
        '上下文空间已满',
      );
    }

    return messageBudget;
  }

  estimateMessageTokens(messages: readonly ModelMessage[]) {
    return messages.reduce((total, message) => {
      const tokens = this.messageTokenEstimator(message);

      if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new ContextError(
          EContextErrorCode.INVALID_ESTIMATE,
          '消息 token 估算值必须是非负的安全整数',
        );
      }

      const nextTotal = total + tokens;
      if (!Number.isSafeInteger(nextTotal)) {
        throw new ContextError(
          EContextErrorCode.INVALID_ESTIMATE,
          '消息 token 总成本超出安全整数范围',
        );
      }

      return nextTotal;
    }, 0);
  }

  /**
   * 保留规则：全部system + 最新的轮次消息(至少需要保留一次用户输入)
   *
   * @param messages
   * @returns
   */
  buildContext(messages: readonly ModelMessage[]) {
    const { systemMessages, turns } = groupMessagesByTurn(messages);
    const messageTokensBudget = this.getMessageTokenBudget();
    let leftTokens = messageTokensBudget;
    const buildMessages: ModelMessage[] = [];

    // 按照轮次裁剪消息，优先保留system 和最新的轮次
    const systemMessagesTokens = this.estimateMessageTokens(systemMessages);

    leftTokens = messageTokensBudget - systemMessagesTokens;

    if (leftTokens < 0) {
      throw new ContextError(
        EContextErrorCode.BUDGET_EXCEEDED,
        '上下文空间不足以存放系统提示词',
      );
    }

    if (!turns.at(-1)) {
      throw new ContextError(EContextErrorCode.INVALID_HISTORY, '没有对话轮次');
    }

    for (let i = turns.length - 1; i >= 0; i--) {
      const currentTurn = turns[i];

      if (currentTurn) {
        const turnTokens = this.estimateMessageTokens(currentTurn);

        leftTokens -= turnTokens;

        if (leftTokens >= 0) {
          buildMessages.unshift(...currentTurn);
        } else {
          break;
        }
      }
    }

    // 没有足够tokens存放最新轮次的消息需要报错，否则没有意义
    if (!buildMessages.length) {
      throw new ContextError(
        EContextErrorCode.BUDGET_EXCEEDED,
        '必须保留的最近轮次消息超出 token 预算',
      );
    }

    // 系统消息放在最前面
    buildMessages.unshift(...systemMessages);

    return buildMessages;
  }
}
