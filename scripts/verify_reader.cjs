#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const REQUIRED_FILES = [
  "index.html",
  "style.css",
  "data.js",
  "data-resolver.js",
  "semantics.js",
  "wave-core.js",
  "wave.js",
  "app.js"
];

const DEMO_PATTERNS = [
  [/demo_pipeline/i, "demo_pipeline"],
  [/work_router\.sv/i, "work_router.sv"],
  [/response_stage\.sv/i, "response_stage.sv"],
  [/模板中的示例检查项/, "模板示例检查项"],
  [/输入帧\s*→\s*路由处理\s*→\s*响应帧/, "示例总览标题"],
  [/window\.DEMO\b/, "window.DEMO"],
  [/window\.OA\b/, "window.OA"],
  [/D\.scenarios\.request/, "默认场景写死 request"],
  [/D\.meta\.demo|meta\.demo/, "运行时依赖 demo 标记"],
  [/demo-reader-theme/, "旧 demo 主题键"],
  [/clk\/rst_n/, "写死时钟复位图例"]
];

const DATA_COUPLING_PATTERNS = [
  [/window\.DEMO\b/, "window.DEMO"],
  [/window\.OA\b/, "window.OA"]
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeout = 10000, interval = 100) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      if (await check()) return true;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  if (lastError) throw lastError;
  return false;
}

