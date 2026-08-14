/** Shared domain types for the PropCo outreach pipeline. */

export type OutreachChannel = 'lawyer-letter' | 'postcard';

/** One row of the PropCo Main Database, after header mapping. */
export interface SourceRow {
  /** 1-based row number in the source sheet (header is row 1). Used in every audit trail. */
  sourceRow: number;
  addressId?: string;
  address?: string;
  postalCode?: string;
  target?: string;
  propertyCondition?: string;
  otherPropertyAddresses?: string;
  relationshipWithProperty?: string;
  /** Owner name/address pairs 1..5, as they appear in the source. */
  owners: { name?: string; address?: string; slot: number }[];
  contactPerson?: string;
  contactNoOrEmail?: string;
  remarks?: string;
  tenure?: string;
  landAreaSqm?: number;
  ownerAge?: string;
  ownerProfile?: string;
  lastTransactionDate?: string;
  noOfFloors?: number;
  /** Gross floor area. Verified against the tracker as SQUARE FEET (landAreaSqm * 10.7639 * floors). */
  gfaSqft?: number;
  gpr?: string;
  gfaMaximisationPotential?: string;
  landUse?: string;
  rearExtension?: string;
  postcardOutreach?: unknown;
  lawyerLetterOutreach?: unknown;
  neighbourhood?: string;
  /** Benchmark psf of GFA, looked up by the tracker from Neighbourhood Benchmarks. */
  benchmarkPsf?: number;
  scorePt1?: number;
  scorePt2?: number;
  /** Every raw cell, keyed by the original header, for passthrough + audit. */
  raw: Record<string, unknown>;
}

/** How a value in an outreach-tracking column is interpreted. */
export type OutreachStatus =
  | 'blank'
  | 'sent-date'
  | 'batch-tag'
  | 'delivery-failed'
  | 'opt-out'
  | 'do-not-send'
  | 'other';

export interface OutreachClassification {
  status: OutreachStatus;
  /** Original cell text, trimmed. Empty string when blank. */
  text: string;
  /** Parsed date when the cell is (or begins with) a date. */
  date?: Date;
}

/** One (property, owner) pair — the unit the pipeline dedupes on. */
export interface OwnerRow {
  sourceRow: number;
  ownerSlot: number;
  target: string;
  neighbourhood: string;
  landUse: string;
  tenure: string;
  /** Cleaned owner name (aliases stripped). */
  ownerName: string;
  /** Owner name exactly as it appeared in the source. */
  ownerNameRaw: string;
  ownerAddress: string;
  ownerAddressRaw: string;
  /** Parsed property address components. */
  property: ParsedAddress;
  gfaSqft?: number;
  benchmarkPsf?: number;
  addressId?: string;
  contactPerson?: string;
  contactNoOrEmail?: string;
  /** True when the owner name looks like a registered company (PTE/LTD/LLP/...). */
  isCorporate: boolean;
  /**
   * Owner count declared inline by a "Total N owners:" prefix in the source cell.
   * Used by the ">4 owners becomes 'Owners of ___'" rule, which would otherwise count
   * a packed multi-owner string as a single owner.
   */
  declaredOwnerCount?: number;
  notes: string[];
}

export interface ParsedAddress {
  /** Original address string. */
  raw: string;
  /** House numbers, e.g. ["27"] or ["72","74"]. */
  numbers: string[];
  /** Street name with the conservation-area phrase removed, e.g. "CLUB STREET". */
  street: string;
  /** Conservation area that was stripped, when one was found. */
  conservationArea?: string;
  /** 6-digit Singapore postal code. */
  postal: string;
  /** True when the parser could not confidently split the address. */
  unparsed: boolean;
}

/** A deduped group: one letter / postcard recipient. */
export interface RecipientGroup {
  key: string;
  target: string;
  neighbourhood: string;
  landUse: string;
  tenure: string;
  members: OwnerRow[];
  /** Merged property address without postal, e.g. "27 / 29 CLUB STREET". */
  address: string;
  /** Merged property address with postal, e.g. "27 / 29 CLUB STREET SINGAPORE 069413 / 14". */
  fullAddress: string;
  /** Owner names joined per the "&" rule. */
  registeredProprietor: string;
  /** The single mailing address for this recipient. */
  mailingAddress: string;
  distinctOwnerNames: string[];
  notes: string[];
}

export interface CompsRecord {
  neighbourhood: string;
  landUse: string;
  tenure: string;
  minimumPrice?: number;
  higherPrice?: number;
  compAddress1?: string;
  comp1?: number;
  comp1Date?: Date;
  compAddress2?: string;
  comp2?: number;
  comp2Date?: Date;
}

export interface ExclusionRecord {
  sourceRow: number;
  addressId?: string;
  address?: string;
  ownerName?: string;
  stage: string;
  reason: string;
  detail?: string;
}

