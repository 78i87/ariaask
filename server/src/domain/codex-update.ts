import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export type CodexInstallMethod = "npm" | "homebrew";
export type CodexUpdateState = "idle" | "running" | "succeeded" | "unchanged" | "failed";

export interface CodexCliStatus {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  installMethod: CodexInstallMethod | null;
  canUpdate: boolean;
  state: CodexUpdateState;
  message?: string;
  manualCommand?: string;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; outputLimit: number; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

interface CodexInstallation {
  executable: string;
  realPath: string;
  installMethod: CodexInstallMethod | null;
  updateExecutable: string | null;
  updateArgs: string[];
  manualCommand?: string;
}

interface InstalledProbe extends CodexInstallation {
  currentVersion: string | null;
}

interface CodexCliUpdaterOptions {
  codexBin: string;
  restartAppServer: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runner?: CommandRunner;
  now?: () => number;
}

const REGISTRY_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest";
const LATEST_CACHE_MS = 60 * 60_000;
const LATEST_TIMEOUT_MS = 4_000;
const PACKAGE_QUERY_TIMEOUT_MS = 8_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 10 * 1024;

function appendBounded(current: string, chunk: Buffer, limit: number): { value: string; truncated: boolean } {
  if (current.length >= limit) return { value: current, truncated: chunk.length > 0 };
  const text = chunk.toString("utf8");
  const remaining = limit - current.length;
  return { value: current + text.slice(0, remaining), truncated: text.length > remaining };
}

function terminateProcessTree(child: ChildProcess, force: boolean): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    // The process group may already be gone between the timer and this call.
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

export const runCommand: CommandRunner = (executable, args, options) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;

    child.stdout.on("data", (chunk: Buffer) => {
      const next = appendBounded(stdout, chunk, options.outputLimit);
      stdout = next.value;
      truncated ||= next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = appendBounded(stderr, chunk, options.outputLimit);
      stderr = next.value;
      truncated ||= next.truncated;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child, false);
      forceTimer = setTimeout(() => terminateProcessTree(child, true), 3000);
      forceTimer.unref();
    }, options.timeoutMs);
    timer.unref();

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      reject(err);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve({ exitCode, stdout, stderr, timedOut, truncated });
    });
  });

async function requireExecutable(candidate: string): Promise<string> {
  await fs.access(candidate, fsConstants.X_OK);
  return candidate;
}

export async function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (path.isAbsolute(command) || command.includes(path.sep)) return requireExecutable(path.resolve(command));
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      return await requireExecutable(candidate);
    } catch {
      /* keep searching PATH */
    }
  }
  throw new Error(`Executable not found: ${command}`);
}

