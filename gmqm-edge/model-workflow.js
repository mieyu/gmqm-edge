import { exportCapture } from "./export-capture.js";
import { pageAction } from "./page.js";
import { modelPage } from "./model-page.js";
import { brain, modelRules, nextMar, randomSample, schemes, trainedModel } from "./model-rules.js";
import { checkModelZip, readZip } from "./model-zip.js";
import { modelDirectory, packageModel, readNamed, saveVerifiedFile } from "./model-storage.js";
import { dailyExports, saveDailyExport } from "./daily-cache.js";
import { inspectNativeModelDownload } from "./model-download.js";
import { queryAndExport } from "./grading.js";
import { previousDay } from "./sop.js";
import { sites } from "./sites.js";

const list = "#/model/model_list";
const deployments = "#/model/create_model";
const marList = "#/modelManage/modelList";
const marPack = "#/model/modelPack";
const validationList = "#/modelManage/modelInfer";
const partSize = 1024 ** 2;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const modelStages = [
  ["scan","查找训练完成模型"], ["deploy","部署 ONNX"], ["download","下载原包"],
  ["zip","整理并校验 ZIP"], ["mar","GMQM 打包 MAR"], ["verify","提交 GMQM 验证"],
];
export const modelKey = (day, modelDay) => "model-workflow:" + day +
  (modelDay === previousDay(day) ? "" : ":" + modelDay);
export const createModelState = () => ({ models: {}, bases: {}, stages: {} });
class PendingMar extends Error {}

async function runScript(tab, func, args, world = "ISOLATED") {
  const [entry] = await chrome.scripting.executeScript({target:{tabId:tab},func,args,world});
  const result = entry?.result;
  if (entry?.error || result?.error) {
    const error = new Error(entry?.error ?? result.error);
    error.beforeSubmission = result?.beforeSubmission === true;
    throw error;
  }
  if (result === undefined) throw new Error("页面没有返回结果");
  return result;
}

