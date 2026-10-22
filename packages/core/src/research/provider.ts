import type { AuthorizationConstraints } from '../platforms/definition.js';

/**
 * Boundary for the future research module (product discovery data). Gate 1/2
 * ship no provider implementation. A provider declares the authorization it
 * holds, and callers must pass through assertResearchUse() before using it,
 * so an unauthorized source (e.g. Kalodata without written permission, R-03)
 * can't be wired into automation or AI processing by accident, and an
 * authorized alternative can be swapped in behind the same interface.
 */
export interface ResearchProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly authorization: AuthorizationConstraints;
}

export interface ResearchQuery {
  readonly market: string;
  readonly keywords: readonly string[];
}

export interface ResearchProvider {
  readonly descriptor: ResearchProviderDescriptor;
  /** Automated retrieval. Only reachable when authorization.automation is 'permitted'. */
  search(query: ResearchQuery): Promise<readonly unknown[]>;
}

export type ResearchUse = 'automated_retrieval' | 'ai_processing';

export class ResearchUseNotAuthorized extends Error {
  constructor(
    readonly providerId: string,
    readonly use: ResearchUse,
  ) {
    super(`research provider ${providerId} is not authorized for ${use}`);
  }
}

/** Throws unless the provider's recorded authorization allows `use`. */
export function assertResearchUse(descriptor: ResearchProviderDescriptor, use: ResearchUse): void {
  const allowed = use === 'automated_retrieval' ? descriptor.authorization.automation : descriptor.authorization.aiDataUse;
  if (allowed !== 'permitted') throw new ResearchUseNotAuthorized(descriptor.id, use);
}
