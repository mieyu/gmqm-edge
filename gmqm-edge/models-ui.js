import { chinaDate } from "./sop.js";
import { modelRules } from "./model-rules.js";
import { sites } from "./sites.js";
import { workWindow } from "./workspace.js";
import { modelArchiveFolders, modelDirectory, saveDirectory, savedDirectory, saveVerifiedFile } from "./model-storage.js";
import { modelPackage } from "./model-zip.js";
import { createModelState, modelKey, modelStages, modelWorkflow } from "./model-workflow.js";

const byId = id => document.getElementById(id);
const date = byId("model-date");
const boxes = byId("bases");
const phases = byId("model-stages");
const input = byId("raw-model-file");
const feedback = byId("model-feedback");
const manualModel = byId("raw-model");
const host = new URL(location.href).searchParams;
const message = text => { feedback.textContent = text; };
let root;
let job;
let workDay = chinaDate();
let loadedModelDay;
let state = createModelState();
const activity = new Map();
const statusLabels = {done:"完成", running:"进行中", error:"需处理", paused:"已暂停"};
const siteScope = host.get("site");
const savedScope = day => "model-base-selection:" + (siteScope ?? "all") + ":" + day;
const selectedBases = () => [...boxes.querySelectorAll("input:checked")].map(box => box.value);

date.value = workDay;
for (const site of sites) {
  const label = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = site.id;
  box.checked = !sites.some(s => s.id === siteScope) || siteScope === site.id;
  label.append(box, site.name);
  boxes.append(label);
}
for (const rule of modelRules) manualModel.add(new Option(rule.key,rule.key));

function render() {
  const selected = selectedBases();
  const activeSites = sites.filter(site => selected.includes(site.id));
  const disabled = Boolean(job) || loadedModelDay !== date.value;
  for (const el of [date,byId("directory"),byId("run-models"),input,manualModel,...boxes.querySelectorAll("input")]) {
    el.disabled = disabled;
  }
  byId("pause-models").disabled = !job || job.signal.aborted;
  byId("selection").textContent = date.value && date.validity.valid
    ? "查找 " + date.value + " 创建且训练成功的模型 · 作业日期 " + workDay + " · " +
      (root ? [root.name,...modelArchiveFolders(workDay,date.value)].join("\\") : "尚未选择本地模型目录")
    : "请选择模型日期";
  phases.replaceChildren(...modelStages.map(([id,label])=>{
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = disabled;
    button.textContent = label;
    button.addEventListener("click",()=>void start(id));
    const status = document.createElement("span");
    status.textContent = statusLabels[state.stages[id]] ?? "待运行";
    if (["mar","verify"].includes(id) && state.stages[id] !== "running") {
      const pending = activeSites.filter(site => !state.bases[site.id]?.[id === "mar" ? "packed" : "verified"]);
      status.textContent = !activeSites.length ? "未选基地" : pending.length
        ? (id === "mar" ? "待打包 · " : "待验证 · ") + pending.map(site => site.name).join("、") : "完成";
    }
    item.append(button,status);
    return item;
  }));
  const progress = new Map(activity);
  for (const site of sites) {
    if (!selected.includes(site.id)) {
      progress.delete(site.name);
      continue;
    }
    if (progress.has(site.name)) continue;
    const item = state.bases[site.id];
    progress.set(site.name,item?.verified ? "200 卷验证完成" : item?.verifyRequested ? "验证待核对" :
      item?.packed ? item.mar + " 已打包，待验证" : item?.packRequested ? item.mar + " 打包待核对" : "待打包");
  }
  byId("model-progress").replaceChildren(...[...progress].map(([label,text])=>{
    const row = document.createElement("li");
    row.textContent = label + " · " + text;
    return row;
  }));
}

async function load(modelDay) {
  const day = chinaDate();
  const key = modelKey(day,modelDay);
  const scopeKey = savedScope(day);
  const saved = await chrome.storage.local.get([key,scopeKey]);
  if (modelDay !== date.value) return;
  workDay = day;
  loadedModelDay = modelDay;
  state = saved[key] ?? createModelState();
  for (const box of boxes.querySelectorAll("input")) {
    box.checked = Array.isArray(saved[scopeKey]) ? saved[scopeKey].includes(box.value) :
      !sites.some(site => site.id === siteScope) || siteScope === box.value;
  }
  for (const [key,value] of Object.entries(state.stages)) {
    if (value === "running") state.stages[key] = "paused";
  }
  activity.clear();
  for (const [name,item] of Object.entries(state.models)) {
    activity.set(name,item.zipName ? item.zipName + " 已校验" : item.raw ? "原包已保存" :
      item.deployed ? "部署成功" : item.deployRequested ? "部署待核对" : item.name);
  }
  render();
}

