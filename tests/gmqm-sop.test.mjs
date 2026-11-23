import assert from "node:assert/strict";
import test from "node:test";
import { jobsForDay } from "../gmqm-edge/collection.js";
import { gradingTargets } from "../gmqm-edge/grading.js";
import { gradingPage } from "../gmqm-edge/grading-page.js";
import {
  chinaDate, collectionPlan, collectionReport, exportFilename, previousDay, readExport,
  reviewReport, reviewSummaryLines, sampleNumbers,
} from "../gmqm-edge/sop.js";

test("sets the Shanghai work date and handles month boundaries", () => {
  assert.equal(chinaDate(new Date("2026-10-31T16:01:00Z")), "2026-11-01");
  assert.equal(previousDay("2026-11-01"), "2026-10-31");
});

test("daily full export selects the applicable sites for all three SOPs", () => {
  const day = "2026-11-19";
  assert.deepEqual(gradingTargets("collection", "all", day).map(site => site.id),
    ["jintan", "suzhou", "hubei"]);
  assert.deepEqual(gradingTargets("collection", "wuxi", day), []);
  assert.equal(gradingTargets("insect", "all", day).length, 4);
  assert.equal(gradingTargets("review", "all", day).length, 4);
});

test("exports from the button's own mounted menu even when Element UI hides it", async t => {
  const origin = "http://172.23.100.51:8077";
  const dates = ["2026-11-18", "2026-11-19"];
  const interactions = [];
  let disabled = false;
  let ccd = "";
  let opacity = "1";
  let closing = false;
  const element = (label, extras = {}) => ({
    innerText: label, textContent: label, childNodes: [], getClientRects: () => [1],
    classList: { contains: () => false }, getAttribute: () => null,
    ...extras,
  });
  const item = element("判等结果", {
    getClientRects: () => [],
    click: () => interactions.push("correct export"),
    classList: { contains: name => disabled && name === "is-disabled" },
  });
  const trigger = element("导出", {
    getAttribute: name => name === "aria-controls" ? "dropdown-menu-8202" : null,
    click: () => assert.fail("Should not depend on clicking the hover trigger"),
  });
  const field = (name, value) => element(name, {
    querySelector: () => element(name),
    querySelectorAll: () => [element("", { value })],
  });
  globalThis.window = {};
  window.top = window;
  globalThis.location = new URL(origin + "/#/ej/etc");
  const mask = element("", { closest: () => null, classList: { contains: name =>
    name === "is-fullscreen" || (closing && name === "el-loading-fade-leave-active") } });
  globalThis.getComputedStyle = node => ({ visibility: "visible", opacity: node === mask ? opacity : "1" });
  globalThis.document = {
    getElementById: id => id === "dropdown-menu-8202"
      ? { querySelectorAll: () => [item, element("机采缺陷统计")] } : null,
    querySelectorAll(selector) {
      if (selector === "button") return [element("查询"), trigger];
      if (selector === ".el-form-item") return [
        field("生产时间", "2026-11-18 00:00:00 - 2026-11-19 00:00:00"), field("CCD等级", ccd),
      ];
      if (selector === ".el-pagination__total") return [element("共 1183 条")];
      if (selector === ".el-loading-mask") return [mask];
      if (selector === ".el-dropdown-menu__item") return [
        element("判等结果", { click: () => assert.fail("Clicked an unrelated dropdown") }),
      ];
      return [];
    },
  };
  t.after(() => {
    for (const key of ["window", "location", "getComputedStyle", "document"]) delete globalThis[key];
  });

  assert.deepEqual(await gradingPage(origin, "probe", dates), { state: "waiting" });
  opacity = "0";
  assert.deepEqual(await gradingPage(origin, "probe", dates), { state: "ready" });
  opacity = "1";
  closing = true;
  assert.deepEqual(await gradingPage(origin, "export", dates), { state: "export-triggered" });
  disabled = true;
  assert.deepEqual(await gradingPage(origin, "export", dates),
    { state: "error", message: "平台已禁用「判等结果」导出" });
  disabled = false;
  ccd = "B";
  assert.deepEqual(await gradingPage(origin, "export", dates),
    { state: "error", message: "导出前的日期、CCD 或筛选条件已改变" });
  assert.deepEqual(interactions, ["correct export"]);
});

