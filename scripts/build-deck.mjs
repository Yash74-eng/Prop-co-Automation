/**
 * Build a .pptx from the captured screenshots.
 *
 * Uses pptxgenjs rather than PowerPoint COM: Office is unactivated on this machine, so
 * PowerPoint opens a file, accepts every instruction, and then blocks forever on save —
 * the same wall the mail merge hits when asked for a PDF.
 *
 * An earlier version of this script wrote the OOXML by hand. It produced a package that
 * passed every structural check I could think of — valid zip, [Content_Types].xml first,
 * no directory entries, no broken relationships, all XML well-formed — and PowerPoint
 * still refused it with 0x80070570, "the file is corrupted and unreadable". That error
 * says nothing about which part is wrong, so the cost of finding out exceeded the cost of
 * taking a library that is already known to produce files PowerPoint accepts.
 *
 *   npx tsx scripts/build-deck.mjs <shots-dir> <out.pptx>
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.argv[2] ?? 'deck-shots';
const OUT = process.argv[3] ?? 'PropCo Outreach Automation.pptx';

const INK = '1A1A18';
const SOFT = '3D3A34';
const MUTED = '5B564C';
const ACCENT = '8C3A1E';
const CREAM = 'F4F1EA';
const LINE = 'D8D2C4';

/** PNG dimensions, straight out of the IHDR chunk, to keep the aspect ratio honest. */
const pngSize = (buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

const SLIDES = [
  {
    file: '01-channel.png',
    title: 'One deliverable per run',
    body: 'Lawyer letters or postcards — never both. That one choice drives the columns, the sheets, and whether pricing is calculated, so the workbook that comes out holds nothing you did not ask for.',
  },
  {
    file: '02-upload.png',
    title: 'The tracker, read and checked',
    body: 'Uploaded, or pulled live from Google Sheets. Every column is mapped and reported before anything runs — a header the tool cannot find is named on screen rather than quietly ignored.',
  },
  {
    file: '03-configure.png',
    title: 'Every setting says what it does',
    body: 'No jargon, no unexplained numbers. Each control spells out the effect of the value currently set — which owners get skipped, and how the envelope will be addressed.',
  },
  {
    file: '04-picker.png',
    title: 'Filter the outreach column like a spreadsheet',
    body: 'Presets for the common cases, or open the column itself: every value actually present, with counts, ticked one by one. "Batch 3" can be included without "Batch 4", which no category filter can do.',
  },
  {
    file: '05-review.png',
    title: 'Nothing disappears quietly',
    body: 'Source rows down to recipients, counted at every stage, with a reason recorded for each row dropped. Merge decisions and judgement calls each get their own sheet in the workbook.',
  },
  {
    file: '06-verify.png',
    title: 'Two independent checks before anything is posted',
    body: 'Registered addresses verified against ACRA open data, and Claude reads every finished row for malformed addresses, institutions and implausible prices. Neither edits the sheet — both report.',
  },
  {
    file: '07-merge.png',
    title: 'From approved sheet to PDFs',
    body: 'The Word template is checked against the sheet actually being sent, one PDF is proved before committing to the run, then the rest export and download as a zip.',
  },
];

const CLOSING = [
  'One deliverable per run — no unused sheets to sift through',
  'Every dropped row logged with a reason, on its own sheet',
  'Addresses checked against ACRA; every row read by Claude',
  'Comps and pricing from one agreed formula, not a meeting',
  'Runs on one machine — owner data never leaves it',
];

const PptxGenJS = (await import('pptxgenjs')).default;
const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_16x9';
pptx.title = 'PropCo Outreach Automation';
pptx.company = 'Figment';

/* ------------------------------------------------------------------ title slide -- */

const title = pptx.addSlide();
title.background = { color: CREAM };
title.addText('PropCo Outreach Automation', {
  x: 1.1, y: 2.0, w: 10, h: 0.9,
  fontSize: 40, bold: true, color: INK, fontFace: 'Calibri',
});
title.addText('Dealflow tracker to print-ready letters and postcards', {
  x: 1.1, y: 2.95, w: 10, h: 0.5,
  fontSize: 18, color: MUTED, fontFace: 'Calibri',
});
title.addText('Figment · internal tool · runs entirely on one machine', {
  x: 1.1, y: 5.9, w: 10, h: 0.4,
  fontSize: 12, color: ACCENT, fontFace: 'Calibri',
});

/* ------------------------------------------------------------ one per screenshot -- */

const present = new Set(readdirSync(SHOTS).filter((f) => f.endsWith('.png')));
let n = 0;

for (const s of SLIDES) {
  const path = join(SHOTS, s.file);
  if (!present.has(s.file) || !existsSync(path)) {
    console.log(`  skipped (missing): ${s.file}`);
    continue;
  }
  n++;

  // Fit the image inside a box, preserving its aspect ratio. pptxgenjs has a `sizing`
  // option for this, but computing it here keeps the placement predictable.
  const { width, height } = pngSize(readFileSync(path));
  const boxX = 5.15;
  const boxY = 0.5;
  const boxW = 6.55;
  const boxH = 5.9;
  const scale = Math.min(boxW / width, boxH / height);
  const w = width * scale;
  const h = height * scale;

  const slide = pptx.addSlide();
  slide.background = { color: 'FFFFFF' };
  slide.addText(`STEP ${n} OF ${SLIDES.length}`, {
    x: 0.85, y: 0.78, w: 3.9, h: 0.3,
    fontSize: 11, bold: true, color: ACCENT, charSpacing: 1, fontFace: 'Calibri',
  });
  slide.addText(s.title, {
    x: 0.85, y: 1.15, w: 3.95, h: 1.5,
    fontSize: 24, bold: true, color: INK, valign: 'top', fontFace: 'Calibri',
  });
  slide.addText(s.body, {
    x: 0.85, y: 2.75, w: 3.95, h: 3.0,
    fontSize: 13, color: SOFT, valign: 'top', lineSpacingMultiple: 1.25, fontFace: 'Calibri',
  });
  slide.addImage({
    path,
    x: boxX + (boxW - w) / 2,
    y: boxY + (boxH - h) / 2,
    w,
    h,
    // A hairline keeps a white screenshot from bleeding into a white slide.
    line: { color: LINE, width: 0.75 },
  });

  console.log(`  slide ${n + 1}: ${s.file} (${width}x${height} -> ${w.toFixed(2)}x${h.toFixed(2)}in)`);
}

/* ---------------------------------------------------------------- closing slide -- */

const close = pptx.addSlide();
close.background = { color: CREAM };
close.addText('What it changes', {
  x: 1.1, y: 1.0, w: 10, h: 0.8,
  fontSize: 30, bold: true, color: INK, fontFace: 'Calibri',
});
close.addText(
  CLOSING.map((text) => ({ text, options: { bullet: { characterCode: '2014' }, breakLine: true } })),
  {
    x: 1.1, y: 2.1, w: 10, h: 3.6,
    fontSize: 15, color: SOFT, paraSpaceAfter: 14, fontFace: 'Calibri',
  },
);

await pptx.writeFile({ fileName: OUT });
const bytes = readFileSync(OUT).length;
console.log(`\n${n + 2} slides -> ${OUT}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
