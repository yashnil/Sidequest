import 'server-only';
import { RESOLVER_VERSION } from '@sidequest/core';
import {
  withSharedEvidence,
  type EvidenceStorePort,
  type SharedClaimStore,
  type SharedEvidenceLayer,
} from '@sidequest/compiler';
import type { CompilerProviders } from '@sidequest/compiler';
import { PINNED_REQUEST_HEADERS } from '../net/safe-fetch';
import {
  awaitOperation,
  claimOperation,
  findAttempts,
  findClaimsFor,
  findFactSets,
  saveAttempts,
  markClaimsSuperseded,
  saveClaims,
  saveFactSets,
  completeOperation,
  findDiscovery,
  findExtraction,
  findLatestDocument,
  findSourceByCanonicalUrl,
  heartbeatOperation,
  recordRetrieval,
  recordRevalidation,
  saveDiscovery,
  saveDocument,
  saveExtraction,
  upsertSource,
} from '../db/evidence-repository';

/**
 * The shared evidence store, bound to this app's database.
 *
 * The binding is deliberately thin. Everything with a decision in it — what may
 * be reused, for how long, and what a `304` is allowed to mean — lives in
 * `@sidequest/compiler`, where it is testable against an in-memory store with no
 * network and no database. This file is the wire.
 *
 * It is applied to **both** provider sets, live and fixture, and that is on
 * purpose: the browser journeys that assert a warm compilation is cheap have to
 * exercise the same code path a live one does, or they assert nothing.
 */

const port: EvidenceStorePort = {
  findDiscovery,
  saveDiscovery,
  findSourceByCanonicalUrl,
  upsertSource,
  findLatestDocument,
  saveDocument,
  recordRevalidation,
  recordRetrieval,
  findExtraction,
  saveExtraction,
  claimOperation,
  heartbeatOperation,
  completeOperation,
  awaitOperation,
};

/**
 * Whether evidence sharing is on.
 *
 * On by default, and switchable off — not as a feature flag for a half-built
 * thing, but because "does the cache explain this result?" has to be answerable
 * by turning it off and running again. A caching layer nobody can bypass is a
 * caching layer nobody can debug.
 */
export function sharedEvidenceEnabled(): boolean {
  return process.env.SIDEQUEST_SHARED_EVIDENCE?.trim().toLowerCase() !== 'off';
}

/**
 * Durable claims, bound to this app's database.
 *
 * Thin on purpose, like the port above it: every decision about what may be
 * reused, for how long, and what may be shared across trips lives in
 * `@sidequest/compiler`, where it is testable with no network and no database.
 */
const claimStore: SharedClaimStore = {
  resolverVersion: RESOLVER_VERSION,
  load: (subjectKeys) => findClaimsFor(subjectKeys),
  save: ({ records, supersededIds, now }) => {
    /**
     * Superseded first, then written.
     *
     * The other order would leave a moment where the replacement and the thing
     * it replaced are both live, and a reader arriving in that moment would see
     * one source apparently disagreeing with itself.
     */
    markClaimsSuperseded(supersededIds, now);
    saveClaims(records);
  },
  loadAttempts: (subjectKeys) => findAttempts(subjectKeys),
  saveAttempts: ({ attempts }) => saveAttempts(attempts),
  loadFactSets: (keys) => findFactSets(keys),
  saveFactSets: ({ entries, now }) => saveFactSets(entries, now),
};

export interface EvidenceBackedProviders {
  providers: CompilerProviders;
  /** Null when sharing is switched off, so a caller can say so rather than guess. */
  evidence: SharedEvidenceLayer | null;
}

export function withEvidenceStore(providers: CompilerProviders): EvidenceBackedProviders {
  if (!sharedEvidenceEnabled()) return { providers, evidence: null };

  const layer = withSharedEvidence(
    {
      sourceDiscovery: providers.sourceDiscovery,
      retrieval: providers.retrieval,
      extraction: providers.extraction,
    },
    {
      store: port,
      now: () => new Date(),
      pinnedHeaders: PINNED_REQUEST_HEADERS,
      ...(process.env.ANTHROPIC_MODEL?.trim() ? { modelId: process.env.ANTHROPIC_MODEL.trim() } : {}),
    },
  );

  return {
    providers: {
      ...providers,
      claims: claimStore,
      sourceDiscovery: layer.sourceDiscovery,
      retrieval: layer.retrieval,
      extraction: layer.extraction,
    },
    evidence: layer,
  };
}
