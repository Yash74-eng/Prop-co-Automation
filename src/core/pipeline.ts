/**
 * The outreach pipeline: Main Database rows in, mail-merge-ready rows out.
 *
 * Stages, in order:
 *   1. Outreach filter        — "Lawyer Letter Outreach" / "Postcard Outreach Date"
 *   2. Suppression            — user-uploaded compset / do-not-contact list
 *   3. Explode owners         — one row per (property, owner slot)
 *   4. Owner-level exclusions — blank names, strata placeholders, agencies, developers,
 *                               owners holding more than N properties
 *   5. De-duplicate           — two-stage merge (see dedupe.ts)
 *   6. Comps + pricing        — Lawyer Letter Comps Benchmarks, with psf fallback
 *   7. Emit rows              — Lawyer Letter A..V, or the Postcard sheets
 *
 * Every drop is recorded in `exclusions` with a reason, and every judgement call in
 * `flags`, so nothing disappears silently.
 */
import {
  AppliedAddressOverride,
  ExclusionRecord,
  LawyerLetterRow,
  OwnerRow,
  PipelineOptions,
  PipelineResult,
  PipelineWarning,
  PostcardRow,
  ReviewFlag,
  SourceRow,
} from './types.js';
import { classifyOutreach, outreachValue } from './mainDatabase.js';
import {
  cleanPrintable,
  isStrataPlaceholder,
  looksOverseas,
  mailingAddressKey,
  parseAddress,
} from './address.js';
import { classifyName, DEFAULT_INSTITUTIONS_TO_AVOID, DEVELOPER_NAMES } from './names.js';
import { buildDuplicateIndex, buildOwnerNoColumn, dedupe } from './dedupe.js';
import { CompsIndex, lookupComps } from './comps.js';
import { defaultCompSelection, selectComps } from '../comps/marketWatch.js';
import { defaultPricing, priceFromComps } from '../comps/pricing.js';
import { addDays, formatDate, normKey, squash, uniq } from './text.js';

export interface PipelineDependencies {
  institutions?: { name: string; status: string; remarks?: string }[];
  developerNames?: string[];
  neighbourhoodOverrides?: Record<string, string>;
}

export function defaultOptions(
  channel: PipelineOptions['channel'],
  overrides: Partial<PipelineOptions> = {},
): PipelineOptions {
  return {
    channel,
    mailDate: new Date(),
    validityDays: 14,
    // Everyone by default. "exclude-contacted" keeps only rows whose outreach column is
    // blank, which silently drops the whole sheet when the tracker tags rows with a batch
    // name — 274 source rows, 0 recipients, and nothing obviously wrong. Opt-outs are
    // still removed: `all` means every row we are permitted to contact, not literally all.
    outreachFilter: { mode: 'all', alwaysExcludeOptOut: true },
    maxPropertiesPerOwner: 5,
    maxOwnersBeforeCollapse: 4,
    maxOwnerNameLength: 120,
    removeAgenciesAndDevelopers: true,
    groupByOwnerName: false,
    includeAuditSheets: true,
    suppressionList: [],
    suppressedOwnerNames: [],
    comps: [],
    deriveMissingPrices: true,
    derivedHigherMultiplier: 1.125,
    derivedRounding: 250_000,
    ...overrides,
  };
}

