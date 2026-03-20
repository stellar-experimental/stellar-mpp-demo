import { Keypair } from '@stellar/stellar-sdk';
import { getServer } from './stellar';

const STORAGE_KEY = 'stellar_secret_key';

/** Get or create a wallet keypair from sessionStorage. */
export function getOrCreateKeypair(): { keypair: Keypair; isNew: boolean } {
  if (typeof window === 'undefined') {
    return { keypair: Keypair.random(), isNew: true };
  }
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) {
    return { keypair: Keypair.fromSecret(stored), isNew: false };
  }
  const keypair = Keypair.random();
  sessionStorage.setItem(STORAGE_KEY, keypair.secret());
  return { keypair, isNew: true };
}

/** Clear the stored keypair (e.g. if funding fails and we want a fresh one). */
export function clearKeypair(): void {
  if (typeof window !== 'undefined') {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

/** Check if account exists on the network via Soroban RPC. */
async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await getServer().getAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

/** Ensure wallet is funded on testnet. Checks account via RPC first, only calls Friendbot if needed. */
export async function fundWallet(publicKey: string): Promise<void> {
  if (await accountExists(publicKey)) {
    return; // Account exists on-network — already funded
  }

  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) {
    const body = await res.text();
    if (
      body.includes('createAccountAlreadyExist') ||
      body.includes('already funded')
    ) {
      return; // Account exists — friendbot just can't re-fund it
    }
    throw new Error(`Friendbot failed: ${res.status}`);
  }
}
