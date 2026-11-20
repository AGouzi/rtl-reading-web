(function () {
  "use strict";

  const D = window.RTLReaderData
    ? window.RTLReaderData.resolve()
    : window.RTL_READING_DATA;
  if (!D) {
    const detail = window.RTLReaderData && window.RTLReaderData.errorMessage
      ? window.RTLReaderData.errorMessage()
      : "";
    if (window.RTLReaderData && window.RTLReaderData.fail) {
      window.RTLReaderData.fail(detail || "未找到包含 modules 和 files 的 RTL 阅读数据。");
    } else {
      document.getElementById("main").innerHTML =
        '<div class="boot-error" role="alert"><h1>页面数据未加载</h1><p>请确认 data.js 在 app.js 之前加载，并导出 window.RTL_READING_DATA。</p></div>';
    }
    return;
  }
  D.meta = D.meta || {};
  D.signals = D.signals || {};
  D.portGroups = D.portGroups || {};
  D.externals = D.externals || {};
  D.edges = D.edges || [];
  D.layout = D.layout || {};
  D.scenarios = D.scenarios || {};
  D.files = D.files || {};
  if (!Array.isArray(D.modules) || !D.modules.length) {
    if (window.RTLReaderData && window.RTLReaderData.fail) {
      window.RTLReaderData.fail("data.modules 必须是非空数组。");
    }
    return;
  }

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
  const initialTab = TABS.some(([id]) => id === location.hash.replace(/^#\/?/, ""))
    ? location.hash.replace(/^#\/?/, "")
    : "overview";

  const configuredDefaults = D.defaults || {};
  const rootModule = D.modules.find((item) => item.name === configuredDefaults.module) ||
    D.modules.find((item) => !item.parent) ||
    D.modules[0];
  if (!rootModule || !rootModule.name) {
    if (window.RTLReaderData && window.RTLReaderData.fail) {
      window.RTLReaderData.fail("data.modules 中没有带 name 的可用模块。");
    }
    return;
  }
  const moduleByName = (name) => D.modules.find((item) => item.name === name);
  const moduleAt = (file, line) =>
    D.modules.find(
      (item) => item.file === file && Number(line) >= item.start && Number(line) <= item.end
    ) || null;
  const childrenOf = (name) => D.modules.filter((item) => item.parent === name);
  const signalNames = Object.keys(D.signals);
  const defaultSignal = D.signals[configuredDefaults.signal]
    ? configuredDefaults.signal
    : signalNames.find((name) => {
      const signal = D.signals[name] || {};
      return signal.module === rootModule.name;
    }) || signalNames[0] || null;
  const defaultScenario = D.scenarios[configuredDefaults.scenario]
    ? configuredDefaults.scenario
    : Object.keys(D.scenarios)[0] || null;
  const defaultFsmState = configuredDefaults.fsmState || (
    D.fsm && D.fsm.states && D.fsm.states.length ? D.fsm.states[0].id : null
  );
  const defaultCodeFile = D.files[configuredDefaults.file]
    ? configuredDefaults.file
    : rootModule.file || Object.keys(D.files)[0] || "";
  const defaultCodeLine = Number(configuredDefaults.line) || Number(rootModule.start) || 1;
  const internalEdges = D.modules.flatMap((module) =>
    ((module.internal && module.internal.edges) || []).map((edge) => ({
      ...edge,
      id: `${module.name}::${edge.id}`,
      module: module.name
    }))
  );
  const projectedEdges = new Map();
  const edgeById = (id) =>
    projectedEdges.get(id) ||
    D.edges.find((item) => item.id === id) ||
    internalEdges.find((item) => item.id === id);
  const kindLabels = { data: "数据", control: "控制", error: "错误", clock: "时钟/复位" };

  /* 常量不是信号：只有声明、取值和引用位置，没有时钟沿。 */
  const constants = (() => {
    const found = new Map();
    const scan = (file, text) => {
      const add = (name, kind, width, value, line) => {
        const key = `${file}:${name}`;
        if (found.has(key)) return;
        const [raw, note] = value.split("//");
        const owner = D.modules.find(
          (module) => module.file === file && line >= module.start && line <= module.end
        );
        found.set(key, {
          name,
          file,
          line,
          kind,
          width: width.trim(),
          value: raw.trim(),
          note: (note || "").trim(),
          module: owner ? owner.name : "",
          uses: []
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
        for (; i < text.length; i += 1) {
          const ch = text[i];
          if (ch === "/" && text[i + 1] === "/") {
            i = text.indexOf("\n", i);
            if (i < 0) {
              end = text.length;
              break;
            }
            continue;
          }
          if (ch === "(" || ch === "[" || ch === "{") depth += 1;
          else if (ch === ")" || ch === "]" || ch === "}") {
            depth -= 1;
            if (depth < 0) {
              end = i;
              break;
            }
          } else if (ch === ";" && depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) end = text.length;
        const body = text.slice(kw.lastIndex, end);
        let start = 0;
        let inner = 0;
        for (let j = 0; j <= body.length; j += 1) {
          const ch = body[j];
          if (ch === "(" || ch === "[" || ch === "{") inner += 1;
          else if (ch === ")" || ch === "]" || ch === "}") inner -= 1;
          if ((ch === "," && inner === 0) || j === body.length) {
            const segment = body.slice(start, j);
            const declaration = segment.match(/([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
            if (declaration) {
              const offset = kw.lastIndex + start + segment.indexOf(declaration[1]);
              const width = (segment.slice(0, segment.indexOf(declaration[1])).match(/\[[^\]]*\]/) || [""])[0];
              add(
                declaration[1],
                hit[1],
                width,
                declaration[2],
                text.slice(0, offset).split("\n").length
              );
            }
            start = j + 1;
          }
        }
        kw.lastIndex = end;
      }
    };
    Object.entries(D.files).forEach(([file, info]) => scan(file, info.code || ""));
    const needles = [...found.values()].map((item) => ({
      item,
      re: new RegExp("\\b" + escapeRegExp(item.name) + "\\b")
    }));
    Object.entries(D.files).forEach(([file, info]) => {
      (info.code || "").split("\n").forEach((line, index) => {
        needles.forEach(({ item, re }) => {
          if (file === item.file && index + 1 === item.line) return;
          if (re.test(line)) item.uses.push({ file, line: index + 1, text: line.trim() });
        });
      });
    });
    return [...found.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file)
    );
  })();

  const constFor = (name, file) =>
    constants.find((item) => item.name === name && item.file === file) || null;

  const state = {
    tab: initialTab,
    module: rootModule.name,
    focus: rootModule.name,
    signal: defaultSignal,
    constant: null,
    constantFile: null,
    edge: null,
    state: defaultFsmState,
    step: 0,
    scenario: defaultScenario,
    codeFile: defaultCodeFile,
    codeLine: defaultCodeLine,
    codeJump: defaultCodeLine,
    codeQuery: "",
    codeSearchLine: null,
    codeSearchAt: -1,
    bench: null,
    waveChannel: null,
    waveSource: null,
    inspect: { type: "module", id: rootModule.name }
  };

  const snippetUI = {
    open: false,
    signal: "",
    origin: null,
    originGroup: 0,
    groups: [],
    tab: 0,
    previewItem: null,
    previewShowTimer: null,
    previewHideTimer: null
  };
  const sourcePreviewCache = new Map();

  function applyStoredTheme() {
    let theme = "light";
    try {
      theme = localStorage.getItem("rtl-reader-theme") || "light";
    } catch (_) {}
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
    $("#themeBtn").textContent = theme === "dark" ? "浅色" : "深色";
  }

  function applyBrand() {
    const meta = D.meta || {};
    const title = meta.title || rootModule.label || rootModule.name || "RTL";
    document.title = title + " · RTL 阅读工作台";
    const logoText = String(meta.brand || title)
      .replace(/[^\p{L}\p{N}]/gu, "")
      .slice(0, 3)
      .toUpperCase() || "RTL";
    const logo = document.querySelector(".brand .logo");
    const name = document.querySelector(".brand .t1");
    const subtitle = document.querySelector(".brand .t2");
    if (logo) logo.textContent = logoText;
    if (name) name.textContent = title;
    if (subtitle) subtitle.textContent = meta.descriptor || "RTL 阅读工作台";
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    $("#themeBtn").textContent = next === "dark" ? "浅色" : "深色";
    if (window.WaveUI) WaveUI.redraw();
    try {
      localStorage.setItem("rtl-reader-theme", next);
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
    const render = (module, depth) => {
      const icon = depth === 0 ? "◆" : "▸";
      return `<button class="item${state.module === module.name ? " on" : ""}" data-module="${module.name}" style="padding-left:${6 + depth * 14}px" title="${module.name}">
        <span class="ico">${icon}</span><span class="nm">${esc(module.name)}</span>
      </button>${childrenOf(module.name).map((child) => render(child, depth + 1)).join("")}`;
    };
    return roots.map((root) => render(root, 0)).join("");
  }

  const sourceSymbolCache = new Map();
  let allSourceSymbolCache = null;
  function sourceSymbolsForFile(file) {
    if (sourceSymbolCache.has(file)) return sourceSymbolCache.get(file);
    const found = [];
    const symbols = window.SigSem ? window.SigSem.symbols(file) : new Set();
    symbols.forEach((name) => {
      const known = D.signals[name];
      if (known && known.file === file) return;
      const positions = window.SigSem
        ? window.SigSem.positions(name, { file })
        : [];
      const line = positions.length ? positions[0].line : 1;
      const owner = moduleAt(file, line);
      found.push({
        name,
        file,
        module: owner ? owner.name : "",
        line,
        kind: "source"
      });
    });
    sourceSymbolCache.set(file, found);
    return found;
  }
  function sourceSymbolIndex() {
    if (allSourceSymbolCache) return allSourceSymbolCache;
    allSourceSymbolCache = Object.keys(D.files).flatMap((file) => sourceSymbolsForFile(file));
    return allSourceSymbolCache;
  }

  function paintSidebarList(query) {
    const q = String(query || "").trim().toLowerCase();
    const signals = signalNames
      .filter((name) => !q || name.toLowerCase().includes(q) ||
        String(D.signals[name].purpose || "").toLowerCase().includes(q))
      .slice(0, 120)
      .map((name) => {
        const sig = D.signals[name];
        return `<button class="sigitem${state.constant ? "" : state.signal === name ? " on" : ""}" data-signal="${name}" title="${esc(sig.module)} · ${esc(sig.kind)}">
          <span>${esc(name)}</span><span class="d">${esc(sig.kind)}</span>
        </button>`;
      })
      .join("");
    const symbolSource = q ? sourceSymbolIndex() : sourceSymbolsForFile(state.codeFile);
    const sourceSymbols = symbolSource
      .filter((item) =>
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.file.toLowerCase().includes(q) ||
        item.module.toLowerCase().includes(q))
      .filter((item) => q || item.file === state.codeFile)
      .slice(0, q ? 100 : 24)
      .map((item) =>
        `<button class="sigitem${state.signal === item.name && state.codeFile === item.file ? " on" : ""}" data-signal="${esc(item.name)}" data-file="${esc(item.file)}" title="${esc(item.name)} · ${esc(item.file)}:${item.line} · 由源码声明自动识别">
          <span>${esc(item.name)}</span><span class="d">${esc(item.module || item.file.replace(/\.[^.]+$/, ""))}</span>
        </button>`)
      .join("");
    const consts = constants
      .filter((item) => !q || item.name.toLowerCase().includes(q) || item.note.toLowerCase().includes(q))
      .slice(0, 40)
      .map((item) => `<button class="sigitem${state.constant === item.name && state.constantFile === item.file ? " on" : ""}" data-const="${esc(item.name)}" data-file="${esc(item.file)}" title="${esc(item.module || item.file)} · ${esc(item.kind)}">
        <span>${esc(item.name)}</span><span class="d">${esc(item.kind === "parameter" ? "param" : "const")}</span>
      </button>`)
      .join("");
    $("#sigList").innerHTML =
      signals +
      (sourceSymbols ? `<div class="tiny dim2" style="padding:8px 6px 2px">源码声明</div>${sourceSymbols}` : "") +
      (consts ? `<div class="tiny dim2" style="padding:8px 6px 2px">常量</div>${consts}` : "") ||
      '<div class="tiny dim2" style="padding:7px 6px">没有匹配信号</div>';
  }

  function buildSidebar() {
    $("#modTree").innerHTML = moduleTree();
    const sourceCount = sourceSymbolsForFile(state.codeFile).length;
    $("#sigCount").textContent = constants.length || sourceCount
      ? `${signalNames.length} 映射 · ${sourceCount} 本文件自动${constants.length ? ` · ${constants.length} 常量` : ""}`
      : `${signalNames.length} 个`;
    paintSidebarList($("#sigSearch").value);
    $("#fileCount").textContent = `${Object.keys(D.files).length} 个`;
    $("#fileTree").innerHTML = Object.entries(D.files).map(([name, file]) =>
      `<button class="item${state.tab === "code" && state.codeFile === name ? " on" : ""}" data-code="${name}">
        <span class="ico">V</span><span class="nm">${esc(name)}</span><span class="cnt">${file.lines}</span>
      </button>`
    ).join("");
  }

  function modulePath(name) {
    const parts = [];
    let current = moduleByName(name);
    while (current) {
      parts.unshift(current);
      current = current.parent ? moduleByName(current.parent) : null;
    }
    return parts;
  }

  function modulePathHtml(name) {
    return modulePath(name).map((module) =>
      `<button type="button" class="crumb-link" data-focus="${module.name}">${esc(module.name)}</button>`
    ).join('<span class="crumb-sep">/</span>');
  }

  function nodeLabel(id) {
    if (D.externals[id]) return D.externals[id].label;
    const module = moduleByName(id);
    return module ? module.name : id;
  }

  function shortSignals(signals, max = 2) {
    if (!signals || !signals.length) return "";
    const shown = signals.slice(0, max).join(" · ");
    return signals.length > max ? `${shown} +${signals.length - max}` : shown;
  }

  function autoLayout(nodes, edges) {
    const nodeW = 150;
    const nodeH = 64;
    const margin = 28;
    const gapX = 54;
    const gapY = 46;
    const ids = new Set(nodes.map((node) => node.id));
    const connected = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const positions = new Map();

    if (!connected.length) {
      nodes.forEach((node, index) => {
        positions.set(node.id, {
          x: margin + (index % 3) * (nodeW + gapX),
          y: margin + Math.floor(index / 3) * (nodeH + gapY),
          w: nodeW,
          h: nodeH
        });
      });
      return positions;
    }

    const level = new Map(nodes.map((node) => [node.id, 0]));
    let changed = true;
    let guard = 0;
    while (changed && guard < nodes.length * 3) {
      changed = false;
      guard += 1;
      for (const edge of connected) {
        const next = Math.min((level.get(edge.from) || 0) + 1, 6);
        if ((level.get(edge.to) || 0) < next) {
          level.set(edge.to, next);
          changed = true;
        }
      }
    }

    const groups = new Map();
    for (const node of nodes) {
      const value = level.get(node.id) || 0;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(node);
    }
    const maxRows = Math.max(...[...groups.values()].map((group) => group.length), 1);
    const totalH = maxRows * nodeH + (maxRows - 1) * gapY;
    for (const [value, group] of groups) {
      group.forEach((node, index) => {
        positions.set(node.id, {
          x: margin + value * (nodeW + gapX),
          y: margin + (totalH - (group.length * nodeH + (group.length - 1) * gapY)) / 2 + index * (nodeH + gapY),
          w: nodeW,
          h: nodeH
        });
      });
    }
    return positions;
  }

  function scopeFor(name, focusName) {
    let current = moduleByName(name);
    let guard = 0;
    while (current && current.parent && guard < 128) {
      if (current.parent === focusName) return current.name;
      current = moduleByName(current.parent);
      guard += 1;
    }
    return null;
  }

  function visibleScope(name, focusName) {
    if (!name) return null;
    const focus = moduleByName(focusName) || rootModule;
    if (name === focus.name) return focus.parent ? name : null;
    const module = moduleByName(name);
    if (module) return scopeFor(name, focusName) || name;
    return D.externals[name] ? name : null;
  }

  function scopeHighlight(highlight, focusName) {
    if (!highlight) return highlight;
    const mapped = new Set();
    for (const name of highlight) {
      const scope = visibleScope(name, focusName);
      if (scope) mapped.add(scope);
    }
    return mapped;
  }

  function diagramNodes(focusName) {
    const focus = moduleByName(focusName) || rootModule;
    const focusHasParent = Boolean(focus.parent);
    projectedEdges.clear();
    const children = childrenOf(focus.name);
    const nodes = children.map((item) => ({
      id: item.name,
      label: item.label,
      caption: item.name,
      external: false
    }));
    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = [];

    const addExternal = (id) => {
      if (!D.externals[id] || visibleIds.has(id)) return;
      visibleIds.add(id);
      nodes.push({
        id,
        label: D.externals[id].label,
        caption: D.externals[id].caption,
        external: true
      });
    };

    const ensureBoundary = (id) => {
      if (visibleIds.has(id)) return;
      const module = moduleByName(id);
      if (!module) return;
      visibleIds.add(id);
      nodes.push({
        id,
        label: module.label || module.name,
        caption: id === focus.name ? "本模块边界" : "外部模块 · " + module.name,
        external: true,
        boundary: true,
        focusBoundary: id === focus.name
      });
    };

    const strictChildScope = (name) => Boolean(scopeFor(name, focus.name));
    const isFocus = (name) => name === focus.name && focusHasParent;
    const isRelevant = (name) => strictChildScope(name) || isFocus(name);

    for (const edge of D.edges) {
      if (!edge || !edge.from || !edge.to) continue;
      if (!isRelevant(edge.from) && !isRelevant(edge.to)) continue;
      const fromModule = moduleByName(edge.from);
      const toModule = moduleByName(edge.to);
      const fromBoundary = Boolean(fromModule) &&
        !strictChildScope(edge.from) &&
        (edge.from !== focus.name || focusHasParent);
      const toBoundary = Boolean(toModule) &&
        !strictChildScope(edge.to) &&
        (edge.to !== focus.name || focusHasParent);
      const fromScope = fromModule
        ? (scopeFor(edge.from, focus.name) || edge.from)
        : (D.externals[edge.from] ? edge.from : null);
      const toScope = toModule
        ? (scopeFor(edge.to, focus.name) || edge.to)
        : (D.externals[edge.to] ? edge.to : null);
      if (!fromScope || !toScope || fromScope === toScope) continue;
      const fromVisible = visibleIds.has(fromScope) ||
        Boolean(D.externals[fromScope]) ||
        (fromBoundary && Boolean(moduleByName(fromScope)));
      const toVisible = visibleIds.has(toScope) ||
        Boolean(D.externals[toScope]) ||
        (toBoundary && Boolean(moduleByName(toScope)));
      if (!fromVisible || !toVisible) continue;
      if (fromBoundary) ensureBoundary(fromScope);
      else addExternal(fromScope);
      if (toBoundary) ensureBoundary(toScope);
      else addExternal(toScope);
      const projected = {
        ...edge,
        from: fromScope,
        to: toScope,
        originalFrom: edge.from,
        originalTo: edge.to,
        aggregated: fromScope !== edge.from || toScope !== edge.to,
        boundary: fromBoundary || toBoundary
      };
      projectedEdges.set(edge.id, projected);
      edges.push(projected);
    }

    return { focus, nodes, edges };
  }

  function layoutFor(nodes, edges) {
    const positions = new Map();
    for (const node of nodes) {
      if (node.boundary) continue;
      if (D.layout[node.id]) positions.set(node.id, D.layout[node.id]);
    }
    const missing = nodes.filter((node) => !positions.has(node.id));
    if (missing.length) {
      const auto = autoLayout(missing, edges);
      for (const [id, position] of auto) positions.set(id, position);
    }
    return positions;
  }

  const EDGE_STUB = 14;
  const EDGE_OBSTACLE_GAP = 8;

  function clampValue(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function roundValue(value) {
    return Math.round(value * 100) / 100;
  }

  function centerOf(position) {
    return { x: position.x + position.w / 2, y: position.y + position.h / 2 };
  }

  function sideNormal(side) {
    if (side === "left") return { x: -1, y: 0 };
    if (side === "right") return { x: 1, y: 0 };
    if (side === "top") return { x: 0, y: -1 };
    return { x: 0, y: 1 };
  }

  function sidePoint(position, side, offset = 0) {
    const center = centerOf(position);
    if (side === "left" || side === "right") {
      return {
        x: side === "left" ? position.x : position.x + position.w,
        y: clampValue(center.y + offset, position.y + 10, position.y + position.h - 10)
      };
    }
    return {
      x: clampValue(center.x + offset, position.x + 10, position.x + position.w - 10),
      y: side === "top" ? position.y : position.y + position.h
    };
  }

  function oppositeSide(side) {
    return side === "left" ? "right" : side === "right" ? "left" : side === "top" ? "bottom" : "top";
  }

  function chooseEdgeSides(from, to, edge) {
    const dx = centerOf(to).x - centerOf(from).x;
    const dy = centerOf(to).y - centerOf(from).y;
    let fromSide;
    let toSide;
    if (Math.abs(dx) >= Math.abs(dy)) {
      fromSide = dx >= 0 ? "right" : "left";
      toSide = oppositeSide(fromSide);
    } else {
      fromSide = dy >= 0 ? "bottom" : "top";
      toSide = oppositeSide(fromSide);
    }
    return {
      from: (edge && edge.fromSide) || fromSide,
      to: (edge && edge.toSide) || toSide
    };
  }

  function edgeAnchorLayout(edges, positions) {
    const records = new Map();
    const groups = new Map();
    for (const edge of edges) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) continue;
      const sides = chooseEdgeSides(from, to, edge);
      const record = { edge, from, to, sides, fromOffset: 0, toOffset: 0 };
      records.set(edge, record);
      for (const role of ["from", "to"]) {
        const position = role === "from" ? from : to;
        const side = role === "from" ? sides.from : sides.to;
        const key = `${role === "from" ? edge.from : edge.to}|${side}`;
        if (!groups.has(key)) groups.set(key, { position, side, entries: [] });
        groups.get(key).entries.push({ record, role });
      }
    }
    for (const group of groups.values()) {
      const vertical = group.side === "left" || group.side === "right";
      const sideLength = vertical ? group.position.h : group.position.w;
      const usable = Math.max(0, sideLength - 24);
      const step = group.entries.length > 1
        ? Math.min(24, usable / (group.entries.length - 1))
        : 0;
      group.entries.sort((a, b) => {
        const aOther = a.role === "from" ? a.record.to : a.record.from;
        const bOther = b.role === "from" ? b.record.to : b.record.from;
        const aCenter = vertical ? centerOf(aOther).y : centerOf(aOther).x;
        const bCenter = vertical ? centerOf(bOther).y : centerOf(bOther).x;
        return aCenter - bCenter || a.record.edge.id.localeCompare(b.record.edge.id);
      });
      group.entries.forEach(({ record, role }, index) => {
        const hint = role === "from" ? record.edge.fromAnchorDx : record.edge.toAnchorDx;
        const base = Number.isFinite(Number(hint)) ? Number(hint) : 0;
        const slot = group.entries.length > 1
          ? -step * (group.entries.length - 1) / 2 + index * step
          : 0;
        const offset = clampValue(base + slot, -usable / 2, usable / 2);
        if (role === "from") record.fromOffset = offset;
        else record.toOffset = offset;
      });
    }
    return records;
  }

  function rectOf(position) {
    return { x: position.x, y: position.y, w: position.w, h: position.h };
  }

  function inflateRect(rect, gap) {
    return { x: rect.x - gap, y: rect.y - gap, w: rect.w + gap * 2, h: rect.h + gap * 2 };
  }

  function cleanRoute(points) {
    const clean = [];
    for (const point of points) {
      const normalized = { x: roundValue(point.x), y: roundValue(point.y) };
      const last = clean[clean.length - 1];
      if (!last || last.x !== normalized.x || last.y !== normalized.y) clean.push(normalized);
    }
    for (let index = 1; index < clean.length - 1;) {
      const before = clean[index - 1];
      const current = clean[index];
      const after = clean[index + 1];
      const sameX = before.x === current.x && current.x === after.x;
      const sameY = before.y === current.y && current.y === after.y;
      if (sameX || sameY) clean.splice(index, 1);
      else index += 1;
    }
    return clean;
  }

  function routePath(points) {
    return cleanRoute(points).map((point, index) =>
      `${index ? "L" : "M"} ${point.x} ${point.y}`
    ).join(" ");
  }

  function routeLength(points) {
    let length = 0;
    for (let index = 1; index < points.length; index += 1) {
      length += Math.abs(points[index].x - points[index - 1].x)
        + Math.abs(points[index].y - points[index - 1].y);
    }
    return length;
  }

  function segmentHitsRect(a, b, rect) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    const horizontal = a.y === b.y;
    const vertical = a.x === b.x;
    if (!horizontal && !vertical) return false;
    if (horizontal) {
      return a.y >= rect.y
        && a.y <= rect.y + rect.h
        && Math.max(minX, rect.x) <= Math.min(maxX, rect.x + rect.w);
    }
    return a.x >= rect.x
      && a.x <= rect.x + rect.w
      && Math.max(minY, rect.y) <= Math.min(maxY, rect.y + rect.h);
  }

  function routeClear(points, obstacles) {
    for (let index = 1; index < points.length; index += 1) {
      for (const obstacle of obstacles) {
        if (segmentHitsRect(points[index - 1], points[index], obstacle)) return false;
      }
    }
    return true;
  }

  function startsOutward(points, normal) {
    if (points.length < 2) return false;
    const dx = points[1].x - points[0].x;
    const dy = points[1].y - points[0].y;
    return dx * normal.y - dy * normal.x === 0 && dx * normal.x + dy * normal.y > 0;
  }

  function endsInward(points, targetNormal) {
    if (points.length < 2) return false;
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    const dx = last.x - before.x;
    const dy = last.y - before.y;
    return dx * targetNormal.y - dy * targetNormal.x === 0
      && dx * -targetNormal.x + dy * -targetNormal.y > 0;
  }

  function routeEdge(from, to, sides, obstacles, bounds, fromOffset = 0, toOffset = 0) {
    let start = sidePoint(from, sides.from, fromOffset);
    let end = sidePoint(to, sides.to, toOffset);
    const horizontalSides = (side) => side === "left" || side === "right";
    if (horizontalSides(sides.from) && horizontalSides(sides.to) && Math.abs(start.y - end.y) <= 3) {
      const y = (start.y + end.y) / 2;
      start = { ...start, y };
      end = { ...end, y };
    } else if (!horizontalSides(sides.from) && !horizontalSides(sides.to) && Math.abs(start.x - end.x) <= 3) {
      const x = (start.x + end.x) / 2;
      start = { ...start, x };
      end = { ...end, x };
    }
    const startNormal = sideNormal(sides.from);
    const endNormal = sideNormal(sides.to);
    const startStub = {
      x: start.x + startNormal.x * EDGE_STUB,
      y: start.y + startNormal.y * EDGE_STUB
    };
    const endStub = {
      x: end.x + endNormal.x * EDGE_STUB,
      y: end.y + endNormal.y * EDGE_STUB
    };
    const candidates = [];
    const add = (points) => candidates.push(cleanRoute(points));
    if (start.x === end.x || start.y === end.y) add([start, end]);
    add([start, startStub, { x: endStub.x, y: startStub.y }, endStub, end]);
    add([start, startStub, { x: startStub.x, y: endStub.y }, endStub, end]);

    const midX = (startStub.x + endStub.x) / 2;
    const midY = (startStub.y + endStub.y) / 2;
    add([start, startStub, { x: midX, y: startStub.y }, { x: midX, y: endStub.y }, endStub, end]);
    add([start, startStub, { x: startStub.x, y: midY }, { x: endStub.x, y: midY }, endStub, end]);

    const outer = {
      top: bounds.top - 30,
      bottom: bounds.bottom + 30,
      left: bounds.left - 30,
      right: bounds.right + 30
    };
    add([start, startStub, { x: startStub.x, y: outer.top }, { x: endStub.x, y: outer.top }, endStub, end]);
    add([start, startStub, { x: startStub.x, y: outer.bottom }, { x: endStub.x, y: outer.bottom }, endStub, end]);
    add([start, startStub, { x: outer.left, y: startStub.y }, { x: outer.left, y: endStub.y }, endStub, end]);
    add([start, startStub, { x: outer.right, y: startStub.y }, { x: outer.right, y: endStub.y }, endStub, end]);

    const clear = candidates.filter((points) =>
      startsOutward(points, startNormal)
      && endsInward(points, endNormal)
      && routeClear(points, obstacles)
    );
    const fallback = candidates.filter((points) => routeClear(points, obstacles));
    const pool = clear.length ? clear : fallback.length ? fallback : [[]];
    pool.sort((a, b) => routeLength(a) - routeLength(b) || a.length - b.length);
    const points = pool[0].length ? pool[0] : [start, end];
    return { start, end, points, d: routePath(points) };
  }

  function textWidth(value, fontSize = 10) {
    let units = 0;
    for (const char of String(value)) units += char.charCodeAt(0) > 255 ? 9.4 : 6.1;
    return units * (fontSize / 10);
  }

  function labelRectAt(x, y, width, height = 13, centered = false) {
    return {
      x: x - width / 2,
      y: centered ? y - height / 2 : y - 10,
      w: width,
      h: height
    };
  }

  function overlapArea(a, b) {
    const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return width * height;
  }

  function nearestPointOnRoute(points, x, y) {
    let nearest = null;
    for (let index = 1; index < points.length; index += 1) {
      const before = points[index - 1];
      const after = points[index];
      let px;
      let py;
      if (before.x === after.x) {
        px = before.x;
        py = clampValue(y, Math.min(before.y, after.y), Math.max(before.y, after.y));
      } else {
        px = clampValue(x, Math.min(before.x, after.x), Math.max(before.x, after.x));
        py = before.y;
      }
      const distance = Math.hypot(px - x, py - y);
      if (!nearest || distance < nearest.distance) nearest = { x: px, y: py, distance };
    }
    return nearest;
  }

  function edgeLeader(points, labelPoint, obstacles) {
    const box = labelPoint.box;
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    const nearest = nearestPointOnRoute(points, centerX, centerY);
    if (!nearest || nearest.distance < 24) return "";
    const startY = centerY < nearest.y ? box.y + box.h : box.y;
    const start = { x: centerX, y: startY };
    const elbow = Math.abs(centerX - nearest.x) > 1
      ? { x: nearest.x, y: startY }
      : start;
    const route = cleanRoute([start, elbow, nearest]);
    if (!routeClear(route, obstacles)) return "";
    return routePath(route);
  }

  function labelCandidates(points, width, height, bounds) {
    const candidates = [];
    const push = (x, y, rank = 0) => candidates.push({ x, y, rank });
    for (let index = 1; index < points.length; index += 1) {
      const before = points[index - 1];
      const after = points[index];
      if (before.y === after.y) {
        const length = Math.abs(after.x - before.x);
        if (length >= 22) {
          for (const ratio of [0.5, 0.32, 0.68, 0.2, 0.8]) {
            const x = before.x + (after.x - before.x) * ratio;
            const ratioRank = ratio === 0.5 ? 0 : Math.abs(ratio - 0.5) < 0.25 ? 1 : 2;
            push(x, before.y - 10, ratioRank);
            push(x, before.y + 17, ratioRank);
            push(x, before.y - 20, ratioRank + 1);
            push(x, before.y + 27, ratioRank + 1);
            for (let level = 0; level < 4; level += 1) {
              push(x, Math.max(12, bounds.top - 24 - level * 18), 10 + level);
            }
            for (let level = 0; level < 4; level += 1) {
              push(x, bounds.bottom + 24 + level * 18, 10 + level);
            }
          }
        }
      } else if (before.x === after.x) {
        const length = Math.abs(after.y - before.y);
        if (length >= 22) {
          for (const ratio of [0.5, 0.32, 0.68, 0.2, 0.8]) {
            const y = before.y + (after.y - before.y) * ratio;
            const ratioRank = ratio === 0.5 ? 0 : Math.abs(ratio - 0.5) < 0.25 ? 1 : 2;
            push(before.x + width / 2 + 8, y, 20 + ratioRank);
            push(before.x - width / 2 - 8, y, 20 + ratioRank);
            for (let level = 0; level < 4; level += 1) {
              push(before.x, Math.max(12, bounds.top - 24 - level * 18), 30 + level);
            }
            for (let level = 0; level < 4; level += 1) {
              push(before.x, bounds.bottom + 24 + level * 18, 30 + level);
            }
          }
        }
      }
    }
    const midX = (bounds.left + bounds.right) / 2;
    push(midX, bounds.top - 24, 40);
    push(midX, bounds.bottom + 24, 40);
    push(bounds.left - width / 2 - 20, (bounds.top + bounds.bottom) / 2, 40);
    push(bounds.right + width / 2 + 20, (bounds.top + bounds.bottom) / 2, 40);
    return candidates;
  }

  function placeEdgeLabel(points, width, nodeRects, placedLabels, bounds, height = 13, centered = false) {
    const candidates = labelCandidates(points, width, height, bounds);
    let best = null;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const box = labelRectAt(candidate.x, candidate.y, width, height, centered);
      const nodeOverlap = nodeRects.reduce((sum, node) => sum + overlapArea(box, node), 0);
      const labelOverlap = placedLabels.reduce((sum, label) => sum + overlapArea(box, label), 0);
      const score = nodeOverlap * 20 + labelOverlap * 8 + (candidate.rank || 0);
      if (score < bestScore) {
        bestScore = score;
        best = { ...candidate, box };
      }
      if (score === 0) return { ...candidate, box };
    }
    return best || { x: 0, y: 0, box: labelRectAt(0, 0, width) };
  }

  function layoutEdges(edges, positions) {
    const records = edgeAnchorLayout(edges, positions);
    const rectEntries = [...positions.entries()].map(([id, position]) => ({ id, rect: rectOf(position) }));
    const bounds = rectEntries.length
      ? rectEntries.reduce((result, item) => ({
        left: Math.min(result.left, item.rect.x),
        right: Math.max(result.right, item.rect.x + item.rect.w),
        top: Math.min(result.top, item.rect.y),
        bottom: Math.max(result.bottom, item.rect.y + item.rect.h)
      }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity })
      : { left: 0, right: 480, top: 0, bottom: 240 };
    const placedLabels = [];
    const result = new Map();
    for (const edge of edges) {
      const record = records.get(edge);
      if (!record) continue;
      const obstacles = rectEntries
        .filter((item) => item.id !== edge.from && item.id !== edge.to)
        .map((item) => inflateRect(item.rect, EDGE_OBSTACLE_GAP));
      const route = routeEdge(
        record.from,
        record.to,
        record.sides,
        obstacles,
        bounds,
        record.fromOffset,
        record.toOffset
      );
      const label = shortSignals(edge.signals, 2) || edge.label || "";
      const width = Math.max(50, textWidth(label) + 14);
      const labelPoint = placeEdgeLabel(
        route.points,
        width,
        rectEntries.map((item) => item.rect),
        placedLabels,
        bounds
      );
      placedLabels.push(labelPoint.box);
      const leaderD = edgeLeader(route.points, labelPoint, obstacles);
      result.set(edge.id, {
        ...route,
        label,
        labelWidth: width,
        labelX: labelPoint.x,
        labelY: labelPoint.y,
        leaderD
      });
    }
    return result;
  }

  function edgeSvg(edge, layout) {
    if (!layout) return "";
    const kind = edge.kind || "data";
    const wireClass = kind === "control" ? "wire dash" : kind === "error" ? "wire err" : kind === "clock" ? "wire clock" : "wire";
    const label = layout.label;
    const width = layout.labelWidth;
    const labelX = layout.labelX;
    const labelY = layout.labelY;
    const actualFrom = edge.originalFrom || edge.from;
    const actualTo = edge.originalTo || edge.to;
    const across = edge.aggregated ? "（图中聚合到可见模块）" : "";
    return `<g class="edge${state.edge === edge.id ? " sel" : ""}" data-edge="${edge.id}" data-from="${esc(actualFrom)}" data-to="${esc(actualTo)}" role="button" tabindex="0" aria-label="${esc(actualFrom)} 到 ${esc(actualTo)}${across}，${esc(label)}">
      ${layout.leaderD ? `<path class="edge-leader" d="${layout.leaderD}"></path>` : ""}
      <path class="edge-hit" d="${layout.d}"></path>
      <path class="${wireClass}" d="${layout.d}" marker-end="url(#arrow-${kind})"></path>
      <g class="edge-label" transform="translate(${labelX} ${labelY})">
        <rect x="${-width / 2}" y="-10" width="${width}" height="13" rx="2"></rect>
        <text text-anchor="middle" y="0">${esc(label)}</text>
      </g>
    </g>`;
  }

  function nodeSvg(node, position, selected, highlight) {
    const { x, y, w, h } = position;
    if (node.external) {
      const classes = `ext${selected === node.id ? " sel" : ""}${highlight && highlight.has(node.id) ? " hl" : ""}${node.boundary ? " boundary" : ""}${node.focusBoundary ? " focus-boundary" : ""}`;
      return `<g class="${classes}" data-node-id="${esc(node.id)}" transform="translate(${x} ${y})">
        <rect width="${w}" height="${h}" rx="6"></rect>
        <text x="${w / 2}" y="25" text-anchor="middle">${esc(node.label)}</text>
        <text class="sub" x="${w / 2}" y="43" text-anchor="middle">${esc(node.caption)}</text>
      </g>`;
    }
    const hasChildren = childrenOf(node.id).length > 0;
    const classes = `blk${selected === node.id ? " sel" : ""}${highlight && highlight.has(node.id) ? " hl" : ""}`;
    return `<g class="${classes}" data-module="${node.id}" data-node-id="${esc(node.id)}" data-drill="1" role="button" tabindex="0" aria-label="${esc(node.id)}，单击进入内部" transform="translate(${x} ${y})">
      <rect width="${w}" height="${h}" rx="6"></rect>
      <text x="${w / 2}" y="24" text-anchor="middle">${esc(node.label)}</text>
      <text class="sub" x="${w / 2}" y="42" text-anchor="middle">${esc(node.caption)}</text>
      <text class="pin" x="${w / 2}" y="57" text-anchor="middle">${hasChildren ? "进入内部 →" : "查看端口"}</text>
    </g>`;
  }

  function diagramSvg(selected, focusName, highlight) {
    const focus = moduleByName(focusName) || rootModule;
    if (!childrenOf(focus.name).length) return "";
    const model = diagramNodes(focus.name);
    const positions = layoutFor(model.nodes, model.edges);
    const maxX = Math.max(...[...positions.values()].map((position) => position.x + position.w), 480);
    const maxY = Math.max(...[...positions.values()].map((position) => position.y + position.h), 240);
    const width = maxX + 28;
    const height = maxY + 52;
    const layouts = layoutEdges(model.edges, positions);
    const edges = model.edges.map((edge) => edgeSvg(edge, layouts.get(edge.id))).join("");
    const selectedScope = visibleScope(selected, focus.name);
    const highlightScope = scopeHighlight(highlight, focus.name);
    const nodes = model.nodes.map((node) => nodeSvg(node, positions.get(node.id), selectedScope, highlightScope)).join("");
    const aggregated = model.edges.some((edge) => edge.aggregated);
    const boundary = model.edges.some((edge) => edge.boundary);
    const note = !model.edges.length
      ? "当前层没有跨模块连线；单击模块进入内部查看连接"
      : boundary && aggregated
        ? "单击模块进入内部；跨层/跨边界连线已标出，单击连线查看真实端点"
        : boundary
          ? "单击模块进入内部；跨边界连线已标出，单击连线查看真实端点"
          : aggregated
            ? "单击模块进入内部；单击连线查看真实端点与依据 · 跨层连线已聚合到可见模块"
            : "单击模块进入内部；单击连线查看真实信号与源码依据";
    return `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(focus.name)} 的子模块连接图">
      <defs>
        <marker id="arrow-data" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="arrow-control" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk d" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="arrow-error" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk e" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="arrow-clock" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk d" d="M0,0 L8,4 L0,8 z"></path></marker>
      </defs>
      <text class="dnote" x="16" y="${height - 14}">${note}</text>
      ${edges}
      ${nodes}
    </svg>`;
  }

  function diagramCard(title, subtitle, selected, focusName, highlight) {
    const focus = moduleByName(focusName) || rootModule;
    const meta = D.meta || {};
    return `<article class="card overview-map">
      <div class="diagram-head">
        <h3>${esc(title)} <span class="section-meta">${esc(subtitle)}</span></h3>
        ${focus.parent ? `<button type="button" class="btn sm" data-focus-back>← 返回 ${esc(moduleByName(focus.parent).name)}</button>` : ""}
      </div>
      <div class="diagram-crumb">${modulePathHtml(focus.name)}</div>
      <div class="diagram">${diagramSvg(selected, focus.name, highlight)}</div>
      <div class="legend"><span><i></i>数据</span><span><i class="d"></i>控制</span><span><i class="e"></i>错误</span>${meta.legendNote ? `<span class="legend-note">${esc(meta.legendNote)}</span>` : ""}</div>
    </article>`;
  }

  function pathButton(number, title, detail, target, signal) {
    return `<button type="button" class="path" data-go="${esc(target)}"${signal ? ` data-signal="${esc(signal)}"` : ""}>
      <span class="n">${number}</span>
      <span class="path-copy"><span class="t">${esc(title)}</span><span class="d">${esc(detail)}</span></span>
      <span class="path-arrow">→</span>
    </button>`;
  }

  function renderOverview() {
    const meta = D.meta || {};
    const headline = meta.headline || meta.subtitle || meta.title || rootModule.label || rootModule.name || "RTL 阅读";
    const lead = meta.lead || meta.note || "";
    const firstScenario = defaultScenario ? D.scenarios[defaultScenario] : null;
    const firstStep = firstScenario && firstScenario.steps && firstScenario.steps[0];
    const flowSignal = (firstStep && firstStep.signals && firstStep.signals[0]) || defaultSignal;
    const readingPath = Array.isArray(D.readingPath) && D.readingPath.length
      ? D.readingPath.slice(0, 3)
      : [
        { title: "看结构", detail: "先了解模块职责与接口", target: "structure", signal: defaultSignal },
        { title: "跟事务", detail: "再跟踪一笔真实事务", target: "dataflow", signal: flowSignal },
        { title: "读代码", detail: "定位实现与信号", target: "code", signal: defaultSignal }
      ];
    const summary = D.validation && D.validation.summary;
    const hasDiagram = childrenOf(rootModule.name).length > 0;
    $("#main").innerHTML = `
      <section class="hero">
        <h1>${esc(headline)}</h1>
        ${lead ? `<p class="lead">${esc(lead)}</p>` : ""}
      </section>
      <section aria-label="建议阅读顺序">
        <h3 class="tiny dim2" style="margin:0 0 7px">建议阅读顺序</h3>
        <div class="reading-path">
          ${readingPath.map((item, index) =>
            pathButton(
              String(index + 1).padStart(2, "0"),
              item.title || "继续阅读",
              item.detail || "",
              item.target || "overview",
              item.signal || ""
            )
          ).join("")}
        </div>
      </section>
      ${hasDiagram ? diagramCard(
        meta.diagramTitle || "结构与连接",
        "单击模块进入内部；单击连线查看真实端点与依据",
        state.module,
        rootModule.name,
        null
      ) : ""}
      ${summary ? `<div class="overview-followup">
        <span>${esc(meta.validationLabel || "验证记录")}：${summary.cases || 0} 个场景 · ${summary.checks || 0} 次断言</span>
        <button type="button" class="btn sm" data-go="verify">查看验证范围 →</button>
      </div>` : ""}
      ${meta.sourceNote ? `<details class="card fold-card">
        <summary>资料来源与边界</summary>
        <div class="fold-content"><p>${esc(meta.sourceNote)}</p></div>
      </details>` : ""}`;
  }

  function groupedPorts(module) {
    const groups = {};
    for (const port of module.ports || []) {
      const key = port.group || "other";
      if (!groups[key]) groups[key] = [];
      groups[key].push(port);
    }
    return groups;
  }

  function groupOrder(groups) {
    const order = Object.keys(D.portGroups).filter((key) => groups[key]);
    for (const key of Object.keys(groups)) {
      if (!order.includes(key)) order.push(key);
    }
    return order;
  }

  function portLine(port) {
    const signal = D.signals[port.name];
    const tag = signal ? "button" : "div";
    const attr = signal ? ` type="button" data-signal="${esc(port.name)}"` : "";
    return `<${tag} class="port-line${signal ? " clickable" : ""}"${attr}>
      <span class="port-name">${esc(port.name)}</span>
      <span class="port-dir ${esc(port.dir)}">${esc(port.dir)}</span>
      <span class="port-width">${esc(port.width)}</span>
      <span class="port-desc">${esc(port.desc)}</span>
    </${tag}>`;
  }

  function portGroupHtml(module, openFirst = false) {
    const groups = groupedPorts(module);
    const order = groupOrder(groups);
    const openKey = openFirst ? order[0] : "";
    return order.map((key) => `<details class="port-group"${openKey === key ? " open" : ""}>
      <summary>${esc(D.portGroups[key] || key)} <span>${groups[key].length} 个</span></summary>
      <div class="port-group-b">${groups[key].map(portLine).join("")}</div>
    </details>`).join("");
  }

  function portPills(module) {
    const groups = groupedPorts(module);
    return groupOrder(groups).map((key) =>
      `<span class="pill">${esc(D.portGroups[key] || key)} ${groups[key].length}</span>`
    ).join("");
  }

  function uniqueEvidence(items) {
    const byPosition = new Map();
    for (const item of items || []) {
      if (!item || !item.file) continue;
      const line = Number(item.start || item.line || 0);
      if (!line) continue;
      const key = item.file + ":" + line;
      const previous = byPosition.get(key);
      if (!previous) {
        byPosition.set(key, {
          file: item.file,
          start: line,
          end: Number(item.end || line),
          note: item.note || item.text || ""
        });
        continue;
      }
      if (!previous.note && (item.note || item.text)) previous.note = item.note || item.text;
      previous.end = Math.max(previous.end, Number(item.end || line));
    }
    return [...byPosition.values()].sort(
      (left, right) =>
        Object.keys(D.files).indexOf(left.file) - Object.keys(D.files).indexOf(right.file) ||
        left.start - right.start
    );
  }

  function evidenceHtml(items) {
    const evidence = uniqueEvidence(items);
    if (!evidence.length) return "";
    return evidence.map((item) => {
      const range = item.end && item.end !== item.start ? `${item.start}–${item.end}` : `${item.start}`;
      return `<div class="sem-ev-row">
        <button type="button" class="sem-ev" data-code="${esc(item.file)}" data-line="${item.start}">
          <span class="sem-ev-l">L${range}</span>
          <span class="mono">${esc(item.file)}</span>
          <span class="dim2">${esc(item.note || "")}</span>
        </button>
        <button type="button" class="btn sm sem-copy" data-copy-file="${esc(item.file)}" data-copy-line="${item.start}" title="复制文件和行号" aria-label="复制 ${esc(item.file)}:${item.start}">复制</button>
      </div>`;
    }).join("");
  }

  function unitsHtml(module) {
    if (!module.units || !module.units.length) return "";
    return `<div class="i-sec"><h5>内部单元</h5><div class="unit-list">${module.units.map((unit) =>
      `<button type="button" class="unit-row" data-code="${esc(unit.file)}" data-line="${unit.start}">
        <span class="unit-name">${esc(unit.name)}</span>
        <span class="unit-kind">${esc(unit.kind)}</span>
        <span class="unit-desc">${esc(unit.desc)}</span>
      </button>`
    ).join("")}</div></div>`;
  }

  function storageHtml(module) {
    if (!module.storage || !module.storage.length) return "";
    return `<div class="i-sec"><h5>存储资源</h5><div class="storage-list">${module.storage.map((item) =>
      `<article class="storage-item">
        <div class="storage-head"><b>${esc(item.name)}</b><span class="pill">${esc(item.kind)}</span></div>
        <div class="sem-meta">${esc(item.width)} · ${esc(item.depth)}</div>
        <dl class="storage-kv">
          <dt>写</dt><dd class="mono">${esc(item.write)}</dd>
          <dt>读</dt><dd class="mono">${esc(item.read)}</dd>
          <dt>数据</dt><dd class="mono">${esc(item.source)} → ${esc(item.sink)}</dd>
        </dl>
        <p class="small muted">${esc(item.note)}</p>
        ${evidenceHtml(item.evidence || [])}
      </article>`
    ).join("")}</div></div>`;
  }

  function internalNodeFor(moduleName, id) {
    const module = moduleByName(moduleName);
    return module && module.internal
      ? (module.internal.nodes || []).find((node) => node.id === id)
      : null;
  }

  function internalNodeLabel(moduleName, id) {
    const node = internalNodeFor(moduleName, id);
    return node ? node.label : id;
  }

  function internalShape(node, width, height) {
    const shape = node.shape || "unit";
    if (shape === "junction") {
      const radius = Math.min(width, height) / 2;
      return `<circle cx="${width / 2}" cy="${height / 2}" r="${radius}"/>`;
    }
    if (shape === "mux") {
      return `<polygon points="14,0 ${width},0 ${width - 14},${height} 0,${height}"/>`;
    }
    if (shape === "decode") {
      return `<polygon points="9,0 ${width},0 ${width},${height - 9} ${width - 9},${height} 0,${height} 0,9"/>`;
    }
    return `<rect width="${width}" height="${height}" rx="${shape === "fsm" ? 14 : 6}"/>`;
  }

  function internalNodeSvg(node) {
    const width = node.w || 148;
    const height = node.h || 54;
    const signal = node.signal && D.signals[node.signal] ? D.signals[node.signal] : null;
    const code = node.code || (signal ? { file: signal.file, line: signal.line } : null);
    const action = signal
      ? ` data-signal="${esc(node.signal)}" role="button" tabindex="0"`
      : "";
    const classes = `inode ${esc(node.shape || "unit")}${action ? " clickable" : ""}`;
    const labelY = height / 2 + (node.sub ? -3 : 5);
    const tags = {
      fsm: "FSM",
      mem: "MEM",
      mux: "MUX",
      counter: "CNT",
      decode: "DEC",
      reg: "REG",
      port: "IO"
    };
    const tag = tags[node.shape] || "";
    return `<g class="${classes}" data-node-id="${esc(node.id)}"${action} transform="translate(${node.x} ${node.y})">
      <title>${esc(node.tip || node.label)}${code ? ` · L${code.line}` : ""}</title>
      ${internalShape(node, width, height)}
      ${node.shape === "mem" ? `<path class="ibank" d="M10,9 H${width - 10} M10,14 H${width - 10}"/>` : ""}
      ${tag ? `<text class="itag" x="${width - 8}" y="12" text-anchor="end">${tag}</text>` : ""}
      <text class="it" x="${width / 2}" y="${labelY}" text-anchor="middle">${esc(node.label)}</text>
      ${node.sub ? `<text class="is" x="${width / 2}" y="${height / 2 + 13}" text-anchor="middle">${esc(node.sub)}</text>` : ""}
      ${node.shape === "counter" ? `<text class="iplus" x="9" y="${height - 7}">+1</text>` : ""}
    </g>${code ? `<text class="ijump" data-code="${esc(code.file)}" data-line="${code.line}" role="button" tabindex="0" x="${node.x + 8}" y="${node.y + 12}">L${code.line}</text>` : ""}`;
  }

  function internalEdgeSvg(edge, layout, moduleName) {
    if (!layout) return "";
    const id = `${moduleName}::${edge.id}`;
    const kind = edge.kind || "data";
    const wireClass = kind === "control"
      ? "wire dash"
      : kind === "error"
        ? "wire err"
        : kind === "clock"
          ? "wire clock"
          : "wire";
    const label = layout.label;
    const width = layout.labelWidth;
    const labelX = layout.labelX;
    const labelY = layout.labelY;
    return `<g class="edge${state.edge === id ? " sel" : ""}" data-edge="${esc(id)}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}" role="button" tabindex="0" aria-label="${esc(internalNodeLabel(moduleName, edge.from))} 到 ${esc(internalNodeLabel(moduleName, edge.to))}，${esc(label)}">
      ${layout.leaderD ? `<path class="edge-leader" d="${layout.leaderD}"></path>` : ""}
      <path class="edge-hit" d="${layout.d}"></path>
      <path class="${wireClass}" d="${layout.d}" marker-end="url(#int-arrow-${kind})"></path>
      <g class="edge-label" transform="translate(${labelX} ${labelY})">
        <rect x="${-width / 2}" y="-10" width="${width}" height="13" rx="2"></rect>
        <text text-anchor="middle" y="0">${esc(label)}</text>
      </g>
    </g>`;
  }

  function internalDiagramSvg(module) {
    if (!module.internal) {
      return `<div class="note">该模块没有可展开的内部数据通路；请看接口分组、内部单元与源码入口，不为凑图生成单元。</div>`;
    }
    const model = module.internal;
    const width = 960;
    const height = model.height || 320;
    const positions = new Map((model.nodes || []).map((node) => [
      node.id,
      { x: node.x, y: node.y, w: node.w || 148, h: node.h || 54 }
    ]));
    const bands = (model.bands || []).map((band) =>
      `<rect class="iband" x="16" y="${band.y}" width="928" height="${band.h}" rx="10"/>
      <text class="iband-t" x="30" y="${band.y + 18}">${esc(band.title)}</text>`
    ).join("");
    const layouts = layoutEdges(model.edges || [], positions);
    const edges = (model.edges || []).map((edge) =>
      internalEdgeSvg(edge, layouts.get(edge.id), module.name)
    ).join("");
    const nodes = (model.nodes || []).map(internalNodeSvg).join("");
    return `<svg class="internal" viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(module.name)} 内部数据通路">
      <defs>
        <marker id="int-arrow-data" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="int-arrow-control" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk d" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="int-arrow-error" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk e" d="M0,0 L8,4 L0,8 z"></path></marker>
        <marker id="int-arrow-clock" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path class="mk d" d="M0,0 L8,4 L0,8 z"></path></marker>
      </defs>
      ${bands}
      ${edges}
      ${nodes}
      <text class="dnote" x="20" y="${height - 12}">${esc(model.note || "内部连线来自实例端口映射或赋值关系。")}</text>
    </svg>`;
  }

  function detailHead(module) {
    return `<div class="diagram-head">
      <h3>${esc(module.name)} <span class="section-meta">${esc(module.label)}</span></h3>
      ${module.parent ? `<button type="button" class="btn sm" data-focus-back>← 返回 ${esc(moduleByName(module.parent).name)}</button>` : ""}
    </div>
    <div class="diagram-crumb">${modulePathHtml(module.name)}</div>`;
  }

  function moduleRoleCard(module) {
    return `<article class="card role-card">
      <div class="role-kicker">模块职责</div>
      <p class="role-statement">${esc(module.role)}</p>
    </article>`;
  }

  function moduleDetailHtml(module) {
    return `<article class="card module-detail">
      ${detailHead(module)}
      <div class="note">${esc(module.note)}</div>
      <div class="i-sec"><h5>内部数据通路</h5>
        <div class="diagram internal-diagram">${internalDiagramSvg(module)}</div>
        <div class="legend"><span><i></i>数据</span><span><i class="d"></i>控制/状态</span><span><i class="e"></i>错误</span><span class="legend-note">节点可点信号，L 行号可回源码</span></div>
      </div>
      <div class="i-sec"><h5>接口分组</h5>${portGroupHtml(module, true)}</div>
      ${unitsHtml(module)}
      ${storageHtml(module)}
      <div class="i-actions">
        <button type="button" class="btn sm" data-code="${esc(module.file)}" data-line="${module.start}">定位源码 →</button>
        ${module.parent ? `<button type="button" class="btn sm" data-focus="${esc(module.parent)}">回到 ${esc(module.parent)}</button>` : ""}
      </div>
    </article>`;
  }

  function renderStructure() {
    const focus = moduleByName(state.focus) || rootModule;
    const children = childrenOf(focus.name);
    const head = `<div class="page-h">
      <div><div class="ttl">模块结构</div><div class="sub">先看职责与接口，再进入具体信号。</div></div>
      <span class="chip">${D.modules.length} 个模块${D.meta.moduleBadge ? ` · ${esc(D.meta.moduleBadge)}` : ""}</span>
    </div>`;
    if (!children.length) {
      $("#main").innerHTML = `${head}${moduleRoleCard(focus)}${moduleDetailHtml(focus)}`;
      return;
    }
    const rows = children.map((item) =>
      `<tr><td class="mono">${esc(item.name)}</td><td>${esc(item.label)}</td><td>${esc(item.role)}</td></tr>`
    ).join("");
    $("#main").innerHTML = `${head}
      ${moduleRoleCard(focus)}
      ${diagramCard(D.meta.structureTitle || "模块与连接关系", "单击模块进入内部；单击连线查看真实端点与依据", state.module, focus.name, null)}
      <details class="card fold-card" style="margin-top:12px">
        <summary>子模块职责 <span class="section-meta">${children.length} 个</span></summary>
      <div class="fold-content"><table class="t"><thead><tr><th>模块</th><th>标签</th><th>职责</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>`;
  }

  function currentStep() {
    const scenario = D.scenarios[state.scenario] || D.scenarios[Object.keys(D.scenarios)[0]];
    if (!scenario || !scenario.steps || !scenario.steps.length) return null;
    return scenario.steps[state.step] || scenario.steps[0];
  }

  function pipelineNodes() {
    const scenario = D.scenarios[state.scenario];
    if (!scenario || !scenario.steps) return "";
    return scenario.steps.map((step, index) =>
      `${index ? '<span class="parrow">→</span>' : ""}<button type="button" class="pnode${state.step === index ? " on" : ""}" data-step="${index}">
        <div class="ph">${esc(step.phase || "—")}</div><div class="pt">${esc(step.condition || "—")}</div><div class="pd">${esc(step.action || "—")}</div>
      </button>`
    ).join("");
  }

  function moduleChips(names) {
    return (names || []).map((name) => {
      const module = moduleByName(name);
      return module ? `<button type="button" class="sem-chip" data-module="${name}">${esc(name)}</button>` : "";
    }).join("");
  }

  function signalChips(names) {
    return (names || []).map((name) => D.signals[name]
      ? `<button type="button" class="sem-chip" data-signal="${name}">${esc(name)}</button>`
      : `<span class="sem-chip plain">${esc(name)}</span>`
    ).join("");
  }

  function edgeChip(id) {
    const edge = edgeById(id);
    return edge ? `<button type="button" class="sem-chip" data-edge-select="${id}">${esc(edge.label)}</button>` : "";
  }

  function renderDataflow() {
    const entries = Object.entries(D.scenarios);
    if (!entries.length) {
      $("#main").innerHTML = `
        <div class="page-h"><div><div class="ttl">数据流</div><div class="sub">从入口到出口跟踪一笔真实事务。</div></div><span class="chip">无事务数据</span></div>
        <article class="card"><h3>当前快照没有可追溯的事务步骤</h3><p class="small muted">补充场景、步骤和源码依据后，本页再展示路径；不生成示例流程。</p></article>`;
      return;
    }
    const scenarioKey = D.scenarios[state.scenario] ? state.scenario : entries[0][0];
    const scenario = D.scenarios[scenarioKey];
    const steps = scenario.steps || [];
    if (state.scenario !== scenarioKey) state.scenario = scenarioKey;
    if (state.step >= steps.length) state.step = 0;
    const step = currentStep() || { modules: [], signals: [], edge: null, code: null };
    const stepCode = step.code && step.code.file
      ? `<button type="button" class="btn sm" data-code="${esc(step.code.file)}" data-line="${Number(step.code.line) || 1}">定位源码 →</button>`
      : "";
    const stepTable = steps.length
      ? `<details class="card fold-card" style="margin-top:12px">
        <summary>步骤条件汇总 <span class="section-meta">${steps.length} 条</span></summary>
        <div class="fold-content"><table class="t"><thead><tr><th>阶段</th><th>条件</th><th>动作</th></tr></thead><tbody>
          ${steps.map((item) => `<tr><td>${esc(item.phase || "—")}</td><td class="mono">${esc(item.condition || "—")}</td><td>${esc(item.action || "—")}</td></tr>`).join("")}
        </tbody></table></div>
      </details>`
      : "";
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">数据流</div><div class="sub">一笔事务在两个握手之间怎样推进。</div></div><span class="chip">${esc(scenario.title || scenarioKey)}</span></div>
      <article class="card">
        <div class="row" style="margin-bottom:10px">
          ${entries.map(([key, value]) => `<button type="button" class="btn sm${state.scenario === key ? " on" : ""}" data-scenario="${key}">${esc(value.title || key)}</button>`).join("")}
        </div>
        <div class="pipe">${pipelineNodes()}</div>
        ${scenario.note ? `<div class="note">${esc(scenario.note)}</div>` : ""}
      </article>
      <article class="card step-map" style="margin-top:12px">
        <h3>高亮路径 <span class="section-meta">当前步骤涉及的模块</span></h3>
        <div class="diagram">${diagramSvg(null, rootModule.name, new Set(step.modules || []))}</div>
      </article>
      <article class="card step-card" style="margin-top:12px">
        <div class="step-head"><h3>本步引用</h3><span class="chip">步骤 ${state.step + 1}/${steps.length}</span></div>
        <div class="step-grid">
          <div><h5>涉及模块</h5><div class="row">${moduleChips(step.modules || [])}</div></div>
          <div><h5>关键信号</h5><div class="row">${signalChips(step.signals || [])}</div></div>
          <div><h5>对应连线</h5><div class="row">${edgeChip(step.edge)}</div></div>
        </div>
        <div class="i-actions">
          ${stepCode}
          ${step.edge ? `<button type="button" class="btn sm" data-edge-select="${step.edge}">查看连线依据</button>` : ""}
        </div>
      </article>
      ${stepTable}`;
  }

  const FSM_NORMAL = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

  function fsmAnchor(node, side, offset) {
    const shift = Number(offset) || 0;
    if (side === "l") return { x: node.x, y: node.y + node.h / 2 + shift };
    if (side === "r") return { x: node.x + node.w, y: node.y + node.h / 2 + shift };
    if (side === "t") return { x: node.x + node.w / 2 + shift, y: node.y };
    return { x: node.x + node.w / 2 + shift, y: node.y + node.h };
  }

  function fsmShift(point, side, distance) {
    const normal = FSM_NORMAL[side] || FSM_NORMAL.r;
    return { x: point.x + normal[0] * distance, y: point.y + normal[1] * distance };
  }

  function fsmSides(from, to) {
    const dx = to.x + to.w / 2 - (from.x + from.w / 2);
    const dy = to.y + to.h / 2 - (from.y + from.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["r", "l"] : ["l", "r"];
    return dy >= 0 ? ["b", "t"] : ["t", "b"];
  }

  function fsmRoute(edge, from, to, obstacles, bounds) {
    const fromSide = edge.fromSide || edge.sides[0];
    const toSide = edge.toSide || edge.sides[1];
    const start = fsmAnchor(from, fromSide, edge.fromOffset);
    const end = fsmAnchor(to, toSide, edge.toOffset);
    const stub = 16;
    const startStub = fsmShift(start, fromSide, stub);
    const endStub = fsmShift(end, toSide, stub);
    const fromHorizontal = fromSide === "l" || fromSide === "r";
    const toHorizontal = toSide === "l" || toSide === "r";
    const candidates = [];
    const add = (points, lane) => candidates.push({ points: cleanRoute(points), lane: lane || "" });
    if (start.x === end.x || start.y === end.y) add([start, end], "direct");
    add([start, startStub, { x: endStub.x, y: startStub.y }, endStub, end], "elbow-y");
    add([start, startStub, { x: startStub.x, y: endStub.y }, endStub, end], "elbow-x");
    if (fromHorizontal && toHorizontal) {
      if (Math.abs(startStub.y - endStub.y) > 0.5) {
        const middleX = (startStub.x + endStub.x) / 2;
        add([start, startStub, { x: middleX, y: startStub.y }, { x: middleX, y: endStub.y }, endStub, end], "middle");
      }
    } else if (!fromHorizontal && !toHorizontal) {
      if (Math.abs(startStub.x - endStub.x) > 0.5) {
        const middleY = (startStub.y + endStub.y) / 2;
        add([start, startStub, { x: startStub.x, y: middleY }, { x: endStub.x, y: middleY }, endStub, end], "middle");
      }
    } else if (fromHorizontal) {
      add([start, startStub, { x: endStub.x, y: startStub.y }, endStub, end], "elbow-y");
    } else {
      add([start, startStub, { x: startStub.x, y: endStub.y }, endStub, end], "elbow-x");
    }
    const outerTop = bounds.top - 34;
    const outerBottom = bounds.bottom + 34;
    const outerLeft = bounds.left - 34;
    const outerRight = bounds.right + 34;
    add([start, startStub, { x: startStub.x, y: outerTop }, { x: endStub.x, y: outerTop }, endStub, end], "top");
    add([start, startStub, { x: startStub.x, y: outerBottom }, { x: endStub.x, y: outerBottom }, endStub, end], "bottom");
    add([start, startStub, { x: outerLeft, y: startStub.y }, { x: outerLeft, y: endStub.y }, endStub, end], "left");
    add([start, startStub, { x: outerRight, y: startStub.y }, { x: outerRight, y: endStub.y }, endStub, end], "right");
    const clear = candidates.filter((candidate) => routeClear(candidate.points, obstacles));
    const pool = clear.length ? clear : candidates;
    const preferred = edge.transition.routeSide;
    pool.sort((left, right) => {
      const leftPreferred = preferred && left.lane === preferred ? 1 : 0;
      const rightPreferred = preferred && right.lane === preferred ? 1 : 0;
      return rightPreferred - leftPreferred
        || routeLength(left.points) - routeLength(right.points)
        || left.points.length - right.points.length;
    });
    return pool[0].points;
  }

  function fsmSelfRouteSide(node, side) {
    const gap = 42;
    if (side === "r") {
      const start = { x: node.x + node.w, y: node.y + node.h * 0.32 };
      const end = { x: node.x + node.w, y: node.y + node.h * 0.68 };
      return [start, { x: start.x + gap, y: start.y }, { x: end.x + gap, y: end.y }, end];
    }
    if (side === "b") {
      const start = { x: node.x + node.w * 0.32, y: node.y + node.h };
      const end = { x: node.x + node.w * 0.68, y: node.y + node.h };
      return [start, { x: start.x, y: start.y + gap }, { x: end.x, y: end.y + gap }, end];
    }
    if (side === "l") {
      const start = { x: node.x, y: node.y + node.h * 0.32 };
      const end = { x: node.x, y: node.y + node.h * 0.68 };
      return [start, { x: start.x - gap, y: start.y }, { x: end.x - gap, y: end.y }, end];
    }
    const start = { x: node.x + node.w * 0.32, y: node.y };
    const end = { x: node.x + node.w * 0.68, y: node.y };
    return [start, { x: start.x, y: start.y - gap }, { x: end.x, y: end.y - gap }, end];
  }

  function fsmSelfRoute(node, edge, obstacles) {
    const preferred = edge.selfSide || "t";
    const sides = [preferred, "t", "r", "b", "l"].filter(
      (side, index, all) => all.indexOf(side) === index
    );
    for (const side of sides) {
      const points = fsmSelfRouteSide(node, side);
      if (!obstacles || routeClear(points, obstacles)) return points;
    }
    return fsmSelfRouteSide(node, preferred);
  }

  function fsmSvg() {
    const fsm = D.fsm;
    if (!fsm) return "";
    const stateWidth = 136;
    const stateHeight = 48;
    const nodes = fsm.states.map((item) => ({
      ...item,
      w: Number(item.w) || stateWidth,
      h: Number(item.h) || stateHeight
    }));
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const edges = fsm.transitions.map((transition, index) => {
      const from = byId.get(transition.from);
      const to = byId.get(transition.to);
      return {
        id: "fsm-edge-" + index,
        transition,
        from,
        to,
        sides: from && to ? fsmSides(from, to) : ["r", "l"],
        type: transition.kind === "err" ? "err" : transition.kind === "warn" ? "warn" : "data",
        label: transition.short || transition.condition || ""
      };
    }).filter((edge) => edge.from && edge.to);

    const groups = new Map();
    for (const edge of edges) {
      for (const role of ["from", "to"]) {
        const node = edge[role];
        const side = edge.sides[role === "from" ? 0 : 1];
        const key = node.id + "|" + side;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ edge, role });
      }
    }
    for (const entries of groups.values()) {
      entries.forEach((entry, index) => {
        const offset = entries.length > 1 ? (index - (entries.length - 1) / 2) * 10 : 0;
        if (entry.role === "from") entry.edge.fromOffset = offset;
        else entry.edge.toOffset = offset;
      });
    }
    for (const edge of edges) {
      const fromEntries = groups.get(edge.from.id + "|" + edge.sides[0]);
      const toEntries = groups.get(edge.to.id + "|" + edge.sides[1]);
      if (!fromEntries || !toEntries) continue;
      if (fromEntries.length === 1 && toEntries.length > 1) {
        edge.fromOffset = edge.toOffset;
      } else if (toEntries.length === 1 && fromEntries.length > 1) {
        edge.toOffset = edge.fromOffset;
      }
    }

    const nodeRects = nodes.map((node) => ({
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h
    }));
    const bounds = nodeRects.reduce(
      (result, rect) => ({
        left: Math.min(result.left, rect.x),
        right: Math.max(result.right, rect.x + rect.w),
        top: Math.min(result.top, rect.y),
        bottom: Math.max(result.bottom, rect.y + rect.h)
      }),
      { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
    );
    const placedLabels = [];
    const routes = [];
    const paths = edges.map((edge) => {
      const obstacles = nodes
        .filter((node) => node.id !== edge.from.id && node.id !== edge.to.id)
        .map((node) => inflateRect({ x: node.x, y: node.y, w: node.w, h: node.h }, 4));
      const points = edge.from === edge.to
        ? fsmSelfRoute(edge.from, edge, obstacles)
        : fsmRoute(edge, edge.from, edge.to, obstacles, bounds);
      const width = Math.max(54, textWidth(edge.label, 11.5) + 16);
      const labelPoint = placeEdgeLabel(points, width, nodeRects, placedLabels, bounds, 22, true);
      placedLabels.push(labelPoint.box);
      const leader = edgeLeader(points, labelPoint, nodeRects);
      routes.push({ edge, points, labelPoint, width, leader });
      return `<path class="tr ${edge.type}" d="${routePath(points)}" marker-end="url(#fsm-arrow-${edge.type})"/>`;
    }).join("");
    const labels = routes.map(({ edge, points, labelPoint, width, leader }) => {
      const x = labelPoint.x - width / 2;
      const y = labelPoint.y - 11;
      return `${leader ? `<path class="tr-leader ${edge.type}" d="${leader}"/>` : ""}
        <g class="tr-label ${edge.type}">
          <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width.toFixed(1)}" height="22" rx="4"/>
          <text x="${labelPoint.x.toFixed(1)}" y="${labelPoint.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle">${esc(edge.label)}</text>
        </g>`;
    }).join("");
    const states = nodes.map((item) =>
      `<g class="st${state.state === item.id ? " sel" : ""}" data-state="${item.id}" role="button" tabindex="0" transform="translate(${item.x} ${item.y})">
        <rect width="${item.w}" height="${item.h}" rx="7"></rect>
        <text x="${item.w / 2}" y="${item.h / 2}" text-anchor="middle" dominant-baseline="middle">${esc(item.label)}</text>
      </g>`
    ).join("");
    const labelsBounds = placedLabels.reduce(
      (result, box) => ({
        left: Math.min(result.left, box.x),
        right: Math.max(result.right, box.x + box.w),
        top: Math.min(result.top, box.y),
        bottom: Math.max(result.bottom, box.y + box.h)
      }),
      bounds
    );
    const padding = 24;
    const minX = Math.min(0, labelsBounds.left - padding);
    const minY = Math.min(0, labelsBounds.top - padding);
    const noteX = minX + padding;
    const noteY = Math.max(labelsBounds.bottom, bounds.bottom) + 30;
    const noteWidth = textWidth(fsm.note || "", 11.5);
    const width = Math.max(labelsBounds.right, bounds.right, noteX + noteWidth) - minX + padding;
    const height = noteY + 18 - minY;
    const markers = ["data", "warn", "err"].map((type) =>
      `<marker id="fsm-arrow-${type}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
        <path class="marker ${type}" d="M0,0 L7,4 L0,8 z"></path>
      </marker>`
    ).join("");
    return `<svg viewBox="${minX} ${minY} ${width} ${height}" role="group" aria-label="${esc(fsm.name)} 状态机">
      <defs>${markers}</defs>
      ${paths}
      ${labels}
      ${states}
      <text class="dnote" x="${noteX}" y="${noteY}">${esc(fsm.note)}</text>
    </svg>`;
  }

  function renderControl() {
    const scenarioCards = Object.entries(D.scenarios).slice(0, 9).map(([key, scenario]) =>
      `<article class="card">
        <h3>${esc(scenario.title || key)}</h3>
        <p class="small muted">${esc(scenario.note || "查看该场景的条件与步骤。")}</p>
        <button type="button" class="btn sm" data-go="dataflow" data-scenario="${esc(key)}">查看步骤 →</button>
      </article>`
    ).join("");
    const fsm = D.fsm;
    const fsmCard = fsm
      ? `<article class="card" style="margin-top:12px">
          <h3>${esc(fsm.name || "状态机")} <span class="section-meta">${esc(fsm.file || "")}</span></h3>
          <div class="fsm-wrap">${fsmSvg()}</div>
          <p class="small muted" style="margin:8px 0 0">单击状态查看转移条件；分支与备注按源码标注。</p>
        </article>`
      : "";
    const transitions = fsm && Array.isArray(fsm.transitions) ? fsm.transitions : [];
    const transitionRows = transitions.map((transition) =>
      `<tr><td class="mono">${esc(transition.from || "—")}</td><td class="mono">${esc(transition.condition || "—")}</td><td class="mono">${esc(transition.to || "—")}</td><td>${esc(transition.note || transition.kind || "")}</td></tr>`
    ).join("");
    const transitionCard = transitionRows
      ? `<article class="card" style="margin-top:12px">
          <h3>状态与转移</h3>
          <table class="t"><thead><tr><th>从</th><th>条件</th><th>到</th><th>备注</th></tr></thead><tbody>${transitionRows}</tbody></table>
        </article>`
      : "";
    const empty = !scenarioCards && !fsmCard && !transitionCard
      ? `<div class="note amber" style="margin-top:12px">当前快照没有可追溯的控制流数据；本页不生成示例状态或优先级。</div>`
      : "";
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">控制流</div><div class="sub">有效、许可与完成条件怎样推进状态。</div></div></div>
      ${scenarioCards ? `<div class="grid g3">${scenarioCards}</div>` : ""}
      ${fsmCard}
      ${transitionCard}
      ${empty}`;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightCode(line, declaredSymbols, options) {
    const opts = options || {};
    const file = opts.file || state.codeFile;
    const interactive = opts.interactive !== false;
    const highlighted = new Set(
      (Array.isArray(opts.highlightSignals) ? opts.highlightSignals : [opts.highlightSignal])
        .filter(Boolean)
    );
    const decorate = (word, html) =>
      highlighted.has(word) ? `<mark class="snippet-hit">${html}</mark>` : html;
    const tokenPattern = new RegExp(
      "(\\/\\/[^\\n]*)|(\\b(?:module|endmodule|input|output|wire|reg|assign|always|posedge|negedge|begin|end|if|else|case|endcase|default|parameter|localparam)\\b)|(\\b[A-Za-z_]\\w*\\b)|(\\b\\d+(?:'[bhd])?[0-9a-fA-F_xXzZ]*\\b)",
      "g"
    );
    let result = "";
    let last = 0;
    let match;
    while ((match = tokenPattern.exec(line)) !== null) {
      result += esc(line.slice(last, match.index));
      if (match[1]) result += `<span class="tk-com">${esc(match[0])}</span>`;
      else if (match[2]) result += `<span class="tk-kw">${esc(match[0])}</span>`;
      else if (match[3]) {
        const word = match[0];
        if (D.signals[word] || (declaredSymbols && declaredSymbols.has(word))) {
          const auto = D.signals[word] ? "" : " auto";
          const selected = state.signal === word ? " selh" : "";
          const attrs = interactive
            ? ` role="button" tabindex="0" data-signal="${esc(word)}" data-file="${esc(file)}"${auto ? ' title="由源码声明自动识别"' : ""}`
            : "";
          result += `<span class="tk-id sig${auto}${selected}"${attrs}>${decorate(word, esc(word))}</span>`;
        } else if (constFor(word, file)) {
          const attrs = interactive
            ? ` role="button" tabindex="0" data-const="${esc(word)}" data-file="${esc(file)}"`
            : "";
          result += `<span class="tk-id const"${attrs}>${decorate(word, esc(word))}</span>`;
        } else {
          result += decorate(word, esc(word));
        }
      }
      else result += `<span class="tk-num">${esc(match[0])}</span>`;
      last = match.index + match[0].length;
    }
    return result + esc(line.slice(last));
  }

  const signalPositionCache = new Map();
  function collectSignalPositions(name, file) {
    if (!name) return [];
    const cacheKey = name + "|" + (file || "*");
    if (signalPositionCache.has(cacheKey)) return signalPositionCache.get(cacheKey);
    const positions = window.SigSem
      ? window.SigSem.positions(name, file ? { file } : undefined)
      : Object.entries(D.files)
        .filter(([candidate]) => !file || candidate === file)
        .flatMap(([file, info]) =>
          String(info.code || "")
            .split("\n")
            .map((line, index) => ({ file, line: index + 1, text: line }))
        )
        .filter((item) => new RegExp("\\b" + escapeRegExp(name) + "\\b").test(item.text))
        .map(({ file, line }) => ({ file, line }));
    signalPositionCache.set(cacheKey, positions);
    return positions;
  }

  function signalPositions(name, file = state.codeFile) {
    return collectSignalPositions(name, file);
  }

  function allSignalPositions(name) {
    return collectSignalPositions(name, "");
  }

  function signalNavHtml() {
    const name = state.signal;
    const positions = name ? signalPositions(name, state.codeFile) : [];
    const allPositions = name ? allSignalPositions(name) : [];
    const index = positions.findIndex(
      (item) => item.file === state.codeFile && item.line === Number(state.codeLine)
    );
    const count = positions.length
      ? (index >= 0 ? index + 1 : "–") + "/" + positions.length
      : "0/0";
    const location = index >= 0
      ? positions[index].file + ":" + positions[index].line
      : name ? (positions.length ? "本文件 " + positions.length + " 处" : "本文件无匹配") : "点击代码中的信号";
    return `<div class="sig-nav${name ? "" : " is-empty"}" id="sigNav" aria-label="信号位置导航">
      <span class="sig-nav-name mono" id="sigNavName" title="${esc(name || "未选择信号")}">${esc(name || "未选择信号")}</span>
      <span class="sig-nav-scope">本文件</span>
      <button class="btn sm sig-nav-btn" id="sigPrevBtn" title="在本文件跳到上一处出现位置"${positions.length > 1 ? "" : " disabled"}>上一处</button>
      <span class="sig-nav-count mono" id="sigNavCount" aria-live="polite">${count}</span>
      <button class="btn sm sig-nav-btn" id="sigNextBtn" title="在本文件跳到下一处出现位置"${positions.length > 1 ? "" : " disabled"}>下一处</button>
      <button class="btn sm sig-nav-btn" id="sigCopyBtn" title="复制当前位置"${name && state.codeFile && state.codeLine ? "" : " disabled"}>复制位置</button>
      <button class="btn sm sig-nav-btn" id="sigSnippetBtn"${allPositions.length ? "" : " disabled"}>相关片段 ${allPositions.length}</button>
      <span class="sig-nav-at" id="sigNavAt" aria-live="polite">${esc(location)}</span>
    </div>`;
  }

  function centerCodeLine(line) {
    requestAnimationFrame(() => {
      const scroller = $("#codeBody");
      const target = scroller && scroller.querySelector(`.cl[data-line="${line}"]`);
      if (!scroller || !target) return;
      const scrollerRect = scroller.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const delta = targetRect.top - scrollerRect.top
        - (scroller.clientHeight - targetRect.height) / 2;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    });
  }

  function copyText(text) {
    const value = String(text || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(
        () => setHint("已复制 · " + (value.split("\n")[0] || "")),
        () => fallbackCopy(value)
      );
      return;
    }
    fallbackCopy(value);
  }

  function fallbackCopy(value) {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (_) {}
    area.remove();
    setHint(copied ? "已复制 · " + (value.split("\n")[0] || "") : "复制失败，请手动选择代码行");
  }

  function copyCodePosition(file, line) {
    const info = D.files[file];
    if (!info) return;
    const source = String(info.code || "").split("\n")[Math.max(0, Number(line) - 1)] || "";
    copyText(file + ":" + line + (source ? "\n" + source : ""));
  }

  function stepSignalPosition(direction) {
    const file = state.codeFile;
    const positions = signalPositions(state.signal, file);
    if (!positions.length) return;
    const current = positions.findIndex(
      (item) => item.file === file && item.line === Number(state.codeLine)
    );
    let next;
    if (current >= 0) {
      next = (current + direction + positions.length) % positions.length;
    } else {
      if (direction > 0) {
        next = positions.findIndex((item) => item.line > Number(state.codeLine));
        if (next < 0) next = 0;
      } else {
        for (let index = positions.length - 1; index >= 0; index -= 1) {
          if (positions[index].line < Number(state.codeLine)) {
            next = index;
            break;
          }
        }
        if (next == null) next = positions.length - 1;
      }
    }
    const target = positions[next];
    if (!target) return;
    state.codeLine = target.line;
    state.codeJump = target.line;
    renderCode();
    buildSidebar();
    setCrumb("代码导航 · " + file + ":" + target.line);
  }

  function codeSearchMatches(query = state.codeQuery, file = state.codeFile) {
    const needle = String(query || "").trim();
    const info = D.files[file];
    if (!needle || !info) return [];
    const re = new RegExp(escapeRegExp(needle), "gi");
    return String(info.code || "").split("\n").map((line, index) => {
      const count = (line.match(re) || []).length;
      return count ? { line: index + 1, count } : null;
    }).filter(Boolean);
  }

  function paintCodeSearch() {
    const needle = String(state.codeQuery || "").trim().toLowerCase();
    const matches = codeSearchMatches();
    if (!needle) {
      state.codeSearchAt = -1;
      state.codeSearchLine = null;
    } else if (!matches.some((item) => item.line === state.codeSearchLine)) {
      state.codeSearchAt = matches.length ? 0 : -1;
      state.codeSearchLine = matches.length ? matches[0].line : null;
    } else {
      state.codeSearchAt = matches.findIndex((item) => item.line === state.codeSearchLine);
    }
    $$("#codeBody .cl").forEach((row) => {
      row.classList.toggle("searchline", Number(row.dataset.line) === state.codeSearchLine);
    });
    $$("#codeBody .tk-id").forEach((token) => {
      token.classList.toggle("hit", !!needle && token.textContent.toLowerCase().includes(needle));
    });
    const hits = $("#codeHits");
    if (hits) {
      hits.textContent = needle
        ? `${matches.reduce((total, item) => total + item.count, 0)} 处 / ${matches.length} 行` +
          (state.codeSearchLine ? ` · L${state.codeSearchLine}` : "")
        : "";
    }
  }

  function revealCodeSearch() {
    if (!state.codeSearchLine) return;
    centerCodeLine(state.codeSearchLine);
    setCrumb("代码导航 · " + state.codeFile + ":" + state.codeSearchLine);
  }

  function applyCodeSearch(value) {
    state.codeQuery = String(value || "");
    state.codeSearchLine = null;
    paintCodeSearch();
    revealCodeSearch();
    const matches = codeSearchMatches();
    setHint(state.codeQuery.trim()
      ? matches.length
        ? `搜索 ${state.codeQuery.trim()} · ${matches.reduce((total, item) => total + item.count, 0)} 处 · 回车下一处`
        : `搜索 ${state.codeQuery.trim()} · 当前文件无匹配`
      : "");
  }

  function stepCodeSearch(direction) {
    const input = $("#codeSearch");
    if (input) state.codeQuery = input.value;
    const matches = codeSearchMatches();
    if (!matches.length) return paintCodeSearch();
    let index = matches.findIndex((item) => item.line === state.codeSearchLine);
    if (index < 0) index = direction > 0 ? -1 : 0;
    index = (index + direction + matches.length) % matches.length;
    state.codeSearchAt = index;
    state.codeSearchLine = matches[index].line;
    paintCodeSearch();
    revealCodeSearch();
    setHint(`搜索 ${state.codeQuery.trim()} · L${matches[index].line} · ${index + 1}/${matches.length} 行`);
  }

  function snippetKindForLine(text, name) {
    const clean = String(text || "").replace(/\/\/.*$/g, "");
    const word = "\\b" + escapeRegExp(name) + "\\b";
    if (new RegExp(word + "\\s*(?:\\[[^\\]]+\\]\\s*)?(?:<=|=)(?!=)").test(clean)) {
      return { key: "assign", label: "赋值" };
    }
    if (new RegExp("\\.\\w+\\s*\\(\\s*" + word).test(clean)) {
      return { key: "instance", label: "例化实参" };
    }
    if (new RegExp("\\.\\s*" + word + "\\s*\\(").test(clean)) {
      return { key: "instance", label: "端口映射" };
    }
    if (/\b(input|output|inout|wire|reg|logic|integer|bit|byte|shortint|longint|tri)\b/.test(clean)) {
      return { key: "decl", label: "声明" };
    }
    return { key: "use", label: "引用" };
  }

  function moduleOrderDistance(moduleName, primaryName) {
    let node = primaryName ? moduleByName(primaryName) : null;
    let distance = 0;
    while (node) {
      if (node.name === moduleName) return distance;
      node = node.parent ? moduleByName(node.parent) : null;
      distance += 1;
    }
    const index = D.modules.findIndex((item) => item.name === moduleName);
    return 100 + (index < 0 ? D.modules.length : index);
  }

  function snippetGroupsForSignal(name, origin) {
    const positions = allSignalPositions(name);
    const originOwner = origin && D.files[origin.file]
      ? moduleAt(origin.file, Number(origin.line) || 1)
      : null;
    const primary = (originOwner || moduleAt(state.codeFile, state.codeLine) || {}).name ||
      ((D.signals[name] || {}).module || "");
    const grouped = new Map();
    positions.slice(0, 80).forEach((position) => {
      const info = D.files[position.file];
      if (!info) return;
      const lines = String(info.code || "").replace(/\r\n?/g, "\n").split("\n");
      const text = lines[position.line - 1] || "";
      const owner = moduleAt(position.file, position.line);
      const moduleName = owner ? owner.name : position.file;
      const key = moduleName;
      if (!grouped.has(key)) {
        grouped.set(key, {
          module: moduleName,
          path: owner ? modulePath(owner.name).map((item) => item.name).join(" › ") : position.file,
          items: []
        });
      }
      grouped.get(key).items.push({
        file: position.file,
        line: position.line,
        text,
        origin: Boolean(origin && position.file === origin.file && position.line === Number(origin.line)),
        kind: snippetKindForLine(text, name)
      });
    });
    const groups = [...grouped.values()].sort((left, right) =>
      moduleOrderDistance(left.module, primary) - moduleOrderDistance(right.module, primary)
    );
    groups.forEach((group) => {
      group.origin = group.items.some((item) => item.origin);
    });
    return {
      total: positions.length,
      groups,
      originGroup: groups.findIndex((group) => group.origin)
    };
  }

  function snippetRangeHtml(item, signal) {
    const info = D.files[item.file];
    if (!info) return "";
    const lines = String(info.code || "").replace(/\r\n?/g, "\n").split("\n");
    const symbols = window.SigSem ? window.SigSem.symbols(item.file) : new Set();
    const start = Math.max(1, item.line - 2);
    const end = Math.min(lines.length, item.line + 2);
    const width = Math.max(3, String(end).length);
    return Array.from({ length: end - start + 1 }, (_, offset) => {
      const number = start + offset;
      const html = highlightCode(lines[number - 1] || "", symbols, {
        file: item.file,
        interactive: false,
        highlightSignal: signal
      });
      return `<span class="snippet-line${number === item.line ? " target" : ""}"><span class="ln">${String(number).padStart(width, " ")}</span><span class="src">${html || " "}</span></span>`;
    }).join("");
  }

  function snippetCardItemHtml(item, signal) {
    return `<div class="snippet-item${item.origin ? " origin" : ""}" role="button" tabindex="0" data-code="${esc(item.file)}" data-line="${item.line}">
      <div class="snippet-meta"><span class="snippet-meta-left"><span class="snippet-kind ${esc(item.kind.key)}">${esc(item.kind.label)}</span></span><span class="snippet-where">${esc(item.file)}:${item.line}</span></div>
      <pre class="snippet-code">${snippetRangeHtml(item, signal)}</pre>
    </div>`;
  }

  function activateSnippetTab(index) {
    snippetUI.tab = index;
    $$("#snippetCard [data-snippet-tab]").forEach((tab, tabIndex) => {
      const active = tabIndex === index;
      tab.classList.toggle("on", active);
      tab.setAttribute("aria-selected", String(active));
    });
    $$("#snippetCard [data-snippet-panel]").forEach((panel, panelIndex) => {
      panel.hidden = panelIndex !== index;
    });
    const body = $("#snippetCardBody");
    if (body) body.scrollTop = 0;
    hideSnippetPreview();
  }

  function positionSnippetCard(event) {
    const card = $("#snippetCard");
    if (!card || card.hidden) return;
    requestAnimationFrame(() => {
      const margin = 12;
      const rect = card.getBoundingClientRect();
      const anchorX = event && Number.isFinite(event.clientX) && event.clientX > 0
        ? event.clientX
        : window.innerWidth / 2;
      const anchorY = event && Number.isFinite(event.clientY) && event.clientY > 0
        ? event.clientY
        : 90;
      let left = anchorX + 16;
      if (left + rect.width > window.innerWidth - margin) left = anchorX - rect.width - 16;
      left = clampValue(left, margin, Math.max(margin, window.innerWidth - rect.width - margin));
      let top = anchorY + 12;
      if (top + rect.height > window.innerHeight - margin) top = anchorY - rect.height - 12;
      top = clampValue(top, 64, Math.max(64, window.innerHeight - rect.height - margin));
      card.style.left = left + "px";
      card.style.top = top + "px";
    });
  }

  function bindSnippetCard() {
    $$("#snippetCard .snippet-item").forEach((item) => {
      item.addEventListener("mouseenter", () => scheduleSnippetPreview(item));
      item.addEventListener("mouseleave", scheduleSnippetPreviewHide);
    });
  }

  function revealOriginSnippet() {
    requestAnimationFrame(() => {
      const body = $("#snippetCardBody");
      const item = body && body.querySelector(".snippet-item.origin");
      if (!body || !item) return;
      const delta = item.getBoundingClientRect().top - body.getBoundingClientRect().top - 10;
      body.scrollTop = Math.max(0, body.scrollTop + delta);
    });
  }

  function renderSnippetCard() {
    const card = $("#snippetCard");
    const groups = snippetUI.groups || [];
    if (!snippetUI.signal) return;
    const activeIndex = groups.length
      ? clampValue(Number(snippetUI.tab) || 0, 0, groups.length - 1)
      : 0;
    const summary = snippetUI.total
      ? `${snippetUI.total} 处 · ${groups.length} 个模块${snippetUI.total > 80 ? " · 显示前 80 处" : ""}`
      : "当前源码快照没有找到该信号的文本出现位置。";
    if (!groups.length) {
      card.innerHTML = `<div class="snippet-head"><div><h2>${esc(snippetUI.signal)}</h2></div><button class="snippet-close" type="button" data-close-snippet aria-label="关闭相关片段">×</button></div><div class="snippet-empty">${esc(summary)}</div>`;
    } else {
      card.innerHTML = `
        <div class="snippet-head">
          <div><h2>${esc(snippetUI.signal)}</h2></div>
          <button class="snippet-close" type="button" data-close-snippet aria-label="关闭相关片段">×</button>
        </div>
        <div class="snippet-summary">${esc(summary)}</div>
        <div class="snippet-tabs" role="tablist" aria-label="按模块查看相关片段">
          ${groups.map((group, index) => `<button class="snippet-tab${index === activeIndex ? " on" : ""}${group.origin ? " origin" : ""}" type="button" role="tab" aria-selected="${index === activeIndex}" data-snippet-tab="${index}" title="${esc(group.path)}"><span class="n">${String(index + 1).padStart(2, "0")}</span>${esc(group.module)} <span class="dim2">${group.items.length}</span></button>`).join("")}
        </div>
        <div class="snippet-body" id="snippetCardBody">
          ${groups.map((group, index) => `<section data-snippet-panel="${index}"${index !== activeIndex ? " hidden" : ""}>
            <div class="snippet-group-title">${esc(group.path)}<span>${group.items.length} 处</span></div>
            ${group.items.map((item) => snippetCardItemHtml(item, snippetUI.signal)).join("")}
          </section>`).join("")}
        </div>`;
    }
    card.hidden = false;
    snippetUI.open = true;
    snippetUI.tab = activeIndex;
    bindSnippetCard();
    revealOriginSnippet();
  }

  function openSignalSnippets(name, event, origin) {
    if (!name) return;
    const originContext = origin && D.files[origin.file]
      ? { file: origin.file, line: Math.max(1, Number(origin.line) || 1) }
      : null;
    const result = snippetGroupsForSignal(name, originContext);
    snippetUI.signal = name;
    snippetUI.origin = originContext;
    snippetUI.originGroup = result.originGroup;
    snippetUI.total = result.total;
    snippetUI.groups = result.groups;
    snippetUI.tab = result.originGroup >= 0 ? result.originGroup : 0;
    renderSnippetCard();
    positionSnippetCard(event);
  }

  function closeSnippetCard() {
    snippetUI.open = false;
    snippetUI.signal = "";
    snippetUI.origin = null;
    snippetUI.originGroup = 0;
    snippetUI.groups = [];
    snippetUI.total = 0;
    hideSnippetPreview();
    const card = $("#snippetCard");
    if (card) {
      card.hidden = true;
      card.innerHTML = "";
    }
  }

  function clearSnippetPreviewTimers() {
    clearTimeout(snippetUI.previewShowTimer);
    clearTimeout(snippetUI.previewHideTimer);
    snippetUI.previewShowTimer = null;
    snippetUI.previewHideTimer = null;
  }

  function scheduleSnippetPreview(item) {
    clearSnippetPreviewTimers();
    snippetUI.previewShowTimer = setTimeout(() => showSnippetPreview(item), 150);
  }

  function scheduleSnippetPreviewHide() {
    clearTimeout(snippetUI.previewShowTimer);
    clearTimeout(snippetUI.previewHideTimer);
    snippetUI.previewHideTimer = setTimeout(hideSnippetPreview, 220);
  }

  function hideSnippetPreview() {
    clearSnippetPreviewTimers();
    snippetUI.previewItem = null;
    const preview = $("#sourcePreview");
    if (!preview) return;
    preview.classList.remove("visible");
    preview.hidden = true;
    preview.innerHTML = "";
  }

  function fullSourcePreviewHtml(file, signal) {
    const key = file + "|" + signal;
    if (sourcePreviewCache.has(key)) return sourcePreviewCache.get(key);
    const info = D.files[file];
    if (!info) return null;
    const lines = String(info.code || "").replace(/\r\n?/g, "\n").split("\n");
    const symbols = window.SigSem ? window.SigSem.symbols(file) : new Set();
    const html = lines.map((line, index) => {
      const number = index + 1;
      return `<span class="sp-line" data-line="${number}"><span class="ln">${number}</span><span class="src">${highlightCode(line, symbols, {
        file,
        interactive: false,
        highlightSignal: signal
      }) || " "}</span></span>`;
    }).join("");
    const result = { html, lines, count: lines.length };
    if (sourcePreviewCache.size >= 3) sourcePreviewCache.delete(sourcePreviewCache.keys().next().value);
    sourcePreviewCache.set(key, result);
    return result;
  }

  function positionSourcePreview(preview, anchor) {
    const card = $("#snippetCard").getBoundingClientRect();
    const margin = 12;
    const gap = 10;
    const maxWidth = Math.min(620, window.innerWidth - margin * 2);
    const minReadableWidth = Math.min(380, maxWidth);
    const rightSpace = window.innerWidth - card.right - gap - margin;
    const leftSpace = card.left - gap - margin;
    let width = maxWidth;
    const height = Math.min(560, window.innerHeight - 76);
    let left;
    if (rightSpace >= minReadableWidth) {
      width = Math.min(maxWidth, rightSpace);
      left = card.right + gap;
    } else if (leftSpace >= minReadableWidth) {
      width = Math.min(maxWidth, leftSpace);
      left = card.left - gap - width;
    } else {
      left = clampValue(window.innerWidth / 2 - width / 2, margin, window.innerWidth - width - margin);
    }
    const top = clampValue(anchor.top, 64, Math.max(64, window.innerHeight - height - margin));
    preview.style.width = width + "px";
    preview.style.height = height + "px";
    preview.style.left = left + "px";
    preview.style.top = top + "px";
  }

  function showSnippetPreview(item) {
    snippetUI.previewShowTimer = null;
    if (!item || !item.isConnected || !snippetUI.open) return;
    const file = item.dataset.file || item.dataset.code || "";
    const line = Number(item.dataset.line) || 1;
    const signal = snippetUI.signal;
    const result = fullSourcePreviewHtml(file, signal);
    if (!result) return;
    snippetUI.previewItem = item;
    const preview = $("#sourcePreview");
    preview.innerHTML = `
      <div class="source-preview-head">
        <div><strong>${esc(file)}</strong></div>
        <span class="at">L${line} / ${result.count}</span>
      </div>
      <div class="source-preview-sub"><span>${esc(signal)}</span></div>
      <div class="source-preview-code" id="sourcePreviewCode">${result.html}</div>`;
    preview.hidden = false;
    positionSourcePreview(preview, item.getBoundingClientRect());
    preview.classList.remove("visible");
    requestAnimationFrame(() => {
      if (preview.hidden || snippetUI.previewItem !== item) return;
      preview.classList.add("visible");
      const code = $("#sourcePreviewCode");
      const target = code && code.querySelector(`.sp-line[data-line="${line}"]`);
      if (code && target) {
        target.classList.add("target");
        code.scrollTop = Math.max(0, target.offsetTop - code.clientHeight / 2 + target.offsetHeight / 2);
      }
    });
  }

  function renderCode() {
    const fileNames = Object.keys(D.files);
    if (!state.codeFile || !D.files[state.codeFile]) state.codeFile = fileNames[0] || "";
    const file = D.files[state.codeFile];
    if (!file) {
      $("#main").innerHTML = `
        <div class="page-h"><div><div class="ttl">代码导航</div><div class="sub">从信号、模块或源码入口定位。</div></div><span class="chip">无源码</span></div>
        <article class="card"><h3>当前快照没有可读取的源码文件</h3><p class="small muted">补充 data.files 后本页再提供代码定位；不生成示例代码。</p></article>`;
      return;
    }
    const lines = String(file.code || "").replace(/\r\n?/g, "\n").split("\n");
    const declaredSymbols = window.SigSem
      ? window.SigSem.symbols(state.codeFile)
      : new Set();
    const shortcuts = (Array.isArray(D.codeShortcuts) && D.codeShortcuts.length
      ? D.codeShortcuts
      : D.modules
        .filter((module) => module.file && D.files[module.file])
        .slice(0, 3)
        .map((module) => ({
          label: module.label || module.name,
          file: module.file,
          line: module.start || 1
        }))
    ).filter((item) => item && item.file && D.files[item.file]).slice(0, 4);
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">代码导航</div><div class="sub">从信号、模块或源码入口定位。</div></div><span class="chip">${esc(state.codeFile)}</span></div>
      <div class="code-bar">
        <label for="codeFileSelect">源码文件</label>
        <select class="search" id="codeFileSelect">${fileNames.map((name) => `<option${name === state.codeFile ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>
        <input class="search" id="codeSearch" style="width:170px" value="${esc(state.codeQuery)}" placeholder="搜索标识符…" autocomplete="off" spellcheck="false" title="回车下一处，Shift+回车上一处" aria-label="搜索代码标识符">
        <span class="tiny dim2" id="codeHits"></span>
        ${shortcuts.map((item) => `<button type="button" class="btn sm" data-code="${esc(item.file)}" data-line="${Number(item.line) || 1}">${esc(item.label || item.file)}</button>`).join("")}
        ${signalNavHtml()}
      </div>
      <div class="code-wrap">
        <div class="code-scroll" id="codeBody">
          ${lines.map((line, index) => {
            const number = index + 1;
            const selectedLine = state.signal && new RegExp("\\b" + escapeRegExp(state.signal) + "\\b").test(line);
            return `<div class="cl${selectedLine ? " sigline" : ""}${number === state.codeLine ? " hl" : ""}" data-line="${number}" id="L${number}"><span class="ln">${number}</span><span class="src">${highlightCode(line, declaredSymbols) || " "}</span></div>`;
          }).join("")}
        </div>
      </div>
      `;
    $("#codeFileSelect").addEventListener("change", (event) => {
      state.codeFile = event.target.value;
      state.codeLine = 1;
      state.codeJump = 1;
      state.codeSearchAt = -1;
      state.codeSearchLine = null;
      buildSidebar();
      renderCode();
    });
    const search = $("#codeSearch");
    if (search) {
      search.addEventListener("input", () => {
        clearTimeout(search._searchTimer);
        search._searchTimer = setTimeout(() => applyCodeSearch(search.value), 140);
      });
      search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          stepCodeSearch(event.shiftKey ? -1 : 1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          search.value = "";
          applyCodeSearch("");
        }
      });
    }
    const previous = $("#sigPrevBtn");
    if (previous) previous.addEventListener("click", () => stepSignalPosition(-1));
    const next = $("#sigNextBtn");
    if (next) next.addEventListener("click", () => stepSignalPosition(1));
    const copy = $("#sigCopyBtn");
    if (copy) copy.addEventListener("click", () => copyCodePosition(state.codeFile, state.codeLine));
    const snippets = $("#sigSnippetBtn");
    if (snippets) snippets.addEventListener("click", (event) => openSignalSnippets(state.signal, event, {
      file: state.codeFile,
      line: state.codeLine
    }));
    centerCodeLine(state.codeJump || state.codeLine);
    state.codeJump = null;
    paintCodeSearch();
  }

  function renderTiming() {
    if (window.WaveUI) WaveUI.dispose();
    if (D.wave && window.WaveUI) {
      $("#main").innerHTML = '<div id="timingWaveRoot"></div>';
      WaveUI.mount($("#timingWaveRoot"), D.wave, {
        onSignal: (channel) => inspectWaveSignal(channel),
        onSource: (model) => inspectWaveSource(model)
      });
      return;
    }
    const message = D.wave
      ? "wave.js 或 wave-core.js 未加载，无法建立查看器。"
      : "当前快照没有附带可读取的 VCD。";
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">时序波形</div><div class="sub">波形页只读取真实 VCD；没有数据时不生成示意采样。</div></div><span class="chip">无可用波形</span></div>
      <article class="card">
        <h3>${esc(message)}</h3>
        <p class="small muted">补充 VCD 后，本页提供信号树、场景窗口、时间游标、缩放/适配、播放和总线位展开；所有值按时间戳读取，X/Z 原样保留。</p>
        <pre class="code-how">initial begin
  $dumpfile("wave.vcd");
  $dumpvars(1, tb);
end</pre>
      </article>`;
  }

  function renderVerify() {
    const validation = D.validation;
    const summary = validation && validation.summary;
    if (!summary) {
      $("#main").innerHTML = `
        <div class="page-h"><div><div class="ttl">仿真验证</div><div class="sub">只记录实际执行过的检查，并单列未覆盖边界。</div></div><span class="chip">无可用报告</span></div>
        <article class="card"><h3>当前快照没有附带验证报告</h3><p class="small muted">不生成通过率、覆盖率或断言数量；补充真实报告后再展示。</p></article>`;
      return;
    }
    const benches = Array.isArray(validation.benches) ? validation.benches : [];
    const notCovered = Array.isArray(validation.notCovered) ? validation.notCovered : [];
    const source = validation.source || D.meta.validationSource || "报告";
    const statDefs = [
      ["benches", "测试平台"],
      ["cases", "场景"],
      ["checks", "断言"],
      ["waveforms", "波形"]
    ];
    const stats = statDefs
      .filter(([key]) => summary[key] != null)
      .map(([key, label]) =>
        `<div class="card stat"><div class="v">${esc(summary[key])}</div><div class="l">${esc(label)}</div><div class="s">${esc(source)}</div></div>`
      ).join("");
    $("#main").innerHTML = `
      <div class="page-h"><div><div class="ttl">仿真验证</div><div class="sub">只记录实际执行过的检查，并单列未覆盖边界。</div></div><span class="chip">${esc(summary.status || "已记录")}</span></div>
      ${stats ? `<div class="grid g4">${stats}</div>` : ""}
      <section style="margin-top:14px">
        ${benches.map((bench, index) => {
          const cases = Array.isArray(bench.cases) ? bench.cases : [];
          return `<article class="bench${state.bench === index ? " open" : ""}">
          <button type="button" class="bench-h" data-bench="${index}" style="border:0;background:none;width:100%;text-align:left">
            <span class="nm">${esc(bench.name || "测试平台")}</span><span class="purpose">${esc(bench.purpose || "")}</span><span class="cnt">${cases.length} 项</span>
          </button>
          <div class="bench-b">${cases.map((item, i) => {
            const title = typeof item === "string" ? item : (item.title || item.name || "");
            const note = typeof item === "string" ? "" : (item.note || "");
            return `<div class="case"><span class="id">C${i + 1}</span><span class="t">${esc(title)}</span><span class="p">${esc(note)}</span></div>`;
          }).join("")}</div>
        </article>`;
        }).join("")}
      </section>
      ${notCovered.length ? `<details class="card fold-card">
        <summary>本页未覆盖的范围</summary>
        <div class="fold-content"><ul class="hlist">${notCovered.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>
      </details>` : ""}`;
  }

  function inspectModule(name, reveal = true) {
    const module = moduleByName(name);
    if (!module) return;
    state.module = name;
    state.constant = null;
    state.constantFile = null;
    state.inspect = { type: "module", id: name };
    const parent = module.parent ? `<tr><td>父模块</td><td class="mono">${esc(module.parent)}</td></tr>` : "";
    const children = childrenOf(name);
    const units = module.units || [];
    $("#inspType").textContent = "模块上下文";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(module.name)}</div>
      <div class="i-sub">${esc(module.file)} · L${module.start}–${module.end}</div>
      <div class="i-sec module-role-context"><h5>模块职责</h5>
        <p class="insp-summary">${esc(module.role)}</p>
      </div>
      <div class="i-sec"><h5>结构</h5><table class="t insp-kv"><tbody>
        ${parent}
        <tr><td>子模块</td><td>${children.length ? children.map((item) => esc(item.name)).join("、") : "—"}</td></tr>
        <tr><td>端口</td><td>${(module.ports || []).length} 个</td></tr>
        <tr><td>内部单元</td><td>${units.length ? units.map((item) => esc(item.name)).join("、") : "—"}</td></tr>
        <tr><td>存储</td><td>${module.storage ? `${module.storage.length} 项` : "—"}</td></tr>
      </tbody></table></div>
      <div class="i-sec"><h5>接口分组</h5><div class="row">${portPills(module)}</div><p class="small muted" style="margin:7px 0 0">完整端口表在模块结构页展开。</p></div>
      ${module.storage && module.storage.length ? `<div class="i-sec"><h5>存储资源</h5><div class="row">${module.storage.map((item) => `<span class="pill">${esc(item.name)} · ${esc(item.kind)}</span>`).join("")}</div></div>` : ""}
      <div class="i-sec"><h5>行为边界</h5><p>${esc(module.note)}</p></div>
      <div class="i-actions">
        <button type="button" class="btn sm" data-code="${esc(module.file)}" data-line="${module.start}">代码</button>
        <button type="button" class="btn sm" data-go="structure" data-focus-module="${esc(module.name)}">结构图</button>
        ${children.length ? `<button type="button" class="btn sm" data-module="${esc(module.name)}" data-drill="1">进入内部</button>` : ""}
      </div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectConstant(name, file, reveal = true) {
    const item = constFor(name, file);
    if (!item) return;
    state.constant = name;
    state.constantFile = file;
    state.signal = null;
    if (item.module && moduleByName(item.module)) state.module = item.module;
    state.inspect = { type: "constant", id: name, file };
    $("#inspType").textContent = "常量";
    $("#inspBody").innerHTML = `
      <div class="i-title mono">${esc(item.name)}</div>
      <div class="i-sub">${esc(item.file)}:${item.line} · ${esc(item.kind)}${item.width ? ` · ${esc(item.width)}` : ""}</div>
      <div class="sem-meta">值 <b class="mono">${esc(item.value)}</b></div>
      <p class="insp-summary">${esc(item.note || `${item.name} 是编译期常量，用来替代散落在代码里的字面量。`)}</p>
      <div class="i-sec"><h5>更新方式</h5><p>编译期确定，运行中不随时钟或复位改变；改值要重新综合。</p></div>
      <div class="i-sec"><h5>引用位置 <span class="mini">${item.uses.length} 处</span></h5>
        <div class="row">${
          item.uses.slice(0, 12).map((use) =>
            `<button type="button" class="sem-chip mono" data-code="${esc(use.file)}" data-line="${use.line}" title="${esc(use.text)}">${esc(use.file)}:${use.line}</button>`
          ).join("") || '<span class="tiny dim2">只在声明处出现</span>'
        }</div></div>
      <div class="i-actions"><button type="button" class="btn sm" data-code="${esc(item.file)}" data-line="${item.line}">定位声明 →</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function placeSignalInCode(name, originFile, semantic) {
    const positions = allSignalPositions(name);
    if (!positions.length) return;
    const signal = D.signals[name] || {};
    const declaration = semantic && semantic.declaration;
    const preferredFiles = [
      originFile,
      state.codeFile,
      signal.file,
      declaration && declaration.file
    ].filter(Boolean);
    const targetFile = preferredFiles.find(
      (file) => positions.some((item) => item.file === file)
    ) || positions[0].file;
    const currentExact = positions.some(
      (item) => item.file === state.codeFile && item.line === Number(state.codeLine)
    );
    if (currentExact) return;
    const target = positions.find((item) => item.file === targetFile) || positions[0];
    state.codeFile = target.file;
    state.codeLine = target.line;
    state.codeJump = target.line;
  }

  function inspectSignal(name, reveal = true, originFile = "") {
    const signal = D.signals[name] || null;
    const clickedModule = originFile ? moduleAt(originFile, state.codeLine) : null;
    const semantic = window.SigSem
      ? window.SigSem.analyze(name, {
        module: clickedModule ? clickedModule.name : signal && signal.module,
        file: originFile || (signal && signal.file) || state.codeFile,
        line: originFile ? state.codeLine : signal && signal.line
      })
      : null;
    if (!signal && !(semantic && (semantic.declaration || semantic.declarations.length))) return;

    state.signal = name;
    state.constant = null;
    state.constantFile = null;
    const declaration = semantic && semantic.declaration;
    const sourceFile = (declaration && declaration.file) ||
      (signal && signal.file) || originFile || state.codeFile;
    const sourceLine = (declaration && declaration.line) ||
      (signal && signal.line) || Number(state.codeLine) || 1;
    const owner = moduleAt(sourceFile, sourceLine);
    const moduleName = owner ? owner.name : (signal && signal.module) || (semantic && semantic.module) || "";
    if (moduleName && moduleByName(moduleName)) state.module = moduleName;
    const width = (semantic && semantic.storageText) ||
      (semantic && semantic.widthText) || (signal && signal.width) || "未知";
    const kind = semantic && semantic.isMemory
      ? "memory"
      : (semantic && semantic.kind) || (signal && signal.kind) || "source";
    const purpose = signal
      ? signal.purpose
      : "该对象由源码声明自动识别；当前数据没有提供人工用途说明。";
    const timing = signal
      ? signal.timing
      : semantic && semantic.isMemory
        ? "容量与位宽来自声明；实际读写时序需结合使能条件和 always 块核对。"
        : "没有人工时序说明；请展开代码依据核对声明和赋值上下文。";
    const rules = (signal && signal.rules) || [
      "自动识别项没有人工规则说明，以声明和代码依据为准。"
    ];
    const related = (signal && signal.related) || [];
    const evidence = uniqueEvidence([
      ...((signal && signal.evidence) || []),
      ...((semantic && semantic.evidence) || []).map((item) => ({
        file: item.file,
        line: item.line,
        note: [item.label, item.text].filter(Boolean).join(" · ")
      }))
    ]);
    state.inspect = { type: "signal", id: name, originFile };
    $("#inspType").textContent = "信号详情";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(name)}</div>
      <div class="i-sub">${moduleName ? `${esc(moduleName)}${signal && signal.instance ? ` · ${esc(signal.instance)}` : ""} · ` : ""}${esc(sourceFile)}:${sourceLine}</div>
      <div class="sem-meta">${esc(kind)} · ${esc(width)}${semantic && semantic.width != null ? " · 声明解析" : ""}</div>
      <p class="insp-summary">${esc(purpose)}</p>
      <div class="i-sec"><h5>生效条件</h5><p>${esc(timing)}</p></div>
      ${rules.length ? `<details class="sem-fold"><summary>规则与边界 <span>${rules.length} 条</span></summary><div class="sem-fold-b"><ul class="hlist">${rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul></div></details>` : ""}
      ${related.length ? `<details class="sem-fold"><summary>相关信号 <span>${related.length} 个</span></summary><div class="sem-fold-b"><div class="row">${related.map((item) => `<button type="button" class="sem-chip" data-signal="${esc(item)}">${esc(item)}</button>`).join("")}</div></div></details>` : ""}
      ${evidence.length ? `<details class="sem-fold"><summary>代码依据 <span>${evidence.length} 个位置</span></summary><div class="sem-fold-b">${evidenceHtml(evidence)}</div></details>` : ""}
      <div class="i-actions"><button type="button" class="btn sm" data-code="${esc(sourceFile)}" data-line="${sourceLine}">定位源码 →</button></div>`;
    if (state.tab === "code" || originFile) placeSignalInCode(name, originFile, semantic);
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectWaveSignal(channel, reveal = true) {
    if (!channel) return;
    state.waveChannel = channel;
    state.constant = null;
    state.constantFile = null;
    state.inspect = { type: "wave", id: channel.path };
    const info = channel.info || {};
    const linkedName = info.signal || channel.name;
    const linked = D.signals[linkedName] || null;
    const sourceFile = info.file || (linked && linked.file) || "";
    const sourceLine = info.line || (linked && linked.line) || 1;
    const purpose = info.purpose ||
      (linked && linked.purpose) ||
      "该信号由 VCD 直接采样；当前数据没有提供人工用途说明。";
    $("#inspType").textContent = "波形信号";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(channel.name)}</div>
      <div class="i-sub">${esc(channel.path)} · ${channel.width} bit · ${esc(channel.type)}</div>
      <div class="sem-meta">游标 ${esc(channel.timeText)} · cycle ${channel.cycle}</div>
      <p class="insp-summary">${esc(purpose)}</p>
      <div class="i-sec"><h5>当前采样</h5><table class="t insp-kv"><tbody>
        <tr><td>显示值</td><td class="mono">${esc(channel.displayValue)}</td></tr>
        <tr><td>VCD 原始值</td><td class="mono">${esc(channel.rawValue)}</td></tr>
        <tr><td>作用域</td><td class="mono">${esc(channel.scope || "—")}</td></tr>
        ${channel.parentPath ? `<tr><td>所属总线</td><td class="mono">${esc(channel.parentPath)}</td></tr>` : ""}
      </tbody></table></div>
      <div class="note">值来自波形时间戳，不做插值；状态名来自数据配置或源码编码。</div>
      <div class="i-actions">
        ${sourceFile ? `<button type="button" class="btn sm" data-code="${esc(sourceFile)}" data-line="${sourceLine}">定位源码 →</button>` : ""}
        ${linked ? `<button type="button" class="btn sm" data-signal="${esc(linkedName)}">查看信号详情</button>` : ""}
      </div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectWaveSource(model, reveal = true) {
    const source = model && model.source
      ? model.source
      : model && model.file
        ? model
        : (D.wave && D.wave.source) || {};
    state.waveSource = source;
    state.inspect = { type: "wave-source", id: source.file || "vcd" };
    const modelData = model && model.baseChannels ? model : (window.WaveUI && WaveUI.model);
    const signalCount = modelData
      ? modelData.baseChannels.length + " 基础 + " + modelData.bitChannels.length + " 拆位"
      : "未加载";
    $("#inspType").textContent = "波形来源";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(source.file || "VCD")}</div>
      <div class="i-sub">${esc(source.simulator || "仿真器未标注")}</div>
      <p class="insp-summary">${esc(source.note || "波形值按 VCD 时间戳读取，保留 X/Z，不做插值或推测。")}</p>
      <div class="i-sec"><h5>数据口径</h5><table class="t insp-kv"><tbody>
        <tr><td>时间精度</td><td class="mono">${esc(source.timescale || (modelData && modelData.timescale.text) || "未标注")}</td></tr>
        <tr><td>生成时间</td><td class="mono">${esc(source.generated || "未标注")}</td></tr>
        <tr><td>信号数量</td><td class="mono">${esc(signalCount)}</td></tr>
        <tr><td>时钟路径</td><td class="mono">${esc(modelData && modelData.clockPath ? modelData.clockPath : "未识别")}</td></tr>
      </tbody></table></div>
      ${source.testbench ? `<div class="i-sec"><h5>测试平台</h5><p class="mono small">${esc(source.testbench)}</p></div>` : ""}
      ${source.fictional ? '<div class="note amber">这是参考页的虚构演示波形，只用于展示查看器交互，不代表任何工程实测结果。</div>' : ""}
      <div class="note">波形只覆盖该文件、该时间窗口和该次仿真配置；不能替代时序签核、CDC 检查或上板验证。</div>`;
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectEdge(id, reveal = true) {
    const edge = edgeById(id);
    if (!edge) return;
    state.edge = id;
    state.constant = null;
    state.constantFile = null;
    if (edge.module) state.module = edge.module;
    else if (moduleByName(edge.from)) state.module = edge.from;
    else if (moduleByName(edge.to)) state.module = edge.to;
    state.inspect = { type: "edge", id };
    const actualFrom = edge.originalFrom || edge.from;
    const actualTo = edge.originalTo || edge.to;
    const fromLabel = edge.module
      ? internalNodeLabel(edge.module, actualFrom)
      : nodeLabel(actualFrom);
    const toLabel = edge.module
      ? internalNodeLabel(edge.module, actualTo)
      : nodeLabel(actualTo);
    const aggregationNote = edge.boundary
      ? `<p class="small muted">当前层级图中显示 ${esc(nodeLabel(edge.from))} → ${esc(nodeLabel(edge.to))}；真实连接端点是 ${esc(actualFrom)} → ${esc(actualTo)}，跨越了当前模块边界。</p>`
      : edge.aggregated
        ? `<p class="small muted">当前层级图中显示 ${esc(nodeLabel(edge.from))} → ${esc(nodeLabel(edge.to))}；真实连接端点是 ${esc(actualFrom)} → ${esc(actualTo)}，跨越了当前层级的子模块。</p>`
        : "";
    $("#inspType").textContent = "连线依据";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(fromLabel)} → ${esc(toLabel)}</div>
      <div class="i-sub">${esc(kindLabels[edge.kind] || edge.kind)} · ${esc(edge.label)}</div>
      <p class="insp-summary">${edge.module ? "这条内部连线对应单元之间的赋值、选择或使能关系。" : "这条连线是实例端口映射或赋值关系的聚合，不表示每一拍都发生传输。"}展开源码依据可核对实际信号。</p>
      ${aggregationNote}
      <div class="i-sec"><h5>经过的信号</h5><div class="row">${signalChips(edge.signals)}</div></div>
      <div class="i-sec"><h5>源码依据</h5>${evidenceHtml(edge.evidence)}</div>
      <div class="i-actions"><button type="button" class="btn sm" data-go="structure"${edge.module ? ` data-focus-module="${esc(edge.module)}"` : ""}>回到结构图</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function inspectStepAnchor(step) {
    if (!step) return;
    const signal = (step.signals || []).find((name) => D.signals[name]);
    if (signal) return inspectSignal(signal);
    if (step.modules && step.modules.length) return inspectModule(step.modules[0]);
  }

  function inspectState(id, reveal = true) {
    if (!D.fsm) return;
    const item = D.fsm.states.find((entry) => entry.id === id);
    if (!item) return;
    state.state = id;
    state.constant = null;
    state.constantFile = null;
    if (D.fsm.module && moduleByName(D.fsm.module)) state.module = D.fsm.module;
    state.inspect = { type: "state", id };
    const outgoing = D.fsm.transitions.filter((transition) => transition.from === id);
    const incoming = D.fsm.transitions.filter((transition) => transition.to === id);
    $("#inspType").textContent = "状态详情";
    $("#inspBody").innerHTML = `
      <div class="i-title">${esc(item.label)}</div>
      <div class="i-sub">${esc(D.fsm.name)} · ${esc(D.fsm.file)}:${item.code}</div>
      <p class="insp-summary">${esc(item.desc)}</p>
      <div class="i-sec"><h5>离开条件</h5>${outgoing.length ? outgoing.map((transition) => `<button type="button" class="sem-chip" data-state="${esc(transition.to)}">${esc(transition.condition)} → ${esc(transition.to)}</button>`).join("") : '<p class="small muted">—</p>'}</div>
      <div class="i-sec"><h5>进入条件</h5>${incoming.length ? incoming.map((transition) => `<button type="button" class="sem-chip" data-state="${esc(transition.from)}">${esc(transition.from)} → ${esc(transition.condition)}</button>`).join("") : '<p class="small muted">—</p>'}</div>
      <div class="i-actions"><button type="button" class="btn sm" data-code="${esc(D.fsm.file)}" data-line="${item.code}">定位状态声明 →</button></div>`;
    buildSidebar();
    if (reveal && matchMedia("(max-width:1180px)").matches) openPanel("inspector");
  }

  function refreshInspector() {
    const context = state.inspect || { type: "module", id: state.module };
    if (context.type === "wave") return inspectWaveSignal(state.waveChannel, false);
    if (context.type === "wave-source") return inspectWaveSource(state.waveSource, false);
    if (context.type === "constant") return inspectConstant(context.id, context.file, false);
    if (context.type === "signal") return inspectSignal(context.id, false, context.originFile || "");
    if (context.type === "edge") return inspectEdge(context.id, false);
    if (context.type === "state" && D.fsm) return inspectState(context.id, false);
    return inspectModule(state.module, false);
  }

  function renderMain() {
    if (state.tab !== "timing" && window.WaveUI) WaveUI.dispose();
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
    const focus = moduleByName(state.focus);
    const label = TABS.find(([id]) => id === state.tab)?.[1] || "总览";
    setCrumb(state.tab === "structure" && focus ? `${label} / ${focus.name}` : label);
    refreshInspector();
  }

  function drillModule(name) {
    const module = moduleByName(name);
    if (!module) return;
    state.module = name;
    state.focus = name;
    state.inspect = { type: "module", id: name };
    state.tab = "structure";
    closePanels();
    renderMain();
    $("#main").scrollTop = 0;
  }

  function focusModule(name) {
    const module = moduleByName(name);
    if (!module) return;
    state.module = name;
    state.focus = name;
    state.inspect = { type: "module", id: name };
    state.tab = "structure";
    closePanels();
    renderMain();
    $("#main").scrollTop = 0;
  }

  function focusBack() {
    const focus = moduleByName(state.focus) || rootModule;
    const parent = focus.parent ? moduleByName(focus.parent) : rootModule;
    focusModule(parent.name);
  }

  function go(tab, options = {}) {
    if (
      tab === "code" &&
      state.tab !== "code" &&
      !options.anchor &&
      state.inspect &&
      state.inspect.type === "module"
    ) {
      const module = moduleByName(state.inspect.id);
      if (module && D.files[module.file]) {
        state.codeFile = module.file;
        state.codeLine = module.start;
        state.codeJump = module.start;
      }
    }
    if (
      tab === "code" &&
      state.tab !== "code" &&
      !options.anchor &&
      state.inspect &&
      state.inspect.type === "signal" &&
      state.signal
    ) {
      placeSignalInCode(state.signal, state.inspect.originFile || "", null);
    }
    state.tab = tab;
    try {
      history.replaceState(null, "", "#" + tab);
    } catch (_) {}
    if (options.scenario) {
      state.scenario = options.scenario;
      state.step = options.step !== undefined ? options.step : 0;
      inspectStepAnchor(currentStep());
    } else if (options.step !== undefined) {
      state.step = options.step;
      inspectStepAnchor(currentStep());
    }
    closePanels();
    renderMain();
    $("#main").scrollTop = 0;
  }

  function openCode(file, line) {
    if (!D.files[file]) return;
    closeSnippetCard();
    if (!state.inspect || state.inspect.type !== "signal") state.signal = null;
    state.codeFile = file;
    state.codeLine = Math.max(1, Number(line) || 1);
    state.codeJump = state.codeLine;
    go("code", { anchor: true });
  }

  document.addEventListener("click", (event) => {
    const snippetClose = event.target.closest("[data-close-snippet]");
    if (snippetClose) {
      event.preventDefault();
      return closeSnippetCard();
    }

    const snippetTab = event.target.closest("[data-snippet-tab]");
    if (snippetTab) {
      event.preventDefault();
      return activateSnippetTab(Number(snippetTab.dataset.snippetTab));
    }

    if (
      snippetUI.open &&
      !event.target.closest("#snippetCard") &&
      !event.target.closest("#sourcePreview") &&
      !event.target.closest("#sigSnippetBtn")
    ) {
      closeSnippetCard();
    }

    const tab = event.target.closest("[data-tab]");
    if (tab) return go(tab.dataset.tab);

    const back = event.target.closest("[data-focus-back]");
    if (back) return focusBack();

    const focus = event.target.closest("[data-focus]");
    if (focus) return focusModule(focus.dataset.focus);

    const goButton = event.target.closest("[data-go]");
    if (goButton) {
      if (goButton.dataset.signal) inspectSignal(goButton.dataset.signal);
      if (goButton.dataset.focusModule) {
        state.focus = goButton.dataset.focusModule;
        state.module = goButton.dataset.focusModule;
      }
      return go(goButton.dataset.go, { scenario: goButton.dataset.scenario });
    }

    const edge = event.target.closest("[data-edge]");
    if (edge) {
      inspectEdge(edge.dataset.edge);
      return renderMain();
    }

    const edgeSelect = event.target.closest("[data-edge-select]");
    if (edgeSelect) {
      state.edge = edgeSelect.dataset.edgeSelect;
      state.inspect = { type: "edge", id: state.edge };
      return go("structure");
    }

    const drill = event.target.closest("[data-drill]");
    if (drill && drill.dataset.module) return drillModule(drill.dataset.module);

    const module = event.target.closest("[data-module]");
    if (module) {
      const target = moduleByName(module.dataset.module);
      if (!target) return;
      if (state.tab === "code" && D.files[target.file]) {
        state.codeFile = target.file;
        state.codeLine = target.start;
        state.codeJump = target.start;
        inspectModule(target.name, false);
        renderCode();
        buildSidebar();
        setCrumb("代码导航 · " + target.file + ":" + target.start);
        return;
      }
      inspectModule(target.name);
      if (state.tab === "overview" || state.tab === "structure") renderMain();
      return;
    }

    const copy = event.target.closest("[data-copy-file]");
    if (copy) {
      event.preventDefault();
      event.stopPropagation();
      return copyCodePosition(copy.dataset.copyFile, Number(copy.dataset.copyLine));
    }

    const constant = event.target.closest("[data-const]");
    if (constant) return inspectConstant(constant.dataset.const, constant.dataset.file);

    const signal = event.target.closest("[data-signal]");
    if (signal) {
      const previousModule = state.module;
      const row = signal.closest("[data-line]");
      const originFile = signal.dataset.file || (row ? state.codeFile : "");
      const originLine = Number(row ? row.dataset.line : state.codeLine) || 1;
      if (state.tab === "code" && row) {
        state.codeLine = Number(row.dataset.line);
        state.codeJump = state.codeLine;
      }
      const codeToken = Boolean(signal.closest("#codeBody .src"));
      inspectSignal(signal.dataset.signal, true, originFile);
      if (state.tab === "code") renderCode();
      if ((state.tab === "overview" || state.tab === "structure") && previousModule !== state.module) {
        if (state.tab === "structure") state.focus = state.module;
        renderMain();
      }
      if (codeToken) {
        openSignalSnippets(signal.dataset.signal, event, {
          file: originFile || state.codeFile,
          line: originLine
        });
      }
      return;
    }

    const code = event.target.closest("[data-code]");
    if (code) {
      if (code.dataset.line) return openCode(code.dataset.code, code.dataset.line);
      return openCode(code.dataset.code, 1);
    }

    const scenario = event.target.closest("[data-scenario]");
    if (scenario) {
      state.scenario = scenario.dataset.scenario;
      state.step = 0;
      inspectStepAnchor(currentStep());
      return renderMain();
    }

    const step = event.target.closest("[data-step]");
    if (step) {
      state.step = Number(step.dataset.step);
      inspectStepAnchor(currentStep());
      return renderMain();
    }

    const fsmState = event.target.closest("[data-state]");
    if (fsmState) {
      state.state = fsmState.dataset.state;
      state.inspect = { type: "state", id: state.state };
      return renderMain();
    }

    const bench = event.target.closest("[data-bench]");
    if (bench) {
      state.bench = state.bench === Number(bench.dataset.bench) ? null : Number(bench.dataset.bench);
      return renderVerify();
    }

    if (event.target.closest("[data-close-panel]")) return closePanels();
  });

  document.addEventListener("keydown", (event) => {
    const control = event.target.closest("[data-signal][role='button'], [data-const][role='button'], [data-module][role='button'], [data-edge][role='button'], [data-state][role='button'], [data-code][role='button']");
    if (control && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    if (event.key === "Escape") {
      if (snippetUI.open) {
        closeSnippetCard();
        return;
      }
      closePanels();
    }
  });

  window.addEventListener("resize", hideSnippetPreview);
  document.addEventListener("scroll", (event) => {
    if (event.target && event.target.closest && event.target.closest("#sourcePreview")) return;
    hideSnippetPreview();
  }, true);
  $("#sourcePreview").addEventListener("mouseenter", clearSnippetPreviewTimers);
  $("#sourcePreview").addEventListener("mouseleave", scheduleSnippetPreviewHide);

  $("#sigSearch").addEventListener("input", (event) => paintSidebarList(event.target.value));
  $("#themeBtn").addEventListener("click", toggleTheme);
  $("#navToggle").addEventListener("click", () => openPanel("nav"));
  $("#inspToggle").addEventListener("click", () => openPanel("inspector"));
  $("#panelBackdrop").addEventListener("click", closePanels);

  applyStoredTheme();
  applyBrand();
  renderMain();
}());
