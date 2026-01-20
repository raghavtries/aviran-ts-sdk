export interface RunEvent {
  runId: string;
  sessionId?: string;
  metadata?: Record<string, any>;
  timestamp: string;
}

export interface StepEvent {
  stepId: string;
  runId: string;
  stepType: 'llm' | 'tool' | 'human' | 'system';
  input?: any;
  output?: any;
  timing?: { startTime: number; endTime?: number; duration?: number };
  metadata?: Record<string, any>;
  timestamp: string;
}

export interface ToolCallEvent {
  toolCallId: string;
  stepId: string;
  toolName: string;
  args?: Record<string, any>;
  result?: any;
  metadata?: Record<string, any>;
  timestamp: string;
}

export interface SDKConfig {
  apiUrl: string;
  apiKey?: string;
  inlineMode?: boolean;
  batchSize?: number;
  flushInterval?: number;
  configTTLms?: number;
  maxQueueSize?: number;
}

export interface RunContext {
  runId: string;
  sessionId: string;
  metadata?: Record<string, any>;
}

export interface StepContext {
  stepId: string;
  stepType: 'llm' | 'tool' | 'human' | 'system';
  input?: any;
  output?: any;
  stage?: string;
  stageScore?: number;
  stagePassed?: boolean;
  agentNode?: string;
  timing?: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
  metadata?: Record<string, any>;
}

export interface ToolCallContext {
  toolCallId: string;
  toolName: string;
  args?: Record<string, any>;
  result?: any;
  metadata?: Record<string, any>;
}

export interface CanaryStep {
  percentage: number;
  durationMinutes?: number;
}

export interface RolloutStatus {
  versionId: string;
  rolloutPercentage: number;
  rolloutStartedAt?: string | null;
  rolloutCompletedAt?: string | null;
  rolloutSchedule?: CanaryStep[] | null;
  autoRollbackEnabled?: boolean;
}

export interface OptimizationCampaignRequest {
  baselineVersionId: string;
  agentId?: string;
  testSuiteId?: string;
  objective?: Record<string, unknown>;
  parameterOverrides?: Record<string, string[]>;
  searchBudget?: Record<string, unknown>;
  campaign?: Record<string, unknown>;
  llmProvider?: string;
  benchmarkAdapterKey?: string;
}

export interface OptimizationCampaignStatus {
  campaignId: string;
  status: string;
  studiesStarted?: number;
  seedsPassed?: number;
  remainingSeedPasses?: number;
  currentTier?: string;
  ceilingRemaining?: number;
}
