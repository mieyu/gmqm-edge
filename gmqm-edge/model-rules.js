export const brain = { company: "http://10.9.30.252:31001", wuxi: "http://192.168.254.12:31001" };
export const schemes = {
  wuxi: "无锡恩捷算法配置方案", jintan: "常州金坛算法配置方案",
  suzhou: "苏州捷力算法配置方案", hubei: "湖北恩捷算法方案_v01",
};
export const modelRules = [
  ["喷涂", ["喷涂膜基础模型"], "film_classification_pentu_wuxi"],
  ["基膜", ["恩捷-基膜基础模型"], "film_classification_base_wuxi", /恩捷-基膜基础数据集/],
  ["涂布", ["恩捷-涂布膜模型"], "film_classification_tubu_wuxi"],
  ["膜面花", ["苏州-膜面花基础模型"], "film_classification_momianhua_wuxi", /苏州-膜面花基础数据集/],
  ["面积", ["卓高-面积分割"], "film_area"],
  ...[1, 2, 3].map(vote => ["点涂" + vote, ["点涂膜基础模型", "点图膜基础模型"],
    "film_classification_diantu_wuxi_vote" + vote, undefined, vote]),
  ["蚊虫", ["隔膜-真实蚊虫模型"], "film_classification_patch_wuxi"],
  ["碎膜", ["关键缺陷-碎膜模型"], "film_classification_top_wuxi"],
].map(([key, families, stem, dataset, vote], index) => ({
  key, families, stem, dataset, vote, origin: index >= 8 ? brain.wuxi : brain.company,
}));

export function modelSearchTerm(rule, name) {
  return rule.families.find(family => name.startsWith(family)) ?? rule.families[0];
}

export function trainedModel(rule, rows, modelDay) {
  const ending = rule.vote ? new RegExp("^(?:[\\s_-]*v\\d+(?:\\.\\d+)*)?[_\\s-]+vote[_\\s-]*" + rule.vote + "$","i") :
    /^(?:[\s_-]*v\d+(?:\.\d+)*)?$/i;
  return rows.filter(row => {
    const family = modelSearchTerm(rule, row.name);
    return row.name.startsWith(family) && ending.test(row.name.slice(family.length).trim()) &&
      row.created.slice(0, 10) === modelDay && row.state === "训练成功" &&
      (!rule.dataset || rule.dataset.test(row.dataset));
  })
    .sort((a, b) => b.created.localeCompare(a.created) ||
      b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
}

export function nextMar(name) {
  const match = /^(.*[._v])([0-9]+)(?:\.mar)+$/i.exec(name);
  if (!match) throw new Error("上一版 MAR 名称缺少可递增的末段版本号");
  return match[1] + String(BigInt(match[2]) + 1n).padStart(match[2].length, "0");
}

export function randomSample(rows, site, size = 200) {
  const values = [...new Set(rows.filter(row => row.site === site && row.sn).map(row => row.sn))];
  if (values.length < size) throw new Error("该基地仅有 " + values.length + " 个有效子卷 SN，验证需要 " + size + " 个");
  for (let i = 0; i < size; i += 1) {
    const limit = values.length - i;
    const max = Math.floor(2 ** 32 / limit) * limit;
    const buffer = new Uint32Array(1);
    do crypto.getRandomValues(buffer); while (buffer[0] >= max);
    const index = i + buffer[0] % limit;
    [values[i], values[index]] = [values[index], values[i]];
  }
  return values.slice(0, size);
}
