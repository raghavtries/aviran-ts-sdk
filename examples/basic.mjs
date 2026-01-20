import { createArkClient } from '../dist/index.js';

const client = createArkClient({
  apiUrl: process.env.ARK_API_URL || 'https://api.example.com',
  apiKey: process.env.ARK_API_KEY,
});

const run = client.createRun();
await client.captureStep(run.runId, {
  stepType: 'llm',
  input: 'Hello',
  output: 'Hi',
});
await client.flush();
