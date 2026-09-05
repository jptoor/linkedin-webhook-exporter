/** Runs in the page's MAIN world (not the isolated content-script world).
 *
 *  Its only job: when Sales Navigator's "Share search" button copies a link
 *  to the clipboard, hand that link to the content script. A saved search is
 *  opened as `/sales/search/people?savedSearchId=…`, a deep link that only
 *  resolves for its owner; the shareable link carries the full `query=`
 *  expression a backend provider can run. Reading the clipboard would need a
 *  permission prompt and focus; wrapping the write is silent and exact.
 *
 *  Nothing else is observed and nothing is sent anywhere: the content script
 *  receives a window message on the same origin and forwards only URLs that
 *  look like a Sales Navigator search. */
(() => {
  const MARK = "__lwe_share_link__";
  const post = (text: unknown) => {
    if (typeof text !== "string" || !/linkedin\.com\/sales\/search\//.test(text)) return;
    try {
      window.postMessage({ [MARK]: text }, location.origin);
    } catch {
      /* ignore */
    }
  };
  const clip = navigator.clipboard;
  if (clip && typeof clip.writeText === "function") {
    const orig = clip.writeText.bind(clip);
    clip.writeText = (text: string) => {
      post(text);
      return orig(text);
    };
  }
  if (clip && typeof clip.write === "function") {
    const origWrite = clip.write.bind(clip);
    clip.write = async (items: ClipboardItems) => {
      try {
        for (const item of items) {
          if (item.types.includes("text/plain")) post(await (await item.getType("text/plain")).text());
        }
      } catch {
        /* ignore */
      }
      return origWrite(items);
    };
  }
  // Legacy copy path: a hidden input + execCommand("copy").
  document.addEventListener(
    "copy",
    (e) => {
      const sel = String(document.getSelection() ?? "");
      const data = e.clipboardData?.getData("text/plain");
      post(data || sel);
    },
    true
  );
})();
