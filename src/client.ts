import { v4 as uuidv4 } from 'uuid';
import type {
  SDKConfig,
  RunContext,
  StepContext,
  ToolCallContext,
  CanaryStep,
  RolloutStatus,
  OptimizationCampaignRequest,
  OptimizationCampaignStatus,
  RunEvent,
  StepEvent,
  ToolCallEvent,
} from './types';

export class ArkClient {
  private config: Required<SDKConfig>;
  private eventQueue: Array<{runEvent?: RunEvent; stepEvents?: StepEvent[]; toolCallEvents?: ToolCallEvent[]}> = [];
  private flushTimer?: NodeJS.Timeout;
  private flushInFlight = false;
  private configCache?: { config: any; fetchedAt: number };
  private configTTL = 60000;
  private defaultConfig: any;

  constructor(config: SDKConfig) {
    this.config = {
      apiUrl: config.apiUrl,
      apiKey: config.apiKey || '',
      inlineMode: config.inlineMode || false,
      batchSize: config.batchSize || 10,
      flushInterval: config.flushInterval || 5000,
      configTTLms: config.configTTLms || 60000,
      maxQueueSize: config.maxQueueSize || 1000,
    };

    this.configTTL = this.config.configTTLms;

    this.defaultConfig = {
      prompt: 'You are a helpful assistant.',
      policies: {},
      evaluators: []
    };

    if (this.config.flushInterval > 0) {
      this.startFlushTimer();
    }
  }

