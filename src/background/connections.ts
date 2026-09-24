import { IDLE_CONNECTION_SYNC, type ConnectionSyncState } from "../shared/connections";
import type { CaptureResponse } from "../shared/messages";
import type { LeadRecord } from "../shared/types";

interface Options {
  leads: LeadRecord[];
  remaining: () => Promise<number>;
  prepare: () => Promise<string>;
  enqueue: (leads: LeadRecord[], runId: string) => Promise<CaptureResponse>;
}
const KEY = "connectionSync";
let state: ConnectionSyncState | null = null;
let run: { id: string; stopped: boolean } | null = null;
const storage = () => chrome.storage.session;
async function publish(): Promise<void> {
  await storage().set({ [KEY]: state });
  void chrome.runtime.sendMessage({ type: "STATE_CHANGED" }).catch(() => undefined);
}
export async function connectionStatus(): Promise<ConnectionSyncState> {
  if (state) return { ...state };
  const previous = (await storage().get(KEY))[KEY] as ConnectionSyncState | undefined;
  // A worker restart never resumes archive admission automatically.
  if (!state) state = previous?.status === "running" ? { ...previous, status: "stopped", message: "Import was interrupted. Queued records remain in Recent activity. Start again to continue." } : previous ?? { ...IDLE_CONNECTION_SYNC };
  return { ...state };
}
export async function stopConnections(): Promise<ConnectionSyncState> {
  if (run) {
    run.stopped = true;
  }
  return connectionStatus();
}
export async function startConnections(opts: Options): Promise<ConnectionSyncState> {
  if (run) throw new Error("A connections import is already running.");
  const current = { id: crypto.randomUUID(), stopped: false };
  run = current; // Claim before the first await, across every panel/tab.
  state = { ...IDLE_CONNECTION_SYNC, status: "running", total: opts.leads.length, message: "Checking destination…" };
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
    try {
      while (!current.stopped && start < opts.leads.length) {
        const count = Math.min(100, Math.max(1, await opts.remaining()), opts.leads.length - start);
        if (current.stopped) break;
        const page = { leads: opts.leads.slice(start, start + count), nextStart: start + count, done: start + count === opts.leads.length };
        if (page.leads.length) {
          const result = await opts.enqueue(page.leads, current.id);
          if (!result.ok) throw new Error(result.detail ?? `Import paused: ${result.rejectedReason}. ${start} of ${opts.leads.length} file records processed. Adjust the export cap or wait, then import the same file again; keep deduplication enabled. Previously queued records remain in Recent activity.`);
          state!.queued += result.queued;
          state!.skipped += result.skippedDuplicates.length;
        }
        start = page.nextStart;
        state!.scanned = start;
        state!.message = "Importing connections…";
        await publish();
        if (page.done) {
          state!.status = "completed";
          state!.message = "All file records processed. Queued is not delivered; check Recent activity for delivery status.";
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (current.stopped) { state!.status = "stopped"; state!.message = "Import stopped. Previously queued records will still be delivered."; }
    } catch (error) {
      state!.status = current.stopped ? "stopped" : "failed";
      state!.message = current.stopped ? "Import stopped. Previously queued records will still be delivered." : error instanceof Error ? error.message : "Connection import failed.";
    } finally {
      try { await publish(); } finally { run = null; }
    }
  })();
  return { ...state };
}
