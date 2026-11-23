import assert from "node:assert/strict";
import test from "node:test";
import { modelRules, modelSearchTerm, trainedModel } from "../gmqm-edge/model-rules.js";
import { matchingModelDownload } from "../gmqm-edge/model-download.js";
import { modelPage } from "../gmqm-edge/model-page.js";
import { createModelState, modelKey, modelWorkflow } from "../gmqm-edge/model-workflow.js";
import { modelArchiveFolders } from "../gmqm-edge/model-storage.js";
import { sha256 } from "../gmqm-edge/model-zip.js";
import { sites } from "../gmqm-edge/sites.js";
import { zip } from "../gmqm-edge/workbook.js";

test("uses the newest training-success row from the selected date and searches by its family only", () => {
  const rule = modelRules.find(entry => entry.key === "碎膜");
  const family = rule.families[0];
  const row = (name, created, state = "训练成功") => ({ name, created, state, version: "v102" });
  const rows = [
    row(family + "v200", "2026-11-20 08:10:00"),
    row(family + "v199", "2026-11-19 23:00:00", "训练失败"),
    row(family + "v94", "2026-11-19 14:04:00"),
    row(family + " v105.2", "2026-11-19 18:20:00"),
    row(family + "v123", "2026-11-18 17:01:00"),
  ];
  const picked = trainedModel(rule, rows, "2026-11-19");
  assert.equal(picked, rows[3]);
  assert.equal(modelSearchTerm(rule, picked.name), family);
});

test("keeps different model dates apart and preserves the legacy batch for the previous day", () => {
  const day = "2026-12-01";
  assert.equal(modelKey(day,"2026-11-30"),"model-workflow:2026-12-01");
  assert.equal(modelKey(day,"2026-11-27"),"model-workflow:2026-12-01:2026-11-27");
  assert.deepEqual(modelArchiveFolders(day,"2026-11-30"),["1201","模型"]);
  assert.deepEqual(modelArchiveFolders(day,"2026-11-27"),["1201","模型","2026-11-27"]);
  assert.deepEqual(modelArchiveFolders(day,day),["1201","模型",day]);
});

test("keeps point-coating votes distinct when the displayed family uses the platform alias", () => {
  const rule = modelRules.find(entry => entry.key === "点涂3");
  const rows = [2, 3].map(vote => ({
    name: "点图膜基础模型v77_vote_" + vote, created: "2026-11-19 10:00:00",
    state: "训练成功", version: "v90",
  }));
  assert.equal(trainedModel(rule, rows, "2026-11-19"), rows[1]);
  assert.equal(modelSearchTerm(rule, rows[1].name), "点图膜基础模型");
});

test("matches the observed F.Brain native download only for the selected model and training version", () => {
  const origin = "http://10.9.30.252:31001";
  const name = "喷涂膜基础模型V87";
  const source = new URL("/file/api/v1/download_model_by_path",origin);
  source.searchParams.set("file_path","/fixture/新喷涂膜合并数据集(V97)_" + name + "(v90)_cls_dynamic");
  const record = {url:source.href};
  assert.equal(matchingModelDownload(record,origin,name,"V90"),source.href);
  assert.equal(matchingModelDownload(record,origin,name,"v9"),"");
  assert.equal(matchingModelDownload(record,"http://192.168.254.12:31001",name,"V90"),"");
  assert.equal(matchingModelDownload(record,origin,"喷涂膜基础模型V86","V90"),"");
});