function parseArgs(argv) {
  const options = {
    page: null,
    staticOnly: false,
    selfTest: false,
    json: false
  };
  for (const arg of argv) {
    if (arg === "--static") options.staticOnly = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (!options.page) options.page = arg;
  }
  options.page = path.resolve(options.page || process.cwd());
  return options;
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function isReaderData(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Array.isArray(value.modules) &&
    value.modules.length &&
    value.files &&
    typeof value.files === "object" &&
    !Array.isArray(value.files)
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moduleDepth(module, byName) {
  let depth = 0;
  let current = module;
  let guard = 0;
  while (current && current.parent && guard < 256) {
    const parent = byName.get(current.parent);
    if (!parent) break;
    depth += 1;
    current = parent;
    guard += 1;
  }
  return depth;
}

function projectedTopology(data) {
  const root = data.modules.find((module) => !module.parent) || data.modules[0];
  if (!root) return { root: null, nodeCount: 0, edgeCount: 0, crossLevelEdges: 0 };
  const byName = new Map(data.modules.map((module) => [module.name, module]));
  const children = data.modules.filter((module) => module.parent === root.name);
  const childNames = new Set(children.map((module) => module.name));
  const externals = data.externals || {};
  const scopeFor = (name) => {
    let current = byName.get(name);
    let guard = 0;
    while (current && current.parent && guard < 256) {
      if (current.parent === root.name) return current.name;
      current = byName.get(current.parent);
      guard += 1;
    }
    return null;
  };
  const visible = new Set(childNames);
  const edgeKeys = new Set();
  let crossLevelEdges = 0;
  for (const edge of data.edges || []) {
    if (!edge || !edge.from || !edge.to) continue;
    const fromScope = byName.has(edge.from) ? scopeFor(edge.from) : (externals[edge.from] ? edge.from : null);
    const toScope = byName.has(edge.to) ? scopeFor(edge.to) : (externals[edge.to] ? edge.to : null);
    if (!fromScope || !toScope || fromScope === toScope) continue;
    if (!visible.has(fromScope) && !externals[fromScope]) continue;
    if (!visible.has(toScope) && !externals[toScope]) continue;
    visible.add(fromScope);
    visible.add(toScope);
    edgeKeys.add(fromScope + "|" + toScope + "|" + (edge.id || ""));
    if (fromScope !== edge.from || toScope !== edge.to) crossLevelEdges += 1;
  }
  return {
    root: root.name,
    nodeCount: visible.size,
    edgeCount: edgeKeys.size,
    crossLevelEdges
  };
}

function validateData(data) {
  const failures = [];
  const warnings = [];
  if (!data || !Array.isArray(data.modules) || !data.modules.length) {
    failures.push("data.modules 必须是非空数组");
    return { failures, warnings, info: null };
  }
  if (!data.files || typeof data.files !== "object" || Array.isArray(data.files)) {
    failures.push("data.files 必须是对象");
    return { failures, warnings, info: null };
  }
  const byName = new Map();
  for (const module of data.modules) {
    if (!module || !module.name) {
      failures.push("模块缺少 name");
      continue;
    }
    if (byName.has(module.name)) failures.push(`模块名重复: ${module.name}`);
    byName.set(module.name, module);
  }
  for (const module of data.modules) {
    if (module.parent && !byName.has(module.parent)) {
      failures.push(`模块 ${module.name} 的父模块不存在: ${module.parent}`);
    }
    if (module.file && !data.files[module.file]) {
      warnings.push(`模块 ${module.name} 引用了不存在的源码文件: ${module.file}`);
    }
  }
  for (const [file, info] of Object.entries(data.files)) {
    if (!info || typeof info.code !== "string") {
      failures.push(`源码文件 ${file} 缺少 code 字符串`);
    }
  }
  const externals = data.externals || {};
  for (const edge of data.edges || []) {
    if (!edge || !edge.from || !edge.to) {
      failures.push("连线缺少 from/to");
      continue;
    }
    if (!byName.has(edge.from) && !externals[edge.from]) {
      failures.push(`连线 ${edge.id || "?"} 的起点不存在: ${edge.from}`);
    }
    if (!byName.has(edge.to) && !externals[edge.to]) {
      failures.push(`连线 ${edge.id || "?"} 的终点不存在: ${edge.to}`);
    }
  }
  for (const [name, signal] of Object.entries(data.signals || {})) {
    if (signal && signal.file && !data.files[signal.file]) {
      warnings.push(`信号 ${name} 引用了不存在的源码文件: ${signal.file}`);
    }
  }
  if (!data.meta || !data.meta.title) warnings.push("data.meta.title 未设置，页面会使用模块名作为标题");
  const depth = Math.max(...data.modules.map((module) => moduleDepth(module, byName)), 0);
  const topology = projectedTopology(data);
  return {
    failures,
    warnings,
    info: {
      modules: data.modules.length,
      files: Object.keys(data.files).length,
      signals: Object.keys(data.signals || {}).length,
      edges: (data.edges || []).length,
      depth,
      topology
    }
  };
}

function staticCheck(pageDir) {
  const failures = [];
  const warnings = [];
  for (const file of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(pageDir, file))) failures.push(`缺少文件: ${file}`);
  }
  if (failures.length) return { failures, warnings, data: null, dataName: null, info: null };

  const index = readText(path.join(pageDir, "index.html"));
  const app = readText(path.join(pageDir, "app.js"));
  const semantics = readText(path.join(pageDir, "semantics.js"));
  const dataSource = readText(path.join(pageDir, "data.js"));
  const scriptOrder = ["data.js", "data-resolver.js", "semantics.js", "app.js"].map((name) => {
    const hit = index.search(new RegExp(`<script[^>]+src=["']?${escapeRegExp(name)}(?:["'\\s>])`));
    if (hit < 0) failures.push(`index.html 未按顺序加载 ${name}`);
    return hit;
  });
  if (scriptOrder.every((value) => value >= 0)) {
    for (let indexValue = 1; indexValue < scriptOrder.length; indexValue += 1) {
      if (scriptOrder[indexValue] < scriptOrder[indexValue - 1]) {
        failures.push("脚本顺序必须是 data.js → data-resolver.js → semantics.js → app.js");
        break;
      }
    }
  }
  if (!/RTLReaderData/.test(app) || !/RTLReaderData/.test(semantics)) {
    failures.push("app.js/semantics.js 未使用 data-resolver.js 的数据入口");
  }
  const runtimeText = [app, semantics, index].join("\n");
  for (const [pattern, label] of DEMO_PATTERNS) {
    if (pattern.test(runtimeText)) failures.push(`运行时文件仍含示例内容: ${label}`);
  }
  for (const [pattern, label] of DATA_COUPLING_PATTERNS) {
    if (pattern.test(dataSource)) failures.push(`data.js 仍通过 Demo 全局名耦合: ${label}`);
  }

  const sandbox = { window: {}, console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  let data = null;
  let dataName = null;
  try {
    vm.runInContext(dataSource, sandbox, { timeout: 5000, filename: "data.js" });
    const names = Object.keys(sandbox.window).filter((name) => isReaderData(sandbox.window[name]));
    if (!names.length) {
      failures.push("data.js 没有导出包含 modules 和 files 的数据对象");
    } else {
      dataName = names.includes("RTL_READING_DATA") ? "RTL_READING_DATA" : names[0];
      data = sandbox.window[dataName];
      if (names.length > 1 && !names.includes("RTL_READING_DATA")) {
        warnings.push(`data.js 导出多个候选数据对象: ${names.join(", ")}；运行时将要求显式设置 RTL_READING_DATA_GLOBAL`);
      }
    }
  } catch (error) {
    failures.push("data.js 求值失败: " + error.message);
  }
  if (!data) return { failures, warnings, data: null, dataName, info: null };
  const dataCheck = validateData(data);
  failures.push(...dataCheck.failures);
  warnings.push(...dataCheck.warnings);
  return { failures, warnings, data, dataName, info: dataCheck.info };
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ].filter(Boolean);
  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    );
    const playwrightRoot = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "ms-playwright")
      : null;
    if (playwrightRoot) {
      try {
        for (const name of fs.readdirSync(playwrightRoot)) {
          if (name.startsWith("chromium_headless_shell-")) {
            candidates.push(path.join(playwrightRoot, name, "chrome-headless-shell-win64", "chrome-headless-shell.exe"));
          } else if (name.startsWith("chromium-")) {
            candidates.push(
              path.join(playwrightRoot, name, "chrome-win64", "chrome.exe"),
              path.join(playwrightRoot, name, "chrome-win", "chrome.exe")
            );
          }
        }
      } catch (_) {}
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails || {};
        const exception = details.exception || {};
        this.errors.push("uncaught: " + (exception.description || details.text || ""));
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        const args = (message.params.args || []).map((arg) =>
          arg.value != null ? String(arg.value) : (arg.description || "")
        );
        this.errors.push("console.error: " + args.join(" "));
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception || {};
      throw new Error(exception.description || result.exceptionDetails.text || "evaluate failed");
    }
    return result.result ? result.result.value : undefined;
  }

  async navigate(url) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.navigate", { url });
    const ready = await waitFor(async () => {
      try {
        return (await this.evaluate("document.readyState")) === "complete";
      } catch (_) {
        return false;
      }
    }, 12000);
    if (!ready) throw new Error("页面加载超时: " + url);
    await delay(450);
  }

  async domClick(selector) {
    return this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return false;
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    })()`);
  }

  async realClick(selector) {
    const point = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height };
    })()`);
    if (!point || point.w <= 0 || point.h <= 0) return this.domClick(selector);
    await delay(80);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1
    });
    return true;
  }

  async close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

