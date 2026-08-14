/** Types for the BizFile registered-address verification step. */

export interface CorporateOwnerQuery {
  ownerName: string;
  /** Every mailing address the sheet holds for this owner. */
  mailingAddresses: string[];
  /** Properties this owner is attached to, for context in the report. */
  propertyAddresses: string[];
}

export interface BizFileRecord {
  name: string;
  uen?: string;
  registeredAddress?: string;
  status?: string;
  entityType?: string;
  source: 'upload' | 'bizfile-scrape' | 'acra-opendata';
}

export type BizFileVerdict =
  /** Registered address matches the sheet exactly. */
  | 'match'
  /** Same building (postal code matches) but unit or formatting differs. */
  | 'match-building'
  /** Registered address differs — update the sheet before sending. */
  | 'mismatch'
  /** Entity is struck off / dissolved / ceased — do not send. */
  | 'entity-inactive'
  /** Record found but nothing comparable in it. */
  | 'inconclusive'
  /** No BizFile record for this name. */
  | 'not-found'
  /**
   * The lookup itself failed (throttled, timed out, network error). Distinct from
   * `not-found` on purpose: "we could not check" must never read as "ACRA has no record".
   */
  | 'lookup-failed';

export interface BizFileVerification {
  ownerName: string;
  mailingAddressInSheet: string;
  propertyAddresses: string;
  bizfileName?: string;
  uen?: string;
  entityStatus?: string;
  bizfileAddress?: string;
  verdict: BizFileVerdict;
  detail: string;
}