export interface ReviewFlag {
  sourceRow: number | string;
  address?: string;
  ownerName?: string;
  flag: string;
  detail?: string;
  severity: 'info' | 'warn' | 'error';
}

export interface PipelineWarning {
  scope: string;
  message: string;
  count?: number;
  samples?: string[];
}

export interface PipelineOptions {
  channel: OutreachChannel;
  /** Date the letters/postcards are mailed. Drives Mail_Date and Valid_Date. */
  mailDate: Date;
  /** Days added to Mail_Date for Valid_Date. */
  validityDays: number;
  outreachFilter: {
    mode: 'exclude-contacted' | 'only-tagged' | 'match' | 'all';
    /** Case-insensitive substring, used when mode === 'match'. */
    matchText?: string;
    /** Drop opt-outs / do-not-send rows regardless of mode. */
    alwaysExcludeOptOut: boolean;
  };
  /** Owners holding strictly more than this many properties are removed. */
  maxPropertiesPerOwner: number;
  /** More than this many distinct owner names on one recipient becomes "Owners of ___". */
  maxOwnersBeforeCollapse: number;
  /** Owner names longer than this become "Owners of ___". */
  maxOwnerNameLength: number;
  /** Remove owners matching the agency / association / developer patterns. */
  removeAgenciesAndDevelopers: boolean;
  /** Include the group key's owner name so different owners never merge. */
  groupByOwnerName: boolean;
  /** Emit the audit subsheets alongside the deliverable sheets. */
  includeAuditSheets: boolean;
  /** Property addresses (or postal codes) the user wants skipped, e.g. a compset upload. */
  suppressionList: SuppressionEntry[];
  /** Owner names the user wants skipped. */
  suppressedOwnerNames: string[];
  /** Comps benchmark rows (from the tracker sheet, or a user upload). */
  comps: CompsRecord[];
  /** When no comps row matches, derive prices from GFA x benchmark psf. */
  deriveMissingPrices: boolean;
  /** Uplift applied to the derived minimum to produce the higher price. */
  derivedHigherMultiplier: number;
  /** Round derived prices to this increment. */
  derivedRounding: number;
  /**
   * Corrected mailing addresses, keyed by the normalised owner name. Used to re-run the
   * whole pipeline after BizFile verification finds a wrong address — dedupe and merging
   * depend on the address, so a corrected address has to go in at the start, not be
   * patched into the finished sheet.
   */
  ownerAddressOverrides?: Record<string, AddressOverride>;
}

export interface AddressOverride {
  /** The replacement mailing address. */
  address: string;
  /** Where it came from, for the audit sheet. */
  source: string;
  /** Owner name as supplied, for the audit sheet. */
  ownerName: string;
}

/** One override actually applied during a run. */
export interface AppliedAddressOverride {
  ownerName: string;
  sourceRow: string;
  previousAddress: string;
  newAddress: string;
  source: string;
}

export interface SuppressionEntry {
  /** Free-text address as supplied. */
  address?: string;
  postal?: string;
  ownerName?: string;
  source: string;
}

export interface LawyerLetterRow {
  Comments: string;
  'Owner No.': string;
  Target: string;
  Address: string;
  Full_Address: string;
  Neighbourhood: string;
  'Land Use': string;
  Mail_Date: Date;
  Valid_Date: Date;
  Registered_Proprietor: string;
  Registered_Proprietor_mailing_address: string;
  'Duplicate Owner / Owner Addresses': string;
  minimum_Price: number | '';
  higher_Price: number | '';
  Comp_Address_1: string;
  Comp_1: number | '';
  Comp_1_Date: Date | '';
  Comp_Address_2: string;
  Comp_2: number | '';
  Comp_2_Date: Date | '';
  Status: string;
  'Date Responded': string;
}

export interface PostcardRow {
  Target: string;
  Address: string;
  'Full Address': string;
  Neighbourhood: string;
  'Land Use': string;
  'Owner Name': string;
  'Owner Address': string;
  Checking: string;
  'Contact Name': string;
  'Contact Number': string;
  Status: string;
  'Updated Date': string;
}

export interface PipelineResult {
  channel: OutreachChannel;
  options: PipelineOptions;
  sourceRowCount: number;
  lawyerLetterRows: LawyerLetterRow[];
  postcardRows: PostcardRow[];
  ownerRows: OwnerRow[];
  groups: RecipientGroup[];
  exclusions: ExclusionRecord[];
  flags: ReviewFlag[];
  warnings: PipelineWarning[];
  stats: Record<string, number>;
  /** Corrected addresses that actually changed a row on this run. */
  appliedAddressOverrides?: AppliedAddressOverride[];
}
