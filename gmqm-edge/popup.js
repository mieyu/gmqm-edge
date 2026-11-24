import { siteForUrl, sites, validAccount } from "./sites.js";
import { pageTools } from "./workspace.js";

const byId = id => document.getElementById(id);
const scope = byId("scope");
const setup = byId("setup");
const edit = byId("edit");
const results = byId("results");
const actionButtons = [...document.querySelectorAll("[data-action]")];
const pageButtons = [];
const entries = [
  { id: "normal", name: "GMQM 普通用户（四站共用）" },
  { id: "fbrain", name: "F.Brain 普通用户（公司、无锡）" },
  ...sites.map(site => ({ id: site.id, name: site.name + "管理员" })),
];
const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
const params = new URL(location.href).searchParams;
const hostId = Number(params.get("host")) || currentTab?.windowId;
let savedAccounts;
let status;
let busy = false;
let editing = false;

function showNotice(message = "") {
  const notice = byId("notice");
  notice.textContent = message;
  notice.hidden = !message;
}

function render() {
  const running = busy || !!status?.running;
  const normal = validAccount(savedAccounts?.normal);
  const fbrain = validAccount(savedAccounts?.fbrain);
  byId("account-state").textContent = `GMQM 普通账号${normal ? "已保存" : "待设置"} · F.Brain 普通账号${fbrain ? "已保存" : "待设置"}`;
  const targets = scope.value === "all" ? sites : sites.filter(site => site.id === scope.value);
  scope.disabled = running;
  for (const button of actionButtons) {
    button.disabled = running || (button.dataset.action === "normal" && !normal) ||
      (button.dataset.action === "admin" && !targets.every(site=>validAccount(savedAccounts?.[site.id])));
  }
  for (const button of pageButtons) button.disabled = running;
  setup.hidden = !editing;
  edit.parentElement.hidden = editing;
  edit.disabled = running;
  for (const button of setup.querySelectorAll("button")) button.disabled = running;
  results.hidden = !status?.rows.length;
  results.replaceChildren(...(status?.rows ?? []).map(row => {
    const line = document.createElement("li");
    line.className = row.kind;
    const name = document.createElement("strong");
    name.textContent = sites.find(site => site.id === row.id)?.name ?? "";
    line.append(name, document.createTextNode(row.message));
    if (row.tabId !== undefined) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "打开";
      button.addEventListener("click", async () => {
        try {
          const tab = await chrome.tabs.update(row.tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {
          showNotice("该标签页已关闭");
        }
      });
      line.append(button);
    }
    return line;
  }));
}

function buildAccountFields() {
  for (const entry of entries) {
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = entry.name;
    group.append(legend);
    for (const [name, title] of [["username", "账号"], ["password", "密码"]]) {
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = title;
      const input = document.createElement("input");
      input.name = entry.id + "-" + name;
      input.type = name === "password" ? "password" : "text";
      input.autocomplete = "off";
      label.append(input);
      group.append(label);
    }
    byId("accounts").append(group);
  }
}

async function refresh() {
  const local = await chrome.storage.local.get("accounts");
  const session = await chrome.storage.session.get("status");
  savedAccounts = local.accounts;
  status = session.status;
  render();
}

async function handleForm(form, work) {
  if (busy || status?.running) return;
  busy = true;
  showNotice();
  render();
  try {
    await work(new FormData(form));
    form.reset();
  } catch (error) {
    showNotice(error.message);
  } finally {
    busy = false;
    await refresh();
  }
}

scope.add(new Option("全部四站", "all"));
for (const site of sites) scope.add(new Option(site.name, site.id));
scope.value = sites.some(site => site.id === params.get("site"))
  ? params.get("site") : siteForUrl(currentTab?.url)?.id ?? "all";
buildAccountFields();
scope.addEventListener("change",render);

for (const tool of pageTools) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = tool.label;
  button.addEventListener("click", async () => {
    if (busy || status?.running) return;
    busy = true;
    showNotice();
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "open-pages", toolId: tool.id, scope: scope.value, windowId: hostId,
      });
      if (response?.error) showNotice(response.error);
      else if (response?.opened < response?.total) {
        showNotice(`已打开 ${response.opened}/${response.total} 个页面`);
      }
    } catch {
      showNotice("无法打开页面，请重试");
    } finally {
      busy = false;
      render();
    }
  });
  pageButtons.push(button);
  byId("page-tools").append(button);
}

edit.addEventListener("click", async () => {
  const { accounts } = await chrome.storage.local.get("accounts");
  for (const entry of entries) {
    const account = accounts?.[entry.id];
    setup.elements.namedItem(entry.id + "-username").value = account?.username ?? "";
    setup.elements.namedItem(entry.id + "-password").value = account?.password ?? "";
  }
  editing = true;
  render();
});

byId("cancel").addEventListener("click", () => {
  setup.reset();
  showNotice();
  editing = false;
  render();
});

setup.addEventListener("submit", event => {
  event.preventDefault();
  void handleForm(setup, async data => {
    const accounts = Object.fromEntries(entries.map(({ id }) => [id, {
      username: data.get(id + "-username").trim(),
      password: data.get(id + "-password"),
    }]));
    const configured = Object.entries(accounts).filter(([,account])=>account.username || account.password);
    if (configured.some(([,account])=>!validAccount(account))) throw new Error("已填写的账号请同时填写密码");
    try {
      await chrome.storage.local.set({ accounts:Object.fromEntries(configured) });
    } catch {
      throw new Error("无法保存凭据，请重试");
    }
    editing = false;
  });
});

for (const button of actionButtons) {
  button.addEventListener("click", async () => {
    if (busy || status?.running) return;
    busy = true;
    showNotice();
    render();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "run", action: button.dataset.action, scope: scope.value, tabId: currentTab?.id,
        windowId: hostId,
      });
      if (response?.error) showNotice(response.error);
    } catch {
      showNotice("无法连接后台，请重新打开工具");
    } finally {
      busy = false;
      await refresh();
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.status) {
    status = changes.status.newValue;
    render();
  }
});
await refresh();