export function runPipeline(
  sourceRows: SourceRow[],
  options: PipelineOptions,
  deps: PipelineDependencies = {},
): PipelineResult {
  const exclusions: ExclusionRecord[] = [];
  const flags: ReviewFlag[] = [];
  const warnings: PipelineWarning[] = [];
  const stats: Record<string, number> = { sourceRows: sourceRows.length };

  const institutions = deps.institutions ?? DEFAULT_INSTITUTIONS_TO_AVOID;
  const developerNames = deps.developerNames ?? DEVELOPER_NAMES;

  // ---- Stage 1: outreach filter -------------------------------------------------
  const afterOutreach: SourceRow[] = [];
  const outreachCounts: Record<string, number> = {};
  for (const row of sourceRows) {
    const cls = classifyOutreach(outreachValue(row, options.channel));
    outreachCounts[cls.status] = (outreachCounts[cls.status] ?? 0) + 1;

    if (options.outreachFilter.alwaysExcludeOptOut && (cls.status === 'opt-out' || cls.status === 'do-not-send')) {
      exclusions.push({
        sourceRow: row.sourceRow,
        addressId: row.addressId,
        address: row.address,
        stage: 'outreach-filter',
        reason: cls.status === 'opt-out' ? 'Owner opted out' : 'Marked do not send',
        detail: cls.text,
      });
      continue;
    }

    // Exact values win over everything: the operator picked these from a list of what is
    // actually in their column, so there is nothing left to infer.
    const includeValues = options.outreachFilter.includeValues;
    if (includeValues?.length) {
      const wanted = new Set(includeValues.map((v) => normKey(v)));
      if (!wanted.has(normKey(cls.text))) {
        exclusions.push({
          sourceRow: row.sourceRow,
          addressId: row.addressId,
          address: row.address,
          stage: 'outreach-filter',
          reason: `Outreach value "${cls.text || '(blank)'}" was not selected`,
          detail: cls.text || '(blank)',
        });
        continue;
      }
      afterOutreach.push(row);
      continue;
    }

    // An explicit list of states wins over the preset: it says what is wanted instead of
    // naming a mode whose meaning has to be looked up.
    const include = options.outreachFilter.include;
    if (include?.length) {
      if (!include.includes(cls.status)) {
        exclusions.push({
          sourceRow: row.sourceRow,
          addressId: row.addressId,
          address: row.address,
          stage: 'outreach-filter',
          reason: `Outreach state "${cls.status}" was not selected`,
          detail: cls.text || '(blank)',
        });
        continue;
      }
      afterOutreach.push(row);
      continue;
    }

    let keep: boolean;
    switch (options.outreachFilter.mode) {
      case 'exclude-contacted':
        keep = cls.status === 'blank';
        break;
      case 'only-tagged':
        keep = cls.status !== 'blank';
        break;
      case 'match': {
        const needle = (options.outreachFilter.matchText ?? '').toLowerCase();
        keep = !!needle && cls.text.toLowerCase().includes(needle);
        break;
      }
      case 'all':
      default:
        keep = true;
    }

    if (!keep) {
      exclusions.push({
        sourceRow: row.sourceRow,
        addressId: row.addressId,
        address: row.address,
        stage: 'outreach-filter',
        reason: `Filtered by outreach mode "${options.outreachFilter.mode}"`,
        detail: cls.text || '(blank)',
      });
      continue;
    }
    afterOutreach.push(row);
  }
  stats.afterOutreachFilter = afterOutreach.length;
  for (const [status, count] of Object.entries(outreachCounts)) {
    stats[`outreach_${status}`] = count;
  }

  // ---- Stage 2: suppression list -------------------------------------------------
  const suppressedPostals = new Set(
    options.suppressionList.map((s) => (s.postal ?? '').replace(/\D/g, '')).filter(Boolean),
  );
  const suppressedAddressKeys = new Set(
    options.suppressionList
      .map((s) => normKey(stripPostal(s.address ?? '')))
      .filter((k) => k.length > 6),
  );
  const suppressedOwners = new Set(
    [...options.suppressedOwnerNames, ...options.suppressionList.map((s) => s.ownerName ?? '')]
      .map(normKey)
      .filter(Boolean),
  );

  const afterSuppression: SourceRow[] = [];
  for (const row of afterOutreach) {
    const parsed = parseAddress(row.address);
    const postal = row.postalCode || parsed.postal;
    const addrKey = normKey(`${parsed.numbers.join(' ')} ${parsed.street}`);
    const hitPostal = postal && suppressedPostals.has(postal);
    const hitAddress = addrKey && suppressedAddressKeys.has(addrKey);
    if (hitPostal || hitAddress) {
      exclusions.push({
        sourceRow: row.sourceRow,
        addressId: row.addressId,
        address: row.address,
        stage: 'suppression',
        reason: 'On the uploaded suppression / compset list',
        detail: hitPostal ? `postal ${postal}` : `address ${addrKey}`,
      });
      continue;
    }
    afterSuppression.push(row);
  }
  stats.afterSuppression = afterSuppression.length;

  // ---- Stage 3: explode owners ---------------------------------------------------
  const exploded: OwnerRow[] = [];
  const appliedOverrides: AppliedAddressOverride[] = [];
  for (const row of afterSuppression) {
    const property = parseAddress(row.address);
    if (property.unparsed) {
      flags.push({
        sourceRow: row.sourceRow,
        address: row.address,
        flag: 'Address could not be fully parsed',
        detail: 'Passed through verbatim — check the merged address before sending',
        severity: 'warn',
      });
    }

    const namedOwners = row.owners.filter((o) => squash(o.name));
    if (namedOwners.length === 0) {
      exclusions.push({
        sourceRow: row.sourceRow,
        addressId: row.addressId,
        address: row.address,
        stage: 'owner-explode',
        reason: 'Owner Name is blank',
      });
      continue;
    }

    for (const owner of namedOwners) {
      // Scrub before classifying. A company name pasted off a website arrives as
      // "SOMEWHERE™ PTE LTD" and would otherwise print that way on the envelope; a
      // zero-width character in one copy of a name also splits one owner into two.
      const scrubbedName = cleanPrintable(owner.name);
      const cls = classifyName(scrubbedName.text, { institutions, developerNames });
      const notes: string[] = [];
      if (scrubbedName.removed.length) {
        flags.push({
          sourceRow: row.sourceRow,
          address: row.address,
          ownerName: scrubbedName.text,
          flag: 'Owner name contained characters that cannot be printed',
          detail: `Removed: ${scrubbedName.removed.join(', ')}. Now reads "${scrubbedName.text}"`,
          severity: 'warn',
        });
      }

      if (cls.isStrataPlaceholder) {
        exclusions.push({
          sourceRow: row.sourceRow,
          addressId: row.addressId,
          address: row.address,
          ownerName: squash(owner.name),
          stage: 'owner-explode',
          reason: 'Strata placeholder owner name',
          detail: 'Title search returned the strata-lot boilerplate instead of a proprietor',
        });
        continue;
      }
      if (!cls.cleaned) {
        exclusions.push({
          sourceRow: row.sourceRow,
          addressId: row.addressId,
          address: row.address,
          ownerName: squash(owner.name),
          stage: 'owner-explode',
          reason: 'Owner name empty after cleaning',
        });
        continue;
      }

      if (cls.alias) notes.push(`Alias removed: ${cls.alias}`);
      if (cls.declaredOwnerCount) {
        notes.push(`Source cell declares ${cls.declaredOwnerCount} owners`);
      }
      if (cls.possibleMultiName) {
        flags.push({
          sourceRow: row.sourceRow,
          address: row.address,
          ownerName: squash(owner.name),
          flag: 'Owner cell may contain more than one name',
          detail: 'Not split automatically — confirm whether these are separate owners',
          severity: 'warn',
        });
      }

      // A corrected address has to be applied here, before dedupe: merging keys on the
      // mailing address, so patching the finished sheet would leave the groups wrong.
      //
      // Scrub printing junk at the same point and for the same reason: the mailing
      // address is a dedupe key, so a trademark mark or a zero-width character in one
      // copy of an address splits a recipient into two letters.
      const scrubbedAddress = cleanPrintable(owner.address);
      const originalAddress = scrubbedAddress.text;
      if (scrubbedAddress.removed.length) {
        flags.push({
          sourceRow: row.sourceRow,
          address: row.address,
          ownerName: squash(owner.name),
          flag: 'Mailing address contained characters that cannot be printed',
          detail: `Removed: ${scrubbedAddress.removed.join(', ')}. Now reads "${originalAddress}"`,
          severity: 'warn',
        });
      }
      if (property.scrubbed?.length) {
        flags.push({
          sourceRow: row.sourceRow,
          address: row.address,
          ownerName: squash(owner.name),
          flag: 'Property address contained characters that cannot be printed',
          detail: `Removed: ${property.scrubbed.join(', ')}. Now reads "${property.raw}"`,
          severity: 'warn',
        });
      }
      const override =
        options.ownerAddressOverrides?.[normKey(cls.cleaned)] ??
        options.ownerAddressOverrides?.[normKey(squash(owner.name))];
      const effectiveAddress = override?.address ? squash(override.address) : originalAddress;
      if (override?.address && normKey(effectiveAddress) !== normKey(originalAddress)) {
        appliedOverrides.push({
          ownerName: cls.cleaned,
          sourceRow: String(row.sourceRow),
          previousAddress: originalAddress,
          newAddress: effectiveAddress,
          source: override.source,
        });
        notes.push(`Mailing address replaced from ${override.source}`);
      }

      exploded.push({
        sourceRow: row.sourceRow,
        ownerSlot: owner.slot,
        target: row.target ?? '',
        neighbourhood: row.neighbourhood ?? '',
        landUse: row.landUse ?? '',
        tenure: row.tenure ?? '',
        ownerName: cls.cleaned,
        ownerNameRaw: squash(owner.name),
        ownerAddress: effectiveAddress,
        ownerAddressRaw: originalAddress,
        property,
        gfaSqft: row.gfaSqft,
        benchmarkPsf: row.benchmarkPsf,
        addressId: row.addressId,
        contactPerson: row.contactPerson,
        contactNoOrEmail: row.contactNoOrEmail,
        isCorporate: cls.isCorporate,
        declaredOwnerCount: cls.declaredOwnerCount,
        notes,
      });
    }
  }
  stats.ownerRowsExploded = exploded.length;

  // ---- Stage 4: owner-level exclusions -------------------------------------------
  // Property counts are computed across every owner row that survived the earlier
  // stages, so "more than 5 properties" reflects the working set, not the raw sheet.
  const propertiesByOwner = new Map<string, Set<string>>();
  for (const r of exploded) {
    const k = normKey(r.ownerName);
    if (!k) continue;
    if (!propertiesByOwner.has(k)) propertiesByOwner.set(k, new Set());
    propertiesByOwner.get(k)!.add(r.property.postal || normKey(r.property.raw));
  }

  const kept: OwnerRow[] = [];
  for (const r of exploded) {
    const cls = classifyName(r.ownerNameRaw, { institutions, developerNames });
    const drop = (reason: string, detail?: string) => {
      exclusions.push({
        sourceRow: r.sourceRow,
        addressId: r.addressId,
        address: r.property.raw,
        ownerName: r.ownerName,
        stage: 'owner-filter',
        reason,
        detail,
      });
    };

    if (!r.ownerAddress) {
      drop('Owner Address is blank', 'Cannot address an envelope without a mailing address');
      continue;
    }
    if (isStrataPlaceholder(r.ownerAddress)) {
      drop(
        'Strata placeholder address',
        'Owner Address is the strata-lot boilerplate, not a mailable address',
      );
      continue;
    }
    if (suppressedOwners.has(normKey(r.ownerName))) {
      drop('Owner is on the uploaded suppression list');
      continue;
    }
    if (options.removeAgenciesAndDevelopers && cls.agencyMatch) {
      drop('Agency / association / statutory body', `matched /${cls.agencyMatch}/`);
      continue;
    }
    if (options.removeAgenciesAndDevelopers && cls.developerMatch) {
      drop('Large property developer', cls.developerMatch);
      continue;
    }

    const count = propertiesByOwner.get(normKey(r.ownerName))?.size ?? 0;
    if (count > options.maxPropertiesPerOwner) {
      drop(
        `Owner holds more than ${options.maxPropertiesPerOwner} properties`,
        `${r.ownerName} — ${count} properties in this working set`,
      );
      continue;
    }

    // Comment-only signals — these never remove a row.
    if (cls.institutionMatch) {
      r.notes.push(
        `INSTITUTION TO AVOID: ${cls.institutionMatch.name} (${cls.institutionMatch.status})${
          cls.institutionMatch.remarks ? ` — ${cls.institutionMatch.remarks}` : ''
        }`,
      );
      flags.push({
        sourceRow: r.sourceRow,
        address: r.property.raw,
        ownerName: r.ownerName,
        flag: 'Institution / competitor to avoid',
        detail: `${cls.institutionMatch.name} (${cls.institutionMatch.status}) — flagged only, not removed`,
        severity: 'error',
      });
    }
    if (cls.reviewMatch) {
      r.notes.push('Corporate-sounding owner name — review before sending');
      flags.push({
        sourceRow: r.sourceRow,
        address: r.property.raw,
        ownerName: r.ownerName,
        flag: 'Possible agency / holding company',
        detail: `matched /${cls.reviewMatch}/ — kept, review manually`,
        severity: 'info',
      });
    }
    if (looksOverseas(r.ownerAddress)) {
      r.notes.push('Mailing address has no Singapore postal code');
      flags.push({
        sourceRow: r.sourceRow,
        address: r.property.raw,
        ownerName: r.ownerName,
        flag: 'Overseas or incomplete mailing address',
        detail: r.ownerAddress,
        severity: 'warn',
      });
    }

    kept.push(r);
  }
  stats.ownerRowsKept = kept.length;

  // ---- Stage 5: de-duplicate ------------------------------------------------------
  const { groups, audit } = dedupe(kept, {
    maxOwnersBeforeCollapse: options.maxOwnersBeforeCollapse,
    maxOwnerNameLength: options.maxOwnerNameLength,
    groupByOwnerName: options.groupByOwnerName,
  });
  stats.recipients = groups.length;
  stats.mergeOperations = audit.length;

  const duplicateIndex = buildDuplicateIndex(groups);
  const ownerNos = buildOwnerNoColumn(
    groups.map((g) => ({
      registeredProprietor: g.registeredProprietor,
      mailingAddress: g.mailingAddress,
    })),
  );

  // ---- Stage 6 + 7: comps and output rows ----------------------------------------
  const compsIndex = new CompsIndex(options.comps);
  const lawyerLetterRows: LawyerLetterRow[] = [];
  const postcardRows: PostcardRow[] = [];
  const validDate = (mail: Date) => addDays(mail, options.validityDays);

  let derivedCount = 0;
  let noPriceCount = 0;
  const unmappedNeighbourhoods = new Set<string>();

  groups.forEach((group, i) => {
    const comments: string[] = [...group.notes];

    if (options.channel === 'lawyer-letter' && options.transactions?.length) {
      // Transactions sheet supplied: pick comps from this property's own district.
      const gfa = maxDefined(group.members.map((m) => m.gfaSqft));
      const selection = selectComps(
        options.transactions,
        { postalCode: group.fullAddress },
        options.compSelection ?? defaultCompSelection(),
        options.mailDate,
      );
      const priced = priceFromComps(selection.comps, { gfaSqft: gfa }, options.pricing ?? defaultPricing());

      if (selection.comps.length === 0) {
        noPriceCount++;
        flags.push({
          sourceRow: group.members.map((m) => m.sourceRow).join(', '),
          address: group.fullAddress,
          ownerName: group.registeredProprietor,
          flag: 'No comparable transactions',
          detail: selection.notes.join(' | '),
          severity: 'error',
        });
      }
      comments.push(priced.basis, ...selection.notes);

      const [c1, c2] = selection.comps;
      lawyerLetterRows.push({
        Comments: uniq(comments).join(' | '),
        'Owner No.': ownerNos[i] ?? '',
        Target: group.target,
        Address: group.address,
        Full_Address: group.fullAddress,
        Neighbourhood: group.neighbourhood,
        'Land Use': group.landUse,
        Mail_Date: options.mailDate,
        Valid_Date: validDate(options.mailDate),
        Registered_Proprietor: group.registeredProprietor,
        Registered_Proprietor_mailing_address: group.mailingAddress,
        'Duplicate Owner / Owner Addresses': duplicateIndex.get(group.key) ?? 'unique',
        minimum_Price: priced.minimumPrice ?? '',
        higher_Price: priced.higherPrice ?? '',
        Comp_Address_1: c1?.address ?? '',
        Comp_1: c1?.price ?? '',
        Comp_1_Date: c1?.date ?? '',
        Comp_Address_2: c2?.address ?? '',
        Comp_2: c2?.price ?? '',
        Comp_2_Date: c2?.date ?? '',
        Status: '',
        'Date Responded': '',
      });
    } else if (options.channel === 'lawyer-letter') {
      const first = group.members[0];
      const gfa = maxDefined(group.members.map((m) => m.gfaSqft));
      const psf = maxDefined(group.members.map((m) => m.benchmarkPsf));
      const comps = lookupComps(
        compsIndex,
        {
          neighbourhood: group.neighbourhood,
          landUse: group.landUse,
          tenure: group.tenure || first.tenure,
          gfaSqft: gfa,
          benchmarkPsf: psf,
        },
        {
          deriveMissingPrices: options.deriveMissingPrices,
          derivedHigherMultiplier: options.derivedHigherMultiplier,
          derivedRounding: options.derivedRounding,
          neighbourhoodOverrides: deps.neighbourhoodOverrides,
        },
      );

      if (comps.source === 'derived-from-psf') derivedCount++;
      if (comps.source === 'none') {
        noPriceCount++;
        flags.push({
          sourceRow: group.members.map((m) => m.sourceRow).join(', '),
          address: group.fullAddress,
          ownerName: group.registeredProprietor,
          flag: 'No indicative price',
          detail: comps.notes.join(' | '),
          severity: 'error',
        });
      }
      if (!comps.resolved.neighbourhood && group.neighbourhood) {
        unmappedNeighbourhoods.add(group.neighbourhood);
      }
      comments.push(...comps.notes);

      lawyerLetterRows.push({
        Comments: uniq(comments).join(' | '),
        'Owner No.': ownerNos[i] ?? '',
        Target: group.target,
        Address: group.address,
        Full_Address: group.fullAddress,
        Neighbourhood: group.neighbourhood,
        'Land Use': group.landUse,
        Mail_Date: options.mailDate,
        Valid_Date: validDate(options.mailDate),
        Registered_Proprietor: group.registeredProprietor,
        Registered_Proprietor_mailing_address: group.mailingAddress,
        'Duplicate Owner / Owner Addresses': duplicateIndex.get(group.key) ?? 'unique',
        minimum_Price: comps.minimumPrice ?? '',
        higher_Price: comps.higherPrice ?? '',
        Comp_Address_1: comps.record?.compAddress1 ?? '',
        Comp_1: comps.record?.comp1 ?? '',
        Comp_1_Date: comps.record?.comp1Date ?? '',
        Comp_Address_2: comps.record?.compAddress2 ?? '',
        Comp_2: comps.record?.comp2 ?? '',
        Comp_2_Date: comps.record?.comp2Date ?? '',
        Status: '',
        'Date Responded': '',
      });
    } else {
      const contactName = firstDefined(group.members.map((m) => m.contactPerson));
      const contactNumber = firstDefined(group.members.map((m) => m.contactNoOrEmail));
      postcardRows.push({
        Target: group.target,
        Address: group.address,
        'Full Address': group.fullAddress,
        Neighbourhood: group.neighbourhood,
        'Land Use': group.landUse,
        'Owner Name': group.registeredProprietor,
        'Owner Address': group.mailingAddress,
        Checking: uniq(comments).join(' | '),
        'Contact Name': contactName ?? '',
        'Contact Number': contactNumber ?? '',
        Status: '',
        'Updated Date': formatDate(options.mailDate),
      });
    }
  });

  if (derivedCount > 0) {
    warnings.push({
      scope: 'pricing',
      message:
        'Rows priced from GFA x neighbourhood psf because no comps benchmark row matched. Verify before mail merge.',
      count: derivedCount,
    });
  }
  if (noPriceCount > 0) {
    warnings.push({
      scope: 'pricing',
      message: 'Rows with no indicative price at all — minimum_Price / higher_Price are blank.',
      count: noPriceCount,
    });
  }
  if (unmappedNeighbourhoods.size > 0) {
    warnings.push({
      scope: 'comps-mapping',
      message:
        'Neighbourhoods with no comps-benchmark mapping. Add them to the comps table or the neighbourhood override config.',
      count: unmappedNeighbourhoods.size,
      samples: [...unmappedNeighbourhoods].sort(),
    });
  }

  stats.lawyerLetterRows = lawyerLetterRows.length;
  stats.postcardRows = postcardRows.length;
  stats.exclusions = exclusions.length;
  stats.flags = flags.length;

  return {
    channel: options.channel,
    options,
    sourceRowCount: sourceRows.length,
    lawyerLetterRows,
    postcardRows,
    ownerRows: kept,
    groups,
    exclusions,
    flags,
    warnings,
    stats,
    appliedAddressOverrides: appliedOverrides,
    // Attached for the audit sheet writer.
    ...({ dedupeAudit: audit } as object),
  } as PipelineResult & { dedupeAudit: typeof audit };
}

