/**
 * A tiny, dependency-free .xlsx writer — enough for formatted sheets
 * (text/number cells, fills, bold, borders, merged cells, column widths,
 * frozen panes, filter buttons, several tabs). Used for the MIS Circle Report
 * download. Files are stored in the zip uncompressed, which every Excel
 * version opens fine.
 */

export interface XlsxStyle {
  /** Background colour, "RRGGBB". */
  fill?: string;
  /** Font colour, "RRGGBB". */
  color?: string;
  bold?: boolean;
  size?: number;
  align?: "left" | "center" | "right";
  wrap?: boolean;
  border?: boolean;
}

export type XlsxValue = string | number | null | undefined;
export interface XlsxCell {
  v: XlsxValue;
  /** Index into the `styles` array (0 = default). */
  s?: number;
}

export interface XlsxSheet {
  name: string;
  rows: (XlsxCell | XlsxValue)[][];
  styles: XlsxStyle[];
  merges?: string[];
  colWidths?: number[];
  /** Freeze rows above / columns left of this cell (1-based). */
  freeze?: { row: number; col: number };
  rowHeights?: Record<number, number>;
  /** Filter buttons on a header row, e.g. "A4:H40". */
  autoFilter?: string;
  /** Tab colour, "RRGGBB". */
  tabColor?: string;
}

/** Several tabs sharing one list of styles. */
export interface XlsxBook {
  styles: XlsxStyle[];
  sheets: Omit<XlsxSheet, "styles">[];
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

export function colName(n: number): string {
  let s = "";
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function stylesXml(styles: XlsxStyle[]): string {
  const all = [{} as XlsxStyle, ...styles];
  const fonts: string[] = [];
  const fills: string[] = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const xfs: string[] = [];
  const border = '<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border>';
  for (const st of all) {
    fonts.push(
      `<font>${st.bold ? "<b/>" : ""}<sz val="${st.size ?? 10}"/>${st.color ? `<color rgb="FF${st.color}"/>` : ""}<name val="Calibri"/></font>`,
    );
    let fillId = 0;
    if (st.fill) {
      fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${st.fill}"/><bgColor indexed="64"/></patternFill></fill>`);
      fillId = fills.length - 1;
    }
    const fontId = fonts.length - 1;
    const align = st.align || st.wrap ? `<alignment${st.align ? ` horizontal="${st.align}"` : ""} vertical="center"${st.wrap ? ' wrapText="1"' : ""}/>` : "";
    xfs.push(
      `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${st.border ? 1 : 0}" xfId="0"${fontId ? ' applyFont="1"' : ""}${fillId ? ' applyFill="1"' : ""}${st.border ? ' applyBorder="1"' : ""}${align ? ' applyAlignment="1"' : ""}>${align}</xf>`,
    );
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="${fills.length}">${fills.join("")}</fills>` +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>"
  );
}

function sheetXml(sheet: Omit<XlsxSheet, "styles">, selected: boolean): string {
  const rows = sheet.rows
    .map((row, ri) => {
      const r = ri + 1;
      const cells = row
        .map((raw, ci) => {
          const cell: XlsxCell = raw !== null && typeof raw === "object" ? raw : { v: raw };
          const ref = `${colName(ci + 1)}${r}`;
          // Style indexes are shifted by one: index 0 in the stylesheet is the default.
          const s = cell.s !== undefined ? ` s="${cell.s + 1}"` : "";
          if (cell.v === null || cell.v === undefined || cell.v === "") return s ? `<c r="${ref}"${s}/>` : "";
          if (typeof cell.v === "number" && Number.isFinite(cell.v)) return `<c r="${ref}"${s}><v>${cell.v}</v></c>`;
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`;
        })
        .join("");
      const ht = sheet.rowHeights?.[r];
      return `<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ""}>${cells}</row>`;
    })
    .join("");
  const cols = sheet.colWidths?.length
    ? `<cols>${sheet.colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const f = sheet.freeze;
  const view = f
    ? `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ""} workbookViewId="0">${freezePane(f)}</sheetView></sheetViews>`
    : `<sheetViews><sheetView${selected ? ' tabSelected="1"' : ""} workbookViewId="0"/></sheetViews>`;
  const merges = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
    : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheetPr>${sheet.tabColor ? `<tabColor rgb="FF${sheet.tabColor}"/>` : ""}<pageSetUpPr fitToPage="1"/></sheetPr>` +
    view +
    cols +
    `<sheetData>${rows}</sheetData>` +
    (sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : "") +
    merges +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>' +
    '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    "</worksheet>"
  );
}

function freezePane(f: { row: number; col: number }): string {
  const x = f.col - 1;
  const y = f.row - 1;
  if (x <= 0 && y <= 0) return "";
  const pane = x > 0 && y > 0 ? "bottomRight" : y > 0 ? "bottomLeft" : "topRight";
  return `<pane${x > 0 ? ` xSplit="${x}"` : ""}${y > 0 ? ` ySplit="${y}"` : ""} topLeftCell="${colName(f.col)}${f.row}" activePane="${pane}" state="frozen"/>`;
}

// --- zip (stored, no compression) ------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

/** Builds a single-sheet .xlsx file. */
export function buildXlsx(sheet: XlsxSheet): Buffer {
  const { styles, ...rest } = sheet;
  return buildWorkbook({ styles, sheets: [rest] });
}

const sheetName = (n: string, i: number) => n.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;

/** Builds an .xlsx file with one tab per sheet (first tab opens first). */
export function buildWorkbook(book: XlsxBook): Buffer {
  if (book.sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  // Excel refuses duplicate tab names (case-insensitive).
  const used = new Set<string>();
  const names = book.sheets.map((sh, i) => {
    let n = sheetName(sh.name, i);
    for (let k = 2; used.has(n.toLowerCase()); k++) n = `${sheetName(sh.name, i).slice(0, 27)} (${k})`;
    used.add(n.toLowerCase());
    return n;
  });
  const files = [
    {
      name: "[Content_Types].xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        book.sheets
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join("") +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        "</Types>",
    },
    {
      name: "_rels/.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        "</Relationships>",
    },
    {
      name: "xl/workbook.xml",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<bookViews><workbookView activeTab="0"/></bookViews>' +
        `<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
        (book.sheets.some((s) => s.autoFilter)
          ? `<definedNames>${book.sheets
              .map((s, i) =>
                s.autoFilter
                  ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(names[i].replace(/'/g, "''"))}'!${s.autoFilter
                      .split(":")
                      .map((c) => c.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2"))
                      .join(":")}</definedName>`
                  : "",
              )
              .join("")}</definedNames>`
          : "") +
        "</workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        book.sheets
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join("") +
        `<Relationship Id="rId${book.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        "</Relationships>",
    },
    { name: "xl/styles.xml", data: stylesXml(book.styles) },
    ...book.sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh, i === 0) })),
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}
