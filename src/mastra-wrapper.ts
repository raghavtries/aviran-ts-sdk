import { AsyncLocalStorage } from 'node:async_hooks';
import { ArkClient } from './client';
import type { RunContext } from './types';

export class MastraWrapper {
  private client: ArkClient;
  private runStore = new AsyncLocalStorage<RunContext>();
  private lastRun?: RunContext;

  constructor(client: ArkClient) {
    this.client = client;
  }

  async wrapWorkflow(
    workflowFn: () => Promise<any>,
    sessionId?: string,
    metadata?: Record<string, any>
  ): Promise<any> {
    const runContext = this.client.createRun(sessionId, metadata);
    this.lastRun = runContext;

    return this.runStore.run(runContext, async () => {
      const startTime = Date.now();

      try {
        const result = await workflowFn();
        const endTime = Date.now();

        await this.client.captureStep(runContext.runId, {
          stepType: 'system',
          input: metadata?.input,
          output: result,
          stage: (metadata?.stage as string | undefined) || 'workflow',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            workflowType: 'mastra',
            ...metadata,
          },
        });

        return result;
      } catch (error) {
        const endTime = Date.now();

        await this.client.captureStep(runContext.runId, {
          stepType: 'system',
          input: metadata?.input,
          output: null,
          stage: (metadata?.stage as string | undefined) || 'workflow',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            workflowType: 'mastra',
            error: String(error),
            ...metadata,
          },
        });

        throw error;
      }
    });
  }

  async wrapAgent(
    agentFn: () => Promise<any>,
    agentName: string,
    sessionId?: string,
    metadata?: Record<string, any>
  ): Promise<any> {
    const activeRun = this.runStore.getStore() || this.lastRun || this.client.createRun(sessionId, metadata);
    this.lastRun = activeRun;

    return this.runStore.run(activeRun, async () => {
      const startTime = Date.now();

      try {
        const result = await agentFn();
        const endTime = Date.now();

        await this.client.captureStep(activeRun.runId, {
          stepType: 'llm',
          input: metadata?.input,
          output: result,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            agentName,
            ...metadata,
          },
        });

        return result;
      } catch (error) {
        const endTime = Date.now();

        await this.client.captureStep(activeRun.runId, {
          stepType: 'llm',
          input: metadata?.input,
          output: null,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            agentName,
            error: String(error),
            ...metadata,
          },
        });

        throw error;
      }
    });
  }

  async wrapTool(
    toolName: string,
    args: Record<string, any>,
    executeFn: () => Promise<any>,
    stepId?: string
  ): Promise<any> {
    const runContext = this.runStore.getStore() || this.lastRun;
    if (!runContext) {
      throw new Error('No active run. Call wrapWorkflow or wrapAgent first.');
    }

    const actualStepId = stepId || await this.client.captureStep(runContext.runId, {
      stepType: 'tool',
      input: { toolName, args },
      output: null,
      stage: 'routing',
    });

    const startTime = Date.now();

    try {
      const result = await executeFn();
      const endTime = Date.now();

      await this.client.captureToolCall(actualStepId, {
        toolName,
        args,
        result,
        metadata: {
          duration: endTime - startTime,
        },
      });

      return result;
    } catch (error) {
      const endTime = Date.now();

      await this.client.captureToolCall(actualStepId, {
        toolName,
        args,
        result: null,
        metadata: {
          error: String(error),
          duration: endTime - startTime,
        },
      });

      throw error;
    }
  }

  getCurrentRun(): RunContext | undefined {
    return this.runStore.getStore() || this.lastRun;
  }
}
