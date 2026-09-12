import 'server-only';
import { destinationConceptSchema, normalizeDestinationQuery, type DestinationConcept, type DestinationIntentGraph } from '@sidequest/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { destinationInterpreterChoice } from '@/lib/providers/switches';
import { readProviderCache, writeProviderCache } from '@/lib/db/compiler-repository';

/**
 * V8.1 — THE WORLD-MODEL TIER: A CLASSIFICATION AND NAMES, NEVER A COORDINATE.
 *
 * Deterministic sources come first and answer most phrases. This tier runs
 * only when they could not settle one: a mountain range whose only rows are
 * businesses named after it, a name shared by a village in Arizona and a
 * region across two countries, a landscape nobody publishes an edge for.
 *
 * What it may say: what kind of geographic thing the words name, at what
 * scale, in which countries, and the *names* of areas inside it a traveller
 * would use and of the cities they arrive through. What it may never say: a
 * latitude, a longitude, an extent. Every name it returns is looked up by
 * the geocoder and passed through the same semantic gate as anything else;
 * a name the geocoder cannot place, or places somewhere incompatible, is
 * dropped. The model classifies; evidence locates.
 *
 * Bounded like every other model call: one call, a strict schema with no
 * free prose beyond a capped note, cached for thirty days on the normalised
 * phrase and the prompt version, charged to the daily model-call ledger, and
 * skipped entirely — leaving the honest deterministic answer — when the
 * ledger, the credential or the switch says no.
 */

export const INTERPRETATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const INTERPRETATION_PROMPT_VERSION = 'interpret-destination-concept/2026-09-11.1';

export interface InterpretationOutcome {
  concept: DestinationConcept | null;
  /** Which tier answered, for diagnostics and the evidence trail. */
  source: 'cache' | 'anthropic' | 'fixture' | 'off' | 'declined' | 'failed';
  modelCalls: number;
}

export interface DestinationInterpreter {
  name: string;
  interpret(input: { text: string; graph: DestinationIntentGraph; evidence: string[] }): Promise<InterpretationOutcome>;
}

function cacheKey(text: string): string {
  return ['destination-concept', INTERPRETATION_PROMPT_VERSION, normalizeDestinationQuery(text)].join('|');
}

/** The recorded corpus, keyed by normalised phrase. Test data, not a product lookup table. */
let fixtureTable: Record<string, unknown> | null = null;
function fixtureConcepts(): Record<string, unknown> {
  if (fixtureTable) return fixtureTable;
  try {
    const raw = readFileSync(join(process.cwd(), 'src/lib/destinations/fixtures/interpretations.json'), 'utf8');
    fixtureTable = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      const raw = readFileSync(join(process.cwd(), 'apps/web/src/lib/destinations/fixtures/interpretations.json'), 'utf8');
      fixtureTable = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      fixtureTable = {};
    }
  }
  return fixtureTable;
}

export function fixtureInterpreter(table: Record<string, unknown> = fixtureConcepts()): DestinationInterpreter {
  return {
    name: 'fixture',
    async interpret({ text }) {
      const entry = table[normalizeDestinationQuery(text)];
      if (!entry) return { concept: null, source: 'fixture', modelCalls: 0 };
      const parsed = destinationConceptSchema.safeParse(entry);
      return { concept: parsed.success ? parsed.data : null, source: 'fixture', modelCalls: 0 };
    },
  };
}

/**
 * The instruction is about shapes, not places: it never names a destination,
 * and the only untrusted text it carries is the phrase itself, quoted as data.
 */
const INSTRUCTION =
  'You classify what kind of geographic thing a traveller has named, for a trip planner. ' +
  'You do not look anything up and you never produce coordinates, distances or extents — a geocoder does that from the names you give. ' +
  'Say what the words name (a mountain region, a coast, a desert, a travel region, a city…), how much ground it covers, which countries it genuinely spans, ' +
  'and name a few well-known areas INSIDE it a traveller would actually use (towns, national parks, valleys) plus the cities travellers arrive through. For a natural region, say which kind of landscape it is. ' +
  'Use the names a map would carry, in Latin script. If the words are not a place, say so. If the name is shared by materially different places, classify the reading a traveller most likely means and flag it.';

