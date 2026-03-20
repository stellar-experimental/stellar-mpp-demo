import { Keypair } from '@stellar/stellar-sdk';

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

/** Fund wallet via testnet Friendbot. Idempotent — safe to call on already-funded accounts. */
export async function fundWallet(publicKey: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!res.ok) {
    // Friendbot returns 400 if already funded — that's fine
    const body = await res.text();
    if (!body.includes('createAccountAlreadyExist')) {
      throw new Error(`Friendbot failed: ${res.status}`);
    }
  }
}
