import { monthDay, previousDay } from "./sop.js";
import { checkModelZip, modelPackage, sha256 } from "./model-zip.js";

async function handleStore(mode, run) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("gmqm-model-directory", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("settings");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("settings", mode);
      const request = run(tx.objectStore("settings"));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const savedDirectory = () => handleStore("readonly", store => store.get("root"));
export const saveDirectory = handle => handleStore("readwrite", store => store.put(handle, "root"));

export function modelArchiveFolders(day, modelDay) {
  const folders = [monthDay(day), "模型"];
  // The old workflow used this directory for the previous day's models.
  if (modelDay !== previousDay(day)) folders.push(modelDay);
  return folders;
}

export async function modelDirectory(root, day, modelDay) {
  if (!root || await root.queryPermission({ mode: "readwrite" }) !== "granted") {
    throw new Error("请选择并授权「更新模型」目录");
  }
  let directory = root;
  for (const folder of modelArchiveFolders(day,modelDay)) {
    directory = await directory.getDirectoryHandle(folder, { create: true });
  }
  return directory;
}

export async function readNamed(directory, name) {
  try {
    return await (await directory.getFileHandle(name)).getFile();
  } catch (error) {
    if (error.name === "NotFoundError") return undefined;
    throw error;
  }
}

export async function saveVerifiedFile(directory, name, data, expected) {
  const hash = expected ?? await sha256(data);
  const existing = await readNamed(directory, name);
  if (existing?.size) {
    if (await sha256(existing) === hash) return hash;
    throw new Error("已存在内容不同的文件：" + name);
  }
  const handle = await directory.getFileHandle(name, { create: true });
  const output = await handle.createWritable();
  try {
    await output.write(data);
    await output.close();
  } catch (error) {
    await output.abort().catch(() => {});
    throw error;
  }
  if (await sha256(await handle.getFile()) !== hash) throw new Error(name + " 写入与源文件的 SHA-256 不同");
  return hash;
}

export async function packageModel(directory, rule, item) {
  const raw = await readNamed(directory, item.raw);
  if (!raw || (item.rawHash && await sha256(raw) !== item.rawHash)) throw new Error("原包不存在或 SHA-256 已变化");
  const { output, archive } = await modelPackage(raw, rule, item.name + " " + raw.name);
  const expanded = await directory.getDirectoryHandle(rule.key, { create: true });
  const hashes = Object.fromEntries(output.map(member => [member.name, member.hash]));
  for (const member of output) {
    await saveVerifiedFile(expanded, member.name, member.data, member.hash);
  }
  const zipName = rule.key + ".zip";
  const existing = await readNamed(directory, zipName);
  if (existing?.size) await checkModelZip(existing, hashes);
  else await saveVerifiedFile(directory, zipName, archive);
  await checkModelZip(await readNamed(directory, zipName), hashes);
  return { zipName, hashes };
}
