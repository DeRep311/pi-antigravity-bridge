// Newline-delimited JSON-RPC client for `agy acp`, spawned lazily and reused for the whole Pi process.
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AcpLike } from "./types.ts";

export type AcpClientOptions = { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class AcpClient implements AcpLike {
  private opts: AcpClientOptions;
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private nextId = 1;
  private stderrTail = "";
  private pending = new Map<number, Pending>();
  private noteHandler: (method: string, params: any) => void = () => {};
  private reqHandler?: (method: string, params: any) => Promise<any>;
  // On host exit agy is SIGKILLed: its isolated config is disposable, and a graceful stop would
  // rewrite files into the gemini dir after isolation cleanup removed it.
  private exitHook = () => this.kill("SIGKILL");

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
  }

  /** Spawns and initializes the child on first use; resolves to this client. */
  async getAcp(): Promise<AcpLike> {
    await this.ensureStarted();
    return this;
  }

  private ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    const p = this.start();
    this.starting = p;
    p.catch(() => { if (this.starting === p) this.starting = undefined; });
    return p;
  }

  private async start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-2048); });
    child.stderr!.on("error", () => {});
    process.once("exit", this.exitHook);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => reject(this.withStderr(e)));
    });
    child.stdin!.on("error", () => {});
    child.on("error", (err) => this.onGone(child, this.withStderr(err)));
    child.on("exit", (code, signal) => this.onGone(child, this.withStderr(new Error(`agy acp exited (code ${code}, signal ${signal})`))));
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(child, line));
    this.setRef(child, false);
    await spawned;
    await this.send(child, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  }

  private withStderr(err: Error): Error {
    const tail = this.stderrTail.trim();
    if (tail) err.message = `${err.message}\nagy stderr: ${tail}`;
    return err;
  }

  private onGone(child: ChildProcess, err: Error) {
    if (this.child !== child) return;
    this.child = undefined;
    this.starting = undefined;
    process.removeListener("exit", this.exitHook);
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) p.reject(err);
  }

  /** Keep the host process alive only while requests are in flight, so Pi's print mode can exit when idle. */
  private setRef(child: ChildProcess, ref: boolean) {
    for (const h of [child, child.stdin, child.stdout, child.stderr] as any[]) {
      if (!h) continue;
      if (ref) h.ref?.();
      else h.unref?.();
    }
  }

  private settle(child: ChildProcess) {
    if (this.pending.size === 0 && this.child === child) this.setRef(child, false);
  }

  private write(child: ChildProcess, msg: object) {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private send(child: ChildProcess, method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v) => { this.settle(child); resolve(v); },
        reject: (e) => { this.settle(child); reject(e); },
      });
      this.setRef(child, true);
      try { this.write(child, { jsonrpc: "2.0", id, method, params }); } catch (e) { this.pending.delete(id); this.settle(child); reject(e as Error); }
    });
  }

  private onLine(child: ChildProcess, line: string) {
    if (!line.trim()) return;
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? "JSON-RPC error")), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    if (m.id === undefined) {
      try { this.noteHandler(m.method, m.params); } catch { /* handler errors must not kill the reader */ }
      return;
    }
    this.answer(child, m);
  }

  private async answer(child: ChildProcess, m: any) {
    const reply = (body: object) => { try { this.write(child, { jsonrpc: "2.0", id: m.id, ...body }); } catch { /* child gone */ } };
    if (!this.reqHandler) return reply({ error: { code: -32601, message: `Method not found: ${m.method}` } });
    try {
      reply({ result: (await this.reqHandler(m.method, m.params)) ?? {} });
    } catch (e) {
      reply({ error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new Error("agy acp is not running");
    return this.send(child, method, params);
  }

  notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child) return;
    try { this.write(child, { jsonrpc: "2.0", method, params }); } catch { /* child gone */ }
  }

  onNotification(handler: (method: string, params: any) => void): void { this.noteHandler = handler; }
  onRequest(handler: (method: string, params: any) => Promise<any>): void { this.reqHandler = handler; }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    const child = this.child;
    if (!child) return;
    this.onGone(child, new Error("agy acp exited (killed)"));
    child.kill(signal);
  }
}
