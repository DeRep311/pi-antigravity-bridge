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
  private pending = new Map<number, Pending>();
  private noteHandler: (method: string, params: any) => void = () => {};
  private reqHandler?: (method: string, params: any) => Promise<any>;
  private exitHook = () => this.kill();

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
      cwd: this.opts.cwd, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    process.once("exit", this.exitHook);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    child.stdin!.on("error", () => {});
    child.on("error", (err) => this.onGone(child, err));
    child.on("exit", (code, signal) => this.onGone(child, new Error(`agy acp exited (code ${code}, signal ${signal})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(child, line));
    await spawned;
    await this.send(child, "initialize", { protocolVersion: 1, clientCapabilities: {} });
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

  private write(child: ChildProcess, msg: object) {
    child.stdin!.write(JSON.stringify(msg) + "\n");
  }

  private send(child: ChildProcess, method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.write(child, { jsonrpc: "2.0", id, method, params }); } catch (e) { this.pending.delete(id); reject(e as Error); }
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

  kill(): void {
    const child = this.child;
    if (!child) return;
    this.onGone(child, new Error("agy acp exited (killed)"));
    child.kill();
  }
}
