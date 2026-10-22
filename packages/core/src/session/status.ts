/** Session statuses from MASTER_SPEC §12. "appears" is deliberate: nothing proves a login. */
export const SESSION_STATUSES = [
  'never_configured',
  'imported_unverified',
  'appears_authenticated',
  // The owner looked at the site in the profile's window and confirmed they are logged in.
  // Distinct from imported_unverified and from an automated appears_authenticated.
  'confirmed_by_user',
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
