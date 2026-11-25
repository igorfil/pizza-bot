/** One process per run: its stdout lines become run events, and cancel stops its whole process group. */
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Emit, RunEvent, Task } from "./protocol.js";

export const KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 20;

export type Spawn = {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  /** Prefixes the process's stderr lines in the runner's log. */
  label: string;
  /** Runs first when the run is canceled, e.g. `docker kill`; the process group is signalled after it. */
  stop?: () => Promise<void>;
};

/** `code` null: killed by a signal, or never started (the reason is then the last stderr line). */
export type Exit = { code: number | null; stderrTail: string[] };

const signalGroup = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
};

export function runProcess(s: Spawn, onLine: (line: string) => void, signal: AbortSignal): Promise<Exit> {
  const tail: string[] = [];
  const keep = (line: string) => {
    tail.push(line);
    if (tail.length > STDERR_TAIL) tail.shift();
  };
  return new Promise((resolve) => {
    const child = spawn(s.command, s.args, { cwd: s.cwd, env: s.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let killer: NodeJS.Timeout | undefined;
    const stop = () => {
      void (s.stop ?? (async () => {}))().finally(() => {
        signalGroup(child.pid, "SIGTERM");
        killer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      });
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", (e) => keep(`could not start ${s.command}: ${e.message}`));
    child.stdin.on("error", () => {});
    child.stdin.end(s.stdin ?? "");
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", onLine);
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on("line", (line) => {
      process.stderr.write(`[${s.label}] ${line}\n`);
      keep(line);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      signal.removeEventListener("abort", stop);
      resolve({ code, stderrTail: tail });
    });
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A line of the one-shot agent contract (python/README.md) as run events. */
export const contractEvent = (line: string): RunEvent[] => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(value)) return [];
  if (typeof value.status === "string") return [{ status: value.status }];
  if (typeof value.error === "string") return [{ error: value.error }];
  const artifact = value.artifact;
  if (isRecord(artifact)) return [{ artifact: { name: typeof artifact.name === "string" ? artifact.name : "result", text: typeof artifact.text === "string" ? artifact.text : "" } }];
  return [];
};

/** Why a finished run failed, or null when it succeeded or already reported an error. */
export const failure = (exit: Exit, errored: boolean): string | null => {
  if (errored || exit.code === 0) return null;
  return exit.stderrTail.at(-1) ?? (exit.code === null ? "killed by a signal" : `exited with code ${exit.code}`);
};

/** Runs a one-shot agent process: the task's JSON on stdin, `translate`d stdout lines out, its exit code as the outcome. */
export async function oneShot(s: Spawn, task: Task, emit: Emit, signal: AbortSignal, translate: (line: string) => RunEvent[] = contractEvent): Promise<string | null> {
  let errored = false;
  const stdin = s.stdin ?? JSON.stringify({ taskId: task.taskId, contextId: task.contextId, input: task.input });
  const exit = await runProcess({ ...s, stdin }, (line) => {
    translate(line).forEach((event) => {
      errored ||= "error" in event;
      emit(event);
    });
  }, signal);
  return signal.aborted ? null : failure(exit, errored);
}

/** A short command's stdout, or why it failed; for health checks. */
export const capture = (command: string, args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) =>
      resolve(error ? { ok: false, error: stderr.trim().split("\n").at(-1) || error.message } : { ok: true, stdout: stdout.trim() }),
    );
  });
