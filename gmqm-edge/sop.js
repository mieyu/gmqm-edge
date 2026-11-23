import { sites } from "./sites.js";

export const films = ["基膜", "涂布膜", "喷涂膜", "点涂膜"];
export const marks = ["AI过杀", "漏检"];
export const labels = ["蚊虫明显", "蚊虫疑似", "蚊虫误判", "碎膜明显", "碎膜疑似", "碎膜误判"];
const platformNames = { wuxi: "无锡恩捷", jintan: "金坛恩捷", suzhou: "苏州捷力", hubei: "湖北恩捷" };
const groups = [
  ["jintan", "喷涂", [
    ["迭代"], ["划痕", "漏涂-划痕", ["漏涂-划痕状"]],
    ["皱折", "漏涂-褶皱", ["漏涂-皱折状"]], ["漏涂异物", "漏涂-异物", ["漏涂-异物状"]],
  ]],
  ["jintan", "涂布", [
    ["迭代"], ["划痕", "漏涂划痕", ["漏涂-划痕状"]],
    ["皱折", "漏涂褶皱", ["漏涂-皱折状"]], ["漏涂异物", "漏涂异物", ["漏涂-异物状"]],
  ]],
  ["suzhou", "涂布", [
    ["迭代"], ["划痕", "划痕", ["划痕"]], ["褶皱", "折痕", ["折痕"]],
    ["漏涂异物", "漏涂异物", ["包心白点（料渣）", "包心白点（胶状）"]],
  ]],
  ["hubei", "涂布", [
    ["迭代"], ["褶皱", "漏涂褶皱", ["褶皱"]], ["划痕", "划痕", ["漏涂-划痕状", "划痕"]],
    ["漏涂异物", "漏涂异物", ["漏涂-异物状"]], ["漏涂未烘干", "漏涂未烘干", ["漏涂-未烘干"]],
  ]],
];

export function chinaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"].map(key => parts.find(part => part.type === key).value).join("-");
}

export function previousDay(day) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function monthDay(day) {
  return day.slice(5).replace("-", "");
}

export function exportFilename(file, day) {
  if (file.outside || file.films.length !== 1 || !films.includes(file.films[0])) return "";
  const range = [previousDay(day), day].map(value => value.replaceAll("-", "")).join("-");
  return ["GMQM", platformNames[file.site], file.films[0], "生产" + range, "判等结果.csv"].join("_");
}

export function collectionPlan(mode, day) {
  const suffix = monthDay(day);
  if (mode === "insect") {
    return sites.map(site => ({
      site: site.id, gallery: site.name + "-蚊虫碎膜迭代-" + suffix, defects: ["碎膜", "蚊虫"],
    }));
  }
  return groups.flatMap(([siteId, process, entries]) => {
    const site = sites.find(target => target.id === siteId);
    return entries.map(([name, reportLabel, defects]) => ({
      site: siteId, film: process + "膜", gallery: [site.name, process + name, suffix].join("-"),
      reportLabel, defects: defects ?? [],
    }));
  });
}

function parseRows(text, delimiter) {
  const rows = [];
  let cells = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character !== '"') field += character;
      else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"' && !field) quoted = true;
    else if (character === delimiter) {
      cells.push(field);
      field = "";
    } else if (character === "\r" || character === "\n") {
      cells.push(field);
      if (cells.some(cell => cell.trim())) rows.push(cells);
      cells = [];
      field = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else field += character;
  }
  if (quoted) throw new Error("文件中的引号未闭合");
  if (field || cells.length) rows.push([...cells, field]);
  return rows;
}

function decode(bytes) {
  if (bytes[0] === 255 && bytes[1] === 254) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 254 && bytes[1] === 255) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

const normalize = value => value.trim().replace(/\s+/g, "");

export function readExport(bytes, siteId, filename, day) {
  const namedSite = sites.find(site => filename.startsWith("GMQM_" + site.name));
  if (namedSite && namedSite.id !== siteId) throw new Error("文件名与选择的站点不同");
  const yesterday = previousDay(day);
  const filenameRange = filename.match(/生产(\d{8})-(\d{8})/);
  if (filenameRange && (filenameRange[1] !== yesterday.replaceAll("-", "") ||
      filenameRange[2] !== day.replaceAll("-", ""))) {
    throw new Error("文件名中的生产日期与所选作业日期不符");
  }
  const text = decode(bytes).replace(/^\uFEFF/, "");
  const delimiter = text.slice(0, text.search(/[\r\n]/) < 0 ? undefined : text.search(/[\r\n]/))
    .includes("\t") ? "\t" : ",";
  const [headers, ...records] = parseRows(text, delimiter);
  if (!headers) throw new Error("文件为空");
  const headings = headers.map(normalize);
  const required = ["子卷SN号", "产品类别", "标记", "CCD等级", "生产时间"];
  if (required.some(key => headings.filter(heading => heading === key).length !== 1)) {
    throw new Error("判等结果表头缺少子卷 SN、产品类别、标记、CCD 等级或生产时间");
  }
  if (records.some(row => row.length !== headers.length)) throw new Error("数据列数与表头不一致");
  const columns = Object.fromEntries(headings.map((name, index) => [name, index]));
  const read = (row, name) => row[columns[name]]?.trim() ?? "";
  const seenFilms = new Set();
  const rows = [];
  let outside = 0;
  let missing = 0;
  let missingB = 0;
  let missingReview = 0;
  for (const row of records) {
    const time = read(row, "生产时间");
    const starts = time.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if (!starts || starts < yesterday || starts > day) {
      outside += 1;
      continue;
    }
    const film = normalize(read(row, "产品类别"));
    if (film) seenFilms.add(film);
    const sn = read(row, "子卷SN号");
    const ccd = normalize(read(row, "CCD等级")).toUpperCase();
    const mark = normalize(read(row, "标记"));
    if (!sn || /[\r\n]/.test(sn)) {
      missing += 1;
      if (ccd === "B") missingB += 1;
      if (marks.includes(mark)) missingReview += 1;
      continue;
    }
    rows.push({
      site: siteId, filename, time, film, sn,
      ccd, mark, batch: read(row, "子卷批支号"),
      reviewer: read(row, "复判人员") || "未记录", line: read(row, "线体"), station: read(row, "工位号"),
      ccdCode: read(row, "CCD降等代码"), manual: read(row, "人工复判等级"),
      manualCode: read(row, "人工降等代码"), finalGrade: read(row, "终判等级"),
      finalCode: read(row, "终判降等代码"),
    });
  }
  const namedFilm = films.find(film => filename.includes("_" + film + "_"));
  if (namedFilm && [...seenFilms].some(film => film !== namedFilm)) throw new Error("文件名与数据膜种不符");
  if (!records.length && namedFilm) seenFilms.add(namedFilm);
  return { filename, site: siteId, total: records.length, outside, missing, missingB, missingReview,
    films: [...seenFilms], rows };
}

