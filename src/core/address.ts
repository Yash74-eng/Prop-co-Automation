/**
 * Singapore address parsing and the merge rules from the PropCo dedupe spec.
 *
 * Source addresses look like:
 *   "91 CIRCULAR ROAD BOAT QUAY CONSERVATION AREA SINGAPORE 049442"
 *   "72, 74 DESKER ROAD DESKER ROAD CONSERVATION AREA SINGAPORE 209604"
 *   "612 SERANGOON ROAD SINGAPORE 218217"
 *
 * The conservation-area phrase sits between the street and "SINGAPORE <postal>" and is
 * stripped so the merge rules can compare streets. CONSERVATION_AREAS below is checked
 * longest-first; anything unmatched falls back to a street-type heuristic and is flagged.
 */
import { ParsedAddress } from './types.js';
import { naturalCompare, squash, upper, uniq } from './text.js';

/**
 * URA conservation area / secondary settlement names, as they appear in the Main Database.
 * Verified to cover 100% of the 2,560 conservation-area addresses in the PropCo tracker
 * (see test/real-data.check.ts). Add new names here if URA gazettes more.
 */
export const CONSERVATION_AREAS: string[] = [
  'PETAIN ROAD/TYRWHITT ROAD',
  'RACE COURSE ROAD/OWEN ROAD',
  'JALAN JURONG KECHIL',
  'MOHAMED SULTAN ROAD',
  'UPPER CIRCULAR ROAD',
  'SUN YAT SEN VILLA',
  'SERANGOON GARDEN',
  'GEYLANG SERAI',
  'TANJONG KATONG',
  'KAMPONG BAHRU',
  'KAMPONG GLAM',
  'TANJONG PAGAR',
  'WATERLOO STREET',
  'JALAN BESAR',
  'JALAN KUBOR',
  'LITTLE INDIA',
  'DESKER ROAD',
  'EMERALD HILL',
  'KIM YAM ROAD',
  'KILLINEY ROAD',
  'MOUNT SOPHIA',
  'RIVER VALLEY',
  'BUKIT PASOH',
  'BLAIR PLAIN',
  'BEACH ROAD',
  'SUNGEI ROAD',
  'TIONG BAHRU',
  'JOO CHIAT',
  'BALESTIER',
  'KRETA AYER',
  'TELOK AYER',
  'BOAT QUAY',
  'CAIRNHILL',
  'CHINATOWN',
  'CUPPAGE',
  'GEYLANG',
  'SELEGIE',
  'ROCHOR',
];

const CONSERVATION_AREAS_SORTED = [...CONSERVATION_AREAS].sort((a, b) => b.length - a.length);

/** Trailing tokens that mark the end of a street name, used only as a fallback. */
const STREET_TYPES = [
  'ROAD', 'STREET', 'LANE', 'AVENUE', 'CRESCENT', 'CLOSE', 'DRIVE', 'WALK', 'TERRACE',
  'PLACE', 'HILL', 'PARK', 'VIEW', 'RISE', 'LINK', 'WAY', 'GARDENS', 'GARDEN', 'GROVE',
  'GREEN', 'QUAY', 'CIRCLE', 'CIRCUS', 'CROSS', 'MALL', 'PLAZA', 'BOULEVARD', 'HEIGHTS',
  'VALLEY', 'FIELD', 'ESTATE', 'LOOP', 'JUNCTION', 'BRIDGE', 'ALLEY', 'PATH', 'SQUARE',
  'CENTRE', 'CENTER', 'BUILDING', 'COMPLEX', 'TOWER', 'MEWS', 'VILLE', 'VISTA',
];

/** Leading house numbers: "91", "27A", "72, 74", "21/23", "27 & 29". */
const LEADING_NUMBERS = /^(\d+[A-Z]?(?:\s*[,/&+-]\s*\d+[A-Z]?)*)\s+/;

/**
 * Parse one Singapore property address into numbers / street / postal.
 * Never throws — an unparseable address comes back with `unparsed: true` and the raw
 * text in `street`, so the caller can surface it for review instead of losing the row.
 */
export function parseAddress(raw: unknown): ParsedAddress {
  const original = squash(raw);
  const text = upper(original);
  const empty: ParsedAddress = {
    raw: original,
    numbers: [],
    street: text,
    postal: '',
    unparsed: true,
  };
  if (!text) return empty;

  // Pull off "SINGAPORE 049442" / "SINGAPORE (049442)" / a bare trailing 6-digit code.
  let body = text;
  let postal = '';
  const sgMatch = body.match(/\bSINGAPORE\s*\(?\s*(\d{5,6})\s*\)?\s*$/);
  if (sgMatch) {
    postal = sgMatch[1].padStart(6, '0');
    body = body.slice(0, sgMatch.index).trim();
  } else {
    const bare = body.match(/\b(\d{6})\s*$/);
    if (bare) {
      postal = bare[1];
      body = body.slice(0, bare.index).trim();
    } else {
      const trailingSg = body.match(/\bSINGAPORE\s*$/);
      if (trailingSg) body = body.slice(0, trailingSg.index).trim();
    }
  }
  body = body.replace(/[,\s]+$/, '');

  // Strip the conservation-area phrase.
  let conservationArea: string | undefined;
  const caIndex = body.indexOf('CONSERVATION AREA');
  if (caIndex >= 0) {
    const beforeCa = body.slice(0, caIndex).replace(/[,\s]+$/, '');
    const matched = CONSERVATION_AREAS_SORTED.find(
      (area) => beforeCa === area || beforeCa.endsWith(' ' + area),
    );
    if (matched) {
      conservationArea = matched;
      body = beforeCa.slice(0, beforeCa.length - matched.length).replace(/[,\s]+$/, '');
    } else {
      // Fallback: cut after the last street-type token.
      const tokens = beforeCa.split(' ');
      let cut = -1;
      for (let i = tokens.length - 1; i >= 0; i--) {
        if (STREET_TYPES.includes(tokens[i])) {
          cut = i;
          break;
        }
      }
      if (cut >= 0 && cut < tokens.length - 1) {
        conservationArea = tokens.slice(cut + 1).join(' ');
        body = tokens.slice(0, cut + 1).join(' ');
      } else {
        conservationArea = undefined;
        body = beforeCa;
      }
    }
  }

  // Split leading house numbers off the street.
  let numbers: string[] = [];
  const numMatch = body.match(LEADING_NUMBERS);
  if (numMatch) {
    numbers = numMatch[1]
      .split(/\s*[,/&+-]\s*/)
      .map((n) => n.trim())
      .filter(Boolean);
    body = body.slice(numMatch[0].length).trim();
  }

  const street = body.replace(/[,\s]+$/, '').trim();
  return {
    raw: original,
    numbers,
    street,
    conservationArea,
    postal,
    // Anything without a postal code or without a street is worth a human look.
    unparsed: !postal || !street,
  };
}