export async function detectCodexInstallation(
  codexBin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexInstallation> {
  const executable = await resolveExecutable(codexBin, env);
  const realPath = await fs.realpath(executable);
  const normalized = realPath.split(path.sep).join("/");

  if (normalized.includes("/node_modules/@openai/codex/")) {
    const npmName = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmCandidate = path.join(path.dirname(executable), npmName);
    try {
      const updateExecutable = await requireExecutable(npmCandidate);
      return {
        executable,
        realPath,
        installMethod: "npm",
        updateExecutable,
        updateArgs: ["install", "-g", "@openai/codex@latest"],
        manualCommand: "npm install -g @openai/codex@latest",
      };
    } catch {
      return { executable, realPath, installMethod: null, updateExecutable: null, updateArgs: [] };
    }
  }

  if (normalized.includes("/Cellar/codex/")) {
    const cellarMarker = "/Cellar/codex/";
    const brewPrefix = realPath.slice(0, normalized.indexOf(cellarMarker));
    try {
      const updateExecutable = await requireExecutable(path.join(brewPrefix, "bin", "brew"));
      return {
        executable,
        realPath,
        installMethod: "homebrew",
        updateExecutable,
        updateArgs: ["upgrade", "codex"],
        manualCommand: "brew upgrade codex",
      };
    } catch {
      return { executable, realPath, installMethod: null, updateExecutable: null, updateArgs: [] };
    }
  }

  return { executable, realPath, installMethod: null, updateExecutable: null, updateArgs: [] };
}

export function parseCodexVersion(output: string): string | null {
  return output.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => value.split("-", 1)[0]!.split(".").map((part) => Number(part));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function commandFailureMessage(result: CommandResult): string {
  if (result.timedOut) return "The Codex CLI update timed out after five minutes.";
  const detail = (result.stderr || result.stdout).trim();
  if (/EACCES|permission denied|operation not permitted/i.test(detail)) {
    return "The package manager does not have permission to update this Codex installation.";
  }
  return detail ? `The Codex CLI update failed: ${detail}` : `The Codex CLI update exited with code ${String(result.exitCode)}.`;
}

export class CodexCliUpdater {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private latestCache: { value: string; expiresAt: number } | null = null;
  private state: CodexUpdateState = "idle";
  private stateMessage: string | undefined;
  private inFlight: Promise<CodexCliStatus> | null = null;

  constructor(private readonly options: CodexCliUpdaterOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runner = options.runner ?? runCommand;
    this.now = options.now ?? Date.now;
  }

  private async probeInstalled(): Promise<InstalledProbe> {
    const install = await detectCodexInstallation(this.options.codexBin, this.env);
    const result = await this.runner(install.executable, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      outputLimit: OUTPUT_LIMIT,
      env: this.env,
    });
    return { ...install, currentVersion: result.exitCode === 0 ? parseCodexVersion(result.stdout || result.stderr) : null };
  }

  private async packageManagerLatest(probe: InstalledProbe | null): Promise<string | null> {
    if (!probe?.updateExecutable || !probe.installMethod) return null;
    const args =
      probe.installMethod === "npm"
        ? ["view", "@openai/codex", "version", "--json"]
        : ["info", "codex", "--json=v2"];
    try {
      const result = await this.runner(probe.updateExecutable, args, {
        timeoutMs: PACKAGE_QUERY_TIMEOUT_MS,
        outputLimit: OUTPUT_LIMIT,
        env: this.env,
      });
      if (result.exitCode !== 0 || result.timedOut) return null;
      if (probe.installMethod === "npm") return parseCodexVersion(result.stdout || result.stderr);
      const body = JSON.parse(result.stdout) as { formulae?: Array<{ versions?: { stable?: unknown } }> };
      const stable = body.formulae?.[0]?.versions?.stable;
      return typeof stable === "string" && parseCodexVersion(stable) ? stable : null;
    } catch {
      return null;
    }
  }

  private async latestVersion(probe: InstalledProbe | null): Promise<string | null> {
    if (this.latestCache && this.latestCache.expiresAt > this.now()) return this.latestCache.value;
    try {
      const response = await this.fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(LATEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`registry returned ${response.status}`);
      const body = (await response.json()) as { version?: unknown };
      if (typeof body.version !== "string" || !parseCodexVersion(body.version)) throw new Error("invalid registry response");
      this.latestCache = { value: body.version, expiresAt: this.now() + LATEST_CACHE_MS };
      return body.version;
    } catch {
      const fallback = await this.packageManagerLatest(probe);
      if (fallback) this.latestCache = { value: fallback, expiresAt: this.now() + LATEST_CACHE_MS };
      return fallback;
    }
  }

  private buildStatus(probe: InstalledProbe | null, latestVersion: string | null): CodexCliStatus {
    const currentVersion = probe?.currentVersion ?? null;
    const updateAvailable =
      currentVersion && latestVersion ? compareVersions(currentVersion, latestVersion) < 0 : null;
    const canUpdate = Boolean(probe?.installMethod && probe.updateExecutable);
    let message = this.stateMessage;
    if (!message && !probe) message = "Codex CLI was not found.";
    if (!message && probe && !canUpdate) {
      message = "This Codex CLI installation is not managed by a supported npm or Homebrew installation.";
    }
    if (!message && !latestVersion) message = "Couldn't check the latest Codex CLI version.";
    if (!message && updateAvailable === false) message = "Codex CLI is up to date.";
    if (!message && updateAvailable) message = `Codex CLI ${latestVersion} is available.`;
    return {
      currentVersion,
      latestVersion,
      updateAvailable,
      installMethod: probe?.installMethod ?? null,
      canUpdate,
      state: this.state,
      ...(message ? { message } : {}),
      ...(probe?.manualCommand ? { manualCommand: probe.manualCommand } : {}),
    };
  }

  async getStatus(): Promise<CodexCliStatus> {
    const probe = await this.probeInstalled().catch(() => null);
    const latest = await this.latestVersion(probe);
    return this.buildStatus(probe, latest);
  }

  update(): Promise<CodexCliStatus> {
    if (this.inFlight) return this.inFlight;
    this.state = "running";
    this.stateMessage = undefined;
    this.inFlight = this.performUpdate().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performUpdate(): Promise<CodexCliStatus> {
    const before = await this.probeInstalled().catch(() => null);
    const latest = await this.latestVersion(before);
    if (!before?.updateExecutable || !before.installMethod) {
      this.state = "failed";
      this.stateMessage = "Aria could not identify a supported npm or Homebrew installation for the active Codex CLI.";
      return this.buildStatus(before, latest);
    }

    let result: CommandResult;
    try {
      result = await this.runner(before.updateExecutable, before.updateArgs, {
        timeoutMs: UPDATE_TIMEOUT_MS,
        outputLimit: OUTPUT_LIMIT,
        env: this.env,
      });
    } catch (err) {
      this.state = "failed";
      this.stateMessage = err instanceof Error ? `The Codex CLI update could not start: ${err.message}` : "The Codex CLI update could not start.";
      return this.buildStatus(before, latest);
    }

    if (result.exitCode !== 0 || result.timedOut) {
      this.state = "failed";
      this.stateMessage = commandFailureMessage(result);
      return this.buildStatus(before, latest);
    }

    const after = await this.probeInstalled().catch(() => null);
    if (!after?.currentVersion || after.currentVersion === before.currentVersion) {
      this.state = "unchanged";
      this.stateMessage = "The package manager completed, but the active Codex CLI version did not change.";
      return this.buildStatus(after ?? before, latest);
    }

    // A verified `@latest`/Homebrew update is authoritative when the registry
    // lookup itself was unavailable. Keep the settled UI from offering the
    // same update again solely because latestVersion is unknown.
    const settledLatest = latest ?? after.currentVersion;
    if (!latest) this.latestCache = { value: after.currentVersion, expiresAt: this.now() + LATEST_CACHE_MS };

    try {
      await this.options.restartAppServer();
      this.state = "succeeded";
      this.stateMessage = `Codex CLI updated to ${after.currentVersion}.`;
    } catch (err) {
      this.state = "failed";
      this.stateMessage = `Codex CLI updated to ${after.currentVersion}, but Aria could not restart it. Restart Aria manually.${
        err instanceof Error ? ` ${err.message}` : ""
      }`;
    }
    return this.buildStatus(after, settledLatest);
  }
}
