import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexCliUpdater,
  detectCodexInstallation,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./codex-update.js";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false });

async function executable(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function npmFixture(): Promise<{ root: string; bin: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aria-codex-npm-"));
  const binDir = path.join(root, "bin");
  const real = path.join(root, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  await executable(real);
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(real, path.join(binDir, "codex"));
  await executable(path.join(binDir, "npm"));
  return { root, bin: path.join(binDir, "codex"), env: { ...process.env, PATH: binDir } };
}

test("detects the exact npm and Homebrew installations and rejects custom binaries", async () => {
  const npm = await npmFixture();
  const brewRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aria-codex-brew-"));
  const otherBrewRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aria-other-brew-"));
  try {
    const npmInstall = await detectCodexInstallation(npm.bin, npm.env);
    assert.equal(npmInstall.installMethod, "npm");
    assert.deepEqual(npmInstall.updateArgs, ["install", "-g", "@openai/codex@latest"]);

    const brewReal = path.join(brewRoot, "Cellar", "codex", "0.144.1", "bin", "codex");
    const brewBin = path.join(brewRoot, "bin");
    await executable(brewReal);
    await fs.mkdir(brewBin, { recursive: true });
    await fs.symlink(brewReal, path.join(brewBin, "codex"));
    await executable(path.join(brewBin, "brew"));
    await executable(path.join(otherBrewRoot, "brew"));
    const brewInstall = await detectCodexInstallation(path.join(brewBin, "codex"), {
      ...process.env,
      PATH: otherBrewRoot,
    });
    assert.equal(brewInstall.installMethod, "homebrew");
    assert.equal(brewInstall.updateExecutable, await fs.realpath(path.join(brewBin, "brew")));
    assert.deepEqual(brewInstall.updateArgs, ["upgrade", "codex"]);

    const custom = path.join(brewRoot, "custom", "codex");
    await executable(custom);
    assert.equal((await detectCodexInstallation(custom, process.env)).installMethod, null);
  } finally {
    await fs.rm(npm.root, { recursive: true, force: true });
    await fs.rm(brewRoot, { recursive: true, force: true });
    await fs.rm(otherBrewRoot, { recursive: true, force: true });
  }
});

test("checks the registry once, deduplicates updates, verifies the version, and restarts once", async () => {
  const fixture = await npmFixture();
  let version = "0.141.0";
  let fetches = 0;
  let installs = 0;
  let restarts = 0;
  const runner: CommandRunner = async (_executable, args) => {
    if (args[0] === "--version") return ok(`codex-cli ${version}`);
    installs++;
    version = "0.144.1";
    return ok("updated");
  };
  const updater = new CodexCliUpdater({
    codexBin: fixture.bin,
    env: fixture.env,
    runner,
    restartAppServer: async () => {
      restarts++;
    },
    fetchImpl: async () => {
      fetches++;
      return new Response(JSON.stringify({ version: "0.144.1" }), { status: 200 });
    },
  });
  try {
    assert.equal((await updater.getStatus()).updateAvailable, true);
    assert.equal((await updater.getStatus()).installMethod, "npm");
    assert.equal(fetches, 1);

    const first = updater.update();
    const second = updater.update();
    assert.strictEqual(first, second);
    const result = await first;
    assert.equal(result.state, "succeeded");
    assert.equal(result.currentVersion, "0.144.1");
    assert.equal(installs, 1);
    assert.equal(restarts, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("reports unchanged, permission, and registry failures without restarting", async () => {
  const fixture = await npmFixture();
  try {
    let restarts = 0;
    const unchanged = new CodexCliUpdater({
      codexBin: fixture.bin,
      env: fixture.env,
      runner: async (_executable, args) => (args[0] === "--version" ? ok("codex-cli 0.141.0") : ok()),
      restartAppServer: async () => {
        restarts++;
      },
      fetchImpl: async () => Promise.reject(new Error("offline")),
    });
    const unchangedResult = await unchanged.update();
    assert.equal(unchangedResult.state, "unchanged");
    assert.equal(unchangedResult.latestVersion, null);
    assert.equal(restarts, 0);

    const denied = new CodexCliUpdater({
      codexBin: fixture.bin,
      env: fixture.env,
      runner: async (_executable, args) =>
        args[0] === "--version"
          ? ok("codex-cli 0.141.0")
          : { exitCode: 1, stdout: "", stderr: "EACCES: permission denied", timedOut: false, truncated: false },
      restartAppServer: async () => {
        restarts++;
      },
      fetchImpl: async () => new Response(JSON.stringify({ version: "0.144.1" }), { status: 200 }),
    });
    const deniedResult = await denied.update();
    assert.equal(deniedResult.state, "failed");
    assert.match(deniedResult.message ?? "", /permission/i);
    assert.equal(restarts, 0);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("a verified update settles as current when the registry lookup is unavailable", async () => {
  const fixture = await npmFixture();
  let version = "0.141.0";
  const updater = new CodexCliUpdater({
    codexBin: fixture.bin,
    env: fixture.env,
    runner: async (_executable, args) => {
      if (args[0] === "--version") return ok(`codex-cli ${version}`);
      if (args[0] === "view") {
        return { exitCode: 1, stdout: "", stderr: "offline", timedOut: false, truncated: false };
      }
      version = "0.144.1";
      return ok("updated");
    },
    restartAppServer: async () => {},
    fetchImpl: async () => Promise.reject(new Error("offline")),
  });
  try {
    const result = await updater.update();
    assert.equal(result.state, "succeeded");
    assert.equal(result.currentVersion, "0.144.1");
    assert.equal(result.latestVersion, "0.144.1");
    assert.equal(result.updateAvailable, false);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("uses the active npm installation to check latest when the direct registry request fails", async () => {
  const fixture = await npmFixture();
  const updater = new CodexCliUpdater({
    codexBin: fixture.bin,
    env: fixture.env,
    runner: async (_executable, args) => {
      if (args[0] === "--version") return ok("codex-cli 0.144.1");
      if (args[0] === "view") return ok('"0.144.1"');
      throw new Error("unexpected update command");
    },
    restartAppServer: async () => {},
    fetchImpl: async () => Promise.reject(new Error("offline")),
  });
  try {
    const status = await updater.getStatus();
    assert.equal(status.currentVersion, "0.144.1");
    assert.equal(status.latestVersion, "0.144.1");
    assert.equal(status.updateAvailable, false);
    assert.equal(status.message, "Codex CLI is up to date.");
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("bounded command execution caps output and terminates timeouts", async () => {
  const capped = await runCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(1000))'], {
    timeoutMs: 1000,
    outputLimit: 32,
    env: process.env,
  });
  assert.equal(capped.stdout.length, 32);
  assert.equal(capped.truncated, true);

  const timedOut = await runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    timeoutMs: 30,
    outputLimit: 32,
    env: process.env,
  });
  assert.equal(timedOut.timedOut, true);
});

test("timed-out commands terminate descendant processes", { skip: process.platform === "win32" }, async () => {
  const script = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });',
    "console.log(child.pid);",
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const started = Date.now();
  const result = await runCommand(process.execPath, ["-e", script], {
    timeoutMs: 30,
    outputLimit: 128,
    env: process.env,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 4_500, "the command tree should be force-killed after the grace period");
  const descendantPid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(descendantPid));
  assert.throws(() => process.kill(descendantPid, 0), /ESRCH/);
});
