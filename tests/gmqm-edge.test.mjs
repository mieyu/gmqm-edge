import assert from "node:assert/strict";
import test from "node:test";
import { pageAction } from "../gmqm-edge/page.js";
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
    update: async (id, update) => {
      assert.equal(id, 7);
      assert.deepEqual(update, { active: true });
    },
  } };
  t.after(() => { delete globalThis.chrome; });
  assert.deepEqual(await openWorkPages("samples", "wuxi", 42), { opened: 1, total: 1 });
});
