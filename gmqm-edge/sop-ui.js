import { sites } from "./sites.js";
import { openWorkPages, workWindow } from "./workspace.js";
import { jobsForDay, runCollection, runInsectLabels } from "./collection.js";
import { gradingTargets, openReviewQuery, queryAndExport } from "./grading.js";
import { dailyExports, deleteDailyExport, saveDailyExport } from "./daily-cache.js";
import {
  chinaDate, collectionPlan, collectionReport, exportFilename, labels, marks, monthDay, previousDay, readExport,
  reviewReport, reviewSummaryLines, sampleNumbers,
} from "./sop.js";
import { reviewWorkbook } from "./workbook.js";

const byId = id => document.getElementById(id);
const mode = byId("mode");
const date = byId("date");
const scope = byId("scope");
const byDate = new Map();
const counts = new Map();
const runStatuses = new Map();
const gradingStatuses = new Map();
const dailyLoads = new Map();
const params = new URL(location.href).searchParams;
const preferredWindowId = Number(params.get("host")) || undefined;
let importing = false;
let collecting = false;
let querying = false;
const busy = () => importing || collecting || querying;

function note(message = "") {
  byId("feedback").textContent = message;
}

function button(label, action, disabled = false) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = label;
  control.disabled = disabled;
  control.addEventListener("click", async () => {
    try {
      await action();
    } catch (error) {
      note(error.message || "操作失败");
    }
  });
  return control;
}

async function openPages(tool, site) {
  const result = await openWorkPages(tool, site, await workWindow(preferredWindowId));
  if (result.error) throw new Error(result.error);
}

function siteName(id) {
  return sites.find(site => site.id === id).name;
}

function filesFor(day = date.value) {
  if (!byDate.has(day)) byDate.set(day, new Map());
  return byDate.get(day);
}

function restoreDaily(day) {
  if (!dailyLoads.has(day)) {
    const load = dailyExports(day).then(entries => {
      const files = filesFor(day);
      for (const entry of entries) {
        if (entry.status === "fulfilled" && !files.has("daily:" + entry.value.site)) {
          files.set("daily:" + entry.value.site, entry.value);
        }
      }
      return entries.some(entry => entry.status === "rejected");
    }).catch(() => true);
    dailyLoads.set(day, load);
  }
  return dailyLoads.get(day);
}

function countMap() {
  if (!counts.has(date.value)) counts.set(date.value, {});
  return counts.get(date.value);
}

function statusMap() {
  if (!runStatuses.has(date.value)) runStatuses.set(date.value, new Map());
  return runStatuses.get(date.value);
}

function activateTab(tabId) {
  return chrome.tabs.update(tabId, { active: true }).then(tab =>
    chrome.windows.update(tab.windowId, { focused: true }));
}

async function collect(jobs, windowId, tabs) {
  if (collecting || importing) return;
  collecting = true;
  const quantities = countMap();
  const states = statusMap();
  for (const job of jobs) states.set(job.gallery, { state: "pending", message: "等待执行" });
  note("采集运行中，收起浮窗仍会继续。");
  render();
  try {
    await runCollection(jobs, {
      windowId: windowId ?? await workWindow(preferredWindowId),
      tabs,
      update(job, result) {
        states.set(job.gallery, result);
        if (result.state === "saved") quantities[job.gallery] = String(result.count);
        else if (job.defects.length && !job.sns.length && result.state === "built") {
          quantities[job.gallery] = "无可采集 SN";
        }
        render();
      },
    });
    const finished = jobs.filter(job => states.get(job.gallery)?.state === "saved" ||
      states.get(job.gallery)?.importedThisRun).length;
    const open = jobs.filter(job => ["error", "uncertain", "existing", "labeling-incomplete"]
      .includes(states.get(job.gallery)?.state)).length;
    const ready = jobs.filter(job => states.get(job.gallery)?.state === "labeling-ready").length;
    note("本次入库 " + finished + " 个图库。" +
      (ready ? ready + " 个图库已补齐标签，可开始人工分类。" : "") +
      (open ? "有 " + open + " 个图库需查看状态。" : ""));
  } finally {
    collecting = false;
    render();
  }
}