async function launchBrowser() {
  if (typeof WebSocket === "undefined") {
    throw new Error("需要 Node 20+ 提供内置 WebSocket；请升级 Node 或使用 --static");
  }
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("未找到 Chrome/Chromium。设置 CHROME_PATH 后重试，或使用 --static");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-reader-verify-"));
  const args = [
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ];
  if (!/headless-shell/i.test(chrome)) args.unshift("--headless=new");
  const child = spawn(chrome, args, { stdio: "ignore", windowsHide: true });
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    const ready = await waitFor(() => fs.existsSync(portFile), 12000);
    if (!ready) throw new Error("Chrome 未创建 DevToolsActivePort");
    const lines = readText(portFile).trim().split(/\r?\n/);
    const port = Number(lines[0]);
    if (!Number.isFinite(port) || port <= 0) throw new Error("无效的 DevTools 端口");
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    let target = targets.find((item) => item.type === "page");
    if (!target) {
      target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
        .then((response) => response.json());
    }
    if (!target || !target.webSocketDebuggerUrl) throw new Error("未找到可调试页面目标");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const client = new CdpClient(ws);
    client.close = async () => {
      await CdpClient.prototype.close.call(client);
      try {
        child.kill();
      } catch (_) {}
      await delay(250);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch (_) {}
    };
    return client;
  } catch (error) {
    try {
      child.kill();
    } catch (_) {}
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (_) {}
    throw error;
  }
}

