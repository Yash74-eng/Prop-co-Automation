/**
 * Encrypt a service-account key so it can be committed.
 *
 *   npm run key:encrypt -- "C:\Users\You\.propco\propco-sheets-key.json"
 *
 * The passphrase is typed at a masked prompt, never passed as an argument: an argument
 * lands in shell history, in the process list while it runs, and in any terminal capture.
 * Nothing sensitive is written to disk except the encrypted file itself.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

const { encryptCredential, decryptCredential } = await import('../src/sheets/keystore.js');
const { ENCRYPTED_KEY_PATH } = await import('../src/sheets/google.js');

const source = process.argv[2];
const target = process.argv[3] ?? ENCRYPTED_KEY_PATH;

if (!source) {
  console.error('Usage: npm run key:encrypt -- <path-to-key.json> [output.enc]');
  process.exitCode = 1;
} else if (!existsSync(source)) {
  console.error(`No such file: ${source}`);
  process.exitCode = 1;
} else {
  const plaintext = readFileSync(source, 'utf8');

  // Fail before asking for a passphrase if the input is not actually a key.
  let account;
  try {
    account = JSON.parse(plaintext);
  } catch {
    console.error(`${source} is not valid JSON.`);
    process.exit(1);
  }
  if (!account.client_email || !account.private_key) {
    console.error(`${source} has no client_email / private_key — is it a service-account key?`);
    process.exit(1);
  }

  console.log(`Encrypting the key for ${account.client_email}`);
  console.log('Choose a passphrase of at least 12 characters. Send it to whoever needs it');
  console.log('through a password manager or a direct message — never in the repo.\n');

  const passphrase = await prompt('Passphrase: ');
  const again = await prompt('Confirm    : ');
  if (passphrase !== again) {
    console.error('\nThose do not match. Nothing was written.');
    process.exit(1);
  }

  const envelope = encryptCredential(plaintext, passphrase);

  // Prove it round-trips before writing, so a bad file can never be the thing you commit.
  const check = decryptCredential(envelope, passphrase);
  if (check !== plaintext) {
    console.error('\nThe encrypted key did not decrypt back to the original. Nothing written.');
    process.exit(1);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  console.log(`\nWrote ${target}`);
  console.log('Verified: it decrypts back to the original key.\n');
  console.log('Next:');
  console.log(`  1. Add to .env:  GOOGLE_SERVICE_ACCOUNT_PASSPHRASE=<the passphrase>`);
  console.log(`  2. Remove GOOGLE_SERVICE_ACCOUNT_JSON from .env, or it takes priority`);
  console.log(`  3. Commit ${target} — the passphrase stays out of the repo`);
  console.log(`  4. Restart, then check /api/health shows the service-account address`);
}

/** Read a line without echoing it. */
function prompt(label) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline writes each keystroke back; replace that with nothing so the passphrase
    // never appears on screen or in a scrollback capture.
    const output = rl.output;
    let muted = false;
    rl._writeToOutput = (text) => {
      if (!muted || text.includes(label)) output.write(text);
    };
    rl.question(label, (answer) => {
      muted = false;
      output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}