async function repairInsectLabels() {
  if (busy()) return;
  const jobs = jobsForDay(date.value, scope.value, [], "insect");
  const states = statusMap();
  collecting = true;
  note("正在检查当天图库的各膜种标签。");
  render();
  try {
    await runInsectLabels(jobs, {
      windowId: await workWindow(preferredWindowId),
      update(job, result) {
        const prior = states.get(job.gallery);
        states.set(job.gallery, { ...prior, ...result });
        render();
      },
    });
    const complete = jobs.filter(job => states.get(job.gallery)?.state === "labeling-ready").length;
    note(complete + "/" + jobs.length + " 个图库的分类标签已核对齐全。");
  } finally {
    collecting = false;
    render();
  }
}

async function autoRun() {
  if (busy()) return;
  const day = date.value;
  const task = mode.value;
  const selected = scope.value;
  const targets = gradingTargets(task, selected, day);
  if (!targets.length) return;
  const progress = new Map();
  gradingStatuses.set(day, progress);
  const files = filesFor(day);
  querying = true;
  note("正在运行，收起浮窗仍会继续。");
  render();
  try {
    const cacheProblem = await restoreDaily(day);
    const missing = targets.filter(site => !files.has("daily:" + site.id));
    for (const site of targets.filter(site => files.has("daily:" + site.id))) {
      const result = files.get("daily:" + site.id);
      progress.set(site.id, { message: "复用当天全量判等表（" + result.total + " 条）", result });
    }
    renderGradingStatus();
    const host = missing.length || task !== "review" ? await workWindow(preferredWindowId) : undefined;
    const exports = missing.length ? await queryAndExport(missing, day, host, (site, message, result) => {
      progress.set(site.id, { message, result });
      if (result && !result.error) files.set("daily:" + site.id, { ...result, daily: true });
      renderGradingStatus();
    }) : [];
    let unsaved = 0;
    for (const record of exports.filter(record => !record.error)) {
      try {
        await saveDailyExport(day, record);
      } catch {
        unsaved += 1;
      }
    }
    const good = targets.map(site => files.get("daily:" + site.id)).filter(Boolean);
    if (task === "review") {
      if (good.length === targets.length) {
        const report = reviewReport(good, selected);
        download("GMQM_过杀漏降复核汇总_" + monthDay(day) + ".xlsx", reviewWorkbook(report.summary, report.grid));
        note("过杀漏降 Excel 已生成，共 " + report.detail.length + " 条待复核明细。" +
          (unsaved ? " 有 " + unsaved + " 站无法保存到跨重启缓存。" : ""));
      } else {
        note("已核对 " + good.length + "/" + targets.length + " 站，缺失站点请看上方提示。");
      }
      return;
    }
    if (good.length) {
      const states = statusMap();
      const jobs = jobsForDay(day, selected, good, task)
        .filter(job => !["saved", "built", "labeling-ready"].includes(states.get(job.gallery)?.state));
      if (jobs.some(job => job.hasSource)) {
        await collect(jobs, host, new Map(exports.filter(record => !record.error)
          .map(record => [record.site, record.tabId])));
      } else {
        note("已核对 " + good.length + "/" + targets.length + " 站的判等结果，本次无需重复处理已完成图库。");
      }
    } else {
      note(cacheProblem ? "有缓存原表无法读取，本轮也未取到已核对的文件。" :
        "本次没有获取到通过核对的判等结果，请查看各站提示。");
    }
    if (unsaved) note(byId("feedback").textContent + " 有 " + unsaved + " 站无法保存到跨重启缓存。");
  } finally {
    querying = false;
    render();
  }
}

