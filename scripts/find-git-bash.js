"use strict";
// find-git-bash.js — 跨平台探测 Git for Windows 的 bash（排除 WSL/WindowsApps 存根）
// 被 run-guards 与各 test-*.js 复用；找不到时回退 "bash"（Linux/CI 由 PATH 提供）。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function findBash() {
  const candidates = [
    process.env.GIT_BASH || "",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Git\\bin\\bash.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 从 git.exe 位置反推：where git → D:/Program Files/Git/cmd/git.exe → ../bin/bash.exe
  const w = spawnSync("where", ["git"], { encoding: "utf8" });
  if (w.status === 0) {
    for (const line of w.stdout.split(/\r?\n/)) {
      const g = (line || "").trim();
      if (!g) continue;
      const cand = path.join(path.dirname(path.dirname(g)), "bin", "bash.exe");
      if (fs.existsSync(cand)) return cand;
    }
  }
  // PATH 上的 bash，排除 WSL(Windows/System32) 与商店存根(WindowsApps)
  const b = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (b.status === 0) {
    for (const line of b.stdout.split(/\r?\n/)) {
      const h = (line || "").trim();
      if (h && fs.existsSync(h) && !/System32|WindowsApps/i.test(h)) return h;
    }
  }
  return "bash";
}

module.exports = findBash;
