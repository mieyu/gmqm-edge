// Runs temporarily in the grading page's MAIN world to retain its own export Blob.
export async function exportCapture(origin, key, command, argument, kind = "grading") {
  const route = kind === "zip" ? /^#\/model\/create_model(?:[/?]|$)/ : /^#\/ej\/etc(?:[/?]|$)/;
  if (window.top !== window || location.origin !== origin || !route.test(location.hash)) return null;
  const current = window[key];
  if (command === "status") return current?.blob
    ? { size: current.blob.size }
    : { size: 0 };
  if (command === "fetchModel" && current && kind === "zip") {
    const url = new URL(argument);
    if (url.origin !== origin || url.pathname !== "/file/api/v1/download_model_by_path") return false;
    try {
      const response = await fetch(url.href, { credentials: "same-origin", redirect: "error",
        signal: AbortSignal.timeout(90_000) });
      if (!response.ok) return false;
      const blob = await response.blob();
      const head = new Uint8Array(await blob.slice(0,4).arrayBuffer());
      if (current.restored || head[0] !== 80 || head[1] !== 75 || head[2] !== 3 || head[3] !== 4) return false;
      current.blob = blob;
      return true;
    } catch {
      return false;
    }
  }
  if (command === "read" && current?.blob) {
    const offset = argument;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= current.blob.size) return null;
    const bytes = new Uint8Array(await current.blob.slice(offset, offset + 1_048_576).arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 8192) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
    }
    return btoa(binary);
  }
  if (command === "release") {
    current?.restore();
    return null;
  }
  if (command !== "arm" || current) return null;

  const fileName = argument;
  const objectUrl = URL.createObjectURL;
  const clickDescriptor = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "click");
  const click = HTMLAnchorElement.prototype.click;
  const dispatch = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "dispatchEvent");
  const originalDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  const originalFetch = window.fetch;
  const send = XMLHttpRequest.prototype.send;
  const seen = new Map();
  const state = {
    blob: null,
    restored: false,
    direct: false,
    restore() {
      if (state.restored) return;
      state.restored = true;
      if (URL.createObjectURL === captureObject) URL.createObjectURL = objectUrl;
      if (HTMLAnchorElement.prototype.click === captureClick) {
        if (clickDescriptor) Object.defineProperty(HTMLAnchorElement.prototype, "click", clickDescriptor);
        else delete HTMLAnchorElement.prototype.click;
      }
      if (HTMLAnchorElement.prototype.dispatchEvent === captureDispatch) {
        if (dispatch) Object.defineProperty(HTMLAnchorElement.prototype, "dispatchEvent", dispatch);
        else delete HTMLAnchorElement.prototype.dispatchEvent;
      }
      if (window.fetch === captureFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.send === captureSend) XMLHttpRequest.prototype.send = send;
      document.removeEventListener("click", captureEvent, true);
      delete window[key];
    },
  };
  async function consider(blob) {
    if (!(blob instanceof Blob) || !blob.size || state.blob || state.restored) return;
    const head = new Uint8Array(await blob.slice(0, 12_288).arrayBuffer());
    if (kind === "zip") {
      if (!state.restored && !state.blob && head[0] === 80 && head[1] === 75 && head[2] === 3 && head[3] === 4) {
        state.blob = blob;
      }
      return;
    }
    const encoding = head[0] === 255 && head[1] === 254 ? "utf-16le" :
      head[0] === 254 && head[1] === 255 ? "utf-16be" : "utf-8";
    const isGrading = charset => {
      const labels = new TextDecoder(charset).decode(head).split(/[\r\n]/, 1)[0].replace(/\s+/g, "");
      return ["子卷SN号", "CCD等级", "生产时间"].every(label => labels.includes(label));
    };
    if (isGrading(encoding) || (encoding === "utf-8" && isGrading("gb18030"))) {
      if (!state.restored && !state.blob) state.blob = blob;
    }
  }
  function inspect(anchor) {
    if (!anchor.download || !(kind === "zip" ? /\.zip$/i : /判等结果|\.csv$/i).test(anchor.download)) return;
    const address = anchor.href;
    if (seen.has(address)) {
      anchor.download = fileName;
      void consider(seen.get(address)).catch(() => {});
      return;
    }
    if (state.direct || state.blob || !address) return;
    const url = new URL(address, location.href);
    if (url.origin !== origin && url.protocol !== "data:") return;
    state.direct = true;
    anchor.download = fileName;
    void fetch(url, { credentials: "same-origin" }).then(response => {
      if (response.ok) return response.blob();
      return null;
    }).then(consider).catch(() => {});
  }
  function captureObject(blob) {
    const address = objectUrl.call(this, blob);
    if (blob instanceof Blob) {
      seen.set(address, blob);
      void consider(blob).catch(() => {});
    }
    return address;
  }
  function captureClick(...args) {
    inspect(this);
    return click.apply(this, args);
  }
  function captureDispatch(event) {
    if (event.type === "click") inspect(this);
    return originalDispatch.call(this, event);
  }
  function captureEvent(event) {
    const anchor = event.target.closest?.("a[download]");
    if (anchor) inspect(anchor);
  }
  function fileResponse(contentType, disposition) {
    if (kind === "zip") return /\bzip\b/i.test(contentType ?? "") || /\.zip\b/i.test(disposition ?? "");
    return /(?:^|[/; ])(?:csv|tab-separated-values|vnd\.ms-excel)(?:$|[; ])/i.test(contentType ?? "") ||
      /filename\*?\s*=.{0,500}\.csv(?:["; ]|$)/i.test(disposition ?? "");
  }
  async function captureFetch(...args) {
    const response = await originalFetch.apply(this, args);
    if (!state.blob && !state.restored && response.ok && response.url.startsWith(origin + "/") &&
        fileResponse(response.headers.get("content-type"), response.headers.get("content-disposition"))) {
      void response.clone().blob().then(consider).catch(() => {});
    }
    return response;
  }
  function captureSend(...args) {
    this.addEventListener("load", () => {
      if (state.blob || state.restored || !this.responseURL.startsWith(origin + "/") ||
          !fileResponse(this.getResponseHeader("content-type"), this.getResponseHeader("content-disposition"))) return;
      if (this.response instanceof Blob) void consider(this.response).catch(() => {});
      else if (this.response instanceof ArrayBuffer) void consider(new Blob([this.response])).catch(() => {});
    }, { once: true });
    return send.apply(this, args);
  }
  window[key] = state;
  URL.createObjectURL = captureObject;
  HTMLAnchorElement.prototype.click = captureClick;
  HTMLAnchorElement.prototype.dispatchEvent = captureDispatch;
  window.fetch = captureFetch;
  XMLHttpRequest.prototype.send = captureSend;
  document.addEventListener("click", captureEvent, true);
  setTimeout(() => state.restore(), kind === "zip" ? 300_000 : 180_000);
  return { armed: true };
}