async function browserCheck(pageDir, staticInfo, options = {}) {
  const failures = [];
  const warnings = [];
  const client = await launchBrowser();
  try {
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.navigate(pathToFileURL(path.join(pageDir, "index.html")).href);
    const boot = await client.evaluate(`(() => ({
      title: document.title,
      resolved: Boolean(window.RTLReaderData && window.RTLReaderData.resolve()),
      semantic: Boolean(window.SigSem),
      mainLength: ((document.querySelector("#main") || {}).innerText || "").trim().length
    }))()`);
    if (!boot.resolved) failures.push("浏览器中未解析到数据对象");
    if (!boot.semantic) failures.push("SigSem 未初始化，信号不会成为可点击符号");
    if (!boot.mainLength) failures.push("总览正文为空");

    await client.realClick('[data-tab="code"]');
    await delay(350);
    const code = await client.evaluate(`(() => ({
      tokens: document.querySelectorAll("#codeBody .tk-id.sig[data-signal]").length,
      first: (document.querySelector("#codeBody .tk-id.sig[data-signal]") || {}).dataset?.signal || ""
    }))()`);
    if (!code.tokens) {
      failures.push("代码页没有可点击的信号词元");
    } else {
      await client.realClick("#codeBody .tk-id.sig[data-signal]");
      await delay(450);
      const clicked = await client.evaluate(`(() => ({
        type: (document.querySelector("#inspType") || {}).textContent || "",
        title: (document.querySelector("#inspBody .i-title") || {}).textContent || "",
        nav: (document.querySelector("#sigNavName") || {}).textContent || "",
        snippetHidden: !document.querySelector("#snippetCard") || document.querySelector("#snippetCard").hidden,
        snippetTitle: (document.querySelector("#snippetCard h2") || {}).textContent || "",
        snippetItems: document.querySelectorAll("#snippetCard .snippet-item").length
      }))()`);
      if (!/信号详情/.test(clicked.type)) failures.push("单击信号后右栏未显示信号详情");
      if (clicked.title !== code.first) failures.push("单击信号后右栏标题与信号不一致");
      if (clicked.nav !== code.first) failures.push("单击信号后导航条未同步");
      if (clicked.snippetHidden) failures.push("单击信号后相关片段卡未打开");
      if (clicked.snippetTitle !== code.first) failures.push("相关片段卡标题与信号不一致");
      if (!clicked.snippetItems) failures.push("相关片段卡没有片段");
    }

    await client.realClick('[data-tab="structure"]');
    await delay(350);
    const structure = await client.evaluate(`(() => ({
      nodes: document.querySelectorAll("#main svg .blk, #main svg .ext").length,
      edges: document.querySelectorAll("#main svg .edge").length
    }))()`);
    const expectedEdges = staticInfo && staticInfo.topology ? staticInfo.topology.edgeCount : 0;
    if (!structure.nodes) failures.push("模块结构图没有渲染模块节点");
    if (expectedEdges > 0 && structure.edges === 0) failures.push("结构图丢弃了全部可见连线");
    if (expectedEdges > 0 && structure.edges < expectedEdges) {
      warnings.push(`结构图连线数 ${structure.edges} 少于投影后的 ${expectedEdges}`);
    }
    if (structure.edges) {
      const clickedEdge = await client.domClick("#main svg .edge");
      if (!clickedEdge) failures.push("无法点击结构图连线");
      await delay(250);
      const edge = await client.evaluate(`(() => ({
        type: (document.querySelector("#inspType") || {}).textContent || "",
        title: (document.querySelector("#inspBody .i-title") || {}).textContent || ""
      }))()`);
      if (!/连线依据/.test(edge.type)) failures.push("单击连线后右栏未显示连线依据");
      if (!edge.title.includes("→")) failures.push("连线详情没有真实端点");
    }

    const portSignal = await client.evaluate(`(() => {
      const element = document.querySelector("#main .port-line[data-signal]");
      return element ? { name: element.dataset.signal || "" } : null;
    })()`);
    if (portSignal) {
      await client.realClick("#main .port-line[data-signal]");
      await delay(350);
      const portClicked = await client.evaluate(`(() => ({
        type: (document.querySelector("#inspType") || {}).textContent || "",
        title: (document.querySelector("#inspBody .i-title") || {}).textContent || ""
      }))()`);
      if (!/信号详情/.test(portClicked.type)) failures.push("结构页端口信号单击后右栏未显示信号详情");
      if (portClicked.title !== portSignal.name) failures.push("结构页端口信号单击后右栏标题不一致");
    }

    for (const tab of ["overview", "structure", "dataflow", "control", "code", "timing", "verify"]) {
      await client.realClick(`[data-tab="${tab}"]`);
      await delay(tab === "timing" ? 500 : 250);
      const contentLength = await client.evaluate(
        `((document.querySelector("#main") || {}).innerText || "").trim().length`
      );
      if (!contentLength) failures.push(`页签 ${tab} 渲染为空`);
      if (tab === "timing" && staticInfo && staticInfo.data && staticInfo.data.wave) {
        const timing = await client.evaluate(`(() => ({
          root: Boolean(document.querySelector("#timingWaveRoot")),
          canvas: Boolean(document.querySelector("#waveCanvas"))
        }))()`);
        if (!timing.root || !timing.canvas) failures.push("有时序数据但未渲染 VCD 查看器");
      }
      if (tab === "verify" && staticInfo && staticInfo.data &&
          staticInfo.data.validation && staticInfo.data.validation.summary) {
        const verifyText = await client.evaluate(
          `((document.querySelector("#main") || {}).innerText || "")`
        );
        if (/无可用报告/.test(verifyText)) failures.push("有验证数据但页面显示无可用报告");
      }
    }

    if (options.deep) {
      await client.realClick('[data-tab="structure"]');
      await delay(250);
      const deep = await client.evaluate(`(() => ({
        nodes: document.querySelectorAll("#main svg .blk, #main svg .ext").length,
        edges: document.querySelectorAll("#main svg .edge").length
      }))()`);
      if (deep.nodes < 2) failures.push("深层测试没有渲染可见父模块");
      if (deep.edges < 2) failures.push("深层测试没有把跨层连线投影到可见模块");
      if (deep.edges) {
        await client.domClick("#main svg .edge");
        await delay(250);
        const aggregation = await client.evaluate(`(() => (document.querySelector("#inspBody") || {}).innerText || "")()`);
        if (!/跨越了当前层级/.test(aggregation)) failures.push("跨层连线详情没有标明真实端点与聚合关系");
      }

      const drillNode = await client.realClick('#main svg [data-module="ctrl"]');
      if (!drillNode) failures.push("无法钻取到中间模块 ctrl");
      await delay(350);
      const drilled = await client.evaluate(`(() => ({
        focus: (document.querySelector(".diagram-crumb") || {}).innerText || "",
        nodes: document.querySelectorAll("#main svg .blk, #main svg .ext").length,
        boundary: document.querySelectorAll("#main svg .ext.boundary").length,
        edges: document.querySelectorAll("#main svg .edge").length
      }))()`);
      if (!/ctrl/.test(drilled.focus)) failures.push("钻取后未进入 ctrl 子视图");
      if (!drilled.boundary) failures.push("钻取中间模块后没有边界节点");
      if (drilled.edges < 2) failures.push("钻取中间模块后跨边界连线被丢弃");
      const drilledEdgeIds = await client.evaluate(`(() => Array.from(
        document.querySelectorAll("#main svg .edge"),
        (edge) => edge.dataset.edge || ""
      ))()`);
      if (!drilledEdgeIds.includes("ctrl_to_datapath")) {
        failures.push("钻取中间模块后，焦点模块到同级兄弟模块的连线被丢弃");
      }
      if (!drilledEdgeIds.includes("fsm_to_datapath")) {
        failures.push("钻取中间模块后，子模块到外部兄弟模块的连线被丢弃");
      }
      if (drilled.edges) {
        await client.domClick("#main svg .edge");
        await delay(250);
        const boundaryInfo = await client.evaluate(`(((document.querySelector("#inspBody") || {}).innerText) || "")`);
        if (!/跨越了当前模块边界/.test(boundaryInfo)) failures.push("跨边界连线详情没有标明真实端点");
      }
    }

    if (options.generic) {
      const generic = await client.evaluate(`(() => {
        const data = window.RTLReaderData && window.RTLReaderData.resolve();
        const root = data && data.modules
          ? (data.modules.find((module) => !module.parent) || data.modules[0] || {})
          : {};
        const signals = data && data.signals ? Object.keys(data.signals) : [];
        const scenario = data && data.scenarios ? Object.keys(data.scenarios)[0] || "" : "";
        const signal = signals.find((name) => {
          const item = data.signals[name] || {};
          return item.module === root.name;
        }) || signals[0] || "";
        const file = root.file || (data && data.files ? Object.keys(data.files)[0] || "" : "");
        return {
          defaults: data && data.defaults ? data.defaults : {},
          scenario,
          signal,
          file
        };
      })()`);
      if (generic.defaults.scenario !== generic.scenario) {
        failures.push("默认场景没有使用数据首项，仍存在 Demo 键偏好");
      }
      if (generic.defaults.signal !== generic.signal || generic.defaults.file !== generic.file) {
        failures.push("稀疏数据的默认信号或文件未从真实数据推导");
      }
      await client.realClick('[data-tab="dataflow"]');
      await delay(250);
      const selectedScenario = await client.evaluate(
        `((document.querySelector('button[data-scenario].on') || {}).innerText || "").trim()`
      );
      if (selectedScenario !== "突发事务") {
        failures.push("数据流默认场景仍优先选择了 request");
      }
      await client.realClick('[data-tab="verify"]');
      await delay(250);
      const verify = await client.evaluate(
        `((document.querySelector("#main") || {}).innerText || "")`
      );
      if (!/无可用报告/.test(verify)) failures.push("没有验证报告时未显示空状态");
    }

    await client.realClick('[data-tab="structure"]');
    await delay(300);
    const sideSignal = await client.evaluate(`(() => {
      const element = document.querySelector(".sigitem[data-signal]");
      return element ? { name: element.dataset.signal || "" } : null;
    })()`);
    if (!sideSignal) {
      warnings.push("侧栏没有可点击信号，跳过非代码页单击验证");
    } else {
      await client.realClick(".sigitem[data-signal]");
      await delay(400);
      const sideClicked = await client.evaluate(`(() => ({
        type: (document.querySelector("#inspType") || {}).textContent || "",
        title: (document.querySelector("#inspBody .i-title") || {}).textContent || ""
      }))()`);
      if (!/信号详情/.test(sideClicked.type)) {
        failures.push("非代码页单击侧栏信号后右栏未显示信号详情");
      }
      if (sideClicked.title !== sideSignal.name) {
        failures.push("非代码页单击侧栏信号后右栏标题不一致");
      }
    }

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await client.navigate(pathToFileURL(path.join(pageDir, "index.html")).href);
    await client.realClick('[data-tab="code"]');
    await delay(350);
    if (await client.evaluate(`Boolean(document.querySelector("#codeBody .tk-id.sig[data-signal]"))`)) {
      await client.realClick("#codeBody .tk-id.sig[data-signal]");
      await delay(350);
      const drawer = await client.evaluate(`({
        open: document.body.classList.contains("inspector-open"),
        expanded: (document.querySelector("#inspToggle") || {}).getAttribute("aria-expanded"),
        title: (document.querySelector("#inspBody .i-title") || {}).textContent || ""
      })`);
      if (!drawer.open || drawer.expanded !== "true") {
        failures.push("1024px 下单击信号未打开右侧详情抽屉");
      }
      if (!drawer.title) failures.push("1024px 下右侧详情抽屉为空");
    }

    if (client.errors.length) failures.push(...client.errors.map((error) => `浏览器错误: ${error}`));
  } finally {
    await client.close();
  }
  return { failures, warnings, boot: null };
}

