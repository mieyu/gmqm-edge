// Edge injects this function alone into the isolated world of the target tab.
export async function pageAction(origin, action, account) {
  if (window.top !== window || location.origin !== origin) return { state: "wrong-site" };

  const visible = (selector, predicate = () => true) =>
    [...document.querySelectorAll(selector)].filter(element =>
      element.getClientRects().length && getComputedStyle(element).visibility === "visible" &&
      predicate(element));
  const one = elements => elements.length === 1 ? elements[0] : null;
  const loginRoute = /^#\/login(?:[/?]|$)/.test(location.hash);
  const username = one(visible('input[type="text"][placeholder="请输入用户名"]'));
  const password = one(visible('input[type="password"][placeholder="请输入密码"]'));
  const submit = one(visible("button.login-btn", element => element.textContent.trim() === "登录"));
  const profile = one(visible('.ivu-dropdown-rel > a[href="javascript:void(0)"]',
    element => element.querySelector('img[alt="logo"]') && element.innerText.trim()));

  if (loginRoute && username && password && submit) {
    if (action !== "login") return { state: "signed-out" };
    if (submit.disabled || submit.classList.contains("ivu-btn-loading")) return { state: "busy" };
    if (username.disabled || username.readOnly || password.disabled || password.readOnly) {
      return { state: "unavailable" };
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    const fill = (element, value) => {
      setValue.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    fill(username, account.username);
    fill(password, account.password);
    if (username.value !== account.username || password.value !== account.password) {
      return { state: "unavailable" };
    }
    submit.click();
    return { state: "submitted" };
  }

  if (!loginRoute && profile) {
    const matches = !!account && profile.innerText.trim() === account.username;
    if (action !== "logout") return { state: "signed-in", matches };
    // GMQM keeps the mounted logout item inside a hidden dropdown.
    const logout = one([...document.querySelectorAll(
      ".ivu-dropdown-transfer .ivu-dropdown-menu > li.ivu-dropdown-item",
    )].filter(item => item.textContent.trim() === "退出登录" &&
      !item.classList.contains("ivu-dropdown-item-disabled") &&
      item.getAttribute("aria-disabled") !== "true"));
    if (!logout) return { state: "unavailable" };
    logout.click();
    return { state: "submitted" };
  }
  return { state: "waiting" };
}
