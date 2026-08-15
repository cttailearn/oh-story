#!/usr/bin/env node
"use strict";

// test-imagegen-custom.js — 自定义图像 API 后端端到端回归
// 起本地 mock 图像 API（OpenAI 兼容 b64 / 自定义 url 结构 / 错误响应三种模式），
// 用临时 conf 指向 mock，跑 imagegen-custom.sh 验证出图、错误检测与认证头。
// 用法：node scripts/test-imagegen-custom.js [--bash <bash路径>]（缺省自动探测 git bash）

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync, spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "skills/story-image/scripts/imagegen-custom.sh");
const scriptDir = path.dirname(script);

// 1x1 透明 PNG（经典 67 字节）
const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function findBash() {
  const candidates = [
    process.env.GIT_BASH || "",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Git\\bin\\bash.exe",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const which = spawnSync("where", ["bash"], { encoding: "utf8" });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/)[0];
    if (first && fs.existsSync(first)) return first;
  }
  return "bash"; // 最后回退：PATH 上的 bash（CI/git bash 环境）
}

// mock 服务器：三种模式
function startMock(mode) {
  let lastAuth = null;
  let lastHeaders = null;
  let lastBody = null;
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      lastAuth = req.headers.authorization || "";
      lastHeaders = req.headers;
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        lastBody = raw;
        if (mode === "error") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid api key" } }));
          return;
        }
        if (mode === "custom-url") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results: [{ url: `http://127.0.0.1:${port}/img.png` }] }));
          return;
        }
        // openai-compatible b64
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: PNG1.toString("base64") }] }));
      });
      return;
    }
    if (req.method === "GET" && req.url === "/img.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG1);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve({ server, port, getState: () => ({ lastAuth, lastHeaders, lastBody }) });
    });
  });
}