function deepFixtureData() {
  return {
    meta: {
      title: "uart_axi",
      headline: "UART AXI 控制路径",
      lead: "三层模块的跨层连线测试。"
    },
    modules: [
      {
        name: "uart_axi", label: "顶层", parent: null, file: "uart_axi.v",
        start: 1, end: 40, role: "连接控制器与数据通路。", note: "测试顶层。",
        ports: [], units: [], instances: ["ctrl", "datapath"]
      },
      {
        name: "ctrl", label: "控制器", parent: "uart_axi", file: "ctrl.v",
        start: 1, end: 30, role: "产生控制与状态。", note: "测试控制器。",
        ports: [], units: [], instances: ["fsm"]
      },
      {
        name: "fsm", label: "状态机", parent: "ctrl", file: "fsm.v",
        start: 1, end: 20, role: "产生启动条件。", note: "测试状态机。",
        ports: [], units: [], instances: []
      },
      {
        name: "datapath", label: "数据通路", parent: "uart_axi", file: "datapath.v",
        start: 1, end: 20, role: "接收控制并搬运数据。", note: "测试数据通路。",
        ports: [], units: [], instances: []
      }
    ],
    files: {
      "uart_axi.v": {
        dir: "rtl", lines: 6,
        code: "module uart_axi;\n  wire start;\n  wire valid;\n  ctrl u_ctrl(.start(start), .valid(valid));\n  datapath u_datapath(.start(start), .valid(valid));\nendmodule\n"
      },
      "ctrl.v": {
        dir: "rtl", lines: 3,
        code: "module ctrl(output wire start, output wire valid);\n  fsm u_fsm(.start(start));\n  assign valid = start;\nendmodule\n"
      },
      "fsm.v": {
        dir: "rtl", lines: 3,
        code: "module fsm(output reg start);\n  always @(posedge clk) start <= ~start;\nendmodule\n"
      },
      "datapath.v": {
        dir: "rtl", lines: 3,
        code: "module datapath(input wire start, input wire valid);\n  always @(posedge clk) if (valid) begin end\nendmodule\n"
      }
    },
    signals: {
      start: {
        module: "fsm", kind: "output reg", width: "1", purpose: "启动条件。",
        file: "fsm.v", line: 2, timing: "测试。", rules: [], related: [],
        evidence: [{ file: "fsm.v", start: 2, end: 2, note: "赋值" }]
      },
      valid: {
        module: "ctrl", kind: "output wire", width: "1", purpose: "有效条件。",
        file: "ctrl.v", line: 3, timing: "测试。", rules: [], related: [],
        evidence: [{ file: "ctrl.v", start: 3, end: 3, note: "赋值" }]
      }
    },
    externals: {},
    edges: [
      {
        id: "fsm_to_datapath", from: "fsm", to: "datapath", label: "start", kind: "control",
        signals: ["start"], evidence: [{ file: "fsm.v", start: 2, end: 2, note: "start 驱动数据通路" }]
      },
      {
        id: "ctrl_to_datapath", from: "ctrl", to: "datapath", label: "valid", kind: "data",
        signals: ["valid"], evidence: [{ file: "ctrl.v", start: 3, end: 3, note: "valid 进入数据通路" }]
      }
    ],
    layout: {},
    scenarios: {},
    validation: {
      summary: { benches: 1, cases: 1, checks: 1, status: "测试" },
      benches: [],
      notCovered: []
    }
  };
}

