import { trainingVersion } from "./model-rules.js";

const endpoint = "/file/api/v1/download_model_by_path";

export function matchingModelDownload(item, origin, name, version) {
  const norm = value => value.normalize("NFKC").toLowerCase();
  const identity = norm(name + "(" + trainingVersion(version) + ")");
  for (const address of [item.finalUrl, item.url]) {
    if (!address) continue;
    let url;
    try {
      url = new URL(address);
    } catch {
      continue;
    }
    if (url.origin !== origin || url.pathname !== endpoint) continue;
    const path = url.searchParams.get("file_path");
    if (path && norm(path).includes(identity)) return url.href;
  }
  return "";
}

export async function inspectNativeModelDownload(origin, model, started) {
  const records = await chrome.downloads.search({
    startedAfter: new Date(started).toISOString(),
    urlRegex: "/file/api/v1/download_model_by_path\\?",
    orderBy: ["-startTime"], limit: 30,
  });
  const matches = records.map(record => ({
    record,
    address: matchingModelDownload(record, origin, model.name, model.version),
  })).filter(entry => entry.address);
  const finished = matches.find(entry => entry.record.state === "complete");
  if (finished) return finished;
  return matches[0];
}
