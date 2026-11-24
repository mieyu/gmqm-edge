export async function modelPage(origin, action, args = {}) {
  const routes = {
    scan: "#/model/model_list", deploy: "#/model/model_list",
    deployments: "#/model/create_model", download: "#/model/create_model",
    detail: "#/model/create_model", configuration: "#/model/deploy_detail/",
    mar: "#/modelManage/modelList", openValidation: "#/modelManage/modelList",
    prepareValidation: "#/modelManage/modelList", validate: "#/modelManage/modelList",
    validationTasks: "#/modelManage/modelInfer", openValidationDetail: "#/modelManage/modelInfer",
    prepare: "#/model/modelPack", inherit: "#/model/modelPack", submit: "#/model/modelPack", packStatus: "#/model/modelPack",
    fileChunk: "#/model/modelPack", upload: "#/model/modelPack",
    validationStatus: "#/model_validation",
  };
  const expected = routes[action];
  const correct = () => window.top === window && location.origin === origin && (expected.endsWith("/")
    ? location.hash.startsWith(expected) : location.hash.split("?")[0] === expected);
  if (!correct()) return { error: "平台页面尚未就绪或已切换", beforeSubmission: true };
  let submitting = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const txt = e => (e?.innerText ?? e?.textContent ?? "").trim();
  // executeScript injects this function without the extension's module imports.
  const version = label => label?.normalize("NFKC").trim().replace(/\s*(?:\(\s*最优版本\s*\)|最优版本)$/u,"").toLowerCase();
  const shown = e => e.getClientRects().length && getComputedStyle(e).visibility === "visible";
  const visible = (selector, root = document) => root ? [...root.querySelectorAll(selector)].filter(shown) : [];
  const one = array => array.length === 1 ? array[0] : null;
  const exact = (selector, label, root) => one(visible(selector, root).filter(el => txt(el) === label));
  const masks = () => visible(".el-loading-mask,.ivu-spin-fix").some(el =>
    Number(getComputedStyle(el).opacity) > 0 && !el.className.includes("leave"));
  const wait = async (test, message, timeout = 14_000) => {
    const end = Date.now() + timeout;
    do {
      if (!correct()) throw new Error("等待期间平台页面已切换");
      const value = test();
      if (value) return value;
      await delay(120);
    } while (Date.now() < end);
    throw new Error(message);
  };
  const click = node => {
    if (!node || node.disabled || !shown(node)) throw new Error("操作控件不可用");
    node.click();
  };
  const fill = (node, value) => {
    if (!node || node.disabled || node.readOnly) throw new Error("输入框不可填写");
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    node.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    for (const type of ["input", "change"]) node.dispatchEvent(new Event(type, { bubbles: true }));
    node.blur();
    if (node.value !== value) throw new Error("页面未保留输入值");
  };
  const tableHeader = ["scan","deploy"].includes(action) ? "训练状态" :
    ["deployments","download","detail"].includes(action) ? "部署模型格式" :
    ["mar","openValidation"].includes(action) ? "生成时间" :
    ["validationTasks","openValidationDetail"].includes(action) ? "验证模型名称" : "来源配置";
  const table = () => one(visible(".el-table").filter(element =>
    visible(".el-table__header-wrapper th",element).some(t => txt(t) === tableHeader)));
  const getRows = () => visible(".el-table__body-wrapper tbody tr",table()).filter(row =>
    row.classList.contains("el-table__row"));
  const header = () => Boolean(table());
  const pageTotal = () => {
    const view = one(visible(".ivu-page-total"));
    const n = txt(view).match(/共\s*([\d,]+)\s*条/)?.[1];
    return n === undefined ? null : Number(n.replaceAll(",",""));
  };
  async function readyBrainList(message) {
    let still;
    let snapshot;
    await wait(() => {
      if (!header() || masks()) {
        still = undefined;
        return false;
      }
      const rows = getRows();
      const count = pageTotal();
      if (!rows.length && ["scan","deploy"].includes(action)) return false;
      if (!rows.length && (count !== 0 || !visible(".el-table__empty-text",table()).length)) return false;
      const sig = signRows();
      if (sig !== snapshot || still === undefined) {
        still = Date.now();
        snapshot = sig;
      }
      return Date.now() - still >= (rows.length ? 600 : 1800);
    },message,35_000);
  }
  const btn = (name, root) => exact("button", name, root);
  const modal = () => one(visible(".ivu-modal").filter(el => txt(el.querySelector(".ivu-modal-header")) === "创建部署"));
  const formField = (root, name) => one(visible(".ivu-form-item", root).filter(el => txt(el.querySelector("label")) === name));
  async function chooseIvu(scope, name) {
    if (txt(scope?.querySelector(".ivu-select-selected-value")) === name) return;
    click(one(visible(".ivu-select-selection", scope)));
    click(await wait(() => exact(".ivu-select-item", name, scope) ?? exact(".ivu-select-item", name),
      "未找到选项：" + name));
    await wait(() => txt(scope.querySelector(".ivu-select-selected-value")) === name, "选项未生效：" + name);
  }
  const elMenus = () => visible(".el-select-dropdown");
  async function closeElMenus(message) {
    const focused = document.activeElement;
    if (focused?.closest?.(".el-select")) focused.blur();
    if (!elMenus().length) return;
    // Element UI closes its portaled menus on an outside mouse down/up pair.
    for (const type of ["mousedown", "mouseup"]) {
      document.body.dispatchEvent(new MouseEvent(type, { bubbles:true }));
    }
    await wait(() => !elMenus().length,message,4500);
  }
  async function chooseEl(control, name, label) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await closeElMenus(label + "的旧下拉菜单未关闭");
        const input = await wait(() => {
          const current = control();
          return !masks() && current && !current.disabled && current;
        }, label + "控件未就绪", 8000);
        if (input.value === name) return;
        const scope = input.closest(".el-select");
        const attached = scope.querySelector(".el-select-dropdown");
        click(input);
        const option = await wait(() => {
          const menu = one(elMenus());
          if (!menu || (attached ? menu !== attached : !scope.querySelector(".el-select__caret.is-reverse"))) return null;
          return exact(".el-select-dropdown__item:not(.is-disabled)", name, menu);
        }, label + "未显示可用选项 " + name, 10_000);
        click(option);
        // The input temporarily holds the search query while a filterable menu is open.
        await wait(() => !elMenus().length && control()?.value === name,
          label + "未保留选项 " + name, 3500);
        await closeElMenus(label + "的下拉菜单未关闭");
        return;
      } catch (error) {
        if (attempt || !correct()) throw error;
      }
    }
  }
  const identity = row => [...row.cells].map(txt);
  const exactRow = (value, col) => one(getRows().filter(row => txt(row.cells[col]) === value));
  const modelRows = () => getRows().map(identity).map(c =>
    ({name:c[1], version:c[5], state:c[6], dataset:c[8], created:c[9]})).filter(row => row.name && row.created);
  const nextPage = () => one(visible('li[title="下一页"]'));
  const signRows = () => JSON.stringify(getRows().map(identity));
  async function advance() {
    const next = nextPage();
    if (!next || next.classList.contains("ivu-page-disabled")) return false;
    const signature = signRows();
    click(next);
    await wait(() => !masks() && signRows() !== signature, "F.Brain 列表翻页未完成");
    return true;
  }
  async function firstPage() {
    const first = one(visible('li[title="1"]'));
    if (first && !first.classList.contains("ivu-page-item-active")) {
      const signature = signRows();
      click(first);
      await wait(() => !masks() && signRows() !== signature, "模型列表未回到第一页");
    }
  }
  async function findAcrossPages(find) {
    for (let page = 0; page < 250; page += 1) {
      const found = find();
      if (found) return found;
      if (!await advance()) return null;
    }
    throw new Error("未能完成 F.Brain 类别结果翻页");
  }
  async function readAllTrainingModels() {
    const scope = await wait(() => document.querySelector('input[placeholder="请输入模型名称"]')
      ?.closest(".right")?.querySelector(".ivu-select"), "「全部」模型范围未加载", 35_000);
    await chooseIvu(scope,"全部");
    await readyBrainList("「全部」模型列表未确认加载");
    await firstPage();
  }
  try {
    if (action === "scan") {
      await readAllTrainingModels();
      const rows = [];
      for (let page = 0; page < 250; page += 1) {
        const current = modelRows();
        rows.push(...current);
        if (current.some(row => row.created.slice(0, 10) < args.day) && current.every((row, index) =>
          index === 0 || current[index - 1].created >= row.created)) return { rows };
        if (!await advance()) return { rows };
      }
      throw new Error("模型列表超过本次扫描范围");
    }
    if (action === "deploy") {
      await readAllTrainingModels();
      const matchingRow = () => one(getRows().filter(el => txt(el.cells[1]) === args.name &&
        version(txt(el.cells[5])) === version(args.version) &&
        txt(el.cells[6]) === "训练成功" && txt(el.cells[9]) === args.created));
      const row = await findAcrossPages(matchingRow);
      if (!row) throw new Error("无法复核训练成功的模型名称、版本和时间");
      if (modal()) throw new Error("页面已有打开的部署弹窗");
      let form;
      let selected;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const trigger = await wait(() => {
          const current = matchingRow();
          return current && !masks() && one(visible(".fb-list_deploy", current));
        }, "选中的训练记录已变化");
        click(trigger);
        form = await wait(modal, "创建部署弹窗未打开");
        const configured = () => form.querySelector('input[placeholder="请选择模型"]')?.value.trim();
        const until = Date.now() + 20_000;
        do {
          if (!correct() || modal() !== form) throw new Error("等待时部署弹窗已切换");
          selected = configured();
          if (selected) break;
          await delay(200);
        } while (Date.now() < until);
        if (selected) break;
        if (attempt === 0) {
          click(btn("取消", form));
          await wait(() => !modal() && !masks(), "未关闭空白部署弹窗");
          await delay(500);
        }
      }
      if (!selected) throw new Error("两次打开后「选择模型」仍未加载，尚未提交部署");
      const matchesSelection = () => {
        const text = form.querySelector('input[placeholder="请选择模型"]')?.value.trim() ?? "";
        const suffix = text.slice(args.name.length);
        return text.startsWith(args.name + "-") &&
          suffix.toLowerCase().split(/[^a-z0-9.]+/).includes(version(args.version));
      };
      if (!matchesSelection()) throw new Error("部署弹窗实际显示「" + selected + "」，预期「" + args.name + " · " + version(args.version) + "」");
      await chooseIvu(formField(form, "模型阶段"), "最新模型");
      await chooseIvu(formField(form, "部署模型格式"), "ONNX");
      const dimensions = ["宽度值","高度值"].map(label => one(visible("input.ivu-input-number-input", formField(form,label))));
      for (const input of dimensions) {
        if (!input || input.disabled || input.readOnly) throw new Error("部署宽高输入框不可填写");
        input.focus({ preventScroll: true });
        input.select();
        if (!document.execCommand("insertText", false, "285")) throw new Error("浏览器未接收部署尺寸输入");
        input.blur();
        await delay(180);
        if (input.value !== "285") throw new Error("尺寸失焦后回落，尚未提交部署");
      }
      await delay(500);
      if (!matchesSelection() || dimensions.some(input => input.value !== "285")) {
        throw new Error("提交前模型名称或输入宽高不符");
      }
      const confirm = btn("确定", form);
      if (!confirm || confirm.disabled) throw new Error("部署确认按钮不可用");
      submitting = true;
      click(confirm);
      // The deployment list is authoritative even if this dialog stays open.
      await delay(1500);
      const error = visible(".ivu-message-error,.ivu-notice-error,.el-message--error").map(txt).find(Boolean);
      return { submitted: true, acknowledgement: error || "" };
    }
    if (["deployments","download","detail"].includes(action)) {
      await readyBrainList("部署列表未确认加载");
      await firstPage();
      const matchingRows = () => getRows().filter(row => {
        const c = identity(row);
        return c[2] === args.name && version(c[4]) === version(args.version) &&
          c[6] === "ONNX" && c[7]?.startsWith(args.day);
      });
      if (action === "deployments") {
        const matches = [];
        for (let page = 0; page < 250; page += 1) {
          matches.push(...matchingRows().map(row => ({status:txt(row.cells[1]),time:txt(row.cells[7])})));
          const times = getRows().map(row => txt(row.cells[7]));
          if (times.some(time => /^\d{4}-\d{2}-\d{2}/.test(time) && time.slice(0,10) < args.day) &&
              times.every((time, i) => i === 0 || times[i-1] >= time)) return { matches };
          if (!await advance()) return { matches };
        }
        throw new Error("无法扫描完该类别的部署记录");
      }
      const row = await findAcrossPages(() => one(matchingRows().filter(row =>
        txt(row.cells[1]) === "部署成功" && txt(row.cells[7]) === args.time)));
      if (!row) throw new Error("未找到已部署成功的唯一 ONNX 条目");
      if (action === "detail") {
        click(one(visible(".fb-list_actionDetails", row)));
        return { clicked: true };
      }
      const icon = one(visible(".fb-list_download", row));
      const dropdown = icon?.closest(".ivu-dropdown");
      if (!dropdown) throw new Error("该模型条目没有下载格式菜单");
      const option = () => exact(".download-list li.ivu-dropdown-item", "下载模型格式为.onnx", dropdown) ??
        exact(".ivu-dropdown-transfer .download-list li.ivu-dropdown-item", "下载模型格式为.onnx");
      if (option()) throw new Error("已有打开的下载格式菜单，请关闭后重试");
      icon.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));
      icon.closest(".ivu-dropdown-rel")?.dispatchEvent(new MouseEvent("mouseenter"));
      dropdown.dispatchEvent(new MouseEvent("mouseenter"));
      await delay(450);
      if (!option()) click(icon);
      click(await wait(option,"未打开「下载模型格式为.onnx」菜单",8000));
      return { clicked: true };
    }
    if (action === "configuration") {
      const content = await wait(() => {
        const value = document.body.innerText;
        return value.includes("输入宽高:") && value.includes(args.name) && value.includes("部署ID:") &&
          /高\s*\d+\s+宽\s*\d+/.test(value) && value;
      }, "部署配置详情未加载");
      const [,height,width] = content.match(/高\s*(\d+)\s+宽\s*(\d+)/);
      return { verified: height === "285" && width === "285" && content.includes("最新模型") &&
        content.includes("ONNX") && (content.match(/(?<![a-z0-9.])v\d+(?:\.\d+)*(?![a-z0-9.])/gi) ?? [])
          .some(label => version(label) === version(args.version)),
      height, width };
    }
    if (action === "mar") {
        const rows = await wait(() => {
          if (masks()) return null;
          const records = getRows().map(identity).map(c =>
            ({name:c[0], version:c[1], source:c[2], status:c[3], notes:c[4], created:c[5]}))
            .filter(row => /\.mar$/i.test(row.name) && /^\d{4}-\d{2}-\d{2}/.test(row.created));
          // GMQM can display an empty table before its first response arrives.
          return records.length ? records : null;
        }, "等待 GMQM 模型列表超时，未看到带生成时间的 MAR 记录", 35_000);
        return { rows: rows.sort((a,b) => b.created.localeCompare(a.created)) };
    }
    if (["openValidation","prepareValidation","validate"].includes(action)) {
      const config = () => one(visible(".vxe-modal--wrapper.is--active .vxe-modal--box")
        .filter(box => txt(box).split("\n").some(line => line.trim() === "模型验证配置")));
      const forModel = box => box && txt(box.querySelector(".vxe-modal--content")).split("\n")
        .some(line => line.trim() === args.name);
      if (action === "openValidation") {
        const existing = config();
        if (existing && !forModel(existing)) throw new Error("另一模型的验证配置正在打开");
        if (!existing) {
          click(await wait(() => {
            const row = !masks() && exactRow(args.name,0);
            return row && btn("模型验证",row);
          }, "GMQM 列表未显示目标 MAR 的模型验证入口", 35_000));
        }
        await wait(() => forModel(config()), "模型管理页未打开目标 MAR 的验证配置弹窗", 15_000);
        return { opened:true };
      }
      const targetDialog = () => {
        const box = config();
        return forModel(box) && box;
      };
      await wait(targetDialog, "验证配置弹窗中的 MAR 与当前任务不符");
      if (args.sns.length !== 200 || new Set(args.sns).size !== 200) {
        throw new Error("生产卷验证必须有 200 个去重的同基地 SN");
      }
      const snSelector = 'textarea[placeholder="请输入子卷SN号，以换行区分"]';
      const production = box => box && exact('label[role="radio"],label.el-radio-button,label.el-radio',
        "生产卷数据",box);
      const productionInput = radio => radio?.querySelector('input[type="radio"]');
      const checked = radio => radio?.getAttribute("aria-checked") === "true" || productionInput(radio)?.checked;
      const snArea = () => {
        const dialog = targetDialog();
        const area = checked(production(dialog)) && one(visible(snSelector,dialog));
        return area && !area.disabled && !area.readOnly && area;
      };
      if (action === "prepareValidation") {
        const radio = await wait(() => {
          const option = production(targetDialog());
          return option && option.getAttribute("aria-disabled") !== "true" &&
            !option.classList.contains("is-disabled") && !productionInput(option)?.disabled && option;
        }, "验证弹窗中的生产卷数据按钮未就绪");
        if (!checked(radio)) click(radio);
      }
      const area = await wait(snArea, "未确认选中生产卷数据并显示可填写的 SN 输入框");
      const raw = args.sns.join("\n");
      if (action === "prepareValidation") {
        fill(area, raw);
        return { prepared:true };
      }
      if (area.value !== raw) throw new Error("验证提交前 SN 输入发生变化");
      const start = await wait(() => {
        const dialog = targetDialog();
        const button = dialog && btn("开始",dialog);
        return button && !button.disabled && button;
      }, "验证配置中的开始按钮未就绪");
      if (snArea()?.value !== raw) throw new Error("验证配置在提交前发生变化");
      submitting = true;
      click(start);
      return { clicked:true };
    }
    if (action === "validationTasks" || action === "openValidationDetail") {
      const rowsForModel = () => getRows().filter(row => txt(row.cells[1]) === args.name);
      if (action === "openValidationDetail") {
        click(await wait(() => {
          const row = one(rowsForModel().filter(row => txt(row.cells[3]) === args.created));
          return !masks() && row && btn("详情",row);
        }, "验证任务列表未显示指定任务的详情入口"));
        return { opened:true };
      }
      const search = await wait(() => !masks() && header() &&
        one(visible('input[placeholder="请输入模型名称"]')), "GMQM 验证任务列表未加载", 30_000);
      if (search.value !== args.name) {
        fill(search,args.name);
        click(await wait(() => btn("查询"), "验证任务查询按钮未出现"));
      }
      const rows = await wait(() => {
        if (masks() || !header()) return null;
        const list = getRows();
        return list.every(row => txt(row.cells[1]).includes(args.name)) ? rowsForModel() : null;
      }, "验证任务筛选未确认完成", 6000).catch(error => {
        if (!correct()) throw error;
        return [];
      });
      return { tasks: rows.map(row => ({status:txt(row.cells[0]),created:txt(row.cells[3]),
        details:Boolean(btn("详情",row))})) };
    }
    if (action === "validationStatus") {
      const model = await wait(() => {
        const label = exact(".item .label","验证模型：");
        return txt(label?.parentElement.querySelector(".value"));
      }, "验证详情未返回 MAR 名称");
      if (model !== args.name) throw new Error("验证详情打开了其他 MAR");
      const values = await wait(() => {
        if (masks()) return null;
        const list = visible(".sn-item-box .sn-item").map(txt).filter(Boolean);
        return list.length ? list : null;
      }, "验证详情未返回生产卷 SN 清单", 6000).catch(error => {
        if (!correct()) throw error;
        return [];
      });
      const actual = new Set(values);
      const expected = new Set(args.sns);
      return { read:values.length > 0, matches:expected.size === 200 && values.length === expected.size &&
        actual.size === expected.size && args.sns.every(sn => actual.has(sn)) };
    }
    const headerField = () => one(visible('input[placeholder="请输入模型Mar名称"]'));
    if (action === "packStatus") {
      const stem = headerField()?.value;
      if (stem && stem !== args.stem) return { busy:false };
      const busy = masks() || visible("button").some(button => {
        const text = txt(button);
        return /^(?:正在(?:提交|打包)|(?:提交|打包)中)[\s.…。]*$/.test(text) || (text === "提交打包" &&
          (button.matches('.is-loading,.is--loading,.ivu-btn-loading,[aria-busy="true"]') ||
            button.querySelector(".el-icon-loading,.ivu-load-loop")));
      });
      return { busy };
    }
    const selectInput = cell => cell && one(visible(".el-select input.el-input__inner",cell));
    const schemeInput = () => selectInput(exact(".el-form-item label","模型方案")?.closest(".el-form-item"));
    await wait(() => headerField() && !masks(), "GMQM 模型打包页未加载", 30_000);
    if (action === "prepare") {
      fill(headerField(), args.stem);
      await chooseEl(schemeInput,args.scheme,"模型方案");
      fill(await wait(() => one(visible('input[placeholder="请输入模型备注"]')), "打包备注控件未加载"),args.notes);
      const rows = await wait(() => !masks() && getRows().length && getRows(), "模型方案配置未载入");
      return { slots: rows.map(row => ({id:txt(row.cells[0]), name:txt(row.cells[1]), file:txt(row.cells[6])})) };
    }
    const verifyPack = () => headerField()?.value === args.stem && schemeInput()?.value === args.scheme;
    if (action !== "submit" && !verifyPack()) throw new Error("打包表单的 MAR 名称或方案已切换");
    // GMQM reuses a group ID for the three point-coating files in Hubei.
    const packRow = slot => one(getRows().filter(row => txt(row.cells[0]) === slot.id && txt(row.cells[6]) === slot.file));
    const source = slot => selectInput(packRow(slot)?.cells[7]);
    const inherited = slot => selectInput(packRow(slot)?.cells[8]);
    const imported = slot => txt(packRow(slot)?.cells[8]?.querySelector(".file-name-text"));
    const slotLabel = slot => slot.name.trim().replace(/\s+/g," ") + "（" + slot.file + "）";
    if (action === "inherit") {
      const {slot} = args;
      const label = slotLabel(slot);
      await chooseEl(() => source(slot),"继承MAR文件",label + "的模型来源");
      await chooseEl(() => inherited(slot),args.previous,label + "的继承版本");
      return { set: true };
    }
    if (action === "fileChunk") {
      const holder = (globalThis[args.token] ??= []);
      holder.push(Uint8Array.from(atob(args.chunk), byte => byte.charCodeAt(0)));
      return { total: holder.length };
    }
    if (action === "upload") {
      const {slot} = args;
      const label = slotLabel(slot);
      try {
        const bytes = globalThis[args.token] ?? [];
        if (bytes.reduce((sum, part) => sum + part.byteLength, 0) !== args.size) throw new Error("ZIP 传入页面不完整");
        await chooseEl(() => source(slot),"导入模型文件",label + "的模型来源");
        const input = await wait(() => {
          const file = packRow(slot)?.cells[8]?.querySelector('input[type="file"][accept=".zip"]');
          return !masks() && file && !file.disabled && file;
        }, label + "的 ZIP 文件控件未就绪");
        const data = new DataTransfer();
        data.items.add(new File(bytes,args.file,{type:"application/zip"}));
        input.files = data.files;
        input.dispatchEvent(new Event("change",{bubbles:true}));
        await wait(() => imported(slot) === args.file, label + "未显示已选文件 " + args.file, 60_000);
        return { set: true };
      } finally {
        delete globalThis[args.token];
      }
    }
    if (action === "submit") {
      await closeElMenus("提交前未能关闭打包页的下拉菜单");
      const submit = await wait(() => {
        const button = btn("提交打包");
        return !masks() && !elMenus().length && button && !button.disabled && button;
      }, "打包提交按钮未就绪");
      if (!verifyPack()) throw new Error("提交前 MAR 名称或模型方案已变化");
      const count = getRows().length;
      if (count !== args.slots.length) throw new Error("提交前模型槽位数量不符，当前 " + count + "，已核对 " + args.slots.length);
      const unmatched = args.slots.find(({slot,zip}) => zip
        ? source(slot)?.value !== "导入模型文件" || imported(slot) !== zip
        : source(slot)?.value !== "继承MAR文件" || inherited(slot)?.value !== args.previous);
      if (unmatched) throw new Error(slotLabel(unmatched.slot) + "的模型来源未通过提交前核对");
      submitting = true;
      click(submit);
      const deadline = Date.now() + 6000;
      let confirmed = false;
      do {
        if (!correct()) break;
        const alert = one(visible(".el-message--error .el-message__content"));
        if (alert) throw new Error(txt(alert));
        if (visible(".el-message--success").some(element => /打包|提交/.test(txt(element)))) break;
        if (!confirmed) {
          const prompt = one(visible(".el-message-box,.ivu-modal,.vxe-modal--wrapper.is--active .vxe-modal--box")
            .filter(element => /(?:确认|确定|是否).{0,12}提交打包|提交打包.{0,12}(?:确认|确定)/.test(txt(element))));
          const button = prompt && (btn("确定",prompt) ?? btn("确认",prompt));
          if (button && !button.disabled) {
            click(button);
            confirmed = true;
          }
        }
        await delay(150);
      } while (Date.now() < deadline);
      return { clicked: true };
    }
    return { error: "未知模型阶段" };
  } catch (error) {
    return { error: error.message, beforeSubmission: !submitting };
  }
}
