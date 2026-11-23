import { reviewSummaryLines } from "./sop.js";

const encoder = new TextEncoder();
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const sheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageNs = "http://schemas.openxmlformats.org/package/2006/relationships";

function xml(value) {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
    })[character]);
}

function columnName(index) {
  let result = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(65 + (value - 1) % 26) + result;
  }
  return result;
}

function sheet(rows, { style, widths, table = false, frozen = false }) {
  const content = rows.map((row, index) => {
    const cells = row.map((value, column) => {
      const cell = '<c r="' + columnName(column) + (index + 1) + '" s="' + style(index, column) + '"';
      if (value?.formula) return cell + ' t="str"><f>' + xml(value.formula) + "</f><v>" + xml(value.text) + "</v></c>";
      return cell + ' t="inlineStr"><is><t xml:space="preserve">' + xml(value ?? "") + "</t></is></c>";
    }).join("");
    return '<row r="' + (index + 1) + '">' + cells + "</row>";
  }).join("");
  const view = frozen ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" ' +
    'activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' +
    "</sheetView></sheetViews>" : "";
  const columns = "<cols>" + widths.map((width, i) =>
    '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>').join("") + "</cols>";
  return declaration + '<worksheet xmlns="' + sheetNs + '" xmlns:r="' + relNs + '">' + view + columns +
    "<sheetData>" + content + "</sheetData>" +
    (table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : "") + "</worksheet>";
}

function reviewStyles() {
  const font = (size, bold = false, white = false) => '<font><name val="Microsoft YaHei"/><sz val="' +
    size + '"/>' + (bold ? "<b/>" : "") + (white ? '<color rgb="FFFFFFFF"/>' : "") + "</font>";
  const fill = color => '<fill><patternFill patternType="solid"><fgColor rgb="' + color +
    '"/><bgColor indexed="64"/></patternFill></fill>';
  const formats = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 2], [0, 3]];
  return declaration + '<styleSheet xmlns="' + sheetNs + '"><fonts count="5">' +
    [font(11), font(15, true), font(12, true), font(11, true), font(10, true, true)].join("") +
    '</fonts><fills count="4"><fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' + fill("FF214460") + fill("FFFFF1CD") +
    '</fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + formats.length + '">' + formats.map(([fontId, fillId]) =>
      '<xf numFmtId="0" fontId="' + fontId + '" fillId="' + fillId +
      '" borderId="0" xfId="0" applyFont="1" applyFill="1"/>').join("") +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size, fields) {
  const buffer = new ArrayBuffer(size);
  const writer = new DataView(buffer);
  for (const [offset, length, value] of fields) {
    if (length === 2) writer.setUint16(offset, value, true);
    else writer.setUint32(offset, value, true);
  }
  return buffer;
}

export function zip(files, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
  const entries = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, body] of files) {
    const name = encoder.encode(path);
    const bytes = typeof body === "string" ? encoder.encode(body) : body;
    const crc = crc32(bytes);
    entries.push(header(30, [
      [0, 4, 0x04034b50], [4, 2, 20], [6, 2, 0x800], [12, 2, 33], [14, 4, crc], [18, 4, bytes.length],
      [22, 4, bytes.length], [26, 2, name.length],
    ]), name, bytes);
    directory.push(header(46, [
      [0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [8, 2, 0x800], [14, 2, 33], [16, 4, crc],
      [20, 4, bytes.length], [24, 4, bytes.length], [28, 2, name.length], [42, 4, offset],
    ]), name);
    offset += 30 + name.length + bytes.length;
    directorySize += 46 + name.length;
  }
  const end = header(22, [
    [0, 4, 0x06054b50], [8, 2, files.length], [10, 2, files.length],
    [12, 4, directorySize], [16, 4, offset],
  ]);
  return new Blob([...entries, ...directory, end], { type });
}

function relationships(entries) {
  return declaration + '<Relationships xmlns="' + packageNs + '">' +
    entries.map(([id, type, target]) =>
      '<Relationship Id="' + id + '" Type="' + relNs + "/" + type + '" Target="' + target + '"/>'
    ).join("") + "</Relationships>";
}

export function reviewWorkbook(summary, detail) {
  const lines = reviewSummaryLines(summary);
  const quote = value => '"' + value.replaceAll('"', '""') + '"';
  const end = Math.max(2, detail.length);
  const listRange = column => "'子卷明细'!$" + column + "$2:$" + column + "$" + end;
  const summaryCells = lines.map(line => [line.mark && line.platform ? {
    text: line.text,
    formula: quote(line.prefix) + "&COUNTIFS(" + listRange("A") + "," + quote(line.platform) + "," +
      listRange("B") + "," + quote(line.film) + "," + listRange("D") + "," + quote(line.mark) + ')&"卷"',
  } : line.text]);
  const range = "A1:" + columnName(detail[0].length - 1) + detail.length;
  const table = declaration + '<table xmlns="' + sheetNs + '" id="1" name="GmqmReview" displayName="GmqmReview" ' +
    'ref="' + range + '" totalsRowShown="0"><autoFilter ref="' + range + '"/><tableColumns count="' +
    detail[0].length + '">' + detail[0].map((label, i) =>
      '<tableColumn id="' + (i + 1) + '" name="' + xml(label) + '"/>').join("") +
    '</tableColumns><tableStyleInfo name="TableStyleLight9" showRowStripes="1"/></table>';
  const worksheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
  const types = declaration + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="' + worksheetType + '"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="' + worksheetType + '"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>';
  const workbook = declaration + '<workbook xmlns="' + sheetNs + '" xmlns:r="' + relNs + '"><sheets>' +
    '<sheet name="复核汇总" sheetId="1" r:id="rId1"/><sheet name="子卷明细" sheetId="2" r:id="rId2"/>' +
    "</sheets></workbook>";
  return zip([
    ["[Content_Types].xml", types],
    ["_rels/.rels", relationships([["rId1", "officeDocument", "xl/workbook.xml"]])],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", relationships([
      ["rId1", "worksheet", "worksheets/sheet1.xml"], ["rId2", "worksheet", "worksheets/sheet2.xml"],
      ["rId3", "styles", "styles.xml"],
    ])],
    ["xl/styles.xml", reviewStyles()],
    ["xl/worksheets/sheet1.xml", sheet(summaryCells, {
      widths: [29.38], style: index => ({title: 1, site: 2, film: 3})[lines[index].type] ?? 0,
    })],
    ["xl/worksheets/sheet2.xml", sheet(detail, {
      table: true, frozen: true, widths: [13.75, 13.13, 13.75, 14.38, 29.63, 17.25, 14, 10.63, 45, 42.88, 13,
        16.88, 16, 18.75, 13, 16.88, 66.88],
      style: (row, column) => row === 0 ? 4 : column === 5 ? 5 : 0,
    })],
    ["xl/worksheets/_rels/sheet2.xml.rels", relationships([["rId1", "table", "../tables/table1.xml"]])],
    ["xl/tables/table1.xml", table],
  ]);
}
