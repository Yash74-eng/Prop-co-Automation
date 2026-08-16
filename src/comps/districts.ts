/**
 * Singapore postal districts.
 *
 * Comps are picked from the district a property sits in, so the district has to be
 * derived reliably. The first two digits of a six-digit postal code are the postal
 * sector, and each sector belongs to exactly one of the 28 districts — a fixed, public
 * mapping, which beats a hand-maintained neighbourhood lookup that would need a new entry
 * every time the tracker names a new street.
 *
 * Verified against the published table on 17 Aug 2026, and against the worked example
 * given for this feature: Changi Road is postal sector 41, which lands in District 14,
 * and the Market Watch sheet does carry the Changi Road transactions on its D14 tab.
 *
 *   https://www.mingproperty.sg/singapore-district-code/
 */

/** district number -> the postal sectors that belong to it. */
export const DISTRICT_SECTORS: Record<number, string[]> = {
  1: ['01', '02', '03', '04', '05', '06'],
  2: ['07', '08'],
  3: ['14', '15', '16'],
  4: ['09', '10'],
  5: ['11', '12', '13'],
  6: ['17'],
  7: ['18', '19'],
  8: ['20', '21'],
  9: ['22', '23'],
  10: ['24', '25', '26', '27'],
  11: ['28', '29', '30'],
  12: ['31', '32', '33'],
  13: ['34', '35', '36', '37'],
  14: ['38', '39', '40', '41'],
  15: ['42', '43', '44', '45'],
  16: ['46', '47', '48'],
  17: ['49', '50', '81'],
  18: ['51', '52'],
  19: ['53', '54', '55', '82'],
  20: ['56', '57'],
  21: ['58', '59'],
  22: ['60', '61', '62', '63', '64'],
  23: ['65', '66', '67', '68'],
  24: ['69', '70', '71'],
  25: ['72', '73'],
  26: ['77', '78'],
  27: ['75', '76'],
  28: ['79', '80'],
};

/** General locality per district, used only to explain a match in the audit trail. */
export const DISTRICT_NAMES: Record<number, string> = {
  1: "Raffles Place, Cecil, Marina, People's Park",
  2: 'Anson, Tanjong Pagar',
  3: 'Queenstown, Tiong Bahru',
  4: 'Telok Blangah, Harbourfront',
  5: 'Pasir Panjang, Hong Leong Garden, Clementi New Town',
  6: 'High Street, Beach Road',
  7: 'Middle Road, Golden Mile',
  8: 'Little India',
  9: 'Orchard, Cairnhill, River Valley',
  10: 'Ardmore, Bukit Timah, Holland Road, Tanglin',
  11: 'Watten Estate, Novena, Thomson',
  12: 'Balestier, Toa Payoh, Serangoon',
  13: 'Macpherson, Braddell',
  14: 'Geylang, Eunos',
  15: 'Katong, Joo Chiat, Amber Road',
  16: 'Bedok, Upper East Coast, Eastwood, Kew Drive',
  17: 'Loyang, Changi',
  18: 'Tampines, Pasir Ris',
  19: 'Serangoon Garden, Hougang, Punggol',
  20: 'Bishan, Ang Mo Kio',
  21: 'Upper Bukit Timah, Clementi Park, Ulu Pandan',
  22: 'Jurong',
  23: 'Hillview, Dairy Farm, Bukit Panjang, Choa Chu Kang',
  24: 'Lim Chu Kang, Tengah',
  25: 'Kranji, Woodgrove',
  26: 'Upper Thomson, Springleaf',
  27: 'Yishun, Sembawang',
  28: 'Seletar',
};

const SECTOR_TO_DISTRICT: Map<string, number> = new Map(
  Object.entries(DISTRICT_SECTORS).flatMap(([district, sectors]) =>
    sectors.map((s) => [s, Number(district)] as [string, number]),
  ),
);

/**
 * District for a Singapore postal code. Accepts anything the tracker holds — a 6-digit
 * string, a number that lost its leading zero in Excel, or an address with the code
 * embedded in it. Returns undefined rather than guessing.
 */
export function districtFromPostalCode(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;

  let text = String(value).trim();
  if (!text) return undefined;

  // Excel drops the leading zero on codes like 049442, leaving 49442.
  if (/^\d{5}$/.test(text)) text = `0${text}`;

  // A bare 6-digit code, or the last 6-digit run inside a longer address string.
  const direct = /^(\d{6})$/.exec(text);
  const sector = direct
    ? direct[1].slice(0, 2)
    : [...text.matchAll(/\b(\d{6})\b/g)].pop()?.[1]?.slice(0, 2);

  if (!sector) return undefined;
  return SECTOR_TO_DISTRICT.get(sector);
}

/** Human-readable district label for the audit sheet, e.g. "D14 — Geylang, Eunos". */
export function districtLabel(district: number | undefined): string {
  if (!district) return '';
  const name = DISTRICT_NAMES[district];
  return name ? `D${district} — ${name}` : `D${district}`;
}
