(function () {
  "use strict";

  const D = window.DEMO || window.OA;
  if (!D) return;

  const fileLineCache = new Map();
  const positionCache = new Map();
  const analysisCache = new Map();
  const symbolCache = new Map();

  const escapeRegExp = (value) =>
    String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function fileLines(file) {
    if (fileLineCache.has(file)) return fileLineCache.get(file);
    const info = D.files && D.files[file];
    const lines = info && info.code ? String(info.code).replace(/\r\n?/g, "\n").split("\n") : [];
    fileLineCache.set(file, lines);
    return lines;
  }

  function stripCommentAndString(value) {
    return String(value || "")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/.*$/g, "")
      .replace(/"(?:\\.|[^"\\])*"/g, '""');
  }

  function insideBrackets(text, index) {
    let depth = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (text[cursor] === "[") depth += 1;
      else if (text[cursor] === "]") depth = Math.max(0, depth - 1);
    }
    return depth > 0;
  }

  function moduleByName(name) {
    return (D.modules || []).find((module) => module.name === name) || null;
  }

  function moduleAt(file, line) {
    const hits = (D.modules || []).filter(
      (module) => module.file === file && line >= module.start && line <= module.end
    );
    return hits[0] || null;
  }

  function splitTopLevel(text, separator) {
    const parts = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
      else if (char === separator && depth === 0) {
        parts.push(text.slice(start, index));
        start = index + 1;
      }
    }
    parts.push(text.slice(start));
    return parts;
  }

  function parameterDeclarations() {
    const found = [];
    const seen = new Set();
    const add = (item) => {
      if (!item.name || item.value == null) return;
      const key = [item.file || "", item.line || 0, item.name].join(":");
      if (seen.has(key)) return;
      seen.add(key);
      found.push(item);
    };
    for (const item of D.consts || []) {
      add({
        name: item.name,
        module: item.module || "",
        file: item.file || "",
        line: Number(item.line) || 0,
        kind: item.kind || "parameter",
        value: item.value
      });
    }
    for (const [file, info] of Object.entries(D.files || {})) {
      const code = stripCommentAndString(info.code || "").replace(/\r\n?/g, "\n");
      const keyword = /\b(parameter|localparam)\b/g;
      let hit;
      while ((hit = keyword.exec(code)) !== null) {
        let end = code.length;
        let depth = 0;
        for (let index = keyword.lastIndex; index < code.length; index += 1) {
          const char = code[index];
          if (char === "(" || char === "[" || char === "{") depth += 1;
          else if (char === ")" || char === "]" || char === "}") {
            if (depth === 0 && char === ")") {
              end = index;
              break;
            }
            depth = Math.max(0, depth - 1);
          } else if (char === ";" && depth === 0) {
            end = index;
            break;
          }
        }
        const block = code.slice(keyword.lastIndex, end);
        for (const segment of splitTopLevel(block, ",")) {
          const text = segment.replace(/^\s*(?:parameter|localparam)\b/, "").trim();
          const match = text.match(
            /^(?:(?:integer|int|logic|bit|byte|shortint|longint|time|signed|unsigned)\s+)*(?:\[[^\]]+\]\s*)?([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/
          );
          if (!match) continue;
          const nameAt = code.indexOf(match[1], hit.index);
          const line = nameAt < 0 ? 0 : code.slice(0, nameAt).split("\n").length;
          const owner = moduleAt(file, line);
          add({
            name: match[1],
            module: owner ? owner.name : "",
            file,
            line,
            kind: hit[1],
            value: match[2].trim()
          });
        }
        keyword.lastIndex = end;
      }
    }
    return found;
  }

  const constants = parameterDeclarations();

  function widthEnv(module) {
    const env = Object.create(null);
    for (const item of constants) {
      if (module && item.module === module.name) env[item.name] = item.value;
    }
    for (const item of (module && module.params) || []) {
      if (item.value != null) env[item.name] = item.value;
    }
    return env;
  }

  function evalConstExpr(expr, env, seen) {
    let text = stripCommentAndString(expr).trim();
    if (!text) return null;
    let ok = true;
    text = text.replace(
      /(\d*)'[sS]?([bBoOdDhH])([0-9a-fA-F_]+)/g,
      (_all, _size, base, digits) => {
        if (/[xz]/i.test(digits)) {
          ok = false;
          return "0";
        }
        const radix = { b: 2, o: 8, d: 10, h: 16 }[(base || "d").toLowerCase()];
        const value = parseInt(digits.replace(/_/g, ""), radix);
        if (!Number.isFinite(value)) {
          ok = false;
          return "0";
        }
        return String(value);
      }
    );
    if (!ok) return null;
    text = text.replace(/\b\d[\d_]*\b/g, (value) => value.replace(/_/g, ""));
    seen = seen || new Set();
    text = text.replace(/\b[A-Za-z_][A-Za-z0-9_$]*\b/g, (name) => {
      if (seen.has(name) || env[name] == null) {
        ok = false;
        return "0";
      }
      const value = evalConstExpr(env[name], env, new Set([...seen, name]));
      if (value == null) {
        ok = false;
        return "0";
      }
      return String(value);
    });
    if (!ok || !/^[\d\s()+\-*/%]+$/.test(text)) return null;
    try {
      const value = Function('"use strict";return (' + text + ")")();
      return Number.isFinite(value) ? Math.trunc(value) : null;
    } catch (_) {
      return null;
    }
  }

  function declarationWidth(text, name, env) {
    const source = stripCommentAndString(text);
    const hit = new RegExp("\\b" + escapeRegExp(name) + "\\b").exec(source);
    if (!hit) return null;
    const before = source.slice(0, hit.index);
    const types = /\b(input|output|inout|wire|reg|logic|integer|time|bit|byte|shortint|longint|tri|genvar)\b/g;
    let type = null;
    let match;
    while ((match = types.exec(before))) type = match;
    if (!type) return null;
    let index = type.index + type[0].length;
    const ranges = [];
    while (index < before.length) {
      while (index < before.length && /\s/.test(before[index])) index += 1;
      const sign = before.slice(index).match(/^(signed|unsigned)\b/);
      if (sign) {
        index += sign[0].length;
        continue;
      }
      if (before[index] !== "[") break;
      let depth = 1;
      let cursor = index + 1;
      while (cursor < before.length && depth) {
        if (before[cursor] === "[") depth += 1;
        else if (before[cursor] === "]") depth -= 1;
        cursor += 1;
      }
      if (depth) return null;
      ranges.push(before.slice(index + 1, cursor - 1).trim());
      index = cursor;
    }
    if (!ranges.length) {
      if (type[1] === "integer" || type[1] === "genvar") return 32;
      if (type[1] === "time") return 64;
      return 1;
    }
    let width = 1;
    for (const range of ranges) {
      const pair = range.split(":");
      if (pair.length !== 2) return null;
      const msb = evalConstExpr(pair[0], env);
      const lsb = evalConstExpr(pair[1], env);
      if (msb == null || lsb == null) return null;
      width *= Math.abs(msb - lsb) + 1;
    }
    return width > 0 ? width : null;
  }

  function declarationMemory(text, name, env) {
    const source = stripCommentAndString(text);
    const hit = new RegExp("\\b" + escapeRegExp(name) + "\\b").exec(source);
    if (!hit) return { isMemory: false, depth: null, depthText: "", depthExpr: "" };
    const after = source.slice(hit.index + name.length);
    const dimensions = [];
    let cursor = 0;
    while (cursor < after.length) {
      while (cursor < after.length && /\s/.test(after[cursor])) cursor += 1;
      if (after[cursor] !== "[") break;
      let depth = 1;
      const start = cursor + 1;
      cursor += 1;
      while (cursor < after.length && depth) {
        if (after[cursor] === "[") depth += 1;
        else if (after[cursor] === "]") depth -= 1;
        cursor += 1;
      }
      if (depth) break;
      dimensions.push(after.slice(start, cursor - 1).trim());
    }
    if (!dimensions.length) {
      return { isMemory: false, depth: null, depthText: "", depthExpr: "" };
    }
    let depth = 1;
    let resolved = true;
    for (const dimension of dimensions) {
      const pair = dimension.split(":");
      if (pair.length === 2) {
        const msb = evalConstExpr(pair[0], env);
        const lsb = evalConstExpr(pair[1], env);
        if (msb == null || lsb == null) {
          resolved = false;
          break;
        }
        depth *= Math.abs(msb - lsb) + 1;
      } else if (pair.length === 1) {
        const count = evalConstExpr(pair[0], env);
        if (count == null || count < 0) {
          resolved = false;
          break;
        }
        depth *= count;
      } else {
        resolved = false;
        break;
      }
    }
    const depthExpr = dimensions.map((dimension) => "[" + dimension + "]").join("");
    return {
      isMemory: true,
      depth: resolved && depth > 0 ? depth : null,
      depthText: resolved && depth > 0 ? depth + " 项" : depthExpr + "（未解析）",
      depthExpr
    };
  }

  function declarationsFor(name) {
    const found = [];
    const seen = new Set();
    const nameRe = new RegExp("\\b" + escapeRegExp(name) + "\\b");
    const typeRe = /\b(input|output|inout|wire|reg|logic)\b/g;
    for (const [file, info] of Object.entries(D.files || {})) {
      const lines = String(info.code || "").replace(/\r\n?/g, "\n").split("\n");
      lines.forEach((raw, lineIndex) => {
        const current = stripCommentAndString(raw);
        const currentHit = nameRe.exec(current);
        if (!currentHit || insideBrackets(current, currentHit.index)) return;
        if (/\bassign\b/.test(current) || /<=/.test(current)) return;
        let type = null;
        let match;
        const before = current.slice(0, currentHit.index);
        while ((match = typeRe.exec(before))) type = match;
        if (!type) {
          const startsName = new RegExp("^[,\\s]*" + escapeRegExp(name) + "\\b").test(current.trim());
          if (!startsName) return;
          const prefix = lines
            .slice(Math.max(0, lineIndex - 2), lineIndex)
            .map(stripCommentAndString)
            .join(" ");
          typeRe.lastIndex = 0;
          while ((match = typeRe.exec(prefix))) type = match;
        }
        typeRe.lastIndex = 0;
        if (!type) return;
        const key = file + ":" + (lineIndex + 1);
        if (seen.has(key)) return;
        seen.add(key);
        found.push({
          file,
          line: lineIndex + 1,
          kind: type[1],
          text: raw.trim()
        });
      });
    }
    return found;
  }

  function positionsFor(name, options) {
    const opts = options || {};
    const file = opts.file && D.files && D.files[opts.file] ? opts.file : "";
    const cacheKey = name + "|" + (file || "*");
    if (positionCache.has(cacheKey)) return positionCache.get(cacheKey);
    const re = new RegExp("\\b" + escapeRegExp(name) + "\\b");
    const positions = [];
    const entries = file
      ? [[file, D.files[file]]]
      : Object.entries(D.files || {});
    for (const [entryFile, info] of entries) {
      const lines = String(info.code || "").replace(/\r\n?/g, "\n").split("\n");
      lines.forEach((line, index) => {
        if (re.test(stripCommentAndString(line))) {
          positions.push({ file: entryFile, line: index + 1 });
        }
      });
    }
    const fileOrder = Object.keys(D.files || {});
    positions.sort(
      (left, right) =>
        fileOrder.indexOf(left.file) - fileOrder.indexOf(right.file) || left.line - right.line
    );
    positionCache.set(cacheKey, positions);
    return positions;
  }

  function symbolsFor(file) {
    if (!D.files || !D.files[file]) return new Set();
    if (symbolCache.has(file)) return symbolCache.get(file);
    const reserved = new Set([
      "always", "and", "assign", "begin", "bit", "byte", "case", "casex", "casez",
      "default", "else", "end", "endcase", "endmodule", "for", "function", "genvar",
      "if", "inout", "input", "integer", "logic", "longint", "module", "negedge",
      "or", "output", "parameter", "localparam", "posedge", "reg", "shortint",
      "signed", "time", "tri", "unsigned", "wire"
    ]);
    const symbols = new Set();
    const typeRe = /\b(input|output|inout|wire|reg|logic|integer|time|bit|byte|shortint|longint|tri|genvar)\b/g;
    const wordRe = /\b[A-Za-z_]\w*\b/g;
    for (const raw of fileLines(file)) {
      const text = stripCommentAndString(raw);
      if (/^\s*(?:parameter|localparam)\b/.test(text)) continue;
      if (!typeRe.test(text)) continue;
      typeRe.lastIndex = 0;
      let word;
      while ((word = wordRe.exec(text)) !== null) {
        const name = word[0];
        if (reserved.has(name) || insideBrackets(text, word.index)) continue;
        const before = text.slice(0, word.index);
        typeRe.lastIndex = 0;
        if (typeRe.test(before)) symbols.add(name);
      }
      typeRe.lastIndex = 0;
      wordRe.lastIndex = 0;
    }
    symbolCache.set(file, symbols);
    return symbols;
  }

  function assignmentsFor(name, declarations) {
    const assignment = new RegExp(
      "\\b" + escapeRegExp(name) + "\\b(?:\\s*\\[[^;]*\\])?\\s*(?:<=|=)(?!=)"
    );
    const found = [];
    for (const declaration of declarations) {
      const lines = fileLines(declaration.file);
      lines.forEach((line, index) => {
        if (!assignment.test(stripCommentAndString(line))) return;
        found.push({
          file: declaration.file,
          line: index + 1,
          text: line.trim()
        });
      });
    }
    return found;
  }

  function uniqueEvidence(items) {
    const byPosition = new Map();
    for (const item of items || []) {
      if (!item || !item.file || !item.line) continue;
      const key = item.file + ":" + item.line;
      const previous = byPosition.get(key);
      if (!previous) {
        byPosition.set(key, {
          file: item.file,
          line: item.line,
          label: item.label || "依据",
          text: item.text || ""
        });
        continue;
      }
      if (!previous.text && item.text) previous.text = item.text;
    }
    const fileOrder = Object.keys(D.files || {});
    return [...byPosition.values()].sort(
      (left, right) =>
        fileOrder.indexOf(left.file) - fileOrder.indexOf(right.file) || left.line - right.line
    );
  }

  function analyze(name, options) {
    const opts = options || {};
    const signal = (D.signals || {})[name] || {};
    const originFile = opts.file && D.files && D.files[opts.file] ? opts.file : "";
    let module = moduleByName(opts.module || signal.module) ||
      (originFile ? moduleAt(originFile, Number(opts.line) || 1) : null);
    if (!module && originFile && !Number(opts.line)) {
      const first = positionsFor(name, { file: originFile })[0];
      if (first) module = moduleAt(originFile, first.line);
    }
    const cacheKey = name + "|" + (module ? module.name : signal.file || "") + "|" + originFile;
    if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);

    let declarations = declarationsFor(name);
    let fileScoped = false;
    if (originFile) {
      const sameFile = declarations.filter((item) => item.file === originFile);
      if (sameFile.length) {
        declarations = sameFile;
        fileScoped = true;
      }
    }
    const env = widthEnv(module);
    let width = null;
    let memory = null;
    let declaration = null;
    for (const candidate of declarations) {
      if (!originFile && module && candidate.file !== module.file) continue;
      if (fileScoped && candidate.file !== originFile) continue;
      const lines = fileLines(candidate.file);
      for (let start = Math.max(1, candidate.line - 2); start <= candidate.line; start += 1) {
        const text = lines
          .slice(start - 1, candidate.line)
          .map(stripCommentAndString)
          .join(" ");
        const value = declarationWidth(text, name, env);
        if (value != null) {
          width = value;
          memory = declarationMemory(text, name, env);
          declaration = candidate;
          break;
        }
      }
      if (width != null) break;
    }

    const assignments = assignmentsFor(name, declaration ? [declaration] : declarations);
    const evidence = uniqueEvidence([
      ...(declaration
        ? [{ file: declaration.file, line: declaration.line, label: "声明", text: declaration.text }]
        : []),
      ...assignments.map((item) => ({
        file: item.file,
        line: item.line,
        label: "更新",
        text: item.text
      }))
    ]);
    const result = {
      name,
      module: module ? module.name : signal.module || "",
      dir: declaration ? /^(input|output|inout)$/.test(declaration.kind) ? declaration.kind : "" : "",
      kind: declaration ? declaration.kind : "",
      width,
      widthText: width == null ? "" : width + " bit",
      isMemory: Boolean(memory && memory.isMemory),
      depth: memory && memory.depth != null ? memory.depth : null,
      depthText: memory ? memory.depthText : "",
      depthExpr: memory ? memory.depthExpr : "",
      storageText: memory && memory.isMemory
        ? (width == null ? "" : width + " bit") +
          (memory.depth != null ? " × " + memory.depth + " 项" : memory.depthExpr ? " × " + memory.depthExpr : "")
        : width == null ? "" : width + " bit",
      declaration,
      declarations,
      assignments,
      evidence
    };
    analysisCache.set(cacheKey, result);
    return result;
  }

  window.SigSem = {
    analyze,
    positions: positionsFor,
    symbols: symbolsFor,
    constants
  };
}());
