import { CONNECTIONS_PAGE_SIZE, IDLE_CONNECTION_SYNC, type ConnectionPage, type ConnectionSyncState } from "../shared/connections";
import type { CaptureResponse } from "../shared/messages";
import type { LeadRecord } from "../shared/types";

interface Options {
  tabId: number;
  limit: number;
  prepare: () => Promise<string>;
  enqueue: (leads: LeadRecord[], runId: string) => Promise<CaptureResponse>;
}
const KEY = "connectionSync";
let state: ConnectionSyncState | null = null;
let run: { id: string; tabId: number; stopped: boolean } | null = null;
const storage = () => chrome.storage.session;
async function publish(): Promise<void> {
  await storage().set({ [KEY]: state });
  void chrome.runtime.sendMessage({ type: "STATE_CHANGED" }).catch(() => undefined);
}
export async function connectionStatus(): Promise<ConnectionSyncState> {
  if (state) return { ...state };
  const previous = (await storage().get(KEY))[KEY] as ConnectionSyncState | undefined;
  // A worker restart never resumes authenticated collection automatically.
  if (!state) state = previous?.status === "running" ? { ...previous, status: "stopped", message: "Sync was interrupted. Queued records remain in Recent activity. Start again to continue." } : previous ?? { ...IDLE_CONNECTION_SYNC };
  return { ...state };
}
export async function stopConnections(): Promise<ConnectionSyncState> {
  if (run) {
    run.stopped = true;
    await chrome.tabs.sendMessage(run.tabId, { type: "CONNECTIONS_ABORT", runId: run.id }).catch(() => undefined);
  }
  return connectionStatus();
}
export async function startConnections(opts: Options): Promise<ConnectionSyncState> {
  if (run) throw new Error("A connections sync is already running.");
  const current = { id: crypto.randomUUID(), tabId: opts.tabId, stopped: false };
  run = current; // Claim before the first await, across every panel/tab.
  state = { ...IDLE_CONNECTION_SYNC, status: "running", message: "Checking destination…" };
  try {
    state.destination = await opts.prepare();
    await publish();
  } catch (error) {
    state.status = "failed";
    state.message = error instanceof Error ? error.message : "Could not start sync.";
    run = null;
    await publish();
    return { ...state };
  }
  void (async () => {
    let start = 0;
    const seen = new Set<string>();
    let owner: string | undefined;
    try {
      while (!current.stopped && start < opts.limit) {
        const count = Math.min(CONNECTIONS_PAGE_SIZE, opts.limit - start);
        const response = await chrome.tabs.sendMessage(current.tabId, { type: "CONNECTIONS_READ", runId: current.id, start, count }) as { page?: ConnectionPage; error?: string } | undefined;
        if (current.stopped) break;
        if (response?.error) throw new Error(response.error);
        const page = response?.page;
        if (!page || !Array.isArray(page.leads) || page.leads.length > count || page.nextStart !== start + page.leads.length || typeof page.done !== "boolean" || (!page.done && !page.leads.length)) throw new Error("LinkedIn returned an invalid page. Sync stopped.");
        for (const lead of page.leads) {
          if (!lead.linkedin_url || !lead.connection_owner_urn || !lead.connected_at || lead.connection_degree !== "1st") throw new Error("LinkedIn returned an incomplete connection. Sync stopped.");
          owner ??= lead.connection_owner_urn;
          if (owner !== lead.connection_owner_urn) throw new Error("The LinkedIn account changed. Sync stopped.");
          if (seen.has(lead.linkedin_url)) throw new Error("LinkedIn repeated a connection. The network changed during paging; sync stopped.");
          seen.add(lead.linkedin_url);
        }
        if (page.leads.length) {
          const result = await opts.enqueue(page.leads, current.id);
          if (!result.ok) throw new Error(result.detail ?? `Export stopped: ${result.rejectedReason}. Previously queued records remain in Recent activity.`);
          state!.queued += result.queued;
          state!.skipped += result.skippedDuplicates.length;
        }
        start = page.nextStart;
        state!.scanned = start;
        state!.message = "Reading connections…";
        await publish();
        if (page.done || start >= opts.limit) {
          state!.status = "completed";
          state!.message = page.done ? "End of network reached." : "Requested limit reached; more connections may remain.";
          break;
        }
        // Simple pacing, not a promise of a safe LinkedIn request rate.
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      if (current.stopped) { state!.status = "stopped"; state!.message = "Sync stopped. Previously queued records will still be delivered."; }
    } catch (error) {
      state!.status = current.stopped ? "stopped" : "failed";
      state!.message = current.stopped ? "Sync stopped. Previously queued records will still be delivered." : error instanceof Error ? error.message : "LinkedIn sync failed.";
    } finally {
      await chrome.tabs.sendMessage(current.tabId, { type: "CONNECTIONS_ABORT", runId: current.id }).catch(() => undefined);
      await publish();
      run = null;
    }
  })();
  return { ...state };
}
