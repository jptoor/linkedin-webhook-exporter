/** Minimal in-memory chrome.* for exercising the service worker in Node. */
type Listener = (...args: any[]) => any;

function area(store: Record<string, unknown>) {
  return {
    get: async (key: string | string[] | null) => {
      if (key === null) return structuredClone(store);
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in store) out[k] = structuredClone(store[k]);
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 0)); // yield, like the real API
      for (const [k, v] of Object.entries(obj)) store[k] = structuredClone(v);
    }
  };
}

export function makeFakeChrome() {
  const store: Record<string, unknown> = {};
  const sessionStore: Record<string, unknown> = {};
  const listeners: Record<string, Listener[]> = {};
  const on = (name: string) => ({ addListener: (fn: Listener) => (listeners[name] ??= []).push(fn), removeListener: (fn: Listener) => (listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn)) });
  const alarms = new Map<string, unknown>();
  const tabs = new Map<number, { id: number; url: string; status: string }>();
  const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
  const broadcasts: unknown[] = [];
  const chrome = {
    runtime: { id: "ext-id", onMessage: on("message"), onStartup: on("startup"), onInstalled: on("installed"), getURL: (p: string) => `chrome-extension://ext-id/${p}`, sendMessage: async (m: unknown) => void broadcasts.push(m) },
    storage: { local: area(store), session: area(sessionStore) },
    alarms: { create: async (name: string, info: unknown) => void alarms.set(name, info), clear: async (name: string) => alarms.delete(name), onAlarm: on("alarm") },
    tabs: {
      get: async (id: number) => tabs.get(id) ?? Promise.reject(new Error("no tab")),
      update: async (id: number, u: { url: string }) => (tabs.get(id)!.url = u.url),
      create: async (u: { url: string }) => tabs.set(tabs.size + 1, { id: tabs.size + 1, url: u.url, status: "complete" }).get(tabs.size)!,
      query: async () => Array.from(tabs.values()),
      sendMessage: async (tabId: number, msg: unknown) => void tabMessages.push({ tabId, msg }),
      onUpdated: on("tabUpdated"),
      onRemoved: on("tabRemoved"),
      onActivated: on("tabActivated")
    },
    commands: { onCommand: on("command") },
    permissions: { contains: async () => true, request: async () => true },
    sidePanel: { setPanelBehavior: async () => undefined, open: async () => undefined }
  };
  return { chrome, store, sessionStore, listeners, alarms, tabs, tabMessages, broadcasts };
}

/** Send a message to the worker as a given sender and await the response. */
export function messenger(listeners: Record<string, Listener[]>) {
  return (msg: unknown, sender: Record<string, unknown> = { id: "ext-id", url: "chrome-extension://ext-id/sidepanel.html" }) =>
    new Promise<any>((resolve) => {
      const fn = listeners.message[0];
      fn(msg, sender, resolve);
    });
}
