(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WaveCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIME_UNITS = {
    s: 1e12,
    ms: 1e9,
    us: 1e6,
    "µs": 1e6,
    ns: 1e3,
    ps: 1,
    fs: 1e-3
  };

  function lowerBound(values, target) {
    let low = 0;
    let high = values.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (values[middle] <= target) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  function valueAt(signal, time) {
    if (!signal || !signal.t || !signal.t.length) return "x";
    const index = lowerBound(signal.t, time);
    return index < 0 ? "x" : signal.v[index];
  }

  function hasXZ(value) {
    return /[xz]/i.test(String(value || ""));
  }

  function isBinary(value) {
    return /^[01]+$/.test(String(value || ""));
  }

  function padBinary(value, width) {
    let text = String(value == null ? "x" : value).toLowerCase();
    if (hasXZ(text)) return text;
    if (!text) text = "x";
    text = text.padStart(Math.max(1, Number(width) || 1), "0");
    return text;
  }

  function hexOf(value, width) {
    const text = padBinary(value, width);
    if (hasXZ(text)) return text.includes("z") && !text.includes("x") ? "Z" : "X";
    if (!isBinary(text)) return String(value);
    if (text.length > 64) {
      try {
        return "0x" + BigInt("0b" + text).toString(16).toUpperCase();
      } catch (_) {
        return "0x?";
      }
    }
    try {
      return "0x" + parseInt(text, 2).toString(16).toUpperCase().padStart(Math.ceil((Number(width) || 1) / 4), "0");
    } catch (_) {
      return "0x?";
    }
  }

  function parseTimescale(text) {
    const compact = String(text || "").replace(/\s+/g, "");
    const match = compact.match(/^(\d+(?:\.\d+)?)(ms|us|µs|ns|ps|fs|s)$/i);
    if (!match) return { text: compact || "unknown", ps: 1, unit: "tick", magnitude: 1 };
    const unit = match[2].toLowerCase();
    const magnitude = Number(match[1]);
    return {
      text: compact,
      ps: magnitude * TIME_UNITS[unit],
      unit,
      magnitude
    };
  }

  function parseTimeSpec(value, timescalePs) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value == null || value === "") return null;
    const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|us|µs|ns|ps|fs|s)?$/i);
    if (!match) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    if (!match[2]) return amount;
    const unit = match[2].toLowerCase();
    return amount * TIME_UNITS[unit] / Math.max(Number.EPSILON, timescalePs || 1);
  }

  function rounded(value, digits) {
    const factor = Math.pow(10, digits == null ? 3 : digits);
    return String(Math.round(value * factor) / factor);
  }

  function formatTime(ticks, timescalePs) {
    const ps = Number(ticks || 0) * Number(timescalePs || 1);
    if (Math.abs(ps) < 1e-9) {
      if (Number(timescalePs) >= 1e6) return "0 µs";
      if (Number(timescalePs) >= 1e3) return "0 ns";
      return "0 ps";
    }
    if (Math.abs(ps) >= 1e6) return rounded(ps / 1e6, 6) + " µs";
    if (Math.abs(ps) >= 1e3) return rounded(ps / 1e3, 3) + " ns";
    return rounded(ps, 3) + " ps";
  }

  function formatAxisTime(ticks, timescalePs) {
    const ps = Number(ticks || 0) * Number(timescalePs || 1);
    if (Math.abs(ps) < 1e-9) {
      if (Number(timescalePs) >= 1e6) return "0µs";
      if (Number(timescalePs) >= 1e3) return "0ns";
      return "0ps";
    }
    if (Math.abs(ps) >= 1e6) return rounded(ps / 1e6, ps % 1e6 ? 3 : 0) + "µs";
    if (Math.abs(ps) >= 1e3) return rounded(ps / 1e3, ps % 1e3 ? 1 : 0) + "ns";
    return rounded(ps, 0) + "ps";
  }

  function cleanScope(scope, options) {
    let result = String(scope || "");
    const prefixes = [].concat(
      options && options.scopePrefix ? options.scopePrefix : [],
      options && options.stripScopePrefixes ? options.stripScopePrefixes : []
    );
    for (const prefix of prefixes) {
      const normalized = String(prefix || "").replace(/\.+$/, "");
      if (normalized && (result === normalized || result.startsWith(normalized + "."))) {
        result = result.slice(normalized.length).replace(/^\./, "");
        break;
      }
    }
    const replacements = (options && options.scopeReplacements) || [];
    for (const item of replacements) {
      if (!item || !item.pattern) continue;
      try {
        result = result.replace(new RegExp(item.pattern, item.flags || ""), item.replace || "");
      } catch (_) {}
    }
    return result.replace(/^\.+|\.+$/g, "") || (options && options.rootScope) || "root";
  }

  function readCommand(lines, start) {
    const words = [];
    let end = start;
    for (; end < lines.length; end += 1) {
      const line = lines[end].trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      for (const part of parts) {
        words.push(part);
        if (part === "$end") return { words, end };
      }
    }
    return { words, end: lines.length };
  }

  function parseVcd(text, options) {
    const opts = options || {};
    const sourceText = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    const lines = sourceText.split(/\r?\n/);
    const stack = [];
    const varDefs = [];
    const signals = new Map();
    let timescale = { text: "unknown", ps: 1, unit: "tick", magnitude: 1 };
    let index = 0;

    while (index < lines.length) {
      const line = lines[index].trim();
      if (!line) {
        index += 1;
        continue;
      }
      if (line.startsWith("$comment")) {
        while (index < lines.length && !lines[index].includes("$end")) index += 1;
        index += 1;
        continue;
      }
      if (line.startsWith("$scope")) {
        const command = readCommand(lines, index);
        const name = command.words.find((word, wordIndex) => wordIndex > 1 && word !== "$end");
        if (name) stack.push(name);
        index = command.end + 1;
        continue;
      }
      if (line.startsWith("$upscope")) {
        stack.pop();
        const command = readCommand(lines, index);
        index = command.end + 1;
        continue;
      }
      if (line.startsWith("$var")) {
        const command = readCommand(lines, index);
        const type = command.words[1] || "wire";
        const width = Number(command.words[2]) || 1;
        const id = command.words[3] || "";
        const nameWords = [];
        for (let wordIndex = 4; wordIndex < command.words.length; wordIndex += 1) {
          const word = command.words[wordIndex];
          if (word === "$end" || /^\[/.test(word)) break;
          nameWords.push(word);
        }
        const name = nameWords.join(" ").replace(/^\\/, "");
        if (id && name) {
          const definition = {
            type,
            width,
            id,
            name,
            scope: stack.join(".")
          };
          varDefs.push(definition);
          if (!signals.has(id)) signals.set(id, { width, t: [], v: [] });
        }
        index = command.end + 1;
        continue;
      }
      if (line.startsWith("$timescale")) {
        const command = readCommand(lines, index);
        const value = command.words.slice(1).filter((word) => word !== "$end").join("");
        timescale = parseTimescale(value);
        index = command.end + 1;
        continue;
      }
      if (line.startsWith("$enddefinitions")) {
        index += 1;
        break;
      }
      if (line.startsWith("$")) {
        const command = readCommand(lines, index);
        index = command.end + 1;
        continue;
      }
      index += 1;
    }

    let time = 0;
    let comment = false;
    for (; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (comment) {
        if (line.includes("$end")) comment = false;
        continue;
      }
      if (line.startsWith("$comment")) {
        if (!line.slice(8).includes("$end")) comment = true;
        continue;
      }
      if (line === "$end" || line.startsWith("$dump")) continue;
      if (line[0] === "#") {
        const nextTime = Number(line.slice(1));
        if (Number.isFinite(nextTime)) time = nextTime;
        continue;
      }
      let id = "";
      let rawValue = "";
      if (/^[bBrRsS]/.test(line)) {
        const split = line.indexOf(" ");
        if (split < 0) continue;
        rawValue = line.slice(1, split);
        id = line.slice(split + 1).trim();
        if (/^[rRsS]$/i.test(line[0])) rawValue = line.slice(1, split);
      } else if (/^[01xzXZ]/.test(line)) {
        rawValue = line[0];
        id = line.slice(1).trim();
      } else {
        continue;
      }
      const signal = signals.get(id);
      if (!signal) continue;
      const value = /^[01xz]+$/i.test(rawValue)
        ? padBinary(rawValue, signal.width)
        : String(rawValue);
      const last = signal.v.length - 1;
      if (last >= 0 && signal.v[last] === value) continue;
      signal.t.push(time);
      signal.v.push(value);
    }

    const channels = [];
    const byPath = new Map();
    for (const definition of varDefs) {
      const scope = cleanScope(definition.scope, opts);
      const path = scope ? scope + "." + definition.name : definition.name;
      if (byPath.has(path)) continue;
      const signal = signals.get(definition.id);
      if (!signal) continue;
      const channel = {
        path,
        scope,
        module: scope.split(".").filter(Boolean).pop() || scope,
        name: definition.name,
        width: definition.width,
        type: definition.type,
        id: definition.id,
        bitIndex: null,
        parentPath: null,
        sig: signal,
        events: signal.t.length,
        first: signal.t.length ? signal.t[0] : 0,
        last: signal.t.length ? signal.t[signal.t.length - 1] : 0
      };
      byPath.set(path, channel);
      channels.push(channel);
    }

    const clock = opts.clockPath
      ? byPath.get(opts.clockPath)
      : channels.find((channel) => channel.name === (opts.clockName || "clk")) ||
        channels.find((channel) => channel.name === "clock");
    const edges = [];
    if (clock) {
      let previous = "0";
      for (let eventIndex = 0; eventIndex < clock.sig.t.length; eventIndex += 1) {
        const value = clock.sig.v[eventIndex];
        if (previous !== "1" && value === "1") edges.push(clock.sig.t[eventIndex]);
        previous = value;
      }
    }

    let endTime = 0;
    for (const signal of signals.values()) {
      if (signal.t.length) endTime = Math.max(endTime, signal.t[signal.t.length - 1]);
    }

    const model = {
      channels,
      baseChannels: channels.slice(),
      bitChannels: [],
      byPath,
      signals,
      edges,
      endTime,
      clockPath: clock ? clock.path : null,
      timescale,
      source: opts.source || {},
      scenarios: []
    };

    const bitSplit = opts.bitSplit || {};
    for (const parentPath of Object.keys(bitSplit)) {
      const parent = byPath.get(parentPath);
      if (!parent || parent.width < 2) continue;
      const setting = bitSplit[parentPath];
      const bits = Array.isArray(setting)
        ? setting
        : setting && Array.isArray(setting.bits)
          ? setting.bits
          : [];
      for (const bitIndex of bits) {
        const indexNumber = Number(bitIndex);
        if (!Number.isInteger(indexNumber) || indexNumber < 0 || indexNumber >= parent.width) continue;
        const path = parentPath + "[" + indexNumber + "]";
        if (byPath.has(path)) continue;
        const timeline = { width: 1, t: [], v: [] };
        let previous = null;
        for (let eventIndex = 0; eventIndex < parent.sig.t.length; eventIndex += 1) {
          const raw = String(parent.sig.v[eventIndex]);
          const offset = raw.length - 1 - indexNumber;
          const value = offset >= 0 ? raw[offset] : "x";
          if (value === previous) continue;
          timeline.t.push(parent.sig.t[eventIndex]);
          timeline.v.push(value);
          previous = value;
        }
        const channel = {
          path,
          scope: parent.scope,
          module: parent.module,
          name: parent.name + "[" + indexNumber + "]",
          width: 1,
          type: "bit",
          id: parent.id + "[" + indexNumber + "]",
          bitIndex: indexNumber,
          parentPath,
          sig: timeline,
          events: timeline.t.length,
          first: timeline.t.length ? timeline.t[0] : 0,
          last: timeline.t.length ? timeline.t[timeline.t.length - 1] : 0
        };
        byPath.set(path, channel);
        model.bitChannels.push(channel);
        model.channels.push(channel);
      }
    }

    const scenarioDefs = Array.isArray(opts.scenarios) && opts.scenarios.length
      ? opts.scenarios
      : [{ key: "all", label: "全窗口", start: 0, end: endTime || 1 }];
    model.scenarios = scenarioDefs.map((definition, scenarioIndex) => {
      const start = parseTimeSpec(definition.start, timescale.ps);
      const end = parseTimeSpec(definition.end, timescale.ps);
      const normalizedStart = Math.max(0, start == null ? 0 : start);
      const normalizedEnd = Math.max(
        normalizedStart + 1,
        end == null ? endTime || normalizedStart + 1 : Math.min(endTime || end, end)
      );
      const cursor = parseTimeSpec(definition.cursor, timescale.ps);
      const edgeInWindow = edges.find((edgeTime) => edgeTime >= normalizedStart && edgeTime <= normalizedEnd);
      const resolvedCursor = cursor == null ? edgeInWindow == null ? normalizedStart : edgeInWindow : cursor;
      return {
        key: definition.key || "scenario-" + scenarioIndex,
        label: definition.label || definition.name || "场景 " + (scenarioIndex + 1),
        start: normalizedStart,
        end: normalizedEnd,
        cursor: Math.max(normalizedStart, Math.min(normalizedEnd, resolvedCursor)),
        markers: Array.isArray(definition.markers) ? definition.markers.map((marker) => ({
          time: parseTimeSpec(marker.time, timescale.ps) || normalizedStart,
          label: marker.label || "",
          tone: marker.tone || "normal"
        })) : []
      };
    });

    return model;
  }

  function cycleOf(model, time) {
    const edges = model && model.edges ? model.edges : [];
    if (!edges.length) return 0;
    return Math.max(0, lowerBound(edges, time));
  }

  function findEdgeIndex(model, time) {
    const edges = model && model.edges ? model.edges : [];
    if (!edges.length) return -1;
    const index = lowerBound(edges, time);
    return index < 0 ? 0 : index;
  }

  function channelByPath(model, path) {
    return model && model.byPath ? model.byPath.get(path) || null : null;
  }

  return {
    lowerBound,
    valueAt,
    hasXZ,
    isBinary,
    padBinary,
    hexOf,
    parseTimescale,
    parseTimeSpec,
    formatTime,
    formatAxisTime,
    parseVcd,
    cycleOf,
    findEdgeIndex,
    channelByPath
  };
});
