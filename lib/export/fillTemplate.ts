/**
 * Fill the REAL official UNDRR Preliminary .xlsm.
 *
 * The official tool stores each answer as a single integer in column E of the
 * per-Essential sheets (E01…E10): `E{headerRow+4}` holds 1–4, and the score is
 * `4 − that value` (so score 3 → 1, score 0 → 4). The four visible checkboxes
 * and every total are FORMULAS that read that one cell, so we only need to set
 * the integer and let Excel recalculate.
 *
 * To keep the file looking and behaving exactly like the original (styles,
 * charts, macros/VBA, every sheet), we do NOT rebuild the workbook. We open the
 * .xlsm as a zip, edit only the handful of target cells inside the relevant
 * sheet XML, force a full recalc on open, and copy every other zip entry byte
 * for byte. No third-party zip library is needed — the browser's built-in
 * DecompressionStream handles the one thing we must read.
 */

import * as XLSX from "xlsx";
import type { Draft } from "@/lib/agent/draft";

export interface CellEdit {
  ref: string;
  value: number | string;
  keepFormula?: boolean;
}

/** City-information fields written to the official template's "Info" sheet. */
export interface TemplateInfo {
  city?: string;
  country?: string;
  typeOfCity?: string;
  date?: string;
  authorityTitle?: string;
  population?: number;
  areaKm2?: number;
  density?: number;
  youthPct?: number;
  seniorPct?: number;
  femaleHeadedPct?: number;
  literacyPct?: number;
  povertyPct?: number;
  incomeUsd?: number;
  nonCitizenPct?: number;
  mostLikelyHazard?: string;
  mostSevereHazard?: string;
}

// ── Work out which cells to set, from the draft ──────────────
const HDR = /^(P\d+\.\d+)\b/i;

export function computeTemplateEdits(
  buf: ArrayBuffer,
  draft: Draft,
  info?: TemplateInfo
): Map<string, CellEdit[]> {
  const wb = XLSX.read(buf, { type: "array" });
  const edits = new Map<string, CellEdit[]>();
  const push = (sheet: string, ref: string, value: number | string, keepFormula?: boolean) => {
    if (!edits.has(sheet)) edits.set(sheet, []);
    edits.get(sheet)!.push({ ref, value, keepFormula });
  };

  // ── City Information sheet ("Info") ──
  // The top "This Assessment" block merges its label across B:C, so the value
  // goes in column D. The "City Profile" block below is not merged; its values
  // sit in column C. (Verified against a real completed scorecard.)
  if (info) {
    const infoCells: Array<[string, string | number | undefined]> = [
      ["D4", info.city],
      ["D5", info.typeOfCity],
      ["D6", info.country],
      ["D7", info.date],
      ["C10", info.authorityTitle],
      ["C11", info.population],
      ["C12", info.areaKm2],
      ["C13", info.density],
      ["C14", info.youthPct],
      ["C15", info.seniorPct],
      ["C16", info.femaleHeadedPct],
      ["C17", info.literacyPct],
      ["C18", info.povertyPct],
      ["C19", info.incomeUsd],
      ["C20", info.nonCitizenPct],
      ["C21", info.mostLikelyHazard],
      ["C22", info.mostSevereHazard],
    ];
    for (const [ref, val] of infoCells) {
      if (val === undefined || val === null || val === "") continue;
      push("Info", ref, val, false);
    }
  }

  for (const name of wb.SheetNames) {
    if (!/^E\d+$/i.test(name)) continue;
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= Math.min(range.s.c + 3, range.e.c); c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        const s = cell ? (cell.w ?? cell.v) : undefined;
        if (typeof s !== "string") continue;
        const m = s.trim().match(HDR);
        if (!m) continue;
        const code = m[1].toUpperCase();
        const entry = draft[code];
        if (entry && entry.score != null) {
          const answerRow = r + 4; // 0-based header row → integer cell 4 rows below
          const idx = 4 - entry.score; // 1..4
          push(name, XLSX.utils.encode_cell({ r: answerRow, c: 4 }), idx, false); // col E
          // Cached one-hot for the four checkbox formulas (col F), so the file
          // also reads correctly if re-opened without a recalc.
          for (let k = 0; k < 4; k++) {
            push(name, XLSX.utils.encode_cell({ r: answerRow + k, c: 5 }), k === idx - 1 ? 1 : 0, true);
          }
        }
        break;
      }
    }
  }

  // Results summary: cache the 0-3 score next to each code (first occurrence).
  const res = wb.Sheets["Results"];
  if (res && res["!ref"]) {
    const range = XLSX.utils.decode_range(res["!ref"]);
    const seen = new Set<string>();
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= Math.min(range.s.c + 4, range.e.c); c++) {
        const cell = res[XLSX.utils.encode_cell({ r, c })];
        const s = cell ? (cell.w ?? cell.v) : undefined;
        if (typeof s !== "string") continue;
        const m = s.trim().match(/^(P\d+\.\d+)$/i);
        if (!m) continue;
        const code = m[1].toUpperCase();
        if (!seen.has(code)) {
          seen.add(code);
          const entry = draft[code];
          if (entry && entry.score != null) {
            push("Results", XLSX.utils.encode_cell({ r, c: 6 }), entry.score, true); // col G
          }
        }
        break;
      }
    }
  }
  return edits;
}

