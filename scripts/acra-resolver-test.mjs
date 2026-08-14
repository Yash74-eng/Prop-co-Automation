/** Exercise lookupEntity directly, bypassing the HTTP route, on known names. */
import { lookupEntity, nameVariants } from '../src/bizfile/opendata.js';

const NAMES = [
  'CHIN HING PROPERTIES PTE LTD',
  'KENSON ENTERPRISE (PTE) LTD',
  'LUCKY DEVELOPMENT PRIVATE LIMITED',
  'ACRES VENTURES PTE LTD',
  'SANE ASIA PTE. LTD.',
  'CANDID ELECTRIC (S) PTE. LTD.',
  'TATE ANZUR PTE. LTD.',
  'KIM LENG OFFICE EQUIPMENT PTE LTD',
];

for (const n of NAMES) {
  console.log(`\n[${n}]`);
  console.log(`  variants tried: ${JSON.stringify(nameVariants(n))}`);
  try {
    const rec = await lookupEntity(n, 30_000);
    console.log(
      rec
        ? `  HIT  ${rec.name} | ${rec.uen} | ${rec.status} | ${rec.registeredAddress}`
        : '  MISS (no record)',
    );
  } catch (e) {
    console.log(`  THREW ${e.name}: ${e.message}`);
  }
}