test("waits through the GMQM empty table and returns the newest displayed MAR first", async t => {
  const origin = "http://gmqm.test";
  const element = (innerText, fields) => ({ innerText, getClientRects: () => [1], ...fields });
  const row = (name, version, date) => element("", {
    classList: { contains: name => name === "el-table__row" },
    cells: [name, version, "模型打包", "未启用", "", date].map(value => element(value)),
  });
  const rows = [
    row("test_v2.0.0.175.mar", "v2.0.0.175", "2026-11-18 14:23:58"),
    row("test_v2.0.0.176.mar", "v2.0.0.176", "2026-11-19 15:06:54"),
  ];
  let polls = 0;
  const table = element("", { querySelectorAll(selector) {
    if (selector === ".el-table__header-wrapper th") return [element("生成时间")];
    if (selector === ".el-table__body-wrapper tbody tr") return polls >= 3 ? rows : [];
    return [];
  } });
  globalThis.window = {};
  globalThis.window.top = globalThis.window;
  globalThis.location = new URL(origin + "/#/modelManage/modelList");
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  globalThis.document = { querySelectorAll(selector) {
    if (selector === ".el-table") return [table];
    if (selector === ".el-table__empty-text" && polls < 3) return [element("暂无数据")];
    return [];
  } };
  t.after(() => {
    for (const key of ["window", "location", "getComputedStyle", "document"]) delete globalThis[key];
  });
  t.mock.method(globalThis, "setTimeout", callback => {
    assert.ok(++polls <= 3, "MAR records should be available after three checks");
    callback();
  });
  const result = await modelPage(origin, "mar");
  assert.equal(polls, 3);
  assert.deepEqual(result.rows.map(record => record.name), ["test_v2.0.0.176.mar", "test_v2.0.0.175.mar"]);
});

test("sets inheritance on the correct file when a group ID and MAR options are repeated", async t => {
  const origin = "http://gmqm.test";
  const pack = {stem:"test_v2.0.0.176",scheme:"湖北恩捷算法方案_v01",previous:"test_v2.0.0.175.mar"};
  const shown = () => [1];
  const elem = (innerText, props) => ({innerText,getClientRects:shown,...props});
  const controls = input => elem("", {querySelectorAll: () => [input]});
  const header = elem("", {value:pack.stem});
  const scheme = elem("模型方案", {closest: () => controls(elem("", {value:pack.scheme}))});
  const openMenus = new Map();
  const cells = [1,2,3].map(number => {
    const file = "film_classification_diantu_wuxi_vote" + number + ".onnx";
    const menu = elem("", {querySelectorAll: () => [option]});
    const scope = {querySelector: selector => selector === ".el-select-dropdown" ? menu : null};
    const input = elem("", {value:"",closest: () => scope,click: () => {
      openMenus.set(menu,() => openMenus.delete(menu));
    }});
    const option = elem(pack.previous, {click: () => {
      openMenus.delete(menu);
      input.value = pack.previous;
    }});
    const row = elem("", {
      cells: [elem("1"),elem("点涂膜"),null,null,null,null,elem(file),
        controls(elem("", {value:"继承MAR文件"})),controls(input)],
      classList: {contains: name => name === "el-table__row"},
    });
    return {row,input,slot:{id:"1",name:"点涂膜",file}};
  });
  const table = elem("", {querySelectorAll(selector) {
    return selector === ".el-table__header-wrapper th" ? [elem("来源配置")] : cells.map(cell => cell.row);
  }});
  let mouseDown = false;
  globalThis.window = {};
  globalThis.window.top = globalThis.window;
  globalThis.location = new URL(origin + "/#/model/modelPack");
  globalThis.getComputedStyle = () => ({visibility:"visible"});
  globalThis.MouseEvent = class extends Event {};
  globalThis.document = {
    body: {dispatchEvent(event) {
      if (event.type === "mousedown") mouseDown = true;
      if (event.type === "mouseup" && mouseDown) {
        for (const close of openMenus.values()) close();
        mouseDown = false;
      }
    }},
    querySelectorAll(selector) {
      if (selector === 'input[placeholder="请输入模型Mar名称"]') return [header];
      if (selector === ".el-form-item label") return [scheme];
      if (selector === ".el-table") return [table];
      if (selector === ".el-select-dropdown") return [...openMenus.keys()];
      return [];
    },
  };
  t.after(() => {
    for (const key of ["window","location","getComputedStyle","MouseEvent","document"]) delete globalThis[key];
  });
  t.mock.method(globalThis,"setTimeout",() => assert.fail("Opening and selecting from the correct menu should pass immediately"));
  cells[0].input.click();
  cells[2].input.click();
  assert.equal(openMenus.size,2);
  assert.deepEqual(await modelPage(origin,"inherit",{...pack,slot:cells[1].slot}),{set:true});
  assert.deepEqual(cells.map(cell => cell.input.value),["",pack.previous,""]);
  assert.equal(openMenus.size,0);
});

