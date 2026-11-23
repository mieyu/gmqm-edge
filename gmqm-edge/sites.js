export const sites = [
  { id: "wuxi", name: "无锡", origin: "http://172.100.72.111:8077" },
  { id: "jintan", name: "金坛", origin: "http://172.29.127.141:7077" },
  { id: "suzhou", name: "苏州", origin: "http://172.30.32.100:8089" },
  { id: "hubei", name: "湖北", origin: "http://172.23.100.51:8077" },
];

export function siteForUrl(url) {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return sites.find(site => site.origin === origin);
  } catch {
    return undefined;
  }
}

export function validAccounts(accounts) {
  return [accounts?.normal, ...sites.map(site => accounts?.[site.id])].every(
    entry => typeof entry?.username === "string" && entry.username.trim() &&
      typeof entry.password === "string" && entry.password.length > 0,
  );
}
