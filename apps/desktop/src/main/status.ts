import type { Session } from 'electron';
import type { PlatformDefinition, SessionStatus } from '@ugc/core';
import { platformOrigin } from './platforms.js';

export interface ProbeResult {
  readonly status: SessionStatus;
  readonly reason: string | null;
}

/** True only for platforms whose definition allows the app to send a status request. */
export function probePermitted(platform: PlatformDefinition): boolean {
  return platform.statusCheck.kind === 'probe' && platform.authorization.automation === 'permitted';
}

/**
 * Asks the platform's probe endpoint whether this partition's cookies are
 * accepted. A positive answer only means the session *appears*
 * authenticated. Never called for platforms without automation permission
 * (their status comes from the owner; see 'poc:confirm-status').
 * The probe contract is the synthetic site's: JSON {authenticated, reason}.
 */
export async function probeSession(ses: Session, platform: PlatformDefinition, everImported: boolean): Promise<ProbeResult> {
  if (!probePermitted(platform) || platform.statusCheck.kind !== 'probe') throw new Error('automated status check not permitted');
  let response: Response;
  try {
    response = await ses.fetch(`${platformOrigin(platform)}${platform.statusCheck.path}`, { credentials: 'include' });
  } catch {
    return { status: 'network_error', reason: 'site_unreachable' };
  }
  let body: { authenticated?: unknown; reason?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { status: 'network_error', reason: 'unexpected_response' };
  }
  if (response.status === 200 && body.authenticated === true) return { status: 'appears_authenticated', reason: null };
  if (body.reason === 'unknown_session') return { status: 'rejected', reason: 'site_rejected_session' };
  if (body.reason === 'no_session') {
    return everImported ? { status: 'expired', reason: 'no_session_cookie' } : { status: 'never_configured', reason: null };
  }
  return { status: 'network_error', reason: 'unexpected_response' };
}
