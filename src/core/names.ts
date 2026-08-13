/** Owner-name cleaning and classification (step 7 of the outreach spec). */
import { normKey, squash, upper, uniq } from './text.js';

const CORPORATE_TOKENS = [
  'PTE', 'PTE.', 'LTD', 'LTD.', 'LIMITED', 'PRIVATE', 'LLP', 'LLC', 'INC', 'INC.',
  'CORP', 'CORP.', 'CORPORATION', 'COMPANY', 'CO.', 'SDN', 'BHD', 'BERHAD', 'GMBH',
  'HOLDINGS', 'ENTERPRISE', 'ENTERPRISES', 'INTERNATIONAL', 'GROUP', 'PLC',
];

/**
 * True when the name looks like a registered entity rather than a natural person.
 * Drives (a) whether bracketed text is an alias or part of the legal name, and
 * (b) which rows the BizFile verification step queues up.
 */
export function isCorporateName(name: unknown): boolean {
  const text = upper(name);
  if (!text) return false;
  if (/\bPTE\.?\s*LTD\.?\b|\bPRIVATE\s+LIMITED\b|\bLIMITED\b|\bLTD\.?\b|\bLLP\b|\bLLC\b/.test(text)) {
    return true;
  }
  const tokens = text.replace(/[(),.]/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.some((t) => CORPORATE_TOKENS.includes(t));
}

export interface InstitutionEntry {
  name: string;
  status: string;
  remarks?: string;
}

/**
 * Institutions and competitors to avoid. Per the spec these are FLAGGED IN COMMENTS,
 * not removed — a human decides.
 *
 * The list is deliberately EMPTY in source. It is confidential competitive intelligence,
 * and this repository is public. At runtime it is loaded from, in order of preference:
 *
 *   1. the uploaded workbook's own "Institutions to Avoid" sheet — the source of truth,
 *      so the list is never stale;
 *   2. `config/institutions-to-avoid.json` (git-ignored) as an override.
 *
 * See `loadInstitutions` in src/core/config.ts.
 */
export const DEFAULT_INSTITUTIONS_TO_AVOID: InstitutionEntry[] = [];

/**
 * Unambiguous agencies, associations and statutory bodies. These ARE removed
 * (spec step 7) because a letter to them is never actionable.
 */
export const AGENCY_PATTERNS: RegExp[] = [
  /\bMANAGEMENT\s+CORPORATION\b/,
  /\bMCST\b/,
  /\bSTRATA\s+TITLE\s+PLAN\b/,
  /\bTOWN\s+COUNCIL\b/,
  /\bHOUSING\s*(&|AND)?\s*DEVELOPMENT\s+BOARD\b/,
  /\bHDB\b/,
  /\bURBAN\s+REDEVELOPMENT\s+AUTHORITY\b/,
  /\bSINGAPORE\s+LAND\s+AUTHORITY\b/,
  /\bJTC\s+CORPORATION\b/,
  /\bLAND\s+TRANSPORT\s+AUTHORITY\b/,
  /\bPEOPLE'?S\s+ASSOCIATION\b/,
  /\bASSOCIATION\b/,
  /\bSOCIETY\b/,
  /\bHUAY\s+KUAN\b/,
  /\bKONGSI\b/,
  /\bCLAN\b/,
  /\bTEMPLE\b/,
  /\bMOSQUE\b/,
  /\bMASJID\b/,
  /\bCHURCH\b/,
  /\bCHURCH\s+OF\b/,
  /\bSCHOOL\b/,
  /\bMINISTRY\s+OF\b/,
  /\bTRUSTEES?\s+OF\b/,
  /\bBOARD\s+OF\s+TRUSTEES\b/,
  /\bCOMMISSIONER\s+OF\b/,
  /\bPRESIDENT\s+OF\s+THE\s+REPUBLIC\b/,
];

/**
 * Large property developers. Removed with the agencies — they do not sell to us.
 * Extend via config; matching is on a normalised substring.
 */
export const DEVELOPER_NAMES: string[] = [
  'CAPITALAND', 'CITY DEVELOPMENTS', 'FAR EAST ORGANIZATION', 'FAR EAST ORGANISATION',
  'FRASERS PROPERTY', 'FRASERS CENTREPOINT', 'GUOCOLAND', 'HONGKONG LAND', 'KEPPEL LAND',
  'MAPLETREE', 'OUE LIMITED', 'PERENNIAL', 'ROXY-PACIFIC', 'SINGHAIYI', 'TUAN SING',
  'UOL GROUP', 'WING TAI', 'BUKIT SEMBAWANG', 'CHIP ENG SENG', 'HOI HUP', 'LIAN BENG',
  'LOW KENG HUAT', 'OXLEY HOLDINGS', 'SIM LIAN', 'SING HOLDINGS', 'TIONG SENG',
  'WORLD CLASS LAND', 'ASPIAL', 'HO BEE LAND', 'ALLGREEN PROPERTIES', 'QINGJIAN',
  'KAJIMA', 'SHUN TAK', 'SL DEVELOPMENT', 'TID PTE',
];

/**
 * Corporate-sounding names that are usually family holding companies, not agencies.
 * These are FLAGGED for review rather than removed — removing them silently would
 * drop real targets (e.g. "NANYANG REALTY (PRIVATE) LIMITED").
 */
export const REVIEW_ONLY_PATTERNS: RegExp[] = [
  /\bREALTY\b/,
  /\bREAL\s+ESTATE\b/,
  /\bPROPERT(Y|IES)\b/,
  /\bDEVELOPMENT(S)?\b/,
  /\bINVESTMENT(S)?\b/,
  /\bHOLDINGS?\b/,
  /\bLAND\b/,
  /\bESTATES?\b/,
  /\bFOUNDATION\b/,
];

/**
 * Placeholder text the title search returns instead of a name when the property is
 * strata-subdivided. Never a mailable recipient.
 * e.g. "ALL THE REGISTERED PROPRIETORS OF ALL THE STRATA LOTS COMPRISED IN THE LAND"
 */
export function isStrataPlaceholderName(name: unknown): boolean {
  const text = upper(name);
  if (!text) return false;
  return (
    /ALL\s+THE\s+REGISTERED\s+PROPRIETORS/.test(text) ||
    // "ALL SUBSIDIARY PROPRIETORS OF ALL THE STRATA LOTS" — and the source's
    // "SUBSIDARY" typo, which appears on 19 rows of the tracker.
    /SUBSID[AI]RY\s+PROPRIETORS/.test(text) ||
    /STRATA\s+LOTS?\s+COMPRISED/.test(text) ||
    /\bOF\s+ALL\s+THE\s+STRATA\s+LOTS?\b/.test(text) ||
    /SUBSIDIARY\s+CERTIFICATES?\s+OF\s+TITLE/.test(text)
  );
}

/**
 * Some cells pack overflow owners into one string, prefixed with the true owner count:
 *   "Total 18 owners: LIANG TEW NGOH, LIANG TIEW PENG, ..."
 *   "TOTAL 6 OWNERS; 5TH+ OWNERS: HOON KEE KIONG (HONG QIQIANG); HOON QIWEI"
 * The count matters — it drives the ">4 owners becomes 'Owners of ___'" rule, which
 * would otherwise see a single long string and count it as one owner.
 */
export function parseOwnerCountPrefix(name: unknown): { declaredCount?: number; rest: string } {
  let text = squash(name);
  if (!text) return { rest: '' };
  let declaredCount: number | undefined;

  const total = text.match(/^\s*TOTAL\s+(\d+)\s+OWNERS?\s*[:;.\-]?\s*/i);
  if (total) {
    declaredCount = Number(total[1]);
    text = squash(text.slice(total[0].length));
  }
  // Strip a following "5TH+ OWNERS:" / "3RD OWNER -" style marker.
  const ordinal = text.match(/^\s*\d+(?:ST|ND|RD|TH)\+?\s+OWNERS?\s*[:;.\-]?\s*/i);
  if (ordinal) text = squash(text.slice(ordinal[0].length));

  return { declaredCount, rest: text };
}

export interface NameClassification {
  /** Cleaned display name. */
  cleaned: string;
  isCorporate: boolean;
  /** Alias text stripped out, if any. */
  alias?: string;
  /** Owner count declared inline by a "Total N owners" prefix. */
  declaredOwnerCount?: number;
  /** True when the cell is the strata-lot placeholder rather than a real name. */
  isStrataPlaceholder: boolean;
  /** Matched institution-to-avoid entry (comment only, never auto-removed). */
  institutionMatch?: { name: string; status: string; remarks?: string };
  /** Set when the name is an agency/association/statutory body — removal candidate. */
  agencyMatch?: string;
  /** Set when the name matches a large developer — removal candidate. */
  developerMatch?: string;
  /** Set when the name is corporate-ish but ambiguous — review, do not remove. */
  reviewMatch?: string;
  /** True when the cell may contain more than one person's name. */
  possibleMultiName: boolean;
}

/**
 * Strip alias text from an owner name.
 *
 * Two alias shapes appear in the tracker:
 *   "CHOW TZE TIEN\nAlias :CHEW AH KEW"   -> newline form
 *   "ANNIE TAN SWEE LAN (ANNIE CHEN RUILAN)" -> bracket form
 *
 * Bracketed text is only treated as an alias for natural persons. Company names keep
 * their brackets, because "(PRIVATE) LIMITED", "(S)" and "(02)" are part of the legal name.
 */
export function stripAlias(name: unknown): { cleaned: string; alias?: string } {
  let text = squash(String(name ?? '').replace(/\r/g, ''));
  if (!text) return { cleaned: '' };

  let alias: string | undefined;

  const aliasWord = text.match(/\bALIAS\s*:?\s*(.+)$/i);
  if (aliasWord) {
    alias = squash(aliasWord[1]);
    text = squash(text.slice(0, aliasWord.index));
  }

  if (!isCorporateName(text)) {
    const bracket = text.match(/\(([^()]*)\)\s*$/);
    if (bracket) {
      const inner = squash(bracket[1]);
      // Keep things like "(DECEASED)" out of the alias bucket but still strip them.
      alias = alias ? `${alias}; ${inner}` : inner;
      text = squash(text.slice(0, bracket.index));
    }
  }

  return { cleaned: text.replace(/[,;]\s*$/, '').trim(), alias };
}

/**
 * A comma in an owner cell is usually "SURNAME, GIVEN NAME" or a western given name
 * ("TAN BOON SIANG, FRANCIS"), not a second owner — so we never split automatically.
 * We only flag cells where every comma-separated part is itself a multi-word full name,
 * which is the shape a genuine multi-owner cell takes.
 */
export function looksLikeMultipleNames(name: unknown): boolean {
  const text = squash(name);
  if (!text) return false;
  if (text.includes('\n')) return true;
  const parts = text.split(',').map((p) => squash(p)).filter(Boolean);
  if (parts.length < 2) return false;
  if (isCorporateName(text)) return false;
  return parts.every((p) => p.split(' ').filter(Boolean).length >= 2);
}

export interface ClassifyOptions {
  institutions?: { name: string; status: string; remarks?: string }[];
  developerNames?: string[];
}

export function classifyName(name: unknown, options: ClassifyOptions = {}): NameClassification {
  const { declaredCount, rest } = parseOwnerCountPrefix(name);
  const { cleaned, alias } = stripAlias(rest);
  const key = normKey(cleaned);
  const text = upper(cleaned);
  const strata = isStrataPlaceholderName(cleaned);

  const institutions = options.institutions ?? DEFAULT_INSTITUTIONS_TO_AVOID;
  const developers = options.developerNames ?? DEVELOPER_NAMES;
  const isCorporate = isCorporateName(cleaned);

  const institutionMatch = strata
    ? undefined
    : institutions.find((i) => {
        const ik = normKey(i.name);
        return ik.length > 0 && (key === ik || key.includes(ik) || ik.includes(key));
      });

  const agencyMatch = strata ? undefined : AGENCY_PATTERNS.find((re) => re.test(text))?.source;

  // Developer matching only applies to registered entities and only on whole words.
  // Without both guards "LEE TIONG SENG" (a person) matches the developer "TIONG SENG"
  // and a real target gets silently dropped.
  const developerMatch =
    strata || !isCorporate
      ? undefined
      : developers.find((d) => ` ${key} `.includes(` ${normKey(d)} `));

  const reviewMatch = strata ? undefined : REVIEW_ONLY_PATTERNS.find((re) => re.test(text))?.source;

  return {
    cleaned,
    alias,
    declaredOwnerCount: declaredCount,
    isStrataPlaceholder: strata,
    isCorporate,
    institutionMatch,
    agencyMatch,
    developerMatch,
    reviewMatch: agencyMatch || developerMatch ? undefined : reviewMatch,
    // Run the multi-name heuristic on the cleaned name so alias brackets do not skew it.
    possibleMultiName: looksLikeMultipleNames(cleaned) || (declaredCount ?? 0) > 1,
  };
}

/**
 * Join owner names for one recipient.
 * Spec: same property + same mailing address -> "JANE XIA & LONG GAN".
 */
/**
 * Split a personal owner cell into its co-owner components.
 *
 * The source is inconsistent: the same couple appears as one cell
 * "GOH ENG SIE & ONG SEW LAN" on one property and as two owner slots on another.
 * Without splitting, joining those produces
 * "GOH ENG SIE & ONG SEW LAN & GOH ENG SIE & ONG SEW LAN".
 *
 * Company names keep their ampersands — "SMITH & SONS REALTY (PRIVATE) LIMITED" and
 * "M & A (02) PTE. LTD." are single legal entities, not two co-owners.
 */
export function splitCoOwners(name: unknown): string[] {
  const text = squash(name);
  if (!text) return [];
  if (isCorporateName(text)) return [text];
  if (!/\s&\s/.test(text)) return [text];
  return text
    .split(/\s+&\s+/)
    .map((p) => squash(p))
    .filter(Boolean);
}

/** Distinct co-owner components by normalised key, keeping the first spelling seen. */
export function distinctOwnerNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    for (const part of splitCoOwners(raw)) {
      const key = normKey(part);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(part);
    }
  }
  return out;
}

export function joinOwnerNames(names: string[]): string {
  const list = distinctOwnerNames(names);
  if (list.length === 0) return '';
  if (list.length === 1) return list[0];
  return list.join(' & ');
}

/**
 * Collapse to "Owners of ___" when the name is too long or there are too many owners.
 * Uses the merged property address so the letter still addresses a real place.
 */
export function collapseToOwnersOf(address: string): string {
  const clean = squash(address);
  return clean ? `Owners of ${clean}` : 'Owners of the Property';
}
