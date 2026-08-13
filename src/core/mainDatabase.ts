/**
 * Read a PropCo Main Database sheet (or a trimmed export of it) into SourceRow objects.
 *
 * Two input shapes are supported:
 *   1. The full 45-column Main Database export.
 *   2. A cut-down sheet with only the major columns (Target, Address, Neighbourhood,
 *      Land Use, Owner Name, Owner Address, ...).
 *
 * Headers are matched on a normalised key, so trailing spaces, casing and punctuation
 * differences between exports do not break the import.
 */
import { SourceRow, OutreachClassification } from './types.js';
import { headerKey, isBlank, parseLooseDate, squash, toNumber, upper } from './text.js';

/** Canonical field -> the header spellings we accept for it. */
const FIELD_ALIASES: Record<string, string[]> = {
  addressId: ['Address ID', 'AddressID', 'ID'],
  address: ['Address', 'Property Address', 'Shophouse Address'],
  postalCode: ['Postal Code', 'Postal', 'Postcode'],
  target: ['Target'],
  propertyCondition: ['Property Condition'],
  otherPropertyAddresses: ['Other Property Addresses'],
  relationshipWithProperty: ['Relationship with Property'],
  contactPerson: ['Contact Person', 'Contact Name'],
  contactNoOrEmail: ['Contact No. / Email', 'Contact No.', 'Contact Number', 'Contact'],
  remarks: ['Remarks'],
  tenure: ['Tenure'],
  landAreaSqm: ['Land Area (SqM)', 'Land Area', 'Current Land Area'],
  ownerAge: ['Owner Age'],
  ownerProfile: ['Owner Profile'],
  lastTransactionDate: ['Last Transaction Date'],
  noOfFloors: ['No. of floors', 'No of floors', 'Current no. of Floors'],
  gfaSqft: ['GFA', 'Current GFA'],
  gpr: ['GPR', 'Gross Plot Ratio'],
  gfaMaximisationPotential: ['GFA Maximisation Potential'],
  landUse: ['Land Use', 'Landuse'],
  rearExtension: ['Rear extension', 'Rear Extension (Y / N)'],
  postcardOutreach: ['Postcard Outreach Date', 'Postcard Outreach'],
  lawyerLetterOutreach: ['Lawyer Letter Outreach', 'Lawyer Letter Outreach Date'],
  neighbourhood: ['Neighbourhood', 'Neighborhood'],
  benchmarkPsf: ['Benchmark'],
  scorePt1: ['Score pt 1'],
  scorePt2: ['Score pt 2'],
};

const OWNER_NAME_HEADERS = [
  'Owner Name',
  '2nd Owner Name',
  '3rd Owner Name',
  '4th Owner Name',
  '5th Owner Name',
];

const OWNER_ADDRESS_HEADERS = [
  'Owner Address',
  '2nd Owner Address',
  '3rd Owner Address',
  '4th Owner Address',
  '5th Owner Address',
];

export interface SheetTable {
  /** Header row, as written in the sheet. */
  headers: string[];
  /** Data rows, aligned to `headers`. */
  rows: unknown[][];
  /** Sheet name the table came from. */
  sheetName: string;
}

export interface ParsedDatabase {
  rows: SourceRow[];
  headers: string[];
  /** Canonical field -> resolved column index. */
  columnMap: Record<string, number>;
  /** Headers we could not map to a canonical field (kept in `raw`). */
  unmappedHeaders: string[];
  /** Canonical fields we expected but did not find. */
  missingFields: string[];
}