const workflowScenarios = [
  ["verify","backfills a newly selected base when verification starts"],
  ["all","continues verification when another base cannot pack and skips already completed work"],
  ["fresh","runs a fresh model batch from training lookup through GMQM verification in one click"],
  ["pack-timeout","keeps the packing page open on timeout and checks the same MAR on restart"],
];
for (const [scenario,name] of workflowScenarios) test(name, async t => {
  const fresh = scenario === "fresh";
  const packingTimeout = scenario === "pack-timeout";
  const stage = fresh || packingTimeout ? "all" : scenario;
  const [wuxi,jintan,suzhou,hubei] = sites;
  const sns = Array.from({length:200},(_,index) => "TEST" + index);
  const state = createModelState();
  const rule = modelRules.find(model => model.key === "涂布");
  const bytes = Uint8Array.of(1,2,3);
  const file = rule.stem + ".onnx";
  const json = rule.stem + ".json";
  const archive = zip([[file,bytes],[json,bytes]],"application/zip");
  const day = "2026-11-20";
  const modelDay = fresh ? "2026-11-16" : "2026-11-19";
  const deployedAt = "2026-11-20 15:12:00";
  const training = {name:rule.families[0]+"v82",version:"v89",created:modelDay+" 16:24:00",state:"训练成功"};
  if (!fresh) {
    state.models[rule.key] = {name:training.name,deployed:deployedAt,zipName:"涂布.zip",
      hashes:{[file]:await sha256(bytes),[json]:await sha256(bytes)}};
    state.stages.scan = "done";
    state.bases[wuxi.id] = {mar:"wuxi_v2.0.0.5.mar",packed:true,verifyRequested:true,sns};
    state.bases[suzhou.id] = {mar:"suzhou_v2.0.0.5.mar",packed:true,verified:true,sns};
  }
  state.bases[jintan.id] = {sns};
  state.bases[hubei.id] = {sns};
  const oldMar = "jintan_v2.0.0.4.mar";
  const newMar = "jintan_v2.0.0.5.mar";
  const tabs = [];
  const packed = [];
  const submitted = [];
  const inspected = [];
  const steps = [];
  let packTabId;
  let statusChecks = 0;
  let stallPacking = packingTimeout;
  let now = Date.now();
  const created = "2026-11-20 16:48:00";
  let deployed = false;
  let download = false;
  const archiveBytes = Buffer.from(await archive.arrayBuffer());
  const stored = new Map(fresh ? [] : [["涂布.zip",archive]]);
  const root = {
    queryPermission: async () => "granted",
    getDirectoryHandle: async () => root,
    getFileHandle: async (name,{create = false} = {}) => {
      if (!create && !stored.has(name)) throw new DOMException("Missing fixture file","NotFoundError");
      let pending;
      return {getFile:async()=>stored.get(name),createWritable:async()=>({
        write:async data=>{ pending=data; },close:async()=>{ stored.set(name,new File([pending],name)); },abort:async()=>{},
      })};
    },
  };
  t.mock.method(Date,"now",() => now);
  t.mock.method(globalThis,"setTimeout",(resolve,delay) => {
    assert.notEqual(packTabId,undefined,"Only MAR tracking should wait in this fixture");
    assert.equal(delay,12_000);
    now += stallPacking ? 10*60_000 : delay;
    queueMicrotask(resolve);
  });
  globalThis.indexedDB = {open() {
    const request = {result:{close(){},transaction() {
      const tx = {objectStore:() => ({index:() => ({getAll:() => ({result:[]})})})};
      queueMicrotask(() => tx.oncomplete());
      return tx;
    }}};
    queueMicrotask(() => request.onsuccess());
    return request;
  }};
  globalThis.chrome = {
    storage:{local:{set:async()=>{}}},
    tabs:{
      create:async ({url,active}) => {
        if (packTabId !== undefined) assert.equal(active,false);
        const tab = {id:tabs.length,url,status:"complete"};
        tabs.push(tab);
        return tab;
      },
      get:async id => tabs[id],
      update:async (id,change) => {
        if (packTabId !== undefined) {
          assert.notEqual(id,packTabId,"The packing tab must stay on the submitted form");
          assert.notEqual(change.active,true,"Waiting for MAR must not switch tabs");
        }
        return Object.assign(tabs[id],change);
      },
      reload:async id => assert.notEqual(id,packTabId,"Never refresh the packing tab"),
    },
    scripting:{async executeScript({target,args:[origin,action,args]}) {
      steps.push(action);
      const site = sites.find(entry => entry.origin === origin);
      const tab = tabs[target.tabId];
      let result = {ok:true};
      if (action.startsWith("__model_download_")) {
        if (args === "arm") result = {armed:true};
        if (args === "status") result = {size:download ? archiveBytes.length : 0};
        if (args === "read") result = archiveBytes.toString("base64");
      } else if (action === "scan") {
        assert.equal(args.day,modelDay);
        result = {rows:origin===rule.origin ? [
          {...training,name:rule.families[0]+"v83",version:"v90",created:"2026-11-19 16:24:00"},training,
        ] : []};
      } else if (action === "deployments") {
        assert.equal(args.day,day);
        assert.equal(args.version,training.version);
        result = {matches:deployed ? [{status:"部署成功",time:deployedAt}] : []};
      } else if (action === "deploy") {
        deployed = true;
        result = {submitted:true};
      } else if (action === "detail") {
        tab.url = origin + "/#/model/deploy_detail/1";
      } else if (action === "configuration") {
        result = {verified:true};
      } else if (action === "download") {
        assert.equal(args.day,day);
        download = true;
      } else if (action === "mar") {
        if (packTabId !== undefined && site.id === jintan.id) {
          assert.ok(statusChecks >= 2,"Do not check the list while the form is submitting");
          assert.notEqual(tab.id,packTabId);
          packTabId = undefined;
        }
        const names = site.id === jintan.id ? (packed.length ? [newMar,oldMar] : [oldMar]) :
          [state.bases[site.id].mar ?? "hubei_v2.0.0.4.mar"];
        result = {rows:names.map(name=>({name}))};
      } else if (action === "prepare") {
        if (site.id === hubei.id) return [{result:{error:"Mock Hubei form unavailable",beforeSubmission:true}}];
        result = {slots:[{id:"2",name:"涂布膜",file}]};
      } else if (action === "submit") {
        packed.push(site.id);
        packTabId = tab.id;
      } else if (action === "packStatus") {
        assert.equal(tab.id,packTabId);
        result = {busy:++statusChecks === 1 || stallPacking};
      } else if (action === "validate") {
        assert.deepEqual(args.sns,sns);
        submitted.push(site.id);
      } else if (action === "validationTasks") {
        result = {tasks:[{status:"验证完成",created,details:true}]};
      } else if (action === "openValidationDetail") {
        assert.equal(args.created,created);
        tab.url = origin + "/#/model_validation?inferId=1";
      } else if (action === "validationStatus") {
        assert.deepEqual(args.sns,sns);
        inspected.push(site.id);
        result = {read:true,matches:true};
      }
      return [{result}];
    }},
  };
  t.after(() => { delete globalThis.chrome; delete globalThis.indexedDB; });
  const selected = fresh ? [jintan.id] : [wuxi.id,jintan.id,suzhou.id];
  if (scenario === "all") selected.push(hubei.id);
  const run = bases => modelWorkflow({day,modelDay,windowId:1,selected:bases,
    root,state,log:()=>{},signal:new AbortController().signal}).run(stage);
  if (packingTimeout) {
    await assert.rejects(run(selected),/尚未确认打包结果，已保留打包页/);
    assert.equal(state.bases[jintan.id].packTabId,packTabId);
    assert.equal(state.bases[jintan.id].packed,undefined);
    assert.equal(submitted.length,0);
    stallPacking = false;
    await run(selected);
    assert.equal(state.stages.verify,"done");
  } else if (scenario === "all") {
    await assert.rejects(run(selected),/GMQM 打包 MAR/);
    assert.equal(state.stages.verify,"error");
    const before = steps.length;
    assert.deepEqual(await run(selected.slice(0,3)),{alreadyDone:true});
    assert.equal(steps.length,before);
    assert.ok(!steps.some(action => ["scan","deploy","download"].includes(action)));
  } else {
    await run(selected);
    assert.equal(state.stages.verify,"done");
    if (fresh) {
      assert.deepEqual(steps.filter(action=>["scan","deploy","download","submit","validate"].includes(action)),
        ["scan","scan","deploy","download","submit","validate"]);
      assert.ok(stored.has("涂布.zip"));
      assert.ok(stored.has("涂布_原包_" + training.name + "_" + training.version + ".zip"));
    }
  }
  assert.deepEqual(packed,[jintan.id]);
  assert.deepEqual(submitted,[jintan.id]);
  assert.deepEqual(inspected.sort(),fresh ? [jintan.id] : [jintan.id,wuxi.id]);
  assert.equal(state.bases[jintan.id].mar,newMar);
  assert.equal(state.bases[jintan.id].verified,true);
});