async function anthropicInterpreter(): Promise<DestinationInterpreter> {
  const { ResearchModel } = await import('@/lib/providers/anthropic');
  const { dailySpendGate, recordDailySpend } = await import('@/lib/compiler/daily-ceiling');
  return {
    name: 'anthropic',
    async interpret({ text, graph, evidence }) {
      const gate = dailySpendGate(new Date(), 'destination_interpretation');
      if (!gate.allowed) return { concept: null, source: 'declined', modelCalls: 0 };
      const model = new ResearchModel({ maxCalls: 1, model: process.env.SIDEQUEST_DESTINATION_INTERPRETER_MODEL?.trim() || 'claude-sonnet-5', maxRetries: 0 });
      try {
        const concept = await model.structured({
          promptVersion: INTERPRETATION_PROMPT_VERSION,
          instruction: INSTRUCTION,
          task: [
            `Classify this destination phrase: ${JSON.stringify(text)}.`,
            `The phrase's shape reads as: ${graph.children.map((c) => `${c.kind}${c.countryCode ? ` in ${c.countryCode}` : ''}`).join(' + ')}.`,
            evidence.length > 0 ? `What a geocoder returned for it, none of which could stand for the destination: ${evidence.slice(0, 5).join('; ')}.` : 'A geocoder returned nothing usable for it.',
          ].join(' '),
          schema: destinationConceptSchema,
          effort: 'low',
          maxTokens: 1024,
          timeoutMs: 20_000,
        });
        recordDailySpend('model_calls', 1, new Date(), 'destination_interpretation');
        return { concept, source: 'anthropic', modelCalls: 1 };
      } catch (error) {
        recordDailySpend('model_calls', 1, new Date(), 'destination_interpretation');
        console.warn('Destination interpretation failed', { name: error instanceof Error ? error.name : 'unknown' });
        return { concept: null, source: 'failed', modelCalls: 1 };
      }
    },
  };
}

/** The configured interpreter, or null when this build keeps to deterministic sources. */
export async function destinationInterpreter(): Promise<DestinationInterpreter | null> {
  const choice = destinationInterpreterChoice();
  if (choice === 'fixture') return fixtureInterpreter();
  if (choice === 'anthropic') return anthropicInterpreter();
  return null;
}

/**
 * Interpret once per phrase per prompt version. A cached reading costs nothing
 * and is what makes the plan door free after the setup door already asked.
 */
export async function interpretDestinationConcept(input: { text: string; graph: DestinationIntentGraph; evidence: string[]; interpreter?: DestinationInterpreter | null }): Promise<InterpretationOutcome> {
  const interpreter = input.interpreter === undefined ? await destinationInterpreter() : input.interpreter;
  if (!interpreter) return { concept: null, source: 'off', modelCalls: 0 };
  /* Only a paid reading is worth remembering; the fixture is free, deterministic, and must never leave rows in a database. */
  if (interpreter.name !== 'anthropic') return interpreter.interpret({ text: input.text, graph: input.graph, evidence: input.evidence });
  const key = cacheKey(input.text);
  try {
    const cached = readProviderCache<{ concept: DestinationConcept | null }>(key, new Date());
    if (cached) return { concept: cached.concept ? destinationConceptSchema.parse(cached.concept) : null, source: 'cache', modelCalls: 0 };
  } catch {
    /* A cache that cannot be read is a cache miss. */
  }
  const outcome = await interpreter.interpret({ text: input.text, graph: input.graph, evidence: input.evidence });
  if (outcome.source === 'anthropic') {
    try {
      writeProviderCache(key, `destination-interpreter:${interpreter.name}`, { concept: outcome.concept }, INTERPRETATION_TTL_MS, new Date());
    } catch {
      /* Not caching is not failing. */
    }
  }
  return outcome;
}