test("keeps the folder SOP's 13 collection galleries and four build-only galleries", () => {
  const plan = collectionPlan("collection", "2026-11-19");
  assert.equal(plan.length, 17);
  assert.equal(plan.filter(entry => entry.defects.length).length, 13);
  assert.deepEqual(plan.find(entry => entry.gallery === "湖北-涂布划痕-1119").defects,
    ["漏涂-划痕状", "划痕"]);
  assert.deepEqual(plan.find(entry => entry.gallery === "苏州-涂布漏涂异物-1119").defects,
    ["包心白点（料渣）", "包心白点（胶状）"]);
  assert.equal(collectionPlan("insect", "2026-11-19").length, 4);
  assert.match(collectionReport("2026-11-19", { "湖北-涂布划痕-1119": "0" }), /划痕：0张/);
});

test("reads UTF-16 tab exports, deduplicates review and collection independently", () => {
  const body = [
    "子卷 SN 号\tCCD等级\t标记\t产品类别\t生产时间\t复判人员",
    '0001\tB\tAI 过杀\t涂布膜\t2026-11-18 01:02:03\t"甲\t乙"',
    "0001\tB\tAI过杀\t涂布膜\t2026-11-18 01:02:03\t",
    "0001\tB\t漏检\t涂布膜\t2026-11-18 01:02:03\t",
    "0002\tA\t漏检\t涂布膜\t2026-11-18 01:02:03\t",
  ].join("\r\n");
  const bytes = Buffer.from("\ufeff" + body, "utf16le");
  const file = readExport(bytes, "hubei", "自动判等结果.csv", "2026-11-19");
  assert.equal(file.rows[0].reviewer, "甲\t乙");
  assert.deepEqual(sampleNumbers(file.rows, { site: "hubei", film: "涂布膜" }), ["0001"]);
  const report = reviewReport([file, file]);
  assert.deepEqual(report.summary[1], ["湖北", "涂布膜", "过杀1卷", "漏降2卷"]);
  assert.equal(report.grid[0][5], "人工判断");
  assert.equal(report.grid[1][5], "");
  assert.deepEqual(reviewSummaryLines(report.summary).map(row => row.text),
    ["过杀漏降", "湖北", "涂布", "过杀1卷", "漏降2卷"]);
  assert.equal(exportFilename(file, "2026-11-19"), "GMQM_湖北恩捷_涂布膜_生产20261118-20261119_判等结果.csv");
  assert.throws(() => readExport(bytes, "suzhou", "GMQM_湖北恩捷_涂布膜.csv", "2026-11-19"),
    /选择的站点不同/);
  assert.throws(() => readExport(bytes, "hubei", "GMQM_湖北恩捷_涂布膜_生产20261115-20261116_判等结果.csv",
    "2026-11-19"), /生产日期/);
});

test("uses the correct site and process for each executable collection job", () => {
  const day = "2026-11-19";
  const rows = [
    { site: "hubei", film: "涂布膜", ccd: "B", sn: "H1" },
    { site: "hubei", film: "涂布膜", ccd: "A", sn: "H2" },
    { site: "hubei", film: "喷涂膜", ccd: "B", sn: "H3" },
  ];
  const jobs = jobsForDay(day, "all", [{ site: "hubei", total: 3, outside: 0, rows }]);
  assert.equal(jobs.filter(job => job.hasSource).length, 5);
  assert.deepEqual(jobs.find(job => job.gallery === "湖北-涂布划痕-1119").sns, ["H1"]);
  assert.deepEqual(jobs.find(job => job.gallery === "湖北-涂布迭代-1119").sns, []);
  assert.ok(jobs.filter(job => job.site === "jintan").every(job => !job.hasSource));
});

test("insect jobs include every site's unique CCD B SN and all supported label films", () => {
  const day = "2026-11-19";
  const rows = [
    { site: "wuxi", film: "涂布膜", ccd: "B", sn: "B1" },
    { site: "wuxi", film: "涂布膜", ccd: "A", sn: "A1" },
    { site: "wuxi", film: "喷涂膜", ccd: "B", sn: "B1" },
    { site: "wuxi", film: "喷涂膜", ccd: "B", sn: "B2" },
  ];
  const jobs = jobsForDay(day, "all", [{ site: "wuxi", total: 4, outside: 0, rows }], "insect");
  assert.equal(jobs.length, 4);
  assert.deepEqual(jobs[0].sns, ["B1", "B2"]);
  assert.deepEqual(jobs[0].defects, ["碎膜", "蚊虫"]);
  assert.deepEqual(jobs[0].labelFilms, ["基膜", "涂布膜", "喷涂膜", "点涂膜"]);
  assert.equal(jobs[0].labelNames.length, 6);
  assert.equal(jobs[0].ccdOnly, true);
});
