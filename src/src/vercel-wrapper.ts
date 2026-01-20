import { AsyncLocalStorage } from 'node:async_hooks';
import { ArkClient } from './client';
import type { RunContext } from './types';

export class VercelAIWrapper {
  private client: ArkClient;
  private runStore = new AsyncLocalStorage<RunContext>();
  private lastRun?: RunContext;

  constructor(client: ArkClient) {
    this.client = client;
  }

  async wrapGenerateText(
    generateTextFn: () => Promise<any>,
    sessionId?: string,
    metadata?: Record<string, any>
  ): Promise<any> {
    const runContext = this.client.createRun(sessionId, metadata);
    this.lastRun = runContext;

    return this.runStore.run(runContext, async () => {
      const startTime = Date.now();

      try {
        const result = await generateTextFn();
        const endTime = Date.now();

        await this.client.captureStep(runContext.runId, {
          stepType: 'llm',
          input: result.prompt || metadata?.prompt,
          output: result.text,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            model: result.model,
            usage: result.usage,
          },
        });

        return result;
      } catch (err) {
        const endTime = Date.now();

        await this.client.captureStep(runContext.runId, {
          stepType: 'llm',
          input: metadata?.prompt,
          output: null,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            error: String(err),
          },
        });

        throw err;
      }
    });
  }

  async wrapStreamText(
    streamTextFn: () => Promise<any>,
    sessionId?: string,
    metadata?: Record<string, any>
  ): Promise<any> {
    const runContext = this.client.createRun(sessionId, metadata);
    this.lastRun = runContext;

    const startTime = Date.now();
    const result = await streamTextFn();

    let fullText = '';
    const originalStream = result.textStream;

    const wrappedStream = (async function* (this: VercelAIWrapper) {
      try {
        for await (const chunk of originalStream) {
          fullText += chunk;
          yield chunk;
        }

        const endTime = Date.now();
        await this.client.captureStep(runContext.runId, {
          stepType: 'llm',
          input: metadata?.prompt,
          output: fullText,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            model: result.model,
            streaming: true,
          },
        });
      } catch (error) {
        const endTime = Date.now();
        await this.client.captureStep(runContext.runId, {
          stepType: 'llm',
          input: metadata?.prompt,
          output: fullText,
          stage: (metadata?.stage as string | undefined) || 'response',
          timing: {
            startTime,
            endTime,
            duration: endTime - startTime,
          },
          metadata: {
            error: String(error),
            streaming: true,
          },
        });
        throw error;
      }
    }).bind(this)();

    return {
      ...result,
      textStream: wrappedStream,
    };
  }

  async wrapToolCall(
    toolName: string,
    args: Record<string, any>,
    executeFn: () => Promise<any>,
    stepId?: string
  ): Promise<any> {
    const runContext = this.runStore.getStore() || this.lastRun;
    if (!runContext) {
      throw new Error('No active run. Call wrapGenerateText or wrapStreamText first.');
    }

    const actualStepId = stepId || await this.client.captureStep(runContext.runId, {
      stepType: 'tool',
      input: { toolName, args },
      output: null,
      stage: 'routing',
    });

    const startTime = Date.now();
    let result: any;

    try {
      result = await executeFn();
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
