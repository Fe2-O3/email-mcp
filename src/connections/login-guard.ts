/**
 * The last check before any login leaves this process: an account whose
 * password could not be read at start-up never connects.
 */

import type { AccountConfig } from '../types/index.js';

export default function assertCanLogIn(
  account: Partial<Pick<AccountConfig, 'name' | 'credentialError'>>,
): void {
  if (account.credentialError) {
    throw new Error(`Account "${account.name ?? '?'}" cannot log in: ${account.credentialError}`);
  }
}
