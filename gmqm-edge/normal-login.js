import { pageAction } from "./page.js";
import { brain } from "./model-rules.js";
import { sites, validAccount } from "./sites.js";

const loginHash = /^#\/login(?:[/?]|$)/;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));

export async function ensureNormalSession(tabId, target, check = () => {}) {
  const origin = new URL(target).origin;
  const site = sites.find(entry => entry.origin === origin);
  const isBrain = origin === brain.company || origin === brain.wuxi;
  if (!site && !isBrain) throw new Error("无法识别工作平台");
  const name = site ? site.name + " GMQM" : (origin === brain.company ? "公司" : "无锡") + " F.Brain";
  const accountKey = isBrain ? "fbrain" : "normal";
  const accountLabel = isBrain ? "F.Brain 普通用户" : "GMQM 普通用户";
  let account;
  let submitted = false;
  let redirected = false;
  let sawLogin = false;
  const deadline = Date.now() + 45_000;
  do {
    check();
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url?.startsWith(origin + "/")) {
      if (loginHash.test(new URL(tab.url).hash)) {
        sawLogin = true;
        if (!submitted) {
          account ??= (await chrome.storage.local.get("accounts")).accounts?.[accountKey];
          if (!validAccount(account)) throw new Error(name + " 未登录，请在「设置账号」填写「" + accountLabel + "」的账号和密码");
          check();
          let outcome;
          try {
            [outcome] = await chrome.scripting.executeScript({target:{tabId},func:pageAction,
              args:[origin,"login",account,isBrain ? "fbrain" : "gmqm"]});
          } catch (error) {
            const current = await chrome.tabs.get(tabId);
            if (current.url === tab.url) throw error;
          }
          submitted = outcome?.result?.state === "submitted";
        }
      } else if (tab.url === target) {
        return tab;
      } else if (sawLogin && !redirected) {
        redirected = true;
        await chrome.tabs.update(tabId,{url:target});
      }
    }
    await pause(350);
  } while (Date.now() < deadline);
  throw new Error(name + (submitted ? " 未确认普通账号登录，请查看平台登录提示" :
    sawLogin ? " 未识别到可用的登录表单" : " 工作页面未就绪"));
}
