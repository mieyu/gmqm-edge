import assert from "node:assert/strict";
import test from "node:test";
import { pageAction } from "../gmqm-edge/page.js";
import { brain } from "../gmqm-edge/model-rules.js";
import { ensureNormalSession } from "../gmqm-edge/normal-login.js";
import { sites } from "../gmqm-edge/sites.js";
import { openWorkPages, workPages } from "../gmqm-edge/workspace.js";

function mountLogout(t, options) {
  let clicked = 0;
  const [site] = sites;
  const tabWindow = {};
  tabWindow.top = tabWindow;
  t.mock.method(globalThis, "setTimeout", () => assert.fail("Logout should use the mounted menu item"));
  globalThis.window = tabWindow;
  globalThis.location = new URL(site.origin + "/#/home");
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  const profile = {
    getClientRects: () => [1],
    querySelector: () => ({}),
    innerText: "test-user",
    click: () => assert.fail("Logout should not have to open the menu"),
  };
  const logout = {
    textContent: "退出登录",
    classList: { contains: () => options.disabled },
    getAttribute: () => null,
    getClientRects: () => [],
    click: () => { clicked += 1; },
  };
  globalThis.document = {
    querySelectorAll(selector) {
      if (selector.startsWith(".ivu-dropdown-rel")) return [profile];
      if (selector.startsWith(".ivu-dropdown-transfer")) {
        return options.duplicate ? [logout, logout] : [logout];
      }
      return [];
    },
  };
  t.after(() => {
    for (const key of ["window", "location", "getComputedStyle", "document"]) delete globalThis[key];
  });
  return { origin: site.origin, clicks: () => clicked };
}

test("uses the unique mounted logout item while its dropdown is hidden", async t => {
  const page = mountLogout(t, {});
  assert.deepEqual(await pageAction(page.origin, "logout"), { state: "submitted" });
  assert.equal(page.clicks(), 1);
});

test("skips disabled or ambiguous logout items", async t => {
  const options = { disabled: true };
  const page = mountLogout(t, options);
  assert.deepEqual(await pageAction(page.origin, "logout"), { state: "unavailable" });
  options.disabled = false;
  options.duplicate = true;
  assert.deepEqual(await pageAction(page.origin, "logout"), { state: "unavailable" });
  assert.equal(page.clicks(), 0);
});

test("opens the chosen site's work page and reuses an exact existing match", async t => {
  const [url] = workPages("samples", "wuxi");
  assert.equal(url, sites[0].origin + "/#/samplingSampleLibrary");
  assert.equal(workPages("grading", "all").length, 4);
  assert.equal(workPages("fbrain", "all").length, 2);
  assert.deepEqual(workPages("unknown", "all"), []);
  globalThis.chrome = { tabs: {
    query: async query => {
      assert.deepEqual(query, { windowId: 42 });
      return [{ id: 7, url }];
    },
    create: async () => assert.fail("Exact existing match should be reused"),
    get: async id => ({id,url,status:"complete"}),
    update: async (id, update) => {
      assert.equal(id, 7);
      assert.deepEqual(update, { active: true });
    },
  } };
  t.after(() => { delete globalThis.chrome; });
  assert.deepEqual(await openWorkPages("samples", "wuxi", 42), { opened: 1, total: 1 });
});

test("uses the F.Brain phone login form even when the password field is visible text", async t => {
  const origin = brain.company;
  class Input {
    text = "";
    get value() { return this.text; }
    set value(value) { this.text = value; }
    getClientRects() { return [1]; }
    dispatchEvent() {}
  }
  const phone = new Input();
  const password = Object.assign(new Input(),{type:"text"});
  let clicks = 0;
  const button = {textContent:"登录",getClientRects:()=>[1],classList:{contains:()=>false},click:()=>{clicks++;}};
  globalThis.window = {};
  globalThis.window.top = globalThis.window;
  globalThis.location = new URL(origin + "/#/login");
  globalThis.HTMLInputElement = Input;
  globalThis.getComputedStyle = () => ({visibility:"visible"});
  globalThis.document = {querySelectorAll(selector) {
    if (selector === 'input[placeholder="请输入手机号码"]') return [phone];
    if (selector === 'input.ivu-input[placeholder="请输入密码"]') return [password];
    if (selector === "button.ivu-btn-primary.ivu-btn-long") return [button];
    return [];
  }};
  t.after(()=>{ for (const key of ["window","location","HTMLInputElement","getComputedStyle","document"]) delete globalThis[key]; });
  const account = {username:"fixture-user",password:"fixture-password"};
  assert.deepEqual(await pageAction(origin,"login",account,"fbrain"),{state:"submitted"});
  assert.equal(phone.value,account.username);
  assert.equal(password.value,account.password);
  assert.equal(clicks,1);
});

test("uses each platform's ordinary account and reopens the requested page", async t => {
  t.after(()=>{delete globalThis.chrome;});
  const accounts = {
    normal:{username:"test-gmqm",password:"gmqm-fixture"},
    fbrain:{username:"test-brain",password:"brain-fixture"},
    wuxi:{username:"test-admin",password:"admin-fixture"},
  };
  for (const [origin,platform,account] of [
    [brain.company,"fbrain",accounts.fbrain],
    [brain.wuxi,"fbrain",accounts.fbrain],
    [sites[0].origin,"gmqm",accounts.normal],
  ]) {
    const target = origin + "/#/work";
    const tab = {id:1,url:origin+"/#/login",status:"complete"};
    let logins = 0;
    globalThis.chrome = {
      tabs:{get:async()=>tab,update:async (_id,change)=>Object.assign(tab,change)},
      storage:{local:{get:async()=>({accounts})}},
      scripting:{executeScript:async ({args})=>{
        assert.deepEqual(args,[origin,"login",account,platform]);
        logins++;
        tab.url = origin + "/#/home";
        return [{result:{state:"submitted"}}];
      }},
    };
    assert.equal((await ensureNormalSession(1,target)).url,target);
    await ensureNormalSession(1,target);
    assert.equal(logins,1);
  }
});

test("an existing GMQM account is never submitted to F.Brain", async t => {
  t.after(()=>{delete globalThis.chrome;});
  const target = brain.company + "/#/work";
  const tab = {id:1,url:brain.company+"/#/login",status:"complete"};
  let submits = 0;
  globalThis.chrome = {
    tabs:{get:async()=>tab},
    storage:{local:{get:async()=>({accounts:{normal:{username:"test-gmqm",password:"gmqm-fixture"}}})}},
    scripting:{executeScript:async()=>{submits++;}},
  };
  await assert.rejects(ensureNormalSession(1,target),/设置账号.*F\.Brain 普通用户/);
  tab.url = target;
  assert.equal(await ensureNormalSession(1,target),tab);
  assert.equal(submits,0);
});
