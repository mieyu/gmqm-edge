import { pageAction } from "./page.js";
import { siteForUrl, sites, validAccount } from "./sites.js";
import { openWorkPages } from "./workspace.js";

let running = false;
const loginHash = /^#\/login(?:[/?]|$)/;
const actions = new Set(["normal", "admin", "logout"]);
const pause = () => new Promise(resolve => setTimeout(resolve, 350));

async function onPage(tabId, site, action, account) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageAction,
    args: [site.origin, action, account ?? null],
  });
  return result.result;
}

async function waitFor(tabId, site, account, accept, timeout = 15_000) {
  const expiry = Date.now() + timeout;
  do {
    const tab = await chrome.tabs.get(tabId);
    const tabSite = siteForUrl(tab.pendingUrl ?? tab.url);
    if (tabSite && tabSite.id !== site.id) throw new Error("站点已改变");
    if (tabSite) {
      let observed;
      try {
        observed = await onPage(tabId, site, "probe", account);
      } catch {
        // Edge may replace the document while a route is loading.
      }
      if (observed && accept(observed)) return observed;
    }
    await pause();
  } while (Date.now() < expiry);
  return null;
}

async function findTab(site, preferredTabId, action, windowId) {
  const tabs = (await chrome.tabs.query({})).filter(tab => siteForUrl(tab.url)?.id === site.id);
  const homeUrl = site.origin + "/#/home";
  const signedInRoute = tab => !loginHash.test(new URL(tab.url).hash);
  const tab = tabs.find(tab => tab.id === preferredTabId && signedInRoute(tab)) ??
    tabs.find(signedInRoute) ?? tabs.find(tab => tab.id === preferredTabId) ?? tabs[0];
  if (!tab) return chrome.tabs.create({ url: homeUrl, active: false, windowId });

  // A stale login tab may coexist with a session established in another tab.
  if (action === "logout" && !signedInRoute(tab)) {
    return chrome.tabs.update(tab.id, { url: homeUrl });
  }
  return tab;
}

async function runSite(site, preferredTabId, action, account, windowId) {
  const tab = await findTab(site, preferredTabId, action, windowId);
  const report = (kind, message) => ({ id: site.id, tabId: tab.id, kind, message });
  const initial = await waitFor(tab.id, site, account, result =>
    result.state === "signed-in" || result.state === "signed-out");
  if (!initial) return report("error", "未识别到 GMQM 登录或账号入口");

  if (initial.state === "signed-in" && initial.matches) {
    return report("ok", "所选账号已登录");
  }
  if (initial.state === "signed-in") {
    const sent = await onPage(tab.id, site, "logout");
    if (sent.state !== "submitted") return report("error", "未找到可操作的退出入口");
    if (!await waitFor(tab.id, site, null, result => result.state === "signed-out")) {
      return report("error", "尚未确认退出，请检查该标签页");
    }
    if (action === "logout") return report("ok", "已退出");
  } else if (action === "logout") {
    return report("ok", "当前已退出");
  }

  const sent = await onPage(tab.id, site, "login", account);
  if (sent.state !== "submitted") return report("error", "未能提交登录，请检查页面");
  const verified = await waitFor(tab.id, site, account, result => result.state === "signed-in");
  if (!verified) return report("error", "未确认登录成功，请检查站点提示");
  return verified.matches
    ? report("ok", "登录成功，账号已核对")
    : report("warn", "已进入平台，请核对页面显示的账号");
}

async function run(message) {
  if (running) return { error: "已有任务在运行" };
  if (!actions.has(message.action)) return { error: "无法识别任务" };
  const targets = message.scope === "all" ? sites : sites.filter(site => site.id === message.scope);
  if (!targets.length) return { error: "请选择站点" };
  running = true;
  try {
    const accounts = message.action === "logout"
      ? null
      : (await chrome.storage.local.get("accounts")).accounts;
    if (message.action === "normal" && !validAccount(accounts?.normal)) return {error:"请先设置普通账号"};
    if (message.action === "admin" && targets.some(site=>!validAccount(accounts?.[site.id]))) {
      return {error:"请先设置所选站点的管理员账号"};
    }
    const status = { running: true, rows: targets.map(site =>
      ({ id: site.id, kind: "pending", message: "等待处理" })) };
    await chrome.storage.session.set({ status });
    for (const [index, site] of targets.entries()) {
      status.rows[index] = { id: site.id, kind: "pending", message: "处理中…" };
      await chrome.storage.session.set({ status });
      const account = message.action === "normal" ? accounts.normal :
        message.action === "admin" ? accounts[site.id] : null;
      try {
        status.rows[index] = await runSite(site, message.tabId, message.action, account, message.windowId);
      } catch {
        status.rows[index] = { id: site.id, kind: "error", message: "浏览器操作中断，请检查站点" };
      }
      await chrome.storage.session.set({ status });
    }
    status.running = false;
    await chrome.storage.session.set({ status });
    return {};
  } finally {
    running = false;
  }
}

// A terminated worker cannot resume an ambiguous login/logout submission.
const ready = (async () => {
  const { status } = await chrome.storage.session.get("status");
  if (status?.running) {
    status.running = false;
    status.rows = status.rows.map(row => row.kind === "pending"
      ? { ...row, kind: "error", message: "上次操作中断，请查看站点状态" } : row);
    await chrome.storage.session.set({ status });
  }
})();

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("popup.html") ||
      !["run", "open-pages"].includes(message?.type)) return false;
  ready.then(() => message.type === "run"
    ? run(message)
    : openWorkPages(message.toolId, message.scope, message.windowId))
    .then(reply, () => reply({ error: "任务中断，请检查各站状态" }));
  return true;
});

let panelOpening = false;
chrome.action.onClicked.addListener(async tab => {
  if (panelOpening) return;
  panelOpening = true;
  try {
    const { panelId } = await chrome.storage.session.get("panelId");
    if (Number.isInteger(panelId)) {
      try {
        const panel = await chrome.windows.get(panelId);
        if (panel.state === "minimized") await chrome.windows.update(panelId, { state: "normal" });
        await chrome.windows.update(panelId, { focused: true });
        return;
      } catch {
        // Recreate the panel if the user closed it.
      }
    }
    const params = new URLSearchParams({ site: siteForUrl(tab.url)?.id ?? "all", host: String(tab.windowId) });
    const panel = await chrome.windows.create({
      type: "popup", url: chrome.runtime.getURL("panel.html") + "?" + params,
      width: 580, height: 750, focused: true,
    });
    await chrome.storage.session.set({ panelId: panel.id });
  } finally {
    panelOpening = false;
  }
});
