import { sites } from "./sites.js";
import { brain } from "./model-rules.js";
import { ensureNormalSession } from "./normal-login.js";

export const pageTools = [
  { id: "grading", label: "自动判等查询", path: "/#/ej/etc" },
  { id: "samples", label: "样本图库", path: "/#/samplingSampleLibrary" },
  { id: "fbrain", label: "F.Brain 普通用户登录", urls: Object.values(brain).map(origin => origin + "/#/home") },
];

export function workPages(toolId, scope) {
  const tool = pageTools.find(item => item.id === toolId);
  if (!tool) return [];
  if (tool.urls) return tool.urls;
  const targets = scope === "all" ? sites : sites.filter(site => site.id === scope);
  return targets.map(site => site.origin + tool.path);
}

export async function workWindow(preferred) {
  if (Number.isInteger(preferred)) {
    try {
      const window = await chrome.windows.get(preferred);
      if (window.type === "normal") return window.id;
    } catch {
      // The original Edge window may have been closed.
    }
  }
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const available = windows.find(window => window.focused) ?? windows[0];
  if (!available) throw new Error("请先打开一个普通 Edge 窗口");
  return available.id;
}
export async function openWorkPages(toolId, scope, windowId) {
  const urls = workPages(toolId, scope);
  if (!urls.length) return { error: "没有可打开的工作页面" };
  const windowQuery = Number.isInteger(windowId) ? { windowId } : { currentWindow: true };
  const tabs = await chrome.tabs.query(windowQuery);
  let opened = 0;
  let first;
  const errors = [];
  for (const url of urls) {
    try {
      const existing = tabs.find(tab => tab.url === url || tab.pendingUrl === url);
      const tab = existing ?? await chrome.tabs.create({ url, active: false, ...(
        Number.isInteger(windowId) ? { windowId } : {}
      ) });
      first ??= tab.id;
      opened += 1;
      await ensureNormalSession(tab.id,url);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!opened) return { error: "浏览器未能打开工作页面" };
  const focused = await chrome.tabs.update(first, { active: true });
  if (Number.isInteger(focused?.windowId)) await chrome.windows.update(focused.windowId, { focused: true });
  return errors.length ? {opened,total:urls.length,error:errors.join("；")} : {opened,total:urls.length};
}