function genericFixtureData() {
  return {
    meta: {
      title: "cpu_top",
      headline: "取指与执行路径",
      lead: "不依赖参考 Demo 命名的稀疏数据夹具。"
    },
    modules: [
      {
        name: "cpu_top", label: "处理器顶层", parent: null, file: "cpu_top.v",
        start: 1, end: 5, role: "连接译码与执行模块。", note: "顶层只负责连接。",
        ports: [], units: [], instances: ["decoder", "executor"]
      },
      {
        name: "decoder", label: "译码", parent: "cpu_top", file: "decoder.v",
        start: 1, end: 3, role: "产生指令有效位。", note: "译码后交给执行模块。",
        ports: [], units: [], instances: []
      },
      {
        name: "executor", label: "执行", parent: "cpu_top", file: "executor.v",
        start: 1, end: 3, role: "消费指令有效位。", note: "只在本夹具中检查页面行为。",
        ports: [], units: [], instances: []
      }
    ],
    files: {
      "cpu_top.v": {
        code: "module cpu_top;\n  wire instr_vld;\n  decoder u_decode(.instr_vld(instr_vld));\n  executor u_exec(.instr_vld(instr_vld));\nendmodule\n"
      },
      "decoder.v": {
        code: "module decoder(output wire instr_vld);\n  assign instr_vld = 1'b1;\nendmodule\n"
      },
      "executor.v": {
        code: "module executor(input wire instr_vld);\n  always @(posedge clk) if (instr_vld) begin end\nendmodule\n"
      }
    },
    signals: {
      instr_vld: {
        module: "cpu_top",
        file: "cpu_top.v",
        line: 2,
        kind: "wire",
        width: "1 bit",
        purpose: "指示译码后的指令有效。",
        timing: "只在执行模块采样时使用。",
        rules: [],
        related: [],
        evidence: [{ file: "cpu_top.v", start: 2, end: 2, note: "网线声明" }]
      }
    },
    edges: [
      {
        id: "decode_to_exec",
        from: "decoder",
        to: "executor",
        label: "instr_vld",
        kind: "data",
        signals: ["instr_vld"],
        evidence: [{ file: "cpu_top.v", start: 3, end: 4, note: "实例端口映射" }]
      }
    ],
    scenarios: {
      burst: {
        title: "突发事务",
        note: "用于确认默认选择不依赖 request 键。",
        steps: [
          {
            phase: "译码",
            condition: "instr_vld",
            action: "送入执行模块",
            modules: ["decoder", "executor"],
            signals: ["instr_vld"]
          }
        ]
      },
      request: {
        title: "请求事务",
        steps: [{ phase: "不应成为默认", action: "仅用于对照" }]
      }
    }
  };
}

