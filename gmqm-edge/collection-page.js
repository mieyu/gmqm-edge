// Runs inside the GMQM tab. Everything it uses must stay within this function.
export async function collectionPage(origin, job, phase) {
  if (location.origin !== origin || window.top !== window) return { state: "error", message: "站点已改变" };
  const route = () => /^#\/samplingSampleLibrary(?:[/?]|$)/.test(location.hash);
  const present = element => element.getClientRects().length && getComputedStyle(element).visibility === "visible";
  const text = element => (element.innerText ?? element.textContent).trim();
  const all = (selector, root = document) => [...root.querySelectorAll(selector)].filter(present);
  const match = items => items.length === 1 ? items[0] : null;
  const exact = (selector, value, root) => match(all(selector, root).filter(element => text(element) === value));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const guard = () => {
    if (/^#\/login(?:[/?]|$)/.test(location.hash)) throw new Error("站点未登录，请登录后重试");
    if (!route()) throw new Error("样本图库页面已改变");
  };
  const wait = async (probe, message, ms = 5000) => {
    const end = Date.now() + ms;
    do {
      guard();
      const value = probe();
      if (value) return value;
      await delay(120);
    } while (Date.now() < end);
    throw new Error(message);
  };
  const click = (element, mountedMenuItem = false) => {
    guard();
    if (!element || (!mountedMenuItem && !present(element)) || element.disabled ||
        element.classList.contains("is-disabled") || element.getAttribute("aria-disabled") === "true") {
      throw new Error("页面控件不可操作");
    }
    element.click();
  };
  const fill = (input, value) => {
    if (!input || input.disabled || input.readOnly) throw new Error("未找到可填写的输入框");
    input.focus({ preventScroll: true });
    const prototype = input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (input.value !== value) throw new Error("页面未接受输入内容");
  };
  const dialog = name => match(all('[role="dialog"]').filter(element =>
    element.getAttribute("aria-label") === name));
  const button = (root, value) => match(all("button", root).filter(element =>
    text(element) === value || [...element.children].some(child => text(child) === value)));
  const label = row => row?.querySelector(".library-name");
  const active = row => row?.classList.contains("library-item__active") || row?.classList.contains("active");
  const rows = () => all(".library-item").filter(row => label(row));
  const count = row => {
    const value = label(row)?.innerText.match(/[（(]([\d,]+)[）)]\s*$/)?.[1];
    return value === undefined ? null : Number(value.replaceAll(",", ""));
  };
  const gallery = () => {
    const found = rows().filter(row => text(label(row)).replace(/[（(][\d,]+[）)]$/, "").trim() === job.gallery);
    if (found.length > 1) throw new Error("找到多个同名图库");
    return found[0];
  };
  const newButton = () => button(document, "新建图库");
  const loading = () => all(".el-loading-mask").some(mask =>
    !mask.classList.contains("el-loading-fade-leave-active") &&
    Number(getComputedStyle(mask).opacity) > 0);
  const searchGallery = async (force = false) => {
    const input = match(all('input[placeholder="请输入图库名称"]').filter(element => !element.closest('[role="dialog"]')));
    if (!input || (!force && gallery())) return;
    if (input.value !== job.gallery) fill(input, job.gallery);
    for (const type of ["keydown", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }
    await delay(650);
    await wait(() => gallery() || !loading(), "图库搜索等待超时，尚未提交采集", 25_000);
  };
  const sameValues = (actual, expected) =>
    actual.length === expected.length && expected.every(value => actual.includes(value));
  const result = () => {
    const actions = match(all(".collect-btns"));
    if (!actions) return null;
    const wrapper = actions.parentElement;
    const body = text(wrapper);
    const amount = body.match(/已采集总数\s*[:：]\s*([\d,]+)\s*张/)?.[1];
    const rows = [...wrapper.querySelectorAll("tbody tr")].map(element =>
      [...element.querySelectorAll("td")].map(text));
    const labels = [...new Set(rows.map(row => row[0]).filter(Boolean))];
    const counts = new Map(job.defects.map(defect => [defect, 0]));
    for (const row of rows) {
      const quantity = row.at(-1)?.replaceAll(",", "");
      if (counts.has(row[0]) && /^\d+$/.test(quantity ?? "")) {
        counts.set(row[0], counts.get(row[0]) + Number(quantity));
      }
    }
    return { body, labels, amount: amount === undefined ? null : Number(amount.replaceAll(",", "")),
      counts, confirm: button(actions, "确定") ?? button(actions, "确认采集") };
  };
  let submission = false;
  try {
    await wait(() => gallery() || newButton(), "样本图库页面加载超时，尚未提交采集", 30_000);
    if (dialog("采集数据") || dialog("新建图库")) throw new Error("此页已有打开的图库表单");
    await searchGallery();
    let row = gallery();
    if (!row) {
      if (phase !== "submit") throw new Error("未找到已提交的图库");
      click(await wait(newButton, "新建图库按钮未加载"));
      const create = await wait(() => dialog("新建图库"), "新建图库表单未打开");
      fill(match(all('input[placeholder="请输入图库名称"]', create)), job.gallery);
      click(button(create, "确定"));
      await wait(() => !dialog("新建图库"), "新建图库表单未关闭，请查看平台提示", 20_000);
      if (!gallery()) await searchGallery(true);
      row = await wait(gallery,
        "已提交建库，按全名复查仍未看到图库", 20_000);
    }
    if (!job.defects.length && phase !== "labels") {
      const existing = count(row);
      if (job.labelNames && existing > 0) {
        return { state: "existing", count: existing, message: "当天图库已有 " + existing + " 张" };
      }
      return { state: "built", message: "图库已就绪" };
    }
    if (!active(row)) click(label(row));
    await wait(() => active(gallery()), "未能切换到目标图库");
    await delay(400);
    await wait(() => !loading(), "图库任务加载超时，尚未提交本次操作", 25_000);
    const current = result();
    if (phase === "labels") {
      if (current) throw new Error("图库仍有采集任务，暂未添加分类标签");
      if (count(gallery()) === 0) return {state: "labeling-incomplete", message: "图库暂时没有图片"};
      const tabFor = film => match(all('[role="tab"]').filter(element =>
        text(element).replace(/[（(][\d,]+[）)]$/, "").trim() === film));
      await wait(() => all('[role="tab"]').length > 0, "没有读取到图库膜种标签页");
      const available = job.labelFilms.filter(film => tabFor(film));
      if (!available.length) throw new Error("当前图库没有 SOP 指定膜种");
      const activeTab = tab => tab?.getAttribute("aria-selected") === "true" || tab?.classList.contains("is-active");
      const activeManager = () => match(all(".tag-manage-wrap"));
      const tagNames = manager => all(".tag-list .tag-name", manager).map(element =>
        text(element).replace(/[（(][\d,]+[）)]$/, ""));
      async function switchAndRead(film) {
        const tab = tabFor(film);
        const changing = !activeTab(tab);
        const previous = activeManager();
        let refreshed = !changing;
        let lastRows;
        let settled = 0;
        const observer = new MutationObserver(records => {
          for (const record of records) {
            const node = record.target instanceof Element ? record.target : record.target.parentElement;
            const manager = node?.closest(".tag-manage-wrap");
            if (!manager || (manager !== previous && manager !== activeManager())) continue;
            const listChanged = record.type !== "attributes" && node.closest(".tag-content,.tag-list");
            const maskClosed = record.type === "attributes" && node.matches(".el-loading-mask") &&
              !/display\s*:\s*none/.test(record.oldValue ?? "") && !present(node);
            if (listChanged || maskClosed) {
              refreshed = true;
              settled = 0;
            }
          }
        });
        observer.observe(document.body, {
          subtree: true, childList: true, characterData: true,
          attributes: true, attributeFilter: ["style"], attributeOldValue: true,
        });
        try {
          if (changing) click(tab);
          return await wait(() => {
            const selected = tabFor(film);
            if (!active(gallery()) || !activeTab(selected) || loading()) {
              settled = 0;
              return null;
            }
            const pane = document.getElementById(selected.getAttribute("aria-controls"));
            if (pane && !present(pane)) return null;
            const manager = activeManager();
            if (!manager) return null;
            const rows = tagNames(manager);
            if (!rows.length || (!refreshed && manager === previous)) return null;
            const snapshot = JSON.stringify(rows);
            if (snapshot !== lastRows || !settled) {
              lastRows = snapshot;
              settled = Date.now();
            }
            return Date.now() - settled >= 500 && manager;
          }, film + "的标签列表未确认刷新", 18_000);
        } finally {
          observer.disconnect();
        }
      }
      async function openFilm(film) {
        if (activeTab(tabFor(film)) && available.length > 1) {
          await switchAndRead(available.find(other => other !== film));
        }
        return switchAndRead(film);
      }
      const missingFrom = manager => job.labelNames.filter(name => !tagNames(manager).includes(name));
      const alerts = () => all(".el-message--error .el-message__content,.el-notification.error .el-notification__content");
      const errors = new Map();
      for (const film of available) {
        try {
          const manager = await openFilm(film);
          for (const name of missingFrom(manager)) {
            if (!active(gallery()) || !activeTab(tabFor(film))) throw new Error("添加标签前图库或膜种已切换");
            fill(match(all('.add-section input[placeholder="请先输入标签名称"]', manager)), name);
            const add = await wait(() => {
              const section = match(all(".add-section", manager));
              const candidate = section && button(section, "添加");
              return candidate && !candidate.disabled ? candidate : null;
            }, "添加标签按钮不可用");
            const preceding = new Set(alerts());
            click(add);
            await wait(() => {
              const alert = alerts().find(element => !preceding.has(element));
              if (alert) throw new Error(text(alert));
              return !missingFrom(manager).includes(name);
            }, "「" + name + "」未确认创建", 10_000);
          }
        } catch (error) {
          errors.set(film, error.message);
        }
      }
      const incomplete = [];
      for (const film of available) {
        try {
          const missing = missingFrom(await openFilm(film));
          if (missing.length) incomplete.push(film + "缺：" + missing.join("、") +
            (errors.has(film) ? "（" + errors.get(film) + "）" : ""));
        } catch (error) {
          incomplete.push(film + "未能复查：" + error.message);
        }
      }
      if (incomplete.length) return {state: "labeling-incomplete", message: incomplete.join("；")};
      return { state: "labeling-ready", message: "待人工分类 · 已核对 " + available.join("、") + "的六类标签" };
    }
    if (phase === "confirm") {
      if (!current) {
        if (count(gallery()) > 0) {
          return { state: "existing", count: count(gallery()), message: "图库已有 " + count(gallery()) + " 张，请核对本批" };
        }
        return { state: "pending", message: "等待平台更新采集状态" };
      }
      if (/采集失败/.test(current.body)) return { state: "error", message: "平台显示采集失败" };
      if (!current.confirm || !/待确认/.test(current.body)) {
        return { state: "pending", message: "平台采集中" };
      }
      const countByDefect = [...current.counts.values()].reduce((total, value) => total + value, 0);
      const matchResults = sameValues(current.labels, job.defects) ||
        (job.labelNames && countByDefect === current.amount && current.labels.every(item => job.defects.includes(item)));
      if (current.amount === null || !matchResults || !active(gallery())) {
        throw new Error("待入库张数或缺陷标签与当前任务不符");
      }
      const baseline = count(gallery());
      if (baseline === null) throw new Error("无法读取图库当前张数");
      submission = true;
      click(current.confirm);
      await wait(() => active(gallery()) && count(gallery()) === baseline + current.amount && !result(),
        "已点确认，入库张数待核实", 8500);
      const byDefect = countByDefect === current.amount ? Object.fromEntries(current.counts) : undefined;
      return { state: "saved", count: current.amount, byDefect, message: "已入库 " + current.amount + " 张" };
    }
    if (current) return { state: "existing", message: "图库已有采集任务，请查看平台状态" };
    if (count(gallery()) !== 0) {
      const existing = count(gallery());
      return { state: "existing", count: existing ?? undefined, message: "图库已有数据，请核对本批" };
    }
    const trigger = match(all("[aria-controls]", gallery()).filter(element => element.tagName === "BUTTON" ||
      element.getAttribute("role") === "button"));
    const id = trigger?.getAttribute("aria-controls");
    if (!id) throw new Error("未找到目标图库的采集菜单");
    const collectItem = () => {
      const menu = document.getElementById(id);
      return menu && match([...menu.querySelectorAll("li,.el-dropdown-menu__item")]
        .filter(item => item.textContent.trim() === "采集数据"));
    };
    if (!collectItem()) {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      for (let element = trigger; element && element !== gallery(); element = element.parentElement) {
        element.dispatchEvent(new MouseEvent("mouseenter"));
      }
      await delay(400);
      if (!collectItem()) click(trigger);
    }
    click(await wait(collectItem, "未找到图库的采集数据菜单项"), true);
    const form = await wait(() => dialog("采集数据"), "采集表单未打开");
    const input = match(all('textarea[placeholder="请输入子卷批支号或子卷SN号，以换行区分"]', form));
    const raw = job.sns.join("\n");
    if (!raw) throw new Error("这批没有可采集的子卷 SN");
    fill(input, raw);
    const field = name => form.querySelector('label[for="' + name + '"]')?.closest(".el-form-item");
    const title = exact(".el-dialog__title", "采集数据", form);
    const area = field("gatherRange")?.querySelector("input.el-input__inner");
    const source = form.querySelector('input[placeholder="请选择缺陷来源"]');
    const choose = async (control, value) => {
      if (control?.value === value) return;
      click(control);
      click(await wait(() => exact(".el-select-dropdown:not(.is-multiple) li.el-select-dropdown__item", value),
        "选项未显示：" + value));
      await wait(() => control.value === value, "选项未生效：" + value);
    };
    await choose(area, "判等区域");
    await choose(source, "AI复判");
    const dropdown = () => match(all(".el-select-dropdown.is-multiple").filter(element =>
      !element.className.includes("leave")));
    const pickValues = async (key, name, values) => {
      const control = field(key);
      if (!control) throw new Error("未找到" + name);
      if (!dropdown()) click(match(all(".el-select__caret", control)));
      await wait(dropdown, name + "菜单未打开");
      const selector = control.querySelector("input.el-select__input");
      const selected = () => [...(dropdown()?.querySelectorAll("li.selected") ?? [])].map(text);
      const clearQuery = () => {
        if (selector && selector.value) fill(selector, "");
      };
      clearQuery();
      if (!sameValues(selected(), values)) {
        const deselect = () => click(exact("label.el-checkbox", "全选", dropdown()));
        if (selected().length) {
          deselect();
          await delay(300);
          if (selected().length) deselect();
          await wait(() => !selected().length, "默认" + name + "未清除");
        }
        for (const value of values) {
          const option = () => dropdown() && exact("li.el-select-dropdown__item", value, dropdown());
          if (!option() && selector) fill(selector, value);
          click(await wait(option, "找不到" + name + "选项：" + value));
          await wait(() => selected().includes(value), "未选中" + value);
          clearQuery();
        }
      }
      await wait(() => sameValues(selected(), values), "所选" + name + "与 SOP 不一致");
      if (selector) {
        for (const type of ["keydown", "keyup"]) {
          selector.dispatchEvent(new KeyboardEvent(type, {
            key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true,
          }));
        }
        await delay(150);
      }
      if (dropdown()) {
        if (!title) throw new Error("未找到采集表单标题，无法关闭" + name + "菜单");
        for (const type of ["mousedown", "mouseup"]) {
          title.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
        }
        click(title);
      }
      await wait(() => !dropdown(), name + "菜单未关闭");
      if (key === "cddLevel") {
        const displayed = all(".el-select__tags .el-select__tags-text", control).map(text);
        if (!sameValues(displayed, values)) throw new Error("关闭菜单后 CCD B 未保留");
      }
    };
    if (job.ccdOnly) await pickValues("cddLevel", "CCD 等级", ["B"]);
    await pickValues("defectClass", "缺陷名称", job.defects);
    if (input.value !== raw || area.value !== "判等区域" || source.value !== "AI复判" || !active(gallery())) {
      throw new Error("图库、SN 或采集条件核对失败");
    }
    submission = true;
    click(button(form, "确定") ?? button(form, "确认"));
    await wait(() => !dialog("采集数据") && result(), "已尝试提交，平台尚未显示结果", 7500);
    return { state: "submitted", message: "已提交，等待平台采集" };
  } catch (error) {
    return { state: submission ? "uncertain" : "error", message: error.message };
  }
}
