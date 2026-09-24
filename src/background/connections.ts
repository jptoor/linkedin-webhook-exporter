import { CONNECTIONS_PAGE_SIZE, IDLE_CONNECTION_SYNC, type ConnectionPage, type ConnectionSyncState } from "../shared/connections";
import type { CaptureResponse } from "../shared/messages";
import type { LeadRecord } from "../shared/types";

type Options = ({ leads: LeadRecord[]; remaining: () => Promise<number> } | { tabId: number; limit: number }) & {
  prepare: () => Promise<string>;
  enqueue: (leads: LeadRecord[], runId: string) => Promise<CaptureResponse>;
}
const KEY = "connectionSync";
let state: ConnectionSyncState | null = null;
let run: { id: string; stopped: boolean; tabId?: number } | null = null;
const storage = () => chrome.storage.session;
async function publish(): Promise<void> {
  await storage().set({ [KEY]: state });
  void chrome.runtime.sendMessage({ type: "STATE_CHANGED" }).catch(() => undefined);
}
export async function connectionStatus(): Promise<ConnectionSyncState> {
  if (state) return { ...state };
  const previous = (await storage().get(KEY))[KEY] as ConnectionSyncState | undefined;
  // A worker restart never resumes collection or archive admission automatically.
  if (!state) state = previous?.status === "running" ? { ...previous, status: "stopped", message: "Import was interrupted. Queued records remain in Recent activity. Start again to continue." } : previous ?? { ...IDLE_CONNECTION_SYNC };
  return { ...state };
}
export async function stopConnections(): Promise<ConnectionSyncState> {
  if (run) {
    run.stopped = true;
    if (run.tabId !== undefined) await chrome.tabs.sendMessage(run.tabId, { type: "CONNECTIONS_ABORT", runId: run.id }).catch(() => undefined);
  }
  return connectionStatus();
}
export async function startConnections(opts: Options): Promise<ConnectionSyncState> {
  if (run) throw new Error("A connections import is already running.");
  const current = { id: crypto.randomUUID(), stopped: false, tabId: "tabId" in opts ? opts.tabId : undefined };
  const total = "leads" in opts ? opts.leads.length : opts.limit;
  run = current; // Claim before the first await, across every panel/tab.
  state = { ...IDLE_CONNECTION_SYNC, status: "running", total, message: "Checking destination…" };
  try {
    state.destination = await opts.prepare();
    await publish();
  } catch (error) {
    state.status = "failed";
    state.message = error instanceof Error ? error.message : "Could not start import.";
    run = null;
    await publish();
    return { ...state };
  }
  void (async () => {
    let start = 0;
    const seen = new Set<string>();
    let owner: string | undefined;
    try {
      while (!current.stopped && start < total) {
        let page: ConnectionPage;
        if ("leads" in opts) {
          const count = Math.min(100, Math.max(1, await opts.remaining()), total - start);
          if (current.stopped) break;
          page = { leads: opts.leads.slice(start, start + count), nextStart: start + count, done: start + count === total };
        } else {
          const count = Math.min(CONNECTIONS_PAGE_SIZE, total - start);
          const response = await chrome.tabs.sendMessage(opts.tabId, { type: "CONNECTIONS_READ", runId: current.id, start, count }) as { page?: ConnectionPage; error?: string } | undefined;
          if (current.stopped) break;
          if (response?.error) throw new Error(response.error);
          if (!response?.page || !Array.isArray(response.page.leads) || response.page.leads.length > count || response.page.nextStart !== start + response.page.leads.length || typeof response.page.done !== "boolean" || (!response.page.done && !response.page.leads.length)) throw new Error("LinkedIn returned an invalid page. Sync stopped.");
          page = response.page;
          for (const lead of page.leads) {
            if (!lead.linkedin_url || !lead.connection_owner_urn || !lead.connected_at || lead.connection_degree !== "1st") throw new Error("LinkedIn returned an incomplete connection. Sync stopped.");
            owner ??= lead.connection_owner_urn;
            if (owner !== lead.connection_owner_urn) throw new Error("The LinkedIn account changed. Sync stopped.");
            if (seen.has(lead.linkedin_url)) throw new Error("LinkedIn repeated a connection. Sync stopped.");
            seen.add(lead.linkedin_url);
          }
        }
        if (page.leads.length) {
          const result = await opts.enqueue(page.leads, current.id);
          if (!result.ok) throw new Error(result.detail ?? (!("leads" in opts) ? `Sync stopped: ${result.rejectedReason}. Previously queued records remain in Recent activity.` : `Import paused: ${result.rejectedReason}. ${start} of ${total} file records processed. Adjust the export cap or wait, then import the same file again; keep deduplication enabled. Previously queued records remain in Recent activity.`));
          state!.queued += result.queued;
          state!.skipped += result.skippedDuplicates.length;
        }
        start = page.nextStart;
        state!.scanned = start;
        state!.message = "Importing connections…";
        await publish();
        if (page.done || start >= total) {
          state!.status = "completed";
          state!.message = "leads" in opts ? "All file records processed. Queued is not delivered; check Recent activity for delivery status." : page.done ? "End of network reached. Check Recent activity for delivery status." : "Requested limit reached; more connections may remain.";
          break;
        }
        await new Promise(resolve => setTimeout(resolve, "leads" in opts ? 0 : 2000));
      }
      if (current.stopped) { state!.status = "stopped"; state!.message = "Import stopped. Previously queued records will still be delivered."; }
    } catch (error) {
      state!.status = current.stopped ? "stopped" : "failed";
      state!.message = current.stopped ? "Import stopped. Previously queued records will still be delivered." : error instanceof Error ? error.message : "Connection import failed.";
    } finally {
      if (current.tabId !== undefined) await chrome.tabs.sendMessage(current.tabId, { type: "CONNECTIONS_ABORT", runId: current.id }).catch(() => undefined);
      try { await publish(); } finally { run = null; }
    }
  })();
  return { ...state };
}