function renderGradingStatus() {
  const list = byId("auto-status");
  const entries = [...(gradingStatuses.get(date.value) ?? [])];
  list.replaceChildren(...entries.filter(([site]) => scope.value === "all" || scope.value === site)
    .map(([site, progress]) => {
      const item = document.createElement("li");
      item.textContent = siteName(site) + " · " + progress.message;
      if (progress.result?.error) {
        item.className = "warn";
        if (Number.isInteger(progress.result.tabId)) {
          item.append(" ", button("查看页面", () => activateTab(progress.result.tabId), busy()));
        }
      }
      return item;
    }));
}

function download(filename, data) {
  const file = data instanceof Blob ? data : new Blob([data], { type: "text/plain;charset=utf-8" });
  const address = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.download = filename;
  link.href = address;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 3000);
}

async function copy(items, kind) {
  await navigator.clipboard.writeText(items.join("\n"));
  note(kind === "SN" ? "已复制 " + items.length + " 个完整 SN" : "已复制" + kind);
}

async function reviewGroup(site, review) {
  if (busy()) return;
  querying = true;
  note(site.name + "正在回查 " + review.sns.length + " 个 SN。");
  render();
  try {
    const result = await openReviewQuery(site, date.value, await workWindow(preferredWindowId), review);
    if (result.error) {
      note(site.name + "回查未完成：" + result.error);
      return;
    }
    note(site.name + "已按所选条件回查，平台返回 " + result.total + " 条。");
  } finally {
    querying = false;
    render();
  }
}

function table(columns, rows) {
  const grid = document.createElement("table");
  const header = grid.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = column;
    header.append(cell);
  }
  const body = grid.createTBody();
  for (const values of rows) {
    const row = body.insertRow();
    for (const [index, item] of values.entries()) {
      const cell = row.insertCell();
      cell.dataset.heading = columns[index];
      if (item instanceof Node) cell.append(item);
      else cell.textContent = item;
    }
  }
  return grid;
}

function renderFiles(files) {
  byId("files").replaceChildren(...[...files].map(([key, file]) => {
    const item = document.createElement("li");
    const details = document.createElement("span");
    const affected = file.outside || file.missingB || file.missingReview;
    details.textContent = siteName(file.site) + " · " + file.filename + " · " + file.total + " 行" +
      (file.outside ? "（日期不符或无法识别 " + file.outside + " 行）" : "") +
      (file.missing ? "（" + file.missing + " 行无有效 SN，其中 CCD B " + (file.missingB ?? 0) +
        " 行、过杀或漏检 " + (file.missingReview ?? 0) + " 行）" : "");
    if (affected) details.className = "warn";
    item.append(details);
    const filename = file.daily ? file.filename : exportFilename(file, date.value);
    if (filename && file.source) item.append(button("下载原文件", () => download(filename, file.source)));
    item.append(button("移除", async () => {
      if (file.daily) await deleteDailyExport(date.value, file.site);
      files.delete(key);
      render();
    }, busy()));
    return item;
  }));
}

function renderReview(files) {
  const report = reviewReport(files, scope.value);
  const shown = report.summary.slice(1).filter(row => row.length);
  byId("result-heading").textContent = "过杀漏降复核";
  byId("instructions").textContent =
    "按原标记汇总完整子卷 SN。回查时过杀打开「判等详情」，漏检打开「缺陷地图」并核对工位。";
  byId("output").replaceChildren(
    button("下载复核 Excel", () => download("GMQM_过杀漏降复核汇总_" + monthDay(date.value) + ".xlsx",
      reviewWorkbook(report.summary, report.grid)), !shown.length),
    button("下载汇总 TXT", () => download(monthDay(date.value) + ".txt",
      reviewSummaryLines(report.summary).map(row => row.text).join("\r\n") + "\r\n"), !shown.length),
  );
  const rows = shown.map(([name, film, over, miss]) => {
    const site = sites.find(item => item.name === name);
    const controls = document.createElement("div");
    controls.className = "actions";
    for (const mark of marks) {
      const sns = report.detail.filter(row => row.site === site.id && row.film === film && row.mark === mark)
        .map(row => row.sn);
      controls.append(button(mark + "回查（" + sns.length + "）", () =>
        reviewGroup(site, {film, mark, sns}), busy() || !sns.length));
      if (sns.length) controls.append(button("复制" + mark + " SN", () => copy(sns, "SN"), busy()));
    }
    return [name, film, over, miss, controls];
  });
  const content = shown.length
    ? table(["站点", "膜种", "AI 过杀", "漏检", "回查操作"], rows)
    : "导入至少一个站点的判等结果后显示汇总。";
  byId("result").replaceChildren(content);
}

