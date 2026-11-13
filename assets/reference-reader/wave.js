(function () {
  "use strict";

  const Core = window.WaveCore;
  const modelCache = new Map();
  let state = null;
  let resizeHandler = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function query(selector) {
    return state && state.root ? state.root.querySelector(selector) : null;
  }

  function queryAll(selector) {
    return state && state.root ? [...state.root.querySelectorAll(selector)] : [];
  }

  function sourceKey(config) {
    const source = config.source || {};
    return [
      source.script || "",
      source.global || "",
      source.text ? source.text.length : "",
      config.clockPath || source.clockPath || "",
      config.rootScope || source.rootScope || "",
      source.scopePrefix || "",
      JSON.stringify(source.scopeReplacements || config.scopeReplacements || []),
      JSON.stringify(config.bitSplit || {}),
      JSON.stringify(config.scenarios || [])
    ].join("|");
  }

  function loadScript(src, globalName) {
    return new Promise((resolve, reject) => {
      if (window[globalName]) {
        resolve();
        return;
      }
      const absolute = new URL(src, document.baseURI).href;
      const existing = [...document.scripts].find((script) => script.src === absolute);
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", () => reject(new Error("无法加载 " + src)), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("无法加载 " + src));
      document.head.appendChild(script);
    });
  }

  function normalizedSource(config, metadata) {
    return Object.assign({}, config.source || {}, metadata || {});
  }

  async function readModel(config) {
    const key = sourceKey(config);
    if (modelCache.has(key)) return modelCache.get(key);

    const source = config.source || {};
    let text = source.text || config.vcd || "";
    let metadata = {};

    if (!text) {
      if (!source.script) throw new Error("波形配置缺少 source.script 或 source.text");
      if (!source.global) throw new Error("波形配置缺少 source.global");
      await loadScript(source.script, source.global);
      text = window[source.global];
      if (!text) throw new Error(source.script + " 中没有 " + source.global + " 数据");
      if (source.metaGlobal && window[source.metaGlobal]) metadata = window[source.metaGlobal];
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
    const mergedSource = normalizedSource(config, metadata);
    const model = Core.parseVcd(text, {
      source: mergedSource,
      scopePrefix: source.scopePrefix,
      rootScope: config.rootScope || source.rootScope,
      stripScopePrefixes: source.stripScopePrefixes || config.stripScopePrefixes,
      scopeReplacements: source.scopeReplacements || config.scopeReplacements,
      clockPath: config.clockPath || source.clockPath,
      clockName: config.clockName || source.clockName,
      bitSplit: config.bitSplit,
      scenarios: config.scenarios
    });
    model.source = mergedSource;
    modelCache.set(key, model);
    return model;
  }

  function renderLoading() {
    const source = state.config.source || {};
    state.root.innerHTML = `
      <div class="page-h">
        <div><div class="ttl">时序波形</div><div class="sub">读取 VCD 后建立信号树、时间窗口和采样值。</div></div>
        <span class="chip">等待 VCD</span>
      </div>
      <article class="card">
        <h3>正在解析 ${esc(source.file || source.script || "波形数据")}</h3>
        <div class="wave-load">
          <div class="wave-progress"><i id="waveProgressBar"></i></div>
          <div class="small" id="waveStatusText">准备加载 VCD…</div>
        </div>
        <p class="small muted" style="margin:9px 0 0">只读取已附带的波形文件；解析失败时不会生成推测波形。</p>
      </article>`;
    const bar = query("#waveProgressBar");
    const text = query("#waveStatusText");
    if (bar) bar.style.width = "22%";
    if (text) text.textContent = source.script ? "加载 " + source.script + "…" : "解析内嵌 VCD…";
  }

  function renderError(error) {
    state.error = error;
    const source = state.config.source || {};
    state.root.innerHTML = `
      <div class="page-h">
        <div><div class="ttl">时序波形</div><div class="sub">当前波形未能读取。</div></div>
        <span class="chip">无可用波形</span>
      </div>
      <article class="card">
        <h3>未生成波形内容</h3>
        <div class="note red">${esc(error && error.message ? error.message : String(error))}</div>
        <p class="small muted">页面不会用示意图、随机值或推导值补成“实测波形”。核对 ${esc(source.script || source.file || "VCD 来源")} 后重新打开。</p>
        <pre class="code-how">initial begin
  $dumpfile("wave.vcd");
  $dumpvars(1, tb);
end</pre>
      </article>`;
  }

  function groupChannels(group) {
    const model = state.model;
    const paths = group.paths || group.signals || [];
    return paths.map((path) => model.byPath.get(path)).filter(Boolean);
  }

  function configureGroups() {
    const model = state.model;
    const config = state.config;
    const groups = [];
    const assigned = new Set();
    const missing = [];

    for (const group of config.groups || []) {
      const declaredPaths = group.paths || group.signals || [];
      for (const path of declaredPaths) {
        if (!model.byPath.has(path)) missing.push({ path, group: group.name || "信号" });
      }
      const channels = groupChannels(group).filter((channel) => !channel.bitIndex);
      if (!channels.length) continue;
      channels.forEach((channel) => assigned.add(channel.path));
      groups.push({ name: group.name || "信号", note: group.note || "", channels });
    }

    const bitGroups = new Map();
    for (const parentPath of Object.keys(config.bitSplit || {})) {
      if (!model.byPath.has(parentPath)) {
        missing.push({ path: parentPath, group: "总线拆位" });
        continue;
      }
      const setting = config.bitSplit[parentPath];
      const groupName = setting && setting.group ? setting.group : "总线拆位";
      if (!bitGroups.has(groupName)) bitGroups.set(groupName, []);
      for (const channel of model.bitChannels) {
        if (channel.parentPath !== parentPath) continue;
        bitGroups.get(groupName).push(channel);
        assigned.add(channel.path);
      }
    }
    for (const [name, channels] of bitGroups) {
      if (channels.length) groups.push({ name, note: "", channels, bits: true });
    }

    state.groups = groups;
    state.groupedPaths = assigned;
    state.missingPaths = missing;
  }

  function defaultSelectedPaths() {
    const config = state.config;
    if (Array.isArray(config.selected) && config.selected.length) {
      return config.selected.filter((path) => state.model.byPath.has(path));
    }
    const selected = [];
    for (const group of state.groups) {
      for (const channel of group.channels) {
        if (channel.bitIndex) {
          const setting = config.bitSplit && config.bitSplit[channel.parentPath];
          if (!setting || !setting.selected) continue;
        }
        selected.push(channel.path);
      }
    }
    if (!selected.length) {
      state.model.baseChannels.slice(0, 16).forEach((channel) => selected.push(channel.path));
    }
    return selected;
  }

  function currentScenario() {
    return state.model.scenarios.find((scenario) => scenario.key === state.scenarioKey) ||
      state.model.scenarios[0];
  }

  function initializeView() {
    configureGroups();
    state.selected = new Set(defaultSelectedPaths());
    state.focusedPath = [...state.selected][0] || state.model.baseChannels[0]?.path || null;
    const scenario = state.model.scenarios[0];
    state.scenarioKey = scenario.key;
    state.view = { start: scenario.start, end: scenario.end };
    state.cursor = scenario.cursor;
    state.cycle = Core.cycleOf(state.model, state.cursor);
  }

  function sourceBadge() {
    const source = state.model.source || {};
    return source.fictional
      ? '<span class="badge derived" style="vertical-align:middle">虚构演示 VCD</span>'
      : '<span class="badge real" style="vertical-align:middle">真实 VCD</span>';
  }

  function sourceSummary() {
    const model = state.model;
    const source = model.source || {};
    return [
      source.file || state.config.source?.script || "内嵌 VCD",
      source.simulator || "仿真器未标注",
      model.timescale.text,
      Core.formatTime(model.endTime, model.timescale.ps),
      model.edges.length + " 个上升沿"
    ].join(" · ");
  }

  function renderLoaded() {
    const model = state.model;
    const source = model.source || {};
    const note = source.note
      ? `<div class="note ${source.fictional ? "amber" : ""}">${esc(source.note)}</div>`
      : "";
    state.root.innerHTML = `
      <div class="page-h">
        <div>
          <div class="ttl">时序波形 ${sourceBadge()}</div>
          <div class="sub">${esc(sourceSummary())}</div>
        </div>
        <div class="row">
          <button type="button" class="btn sm" id="waveFull">全览</button>
          <button type="button" class="btn sm" data-wave-source>数据来源</button>
        </div>
      </div>
      ${note}
      <div class="wave-work">
        <aside class="wave-sigs card">
          <div class="wave-sigs-h"><b>信号</b><span class="mini" id="waveSigCount"></span></div>
          <input class="search" id="waveSigSearch" placeholder="搜索信号 / 层级…" value="${esc(state.search)}" aria-label="搜索波形信号">
          <div class="wave-sig-tree" id="waveSigTree"></div>
        </aside>
        <section class="wave-main card">
          <div class="wave-tools">
            <span class="small muted">场景</span>
            <span class="row" id="waveScenarios"></span>
            <span class="wave-sep"></span>
            <button type="button" class="btn sm" id="waveZoomOut" title="缩小时间范围">−</button>
            <button type="button" class="btn sm" id="waveZoomIn" title="放大时间范围">＋</button>
            <button type="button" class="btn sm" id="waveFit">适配</button>
            <span class="wave-sep"></span>
            <label class="tiny dim2">cycle <input class="cyc-input" id="waveCycle" value="${state.cycle}" inputmode="numeric"></label>
            <label class="tiny dim2">时间 <input class="cyc-input" id="waveTime" style="width:92px" inputmode="decimal"> ns</label>
            <button type="button" class="btn sm" id="wavePlay">播放</button>
            <span class="tiny dim2 wave-hint">滚轮平移 · Ctrl+滚轮缩放 · 拖拽平移</span>
          </div>
          <div class="wave-viewport" id="waveViewport">
            <div class="wv-labels" id="waveLabelCol"></div>
            <div class="wv-canvas-wrap" id="waveCanvasWrap">
              <canvas id="waveCanvas" tabindex="0" aria-label="VCD 时序波形画布"></canvas>
            </div>
          </div>
          <div class="wave-foot">
            <span>窗口 <b class="mono" id="waveRangeLabel"></b></span>
            <span>游标 <b class="mono" id="waveCursorLabel"></b></span>
            <span id="waveHover" class="dim2"></span>
            <span style="margin-left:auto">变化事件 <b class="mono">${model.channels.reduce((sum, channel) => sum + channel.events, 0).toLocaleString("en-US")}</b></span>
          </div>
        </section>
      </div>
      <div class="grid g2" style="margin-top:12px">
        <article class="card">
          <h3>当前采样 <span class="section-meta">VCD 时间戳</span></h3>
          <div id="waveCycleCard" class="small"></div>
        </article>
        <article class="card">
          <h3>数据来源与采样口径</h3>
          <div id="waveSourceCard" class="small"></div>
        </article>
      </div>
      <article class="card" style="margin-top:12px">
        <h3>窗口内变化事件 <span class="badge real" style="margin-left:auto">按 VCD 时间戳</span></h3>
        <div id="waveEvents" class="scroll" style="max-height:280px"></div>
      </article>`;
    renderScenarioButtons();
    renderTree();
    buildRows();
    renderLabels();
    renderSourceCard();
    bindViewEvents();
    draw();
    updateSampleAndEvents();
  }

  function scenarioByName(key) {
    return state.model.scenarios.find((scenario) => scenario.key === key) || state.model.scenarios[0];
  }

  function renderScenarioButtons() {
    const box = query("#waveScenarios");
    if (!box) return;
    box.innerHTML = state.model.scenarios.map((scenario) =>
      `<button type="button" class="btn sm${scenario.key === state.scenarioKey ? " on" : ""}" data-wave-scenario="${esc(scenario.key)}">${esc(scenario.label)}</button>`
    ).join("");
    box.onclick = (event) => {
      const button = event.target.closest("[data-wave-scenario]");
      if (button) setScenario(button.dataset.waveScenario);
    };
  }

  function displayName(channel) {
    return channel.name;
  }

  function channelRow(channel) {
    const selected = state.selected.has(channel.path);
    const focused = state.focusedPath === channel.path;
    return `<label class="wv-ch${focused ? " on" : ""}" data-wave-path="${esc(channel.path)}" title="${esc(channel.path)}">
      <input type="checkbox" ${selected ? "checked" : ""} aria-label="${esc(channel.path)}">
      <span class="wv-ch-name mono">${esc(displayName(channel))}</span>
      <em>${channel.width}${channel.bitIndex == null ? "" : " bit"}</em>
    </label>`;
  }

  function renderTree() {
    const box = query("#waveSigTree");
    if (!box) return;
    const term = state.search.trim().toLowerCase();
    if (term) {
      const hits = state.model.channels
        .filter((channel) => (channel.name + " " + channel.path).toLowerCase().includes(term))
        .slice(0, 140);
      box.innerHTML = `<div class="wv-search-note">匹配 ${hits.length} 个，最多显示 140 个</div>` +
        (hits.length
          ? hits.map(channelRow).join("")
          : '<div class="small dim2" style="padding:6px">没有匹配信号</div>');
    } else {
      box.innerHTML = state.groups.map((group) => {
        const visible = group.channels;
        if (!visible.length) return "";
        return `<div class="wv-group">
          <div class="wv-group-h">${esc(group.name)} <span>${group.channels.length}</span></div>
          ${visible.map(channelRow).join("")}
        </div>`;
      }).join("") +
        `<div class="wv-group"><div class="wv-group-h">全部 VCD 变量</div>
          <div class="tiny dim2" style="padding:4px 6px">在搜索框输入可添加未分组信号，共 ${state.model.baseChannels.length} 个基础信号。</div>
        </div>`;
    }
    const count = query("#waveSigCount");
    if (count) count.textContent = state.model.baseChannels.length + state.model.bitChannels.length + " 个";
    box.onclick = (event) => {
      const row = event.target.closest("[data-wave-path]");
      if (!row || event.target.matches("input")) return;
      event.preventDefault();
      togglePath(row.dataset.wavePath, true);
    };
    box.onchange = (event) => {
      const checkbox = event.target.closest("[data-wave-path] input");
      if (!checkbox) return;
      togglePath(checkbox.closest("[data-wave-path]").dataset.wavePath, true);
    };
  }

  function togglePath(path, focus) {
    if (!state.model.byPath.has(path)) return;
    if (state.selected.has(path)) state.selected.delete(path);
    else state.selected.add(path);
    if (focus) state.focusedPath = path;
    buildRows();
    syncTreeState();
    renderLabels();
    draw();
    updateSampleAndEvents();
    if (focus) notifySignal(path);
  }

  function syncTreeState() {
    queryAll("[data-wave-path]").forEach((row) => {
      const path = row.dataset.wavePath;
      row.classList.toggle("on", path === state.focusedPath);
      const checkbox = row.querySelector("input");
      if (checkbox) checkbox.checked = state.selected.has(path);
    });
  }

  function buildRows() {
    const rows = [];
    const used = new Set();
    for (const group of state.groups) {
      const channels = group.channels.filter((channel) => state.selected.has(channel.path));
      if (!channels.length) continue;
      rows.push({ type: "group", name: group.name });
      channels.forEach((channel) => {
        rows.push({ type: "signal", channel });
        used.add(channel.path);
      });
    }
    const extra = [...state.selected]
      .filter((path) => !used.has(path))
      .map((path) => state.model.byPath.get(path))
      .filter(Boolean)
      .sort((left, right) => left.path.localeCompare(right.path));
    if (extra.length) {
      rows.push({ type: "group", name: "其他已选信号" });
      extra.forEach((channel) => rows.push({ type: "signal", channel }));
    }
    state.rows = rows;
  }

  function renderLabels() {
    const box = query("#waveLabelCol");
    if (!box) return;
    let html = '<div class="wv-ruler"></div>';
    for (const row of state.rows) {
      if (row.type === "group") {
        html += `<div class="wv-grouprow">${esc(row.name)}</div>`;
      } else {
        const channel = row.channel;
        html += `<div class="wv-sigrow${channel.path === state.focusedPath ? " on" : ""}" data-wave-row="${esc(channel.path)}" title="${esc(channel.path)}">
          <span class="mono">${esc(displayName(channel))}</span><em>${channel.width}</em>
        </div>`;
      }
    }
    box.innerHTML = html;
    box.onclick = (event) => {
      const row = event.target.closest("[data-wave-row]");
      if (row) {
        state.focusedPath = row.dataset.waveRow;
        syncTreeState();
        renderLabels();
        draw();
        notifySignal(state.focusedPath);
      }
    };
  }

  function rowHeight() {
    let height = 26;
    for (const row of state.rows) height += row.type === "group" ? 22 : 24;
    return Math.max(80, height);
  }

  function resolvedStateMap(channel) {
    const maps = state.config.stateMaps || {};
    return maps[channel.path] || maps[channel.name] || null;
  }

  function numericValue(value) {
    const text = String(value || "");
    if (!/^[01]+$/.test(text)) return null;
    try {
      return parseInt(text, 2);
    } catch (_) {
      return null;
    }
  }

  function formatValue(channel, value) {
    const text = String(value == null ? "x" : value);
    if (Core.hasXZ(text)) return text.includes("z") && !text.includes("x") ? "Z" : "X";
    const map = resolvedStateMap(channel);
    const number = numericValue(text);
    if (map && number != null) {
      const mapped = map[number] || map[String(number)];
      if (mapped) return String(mapped);
    }
    if (channel.bitIndex != null || channel.width === 1) return text;
    if (channel.display === "bin" || state.config.busRadix === "bin") return "0b" + text;
    if (channel.display === "dec" || state.config.busRadix === "dec") return number == null ? text : String(number);
    return Core.hexOf(text, channel.width);
  }

  function sampleChannels() {
    return state.rows
      .filter((row) => row.type === "signal")
      .map((row) => row.channel)
      .slice(0, 32);
  }

  function signalDescriptor(channel) {
    if (!channel) return null;
    const value = Core.valueAt(channel.sig, state.cursor);
    const info = (state.config.signalInfo || {})[channel.path] ||
      (state.config.signalInfo || {})[channel.name] || null;
    return {
      name: channel.name,
      path: channel.path,
      width: channel.width,
      type: channel.type,
      scope: channel.scope,
      module: channel.module,
      bitIndex: channel.bitIndex,
      parentPath: channel.parentPath,
      rawValue: value,
      displayValue: formatValue(channel, value),
      time: state.cursor,
      timeText: Core.formatTime(state.cursor, state.model.timescale.ps),
      cycle: Core.cycleOf(state.model, state.cursor),
      info
    };
  }

  function notifySignal(path) {
    if (!state || !state.callbacks || !state.callbacks.onSignal) return;
    const channel = state.model.byPath.get(path);
    const descriptor = signalDescriptor(channel);
    if (descriptor) state.callbacks.onSignal(descriptor);
  }

  function updateSampleAndEvents() {
    const sample = query("#waveCycleCard");
    if (sample) {
      const channels = sampleChannels();
      sample.innerHTML = `
        <div class="row" style="margin-bottom:7px">
          <span class="pill">cycle ${state.cycle}</span>
          <span class="pill">${esc(Core.formatTime(state.cursor, state.model.timescale.ps))}</span>
          <span class="tiny dim2">按该时刻 VCD 值读取，不插值</span>
        </div>
        ${channels.length ? `<table class="t"><thead><tr><th>信号</th><th>位宽</th><th>值</th></tr></thead><tbody>
          ${channels.map((channel) => {
            const value = Core.valueAt(channel.sig, state.cursor);
            return `<tr data-wave-sample="${esc(channel.path)}"><td class="mono">${esc(displayName(channel))}</td><td class="mono">${channel.width}</td><td class="mono">${esc(formatValue(channel, value))}</td></tr>`;
          }).join("")}
        </tbody></table>` : '<div class="small dim2">左侧尚未勾选信号。</div>'}`;
      sample.onclick = (event) => {
        const row = event.target.closest("[data-wave-sample]");
        if (row) {
          state.focusedPath = row.dataset.waveSample;
          syncTreeState();
          renderLabels();
          draw();
          notifySignal(state.focusedPath);
        }
      };
    }

    const box = query("#waveEvents");
    if (box) {
      const scenario = currentScenario();
      const events = [];
      for (const path of state.selected) {
        const channel = state.model.byPath.get(path);
        if (!channel) continue;
        let previous = Core.valueAt(channel.sig, scenario.start);
        for (let index = 0; index < channel.sig.t.length; index += 1) {
          const time = channel.sig.t[index];
          if (time < scenario.start || time > scenario.end) continue;
          const value = channel.sig.v[index];
          if (value === previous) continue;
          events.push({
            time,
            channel,
            value,
            previous
          });
          previous = value;
        }
      }
      events.sort((left, right) => left.time - right.time || left.channel.path.localeCompare(right.channel.path));
      box.innerHTML = events.length
        ? `<table class="t"><thead><tr><th>时间</th><th>cycle</th><th>信号</th><th>变化</th></tr></thead><tbody>
          ${events.slice(0, 180).map((event) => `<tr class="wave-ev" data-wave-t="${event.time}">
            <td class="mono">${esc(Core.formatTime(event.time, state.model.timescale.ps))}</td>
            <td class="mono">${Core.cycleOf(state.model, event.time)}</td>
            <td class="mono">${esc(displayName(event.channel))}</td>
            <td class="mono">${esc(formatValue(event.channel, event.previous))} → ${esc(formatValue(event.channel, event.value))}</td>
          </tr>`).join("")}
        </tbody></table>${events.length > 180 ? '<div class="tiny dim2" style="padding:7px">仅显示前 180 条变化。</div>' : ""}`
        : '<div class="small dim2" style="padding:8px">当前窗口没有所选信号的变化事件。</div>';
      box.onclick = (event) => {
        const row = event.target.closest("[data-wave-t]");
        if (row) selectTime(Number(row.dataset.waveT));
      };
    }
  }

  function renderSourceCard() {
    const box = query("#waveSourceCard");
    if (!box) return;
    const source = state.model.source || {};
    const rows = [
      ["波形文件", source.file || state.config.source?.script || "内嵌 VCD"],
      ["仿真器", source.simulator || "未标注"],
      ["时间精度", state.model.timescale.text],
      ["生成时间", source.generated || "未标注"],
      ["信号数量", state.model.baseChannels.length + " 基础 + " + state.model.bitChannels.length + " 拆位"],
      ["时钟路径", state.model.clockPath || "未识别"],
      ["采样口径", state.config.sampling || "按 VCD 时间戳取值；游标不吸附时取该时刻最近一次变化后的值。"]
    ];
    const missing = state.missingPaths || [];
    box.innerHTML = `<table class="t insp-kv"><tbody>${rows.map(([label, value]) =>
      `<tr><td>${esc(label)}</td><td class="mono">${esc(value)}</td></tr>`
    ).join("")}</tbody></table>
    ${missing.length ? `<div class="note amber" style="margin-top:8px">配置中有 ${missing.length} 个路径未出现在 VCD：${esc(missing.slice(0, 8).map((item) => item.path).join("、"))}${missing.length > 8 ? "…" : ""}</div>` : ""}
    <div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-wave-source>在详情栏展开来源</button></div>`;
  }

  function bindViewEvents() {
    const search = query("#waveSigSearch");
    if (search) {
      search.oninput = () => {
        state.search = search.value;
        renderTree();
      };
    }
    const full = query("#waveFull");
    if (full) full.onclick = fitFull;
    const fit = query("#waveFit");
    if (fit) fit.onclick = fitScenario;
    const zoomIn = query("#waveZoomIn");
    if (zoomIn) zoomIn.onclick = () => zoom(0.65, state.cursor);
    const zoomOut = query("#waveZoomOut");
    if (zoomOut) zoomOut.onclick = () => zoom(1.55, state.cursor);
    const cycle = query("#waveCycle");
    if (cycle) {
      cycle.onchange = () => {
        const index = Number(cycle.value);
        if (Number.isFinite(index)) selectEdge(index);
      };
    }
    const time = query("#waveTime");
    if (time) {
      time.onchange = () => {
        const value = Number(time.value);
        if (Number.isFinite(value)) selectTime(value * 1000 / state.model.timescale.ps);
      };
    }
    const play = query("#wavePlay");
    if (play) play.onclick = togglePlay;
    queryAll("[data-wave-source]").forEach((button) => {
      button.onclick = () => {
        if (state.callbacks && state.callbacks.onSource) state.callbacks.onSource(state.model);
      };
    });
    const canvas = query("#waveCanvas");
    if (canvas) bindCanvas(canvas);
    window.removeEventListener("resize", resizeHandler);
    resizeHandler = () => draw();
    window.addEventListener("resize", resizeHandler);
  }

  function tickStep(span) {
    const raw = span / 8;
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    const fraction = raw / power;
    const multiplier = fraction < 1.5 ? 1 : fraction < 3.5 ? 2 : fraction < 7.5 ? 5 : 10;
    return Math.max(1, Math.round(multiplier * power));
  }

  function canvasColors() {
    const styles = getComputedStyle(document.documentElement);
    const get = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      background: get("--wave-bg", "#fff"),
      grid: get("--wave-grid", "#edf1f4"),
      ruler: get("--wave-ruler", "#8c959f"),
      group: get("--wave-group", "#f3f6f9"),
      line: get("--wave-line", "#dde3e9"),
      bit: get("--wave-bit", "#1a7f37"),
      unknown: get("--wave-unknown", "#b0b8c0"),
      state: get("--wave-state", "#0b6bcb"),
      bus: get("--wave-bus", "#0550ae"),
      busLine: get("--wave-busline", "#7fa7cc"),
      cursor: get("--wave-cursor", "#bf6a00"),
      selected: get("--sel", "#e4f0fb"),
      text: get("--tx2", "#3d444d"),
      dim: get("--dim2", "#6e7781"),
      marker: get("--wave-band-line", "#0b6bcb")
    };
  }

  function drawChannel(context, channel, options) {
    const signal = channel.sig;
    if (!signal || !signal.t.length) return;
    const { xOf, y, height, width, start, end, colors } = options;
    const first = Math.max(0, Core.lowerBound(signal.t, start));
    const high = y + 4;
    const low = y + height - 4;
    const middle = (high + low) / 2;

    if (channel.width === 1) {
      let previousValue = Core.valueAt(signal, start);
      let previousY = Core.hasXZ(previousValue) ? middle : previousValue === "1" ? high : low;
      let previousColor = Core.hasXZ(previousValue) ? colors.unknown : previousValue === "1" ? colors.bit : colors.busLine;
      context.lineWidth = 1.6;
      context.strokeStyle = previousColor;
      context.beginPath();
      context.moveTo(0, previousY);
      for (let index = first; index < signal.t.length && signal.t[index] <= end; index += 1) {
        const time = signal.t[index];
        if (time < start) continue;
        const x = xOf(time);
        const value = signal.v[index];
        const nextY = Core.hasXZ(value) ? middle : value === "1" ? high : low;
        context.lineTo(x, previousY);
        if (nextY !== previousY) context.lineTo(x, nextY);
        const nextColor = Core.hasXZ(value) ? colors.unknown : value === "1" ? colors.bit : colors.busLine;
        if (nextColor !== previousColor) {
          context.stroke();
          context.strokeStyle = nextColor;
          context.beginPath();
          context.moveTo(x, nextY);
        }
        previousY = nextY;
        previousColor = nextColor;
      }
      context.lineTo(width, previousY);
      context.stroke();
      return;
    }

    context.strokeStyle = colors.busLine;
    context.lineWidth = 1.2;
    context.beginPath();
    context.moveTo(0, middle);
    context.lineTo(width, middle);
    context.stroke();

    const events = [];
    for (let index = first; index < signal.t.length && signal.t[index] <= end; index += 1) {
      if (signal.t[index] >= start) events.push({ time: signal.t[index], value: signal.v[index] });
    }
    const drawDiamond = (x) => {
      context.beginPath();
      context.moveTo(x - 3, middle + 4);
      context.lineTo(x, middle);
      context.lineTo(x + 3, middle + 4);
      context.lineTo(x, middle + 8);
      context.closePath();
      context.stroke();
    };
    let segmentStart = start;
    let segmentValue = Core.valueAt(signal, start);
    const drawLabel = (left, right, value) => {
      if (right - left < 40) return;
      const label = formatValue(channel, value);
      const mapped = resolvedStateMap(channel);
      context.save();
      context.beginPath();
      context.rect(left + 1, y + 2, Math.max(0, right - left - 3), height - 4);
      context.clip();
      context.fillStyle = Core.hasXZ(value) ? colors.unknown : mapped ? colors.state : colors.bus;
      context.font = "10px Consolas, monospace";
      context.textAlign = "left";
      context.fillText(label, left + 5, middle + 3.5);
      context.restore();
    };
    for (const event of events) {
      const x = xOf(event.time);
      drawLabel(xOf(segmentStart), x, segmentValue);
      drawDiamond(x);
      segmentStart = event.time;
      segmentValue = event.value;
    }
    drawLabel(xOf(segmentStart), width, segmentValue);
  }

  function draw() {
    if (!state || !state.model || !state.root || !query("#waveCanvas")) return;
    if (!state.rows || !state.rows.length) buildRows();
    renderLabels();
    const wrap = query("#waveCanvasWrap");
    const canvas = query("#waveCanvas");
    if (!wrap || !canvas) return;
    const width = Math.max(320, wrap.clientWidth || 640);
    const height = rowHeight();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const colors = canvasColors();
    const { start, end } = state.view;
    const span = Math.max(1, end - start);
    const xOf = (time) => Math.max(0, Math.min(width, (time - start) / span * width));

    context.clearRect(0, 0, width, height);
    context.fillStyle = colors.background;
    context.fillRect(0, 0, width, height);

    const tick = tickStep(span);
    context.font = "10px Consolas, monospace";
    context.textAlign = "left";
    for (let time = Math.ceil(start / tick) * tick; time <= end; time += tick) {
      const x = xOf(time);
      context.strokeStyle = colors.grid;
      context.beginPath();
      context.moveTo(x, 20);
      context.lineTo(x, height);
      context.stroke();
      context.fillStyle = colors.dim;
      context.fillText(Core.formatAxisTime(time, state.model.timescale.ps), x + 3, 12);
    }

    const scenario = currentScenario();
    for (const marker of scenario.markers || []) {
      if (marker.time < start || marker.time > end) continue;
      const x = xOf(marker.time);
      context.strokeStyle = marker.tone === "done" ? colors.bit : colors.marker;
      context.lineWidth = 1;
      context.setLineDash([2, 3]);
      context.beginPath();
      context.moveTo(x, 18);
      context.lineTo(x, height - 2);
      context.stroke();
      context.setLineDash([]);
      if (marker.label) {
        context.fillStyle = marker.tone === "done" ? colors.bit : colors.dim;
        context.font = "9px 'Segoe UI', sans-serif";
        context.fillText(marker.label, Math.min(width - 60, x + 3), 21);
      }
    }

    let y = 26;
    for (const row of state.rows) {
      if (row.type === "group") {
        context.fillStyle = colors.group;
        context.fillRect(0, y, width, 22);
        context.fillStyle = colors.state;
        context.font = "10px 'Segoe UI', sans-serif";
        context.fillText(row.name, 8, y + 14);
        y += 22;
        continue;
      }
      const channel = row.channel;
      if (channel.path === state.focusedPath) {
        context.fillStyle = colors.selected;
        context.fillRect(0, y, width, 24);
      }
      context.strokeStyle = colors.line;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, y + 23.5);
      context.lineTo(width, y + 23.5);
      context.stroke();
      drawChannel(context, channel, {
        xOf,
        y,
        height: 24,
        width,
        start,
        end,
        colors
      });
      y += 24;
    }

    if (!state.rows.length) {
      context.fillStyle = colors.dim;
      context.font = "12px 'Segoe UI', sans-serif";
      context.fillText("在左侧勾选信号后显示波形", 14, 56);
    }

    if (state.cursor >= start && state.cursor <= end) {
      const x = xOf(state.cursor);
      context.strokeStyle = colors.cursor;
      context.lineWidth = 1.2;
      context.setLineDash([4, 3]);
      context.beginPath();
      context.moveTo(x, 18);
      context.lineTo(x, height - 2);
      context.stroke();
      context.setLineDash([]);
      context.fillStyle = colors.cursor;
      context.beginPath();
      context.moveTo(x - 4, 18);
      context.lineTo(x + 4, 18);
      context.lineTo(x, 23);
      context.closePath();
      context.fill();
    }

    updateChrome();
  }

  function updateChrome() {
    queryAll("[data-wave-scenario]").forEach((button) => {
      button.classList.toggle("on", button.dataset.waveScenario === state.scenarioKey);
    });
    const cycle = query("#waveCycle");
    if (cycle && document.activeElement !== cycle) cycle.value = state.cycle;
    const time = query("#waveTime");
    if (time && document.activeElement !== time) {
      time.value = String(Math.round(state.cursor * state.model.timescale.ps / 1000 * 1000) / 1000);
    }
    const range = query("#waveRangeLabel");
    if (range) {
      range.textContent = Core.formatTime(state.view.start, state.model.timescale.ps) +
        " – " + Core.formatTime(state.view.end, state.model.timescale.ps);
    }
    const cursor = query("#waveCursorLabel");
    if (cursor) {
      cursor.textContent = "cycle " + state.cycle + " · " + Core.formatTime(state.cursor, state.model.timescale.ps);
    }
    const play = query("#wavePlay");
    if (play) play.textContent = state.playTimer ? "暂停" : "播放";
  }

  function setScenario(key) {
    const scenario = scenarioByName(key);
    if (!scenario) return;
    state.scenarioKey = scenario.key;
    state.view = { start: scenario.start, end: scenario.end };
    state.cursor = scenario.cursor;
    state.cycle = Core.cycleOf(state.model, state.cursor);
    draw();
    updateSampleAndEvents();
  }

  function fitFull() {
    state.view = { start: 0, end: Math.max(1, state.model.endTime) };
    draw();
  }

  function fitScenario() {
    const scenario = currentScenario();
    state.view = { start: scenario.start, end: scenario.end };
    draw();
  }

  function minSpan() {
    return Math.max(1, Math.round(1000 / state.model.timescale.ps));
  }

  function panTo(start, span) {
    const endTime = Math.max(1, state.model.endTime);
    const clampedSpan = Math.max(minSpan(), Math.min(endTime, span));
    const clampedStart = Math.max(0, Math.min(endTime - clampedSpan, start));
    state.view = { start: clampedStart, end: clampedStart + clampedSpan };
    draw();
  }

  function zoom(factor, anchor) {
    const endTime = Math.max(1, state.model.endTime);
    const span = Math.max(minSpan(), Math.min(endTime, state.view.end - state.view.start));
    const nextSpan = Math.max(minSpan(), Math.min(endTime, span * factor));
    const ratio = span > 0 ? (anchor - state.view.start) / span : 0.5;
    const start = anchor - ratio * nextSpan;
    panTo(start, nextSpan);
  }

  function selectTime(time) {
    const endTime = Math.max(1, state.model.endTime);
    state.cursor = Math.max(0, Math.min(endTime, Number(time) || 0));
    state.cycle = Core.cycleOf(state.model, state.cursor);
    draw();
    updateSampleAndEvents();
  }

  function selectEdge(index) {
    if (!state.model.edges.length) return;
    const clamped = Math.max(0, Math.min(state.model.edges.length - 1, Math.round(index)));
    state.cycle = clamped;
    state.cursor = state.model.edges[clamped];
    if (state.cursor < state.view.start || state.cursor > state.view.end) {
      const span = state.view.end - state.view.start;
      panTo(state.cursor - span * 0.35, span);
    }
    draw();
    updateSampleAndEvents();
  }

  function togglePlay() {
    if (state.playTimer) {
      clearInterval(state.playTimer);
      state.playTimer = null;
      updateChrome();
      return;
    }
    state.playTimer = setInterval(() => {
      if (!state || !state.root || !document.contains(state.root)) {
        if (state) {
          clearInterval(state.playTimer);
          state.playTimer = null;
        }
        return;
      }
      const scenario = currentScenario();
      const nextIndex = state.model.edges.findIndex((time) => time > state.cursor);
      if (nextIndex < 0 || state.model.edges[nextIndex] > scenario.end) {
        clearInterval(state.playTimer);
        state.playTimer = null;
        updateChrome();
        return;
      }
      selectEdge(nextIndex);
    }, 220);
    updateChrome();
  }

  function bindCanvas(canvas) {
    let drag = null;
    let moved = false;
    canvas.addEventListener("pointerdown", (event) => {
      drag = { x: event.clientX, start: state.view.start, end: state.view.end };
      moved = false;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const time = state.view.start + x / rect.width * (state.view.end - state.view.start);
      const hover = query("#waveHover");
      if (hover) hover.textContent = "hover " + Core.formatTime(time, state.model.timescale.ps);
      if (!drag) return;
      const delta = event.clientX - drag.x;
      if (Math.abs(delta) > 3) moved = true;
      if (!moved) return;
      const span = drag.end - drag.start;
      const shift = -delta / rect.width * span;
      panTo(drag.start + shift, span);
    });
    canvas.addEventListener("pointerup", (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const time = state.view.start + x / rect.width * (state.view.end - state.view.start);
      drag = null;
      if (!moved) selectTime(time);
      moved = false;
    });
    canvas.addEventListener("pointerleave", () => {
      drag = null;
      const hover = query("#waveHover");
      if (hover) hover.textContent = "";
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const time = state.view.start + x / rect.width * (state.view.end - state.view.start);
      if (event.ctrlKey) {
        zoom(event.deltaY > 0 ? 1.22 : 0.82, time);
      } else {
        const span = state.view.end - state.view.start;
        panTo(state.view.start + event.deltaY / 650 * span, span);
      }
    }, { passive: false });
    canvas.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      selectEdge(Core.findEdgeIndex(state.model, state.cursor) + direction);
    });
  }

  async function mount(root, config, callbacks) {
    if (!Core) {
      root.innerHTML = '<div class="card"><div class="note red">wave-core.js 未加载。</div></div>';
      return;
    }
    dispose();
    const token = {};
    state = {
      root,
      token,
      config: config || {},
      callbacks: callbacks || {},
      model: null,
      groups: [],
      selected: new Set(),
      rows: [],
      focusedPath: null,
      search: "",
      scenarioKey: null,
      view: { start: 0, end: 1 },
      cursor: 0,
      cycle: 0,
      playTimer: null,
      error: null
    };
    renderLoading();
    try {
      const model = await readModel(state.config);
      if (!state || state.token !== token) return;
      state.model = model;
      initializeView();
      renderLoaded();
      notifySignal(state.focusedPath);
    } catch (error) {
      if (!state || state.token !== token) return;
      renderError(error);
    }
  }

  function dispose() {
    if (state && state.playTimer) clearInterval(state.playTimer);
    if (resizeHandler) window.removeEventListener("resize", resizeHandler);
    resizeHandler = null;
    state = null;
  }

  function redraw() {
    if (state && state.model && state.root) draw();
  }

  window.WaveUI = {
    mount,
    dispose,
    redraw,
    valueAt(path, time) {
      if (!state || !state.model) return "x";
      const channel = state.model.byPath.get(path);
      return channel ? Core.valueAt(channel.sig, time) : "x";
    },
    get model() {
      return state ? state.model : null;
    },
    get cursor() {
      return state ? state.cursor : 0;
    },
    get view() {
      return state ? state.view : null;
    }
  };
})();