function buildIndex(headers: string[]): Map<string, number> {
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = headerKey(h);
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

function findColumn(index: Map<string, number>, aliases: string[]): number | undefined {
  for (const alias of aliases) {
    const hit = index.get(headerKey(alias));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Fields without which the pipeline cannot produce a mail-merge row. */
export const REQUIRED_FIELDS = ['address', 'target', 'neighbourhood', 'landUse'] as const;

export function parseMainDatabase(table: SheetTable): ParsedDatabase {
  const headers = table.headers.map((h) => squash(h));
  const index = buildIndex(headers);

  const columnMap: Record<string, number> = {};
  const missingFields: string[] = [];
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const col = findColumn(index, aliases);
    if (col !== undefined) columnMap[field] = col;
    else missingFields.push(field);
  }

  const ownerNameCols = OWNER_NAME_HEADERS.map((h) => index.get(headerKey(h)));
  const ownerAddressCols = OWNER_ADDRESS_HEADERS.map((h) => index.get(headerKey(h)));

  const mappedCols = new Set<number>([
    ...Object.values(columnMap),
    ...ownerNameCols.filter((c): c is number => c !== undefined),
    ...ownerAddressCols.filter((c): c is number => c !== undefined),
  ]);
  const unmappedHeaders = headers.filter((h, i) => h && !mappedCols.has(i));

  const rows: SourceRow[] = [];
  table.rows.forEach((cells, i) => {
    // Sheet row number: +2 because the header is row 1 and `i` is 0-based.
    const sourceRow = i + 2;
    const raw: Record<string, unknown> = {};
    headers.forEach((h, c) => {
      if (h) raw[h] = cells[c];
    });

    const get = (field: string): unknown =>
      columnMap[field] === undefined ? undefined : cells[columnMap[field]];

    const owners: SourceRow['owners'] = [];
    for (let slot = 0; slot < OWNER_NAME_HEADERS.length; slot++) {
      const nameCol = ownerNameCols[slot];
      const addrCol = ownerAddressCols[slot];
      const name = nameCol === undefined ? undefined : squash(cells[nameCol]);
      const address = addrCol === undefined ? undefined : squash(cells[addrCol]);
      if (!name && !address) continue;
      owners.push({ name: name || undefined, address: address || undefined, slot: slot + 1 });
    }

    const row: SourceRow = {
      sourceRow,
      addressId: squash(get('addressId')) || undefined,
      address: squash(get('address')) || undefined,
      postalCode: normalisePostal(get('postalCode')),
      target: squash(get('target')) || undefined,
      propertyCondition: squash(get('propertyCondition')) || undefined,
      otherPropertyAddresses: squash(get('otherPropertyAddresses')) || undefined,
      relationshipWithProperty: squash(get('relationshipWithProperty')) || undefined,
      owners,
      contactPerson: squash(get('contactPerson')) || undefined,
      contactNoOrEmail: squash(get('contactNoOrEmail')) || undefined,
      remarks: squash(get('remarks')) || undefined,
      tenure: squash(get('tenure')) || undefined,
      landAreaSqm: toNumber(get('landAreaSqm')),
      ownerAge: squash(get('ownerAge')) || undefined,
      ownerProfile: squash(get('ownerProfile')) || undefined,
      lastTransactionDate: squash(get('lastTransactionDate')) || undefined,
      noOfFloors: toNumber(get('noOfFloors')),
      gfaSqft: toNumber(get('gfaSqft')),
      gpr: squash(get('gpr')) || undefined,
      gfaMaximisationPotential: squash(get('gfaMaximisationPotential')) || undefined,
      landUse: squash(get('landUse')) || undefined,
      rearExtension: squash(get('rearExtension')) || undefined,
      postcardOutreach: get('postcardOutreach'),
      lawyerLetterOutreach: get('lawyerLetterOutreach'),
      neighbourhood: squash(get('neighbourhood')) || undefined,
      benchmarkPsf: toNumber(get('benchmarkPsf')),
      scorePt1: toNumber(get('scorePt1')),
      scorePt2: toNumber(get('scorePt2')),
      raw,
    };

    // Skip fully empty rows without burning a source row number.
    const hasAnything =
      row.address || row.addressId || row.owners.length > 0 || row.target || row.neighbourhood;
    if (!hasAnything) return;

    rows.push(row);
  });

  return { rows, headers, columnMap, unmappedHeaders, missingFields };
}

function normalisePostal(value: unknown): string | undefined {
  if (isBlank(value)) return undefined;
  const digits = squash(value).replace(/\D/g, '');
  if (!digits) return undefined;
  return digits.padStart(6, '0').slice(-6);
}

const DELIVERY_FAIL_RE =
  /delivery\s*fail|no\s*such\s*(person|company|address|blk|block|unit|floor|name)|address\s*is\s*incomplete|addressee?s?\s*has\s*(moved|gone)|has\s*moved|moved\s*away|no\s*longer\s*stay|gone\s*away|demoish|demolish|building\s*(is\s*)?not\s*ready|no\s*letterbox|owner\s*has\s*moved/i;
const OPT_OUT_RE = /opt\s*-?\s*out|not\s*interested|rejected/i;
const DO_NOT_SEND_RE = /do\s*not\s*send|did\s*not\s*send/i;
const BATCH_RE = /\bbatch\b/i;

/**
 * Interpret a value from "Lawyer Letter Outreach" / "Postcard Outreach Date".
 * The column mixes real dates, batch tags and delivery-failure notes, so the filter
 * needs a classification rather than a blank/non-blank test.
 */
export function classifyOutreach(value: unknown): OutreachClassification {
  if (isBlank(value)) return { status: 'blank', text: '' };
  const text = value instanceof Date ? value.toISOString() : squash(value);
  const date = parseLooseDate(value);

  // Order matters: "28 Jan 2026 - No such person" is a failure, not a clean send.
  if (OPT_OUT_RE.test(text)) return { status: 'opt-out', text, date };
  if (DO_NOT_SEND_RE.test(text)) return { status: 'do-not-send', text, date };
  if (DELIVERY_FAIL_RE.test(text)) return { status: 'delivery-failed', text, date };
  if (value instanceof Date || (date && /^\s*\d/.test(text) && !BATCH_RE.test(text))) {
    return { status: 'sent-date', text, date };
  }
  if (BATCH_RE.test(text)) return { status: 'batch-tag', text, date };
  return { status: 'other', text, date };
}

/** Which column drives the outreach filter for a channel. */
export function outreachValue(row: SourceRow, channel: 'lawyer-letter' | 'postcard'): unknown {
  return channel === 'lawyer-letter' ? row.lawyerLetterOutreach : row.postcardOutreach;
}

/** Land Use values that mean "no usable classification". */
export function isUsableLandUse(landUse: unknown): boolean {
  const text = upper(landUse);
  return !!text && text !== '#N/A' && text !== 'N/A';
}
