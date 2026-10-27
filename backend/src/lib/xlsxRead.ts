/**
 * A small, dependency-free reader for .xlsx files (cell text only): enough to
 * read lists people keep in Excel (e.g. the "All MIS Spreadsheet Link" master
 * list). Returns every sheet as rows of strings, with cell hyperlinks.
 */
import { inflateRawSync } from "node:zlib";

export interface XlsxSheet {
  name: string;
  /** rows[r][c] = the cell's text ("" when empty). */
  rows: string[][];
  /** "r,c" -> hyperlink target of that cell. */
  links: Map<string, string>;
}

export class XlsxError extends Error {}

const MAX_BYTES = 30 * 1024 * 1024;

function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("This is not an Excel (.xlsx) file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError("The Excel file is damaged.");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^(xl\/|\[Content_Types\])/.test(name) || local + 30 > buf.length) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_BYTES }));
  }
  return out;
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Text of an <si> / <is> element: all its <t> runs (not phonetic hints). */
const textOf = (xml: string) =>
  decode(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""),
  );

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** "B12" -> { r: 11, c: 1 } */
function ref(a1: string): { r: number; c: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: Number(m[2]) - 1, c: c - 1 };
}

function rels(files: Map<string, Buffer>, path: string): Map<string, string> {
  const xml = files.get(path)?.toString("utf8") ?? "";
  return new Map([...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", decode(attr(m[0], "Target") ?? "")]));
}

export function readXlsx(buf: Buffer): XlsxSheet[] {
  if (buf.length > MAX_BYTES) throw new XlsxError("The file is too large.");
  const files = unzip(buf);
  const wb = files.get("xl/workbook.xml")?.toString("utf8");
  if (!wb) throw new XlsxError("This is not an Excel (.xlsx) file.");
  const shared = [...(files.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const wbRels = rels(files, "xl/_rels/workbook.xml.rels");
  const sheets: XlsxSheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(attr(m[0], "name") ?? "Sheet");
    const target = wbRels.get(attr(m[0], "r:id") ?? "") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = files.get(path)?.toString("utf8");
    if (!xml) continue;
    const rows: string[][] = [];
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const at = ref(attr(c[1], "r") ?? "");
      if (!at || at.r > 5000 || at.c > 200) continue;
      const type = attr(c[1], "t");
      const inner = c[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let text = "";
      if (type === "s") text = shared[Number(v)] ?? "";
      else if (type === "inlineStr") text = textOf(inner);
      else if (v !== undefined) text = decode(v);
      (rows[at.r] ??= [])[at.c] = text;
    }
    for (let r = 0; r < rows.length; r++) rows[r] = Array.from(rows[r] ?? [], (x) => x ?? "");
    const sheetRels = rels(files, path.replace(/([^/]+)$/, "_rels/$1.rels"));
    const links = new Map<string, string>();
    for (const h of xml.matchAll(/<hyperlink\b[^>]*>/g)) {
      const at = ref((attr(h[0], "ref") ?? "").split(":")[0]);
      const target = sheetRels.get(attr(h[0], "r:id") ?? "");
      if (at && target) links.set(`${at.r},${at.c}`, target);
    }
    sheets.push({ name, rows, links });
  }
  if (!sheets.length) throw new XlsxError("The Excel file has no sheets.");
  return sheets;
}
