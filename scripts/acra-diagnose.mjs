/**
 * Diagnostic: why does an owner name miss in the ACRA open-data set?
 * Tries each strategy in turn and reports which one lands, so the resolver's variant
 * list can be tuned against real misses rather than guesses.
 */
const BASE = 'https://data.gov.sg/api/action/datastore_search';
const ID = 'd_3f960c10fed6145404ca7b821f263b87';
const get = async (params) => (await fetch(`${BASE}?resource_id=${ID}&${params}`)).json();
const exact = (name) =>
  get(`filters=${encodeURIComponent(JSON.stringify({ entity_name: name }))}&limit=3`);

const NAMES = process.argv.slice(2);

for (const name of NAMES) {
  const variants = [
    name,
    name.replace(/\bPTE\s+LTD$/i, 'PTE. LTD.'),
    name.replace(/\bPTE\.\s+LTD\.$/i, 'PTE LTD'),
    name.replace(/\./g, ''),
    name.replace(/\bPRIVATE\b/i, 'PTE.'),
    name.replace(/\bLIMITED$/i, 'LTD.'),
    name.replace(/\(PTE\)/i, '(PTE.)'),
  ];

  let hit = null;
  let via = null;
  for (const v of [...new Set(variants)]) {
    const j = await exact(v);
    if ((j.result?.total ?? 0) > 0) {
      hit = j.result.records[0];
      via = `exact "${v}"`;
      break;
    }
  }

  if (!hit) {
    // Phrase search, then accept only an exact string equality among candidates.
    const j = await get(`q=${encodeURIComponent(name)}&limit=100`);
    const recs = j.result?.records ?? [];
    const same = recs.find((r) => r.entity_name === name);
    if (same) {
      hit = same;
      via = 'q + exact string among candidates';
    } else {
      // How close did we get? Show the nearest by shared prefix.
      const head = name.split(/\s+/).slice(0, 2).join(' ');
      const near = recs.filter((r) => (r.entity_name ?? '').startsWith(head)).slice(0, 3);
      via = near.length
        ? `q found ${recs.length}; near-misses: ${near.map((r) => r.entity_name).join(' / ')}`
        : `q found ${recs.length}, none starting "${head}"`;
    }
  }

  console.log(`${hit ? 'HIT ' : 'MISS'} [${name}]`);
  console.log(`      via: ${via}`);
  if (hit) {
    console.log(
      `      -> ${hit.entity_name} | ${hit.uen} | ${hit.uen_status_desc} | ${hit.reg_street_name} ${hit.reg_postal_code}`,
    );
  }
}