function createDeepFixture() {
  const source = path.resolve(__dirname, "..", "assets", "reference-reader");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-reader-deep-"));
  for (const file of REQUIRED_FILES) {
    if (file === "data.js") continue;
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  fs.writeFileSync(
    path.join(target, "data.js"),
    "window.UART_AXI = " + JSON.stringify(deepFixtureData(), null, 2) + ";\n",
    "utf8"
  );
  return target;
}

function createGenericFixture() {
  const source = path.resolve(__dirname, "..", "assets", "reference-reader");
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "rtl-reader-generic-"));
  for (const file of REQUIRED_FILES) {
    if (file === "data.js") continue;
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  fs.writeFileSync(
    path.join(target, "data.js"),
    "window.CPU_READER = " + JSON.stringify(genericFixtureData(), null, 2) + ";\n",
    "utf8"
  );
  return target;
}

function printResult(label, result) {
  const lines = [`== ${label} ==`];
  for (const item of result.warnings) lines.push("WARN " + item);
  for (const item of result.failures) lines.push("FAIL " + item);
  if (!result.failures.length) lines.push("PASS");
  console.log(lines.join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/verify_reader.cjs [page-dir] [--static] [--self-test] [--json]");
    return;
  }
  const report = {
    page: options.page,
    static: null,
    browser: null,
    selfTest: null,
    contractSelfTest: null
  };
  const staticResult = staticCheck(options.page);
  report.static = staticResult;
  if (staticResult.info) {
    console.log(
      `Data: window.${staticResult.dataName} | modules ${staticResult.info.modules} | ` +
      `files ${staticResult.info.files} | signals ${staticResult.info.signals} | ` +
      `edges ${staticResult.info.edges} | depth ${staticResult.info.depth} | ` +
      `projected root nodes ${staticResult.info.topology.nodeCount} edges ${staticResult.info.topology.edgeCount}`
    );
  }

  if (!options.staticOnly && !staticResult.failures.length) {
    try {
      report.browser = await browserCheck(options.page, staticResult.info, { deep: false });
    } catch (error) {
      report.browser = { failures: ["浏览器验收失败: " + error.message], warnings: [] };
    }
  }

  if (options.selfTest) {
    const fixture = createDeepFixture();
    try {
      const fixtureStatic = staticCheck(fixture);
      const fixtureBrowser = fixtureStatic.failures.length
        ? { failures: [], warnings: [] }
        : await browserCheck(fixture, fixtureStatic.info, { deep: true });
      report.selfTest = {
        failures: [...fixtureStatic.failures, ...fixtureBrowser.failures],
        warnings: [...fixtureStatic.warnings, ...fixtureBrowser.warnings],
        info: fixtureStatic.info
      };
    } catch (error) {
      report.selfTest = { failures: ["深层拓扑自测失败: " + error.message], warnings: [] };
    } finally {
      try {
        fs.rmSync(fixture, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (options.selfTest) {
    const fixture = createGenericFixture();
    try {
      const fixtureStatic = staticCheck(fixture);
      const fixtureBrowser = fixtureStatic.failures.length
        ? { failures: [], warnings: [] }
        : await browserCheck(fixture, fixtureStatic.info, { generic: true });
      report.contractSelfTest = {
        failures: [...fixtureStatic.failures, ...fixtureBrowser.failures],
        warnings: [...fixtureStatic.warnings, ...fixtureBrowser.warnings],
        info: fixtureStatic.info
      };
    } catch (error) {
      report.contractSelfTest = {
        failures: ["通用数据契约自测失败: " + error.message],
        warnings: []
      };
    } finally {
      try {
        fs.rmSync(fixture, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printResult("Static", report.static);
    if (report.browser) printResult("Browser", report.browser);
    if (report.selfTest) printResult("Deep hierarchy self-test", report.selfTest);
    if (report.contractSelfTest) printResult("Generic data contract self-test", report.contractSelfTest);
  }

  const failures = [
    ...report.static.failures,
    ...(report.browser ? report.browser.failures : []),
    ...(report.selfTest ? report.selfTest.failures : []),
    ...(report.contractSelfTest ? report.contractSelfTest.failures : [])
  ];
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
