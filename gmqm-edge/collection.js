import { collectionPage } from "./collection-page.js";
import { sites } from "./sites.js";
import { collectionPlan, films, labels, sampleNumbers } from "./sop.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let pageQueue = Promise.resolve();

export function jobsForDay(day, scope, files, mode = "collection") {
  const records = files.flatMap(file => file.rows);
  return collectionPlan(mode, day)
    .filter(entry => scope === "all" || entry.site === scope)
    .map(entry => ({
      hasSource: files.some(file => file.site === entry.site && (!file.total || file.outside < file.total)),
      ...entry, sns: entry.defects.length ? sampleNumbers(records, entry) : [],
      ...(mode === "insect" ? { ccdOnly: true, labelNames: labels, labelFilms: films } : {}),
    }));
}

async function siteTab(site, windowId, existingId) {
  const url = site.origin + "/#/samplingSampleLibrary";
  const tab = Number.isInteger(existingId)
    ? await chrome.tabs.update(existingId, { url })
    : await chrome.tabs.create({ url, active: false, windowId });
  const end = Date.now() + 15_000;
  do {
    const current = await chrome.tabs.get(tab.id);
    if (current.status === "complete" && current.url !== site.origin + "/#/ej/etc") return current;
    await pause(350);
  } while (Date.now() < end);
  return chrome.tabs.get(tab.id);
}

function runOnPage(tabId, origin, job, phase) {
  const operation = pageQueue.then(async () => {
    try {
      // Run one site's controls at a time on the active tab, without focusing its window.
      await chrome.tabs.update(tabId, { active: true });
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId }, func: collectionPage,
        args: [origin, phase === "submit" ? job : { ...job, sns: [] }, phase],
      });
      return execution?.result ?? { state: "uncertain", message: "页面没有返回结果，请核对平台" };
    } catch {
      return { state: "uncertain", message: "页面操作中断，请核对平台状态" };
    }
  });
  pageQueue = operation.then(() => {});
  return operation;
}

async function runSite(site, jobs, options) {
  const { windowId, update } = options;
  const due = jobs.filter(job => job.hasSource);
  for (const job of jobs.filter(job => !due.includes(job))) {
    update(job, { state: "skipped", message: "该站没有已核对的判等结果" });
  }
  if (!due.length) return;
  let tab;
  try {
    tab = await siteTab(site, windowId, options.tabs?.get(site.id));
  } catch {
    for (const job of due) update(job, { state: "error", message: "样本图库网页未打开" });
    return;
  }
  const report = (job, result) => update(job, { ...result, tabId: tab.id });
  const finishLabels = async (job, result) => {
    if (!job.labelNames || !["saved", "existing"].includes(result.state) || result.count === undefined ||
        (result.count === 0 && result.state === "saved")) return;
    report(job, { ...result, state: "tagging", message: "图片已在图库，正在核对六类标签" });
    const tagged = await runOnPage(tab.id, site.origin, job, "labels");
    report(job, { ...tagged, count: result.count, byDefect: result.byDefect, importedThisRun: result.state === "saved" });
  };
  const pending = [];
  for (const job of due) {
    report(job, { state: "running", message: "正在处理图库" });
    const empty = job.defects.length && !job.sns.length;
    const result = await runOnPage(tab.id, site.origin, empty ? { ...job, defects: [] } : job, "submit");
    if (empty && result.state === "built") result.message = "图库已就绪 · 无可采集 SN";
    report(job, result);
    await finishLabels(job, result);
    if (!empty && job.defects.length && ["submitted", "uncertain"].includes(result.state)) pending.push(job);
  }
  const end = Date.now() + 20 * 60_000;
  while (pending.length && Date.now() < end) {
    for (const job of pending.splice(0)) {
      const result = await runOnPage(tab.id, site.origin, job, "confirm");
      report(job, result);
      await finishLabels(job, result);
      if (result.state === "pending") pending.push(job);
    }
    if (pending.length) await pause(12_000);
  }
  for (const job of pending) {
    report(job, { state: "uncertain", message: "平台仍在采集，请查看该图库" });
  }
}

export async function runCollection(jobs, options) {
  const groups = sites.filter(site => jobs.some(job => job.site === site.id));
  await Promise.all(groups.map(site =>
    runSite(site, jobs.filter(job => job.site === site.id), options)));
}

export async function runInsectLabels(jobs, {windowId, update}) {
  for (const job of jobs) {
    update(job, {state: "tagging", message: "正在逐膜种补标签"});
    try {
      const site = sites.find(site => site.id === job.site);
      const url = site.origin + "/#/samplingSampleLibrary";
      const existing = (await chrome.tabs.query({windowId})).find(tab => tab.url === url);
      const tab = existing ?? await siteTab(site, windowId);
      const result = await runOnPage(tab.id, site.origin, job, "labels");
      update(job, { ...result, tabId: tab.id });
    } catch {
      update(job, {state: "error", message: "无法读取当天图库的标签"});
    }
  }
}
