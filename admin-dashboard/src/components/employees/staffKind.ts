/**
 * MIS staff sign in with a plain username (their name); mail employees sign in
 * with an email address. Mirrors backend/src/services/msiStaff.ts.
 */
export function isMsiStaffLogin(login: string): boolean {
  return !login.includes('@');
}