test("switches the GMQM radio button to production data and verifies the entered SNs before Start", async t => {
  const origin = "http://gmqm.test";
  const name = "film_classification_wuxi_enji_v2.0.0.177.mar";
  const sns = Array.from({length:200},(_,index) => "TEST" + index);
  const element = (innerText, fields) => ({innerText,getClientRects:() => [1],...fields});
  const nativeRadio = {checked:false};
  let textarea;
  let started = 0;
  class TextArea {
    text = "";
    get value() { return this.text; }
    set value(value) { this.text = value; }
    getClientRects() { return [1]; }
    focus() {}
    dispatchEvent() {}
    blur() {}
  }
  const production = element("生产卷数据",{
    getAttribute: attr => attr === "aria-checked" && nativeRadio.checked ? "true" : null,
    classList:{contains:() => false},
    querySelector: selector => selector === 'input[type="radio"]' ? nativeRadio : null,
    click() {
      nativeRadio.checked = true;
      textarea = new TextArea();
    },
  });
  const start = element("开始",{click:() => { started += 1; }});
  const dialog = element(`模型验证配置\n验证模型：\n${name}\n图库数据\n生产卷数据`,{
    querySelector: selector => selector === ".vxe-modal--content" ? element(`验证模型：\n${name}`) : null,
    querySelectorAll(selector) {
      if (selector.split(",").includes('label[role="radio"]')) return [element("图库数据"),production];
      if (selector.startsWith("textarea")) return textarea ? [textarea] : [];
      if (selector === "button") return [start];
      return [];
    },
  });
  globalThis.window = {};
  globalThis.window.top = globalThis.window;
  globalThis.location = new URL(origin + "/#/modelManage/modelList");
  globalThis.getComputedStyle = () => ({visibility:"visible"});
  globalThis.HTMLTextAreaElement = TextArea;
  globalThis.document = {querySelectorAll: selector => selector.includes(".vxe-modal--box") ? [dialog] : []};
  t.after(() => {
    for (const key of ["window","location","getComputedStyle","HTMLTextAreaElement","document"]) delete globalThis[key];
  });
  t.mock.method(globalThis,"setTimeout",() => assert.fail("Expected the fixture controls to be immediately available"));
  assert.deepEqual(await modelPage(origin,"prepareValidation",{name,sns}),{prepared:true});
  assert.equal(nativeRadio.checked,true);
  assert.equal(textarea.value,sns.join("\n"));
  textarea.value = "changed";
  assert.equal((await modelPage(origin,"validate",{name,sns})).beforeSubmission,true);
  assert.equal(started,0);
  await modelPage(origin,"prepareValidation",{name,sns});
  assert.deepEqual(await modelPage(origin,"validate",{name,sns}),{clicked:true});
  assert.equal(started,1);
});
