import { crc32, zip } from "./workbook.js";

export async function readZip(blob) {
  const tailOffset = Math.max(0, blob.size - 65557);
  const tail = new DataView(await blob.slice(tailOffset).arrayBuffer());
  let end = tail.byteLength - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 ||
    end + 22 + tail.getUint16(end + 20, true) !== tail.byteLength)) end -= 1;
  if (end < 0 || tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) {
    throw new Error("无法读取 ZIP 目录");
  }
  const count = tail.getUint16(end + 10, true);
  const length = tail.getUint32(end + 12, true);
  const start = tail.getUint32(end + 16, true);
  if (start + length > tailOffset + end || count === 65535) throw new Error("ZIP 目录超出支持范围");
  const directory = new DataView(await blob.slice(start, start + length).arrayBuffer());
  const paths = [];
  for (let pos = 0, i = 0; i < count; i += 1) {
    if (pos + 46 > length || directory.getUint32(pos, true) !== 0x02014b50) throw new Error("ZIP 目录损坏");
    const nameSize = directory.getUint16(pos + 28, true);
    const extraSize = directory.getUint16(pos + 30, true);
    const commentSize = directory.getUint16(pos + 32, true);
    const nameBytes = new Uint8Array(directory.buffer, pos + 46, nameSize);
    const flags = directory.getUint16(pos + 8, true);
    const path = new TextDecoder(flags & 0x800 ? "utf-8" : "gb18030").decode(nameBytes);
    const entry = { path, flags, method: directory.getUint16(pos + 10, true),
      checksum: directory.getUint32(pos + 16, true), compressed: directory.getUint32(pos + 20, true),
      size: directory.getUint32(pos + 24, true), offset: directory.getUint32(pos + 42, true) };
    if (!path.endsWith("/")) paths.push(entry);
    pos += 46 + nameSize + extraSize + commentSize;
  }
  return {
    paths,
    async extract(entry) {
      if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > 512 * 1024 ** 2) {
        throw new Error("ZIP 成员加密、过大或压缩方式不受支持");
      }
      const local = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
      if (local.byteLength !== 30 || local.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP 成员头损坏");
      const start = entry.offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
      const content = blob.slice(start, start + entry.compressed);
      const bytes = new Uint8Array(await (entry.method === 0 ? content.arrayBuffer() :
        new Response(content.stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer()));
      if (bytes.length !== entry.size || crc32(bytes) !== entry.checksum) throw new Error("ZIP 成员校验失败：" + entry.path);
      return bytes;
    },
  };
}

export async function sha256(data) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data instanceof Blob
    ? await data.arrayBuffer() : data))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function modelPackage(raw, rule, sourceName = "") {
  const source = await readZip(raw);
  const ends = [".onnx", ".json"];
  const vote = /_vote([123])$/.exec(rule.stem)?.[1];
  if (vote) {
    const votes = new Set([...source.paths.map(entry => entry.path), sourceName]
      .flatMap(name => [...name.matchAll(/vote[\s_-]*([123])(?!\d)/gi)].map(match => match[1])));
    if (votes.size !== 1 || !votes.has(vote)) throw new Error("原包 vote 标记不符或无法唯一确认");
  }
  const output = [];
  for (const ext of ends) {
    const candidates = source.paths.filter(entry => entry.path.toLowerCase().endsWith(ext) &&
      !entry.path.split("/").includes("__MACOSX"));
    if (candidates.length !== 1) throw new Error("原包必须各有一份 ONNX 和 JSON，" + ext + " 找到 " + candidates.length + " 份");
    const data = await source.extract(candidates[0]);
    if (!data.length) throw new Error(ext + " 文件为空");
    output.push({name: rule.stem + ext, data, hash: await sha256(data)});
  }
  return { output, archive: zip(output.map(entry => [entry.name, entry.data]), "application/zip") };
}

export async function checkModelZip(archive, hashes) {
  const packed = await readZip(archive);
  if (packed.paths.length !== Object.keys(hashes).length) throw new Error("成品 ZIP 文件数量不符");
  for (const entry of packed.paths) {
    if (!hashes[entry.path] || await sha256(await packed.extract(entry)) !== hashes[entry.path]) {
      throw new Error("成品 ZIP 根目录文件名或 SHA-256 不符");
    }
  }
}
