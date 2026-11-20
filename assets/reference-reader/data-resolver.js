(function () {
  "use strict";

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

  const normalized = new WeakSet();
  let lastError = "";
  const objectValue = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const arrayValue = (value) => Array.isArray(value) ? value : [];
  const textValue = (value, fallback = "") =>
    value == null ? fallback : String(value);
  const numberValue = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  };

  function normalize(data) {
    if (!isReaderData(data) || normalized.has(data)) return data;
    normalized.add(data);

    data.meta = objectValue(data.meta);
    data.portGroups = objectValue(data.portGroups);
    data.externals = objectValue(data.externals);
    data.layout = objectValue(data.layout);
    data.signals = objectValue(data.signals);
    data.scenarios = objectValue(data.scenarios);
    data.files = objectValue(data.files);

    for (const [file, info] of Object.entries(data.files)) {
      if (!info || typeof info !== "object" || Array.isArray(info)) {
        data.files[file] = { code: "", lines: 0 };
        continue;
      }
      info.code = textValue(info.code);
      info.lines = numberValue(
        info.lines,
        info.code ? info.code.replace(/\r\n?/g, "\n").split("\n").length : 0
      );
    }

    data.modules = data.modules.map((module) => {
      if (!module || typeof module !== "object") return module;
      module.label = textValue(module.label, textValue(module.name));
      module.parent = module.parent || null;
      module.file = textValue(module.file);
      module.start = numberValue(module.start, 1);
      module.end = numberValue(module.end, module.start);
      module.role = textValue(module.role);
      module.note = textValue(module.note);
      module.ports = arrayValue(module.ports).map((port) =>
        port && typeof port === "object"
          ? {
            ...port,
            name: textValue(port.name),
            dir: textValue(port.dir),
            width: textValue(port.width),
            group: textValue(port.group, "other") || "other",
            desc: textValue(port.desc)
          }
          : port
      );
      module.units = arrayValue(module.units);
      module.instances = arrayValue(module.instances);
      if (module.storage != null) module.storage = arrayValue(module.storage);
      if (module.internal && typeof module.internal === "object") {
        module.internal.nodes = arrayValue(module.internal.nodes);
        module.internal.edges = arrayValue(module.internal.edges);
      }
      return module;
    });

    for (const [name, signalValue] of Object.entries(data.signals)) {
      let signal = signalValue;
      if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
        data.signals[name] = {};
        signal = data.signals[name];
      }
      const module = data.modules.find((item) => item && item.name === signal.module);
      signal.module = textValue(signal.module);
      signal.file = textValue(signal.file, module && module.file);
      signal.line = numberValue(signal.line, module && module.start || 1);
      signal.kind = textValue(signal.kind);
      signal.width = textValue(signal.width);
      signal.group = textValue(signal.group, "other") || "other";
      signal.purpose = textValue(signal.purpose);
      signal.timing = textValue(signal.timing);
      signal.rules = arrayValue(signal.rules);
      signal.related = arrayValue(signal.related);
      signal.evidence = arrayValue(signal.evidence);
    }

    data.edges = arrayValue(data.edges).filter(Boolean).map((edge, index) => ({
      ...edge,
      id: textValue(edge.id, `edge-${index + 1}`),
      from: textValue(edge.from),
      to: textValue(edge.to),
      label: textValue(edge.label),
      kind: textValue(edge.kind, "data") || "data",
      signals: arrayValue(edge.signals),
      evidence: arrayValue(edge.evidence)
    }));

    for (const [key, scenario] of Object.entries(data.scenarios)) {
      if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
        data.scenarios[key] = { title: key, steps: [] };
        continue;
      }
      scenario.title = textValue(scenario.title, key);
      scenario.steps = arrayValue(scenario.steps).map((step) => {
        const item = objectValue(step);
        return {
          ...item,
          phase: textValue(item.phase, "步骤"),
          condition: textValue(item.condition),
          action: textValue(item.action),
          modules: arrayValue(item.modules),
          signals: arrayValue(item.signals)
        };
      });
    }

    if (data.fsm && typeof data.fsm === "object" && !Array.isArray(data.fsm)) {
      data.fsm.states = arrayValue(data.fsm.states);
      data.fsm.transitions = arrayValue(data.fsm.transitions);
    }
    if (data.validation && typeof data.validation === "object" && !Array.isArray(data.validation)) {
      data.validation.benches = arrayValue(data.validation.benches);
      data.validation.notCovered = arrayValue(data.validation.notCovered);
    }

    const root = data.modules.find((module) => module && !module.parent) || data.modules[0];
    const configured = objectValue(data.defaults);
    const signalNames = Object.keys(data.signals);
    const scenarioNames = Object.keys(data.scenarios);
    const fsmState = data.fsm && data.fsm.initial;
    const moduleName = configured.module && data.modules.some((item) => item.name === configured.module)
      ? configured.module
      : root && root.name;
    const fileName = configured.file && data.files[configured.file]
      ? configured.file
      : root && root.file && data.files[root.file] ? root.file : Object.keys(data.files)[0] || "";
    const signalName = configured.signal && data.signals[configured.signal]
      ? configured.signal
      : signalNames.find((name) => data.signals[name].module === moduleName) || signalNames[0] || null;
    data.defaults = {
      ...configured,
      module: moduleName || null,
      file: fileName,
      line: configured.line != null
        ? numberValue(configured.line, 1)
        : root ? numberValue(root.start, 1) : 1,
      signal: signalName,
      scenario: configured.scenario && data.scenarios[configured.scenario]
        ? configured.scenario
        : scenarioNames[0] || null,
      fsmState: configured.fsmState && data.fsm && data.fsm.states.some((state) => state.id === configured.fsmState)
        ? configured.fsmState
        : fsmState && data.fsm.states.some((state) => state.id === fsmState)
          ? fsmState
          : data.fsm && data.fsm.states[0] ? data.fsm.states[0].id : null
    };
    return data;
  }

  function resolve() {
    if (isReaderData(window.RTL_READING_DATA)) return normalize(window.RTL_READING_DATA);

    const configured = window.RTL_READING_DATA_GLOBAL;
    if (typeof configured === "string" && configured) {
      if (isReaderData(window[configured])) return normalize(window[configured]);
      return fail("window.RTL_READING_DATA_GLOBAL 指向的数据对象不存在或缺少 modules/files: " + configured);
    }

    const candidates = [];
    for (const name of Object.keys(window)) {
      try {
        if (isReaderData(window[name])) candidates.push(name);
      } catch (_) {}
    }
    if (candidates.length === 1) return normalize(window[candidates[0]]);
    if (candidates.length > 1) {
      return fail("发现多个候选数据对象: " + candidates.join(", ") + "。请设置 window.RTL_READING_DATA_GLOBAL 明确选择。");
    }
    return null;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function fail(message) {
    const detail = message || "未找到 RTL 阅读数据。";
    lastError = detail;
    console.error("[RTL reader] " + detail);
    const main = document.getElementById("main");
    if (!main) return null;
    main.innerHTML = `<div class="boot-error" role="alert">
      <h1>页面数据未加载</h1>
      <p>${escapeHtml(detail)}</p>
      <p>请确认 <code>data.js</code> 在 <code>data-resolver.js</code>、<code>semantics.js</code> 和 <code>app.js</code> 之前加载，并导出 <code>window.RTL_READING_DATA</code>。</p>
      <p>如果数据使用其他全局变量名，设置 <code>window.RTL_READING_DATA_GLOBAL = "变量名"</code>，或让数据对象同时包含 <code>modules</code> 数组和 <code>files</code> 对象以便自动识别。</p>
    </div>`;
    return null;
  }

  function errorMessage() {
    return lastError;
  }

  window.RTLReaderData = { resolve, isReaderData, normalize, fail, errorMessage };
}());