function stripPostal(address: string): string {
  return address.replace(/\bSINGAPORE\b/gi, ' ').replace(/\b\d{6}\b/g, ' ');
}

function maxDefined(values: (number | undefined)[]): number | undefined {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? Math.max(...nums) : undefined;
}

function firstDefined(values: (string | undefined)[]): string | undefined {
  return values.find((v) => squash(v));
}

/** Mail-merge field names the Word templates expect, in sheet order. */
export const LAWYER_LETTER_HEADERS: (keyof LawyerLetterRow)[] = [
  'Comments',
  'Owner No.',
  'Target',
  'Address',
  'Full_Address',
  'Neighbourhood',
  'Land Use',
  'Mail_Date',
  'Valid_Date',
  'Registered_Proprietor',
  'Registered_Proprietor_mailing_address',
  'Duplicate Owner / Owner Addresses',
  'minimum_Price',
  'higher_Price',
  'Comp_Address_1',
  'Comp_1',
  'Comp_1_Date',
  'Comp_Address_2',
  'Comp_2',
  'Comp_2_Date',
  'Status',
  'Date Responded',
];

export const POSTCARD_HEADERS: (keyof PostcardRow)[] = [
  'Target',
  'Address',
  'Full Address',
  'Neighbourhood',
  'Land Use',
  'Owner Name',
  'Owner Address',
  'Checking',
  'Contact Name',
  'Contact Number',
  'Status',
  'Updated Date',
];