function renderCollection(files) {
  const insect = mode.value === "insect";
  const plan = collectionPlan(mode.value, date.value)
    .filter(entry => scope.value === "all" || entry.site === scope.value);
  const rows = files.flatMap(file => file.rows);
  const quantities = countMap();
  const states = statusMap();
  const jobs = jobsForDay(date.value, scope.value, files, mode.value)
    .filter(job => !["saved", "built", "labeling-ready"].includes(states.get(job.gallery)?.state));
  byId("result-heading").textContent = insect ? "蚊虫碎膜采集计划" : "分类图库采集计划";
  byId("instructions").textContent = "采集区域选「判等区域」，缺陷来源选「AI 复判」。" +
    (insect ? "入库后补齐图库中实际出现的各膜种六类标签，再交给人工分类。" :
      "迭代图库只建库。已导入的判等文件也可单独用于采集。");
  byId("output").replaceChildren(
    button("打开样本图库", () => openPages("samples", scope.value), !plan.length),
    insect ? button("仅补标签", repairInsectLabels, busy() || !plan.length) :
      button("下载全日统计 TXT", () => download(monthDay(date.value) + ".txt",
        collectionReport(date.value, quantities)), !plan.length),
  );
  if (insect) byId("output").append(button("复制六类标签", () => copy(labels, "六类标签")));
  if (jobs.some(job => job.hasSource)) {
    byId("output").prepend(button("用现有文件采集", () => collect(jobs), busy()));
  }
  if (!plan.length) {
    byId("result").replaceChildren("所选站点没有这项采集任务。");
    return;
  }
  const grid = plan.map(entry => {
    const sns = sampleNumbers(rows, entry);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("复制图库名", () => copy([entry.gallery], "图库名")));
    if (entry.defects.length) {
      actions.append(button("复制 SN（" + sns.length + "）", () => copy(sns, "SN"), !sns.length));
    }
    const row = [siteName(entry.site), entry.gallery, entry.defects.join("、") || "只建库", actions];
    const task = states.get(entry.gallery);
    const cell = document.createElement("div");
    if (!insect && entry.defects.length) {
      const amount = document.createElement("input");
      amount.type = "text";
      amount.placeholder = "待采集";
      amount.value = quantities[entry.gallery] ?? "";
      amount.setAttribute("aria-label", entry.gallery + " 本批张数或状态");
      amount.maxLength = 32;
      amount.disabled = busy();
      amount.addEventListener("input", () => { quantities[entry.gallery] = amount.value; });
      cell.append(amount);
    }
    if (task) {
      const progress = document.createElement("span");
      progress.className = "run-status";
      const breakdown = task.byDefect ? Object.entries(task.byDefect).map(([defect, amount]) =>
        defect + " " + amount + " 张").join("、") : "";
      progress.textContent = task.message + (insect && Number.isInteger(task.count)
        ? " · " + (breakdown || "图库 " + task.count + " 张") : "");
      cell.append(progress);
      if (Number.isInteger(task.tabId) &&
          ["error", "existing", "uncertain", "labeling-ready", "labeling-incomplete"].includes(task.state)) {
        cell.append(button(task.state === "labeling-ready" ? "打开图库分类" : "查看平台",
          () => activateTab(task.tabId), busy()));
      }
    }
    row.push(cell);
    return row;
  });
  const columns = ["站点", "图库名称", "缺陷名称", "操作"];
  columns.push(insect ? "采集与分类状态" : "本批张数或状态");
  byId("result").replaceChildren(table(columns, grid));
}

