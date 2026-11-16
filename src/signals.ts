// Runs registered cleanups when the process is terminated by SIGTERM/SIGINT/SIGHUP, where Node never emits 'exit'.
// Adding a listener disables Node's default termination, so when ours is the only listener for the signal we
// remove it and re-raise, letting the process die by that signal exactly as before.
const SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const handlers = new Set<() => void>();
const installed = new Map<NodeJS.Signals, () => void>();

function runAll() {
  for (const fn of [...handlers]) { try { fn(); } catch { /* cleanup must never throw */ } }
}

function install() {
  for (const sig of SIGNALS) {
    const listener = () => {
      // The host has its own handler (Pi uses SIGINT to interrupt a turn and keeps running): leave everything
      // in place. Cleaning up here would delete the isolated gemini dir and let a respawned agy run without the
      // native-tool deny hook. If the host then exits, the 'exit' cleanup runs.
      if (process.listenerCount(sig) > 1) return;
      runAll();
      process.removeListener(sig, listener);
      installed.delete(sig);
      process.kill(process.pid, sig);
    };
    try {
      process.on(sig, listener); // SIGHUP is unsupported on some platforms (Windows)
      installed.set(sig, listener);
    } catch { /* unsupported signal */ }
  }
}

/** Registers a synchronous, idempotent cleanup to run on termination signals. Handlers install on first use. */
export function onTerminate(fn: () => void): () => void {
  if (installed.size === 0) install();
  handlers.add(fn);
  return () => { handlers.delete(fn); };
}