// 异步 spawn：mock 服务器与脚本同进程，spawnSync 会阻塞事件循环导致 mock 无法响应
function runScript(bash, conf, promptText, args) {
  return new Promise((resolve) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "custom-img-"));
    const confFile = path.join(tmp, "custom-backend.conf");
    const promptFile = path.join(tmp, "prompt.txt");
    const outFile = path.join(tmp, "out.png");
    fs.writeFileSync(confFile, conf, "utf8");
    fs.writeFileSync(promptFile, promptText, "utf8");
    const env = { ...process.env, HOME: tmp };
    const homeDir = path.join(tmp, ".story-image");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.renameSync(confFile, path.join(homeDir, "custom-backend.conf"));
    const proc = spawn(bash, [script, "--prompt-file", promptFile, "--out", outFile, ...args], {
      env, timeout: 120000,
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => resolve({ code, stdout, stderr, outFile, tmp }));
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: String(e), outFile, tmp }));
  });
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`[PASS] ${name}`);
  else { failures++; console.error(`[FAIL] ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  const bashIdx = process.argv.indexOf("--bash");
  const bash = bashIdx >= 0 ? process.argv[bashIdx + 1] : findBash();
  console.log(`bash: ${bash}`);

  // 1. OpenAI 兼容 b64 模式
  const m1 = await startMock("openai-b64");
  const conf1 = [
    `CUSTOM_API_URL="http://127.0.0.1:${m1.port}/v1/images/generations"`,
    "CUSTOM_API_KEY=\"test-key-123\"",
    "CUSTOM_API_MODEL=\"test-model-v1\"",
    "CUSTOM_TEST_SIZE=\"256x256\"",
  ].join("\n");
  let res = await runScript(bash, conf1, "a red apple", ["--test"]);
  check("openai-b64 模式出图成功", res.code === 0 && fs.existsSync(res.outFile) && fs.statSync(res.outFile).size > 0, `exit=${res.code} out=${res.stdout} err=${res.stderr}`);
  const s1 = m1.getState();
  check("认证头为 Bearer", s1.lastAuth === "Bearer test-key-123", s1.lastAuth);
  check("请求体含 model/prompt/size", s1.lastBody.includes("test-model-v1") && s1.lastBody.includes("a red apple") && s1.lastBody.includes("256x256"), s1.lastBody);
  m1.server.close();
  fs.rmSync(res.tmp, { recursive: true, force: true });

  // 2. 自定义 url 结构（results[].url）+ 自定义认证头
  const m2 = await startMock("custom-url");
  const conf2 = [
    `CUSTOM_API_URL="http://127.0.0.1:${m2.port}/v1/images/generations"`,
    "CUSTOM_API_KEY=\"secret\"",
    "CUSTOM_AUTH_HEADER=\"X-Api-Key: secret\"",
    "CUSTOM_IMAGE_PATH=\"results.0.url\"",
    "CUSTOM_BODY=\"{\\\"model\\\":\\\"__MODEL__\\\",\\\"prompt\\\":\\\"__PROMPT__\\\",\\\"n\\\":1}\"",
  ].join("\n");
  res = await runScript(bash, conf2, "a blue sky", []);
  check("自定义 url 结构出图成功", res.code === 0 && fs.existsSync(res.outFile) && fs.statSync(res.outFile).size > 0, `exit=${res.code} out=${res.stdout} err=${res.stderr}`);
  const s2 = m2.getState();
  check("自定义认证头生效", s2.lastHeaders["x-api-key"] === "secret" && !s2.lastHeaders.authorization, JSON.stringify(s2.lastHeaders));
  check("CUSTOM_BODY 模板替换生效（无 size 字段、含 n）", s2.lastBody.includes("\"n\"") && !s2.lastBody.includes("\"size\""), s2.lastBody);
  m2.server.close();
  fs.rmSync(res.tmp, { recursive: true, force: true });

  // 3. 错误响应检测
  const m3 = await startMock("error");
  const conf3 = [`CUSTOM_API_URL="http://127.0.0.1:${m3.port}/v1/images/generations"`, "CUSTOM_API_KEY=\"bad\""].join("\n");
  res = await runScript(bash, conf3, "whatever", ["--test"]);
  check("错误响应被检测并退出非 0", res.code !== 0 && res.stderr.includes("invalid api key"), `exit=${res.code} err=${res.stderr}`);
  m3.server.close();
  fs.rmSync(res.tmp, { recursive: true, force: true });

  // 4. imagegen.sh 分发：IMG_BACKEND=custom 转发
  const m4 = await startMock("openai-b64");
  const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "custom-gen-"));
  const home4 = path.join(tmp4, ".story-image");
  fs.mkdirSync(home4, { recursive: true });
  fs.writeFileSync(path.join(home4, "custom-backend.conf"), `CUSTOM_API_URL="http://127.0.0.1:${m4.port}/v1/images/generations"\nCUSTOM_API_KEY="k4"`, "utf8");
  const prompt4 = path.join(tmp4, "p.txt");
  const out4 = path.join(tmp4, "o.png");
  fs.writeFileSync(prompt4, "dispatch test", "utf8");
  const gen = path.join(repoRoot, "skills/story-image/scripts/imagegen.sh");
  const r4 = await new Promise((resolve) => {
    const proc = spawn(bash, [gen, "custom", "--prompt-file", prompt4, "--out", out4], { env: { ...process.env, HOME: tmp4 }, timeout: 120000 });
    let so = "", se = "";
    proc.stdout.on("data", (d) => (so += d));
    proc.stderr.on("data", (d) => (se += d));
    proc.on("close", (code) => resolve({ code, so, se }));
  });
  check("imagegen.sh 分发到 custom 后端", r4.code === 0 && fs.existsSync(out4), `exit=${r4.code} out=${r4.so} err=${r4.se}`);
  m4.server.close();
  fs.rmSync(tmp4, { recursive: true, force: true });

  console.log(failures === 0 ? "PASS: test-imagegen-custom.js" : `FAIL: ${failures} case(s)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("TEST ERROR:", e); process.exit(2); });
