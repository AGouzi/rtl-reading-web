(function () {
  "use strict";

  const definitions = [
    { scope: ["tb"], type: "wire", width: 1, id: "v0", name: "clk" },
    { scope: ["tb"], type: "wire", width: 1, id: "v1", name: "rst_n" },
    { scope: ["tb"], type: "wire", width: 1, id: "v2", name: "req_valid" },
    { scope: ["tb"], type: "wire", width: 8, id: "v3", name: "req_opcode" },
    { scope: ["tb"], type: "wire", width: 1, id: "v4", name: "req_ready" },
    { scope: ["tb", "dut"], type: "reg", width: 2, id: "v5", name: "state" },
    { scope: ["tb", "dut"], type: "reg", width: 1, id: "v6", name: "req_valid_q" },
    { scope: ["tb", "dut"], type: "reg", width: 1, id: "v7", name: "work_valid" },
    { scope: ["tb", "dut"], type: "wire", width: 1, id: "v8", name: "work_ready" },
    { scope: ["tb", "dut"], type: "reg", width: 1, id: "v9", name: "resp_valid" },
    { scope: ["tb", "dut"], type: "wire", width: 1, id: "v10", name: "resp_ready" },
    { scope: ["tb", "dut"], type: "reg", width: 8, id: "v11", name: "req_error" },
    { scope: ["tb", "dut"], type: "reg", width: 32, id: "v12", name: "status_count" },
    { scope: ["tb", "dut"], type: "reg", width: 1, id: "v13", name: "packet_magic" }
  ];

  const timeline = new Map();

  function at(time, id, value) {
    if (!timeline.has(time)) timeline.set(time, new Map());
    timeline.get(time).set(id, String(value));
  }

  function binary(value, width) {
    return Number(value).toString(2).padStart(width, "0");
  }

  function scalar(time, id, value) {
    at(time, id, value);
  }

  function bus(time, id, value, width) {
    at(time, id, binary(value, width));
  }

  scalar(0, "v0", "0");
  scalar(0, "v1", "0");
  scalar(0, "v2", "0");
  bus(0, "v3", 0xa5, 8);
  scalar(0, "v4", "0");
  bus(0, "v5", 0, 2);
  scalar(0, "v6", "0");
  scalar(0, "v7", "0");
  scalar(0, "v8", "0");
  scalar(0, "v9", "0");
  scalar(0, "v10", "1");
  bus(0, "v11", 0, 8);
  bus(0, "v12", 0, 32);
  scalar(0, "v13", "0");

  for (let time = 5; time <= 700; time += 5) {
    scalar(time, "v0", time % 10 === 0 ? "0" : "1");
  }

  scalar(12, "v1", "1");
  scalar(12, "v4", "1");
  bus(15, "v12", 1, 32);
  scalar(15, "v13", "1");
  scalar(21, "v2", "1");
  scalar(25, "v6", "1");
  bus(25, "v5", 1, 2);
  scalar(32, "v8", "1");
  bus(35, "v5", 2, 2);
  scalar(35, "v7", "1");
  scalar(36, "v2", "0");
  scalar(36, "v8", "0");
  bus(45, "v5", 0, 2);
  scalar(45, "v6", "0");
  scalar(45, "v7", "0");
  bus(46, "v12", 2, 32);
  bus(55, "v5", 0, 2);

  scalar(121, "v2", "1");
  bus(121, "v3", 0x00, 8);
  scalar(121, "v13", "0");
  bus(125, "v5", 1, 2);
  scalar(125, "v6", "1");
  bus(135, "v5", 0, 2);
  scalar(135, "v6", "0");
  bus(135, "v11", 0x01, 8);
  scalar(136, "v2", "0");
  bus(145, "v11", 0x00, 8);
  bus(146, "v12", 3, 32);

  scalar(281, "v2", "1");
  bus(281, "v3", 0x5a, 8);
  scalar(281, "v13", "1");
  scalar(285, "v6", "1");
  bus(285, "v5", 1, 2);
  scalar(292, "v8", "1");
  bus(295, "v5", 2, 2);
  scalar(295, "v7", "1");
  scalar(296, "v2", "0");
  scalar(296, "v8", "0");
  scalar(305, "v9", "1");
  scalar(305, "v10", "0");
  scalar(305, "v6", "0");
  scalar(305, "v7", "0");
  bus(305, "v5", 2, 2);
  bus(315, "v5", 0, 2);
  bus(316, "v12", 4, 32);
  scalar(385, "v10", "1");
  scalar(395, "v9", "0");

  const lines = [
    "$date",
    "  2026-11-13 10:00:00",
    "$end",
    "$version",
    "  Icarus Verilog fixture",
    "$end",
    "$timescale",
    "  1ns",
    "$end",
    "$scope module tb $end"
  ];

  let activeScope = ["tb"];
  for (const definition of definitions) {
    if (definition.scope.join(".") !== activeScope.join(".")) {
      while (activeScope.length > 1 && definition.scope.slice(0, activeScope.length).join(".") !== activeScope.join(".")) {
        lines.push("$upscope $end");
        activeScope.pop();
      }
      for (let depth = activeScope.length; depth < definition.scope.length; depth += 1) {
        lines.push("$scope module " + definition.scope[depth] + " $end");
        activeScope = definition.scope.slice(0, depth + 1);
      }
    }
    lines.push("$var " + definition.type + " " + definition.width + " " + definition.id + " " + definition.name + " $end");
  }
  while (activeScope.length > 1) {
    lines.push("$upscope $end");
    activeScope.pop();
  }
  lines.push("$upscope $end");
  lines.push("$enddefinitions $end");
  lines.push("$dumpvars");

  const times = [...timeline.keys()].sort((left, right) => left - right);
  for (const time of times) {
    lines.push("#" + time);
    const changes = timeline.get(time);
    for (const definition of definitions) {
      const value = changes.get(definition.id);
      if (value == null) continue;
      lines.push(definition.width === 1 ? value + definition.id : "b" + value + " " + definition.id);
    }
    if (time === 0) lines.push("$end");
  }

  window.DEMO_WAVE_META = {
    file: "demo_pipeline_tb.vcd",
    simulator: "Icarus Verilog（虚构演示）",
    timescale: "1ns",
    generated: "2026-11-13 10:00",
    note: "仅用于演示查看器交互，不是实际仿真结果。",
    fictional: true
  };
  window.DEMO_WAVE_VCD = lines.join("\n");
})();
