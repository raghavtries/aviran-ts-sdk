export { ArkClient } from './client';
export { VercelAIWrapper } from './vercel-wrapper';
export { MastraWrapper } from './mastra-wrapper';
export type {
  SDKConfig,
  RunContext,
  StepContext,
  ToolCallContext,
  RolloutStatus,
  CanaryStep,
  OptimizationCampaignRequest,
  OptimizationCampaignStatus,
} from './types';
import { ArkClient } from './client';
import { VercelAIWrapper } from './vercel-wrapper';
import { MastraWrapper } from './mastra-wrapper';
import type { SDKConfig } from './types';

export function createArkClient(config: SDKConfig): ArkClient {
  return new ArkClient(config);
}

export function createVercelAIWrapper(client: ArkClient): VercelAIWrapper {
  return new VercelAIWrapper(client);
}

export function createMastraWrapper(client: ArkClient): MastraWrapper {
  return new MastraWrapper(client);
}