// ── CRC32 ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Minimal ZIP read / write ─────────────────────────────────
interface RawEntry {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  compressed: Uint8Array;
}

function u16(dv: DataView, o: number) { return dv.getUint16(o, true); }
function u32(dv: DataView, o: number) { return dv.getUint32(o, true); }

function parseZip(buf: Uint8Array): RawEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // find End Of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsm (no EOCD).");
  const count = u16(dv, eocd + 10);
  let p = u32(dv, eocd + 16); // central dir offset
  const entries: RawEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(dv, p) !== 0x02014b50) break;
    const method = u16(dv, p + 10);
    const crc = u32(dv, p + 16);
    const csize = u32(dv, p + 20);
    const usize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const commentLen = u16(dv, p + 32);
    const localOff = u32(dv, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    // read local header to locate data
    const lNameLen = u16(dv, localOff + 26);
    const lExtraLen = u16(dv, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + csize);
    entries.push({ name, method, crc, csize, usize, compressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function buildZip(entries: RawEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const lh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0, true); // flags (no data descriptor)
    ldv.setUint16(8, e.method, true);
    ldv.setUint16(10, 0, true); // time
    ldv.setUint16(12, 0x21, true); // date (1980-01-01)
    ldv.setUint32(14, e.crc, true);
    ldv.setUint32(18, e.csize, true);
    ldv.setUint32(22, e.usize, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra len
    lh.set(nameBytes, 30);
    locals.push(lh, e.compressed);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(ch.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed
    cdv.setUint16(8, 0, true); // flags
    cdv.setUint16(10, e.method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x21, true);
    cdv.setUint32(16, e.crc, true);
    cdv.setUint32(20, e.csize, true);
    cdv.setUint32(24, e.usize, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true); // local header offset
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + e.compressed.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of centrals) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of locals) { out.set(part, o); o += part.length; }
  for (const part of centrals) { out.set(part, o); o += part.length; }
  out.set(eocd, o);
  return out;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function getText(e: RawEntry): Promise<string> {
  const bytes = e.method === 0 ? e.compressed : await inflateRaw(e.compressed);
  return new TextDecoder().decode(bytes);
}

// ── XML cell editing ─────────────────────────────────────────
function colToNum(ref: string): number {
  const letters = ref.replace(/[0-9]/g, "");
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Insert a brand-new cell (in column order) when the ref is absent.
function insertCellXml(xml: string, ref: string, cellXml: string): string {
  const rowNum = ref.replace(/[A-Z]/g, "");
  const colN = colToNum(ref);
  const rowRe = new RegExp(`(<row r="${rowNum}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rm = xml.match(rowRe);
  if (rm) {
    const body = rm[2];
    const cellTag = /<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
    let insertAt = body.length;
    let cm: RegExpExecArray | null;
    while ((cm = cellTag.exec(body))) {
      if (colToNum(cm[1]) > colN) { insertAt = cm.index; break; }
    }
    const newBody = body.slice(0, insertAt) + cellXml + body.slice(insertAt);
    return xml.replace(rowRe, `${rm[1]}${newBody}${rm[3]}`);
  }
  const rowTag = /<row r="(\d+)"[^>]*>/g;
  let insertAt = -1;
  let rmatch: RegExpExecArray | null;
  while ((rmatch = rowTag.exec(xml))) {
    if (parseInt(rmatch[1], 10) > parseInt(rowNum, 10)) { insertAt = rmatch.index; break; }
  }
  const rowXml = `<row r="${rowNum}">${cellXml}</row>`;
  if (insertAt >= 0) return xml.slice(0, insertAt) + rowXml + xml.slice(insertAt);
  return xml.replace("</sheetData>", `${rowXml}</sheetData>`);
}

function setCellValue(xml: string, ref: string, value: number, keepFormula?: boolean): string {
  const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = xml.match(cellRe);
  if (m) {
    let attrs = (m[1] || "").replace(/\s+t="[^"]*"/g, ""); // numbers carry no type
    const inner = m[2] || "";
    let newInner: string;
    if (keepFormula) {
      const f = inner.match(/<f[\s\S]*?<\/f>|<f[^>]*\/>/);
      newInner = `${f ? f[0] : ""}<v>${value}</v>`;
    } else {
      newInner = `<v>${value}</v>`;
    }
    return xml.replace(cellRe, `<c r="${ref}"${attrs}>${newInner}</c>`);
  }
  return insertCellXml(xml, ref, `<c r="${ref}"><v>${value}</v></c>`);
}

// Write a text cell that references the shared-strings table (t="s"), matching
// how the template itself stores every label — the most universally-read form.
function setSharedCell(xml: string, ref: string, index: number): string {
  const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = xml.match(cellRe);
  if (m) {
    const attrs = (m[1] || "").replace(/\s+t="[^"]*"/g, "");
    return xml.replace(cellRe, `<c r="${ref}"${attrs} t="s"><v>${index}</v></c>`);
  }
  return insertCellXml(xml, ref, `<c r="${ref}" t="s"><v>${index}</v></c>`);
}

function setFullCalc(wbXml: string): string {
  if (/<calcPr[^>]*\/>/.test(wbXml)) {
    return wbXml.replace(/<calcPr([^>]*)\/>/, (full, attrs) => {
      let a = attrs.replace(/\s+fullCalcOnLoad="[^"]*"/g, "");
      return `<calcPr${a} fullCalcOnLoad="1"/>`;
    });
  }
  if (/<\/sheets>/.test(wbXml)) return wbXml.replace("</sheets>", `</sheets><calcPr calcId="0" fullCalcOnLoad="1"/>`);
  return wbXml;
}

// ── Legacy option-button (radio) visual state ────────────────
// Each indicator is a group of Form-Control option buttons. The group's first
// button carries <x:FmlaLink>$E$row</x:FmlaLink>; the buttons appear in option
// order (option 1 = "score 3" … option 4 = "score 0"). Excel shows the SELECTED
// button from its stored <x:Checked>1</x:Checked> flag, so setting the linked E
// cell alone leaves the circles empty. This stamps Checked on the right button
// (position = the E value = 4 − score), exactly as a real Excel fill does.
function applyRadioChecks(vml: string, rowToIdx: Map<number, number>): string {
  const re = /<x:ClientData ObjectType="Radio">[\s\S]*?<\/x:ClientData>/g;
  let curRow: number | null = null;
  let pos = 0;
  return vml.replace(re, (block) => {
    const first = block.includes("<x:FirstButton/>");
    if (first) {
      const m = block.match(/<x:FmlaLink>\$E\$(\d+)<\/x:FmlaLink>/);
      curRow = m ? parseInt(m[1], 10) : null;
      pos = 1;
    } else {
      pos += 1;
    }
    if (curRow == null || !rowToIdx.has(curRow)) return block;
    const wantIdx = rowToIdx.get(curRow)!;
    // Remove any existing Checked, then stamp it on the selected option only.
    // Excel's VML schema is order-sensitive: <x:Checked> must sit right after
    // <x:TextVAlign>, otherwise Excel silently ignores it and the button looks
    // empty. So insert it there rather than at the end of the block.
    let b = block.replace(/\s*<x:Checked>[\s\S]*?<\/x:Checked>/g, "");
    if (pos === wantIdx) {
      if (/<\/x:TextVAlign>/.test(b)) {
        b = b.replace(/(<\/x:TextVAlign>)/, `$1\r\n   <x:Checked>1</x:Checked>`);
      } else {
        // Fallback: before the closing tag (rare, only if TextVAlign is absent).
        b = b.replace("</x:ClientData>", "<x:Checked>1</x:Checked>\r\n  </x:ClientData>");
      }
    }
    return b;
  });
}

// ── Modern option-button state (xl/ctrlProps/*.xml) ──────────
// Modern Excel (2010+) reads a radio's selected state from its ctrlProp's
// `checked` attribute — NOT the legacy VML. Setting only the linked cell leaves
// the dot empty (the conditional-format highlight still moves, which is why a
// filled file used to show "highlighted but not selected"). We group the radios
// geometrically: each Group Box is a rectangle, every radio whose anchor row
// falls inside it belongs to that group, and top-to-bottom order is the option
// index (1 = "score 3" … 4 = "score 0"). This is robust even when a radio is
// stored out of document order (which the real template does). Returns a map of
// ctrlProp path -> new XML with checked="Checked" on the selected button.
const ANCHOR_FROM = /<from>\s*<(?:\w+:)?col>(\d+)<\/(?:\w+:)?col>\s*<(?:\w+:)?colOff>-?\d+<\/(?:\w+:)?colOff>\s*<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/;
const ANCHOR_TO = /<to>\s*<(?:\w+:)?col>\d+<\/(?:\w+:)?col>\s*<(?:\w+:)?colOff>-?\d+<\/(?:\w+:)?colOff>\s*<(?:\w+:)?row>(\d+)<\/(?:\w+:)?row>/;

async function planCtrlPropChecks(
  sheetXml: string,
  relsXml: string,
  rowToIdx: Map<number, number>,
  readCtrlProp: (path: string) => Promise<string | null>
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const enc = new TextEncoder();

  // rId -> ctrlProp path (Targets look like ../ctrlProps/ctrlProp2.xml)
  const ridToPath = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]*ctrlProps\/ctrlProp\d+\.xml)"/g)) {
    ridToPath.set(m[1], ("xl/" + m[2].replace(/^\.\.\//, "").replace(/^\/?xl\//, "")).replace(/\/{2,}/g, "/"));
  }
  if (!ridToPath.size) return out;

  type Ctrl = { path: string; fromCol: number; fromRow: number; toRow: number; type: string; linkRow: number | null };
  const ctrls: Ctrl[] = [];
  for (const m of sheetXml.matchAll(/<control [^>]*\br:id="(rId\d+)"[^>]*>([\s\S]*?)<\/control>/g)) {
    const path = ridToPath.get(m[1]);
    if (!path) continue;
    const body = m[2];
    const fm = ANCHOR_FROM.exec(body);
    if (!fm) continue;
    const tm = ANCHOR_TO.exec(body);
    const cp = await readCtrlProp(path);
    if (!cp) continue;
    const type = (/objectType="(\w+)"/.exec(cp) || [, ""])[1] as string;
    const fl = /fmlaLink="\$?[A-Z]+\$?(\d+)"/.exec(cp);
    ctrls.push({
      path,
      fromCol: parseInt(fm[1], 10),
      fromRow: parseInt(fm[2], 10),
      toRow: tm ? parseInt(tm[1], 10) : parseInt(fm[2], 10),
      type,
      linkRow: fl ? parseInt(fl[1], 10) : null,
    });
  }

  const boxes = ctrls.filter((c) => c.type === "GBox");
  const radios = ctrls.filter((c) => c.type === "Radio");

  for (const box of boxes) {
    const members = radios
      .filter((r) => r.fromRow >= box.fromRow && r.fromRow <= box.toRow)
      .sort((a, b) => a.fromRow - b.fromRow || a.fromCol - b.fromCol);
    if (!members.length) continue;
    const first = members.find((r) => r.linkRow != null);
    const linkRow = first?.linkRow ?? null;
    if (linkRow == null || !rowToIdx.has(linkRow)) continue; // unfilled → leave blank
    const idx = rowToIdx.get(linkRow)!; // 1..4
    const chosen = members[idx - 1];
    if (!chosen) continue;
    const cp = await readCtrlProp(chosen.path);
    if (!cp) continue;
    // Set checked="Checked" on the chosen radio (replace any existing).
    let next = cp.replace(/\s+checked="[^"]*"/g, "");
    next = next.replace(/objectType="Radio"/, 'objectType="Radio" checked="Checked"');
    out.set(chosen.path, enc.encode(next));
  }
  return out;
}

export async function fillOfficialTemplate(
  templateBuf: ArrayBuffer,
  editsBySheet: Map<string, CellEdit[]>
): Promise<Blob> {
  const entries = parseZip(new Uint8Array(templateBuf));
  const byName = new Map(entries.map((e) => [e.name, e]));

  const wbEntry = byName.get("xl/workbook.xml");
  const relsEntry = byName.get("xl/_rels/workbook.xml.rels");
  if (!wbEntry || !relsEntry) throw new Error("This file is not a standard .xlsm workbook.");

  const wbXml = await getText(wbEntry);
  const relsXml = await getText(relsEntry);

  const nameToRid: Record<string, string> = {};
  for (const m of wbXml.matchAll(/<sheet[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) nameToRid[m[1]] = m[2];
  const ridToTarget: Record<string, string> = {};
  for (const m of relsXml.matchAll(/<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) ridToTarget[m[1]] = m[2];

  const modified = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();

  // Register any text values in the shared-strings table (t="s"), the form the
  // template uses for every label, then reference them by index in each cell.
  const strIndex = new Map<string, number>();
  const allStrings: string[] = [];
  for (const eds of editsBySheet.values())
    for (const ed of eds) if (typeof ed.value === "string") allStrings.push(ed.value);
  const sstEntry = byName.get("xl/sharedStrings.xml");
  if (allStrings.length && sstEntry) {
    let sst = await getText(sstEntry);
    let base = (sst.match(/<si[\s>]/g) || []).length; // current unique count = next index
    let additions = "";
    let added = 0;
    for (const s of allStrings) {
      if (strIndex.has(s)) continue;
      strIndex.set(s, base++);
      additions += `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`;
      added++;
    }
    if (additions) {
      sst = sst.replace("</sst>", `${additions}</sst>`);
      sst = sst.replace(/<sst([^>]*)>/, (full, attrs: string) => {
        const cm = /\bcount="(\d+)"/.exec(attrs);
        const um = /\buniqueCount="(\d+)"/.exec(attrs);
        const count = (cm ? parseInt(cm[1], 10) : 0) + allStrings.length;
        const uniq = (um ? parseInt(um[1], 10) : 0) + added;
        let a = attrs.replace(/\s+count="\d+"/, "").replace(/\s+uniqueCount="\d+"/, "");
        return `<sst${a} count="${count}" uniqueCount="${uniq}">`;
      });
    }
    modified.set("xl/sharedStrings.xml", encoder.encode(sst));
  }

  for (const [sheetName, edits] of editsBySheet) {
    const rid = nameToRid[sheetName];
    const target = rid && ridToTarget[rid];
    if (!target) continue;
    const path = ("xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, "")).replace(/\/{2,}/g, "/");
    const entry = byName.get(path);
    if (!entry) continue;
    let xml = await getText(entry);
    const origSheetXml = xml;
    for (const ed of edits) {
      if (typeof ed.value === "string") {
        const idx = strIndex.get(ed.value);
        if (idx != null) xml = setSharedCell(xml, ed.ref, idx);
      } else {
        xml = setCellValue(xml, ed.ref, ed.value, ed.keepFormula);
      }
    }
    modified.set(path, encoder.encode(xml));

    // For the per-Essential answer sheets, also select the matching option
    // buttons in the sheet's legacy VML drawing so the radios show as filled.
    if (/^E\d+$/i.test(sheetName)) {
      const rowToIdx = new Map<number, number>();
      for (const ed of edits) {
        const em = /^E(\d+)$/.exec(ed.ref);
        if (em && ed.keepFormula === false && typeof ed.value === "number") {
          rowToIdx.set(parseInt(em[1], 10), ed.value);
        }
      }
      if (rowToIdx.size) {
        const m = /worksheets\/(sheet\d+)\.xml$/.exec(path);
        const relsPath = m ? `xl/worksheets/_rels/${m[1]}.xml.rels` : null;
        const relsE = relsPath ? byName.get(relsPath) : null;
        if (relsE) {
          const rels = await getText(relsE);
          const vm = /Target="([^"]*vmlDrawing\d+\.vml)"/.exec(rels);
          if (vm) {
            const vmlPath = ("xl/worksheets/" + vm[1]).replace(/xl\/worksheets\/\.\.\//, "xl/").replace(/\/{2,}/g, "/");
            const vmlEntry = byName.get(vmlPath);
            if (vmlEntry) {
              const vml = await getText(vmlEntry);
              modified.set(vmlPath, encoder.encode(applyRadioChecks(vml, rowToIdx)));
            }
          }
          // Modern Excel: stamp checked="Checked" on the right ctrlProp so the
          // radio DOT actually fills in (the real fix for "highlighted but not
          // selected"). Grouped by geometry so it's correct even out of order.
          const cpMods = await planCtrlPropChecks(origSheetXml, rels, rowToIdx, async (p) => {
            const e = byName.get(p);
            return e ? await getText(e) : null;
          });
          for (const [p, data] of cpMods) modified.set(p, data);
        }
      }
    }
  }

  modified.set("xl/workbook.xml", encoder.encode(setFullCalc(wbXml)));

  const rebuilt: RawEntry[] = [];
  for (const e of entries) {
    const mod = modified.get(e.name);
    if (mod) rebuilt.push({ name: e.name, method: 0, crc: crc32(mod), csize: mod.length, usize: mod.length, compressed: mod });
    else rebuilt.push(e);
  }
  return new Blob([buildZip(rebuilt) as unknown as BlobPart], { type: "application/vnd.ms-excel.sheet.macroEnabled.12" });
}
