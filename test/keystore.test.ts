/**
 * Passphrase-encrypted credentials.
 *
 * The property that matters is not "it round-trips" but "a wrong passphrase fails loudly".
 * A cipher without authentication would hand back plausible garbage, and the failure would
 * surface much later as an unreadable key with no clue why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CredentialDecryptError,
  decryptCredential,
  encryptCredential,
} from '../src/sheets/keystore.js';

const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'propco@figment-propco.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
});
const PASS = 'correct horse battery staple';

test('a credential round-trips through encryption unchanged', () => {
  const out = decryptCredential(encryptCredential(KEY, PASS), PASS);
  assert.equal(out, KEY);
  assert.equal(JSON.parse(out).client_email, 'propco@figment-propco.iam.gserviceaccount.com');
});

test('the wrong passphrase fails loudly rather than returning garbage', () => {
  const envelope = encryptCredential(KEY, PASS);
  assert.throws(() => decryptCredential(envelope, 'not the passphrase'), CredentialDecryptError);
  // Including the near-miss cases someone would actually type.
  for (const wrong of [PASS.toUpperCase(), `${PASS} `, PASS.slice(0, -1), '']) {
    assert.throws(() => decryptCredential(envelope, wrong), CredentialDecryptError);
  }
});

test('the committed file leaks nothing about what it holds', () => {
  const envelope = encryptCredential(KEY, PASS);
  const onDisk = JSON.stringify(envelope);
  for (const secret of ['propco@', 'BEGIN PRIVATE KEY', 'service_account', 'figment']) {
    assert.ok(!onDisk.includes(secret), `"${secret}" is visible in the encrypted file`);
  }
  assert.ok(!onDisk.includes(PASS), 'the passphrase must never be stored');
});

test('the same key encrypted twice produces different files', () => {
  // A fresh salt and IV each time. Identical output would tell an observer that two
  // repositories hold the same credential, and would break GCM outright on IV reuse.
  const a = encryptCredential(KEY, PASS);
  const b = encryptCredential(KEY, PASS);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  // Both still open with the same passphrase.
  assert.equal(decryptCredential(a, PASS), KEY);
  assert.equal(decryptCredential(b, PASS), KEY);
});

test('tampering with the ciphertext is detected', () => {
  const envelope = encryptCredential(KEY, PASS);
  const bytes = Buffer.from(envelope.ct, 'base64');
  bytes[0] ^= 0xff;
  assert.throws(
    () => decryptCredential({ ...envelope, ct: bytes.toString('base64') }, PASS),
    CredentialDecryptError,
  );
});

test('a too-short passphrase is refused at encryption time', () => {
  // Refusing here is the only useful moment: once committed, the file is public and the
  // passphrase is the whole defence.
  assert.throws(() => encryptCredential(KEY, 'short'), /at least 12/);
  assert.throws(() => encryptCredential(KEY, '12345678901'), /at least 12/);
  assert.ok(encryptCredential(KEY, '123456789012'));
});

test('a file this version cannot read says so instead of throwing something opaque', () => {
  for (const bad of [
    null,
    {},
    { v: 2, kdf: 'scrypt', cipher: 'aes-256-gcm' },
    { v: 1, kdf: 'pbkdf2', cipher: 'aes-256-gcm' },
    { v: 1, kdf: 'scrypt', cipher: 'aes-128-cbc' },
  ]) {
    assert.throws(() => decryptCredential(bad, PASS), /not a credential file this version/);
  }
});

test('an envelope missing a field names the field', () => {
  const envelope = encryptCredential(KEY, PASS);
  for (const field of ['salt', 'iv', 'tag', 'ct'] as const) {
    const broken = { ...envelope, [field]: undefined };
    assert.throws(() => decryptCredential(broken, PASS), new RegExp(`missing "${field}"`));
  }
});

test('an encrypted key with no passphrase set points at the fix', () => {
  assert.throws(
    () => decryptCredential(encryptCredential(KEY, PASS), ''),
    /GOOGLE_SERVICE_ACCOUNT_PASSPHRASE/,
  );
});
