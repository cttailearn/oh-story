#!/usr/bin/env node
"use strict";

// test-imagegen-env.js — check-imagegen-env.sh 回归（无后端 MISSING / 有 key 全 OK / 专项检查）
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "skills/story-image/scripts/check-imagegen-env.sh");

const findBash = require("./find-git-bash");

function run(env) {
  const bash = findBash();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "img-env-"));
  const r = spawnSync(bash, [script], { env: { ...process.env, ...env, HOME: tmp }, encoding: "utf8", timeout: 60000 });
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.error(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

// state 1: no backend -> MISSING + exit 1
const r1 = run({ GPT_IMAGE_API_KEY: "", GRSAI_API_KEY: "", ARK_API_KEY: "", DASHSCOPE_API_KEY: "", COMFYUI_URL: "" });
check("无后端 → exit 1", r1.status === 1, `status=${r1.status}`);
check("无后端 → 报 MISSING 并提示询问", r1.stdout.includes("[MISSING]") && r1.stdout.includes("询问"));
check("依赖项 OK", r1.stdout.includes("[OK] curl") && r1.stdout.includes("[OK] python") && r1.stdout.includes("[OK] base64"));

// state 2: openai key -> all OK + exit 0
const r2 = run({ GPT_IMAGE_API_KEY: "test-key", GRSAI_API_KEY: "", ARK_API_KEY: "", DASHSCOPE_API_KEY: "", COMFYUI_URL: "" });
check("有 openai key → exit 0", r2.status === 0, `status=${r2.status} out=${r2.stdout.slice(-200)}`);
check("有 openai key → 后端 OK", r2.stdout.includes("[OK] 已配置后端") && r2.stdout.includes("openai"));

// state 3: --backend openai 专项检查
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "img-env3-"));
const r3 = spawnSync(findBash(), [script, "--backend", "openai"], { env: { ...process.env, GPT_IMAGE_API_KEY: "k", GRSAI_API_KEY: "", ARK_API_KEY: "", DASHSCOPE_API_KEY: "", COMFYUI_URL: "", HOME: tmp3 }, encoding: "utf8", timeout: 60000 });
check("--backend openai 专项 OK", r3.status === 0 && r3.stdout.includes("GPT_IMAGE_API_KEY 已配置"), r3.stdout.slice(-200));
fs.rmSync(tmp3, { recursive: true, force: true });

console.log(failures === 0 ? "PASS: test-imagegen-env.js" : `FAIL: ${failures} case(s)`);
process.exit(failures === 0 ? 0 : 1);