async function start(stage) {
  if (job || !date.reportValidity() || loadedModelDay !== date.value) return;
  job = new AbortController();
  const selected = selectedBases();
  const modelDay = date.value;
  const day = chinaDate();
  message("运行中，可切换插件页签或收起浮窗。");
  render();
  try {
    if (["all","mar","verify"].includes(stage) && !selected.length) throw new Error("请勾选 GMQM 基地");
    const result = await navigator.locks.request("gmqm-model-workflow", {ifAvailable:true},async lock=>{
      if (!lock) throw new Error("已有模型流程在运行");
      const key = modelKey(day,modelDay);
      state = (await chrome.storage.local.get(key))[key] ?? createModelState();
      if (workDay !== day) activity.clear();
      workDay = day;
      for (const [id,value] of Object.entries(state.stages)) {
        if (value === "running") state.stages[id] = "paused";
      }
      for (const site of sites) activity.delete(site.name);
      const windowId = await workWindow(Number(host.get("host")) || undefined);
      const runner = modelWorkflow({day,modelDay,windowId,selected,root,state,signal:job.signal,log(label,text){
        activity.set(label,text);
        render();
      }});
      return runner.run(stage);
    });
    message(result?.alreadyDone ? "本批选中基地均已完成验证。" : result?.empty ? modelDay + " 没有训练成功的匹配模型。" :
      stage === "all" ? "本批模型流程完成。" : "所选阶段完成。");
  } catch (error) {
    message(job.signal.aborted ? "已暂停，重跑时会核对已提交的任务。" : error.message);
  } finally {
    job = null;
    render();
  }
}

byId("directory").addEventListener("click",async ()=>{
  try {
    if (typeof showDirectoryPicker !== "function") throw new Error("此 Edge 未启用目录选择能力");
    const selected = await showDirectoryPicker({id:"gmqm-update-models",mode:"readwrite",startIn:root ?? "desktop"});
    root = selected;
    await saveDirectory(root);
    message("已授权模型归档目录。");
    render();
  } catch (error) {
    if (error.name !== "AbortError") message(error.message);
  }
});

input.addEventListener("change",async ()=>{
  const [file] = input.files;
  input.value = "";
  if (!file || job || !date.reportValidity() || loadedModelDay !== date.value) return;
  const rule = modelRules.find(entry=>entry.key===manualModel.value);
  const modelDay = date.value;
  const day = chinaDate();
  const key = modelKey(day,modelDay);
  job = new AbortController();
  render();
  try {
    if (day !== workDay) {
      state = (await chrome.storage.local.get(key))[key] ?? createModelState();
      workDay = day;
      activity.clear();
    }
    const path = await modelDirectory(root,day,modelDay);
    const previous = state.models[rule.key];
    await modelPackage(file,rule,file.name + " " + (previous?.name ?? ""));
    const filename = rule.key + "_原包_" + file.name;
    const hash = await saveVerifiedFile(path,filename,file);
    state.models[rule.key] = {...previous,name:previous?.name ?? file.name,raw:filename,rawHash:hash};
    delete state.models[rule.key].zipName;
    delete state.models[rule.key].hashes;
    await chrome.storage.local.set({[key]:state});
    activity.set(rule.key,"本地原包已关联");
    message("已导入，可运行「整理并校验 ZIP」。");
  } catch (error) {
    message(error.message);
  } finally {
    job = null;
    render();
  }
});

byId("run-models").addEventListener("click",()=>void start("all"));
byId("pause-models").addEventListener("click",()=>{
  job?.abort();
  message("正在等待当前页面操作返回。");
  render();
});
date.addEventListener("change",()=>{
  message("");
  render();
  if (date.value && date.validity.valid) void load(date.value).catch(error=>message(error.message));
});
boxes.addEventListener("change",()=>{
  message("");
  for (const [id,label] of modelStages) {
    if (id === "mar" || id === "verify") activity.delete(label);
  }
  render();
  void chrome.storage.local.set({[savedScope(chinaDate())]:selectedBases()}).catch(error=>message(error.message));
});
root = await savedDirectory().catch(()=>null);
await load(date.value);
