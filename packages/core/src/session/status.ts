/** Session statuses from MASTER_SPEC §12. "appears" is deliberate: nothing proves a login. */
export const SESSION_STATUSES = [
  'never_configured',
  'imported_unverified',
  'appears_authenticated',
  'expired',
  'rejected',
  'network_error',
  'waiting_for_user',
  'locked_unavailable',
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as readonly string[]).includes(value);
}