/** Comparison key for "is this the same street?". */
export function streetKey(address: ParsedAddress): string {
  return address.street.replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Merge postal codes for a single street per the spec:
 *   111100, 111101, 111102  ->  "111100 / 01 / 02"
 * The first postal is written in full; later ones contribute their last two digits.
 * Postal codes that do not share the first four digits are appended in full.
 */
export function mergePostalCodes(postals: string[]): string {
  const list = uniq(postals.filter(Boolean)).sort(naturalCompare);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];

  const first = list[0];
  const prefix = first.slice(0, 4);
  const parts: string[] = [first];
  for (const p of list.slice(1)) {
    if (p.slice(0, 4) === prefix) {
      parts.push(p.slice(-2));
    } else {
      parts.push(p);
    }
  }
  return parts.join(' / ');
}

/** Merge house numbers for a single street: 27, 29 -> "27 / 29". */
export function mergeHouseNumbers(numbers: string[]): string {
  return uniq(numbers.filter(Boolean)).sort(naturalCompare).join(' / ');
}

export interface MergedAddress {
  /** Numbers + street, no postal: "27 / 29 CLUB STREET". */
  address: string;
  /** Numbers + street + postal: "27 / 29 CLUB STREET SINGAPORE 069413 / 14". */
  fullAddress: string;
  /** True when more than one distinct street was merged (joined with "; "). */
  multiStreet: boolean;
}

/**
 * Merge a set of property addresses that belong to one recipient.
 *
 * Same street  -> numbers joined with " / ", postals collapsed by the rule above.
 * Different streets -> each street rendered separately and joined with "; ".
 */
export function mergeAddresses(addresses: ParsedAddress[]): MergedAddress {
  const usable = addresses.filter((a) => a.raw);
  if (usable.length === 0) return { address: '', fullAddress: '', multiStreet: false };

  // Preserve first-seen street order so output is stable and reads naturally.
  const order: string[] = [];
  const byStreet = new Map<string, ParsedAddress[]>();
  for (const a of usable) {
    const key = streetKey(a) || a.raw;
    if (!byStreet.has(key)) {
      byStreet.set(key, []);
      order.push(key);
    }
    byStreet.get(key)!.push(a);
  }

  const addressParts: string[] = [];
  const fullParts: string[] = [];

  for (const key of order) {
    const group = byStreet.get(key)!;
    const anyUnparsed = group.some((g) => g.unparsed && !g.street);
    if (anyUnparsed) {
      // Cannot safely restructure — pass the raw text straight through.
      for (const g of group) {
        addressParts.push(g.raw);
        fullParts.push(g.raw);
      }
      continue;
    }
    const numbers = mergeHouseNumbers(group.flatMap((g) => g.numbers));
    const street = group[0].street;
    const postal = mergePostalCodes(group.map((g) => g.postal));
    const head = [numbers, street].filter(Boolean).join(' ');
    addressParts.push(head);
    fullParts.push(postal ? `${head} SINGAPORE ${postal}` : head);
  }

  return {
    address: addressParts.join('; '),
    fullAddress: fullParts.join('; '),
    multiStreet: order.length > 1,
  };
}

/**
 * Normalise an owner's mailing address for grouping and for the
 * "[Block No.] [Street Name] [Unit no.] [Postal Code]" review in step 7.
 * Returns a comparison key, not display text — display keeps the original.
 */
export function mailingAddressKey(raw: unknown): string {
  return upper(raw)
    .replace(/\bSINGAPORE\b/g, ' ')
    .replace(/[.,'"()]/g, ' ')
    .replace(/\s*#\s*/g, '#')
    .replace(/[-–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The placeholder text the tracker uses for strata lots — never a mailable address. */
export function isStrataPlaceholder(raw: unknown): boolean {
  const text = upper(raw);
  return (
    text.includes('REGISTERED PROPRIETORS OF THE STRATA') ||
    text.includes('SUBSIDIARY CERTIFICATES OF TITLE')
  );
}

/** True when a mailing address has no Singapore postal code (likely overseas). */
export function looksOverseas(raw: unknown): boolean {
  const text = upper(raw);
  if (!text) return false;
  if (isStrataPlaceholder(text)) return false;
  return !/\b\d{6}\b/.test(text) && !/\bSINGAPORE\b/.test(text);
}
