(function () {
  "use strict";

  const D = window.DEMO;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[ch]);

  const TABS = [
    ["overview", "总览"],
    ["structure", "模块结构"],
    ["dataflow", "数据流"],
    ["control", "控制流"],
    ["code", "代码导航"],
    ["timing", "时序波形"],
    ["verify", "仿真验证"]
  ];

  const state = {
    tab: "overview",
    module: "demo_pipeline",
    signal: "req_valid",
    constant: null,
    constantFile: null,
    scenario: "request",
    codeFile: "demo_pipeline.sv",
    codeLine: 18,
    bench: null
  };

  const moduleByName = (name) => D.modules.find((item) => item.name === name);
  const signalNames = Object.keys(D.signals);

  /* 常量不是信号：只有声明、取值和引用位置，没有时钟沿。 */
  const constants = (() => {
    const found = new Map();
    const scan = (file, text) => {
      const add = (name, kind, width, value, line) => {
        const key = file + ":" + name;
        if (found.has(key)) return;
        const [raw, note] = value.split("//");
        const owner = moduleByName(D.modules.find((m) => m.file === file && line >= m.start && line <= m.end)?.name);
        found.set(key, {
          name, file, line, kind, width: width.trim(),
          value: raw.trim(), note: (note || "").trim(),
          module: owner ? owner.name : "", uses: []
        });
      };
      const kw = /\b(parameter|localparam)\b/g;
      let hit;
      while ((hit = kw.exec(text)) !== null) {
        const lineStart = text.lastIndexOf("\n", hit.index) + 1;
        if (text.slice(lineStart, hit.index).includes("//")) continue;
        let i = kw.lastIndex;
        let depth = 0;
        let end = -1;
        for (; i < text.length; i++) {
          const ch = text[i];
          if (ch === "/" && text[i + 1] === "/") {
            i = text.indexOf("\n", i);
            if (i < 0) { end = text.length; break; }
            continue;
          }
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth < 0) { end = i; break; } }
          else if (ch === ";" && depth === 0) { end = i; break; }
        }
        if (end < 0) end = text.length;
        const body = text.slice(kw.lastIndex, end);
        let start = 0;
        let inner = 0;
        for (let j = 0; j <= body.length; j++) {
          const ch = body[j];
          if (ch === "(" || ch === "[" || ch === "{") inner++;
          else if (ch === ")" || ch === "]" || ch === "}") inner--;
          if ((ch === "," && inner === 0) || j === body.length) {
            const seg = body.slice(start, j);
            const decl = seg.match(/([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
            if (decl) {
              const offset = kw.lastIndex + start + seg.indexOf(decl[1]);
              const width = (seg.slice(0, seg.indexOf(decl[1])).match(/\[[^\]]*\]/) || [""])[0];
              add(decl[1], hit[1], width, decl[2], text.slice(0, offset).split("\n").length);
            }
            start = j + 1;
          }
        }
        kw.lastIndex = end;
      }
    };
    Object.entries(D.files).forEach(([file, info]) => scan(file, info.code || ""));
    const needles = [...found.values()].map((item) => ({
      item, re: new RegExp("\\b" + item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b")
    }));
    Object.entries(D.files).forEach(([file, info]) => {
      (info.code || "").split("\n").forEach((line, index) => {
        needles.forEach(({ item, re }) => {
          if (file === item.file && index + 1 === item.line) return;
          if (re.test(line)) item.uses.push({ file, line: index + 1, text: line.trim() });
        });
      });
    });
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
  })();

  const constFor = (name, file) =>
    constants.find((item) => item.name === name && item.file === file) || null;

  function applyStoredTheme() {
    let theme = "light";
    try {
      theme = localStorage.getItem("demo-reader-theme") || "light";
    } catch (_) {}
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    $("#themeBtn").textContent = theme === "dark" ? "浅色" : "深色";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    $("#themeBtn").textContent = next === "dark" ? "浅色" : "深色";
    try {
      localStorage.setItem("demo-reader-theme", next);
    } catch (_) {}
  }

  function setHint(text) {
    $("#hint").textContent = text;
  }

  function setCrumb(text) {
    $("#crumb").textContent = text;
  }

  function closePanels() {
    document.body.classList.remove("nav-open", "inspector-open");
    $("#navToggle").setAttribute("aria-expanded", "false");
    $("#inspToggle").setAttribute("aria-expanded", "false");
  }

  function openPanel(kind) {
    const bodyClass = kind === "nav" ? "nav-open" : "inspector-open";
    document.body.classList.remove(kind === "nav" ? "inspector-open" : "nav-open");
    document.body.classList.add(bodyClass);
    $(kind === "nav" ? "#navToggle" : "#inspToggle").setAttribute("aria-expanded", "true");
  }

  function buildTabs() {
    $("#tabs").innerHTML = TABS.map(([id, label]) =>
      `<button class="tab${state.tab === id ? " on" : ""}" data-tab="${id}"${state.tab === id ? ' aria-current="page"' : ""}>${label}</button>`
    ).join("");
  }

  function moduleTree() {
    const roots = D.modules.filter((item) => !item.parent);
    const children = (parent) => D.modules.filter((item) => item.parent === parent);
    const render = (module, depth) => {
      const icon = depth === 0 ? "◆" : "▸";
      return `<button class="item${state.module === module.name ? " on" : ""}" data-module="${module.name}" style="padding-left:${6 + depth * 14}px" title="${module.name}">
        <span class="ico">${icon}</span><span class="nm">${esc(module.name)}</span>
      </button>${children(module.name).map((child) => render(child, depth + 1)).join("")}`;
    };
    return roots.map((root) => render(root, 0)).join("");
  }

  function paintSidebarList(query) {
    const q = String(query || "").trim().toLowerCase();
    const signals = signalNames
      .filter((name) => !q || name.toLowerCase().includes(q) || D.signals[name].purpose.toLowerCase().includes(q))
      .slice(0, 120)
      .map((name) => `<button class="sigitem${state.constant ? "" : state.signal === name ? " on" : ""}" data-signal="${name}">
          <span>${esc(name)}</span><span class="d">${esc(D.signals[name].kind)}</span>
        </button>`)
      .join("");
    const consts = constants
      .filter((item) => !q || item.name.toLowerCase().includes(q) || item.note.toLowerCase().includes(q))
      .slice(0, 40)
      .map((item) => `<button class="sigitem${state.constant === item.name && state.constantFile === item.file ? " on" : ""}" data-const="${esc(item.name)}" data-file="${esc(item.file)}">
          <span>${esc(item.name)}</span><span class="d">${esc(item.kind === "parameter" ? "param" : "const")}</span>
        </button>`)
      .join("");
    $("#sigList").innerHTML =
      signals + (consts ? `<div class="tiny dim2" style="padding:8px 6px 2px">常量</div>${consts}` : "") ||
      '<div class="tiny dim2" style="padding:7px 6px">没有匹配信号</div>';
  }

  function buildSidebar() {
    $("#modTree").innerHTML = moduleTree();
    $("#sigCount").textContent = constants.length
      ? `${signalNames.length} 信号 · ${constants.length} 常量`
      : `${signalNames.length} 个`;
    paintSidebarList($("#sigSearch").value);
    $("#fileCount").textContent = `${Object.keys(D.files).length} 个`;
    $("#fileTree").innerHTML = Object.entries(D.files).map(([name, file]) =>
      `<button class="item${state.tab === "code" && state.codeFile === name ? " on" : ""}" data-code="${name}">
        <span class="ico">V</span><span class="nm">${esc(name)}</span><span class="cnt">${file.lines}</span>
      </button>`
    ).join("");
  }

  function diagramSvg(selected) {
    const node = (name, x, y, width, label, caption) =>
      `<g class="blk${selected === name ? " sel" : ""}" data-module="${name}" transform="translate(${x} ${y})">
        <rect width="${width}" height="66" rx="6"></rect>
        <text x="${width / 2}" y="25" text-anchor="middle">${esc(label)}</text>
        <text class="sub" x="${width / 2}" y="42" text-anchor="middle">${esc(caption)}</text>
      </g>`;
    return `<svg viewBox="0 0 960 390" role="img" aria-label="示例数据从输入节点经过四个子模块到达响应节点">
      <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk" d="M0,0 L8,4 L0,8 z"></path></marker></defs>
      <g class="ext"><rect x="10" y="145" width="108" height="66" rx="6"></rect><text x="64" y="170" text-anchor="middle">输入源</text><text class="sub" x="64" y="188" text-anchor="middle">request</text></g>
      ${node("ingress_stage", 165, 145, 145, "输入检查", "ingress_stage")}
      ${node("work_router", 365, 145, 145, "任务路由", "work_router")}
      ${node("response_stage", 565, 145, 145, "响应对齐", "response_stage")}
      ${node("status_counter", 365, 278, 145, "状态计数", "status_counter")}
      <g class="ext"><rect x="765" y="145" width="120" height="66" rx="6"></rect><text x="825" y="170" text-anchor="middle">响应通道</text><text class="sub" x="825" y="188" text-anchor="middle">response</text></g>
      <path class="wire" marker-end="url(#arrow)" d="M118 178 H165"></path>
      <path class="wire" marker-end="url(#arrow)" d="M310 178 H365"></path>
      <path class="wire" marker-end="url(#arrow)" d="M510 178 H565"></path>
      <path class="wire" marker-end="url(#arrow)" d="M710 178 H765"></path>
      <path class="wire dash" marker-end="url(#arrow)" d="M438 211 V278"></path>
      <text class="wlabel" x="319" y="136">request</text><text class="wlabel" x="516" y="136">done</text><text class="wlabel" x="716" y="136">resp</text><text class="wlabel" x="451" y="250">event</text>
      <text class="dnote" x="16" y="330">单击模块查看职责、端口和代码入口；图为虚构示例</text>
    </svg>`;
  }

  function pathButton(number, title, detail, target, signal) {
    return `<button class="path" data-go="${target}"${signal ? ` data-signal="${signal}"` : ""}>
      <span class="n">${number}</span>
      <span class="path-copy"><span class="t">${title}</span><span class="d">${detail}</span></span>
      <span class="path-arrow">→</span>
    </button>`;
  }

  function renderOverview() {
    $("#main").innerHTML = `
      <section class="hero">
        <h1>输入帧 → 路由处理 → 响应帧</h1>
        <p class="lead">${esc(D.meta.note)}。示例聚焦一笔请求怎样经过字段检查、任务路由、响应生成和状态计数。</p>
      </section>
      <section aria-label="建议阅读顺序">
        <h3 class="tiny dim2" style="margin:0 0 7px">建议阅读顺序</h3>
        <div class="reading-path">
          ${pathButton("01", "看模块", "先了解职责与接口", "structure", "req_valid")}
          ${pathButton("02", "跟请求", "再跟踪一笔请求", "dataflow", "work_done")}
          ${pathButton("03", "读代码", "定位实现与信号", "code", "resp_valid")}
        </div>
      </section>
      <article class="card overview-map">
        <h3>请求如何经过各模块 <span class="section-meta">单时钟域</span></h3>
        <div class="diagram">${diagramSvg(state.module)}</div>
        <div class="legend"><span><i></i>请求 / 数据</span><span><i class="d"></i>控制 / 状态</span></div>
      </article>
      <div class="overview-followup">
        <span>示例检查：${D.validation.summary.cases} 个场景 · ${D.validation.summary.checks} 次断言</span>
        <button class="btn sm" data-go="verify">查看验证范围 →</button>
      </div>
      <details class="card fold-card">
        <summary>模板说明与资料来源</summary>
        <div class="fold-content">
          <p>此页仅演示 RTL 阅读页面的结构、视觉和交互。模块、源码、信号、测试计数均为虚构内容，不来自任何产品。</p>
        </div>
      </details>`;
    inspectModule(state.module, false);
  }

  function moduleCards() {
    return D.modules
      .filter((item) => item.parent === "demo_pipeline")
      .map((item) => `<button class="card" data-module="${item.name}" style="text-align:left;color:inherit;cursor:pointer">
        <h3>${esc(item.name)} <span class="section-meta">${esc(item.label)}</span></h3>
        <p class="small muted" style="line-height:1.65;margin:0">${esc(item.role)}</p>
      </button>`)
      .join("");
  }

  function renderStructure() {
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">模块结构</div><div class="sub">先看职责与接口，再进入具体信号。</div></div><span class="chip">${D.modules.length} 个模块 · 虚构示例</span></div>
      <article class="card overview-map">
        <h3>模块与连接关系 <span class="section-meta">请求 → 路由 → 响应</span></h3>
        <div class="diagram">${diagramSvg(state.module)}</div>
      </article>
      <div class="grid g2" style="margin-top:12px">${moduleCards()}</div>`;
    inspectModule(state.module, false);
  }

  function pipelineNodes() {
    return D.scenarios[state.scenario].steps.map((step, index) =>
      `${index ? '<span class="parrow">→</span>' : ""}<button class="pnode" data-signal="${index === 0 ? "req_valid" : index === 3 ? "resp_ready" : index === 2 ? "work_done" : "req_opcode"}">
        <div class="ph">${step[0]} · ${step[1]}</div><div class="pt">${step[2]}</div><div class="pd">${step[3]}</div>
      </button>`
    ).join("");
  }

  function renderDataflow() {
    const scenario = D.scenarios[state.scenario];
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">数据流</div><div class="sub">一笔请求在两个握手之间怎样推进。</div></div><span class="chip">${esc(scenario.title)}</span></div>
      <article class="card">
        <div class="row" style="margin-bottom:10px">
          ${Object.entries(D.scenarios).map(([key, value]) => `<button class="btn sm${state.scenario === key ? " on" : ""}" data-scenario="${key}">${esc(value.title)}</button>`).join("")}
        </div>
        <div class="pipe">${pipelineNodes()}</div>
        <div class="note">${esc(scenario.note)}</div>
      </article>
      <article class="card" style="margin-top:12px">
        <h3>关键握手</h3>
        <table class="t"><thead><tr><th>阶段</th><th>条件</th><th>下一状态</th></tr></thead><tbody>
          <tr><td>接收</td><td class="mono">req_valid && req_ready</td><td>检查请求类型</td></tr>
          <tr><td>执行</td><td class="mono">work_valid && work_ready</td><td>等待 work_done</td></tr>
          <tr><td>响应</td><td class="mono">resp_valid && resp_ready</td><td>释放当前请求</td></tr>
        </tbody></table>
      </article>`;
  }

  function renderControl() {
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">控制流</div><div class="sub">有效位决定请求是否推进，ready 决定何时可以兑现。</div></div></div>
      <div class="grid g3">
        <article class="card"><h3>正常路径</h3><p class="small muted">req_valid 到达后检查操作码，合法请求进入执行层，完成后生成响应。</p><button class="btn sm" data-go="dataflow" data-scenario="request">跟踪正常请求 →</button></article>
        <article class="card"><h3>反压路径</h3><p class="small muted">resp_ready 为 0 时保持 resp_valid，不重复生成新响应。</p><button class="btn sm" data-go="dataflow" data-scenario="backpressure">查看反压条件 →</button></article>
        <article class="card"><h3>错误路径</h3><p class="small muted">操作码为 0 时产生错误码，不进入正常执行分支。</p><button class="btn sm" data-go="dataflow" data-scenario="error">查看错误路径 →</button></article>
      </div>
      <article class="card" style="margin-top:12px">
        <h3>状态与优先级</h3>
        <table class="t"><thead><tr><th>条件</th><th>动作</th><th>目的</th></tr></thead><tbody>
          <tr><td class="mono">!rst_n</td><td>清空有效位与错误码</td><td>确定性复位</td></tr>
          <tr><td class="mono">error != 0</td><td>绕过执行层并返回错误</td><td>保护正常路径</td></tr>
          <tr><td class="mono">valid && !ready</td><td>保持当前数据与有效位</td><td>支持下游反压</td></tr>
          <tr><td class="mono">valid && ready</td><td>完成当前传输</td><td>推进下一笔</td></tr>
        </tbody></table>
      </article>`;
  }

  function highlightCode(line) {
    const tokenPattern = /(\/\/[^\n]*)|(\b(?:module|endmodule|input|output|wire|reg|assign|always|posedge|negedge|begin|end|if|else|parameter|localparam)\b)|(\b[A-Za-z_]\w*\b)|(\b\d+(?:'[bhd])?[0-9a-fA-F_xXzZ]*\b)/g;
    let result = "";
    let last = 0;
    let match;
    while ((match = tokenPattern.exec(line)) !== null) {
      result += esc(line.slice(last, match.index));
      if (match[1]) result += `<span class="tk-com">${esc(match[0])}</span>`;
      else if (match[2]) result += `<span class="tk-kw">${esc(match[0])}</span>`;
      else if (match[3]) {
        const word = match[0];
        if (D.signals[word]) result += `<span class="tk-id sig" role="button" tabindex="0" data-signal="${word}">${esc(word)}</span>`;
        else if (constFor(word, state.codeFile)) result += `<span class="tk-id const" role="button" tabindex="0" data-const="${word}" data-file="${state.codeFile}">${esc(word)}</span>`;
        else result += esc(word);
      }
      else result += `<span class="tk-num">${esc(match[0])}</span>`;
      last = match.index + match[0].length;
    }
    return result + esc(line.slice(last));
  }

  function renderCode() {
    const file = D.files[state.codeFile];
    const lines = file.code.split("\n");
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">代码导航</div><div class="sub">从信号、模块或阅读入口直接定位到源码行。</div></div><span class="chip">${esc(state.codeFile)}</span></div>
      <div class="code-bar">
        <label for="codeFileSelect">源码文件</label>
        <select class="search" id="codeFileSelect">${Object.keys(D.files).map((name) => `<option${name === state.codeFile ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>
        <button class="btn sm" data-code="demo_pipeline.sv" data-line="18">接收分支</button>
        <button class="btn sm" data-code="work_router.sv" data-line="14">任务完成</button>
        <button class="btn sm" data-code="response_stage.sv" data-line="7">响应保持</button>
      </div>
      <div class="code-wrap">
        <div class="code-scroll">
          ${lines.map((line, index) => {
            const number = index + 1;
            return `<div class="cl${number === state.codeLine ? " hl" : ""}" data-line="${number}"><span class="ln">${number}</span><span class="src">${highlightCode(line) || " "}</span></div>`;
          }).join("")}
        </div>
      </div>
      <div class="card code-explain code-explanation" style="margin-top:12px">
        <h4>当前入口</h4>
        <p>${esc(file.code.split("\n")[Math.max(0, state.codeLine - 1)].trim() || "空行")}</p>
        <div class="q">用信号详情继续</div>
        <p>点击源码中的信号名，右侧会显示用途、生效条件和可直接跳转的行号。</p>
      </div>`;
    $("#codeFileSelect").addEventListener("change", (event) => {
      state.codeFile = event.target.value;
      state.codeLine = 1;
      buildSidebar();
      renderCode();
    });
    requestAnimationFrame(() => {
      const target = $(`.cl[data-line="${state.codeLine}"]`);
      if (target) target.scrollIntoView({ block: "center", inline: "nearest" });
    });
  }

  function waveSvg() {
    const rows = [
      ["req_valid", ["0", "1", "1", "0"]],
      ["req_opcode", ["00", "01", "01", "00"]],
      ["work_done", ["0", "0", "1", "0"]],
      ["resp_valid", ["0", "0", "1", "1"]],
      ["resp_ready", ["0", "0", "0", "1"]]
    ];
    const rowHeight = 34;
    const cell = 150;
    const shapes = rows.map(([, values], row) => {
      const y = 22 + row * rowHeight;
      const levels = values.map((value) => value === "0" || value === "00" ? 24 : 6);
      let path = `M0 ${y + levels[0]}`;
      for (let i = 1; i < levels.length; i += 1) {
        const x = i * cell;
        path += ` H${x} V${y + levels[i]}`;
      }
      path += ` H${cell * levels.length}`;
      return `<path d="${path}" fill="none" stroke="var(--wave-bit)" stroke-width="2"></path>`;
    }).join("");
    return `<svg width="600" height="190" viewBox="0 0 600 190" aria-label="虚构时序波形示例">
      <rect width="600" height="190" fill="var(--wave-bg)"></rect>
      ${[0, 1, 2, 3].map((i) => `<line x1="${i * 150}" y1="18" x2="${i * 150}" y2="184" stroke="var(--wave-grid)"></line><text x="${i * 150 + 5}" y="14" fill="var(--wave-ruler)" font-size="10">C${i}</text>`).join("")}
      ${shapes}
    </svg>`;
  }

  function renderTiming() {
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">时序波形</div><div class="sub">只在有可信波形数据时展示采样时刻与值。</div></div><span class="chip">虚构波形示例</span></div>
      <div class="note amber">这是参考模板的虚构波形，用于展示布局。生成真实工程页时，没有 VCD/WLF 或仿真报告就不要显示本页的实测结论。</div>
      <article class="card" style="margin-top:12px">
        <div class="wave-tools"><span class="mono small">正常请求 · 4 拍窗口</span><button class="btn sm" data-go="code">从波形回到源码</button></div>
        <div class="wave-shell"><div class="wave-body">
          <div class="wave-labels"><div class="wl mod">pipeline</div><div class="wl">req_valid</div><div class="wl">req_opcode</div><div class="wl">work_done</div><div class="wl">resp_valid</div><div class="wl">resp_ready</div></div>
          <div class="wave-scroll">${waveSvg()}</div>
        </div></div>
        <div class="wave-info"><span>采样：clk 上升沿</span><span>范围：C0–C3</span><span>来源：模板虚构</span></div>
      </article>`;
  }

  function renderVerify() {
    const summary = D.validation.summary;
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">仿真验证</div><div class="sub">只记录实际执行过的检查，并单列未覆盖边界。</div></div><span class="chip">${esc(summary.status)}</span></div>
      <div class="grid g4">
        <div class="card stat"><div class="v">${summary.benches}</div><div class="l">测试平台</div><div class="s">模板示例</div></div>
        <div class="card stat"><div class="v">${summary.cases}</div><div class="l">场景</div><div class="s">模板示例</div></div>
        <div class="card stat"><div class="v">${summary.checks}</div><div class="l">断言</div><div class="s">模板示例</div></div>
        <div class="card stat"><div class="v">0</div><div class="l">真实波形</div><div class="s">未附带工程数据</div></div>
      </div>
      <section style="margin-top:14px">
        ${D.validation.benches.map((bench, index) => `<article class="bench${state.bench === index ? " open" : ""}">
          <button class="bench-h" data-bench="${index}" style="border:0;background:none;width:100%;text-align:left">
            <span class="nm">${esc(bench.name)}</span><span class="purpose">${esc(bench.purpose)}</span><span class="cnt">${bench.cases.length} 项</span>
          </button>
          <div class="bench-b">${bench.cases.map((item, i) => `<div class="case"><span class="id">C${i + 1}</span><span class="t">${esc(item)}</span><span class="p">模板中的示例检查项</span></div>`).join("")}</div>
        </article>`).join("")}
      </section>
      <details class="card fold-card">
        <summary>本页未覆盖的范围</summary>
        <div class="fold-content"><ul class="hlist">${D.validation.notCovered.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>
      </details>`;
  }

  function renderMain() {
    const renderers = {
      overview: renderOverview,
      structure: renderStructure,
      dataflow: renderDataflow,
      control: renderControl,
      code: renderCode,
      timing: renderTiming,
      verify: renderVerify
    };
    (renderers[state.tab] || renderOverview)();
    buildTabs();
    buildSidebar();
    setCrumb(TABS.find(([id]) => id === state.tab)?.[1] || "总览");
    setHint("选择模块、信号或源码入口查看上下文");
  }

  function inspectModule(name, reveal = true) {
    const module = moduleByName(name);
    if (!module) return;
    state.module = name;
    const parent = module.parent ? `<tr><td>父模块</td><td class="mono">${esc(module.parent)}</td></tr>` : "";
    const children = D.modules.filter((item) => item.parent === name).map((item) => item.name);
    $("#inspType").textContent = "模块上下文";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(module.name)}</div>
      <div class="i-sub">${esc(module.file)} · L${module.start}–${module.end}</div>
      <p class="insp-summary">${esc(module.role)}</p>
      <div class="i-sec"><h5>结构</h5><table class="t insp-kv"><tbody>
        ${parent}
        <tr><td>子模块</td><td>${children.length ? children.map(esc).join("、") : "—"}</td></tr>
        <tr><td>端口</td><td>${module.ports.length} 个</td></tr>
      </tbody></table></div>
      <div class="i-sec"><h5>行为边界</h5><p>${esc(module.note)}</p></div>
      <div class="i-actions"><button class="btn sm" data-code="${esc(module.file)}" data-line="${module.start}">代码</button><button class="btn sm" data-go="structure">结构图</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectConstant(name, file, reveal = true) {
    const item = constFor(name, file);
    if (!item) return;
    state.constant = name;
    state.constantFile = file;
    state.signal = null;
    $("#inspType").textContent = "常量";
    $("#inspBody").innerHTML = `
      <div class="i-title mono">${esc(item.name)}</div>
      <div class="i-sub">${esc(item.file)}:${item.line} · ${esc(item.kind)}</div>
      <div class="sem-meta">值 <b class="mono">${esc(item.value)}</b></div>
      <p class="insp-summary">${esc(item.note || `${item.name} 是编译期常量，用来替代散落在代码里的字面量。`)}</p>
      <div class="i-sec"><h5>更新方式</h5><p>编译期确定，运行中不随时钟或复位改变；改值要重新综合。</p></div>
      <div class="i-sec"><h5>引用位置 <span class="mini">${item.uses.length} 处</span></h5>
        <div class="row">${
          item.uses.slice(0, 12).map((use) =>
            `<button class="sem-chip mono" data-code="${esc(use.file)}" data-line="${use.line}" title="${esc(use.text)}">${esc(use.file)}:${use.line}</button>`
          ).join("") || '<span class="tiny dim2">只在声明处出现</span>'
        }</div></div>
      <div class="i-actions"><button class="btn sm" data-code="${esc(item.file)}" data-line="${item.line}">定位声明 →</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectSignal(name, reveal = true) {
    const signal = D.signals[name];
    if (!signal) return;
    state.signal = name;
    state.constant = null;
    state.constantFile = null;
    $("#inspType").textContent = "信号详情";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(name)}</div>
      <div class="i-sub">${esc(signal.module)} · ${esc(signal.file)}:${signal.line}</div>
      <div class="sem-meta">${esc(signal.kind)} · ${esc(signal.width)}</div>
      <p class="insp-summary">${esc(signal.purpose)}</p>
      <div class="i-sec"><h5>生效条件</h5><p>${esc(signal.timing)}</p></div>
      <details class="sem-fold"><summary>规则与边界 <span>${signal.rules.length} 条</span></summary><div class="sem-fold-b"><ul class="hlist">${signal.rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul></div></details>
      <details class="sem-fold"><summary>相关信号 <span>${signal.related.length} 个</span></summary><div class="sem-fold-b"><div class="row">${signal.related.map((item) => `<button class="sem-chip" data-signal="${esc(item)}">${esc(item)}</button>`).join("")}</div></div></details>
      <div class="i-actions"><button class="btn sm" data-code="${esc(signal.file)}" data-line="${signal.line}">定位源码 →</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function go(tab, options = {}) {
    state.tab = tab;
    if (options.scenario) state.scenario = options.scenario;
    closePanels();
    renderMain();
    $("#main").scrollTop = 0;
  }

  function openCode(file, line) {
    if (!D.files[file]) return;
    state.codeFile = file;
    state.codeLine = Math.max(1, Number(line) || 1);
    go("code");
  }

  document.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) return go(tab.dataset.tab);

    const path = event.target.closest("[data-go]");
    if (path) {
      go(path.dataset.go, { scenario: path.dataset.scenario });
      if (path.dataset.signal) inspectSignal(path.dataset.signal);
      return;
    }

    const module = event.target.closest("[data-module]");
    if (module) return inspectModule(module.dataset.module);

    const constant = event.target.closest("[data-const]");
    if (constant) return inspectConstant(constant.dataset.const, constant.dataset.file);

    const signal = event.target.closest("[data-signal]");
    if (signal) return inspectSignal(signal.dataset.signal);

    const code = event.target.closest("[data-code]");
    if (code) {
      if (code.dataset.line) return openCode(code.dataset.code, code.dataset.line);
      return openCode(code.dataset.code, 1);
    }

    const scenario = event.target.closest("[data-scenario]");
    if (scenario) {
      state.scenario = scenario.dataset.scenario;
      renderDataflow();
      return;
    }

    const bench = event.target.closest("[data-bench]");
    if (bench) {
      state.bench = state.bench === Number(bench.dataset.bench) ? null : Number(bench.dataset.bench);
      return renderVerify();
    }

    if (event.target.closest("[data-close-panel]")) return closePanels();
  });

  document.addEventListener("keydown", (event) => {
    const control = event.target.closest("[data-signal][role='button'], [data-const][role='button'], [data-module][role='button']");
    if (control && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    if (event.key === "Escape") closePanels();
  });

  $("#sigSearch").addEventListener("input", (event) => {
    paintSidebarList(event.target.value);
  });
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#navToggle").addEventListener("click", () => openPanel("nav"));
  $("#inspToggle").addEventListener("click", () => openPanel("inspector"));
  $("#panelBackdrop").addEventListener("click", closePanels);

  applyStoredTheme();
  renderMain();
}());
