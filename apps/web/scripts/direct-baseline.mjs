// QUALITY V1 — CALL 1: a direct-model baseline with a plain user request and
// no Sidequest system prompt, for the founder comparison. Reads the key from
// apps/web/.env.local; writes markdown + the raw response JSON to the path
// given. One call, no retry. Usage:
//   node apps/web/scripts/direct-baseline.mjs <prompt-file> <out-dir> [model]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const [promptFile, outDir, modelArg] = process.argv.slice(2);
if (!promptFile || !outDir) {
  console.error('usage: direct-baseline.mjs <prompt-file> <out-dir> [model]');
  process.exit(2);
}
for (const line of readFileSync(resolve('apps/web/.env.local'), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const model = modelArg ?? process.env.SIDEQUEST_COMPOSER_MODEL ?? 'claude-sonnet-5';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 240_000 });
const prompt = readFileSync(promptFile, 'utf8');
const started = Date.now();
const response = await client.messages.create({ model, max_tokens: Number(process.env.BASELINE_MAX_TOKENS ?? 24000), messages: [{ role: 'user', content: prompt }] });
const ms = Date.now() - started;
mkdirSync(outDir, { recursive: true });
const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
writeFileSync(resolve(outDir, 'direct-baseline.md'), `# Direct baseline — ${model}\n\nLatency: ${ms} ms · input ${response.usage.input_tokens} · output ${response.usage.output_tokens}\n\n## Prompt\n\n${prompt}\n\n## Response\n\n${text}\n`);
writeFileSync(resolve(outDir, 'direct-baseline.raw.json'), JSON.stringify({ model, ms, usage: response.usage, stop_reason: response.stop_reason }, null, 2));
console.log(`baseline ${model} in ${ms} ms; output ${response.usage.output_tokens} tokens → ${outDir}`);
