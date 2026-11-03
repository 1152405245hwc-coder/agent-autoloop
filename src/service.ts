// Keeping it running: launchd on a Mac, systemd on Linux. Both start it at login and restart it if it stops.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-hub.ts");
/** Another install on this machine (another AGENT_HUB_HOME) has a service of its own. */
const label = () => (HOME === path.join(homedir(), ".agent-hub") ? "agent-hub" : `agent-hub-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`);
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plist() {
  const logs = path.join(HOME, "logs");
  const path_ = [path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>--disable-warning=ExperimentalWarning</string><string>${xml(PROGRAM)}</string><string>up</string></array>
  <key>EnvironmentVariables</key><dict><key>AGENT_HUB_HOME</key><string>${xml(HOME)}</string><key>PATH</key><string>${xml(path_)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit() {
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=AGENT_HUB_HOME=${HOME}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${PROGRAM} up
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let i = 0; i < 100 && spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0; i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

export function serviceRunning() {
  return process.platform === "darwin"
    ? existsSync(plistFile()) && spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0
    : spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
