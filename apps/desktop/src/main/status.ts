import type { Session } from 'electron';
import type { SessionStatus } from '@ugc/core';

export interface ProbeResult {
  readonly status: SessionStatus;
  readonly reason: string | null;
}

/**
 * Asks the synthetic site whether this partition's cookies are accepted.
 * A positive answer only means the session *appears* authenticated.
 * Real platforms need their own probes (Gate 2+).
 */
export async function probeSyntheticSession(ses: Session, origin: string, everImported: boolean): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await ses.fetch(`${origin}/whoami`, { credentials: 'include' });
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
