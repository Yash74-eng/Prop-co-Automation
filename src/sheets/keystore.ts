/**
 * Passphrase-encrypted credentials, so a service-account key can live in the repo.
 *
 * The key itself is a live credential to a spreadsheet of owner names and mailing
 * addresses. Committing it in the clear puts it in git history permanently, where it stays
 * after any later deletion and travels into every clone. Encrypted, the committed file is
 * inert: it is useless without a passphrase that is never in the repo, never in a command
 * line, and never in a chat transcript.
 *
 * AES-256-GCM under a scrypt-derived key, both from node:crypto — no dependency, and GCM's
 * authentication tag means a wrong passphrase fails loudly instead of yielding plausible
 * garbage that would surface later as an unreadable key.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** Self-describing envelope, so a file encrypted today stays readable if defaults change. */
export interface EncryptedEnvelope {
  v: 1;
  kdf: 'scrypt';
  /** scrypt cost. N is the expensive one; 2^15 is ~100ms here, slow enough to matter. */
  N: number;
  r: number;
  p: number;
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

const SCRYPT = { N: 32_768, r: 8, p: 1 } as const;
// scryptSync refuses to allocate for N=32768 at the default 32 MB limit.
const MAX_MEMORY = 64 * 1024 * 1024;

export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptError';
  }
}

function derive(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }) {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY,
  });
}

/** Encrypt a credential. The output is safe to commit; the passphrase is not. */
export function encryptCredential(plaintext: string, passphrase: string): EncryptedEnvelope {
  if (passphrase.length < 12) {
    throw new CredentialDecryptError(
      'Use a passphrase of at least 12 characters. This one has to stand up to anyone who ' +
        'can read the repository, which for a public repo is everyone.',
    );
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, SCRYPT), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return {
    v: 1,
    kdf: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

/** Decrypt a credential, or say clearly why it could not be decrypted. */
export function decryptCredential(envelope: unknown, passphrase: string): string {
  const e = envelope as Partial<EncryptedEnvelope>;
  if (!e || e.v !== 1 || e.kdf !== 'scrypt' || e.cipher !== 'aes-256-gcm') {
    throw new CredentialDecryptError(
      'This is not a credential file this version can read. Re-encrypt it with ' +
        '"npm run key:encrypt".',
    );
  }
  for (const field of ['salt', 'iv', 'tag', 'ct'] as const) {
    if (typeof e[field] !== 'string') {
      throw new CredentialDecryptError(`The encrypted credential is missing "${field}".`);
    }
  }
  if (!passphrase) {
    throw new CredentialDecryptError(
      'An encrypted credential is present but no passphrase is set. Add ' +
        'GOOGLE_SERVICE_ACCOUNT_PASSPHRASE to .env.',
    );
  }

  const key = derive(passphrase, Buffer.from(e.salt!, 'base64'), {
    N: e.N ?? SCRYPT.N,
    r: e.r ?? SCRYPT.r,
    p: e.p ?? SCRYPT.p,
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv!, 'base64'));
  decipher.setAuthTag(Buffer.from(e.tag!, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(e.ct!, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM verification failed. Overwhelmingly the passphrase; otherwise the file is damaged.
    throw new CredentialDecryptError(
      'The passphrase does not match this encrypted credential (or the file has been ' +
        'altered). Nothing was decrypted.',
    );
  }
}
