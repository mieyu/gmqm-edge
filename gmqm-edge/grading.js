import { exportCapture } from "./export-capture.js";
import { gradingPage } from "./grading-page.js";
import { pageAction } from "./page.js";
import { collectionPlan, previousDay, readExport } from "./sop.js";
import { sites } from "./sites.js";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const chunkSize = 1_048_576;
const fullNames = { wuxi: "无锡恩捷", jintan: "金坛恩捷", suzhou: "苏州捷力", hubei: "湖北恩捷" };

export function gradingTargets(mode, scope, day) {
  const planned = new Set(mode === "review" ? sites.map(site => site.id) :
    collectionPlan(mode, day).map(entry => entry.site));
  return sites.filter(site => planned.has(site.id) && (scope === "all" || site.id === scope));
}

async function execute(tabId, func, args, world = "ISOLATED") {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world });
  if (result?.error) throw new Error(result.error);
  return result?.result;
}

async function prepareTab(tabId, site, days, account) {
  const end = Date.now() + 60_000;
  let loginSubmitted = false;
  let sawHome = false;
  do {
    const observed = await chrome.tabs.get(tabId);
    if (observed.url?.startsWith(site.origin + "/")) {
      let state;
      try {
        state = (await execute(tabId, gradingPage, [site.origin, "probe", days]))?.state;
      } catch {
        // A document replacement can overlap the first probe.
      }
      if (state === "ready") {
        await pause(450);
        const settled = await execute(tabId, gradingPage, [site.origin, "probe", days]).catch(() => null);
        if (settled?.state === "ready") return;
      }
      if (state === "signed-out" && !loginSubmitted) {
        if (!account?.username || !account?.password) throw new Error("站点未登录，扩展尚未保存普通账号");
        const sent = await execute(tabId, pageAction, [site.origin, "login", account]);
        loginSubmitted = sent?.state === "submitted";
      }
      if (loginSubmitted && !sawHome && observed.url.includes("/#/home")) {
        sawHome = true;
        await chrome.tabs.update(tabId, { url: site.origin + "/#/ej/etc" });
      }
    }
    await pause(350);
  } while (Date.now() < end);
  throw new Error(loginSubmitted ? "普通账号登录后，自动判等页仍未就绪" :
    "自动判等页的筛选控件在 60 秒内未就绪，尚未查询");
}

async function captureCsv(tabId, origin, days, filename) {
  const key = "__gmqm_csv_" + crypto.randomUUID().replaceAll("-", "");
  const capture = (action, value = null) => execute(tabId, exportCapture, [origin, key, action, value], "MAIN");
  try {
    if (!(await capture("arm", filename))?.armed) throw new Error("无法准备判等导出");
    const exported = await execute(tabId, gradingPage, [origin, "export", days]);
    if (exported?.state !== "export-triggered") throw new Error(exported?.message ?? "没有触发判等导出");
    const end = Date.now() + 120_000;
    let size = 0;
    do {
      size = (await capture("status"))?.size ?? 0;
      if (size) break;
      await pause(450);
    } while (Date.now() < end);
    if (!size) throw new Error("已点击平台导出，但插件未取得文件内容。可导入浏览器下载的原文件");
    const bytes = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += chunkSize) {
      const data = await capture("read", offset);
      if (typeof data !== "string") throw new Error("读取导出文件时页面已改变");
      const binary = atob(data);
      if (binary.length !== Math.min(chunkSize, size - offset)) throw new Error("导出文件读取不完整");
      for (let index = 0; index < binary.length; index += 1) bytes[offset + index] = binary.charCodeAt(index);
    }
    return bytes;
  } finally {
    await capture("release").catch(() => {});
  }
}

async function querySite(site, day, windowId, account, report) {
  const days = [previousDay(day), day];
  const tab = await chrome.tabs.create({ url: site.origin + "/#/ej/etc", active: false, windowId });
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await prepareTab(tab.id, site, days, account);
    report(site, "正在查询全膜种、全 CCD 等级");
    const result = await execute(tab.id, gradingPage, [site.origin, "query", days]);
    if (result?.state !== "queried") throw new Error(result?.message ?? "判等查询未完成");
    if (result.total === 0) {
      return { filename: result.production + "（查询 0 条）", site: site.id, total: 0,
        outside: 0, missing: 0, films: [], rows: [], tabId: tab.id, production: result.production };
    }
    report(site, "已查到 " + result.total + " 条，正在导出");
    const stamp = days.map(value => value.replaceAll("-", "")).join("-");
    const filename = "GMQM_" + fullNames[site.id] + "_全量_生产" + stamp + "_判等结果.csv";
    const bytes = await captureCsv(tab.id, site.origin, days, filename);
    const record = readExport(bytes, site.id, filename, day);
    if (record.total !== result.total || record.outside) {
      throw new Error("整站导出与查询行数或日期不一致，尚未用于后续操作");
    }
    return { ...record, tabId: tab.id, production: result.production, source: new Blob([bytes], {type: "text/csv"}) };
  } catch (error) {
    return { site: site.id, tabId: tab.id, error: error.message };
  }
}

export async function queryAndExport(targets, day, windowId, report) {
  const { accounts } = await chrome.storage.local.get("accounts");
  const results = [];
  for (const site of targets) report(site, "等待查询");
  for (const site of targets) {
    report(site, "正在打开自动判等");
    let result;
    try {
      result = await querySite(site, day, windowId, accounts?.normal, report);
    } catch (error) {
      result = { site: site.id, error: error.message };
    }
    const summary = result.error ?? (result.total
      ? "已导出并核对 " + result.total + " 条 · " + result.production
      : "查询为 0 条 · " + result.production);
    report(site, summary, result);
    results.push(result);
  }
  return results;
}

export async function openReviewQuery(site, day, windowId, review) {
  const { accounts } = await chrome.storage.local.get("accounts");
  const days = [previousDay(day), day];
  const tab = await chrome.tabs.create({ url: site.origin + "/#/ej/etc", active: true, windowId });
  try {
    await prepareTab(tab.id, site, days, accounts?.normal);
    const result = await execute(tab.id, gradingPage, [site.origin, "review", days, review]);
    if (result?.state !== "queried") throw new Error(result?.message ?? "回查未完成");
    await chrome.windows.update(windowId, { focused: true });
    return result;
  } catch (error) {
    return { error: error.message, tabId: tab.id };
  }
}
