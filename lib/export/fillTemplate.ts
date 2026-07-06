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
  value: number;
  keepFormula?: boolean;
}

// ── Work out which cells to set, from the draft ──────────────
const HDR = /^(P\d+\.\d+)\b/i;

export function computeTemplateEdits(buf: ArrayBuffer, draft: Draft): Map<string, CellEdit[]> {
  const wb = XLSX.read(buf, { type: "array" });
  const edits = new Map<string, CellEdit[]>();
  const push = (sheet: string, ref: string, value: number, keepFormula?: boolean) => {
    if (!edits.has(sheet)) edits.set(sheet, []);
    edits.get(sheet)!.push({ ref, value, keepFormula });
  };

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

function setCellValue(xml: string, ref: string, value: number, keepFormula?: boolean): string {
  const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = xml.match(cellRe);
  if (m) {
    let attrs = m[1] || "";
    const inner = m[2] || "";
    attrs = attrs.replace(/\s+t="[^"]*"/g, ""); // numbers carry no type
    let newInner: string;
    if (keepFormula) {
      const f = inner.match(/<f[\s\S]*?<\/f>|<f[^>]*\/>/);
      newInner = `${f ? f[0] : ""}<v>${value}</v>`;
    } else {
      newInner = `<v>${value}</v>`;
    }
    return xml.replace(cellRe, `<c r="${ref}"${attrs}>${newInner}</c>`);
  }

  // Cell absent — insert into its row (in column order).
  const rowNum = ref.replace(/[A-Z]/g, "");
  const colN = colToNum(ref);
  const newCell = `<c r="${ref}"><v>${value}</v></c>`;
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
    const newBody = body.slice(0, insertAt) + newCell + body.slice(insertAt);
    return xml.replace(rowRe, `${rm[1]}${newBody}${rm[3]}`);
  }

  // Row absent — insert a new row in row order inside <sheetData>.
  const rowTag = /<row r="(\d+)"[^>]*>/g;
  let insertAt = -1;
  let rmatch: RegExpExecArray | null;
  while ((rmatch = rowTag.exec(xml))) {
    if (parseInt(rmatch[1], 10) > parseInt(rowNum, 10)) { insertAt = rmatch.index; break; }
  }
  const rowXml = `<row r="${rowNum}">${newCell}</row>`;
  if (insertAt >= 0) return xml.slice(0, insertAt) + rowXml + xml.slice(insertAt);
  return xml.replace("</sheetData>", `${rowXml}</sheetData>`);
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

// ── Public API ───────────────────────────────────────────────
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

  for (const [sheetName, edits] of editsBySheet) {
    const rid = nameToRid[sheetName];
    const target = rid && ridToTarget[rid];
    if (!target) continue;
    const path = ("xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, "")).replace(/\/{2,}/g, "/");
    const entry = byName.get(path);
    if (!entry) continue;
    let xml = await getText(entry);
    for (const ed of edits) xml = setCellValue(xml, ed.ref, ed.value, ed.keepFormula);
    modified.set(path, encoder.encode(xml));
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
