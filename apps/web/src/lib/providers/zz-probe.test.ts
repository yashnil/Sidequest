import { describe, it, expect } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';
import { deriveScope, buildInventory } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, syntheticCandidate, syntheticPack } from '@sidequest/compiler/testing';

const OUT = '/tmp/probe2.txt';
function log(...p: unknown[]) { appendFileSync(OUT, p.map(String).join(' ') + '\n'); }
function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}
describe('probe2', () => {
  it('food records', () => {
    writeFileSync(OUT, '');
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const candidate = syntheticCandidate(spec);
    const scope = { ...deriveScope({ candidate, clarifications: emptyClarifications(), nights: 5, revision: 1 }), confirmedByUser: true };
    const pack = syntheticPack(spec, scope);
    for (const layer of pack.layers) {
      for (const r of layer.records) {
        if (r.planningRole === 'food' || /food|restaurant|cafe|bakery/i.test(r.sourceCategory)) {
          log(layer.id ?? '?', r.id, r.planningRole, r.sourceCategory, JSON.stringify(r.coordinates));
        }
      }
    }
    const inv = buildInventory({ pack, scope });
    log('--- inventory food records:', inv.foodRecords.length);
    for (const r of inv.foodRecords) log('   ', r.id, r.planningRole, r.sourceCategory, JSON.stringify(r.coordinates));
    expect(true).toBe(true);
  });
});