function render() {
  if (!date.value || !date.validity.valid) return;
  const files = filesFor();
  for (const control of [mode, date, scope, byId("open-grading"), ...document.querySelectorAll(".imports input")]) {
    control.disabled = busy();
  }
  renderFiles(files);
  const wholeSites = new Set([...files.values()].filter(file => file.daily).map(file => file.site));
  const relevant = [...files.values()].filter(file => (scope.value === "all" || file.site === scope.value) &&
    (file.daily || !wholeSites.has(file.site)) && (mode.value !== "review" || !file.ccdFiltered));
  byId("query-note").textContent = "生产时间点选 " + previousDay(date.value) + " 至 " + date.value +
    "，保留平台默认时刻。" + (mode.value === "review"
      ? " 复用整站原表，在本地按膜种及标记筛选全等级数据。"
      : " 复用整站原表，在本地按膜种及 CCD B 筛选。");
  const actions = byId("auto-action");
  actions.replaceChildren();
  if (gradingTargets(mode.value, scope.value, date.value).length) {
    const start = button(querying ? "执行中…" :
      mode.value === "review" ? "一键生成过杀漏降 Excel" :
        mode.value === "collection" ? "一键查询、导出并采集" : "一键采集蚊虫碎膜", autoRun, busy());
    start.className = "primary";
    actions.append(start);
  }
  renderGradingStatus();
  if (mode.value === "review") renderReview(relevant);
  else renderCollection(relevant);
}

async function importFiles(site, selection) {
  if (busy()) return;
  if (!date.value || !date.reportValidity()) throw new Error("请先选择作业日期");
  const day = date.value;
  const files = filesFor(day);
  const messages = [];
  importing = true;
  render();
  try {
    for (const file of selection) {
      note("正在读取 " + file.name);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const key = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const record = readExport(bytes, site, file.name, day);
        const previous = files.get(key);
        if (previous && record.total) {
          messages.push(file.name + (previous.site === site ? "：已导入同一文件" :
            "：同一份数据已归入" + siteName(previous.site)));
          continue;
        }
        if (/_全量_生产\d{8}-\d{8}_判等结果\.csv$/i.test(file.name) && !record.outside &&
            !files.has("daily:" + site)) {
          const daily = { ...record, source: file, daily: true };
          files.set("daily:" + site, daily);
          try {
            await saveDailyExport(day, daily);
          } catch {
            messages.push(file.name + "：已导入，跨重启缓存写入失败");
          }
        } else {
          files.set(record.total ? key : site + ":" + key, {
            ...record, source: file, ccdFiltered: /_CCD-B_/i.test(file.name),
          });
        }
      } catch (error) {
        messages.push(file.name + "：" + error.message);
      }
    }
  } finally {
    importing = false;
  }
  note(messages.length ? messages.join("\n") : "导入完成");
  render();
}

date.value = chinaDate();
const requested = params.get("site");
for (const site of sites) {
  scope.add(new Option(site.name, site.id));
  const label = document.createElement("label");
  label.textContent = site.name + " ";
  const select = document.createElement("input");
  select.type = "file";
  select.accept = ".csv,.tsv";
  select.multiple = true;
  select.addEventListener("change", () => {
    const selection = [...select.files];
    select.value = "";
    if (selection.length) void importFiles(site.id, selection).catch(error => note(error.message));
  });
  label.append(select);
  byId("imports").append(label);
}
if (sites.some(site => site.id === requested)) scope.value = requested;

byId("open-grading").addEventListener("click", () => {
  void openPages("grading", scope.value).catch(error => note(error.message));
});
function showDate() {
  render();
  if (date.value && date.validity.valid) void restoreDaily(date.value).then(render);
}
for (const input of [mode, scope]) input.addEventListener("change", render);
date.addEventListener("change", showDate);
showDate();