export function modelWorkflow({day, modelDay, windowId, selected, root, state, log, signal}) {
  const tabs = new Map();
  const check = () => signal.throwIfAborted();
  let saved = Promise.resolve();
  const commit = () => {
    const write = saved.then(() => chrome.storage.local.set({[modelKey(day,modelDay)]: state}));
    saved = write.catch(() => {});
    return write;
  };
  const notify = async (label, message) => {
    log(label, message);
    await commit();
  };
  const bounded = async (read, description, timeout, interval) => {
    const end = Date.now() + timeout;
    do {
      check();
      const result = await read();
      if (result) return result;
      await sleep(interval);
    } while (Date.now() < end);
    throw new Error(description);
  };
  const watchReceipt = (read, description, timeout, interval) => {
    let failedReads = 0;
    return bounded(async () => {
      try {
        const receipt = await read();
        failedReads = 0;
        return receipt;
      } catch (error) {
        check();
        if (++failedReads === 3) throw error;
        return null;
      }
    },description,timeout,interval);
  };
  async function navigate(origin, hash, refresh = false, lane = origin, active = true) {
    check();
    const url = origin + "/" + hash;
    let tabId = tabs.get(lane);
    let tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (tab?.url && !tab.url.startsWith(origin + "/")) tab = null;
    if (!tab) {
      tab = await chrome.tabs.create({ url, active, windowId });
      tabId = tab.id;
      tabs.set(lane, tabId);
    } else {
      await chrome.tabs.update(tabId, {...(active ? {active:true} : {}),...(tab.url === url ? {} : {url})});
      if (refresh && tab.url === url) await chrome.tabs.reload(tabId);
    }
    let loginSent = false;
    let backToTarget = false;
    await bounded(async () => {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url === url && tab.status === "complete") return true;
      if (tab.url?.startsWith(origin + "/#/login") && tab.status === "complete") {
        const site = sites.find(entry => entry.origin === origin);
        if (!site) throw new Error("请先在 Edge 登录 " + (origin === brain.company ? "公司" : "无锡") + " F.Brain");
        if (!loginSent) {
          const {accounts} = await chrome.storage.local.get("accounts");
          const account = accounts?.[site.id];
          if (!account) throw new Error("请先登录" + site.name + " GMQM 管理员");
          const outcome = await runScript(tabId,pageAction,[origin,"login",account]);
          loginSent = outcome?.state === "submitted";
        }
      } else if (!backToTarget && loginSent && tab.url === origin + "/#/home") {
        backToTarget = true;
        await chrome.tabs.update(tabId,{url});
      }
      return false;
    }, "无法进入平台页面：" + url,45_000,350);
    return tabId;
  }
  const onPage = async (tab,origin,action,params) => {
    if (signal.aborted) {
      const error = new Error("已暂停，尚未执行页面操作");
      error.beforeSubmission = true;
      throw error;
    }
    return runScript(tab,modelPage,[origin,action,params ?? {}]);
  };
  const targets = () => modelRules.filter(rule => state.models[rule.key]?.name);
  async function each(items, work, {tracking = false, tolerate = false} = {}) {
    const run = async item => {
      check();
      try {
        await work(item);
      } catch (error) {
        if (signal.aborted || error instanceof PendingMar) throw error;
        const name = item.key ?? item.name;
        await notify(name,error.message);
        return name;
      }
    };
    const blocked = [];
    if (tracking) {
      const outcomes = await Promise.allSettled(items.map(run));
      check();
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
        if (outcome.value) blocked.push(outcome.value);
      }
    } else {
      for (const item of items) {
        const name = await run(item);
        if (name) blocked.push(name);
      }
    }
    if (!tolerate && blocked.length) throw new Error("未完成：" + blocked.join("、"));
  }
  function expectModels() {
    if (!state.stages.scan && !targets().length) throw new Error("请先查找模型，或从本地导入原包");
    return targets();
  }
  async function deploymentConfig(origin, tab, query) {
    await onPage(tab,origin,"detail",query);
    await bounded(async () => (await chrome.tabs.get(tab)).url?.startsWith(origin + "/#/model/deploy_detail/"),
      "部署配置详情未打开",20_000,250);
    return onPage(tab,origin,"configuration",query);
  }
  async function finalZip(directory,item) {
    const file = item.zipName && item.hashes && await readNamed(directory,item.zipName);
    if (file) await checkModelZip(file,item.hashes);
    return file;
  }
  const handlers = {
    async scan() {
      for (const origin of [brain.company,brain.wuxi]) {
        const tab = await navigate(origin,list,true);
        const {rows} = await onPage(tab,origin,"scan",{day:modelDay});
        for (const rule of modelRules.filter(item => item.origin === origin)) {
          const trained = trainedModel(rule,rows,modelDay);
          const prior = state.models[rule.key];
          if (!trained) {
            if (!prior?.raw && !prior?.deployRequested && !prior?.deployed) delete state.models[rule.key];
            await notify(rule.key,state.models[rule.key] ? "保留本批已选模型" : modelDay + " 没有训练成功的匹配模型");
          } else {
            if (prior?.name !== trained.name || prior?.version !== trained.version) {
              if (prior?.deployRequested || prior?.raw || prior?.deployed) {
                await notify(rule.key,"保留本批已选版本 · " + prior.version);
                continue;
              }
              state.models[rule.key] = trained;
            }
            await notify(rule.key,"已选 " + trained.name + " · " + trained.version);
          }
        }
      }
    },
    async deploy(retryUnlisted) {
      const pending = expectModels().filter(rule => {
        const item = state.models[rule.key];
        return !item.raw && (!item.deployed || retryUnlisted);
      });
      // One-click deployment needs a place to save the resulting packages.
      if (!retryUnlisted && pending.length) await modelDirectory(root,day,modelDay);
      await each(pending,async rule => {
        const item = state.models[rule.key], origin = rule.origin;
        const query = {...item,day};
        const excluded = new Set();
        const inspect = async () => {
          let tab = await navigate(origin,deployments,true);
          const records = (await onPage(tab,origin,"deployments",query)).matches
            .sort((a,b) => b.time.localeCompare(a.time));
          for (const record of records.filter(row => row.status === "部署成功" && !excluded.has(row.time))) {
            tab = await navigate(origin,deployments);
            const config = await deploymentConfig(origin,tab,{...query,time:record.time});
            if (config.verified) return {ready:record, pending:false};
            excluded.add(record.time);
            await notify(rule.key,"现有部署尺寸 " + config.width + "×" + config.height + " 或配置与 SOP 不符，已排除");
          }
          return {pending:records.some(row=>!excluded.has(row.time) && !/成功|失败/.test(row.status)),
            rejected:records.length > 0 && records.every(row => excluded.has(row.time) || /失败/.test(row.status))};
        };
        let result = await inspect();
        if (!result.ready && !result.pending && item.deployRequested && !result.rejected) {
          // Repeated list checks are read-only. A deliberate per-stage retry can recover
          // a previous click that never created a deployment record.
          for (let attempt=0;attempt<2 && !result.ready && !result.pending && !result.rejected;attempt++) {
            await sleep(4500);
            result = await inspect();
          }
          if (!result.ready && !result.pending && !result.rejected &&
              (!retryUnlisted || Date.now() - (item.deployAt ?? 0) < 60_000)) {
            throw new Error("部署请求尚未在 F.Brain 列表确认，已保留本次版本供重查");
          }
        }
        let acknowledgement = "";
        if (!result.ready && !result.pending) {
          const tab = await navigate(origin,list,true);
          item.deployRequested = true;
          item.deployAt = Date.now();
          delete item.deployed;
          await commit();
          const sent = await onPage(tab,origin,"deploy",query).catch(error => {
            if (error.beforeSubmission) delete item.deployRequested;
            throw error;
          });
          if (!sent.submitted) throw new Error("未确认部署已提交");
          acknowledgement = sent.acknowledgement;
        }
        let deployed = result.ready;
        if (!deployed) {
          await notify(rule.key,"按模型名称和训练版本核对 F.Brain 部署记录");
          let listed = result.pending;
          const observedAt = Date.now();
          deployed = await bounded(async () => {
            const snapshot = await inspect();
            if (snapshot.ready) return snapshot.ready;
            listed ||= snapshot.pending;
            const elapsed = Date.now() - (item.deployAt ?? observedAt);
            if (snapshot.rejected && elapsed >= 60_000 && !snapshot.pending) {
              throw new Error("只有失败或配置不符的记录，未找到符合 SOP 的部署");
            }
            if (!listed && elapsed >= 60_000) {
              throw new Error(acknowledgement ?
                "未找到新部署记录，平台提示：" + acknowledgement :
                "部署请求一分钟内未入列，重跑会先核对本次版本");
            }
            return null;
          },"部署已入列，平台处理超时；重跑会核对同一记录",12*60_000,8_000);
        }
        item.deployed = deployed.time;
        await notify(rule.key,"部署成功 · 285×285 · " + deployed.time);
      });
    },
    async download() {
      const directory = await modelDirectory(root,day,modelDay);
      await each(expectModels(), async rule => {
        const item = state.models[rule.key];
        if (item.raw && (await readNamed(directory,item.raw))?.size) return;
        if (await finalZip(directory,item)) return;
        if (item.raw && !item.deployed && item.version) {
          delete item.raw;
          delete item.rawHash;
          await commit();
        }
        if (!item.deployed) throw new Error("需先确认 ONNX 部署成功");
        const origin = rule.origin;
        let tab = await navigate(origin,deployments);
        const query = {...item,day,time:item.deployed};
        const config = await deploymentConfig(origin,tab,query);
        if (!config.verified) {
          delete item.deployed;
          throw new Error("部署详情未通过 ONNX、最新模型及 285×285 核对；下次运行会重新查部署记录");
        }
        tab = await navigate(origin,deployments);
        const name = rule.key + "_原包_" + item.name + "_" + item.version + ".zip";
        const token = "__model_download_" + crypto.randomUUID().replaceAll("-","");
        const capture = (command,arg = null) => runScript(tab,exportCapture,[origin,token,command,arg,"zip"],"MAIN");
        try {
          if (!(await capture("arm",name))?.armed) throw new Error("无法准备 ZIP 下载");
          const previous = item.downloadAttempt;
          const existing = previous?.deployment === item.deployed && Number.isFinite(previous.started)
            ? await inspectNativeModelDownload(origin,item,previous.started) : null;
          const resume = existing && existing.record.state !== "interrupted";
          const started = resume ? previous.started : Date.now() - 500;
          if (resume) {
            log(rule.key,"继续跟踪 Edge 中的同一份 ONNX 下载");
          } else {
            item.downloadAttempt = {deployment:item.deployed,started};
            await commit();
            log(rule.key,"已核对 285×285，正在选择 ONNX 下载");
            await onPage(tab,origin,"download",query);
            log(rule.key,"已选 ONNX，等待 F.Brain 返回原包");
          }
          let bytesReported = 0;
          let usedNative = false;
          const size = await bounded(async () => {
            const captured = (await capture("status"))?.size;
            if (captured) return captured;
            const download = await inspectNativeModelDownload(origin,item,started);
            if (!download) return null;
            const {record,address} = download;
            if (record.state === "interrupted") {
              throw new Error("Edge 中的 ONNX 下载已中断，请查看浏览器下载列表");
            }
            if (record.state !== "complete") {
              if (record.bytesReceived > bytesReported) {
                bytesReported = record.bytesReceived;
                log(rule.key,"Edge 下载中 · " + (bytesReported / partSize).toFixed(1) + " MB");
              }
              return null;
            }
            if (record.danger && !["safe","accepted","allowlistedByPolicy"].includes(record.danger)) {
              throw new Error("Edge 下载尚未标记为可用，请查看浏览器下载列表");
            }
            log(rule.key,"浏览器已下载，正在读取原包并校验");
            if (!await capture("fetchModel",address)) {
              delete item.downloadAttempt;
              throw new Error("浏览器已下载，但 F.Brain 未能返回同一原包；可以重新一键运行，或导入已下载的原包");
            }
            usedNative = true;
            const result = (await capture("status"))?.size;
            if (record.fileSize > 0 && record.fileSize !== result) throw new Error("读取的 ZIP 大小与浏览器下载记录不符");
            return result;
          },"未等到本模型的下载。若 Edge 显示保存对话框，请先完成保存",150_000,800);
          if (!usedNative) log(rule.key,"收到 ZIP，正在读取原包并校验");
          const chunks = [];
          for (let offset=0;offset<size;offset+=partSize) {
            check();
            const part = atob(await capture("read",offset));
            if (part.length !== Math.min(partSize,size-offset)) throw new Error("下载 ZIP 读取不完整");
            chunks.push(Uint8Array.from(part,byte=>byte.charCodeAt(0)));
          }
          const archive = new Blob(chunks,{type:"application/zip"});
          await readZip(archive);
          item.rawHash = await saveVerifiedFile(directory,name,archive);
          item.raw = name;
          delete item.downloadAttempt;
          await notify(rule.key,"原包已保存并校验");
        } finally {
          await capture("release").catch(()=>{});
        }
      });
    },
    async zip() {
      const directory = await modelDirectory(root,day,modelDay);
      await each(expectModels(),async rule=>{
        const item = state.models[rule.key];
        if (await finalZip(directory,item)) return;
        if (!item.raw) throw new Error("没有已关联的原包");
        Object.assign(item,await packageModel(directory,rule,item));
        await notify(rule.key,item.zipName + " · 原包、解压文件、ZIP 的 SHA-256 一致");
      });
    },
  };
  async function listMar(site, refresh = false, active = true) {
    const tab = await navigate(site.origin,marList,refresh,site.origin + ":mar-list",active);
    return {tab,rows:(await onPage(tab,site.origin,"mar")).rows};
  }
  async function confirmMar(site,section) {
    log(site.name,"保留打包页面，等待 GMQM 生成 " + section.mar);
    try {
      await watchReceipt(async () => {
        if (Number.isInteger(section.packTabId)) {
          const tab = await chrome.tabs.get(section.packTabId).catch(() => null);
          if (tab?.url?.split("?")[0] === site.origin + "/" + marPack) {
            const {busy} = await onPage(tab.id,site.origin,"packStatus",{stem:section.mar.replace(/\.mar$/i,"")});
            if (busy) return false;
          }
        }
        // Query only the background list tab, leaving the submission tab untouched.
        return (await listMar(site,true,false)).rows.some(row=>row.name===section.mar);
      },"列表尚未出现 " + section.mar,10*60_000,12_000);
    } catch (error) {
      check();
      const message = "尚未确认打包结果，已保留打包页。" + error.message + "。再次运行会核对同一版本。";
      await notify(site.name,message);
      throw new PendingMar(site.name + " · " + message);
    }
    section.packed = true;
    delete section.packTabId;
    await notify(site.name,"打包完成 · " + section.mar);
  }
  async function resumePendingPacks(targetSites) {
    for (const site of targetSites) {
      const section = state.bases[site.id];
      if (section?.packRequested && !section.packed) await confirmMar(site,section);
    }
  }
  function baseTargets() {
    const targets = sites.filter(site => selected.includes(site.id));
    if (!targets.length) throw new Error("请勾选 GMQM 打包和验证的基地");
    return targets;
  }
  async function packMar(targetSites, throwOnBlocked = true) {
    if (!targetSites.length) return;
    await resumePendingPacks(targetSites);
    targetSites = targetSites.filter(site=>!state.bases[site.id]?.packed);
    if (!targetSites.length) return;
    const models = expectModels();
    const archives = new Map();
    let archiveError;
    if (models.length) {
      try {
        const directory = await modelDirectory(root,day,modelDay);
        for (const rule of models) {
          const item = state.models[rule.key];
          const file = await finalZip(directory,item);
          if (!file) throw new Error(rule.key + "尚未完成 ZIP 整理");
          archives.set(rule.key,{name:item.zipName,file});
        }
      } catch (error) {
        archiveError = error;
      }
    }
    await each(targetSites,async site=>{
      const section = (state.bases[site.id] ??= {});
      log(site.name,"正在等待 GMQM 模型列表返回 MAR 记录");
      const live = await listMar(site,true);
      if (section.mar && live.rows.some(row=>row.name === section.mar)) {
        section.packed = true;
        return notify(site.name,"已确认 MAR 存在 · " + section.mar);
      }
      if (!models.length) return notify(site.name,"本次没有更新模型");
      if (archiveError) throw archiveError;
      const [latest] = live.rows;
      const stem = nextMar(latest.name);
      const scheme = schemes[site.id];
      log(site.name,"上一版 " + latest.name + " · 正在载入 " + scheme);
      const tab = await navigate(site.origin,marPack);
      const pack = {stem,scheme,previous:latest.name,notes:"更新" + models.map(rule=>rule.key).join("、") + "模型"};
      const slots = (await onPage(tab,site.origin,"prepare",pack)).slots;
      const slotRules = slots.map(slot=>({ ...slot,rule:models.find(rule=>slot.file.toLowerCase()
        .replace(/\.onnx$/,"")===rule.stem.toLowerCase()) }));
      const changed = slotRules.filter(slot=>slot.rule).map(slot=>slot.rule.key);
      if (!changed.length) throw new Error("所选方案没有与本批 ZIP 文件名匹配的槽位");
      await onPage(tab,site.origin,"prepare",{...pack,notes:"更新"+changed.join("、")+"模型"});
      const confirmed = [];
      for (const {rule,...slot} of slotRules) {
        log(site.name,(confirmed.length + 1) + "/" + slotRules.length + " · " +
          (rule ? "导入 " + rule.key + ".zip" : "继承 " + slot.name));
        if (!rule) {
          await onPage(tab,site.origin,"inherit",{...pack,slot});
          confirmed.push({slot});
          continue;
        }
        const {name,file} = archives.get(rule.key);
        const token = "__model_upload_" + crypto.randomUUID().replaceAll("-","");
        for (let offset=0;offset<file.size;offset+=partSize) {
          const bytes = new Uint8Array(await file.slice(offset,offset+partSize).arrayBuffer());
          let binary = "";
          for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
          await onPage(tab,site.origin,"fileChunk",{...pack,token,chunk:btoa(binary)});
        }
        await onPage(tab,site.origin,"upload",{...pack,slot,token,size:file.size,file:name});
        confirmed.push({slot,zip:name});
      }
      log(site.name,"模型来源已设置，正在复核上一版和目标版本");
      const refreshed = (await listMar(site,true)).rows;
      if (refreshed[0]?.name !== latest.name || refreshed.some(row=>row.name===stem+".mar")) {
        throw new Error("上一版来源已变化或目标版本已存在");
      }
      await chrome.tabs.update(tab,{active:true});
      section.mar = stem + ".mar";
      section.previous = latest.name;
      section.packRequested = true;
      section.packTabId = tab;
      await commit();
      log(site.name,"正在提交打包，保留当前 GMQM 页面");
      try {
        await onPage(tab,site.origin,"submit",{...pack,slots:confirmed});
      } catch (error) {
        if (error.beforeSubmission) {
          delete section.packRequested;
          delete section.packTabId;
          throw error;
        }
        check();
        await notify(site.name,"打包回执待核对 · " + error.message);
      }
      await confirmMar(site,section);
    },{tolerate:true});
    const pending = targetSites.filter(site=>!state.bases[site.id]?.packed);
    if (throwOnBlocked && pending.length && models.length) {
      throw new Error("未完成：" + pending.map(site=>site.name).join("、"));
    }
  }
  handlers.mar = () => packMar(baseTargets().filter(site=>!state.bases[site.id]?.packed));
  handlers.verify = async (backfill = true) => {
    const requested = baseTargets();
    const unpacked = requested.filter(site=>!state.bases[site.id]?.packed);
    if (backfill && unpacked.length && targets().length) {
      for (const site of unpacked) log(site.name,"尚无本批 MAR，先补打包再验证");
      try {
        await packMar(unpacked,false);
      } catch (error) {
        if (signal.aborted || error instanceof PendingMar) throw error;
        for (const site of unpacked) log(site.name,"补打包未完成 · " + error.message);
      }
    }
    const ready = requested.filter(site=>state.bases[site.id]?.packed && !state.bases[site.id].verified);
    if (!targets().length && !ready.length) return;
    const needsData = ready.filter(site=>!state.bases[site.id].verifyRequested && !state.bases[site.id].sns);
    const cached = needsData.length ? await dailyExports(day) : [];
    const source = new Map(cached.filter(result=>result.status==="fulfilled").map(result=>
      [result.value.site,result.value]));
    const missing = needsData.filter(site=>!source.has(site.id));
    for (const item of missing.length ? await queryAndExport(missing,day,windowId,
      (site,message)=>log(site.name,message)) : []) {
      if (!item.error) {
        source.set(item.site,item);
        await saveDailyExport(day,item);
      }
    }
    await each(ready,async site=>{
      const section = state.bases[site.id];
      if (section.verifyRequested) return;
      if (!section.sns) {
        const file = source.get(site.id);
        if (!file) throw new Error("缺少该基地当天全量判等表");
        section.sns = randomSample(file.rows,site.id);
      }
      const {sns} = section;
      const {tab} = await listMar(site,true);
      log(site.name,"正在打开 " + section.mar + " 的验证配置");
      await onPage(tab,site.origin,"openValidation",{name:section.mar});
      await onPage(tab,site.origin,"prepareValidation",{name:section.mar,sns});
      section.verifyRequested = true;
      await commit();
      await onPage(tab,site.origin,"validate",{name:section.mar,sns}).catch(error=>{
        if (error.beforeSubmission) delete section.verifyRequested;
        throw error;
      });
      await notify(site.name,"已点击开始，等待 GMQM 验证任务 · " + section.mar);
    },{tolerate:true});
    await each(ready.filter(site=>state.bases[site.id].verifyRequested),async site=>{
      const section = state.bases[site.id];
      const params = {name:section.mar,sns:section.sns};
      await notify(site.name,"等待 GMQM 验证 200 卷 · " + section.mar);
      const otherBatches = new Set();
      const receipt = await watchReceipt(async () => {
        const tab = await navigate(site.origin,validationList,true,site.origin + ":validation-list",false);
        const {tasks} = await onPage(tab,site.origin,"validationTasks",params);
        const terminal = tasks.filter(task=>task.details && /^(验证完成|验证失败)$/.test(task.status) &&
          task.created && !otherBatches.has(task.created));
        for (const task of terminal) {
          await navigate(site.origin,validationList,false,site.origin + ":validation-list",false);
          await onPage(tab,site.origin,"validationTasks",params);
          await onPage(tab,site.origin,"openValidationDetail",{...params,created:task.created});
          await bounded(async () => (await chrome.tabs.get(tab)).url?.startsWith(site.origin + "/#/model_validation?"),
            "GMQM 验证详情页未打开",15_000,250);
          const result = await onPage(tab,site.origin,"validationStatus",params);
          if (result.matches) return task;
          if (result.read) otherBatches.add(task.created);
        }
        return false;
      },"验证结果尚未完成；重跑会核对同一批 SN",20*60_000,10_000);
      if (receipt.status === "验证失败") throw new Error("GMQM 验证失败 · " + section.mar);
      section.verified = true;
      await notify(site.name,"200 卷验证完成 · "+section.mar);
    },{tracking:true,tolerate:true});
    const pending = requested.filter(site=>!state.bases[site.id]?.verified);
    if (pending.length) throw new Error("未完成：" + pending.map(site=>site.name).join("、"));
  };
  async function runStage(key, option) {
    const [,label] = modelStages.find(([id])=>id===key);
    check();
    state.stages[key] = "running";
    await notify(label,"进行中");
    try {
      await handlers[key](option);
      state.stages[key] = "done";
      await notify(label,"阶段完成");
    } catch (error) {
      state.stages[key] = signal.aborted ? "paused" : "error";
      await notify(label,error.message);
      throw error;
    }
  }
  return {
    async run(stage) {
      if (stage !== "all") return runStage(stage, stage === "deploy" ? true : undefined);
      const bases = baseTargets();
      if (bases.every(site=>state.bases[site.id]?.verified)) return {alreadyDone:true};
      await resumePendingPacks(bases);
      if (bases.every(site=>state.bases[site.id]?.packed)) return runStage("verify",false);
      if (state.stages.scan !== "done" || !targets().length) await runStage("scan");
      if (!targets().length && bases.every(site=>!state.bases[site.id]?.packed)) return {empty:true};

      const problems = [];
      for (const key of ["deploy","download","zip","mar","verify"]) {
        try {
          await runStage(key,false);
        } catch (error) {
          check();
          if (error instanceof PendingMar) throw error;
          problems.push(modelStages.find(([id])=>id===key)[1]);
        }
      }
      if (problems.length) throw new Error("仍需处理「" + problems.join("」「") + "」，各基地和模型的原因见下方进度。");
    },
  };
}