  async getLatestConfig(options?: { userId?: string; forceRefresh?: boolean }): Promise<any> {
    if (!options?.forceRefresh && this.configCache && Date.now() - this.configCache.fetchedAt < this.configTTL) {
      return this.configCache.config;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const userId = options?.userId || this.getUserId();
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.config.apiKey}`
      };
      if (userId) {
        headers['X-User-Id'] = userId;
      }

      const response = await fetch(`${this.config.apiUrl}/version/current`, {
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const data = await response.json() as { config: any };

      this.configCache = { config: data.config, fetchedAt: Date.now() };
      return data.config;

    } catch (error) {
      console.error('Failed to fetch config from API:', error);

      if (this.configCache) {
        console.warn('Using stale cached config due to API failure');
        return this.configCache.config;
      }

      console.warn('Using SDK-bundled default config');
      return this.defaultConfig;
    }
  }

  private getUserId(): string {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      try {
        return globalThis.localStorage.getItem('ark_user_id') || '';
      } catch {
        return '';
      }
    }
    return '';
  }

  createRun(sessionId?: string, metadata?: Record<string, any>): RunContext {
    const runId = uuidv4();
    const runEvent: RunEvent = {
      runId,
      sessionId: sessionId || uuidv4(),
      metadata,
      timestamp: new Date().toISOString(),
    };

    this.queueEvent({ runEvent });

    return {
      runId,
      sessionId: runEvent.sessionId!,
      metadata,
    };
  }

  async captureStep(runId: string, stepContext: Omit<StepContext, 'stepId'>): Promise<string> {
    const stepId = uuidv4();
    const metadata: Record<string, any> = {
      ...(stepContext.metadata || {}),
    };
    if (stepContext.stage && !metadata.stage) metadata.stage = stepContext.stage;
    if (stepContext.agentNode && !metadata.agentNode) metadata.agentNode = stepContext.agentNode;
    if (typeof stepContext.stageScore === 'number' && Number.isFinite(stepContext.stageScore)) {
      metadata.stageScore = stepContext.stageScore;
    }
    if (typeof stepContext.stagePassed === 'boolean') {
      metadata.stagePassed = stepContext.stagePassed;
    }
    const stepEvent: StepEvent = {
      stepId,
      runId,
      stepType: stepContext.stepType,
      input: stepContext.input,
      output: stepContext.output,
      timing: stepContext.timing,
      metadata,
      timestamp: new Date().toISOString(),
    };

    this.queueEvent({ stepEvents: [stepEvent] });

    if (this.config.inlineMode && stepContext.output) {
      const decision = await this.evaluateInline(runId, stepContext.input, stepContext.output);
      if (decision.action === 'block') {
        throw new Error(`Step blocked: ${decision.reason}`);
      }
    }

    return stepId;
  }

  async captureToolCall(stepId: string, toolCallContext: Omit<ToolCallContext, 'toolCallId'>): Promise<string> {
    const toolCallId = uuidv4();
    const toolCallEvent: ToolCallEvent = {
      toolCallId,
      stepId,
      toolName: toolCallContext.toolName,
      args: toolCallContext.args,
      result: toolCallContext.result,
      metadata: toolCallContext.metadata,
      timestamp: new Date().toISOString(),
    };

    this.queueEvent({ toolCallEvents: [toolCallEvent] });

    return toolCallId;
  }

  private queueEvent(event: {runEvent?: RunEvent; stepEvents?: StepEvent[]; toolCallEvents?: ToolCallEvent[]}) {
    this.eventQueue.push(event);

    if (this.eventQueue.length > this.config.maxQueueSize) {
      const overflow = this.eventQueue.length - this.config.maxQueueSize;
      this.eventQueue.splice(0, overflow);
      console.warn(`Ark SDK queue overflow. Dropped ${overflow} oldest events.`);
    }

    if (this.eventQueue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushInFlight || this.eventQueue.length === 0) return;
    this.flushInFlight = true;

    const batch = this.eventQueue.splice(0, this.eventQueue.length);
    const runEvent = batch.find(e => e.runEvent)?.runEvent;
    const runMeta =
      runEvent?.metadata && typeof runEvent.metadata === 'object'
        ? (runEvent.metadata as Record<string, unknown>)
        : {};

    const payload = {
      runEvent,
      stepEvents: batch.flatMap(e => e.stepEvents || []),
      toolCallEvents: batch.flatMap(e => e.toolCallEvents || []),
      ...(typeof runMeta.agentId === 'string' ? { agentId: runMeta.agentId } : {}),
      ...(typeof runMeta.experimentId === 'string' ? { experimentId: runMeta.experimentId } : {}),
      ...(typeof runMeta.candidateId === 'string' ? { candidateId: runMeta.candidateId } : {}),
      inlineMode: this.config.inlineMode,
    };

    try {
      const response = await fetch(`${this.config.apiUrl}/capture-production-trace`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error('Failed to send events to backend:', await response.text());
      }
    } catch (error) {
      console.error('Error sending events:', error);
      console.warn(`Ark SDK dropped ${batch.length} queued event envelopes after transport failure.`);
    } finally {
      this.flushInFlight = false;
    }
  }

  private async evaluateInline(runId: string, input: any, output: any): Promise<{action: string; reason: string}> {
    try {
      const response = await fetch(`${this.config.apiUrl}/evaluate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'Authorization': `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ runId, input, output }),
      });

      const result: any = await response.json();
      return result.policyDecision || { action: 'allow', reason: 'No policy decision' };
    } catch (error) {
      console.error('Inline evaluation error:', error);
      return { action: 'allow', reason: 'Evaluation failed' };
    }
  }

  private startFlushTimer() {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushInterval);
  }

  async recordFeedback(runId: string, feedbackType: 'thumbs_up' | 'thumbs_down'): Promise<void> {
    try {
      await fetch(`${this.config.apiUrl}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({ runId, feedbackType })
      });
    } catch (error) {
      console.error('Failed to record feedback:', error);
    }
  }

  async recordTaskCompletion(runId: string, completed: boolean): Promise<void> {
    try {
      await fetch(`${this.config.apiUrl}/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({ runId, taskCompleted: completed })
      });
    } catch (error) {
      console.error('Failed to record task completion:', error);
    }
  }

  async approveDeployment(deploymentId: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.apiUrl}/deploy/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        'X-Ark-Role': 'admin',
        'Idempotency-Key': `sdk-approve-${deploymentId}-${Date.now()}`,
      },
      body: JSON.stringify({ deploymentId }),
    });
    if (!response.ok) {
      throw new Error(`approveDeployment failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async rejectDeployment(deploymentId: string, reason?: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.config.apiUrl}/deploy/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        'X-Ark-Role': 'admin',
        'Idempotency-Key': `sdk-reject-${deploymentId}-${Date.now()}`,
      },
      body: JSON.stringify({ deploymentId, reason }),
    });
    if (!response.ok) {
      throw new Error(`rejectDeployment failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async startRollout(
    versionId: string,
    options?: {
      schedule?: CanaryStep[];
      autoRollback?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${this.config.apiUrl}/version/${encodeURIComponent(versionId)}/rollout`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          'X-Ark-Role': 'admin',
          'Idempotency-Key': `sdk-rollout-start-${versionId}-${Date.now()}`,
        },
        body: JSON.stringify({
          schedule: options?.schedule,
          autoRollback: options?.autoRollback,
        }),
      }
    );
    if (!response.ok) {
      throw new Error(`startRollout failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async getRolloutStatus(versionId: string): Promise<RolloutStatus> {
    const response = await fetch(
      `${this.config.apiUrl}/version/${encodeURIComponent(versionId)}/rollout`,
      {
        headers: {
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
      }
    );
    if (!response.ok) {
      throw new Error(`getRolloutStatus failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<RolloutStatus>;
  }

  async advanceRollout(versionId: string): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${this.config.apiUrl}/version/${encodeURIComponent(versionId)}/rollout/advance`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          'X-Ark-Role': 'admin',
          'Idempotency-Key': `sdk-rollout-advance-${versionId}-${Date.now()}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`advanceRollout failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async rollbackRollout(versionId: string): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${this.config.apiUrl}/version/${encodeURIComponent(versionId)}/rollback`,
      {
        method: 'POST',
        headers: {
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
          'X-Ark-Role': 'admin',
          'Idempotency-Key': `sdk-rollout-rollback-${versionId}-${Date.now()}`,
        },
      }
    );
    if (!response.ok) {
      throw new Error(`rollbackRollout failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async startOptimizationCampaign(
    payload: OptimizationCampaignRequest
  ): Promise<{ campaignId: string; status: string }> {
    const response = await fetch(`${this.config.apiUrl}/optimize/campaigns`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        'Idempotency-Key': `sdk-opt-campaign-${Date.now()}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`startOptimizationCampaign failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<{ campaignId: string; status: string }>;
  }

  async getOptimizationCampaignStatus(
    campaignId: string
  ): Promise<OptimizationCampaignStatus> {
    const response = await fetch(
      `${this.config.apiUrl}/optimize/campaigns/${encodeURIComponent(campaignId)}`,
      {
        headers: {
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
      }
    );
    if (!response.ok) {
      throw new Error(`getOptimizationCampaignStatus failed: ${response.status} ${await response.text()}`);
    }
    return response.json() as Promise<OptimizationCampaignStatus>;
  }

  async destroy() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
    }
    await this.flush();
  }
}