export function sampleNumbers(rows, entry) {
  return [...new Set(rows.filter(row => row.site === entry.site && row.ccd === "B" &&
    (!entry.film || row.film === entry.film)).map(row => row.sn))];
}

export function reviewNumbers(rows) {
  const unique = new Map();
  for (const row of rows) {
    if (!marks.includes(row.mark)) continue;
    const key = JSON.stringify([row.site, row.film, row.sn, row.mark]);
    const previous = unique.get(key);
    if (!previous || (previous.reviewer === "未记录" && row.reviewer !== "未记录")) unique.set(key, row);
  }
  return [...unique.values()];
}

export function reviewReport(files, scope = "all") {
  const selected = scope === "all" ? sites : sites.filter(site => site.id === scope);
  const relevant = files.filter(file => selected.some(site => site.id === file.site));
  const detail = reviewNumbers(relevant.flatMap(file => file.rows));
  const summary = [["过杀漏降"]];
  for (const site of selected) {
    const seen = new Set(relevant.filter(file => file.site === site.id).flatMap(file => file.films));
    if (!seen.size) continue;
    const siteFilms = [...films.filter(film => seen.has(film)), ...[...seen].filter(film => !films.includes(film))];
    for (const film of siteFilms) {
      const group = detail.filter(row => row.site === site.id && row.film === film);
      summary.push([site.name, film, "过杀" + group.filter(row => row.mark === "AI过杀").length + "卷",
        "漏降" + group.filter(row => row.mark === "漏检").length + "卷"], []);
    }
  }
  const headers = ["平台", "产品类别", "复判人员", "GMQM 标记", "子卷 SN 号", "人工判断", "线体",
    "工位号", "子卷批支号", "生产时间", "CCD等级", "CCD降等代码", "人工复判等级", "人工降等代码",
    "终判等级", "终判降等代码", "来源文件"];
  return { summary, detail, grid: [headers, ...detail.map(row => [
    platformNames[row.site], row.film, row.reviewer, row.mark, row.sn, "", row.line, row.station, row.batch, row.time,
    row.ccd, row.ccdCode, row.manual, row.manualCode, row.finalGrade, row.finalCode, row.filename,
  ])] };
}

export function reviewSummaryLines(summary) {
  const lines = [{ text: "过杀漏降", type: "title" }];
  let previous;
  for (const [site, film, over, miss] of summary.slice(1).filter(row => row.length)) {
    if (site !== previous) {
      lines.push({ text: site, type: "site" });
      previous = site;
    }
    lines.push({ text: film === "基膜" ? film : film.replace(/膜$/, ""), type: "film" });
    const platform = platformNames[sites.find(entry => entry.name === site)?.id];
    lines.push({ text: over, platform, film, mark: "AI过杀", prefix: "过杀" },
      { text: miss, platform, film, mark: "漏检", prefix: "漏降" }, { text: "" });
  }
  if (lines.at(-1).text === "") lines.pop();
  return lines;
}

export function collectionReport(day, counts) {
  const plan = collectionPlan("collection", day);
  const reportOrder = {
    "涂布膜": {
      suzhou: ["划痕", "漏涂异物", "折痕"],
      hubei: ["漏涂褶皱", "划痕", "漏涂未烘干", "漏涂异物"],
      jintan: ["漏涂异物", "漏涂划痕", "漏涂褶皱"],
    },
    "喷涂膜": { jintan: ["漏涂-褶皱", "漏涂-划痕", "漏涂-异物"] },
  };
  const lines = [];
  for (const [index, film] of ["涂布膜", "喷涂膜"].entries()) {
    lines.push(index === 0 ? "一、涂布" : "二、喷涂膜");
    for (const siteId of ["suzhou", "hubei", "jintan"]) {
      const order = reportOrder[film][siteId];
      if (!order) continue;
      lines.push(sites.find(site => site.id === siteId).name);
      for (const label of order) {
        const entry = plan.find(item => item.site === siteId && item.film === film && item.reportLabel === label);
        const value = (counts[entry.gallery] ?? "").trim();
        lines.push(entry.reportLabel + "：" + (/^\d+$/.test(value) ? value + "张" : value || "待采集"));
      }
      lines.push("");
    }
  }
  return lines.join("\r\n");
}
