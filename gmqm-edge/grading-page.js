// This function executes in the same document as the GMQM filter form.
export async function gradingPage(origin, action, days, review = null) {
  const login = /^#\/login(?:[/?]|$)/;
  const route = /^#\/ej\/etc(?:[/?]|$)/;
  const here = () => location.origin === origin && window.top === window;
  if (!here()) return { state: "waiting" };
  if (login.test(location.hash)) return { state: "signed-out" };
  if (!route.test(location.hash)) return { state: "waiting" };

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const present = element => element.getClientRects().length && getComputedStyle(element).visibility === "visible";
  const visible = (selector, root = document) => root ? [...root.querySelectorAll(selector)].filter(present) : [];
  const text = element => (element?.innerText ?? element?.textContent ?? "").trim();
  const one = list => list.length === 1 ? list[0] : null;
  const exact = (selector, label, root) => one(visible(selector, root).filter(element => text(element) === label));
  const button = (label, root) => one(visible("button", root).filter(element =>
    [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() === label) ||
    text(element) === label || text(element).split(/\s+/).at(-1) === label));
  const field = name => one(visible(".el-form-item").filter(element => text(element.querySelector("label")) === name));
  const input = name => visible("input", field(name))[0];
  const dateField = () => input("生产时间");
  const ccdField = () => input("CCD等级");
  const guard = () => {
    if (!here() || !route.test(location.hash)) throw new Error("自动判等页面已改变");
  };
  const wait = async (probe, error, timeout = 12_000) => {
    const end = Date.now() + timeout;
    do {
      guard();
      const value = probe();
      if (value) return value;
      await pause(100);
    } while (Date.now() < end);
    throw new Error(error);
  };
  const click = element => {
    if (!element || element.disabled || element.getAttribute("aria-disabled") === "true") {
      throw new Error("所需查询控件不可操作");
    }
    element.click();
  };
  const query = () => button("查询");
  const loading = () => !!query()?.classList.contains("is-loading") ||
    visible(".el-loading-mask").some(mask =>
      !mask.classList.contains("el-loading-fade-leave-active") &&
      Number(getComputedStyle(mask).opacity) > 0 &&
      (mask.closest(".el-table") || mask.classList.contains("is-fullscreen")));
  const total = () => {
    const str = text(one(visible(".el-pagination__total")));
    const amount = str.match(/共\s*([\d,]+)\s*条/)?.[1];
    if (amount) return Number(amount.replaceAll(",", ""));
    return null;
  };
  const range = () => dateField()?.value.match(/(\d{4}-\d{2}-\d{2})\s+(\d\d:\d\d:\d\d)\s*-\s*(\d{4}-\d{2}-\d{2})\s+(\d\d:\d\d:\d\d)/);
  const datesMatch = () => range()?.[1] === days[0] && range()?.[3] === days[1];
  const ready = () => dateField() && ccdField() && query() && !query().disabled && !loading();
  if (action === "probe") return { state: ready() ? "ready" : "waiting" };

  try {
    await wait(ready, "自动判等筛选条件加载超时，尚未提交查询", 30_000);
    const clearFilters = ["产品类别", "卷类别", "人工复判结果", "人工复判标记", "终判结果", "状态", "批支号/SN号"];
    const noExtra = (ignore = []) => clearFilters.every(name => ignore.includes(name) ||
      visible("input,textarea", field(name)).every(element => !element.value.trim()));
    const unfiltered = () => !ccdField().value.trim() && noExtra();
    if (action === "export") {
      if (!datesMatch() || !unfiltered() || total() === null || loading()) {
        throw new Error("导出前的日期、CCD 或筛选条件已改变");
      }
      const trigger = button("导出");
      if (!trigger || trigger.disabled) throw new Error("自动判等页的导出按钮不可用");
      const menuId = trigger.getAttribute("aria-controls");
      const mounted = () => {
        if (!menuId) return exact(".el-dropdown-menu__item", "判等结果");
        const menu = document.getElementById(menuId);
        return one([...(menu?.querySelectorAll(".el-dropdown-menu__item") ?? [])]
          .filter(element => element.textContent.trim() === "判等结果"));
      };
      if (!mounted()) {
        trigger.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true,
        }));
        await pause(350);
        if (!mounted()) click(trigger);
      }
      // The bound Element UI menu item already has its click handler while hidden.
      const option = await wait(mounted, "未找到导出按钮关联的「判等结果」菜单项");
      if (option.classList.contains("is-disabled") || option.getAttribute("aria-disabled") === "true") {
        throw new Error("平台已禁用「判等结果」导出");
      }
      click(option);
      return { state: "export-triggered" };
    }
    if (!unfiltered()) {
      click(button("重置"));
      await wait(() => unfiltered() && !loading(), "无法清除会影响整站导出的筛选条件");
    }
    if (!datesMatch()) {
      const panel = () => one(visible(".ivu-picker-panel-body-time"));
      if (!panel()) click(dateField().closest("a"));
      await wait(panel, "生产时间的日期面板未打开");
      const calendars = () => visible(".ivu-date-picker-header", panel()).map(header => {
        const value = text(header).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        let body = header.parentElement;
        while (body && body !== panel() && !body.querySelector(".ivu-date-picker-cells-cell")) {
          body = body.parentElement;
        }
        return { header, body, month: value ? Number(value[1]) * 12 + Number(value[2]) - 1 : NaN };
      }).filter(calendar => calendar.body && calendar.body !== panel() && Number.isFinite(calendar.month));
      const parseDay = day => {
        const parts = day.split("-").map(Number);
        return { month: parts[0] * 12 + parts[1] - 1, day: String(parts[2]) };
      };
      const start = parseDay(days[0]);
      const finish = parseDay(days[1]);
      await wait(() => calendars().length >= 2, "无法读取生产时间的年月");
      const inView = () => [start, finish].every(day => calendars().some(value => value.month === day.month));
      for (let attempt = 0; !inView() && attempt < 40; attempt++) {
        const startMonth = calendars()[0].month;
        const backwards = start.month < startMonth;
        const buttonClass = backwards ? ".ivu-date-picker-prev-btn-arrow" : ".ivu-date-picker-next-btn-arrow";
        click(one(visible(buttonClass, panel())));
        await wait(() => calendars()[0]?.month !== startMonth, "日历月份未切换", 1800);
      }
      const cellSelector = ".ivu-date-picker-cells-cell:not(.ivu-date-picker-cells-cell-prev-month)" +
        ":not(.ivu-date-picker-cells-cell-next-month):not(.ivu-date-picker-cells-cell-disabled)";
      const cell = day => {
        const calendar = calendars().find(value => value.month === day.month);
        return calendar && exact(cellSelector, day.day, calendar.body);
      };
      if (!cell(start) || !cell(finish)) throw new Error("目标日期超出当前可选范围");
      click(cell(start));
      await wait(() => cell(start)?.classList.contains("ivu-date-picker-cells-cell-selected"), "起始日未选中");
      click(cell(finish));
      await wait(() => [start, finish].every(day =>
        cell(day)?.classList.contains("ivu-date-picker-cells-cell-selected")), "起止日期未同时选中");
      click(button("确定", panel()));
      await wait(datesMatch, "页面显示的生产时间与目标日期不符");
    }
    let verifiedFilters = unfiltered;
    if (action === "review") {
      if (!review?.sns?.length) throw new Error("没有可回查的子卷 SN");
      const normalize = value => value.replace(/\s+/g, "");
      const setSelect = async (name, value) => {
        const chosen = () => normalize(input(name)?.value ?? "") === normalize(value);
        if (chosen()) return;
        click(input(name));
        const option = await wait(() => one(visible(".el-select-dropdown__item").filter(element =>
          normalize(text(element)) === normalize(value))), "未找到「" + value + "」筛选项");
        click(option);
        await wait(chosen, "「" + value + "」筛选未生效");
      };
      await setSelect("产品类别", review.film);
      await setSelect("人工复判标记", review.mark);
      const snBox = () => one(visible('textarea[placeholder*="SN号"]', field("批支号/SN号")));
      const box = await wait(snBox, "未找到批支号/SN 号输入框");
      if (box.disabled || box.readOnly) throw new Error("子卷 SN 输入框不可填写");
      const raw = review.sns.join("\n");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, raw);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
      verifiedFilters = () => !ccdField().value.trim() &&
        noExtra(["产品类别", "人工复判标记", "批支号/SN号"]) && snBox()?.value === raw &&
        normalize(input("产品类别")?.value ?? "") === normalize(review.film) &&
        normalize(input("人工复判标记")?.value ?? "") === normalize(review.mark);
    }
    if (!verifiedFilters()) throw new Error("查询筛选条件核对失败");
    let updated = false;
    let lastChange = Date.now();
    const observers = [];
    const watch = (element, options) => {
      if (!element) return;
      const observer = new MutationObserver(() => {
        updated = true;
        lastChange = Date.now();
      });
      observer.observe(element, options);
      observers.push(observer);
    };
    watch(query(), { attributes: true, attributeFilter: ["class", "disabled"] });
    for (const selector of [".el-table__body-wrapper", ".el-pagination__total"]) {
      watch(document.querySelector(selector), { subtree: true, childList: true, characterData: true });
    }
    try {
      click(query());
      await wait(() => {
        if (loading()) {
          updated = true;
          lastChange = Date.now();
        }
        return updated && !loading() && Date.now() - lastChange > 350 && total() !== null;
      }, "查询已提交，但平台结果等待超时，尚未导出", 60_000);
      if (!datesMatch() || !verifiedFilters()) throw new Error("查询完成后筛选条件已变化");
      return { state: "queried", total: total(), production: dateField().value };
    } finally {
      observers.forEach(observer => observer.disconnect());
    }
  } catch (error) {
    return { state: "error", message: error.message };
  }
}
