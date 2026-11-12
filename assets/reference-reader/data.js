window.DEMO = {
  meta: {
    title: "demo_pipeline",
    subtitle: "输入帧 → 路由处理 → 响应帧",
    clock: "125 MHz",
    reset: "rst_n，异步低有效",
    note: "全部 RTL、信号和验证记录均为虚构示例"
  },

  portGroups: {
    clock_reset: "时钟与复位",
    request: "请求接口",
    response: "响应接口",
    work: "执行接口",
    event: "事件接口",
    status: "状态与错误",
    config: "配置",
    other: "其他"
  },

  externals: {
    __input: { label: "输入源", caption: "request" },
    __output: { label: "响应通道", caption: "response" }
  },

  layout: {
    __input: { x: 12, y: 150, w: 108, h: 64 },
    ingress_stage: { x: 168, y: 150, w: 150, h: 64 },
    work_router: { x: 368, y: 150, w: 150, h: 64 },
    response_stage: { x: 568, y: 150, w: 150, h: 64 },
    status_counter: { x: 368, y: 282, w: 150, h: 64 },
    __output: { x: 768, y: 150, w: 120, h: 64 }
  },

  modules: [
    {
      name: "demo_pipeline",
      label: "顶层",
      parent: null,
      file: "demo_pipeline.sv",
      start: 1,
      end: 55,
      role: "连接输入检查、任务路由、响应对齐和状态计数，负责一笔请求从接收到应答的外层控制。",
      note: "顶层只做实例连接和错误汇总，不保存业务数据；clk/rst_n 广播到四个子模块。",
      ports: [
        { name: "clk", dir: "input", width: "1", group: "clock_reset", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", group: "clock_reset", desc: "异步低有效复位" },
        { name: "req_valid", dir: "input", width: "1", group: "request", desc: "请求帧有效" },
        { name: "req_opcode", dir: "input", width: "8", group: "request", desc: "请求类型" },
        { name: "req_ready", dir: "output", width: "1", group: "request", desc: "允许接收请求" },
        { name: "resp_valid", dir: "output", width: "1", group: "response", desc: "响应帧有效" },
        { name: "resp_ready", dir: "input", width: "1", group: "response", desc: "下游接收响应" }
      ],
      units: [],
      instances: ["ingress_stage", "work_router", "response_stage", "status_counter"]
    },
    {
      name: "ingress_stage",
      label: "输入检查",
      parent: "demo_pipeline",
      file: "ingress_stage.sv",
      start: 1,
      end: 21,
      role: "接收输入拍，检查字段边界，生成一条内部请求描述符。",
      note: "格式错误只产生一拍的错误事件，不进入路由。",
      ports: [
        { name: "clk", dir: "input", width: "1", group: "clock_reset", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", group: "clock_reset", desc: "异步低有效复位" },
        { name: "req_valid", dir: "input", width: "1", group: "request", desc: "外部请求有效" },
        { name: "req_opcode", dir: "input", width: "8", group: "request", desc: "请求类型" },
        { name: "req_ready", dir: "output", width: "1", group: "request", desc: "检查层接收许可" },
        { name: "req_valid_i", dir: "output", width: "1", group: "request", desc: "内部请求有效" },
        { name: "req_error", dir: "output", width: "8", group: "status", desc: "格式错误码" }
      ],
      units: [
        {
          name: "输入寄存与错误检查",
          kind: "always",
          file: "ingress_stage.sv",
          start: 10,
          end: 20,
          desc: "在时钟沿锁存 req_valid，并在操作码为 0 时生成 0x01 错误码。"
        }
      ],
      internal: {
        height: 300,
        note: "输入采样只在 clk 上升沿更新；req_ready 的正常与复位分支都写入 1。",
        bands: [
          { y: 44, h: 152, title: "数据通路  DATA" },
          { y: 212, h: 66, title: "控制  CONTROL" }
        ],
        nodes: [
          { id: "req", x: 54, y: 78, w: 132, h: 54, shape: "port", label: "req_valid", sub: "请求有效", signal: "req_valid" },
          { id: "sample", x: 250, y: 72, w: 184, h: 66, shape: "reg", label: "输入采样", sub: "req_valid_i", code: { file: "ingress_stage.sv", line: 17 }, tip: "在时钟沿采样请求有效位" },
          { id: "valid_out", x: 500, y: 78, w: 136, h: 54, shape: "port", label: "req_valid_i", sub: "寄存后的有效位", signal: "req_valid_i" },
          { id: "opcode", x: 54, y: 148, w: 132, h: 38, shape: "port", label: "req_opcode", sub: "[7:0] 请求类型", signal: "req_opcode" },
          { id: "decode", x: 250, y: 142, w: 184, h: 48, shape: "decode", label: "opcode == 0", sub: "非法编码判定", code: { file: "ingress_stage.sv", line: 18 } },
          { id: "error_out", x: 500, y: 142, w: 136, h: 48, shape: "port", label: "req_error", sub: "0x01 / 0x00", signal: "req_error" },
          { id: "one", x: 54, y: 226, w: 132, h: 40, shape: "reg", label: "1'b1", sub: "正常分支常量", code: { file: "ingress_stage.sv", line: 16 } },
          { id: "ready_out", x: 250, y: 226, w: 184, h: 40, shape: "port", label: "req_ready", sub: "接收许可", signal: "req_ready" }
        ],
        edges: [
          { id: "req_sample", from: "req", to: "sample", label: "req_valid", kind: "data", signals: ["req_valid"], evidence: [{ file: "ingress_stage.sv", start: 17, end: 17, note: "采样 req_valid" }] },
          { id: "sample_valid", from: "sample", to: "valid_out", label: "req_valid_i", kind: "data", signals: ["req_valid_i"], evidence: [{ file: "ingress_stage.sv", start: 17, end: 17, note: "写入 req_valid_i" }] },
          { id: "opcode_decode", from: "opcode", to: "decode", label: "req_opcode", kind: "data", signals: ["req_opcode"], evidence: [{ file: "ingress_stage.sv", start: 18, end: 18, note: "操作码参与错误判定" }] },
          { id: "decode_error", from: "decode", to: "error_out", label: "req_error", kind: "error", signals: ["req_error"], evidence: [{ file: "ingress_stage.sv", start: 18, end: 18, note: "非法操作码生成 0x01" }] },
          { id: "one_ready", from: "one", to: "ready_out", label: "assign", kind: "control", signals: ["req_ready"], evidence: [{ file: "ingress_stage.sv", start: 12, end: 16, note: "复位与正常分支都写 1" }] }
        ]
      },
      instances: []
    },
    {
      name: "work_router",
      label: "任务路由",
      parent: "demo_pipeline",
      file: "work_router.sv",
      start: 1,
      end: 46,
      role: "根据请求类型选择快速通道或分块处理，并保存本笔请求的去向。",
      note: "IDLE 只接受合法请求；ACTIVE 保持 work_valid，work_ready 后进入 DONE 并产生一拍 work_done。",
      ports: [
        { name: "clk", dir: "input", width: "1", group: "clock_reset", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", group: "clock_reset", desc: "异步低有效复位" },
        { name: "req_valid", dir: "input", width: "1", group: "request", desc: "内部请求有效" },
        { name: "req_ready", dir: "input", width: "1", group: "request", desc: "上游接收许可" },
        { name: "req_error", dir: "input", width: "8", group: "status", desc: "格式错误码" },
        { name: "work_valid", dir: "output", width: "1", group: "work", desc: "任务输出有效" },
        { name: "work_ready", dir: "input", width: "1", group: "work", desc: "执行层反压" },
        { name: "work_done", dir: "output", width: "1", group: "work", desc: "任务完成事件" }
      ],
      units: [
        {
          name: "路由状态机",
          kind: "fsm",
          file: "work_router.sv",
          start: 17,
          end: 45,
          desc: "IDLE → ACTIVE → DONE 三态控制 work_valid/work_done。"
        }
      ],
      internal: {
        height: 360,
        note: "合法请求从 IDLE 进入 ACTIVE；work_ready 完成当前任务，DONE 下一拍回到 IDLE。",
        bands: [
          { y: 44, h: 184, title: "请求、任务与状态  DATA" },
          { y: 242, h: 92, title: "握手与完成  CONTROL" }
        ],
        nodes: [
          { id: "req", x: 52, y: 82, w: 132, h: 52, shape: "port", label: "req_valid", sub: "请求有效", signal: "req_valid" },
          { id: "error", x: 52, y: 150, w: 132, h: 48, shape: "port", label: "req_error", sub: "格式错误", signal: "req_error" },
          { id: "gate", x: 236, y: 78, w: 190, h: 66, shape: "decode", label: "合法请求门控", sub: "valid && ready && !error", code: { file: "work_router.sv", line: 27 }, tip: "只有合法请求才产生进入 ACTIVE 的条件" },
          { id: "fsm", x: 476, y: 66, w: 210, h: 122, shape: "fsm", label: "route_state", sub: "IDLE → ACTIVE → DONE", signal: "route_state" },
          { id: "work_valid", x: 742, y: 86, w: 140, h: 48, shape: "port", label: "work_valid", sub: "任务有效", signal: "work_valid" },
          { id: "work_done", x: 742, y: 146, w: 140, h: 48, shape: "port", label: "work_done", sub: "完成脉冲", signal: "work_done" },
          { id: "req_ready", x: 236, y: 266, w: 170, h: 44, shape: "port", label: "req_ready", sub: "上游握手", signal: "req_ready" },
          { id: "work_ready", x: 476, y: 266, w: 180, h: 44, shape: "port", label: "work_ready", sub: "执行层接收", signal: "work_ready" }
        ],
        edges: [
          { id: "req_gate", from: "req", to: "gate", label: "req_valid", kind: "data", signals: ["req_valid"], evidence: [{ file: "work_router.sv", start: 27, end: 27, note: "req_valid 参与进入条件" }] },
          { id: "error_gate", from: "error", to: "gate", label: "req_error", kind: "error", signals: ["req_error"], evidence: [{ file: "work_router.sv", start: 27, end: 27, note: "req_error 非零时关闭门控" }] },
          { id: "reqready_gate", from: "req_ready", to: "gate", label: "req_ready", kind: "control", signals: ["req_ready"], evidence: [{ file: "work_router.sv", start: 27, end: 27, note: "ready 与 valid 共同决定接收" }] },
          { id: "gate_fsm", from: "gate", to: "fsm", label: "合法", kind: "control", signals: ["req_error"], evidence: [{ file: "work_router.sv", start: 27, end: 29, note: "合法请求触发 IDLE → ACTIVE" }] },
          { id: "fsm_valid", from: "fsm", to: "work_valid", label: "ACTIVE", kind: "data", signals: ["work_valid"], evidence: [{ file: "work_router.sv", start: 29, end: 34, note: "进入或保持 ACTIVE 时 work_valid 为 1" }] },
          { id: "fsm_done", from: "fsm", to: "work_done", label: "work_ready", kind: "control", signals: ["work_done"], evidence: [{ file: "work_router.sv", start: 35, end: 37, note: "work_ready 时产生完成脉冲" }] },
          { id: "ready_fsm", from: "work_ready", to: "fsm", label: "work_ready", kind: "control", signals: ["work_ready"], evidence: [{ file: "work_router.sv", start: 35, end: 35, note: "work_ready 触发 ACTIVE → DONE" }] }
        ]
      },
      instances: [],
      fsm: "route_state"
    },
    {
      name: "response_stage",
      label: "响应对齐",
      parent: "demo_pipeline",
      file: "response_stage.sv",
      start: 1,
      end: 14,
      role: "合并执行结果与错误状态，生成响应帧并保护当前帧不被中途打断。",
      note: "响应只在帧边界切换，错误响应具有较高优先级。",
      ports: [
        { name: "clk", dir: "input", width: "1", group: "clock_reset", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", group: "clock_reset", desc: "异步低有效复位" },
        { name: "work_done", dir: "input", width: "1", group: "work", desc: "执行完成" },
        { name: "resp_valid", dir: "output", width: "1", group: "response", desc: "响应帧有效" },
        { name: "resp_ready", dir: "input", width: "1", group: "response", desc: "下游接收许可" }
      ],
      units: [
        {
          name: "响应保持",
          kind: "always",
          file: "response_stage.sv",
          start: 8,
          end: 13,
          desc: "下游未接收时保持 resp_valid，空闲或完成时接收新的 work_done。"
        }
      ],
      internal: {
        height: 330,
        note: "resp_valid 在 resp_ready 为 0 时保持；只有空闲或完成握手后才接收新的 work_done。",
        bands: [
          { y: 44, h: 154, title: "响应通路  DATA" },
          { y: 212, h: 88, title: "保持与反压  CONTROL" }
        ],
        nodes: [
          { id: "work_done", x: 54, y: 82, w: 136, h: 54, shape: "port", label: "work_done", sub: "执行完成", signal: "work_done" },
          { id: "hold", x: 264, y: 72, w: 210, h: 74, shape: "reg", label: "响应保持", sub: "resp_valid", signal: "resp_valid", tip: "下游未接收时保持当前响应" },
          { id: "valid_out", x: 560, y: 82, w: 136, h: 54, shape: "port", label: "resp_valid", sub: "响应有效", signal: "resp_valid" },
          { id: "resp_ready", x: 54, y: 222, w: 136, h: 44, shape: "port", label: "resp_ready", sub: "下游接收", signal: "resp_ready" },
          { id: "release", x: 264, y: 216, w: 210, h: 52, shape: "decode", label: "接收 / 保持", sub: "!resp_valid || resp_ready", code: { file: "response_stage.sv", line: 11 } },
          { id: "hold_path", x: 560, y: 216, w: 170, h: 52, shape: "decode", label: "反压保持", sub: "ready=0 不清有效位", code: { file: "response_stage.sv", line: 11 } }
        ],
        edges: [
          { id: "done_hold", from: "work_done", to: "hold", label: "work_done", kind: "data", signals: ["work_done"], evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "空闲或完成时接收新的 work_done" }] },
          { id: "hold_valid", from: "hold", to: "valid_out", label: "resp_valid", kind: "data", signals: ["resp_valid"], evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "保持寄存器驱动响应有效位" }] },
          { id: "ready_release", from: "resp_ready", to: "release", label: "resp_ready", kind: "control", signals: ["resp_ready"], evidence: [{ file: "response_stage.sv", start: 11, end: 11, note: "resp_ready 参与释放条件" }] },
          { id: "release_hold", from: "release", to: "hold", label: "更新", kind: "control", signals: ["resp_valid", "resp_ready"], evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "更新条件决定是否接收新的完成事件" }] },
          { id: "ready_hold", from: "resp_ready", to: "hold_path", label: "ready=0", kind: "control", signals: ["resp_ready"], evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "ready 为 0 时保持 resp_valid" }] }
        ]
      },
      storage: [
        {
          name: "resp_valid",
          kind: "保持寄存器",
          width: "1 bit",
          depth: "1 项",
          write: "work_done && (!resp_valid || resp_ready)",
          read: "resp_valid && resp_ready",
          source: "work_done",
          sink: "resp_valid",
          note: "保存当前响应是否仍待发送；不是 FIFO，也没有多条目缓存。",
          evidence: [{ file: "response_stage.sv", start: 11, end: 12 }]
        }
      ],
      instances: []
    },
    {
      name: "status_counter",
      label: "状态计数",
      parent: "demo_pipeline",
      file: "status_counter.sv",
      start: 1,
      end: 14,
      role: "统计完成、丢弃和错误次数，并把计数暴露给右侧信号详情。",
      note: "清零优先于同一拍的计数事件。",
      ports: [
        { name: "clk", dir: "input", width: "1", group: "clock_reset", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", group: "clock_reset", desc: "异步低有效复位" },
        { name: "event_valid", dir: "input", width: "1", group: "event", desc: "事件有效" },
        { name: "event_error", dir: "input", width: "1", group: "event", desc: "错误事件" },
        { name: "status_count", dir: "output", width: "32", group: "status", desc: "累计事件数" }
      ],
      units: [
        {
          name: "事件计数",
          kind: "always",
          file: "status_counter.sv",
          start: 8,
          end: 13,
          desc: "event_valid 为 1 时加一，复位清零；本示例没有单独 clear 输入。"
        }
      ],
      internal: {
        height: 300,
        note: "event_error 端口保留但当前计数逻辑未使用；status_count 是计数器寄存器，不是多条目缓存。",
        bands: [
          { y: 44, h: 132, title: "计数通路  DATA" },
          { y: 196, h: 78, title: "复位与事件  CONTROL" }
        ],
        nodes: [
          { id: "event", x: 60, y: 82, w: 150, h: 54, shape: "port", label: "event_valid", sub: "事件有效", signal: "event_valid" },
          { id: "counter", x: 302, y: 72, w: 220, h: 74, shape: "counter", label: "32 位计数器", sub: "event_valid 时 +1", signal: "status_count" },
          { id: "count_out", x: 618, y: 82, w: 150, h: 54, shape: "port", label: "status_count", sub: "累计事件数", signal: "status_count" },
          { id: "rst", x: 60, y: 218, w: 150, h: 44, shape: "port", label: "rst_n", sub: "异步低有效", code: { file: "status_counter.sv", line: 3 } },
          { id: "event_error", x: 302, y: 218, w: 190, h: 44, shape: "port", label: "event_error", sub: "保留，未参与计数", signal: "event_error" }
        ],
        edges: [
          { id: "event_counter", from: "event", to: "counter", label: "event_valid", kind: "data", signals: ["event_valid"], evidence: [{ file: "status_counter.sv", start: 11, end: 12, note: "event_valid 为 1 时计数加一" }] },
          { id: "counter_out", from: "counter", to: "count_out", label: "status_count", kind: "data", signals: ["status_count"], evidence: [{ file: "status_counter.sv", start: 9, end: 12, note: "计数器输出与更新" }] },
          { id: "rst_counter", from: "rst", to: "counter", label: "clear", kind: "control", signals: ["rst_n"], evidence: [{ file: "status_counter.sv", start: 9, end: 10, note: "复位清零优先" }] }
        ]
      },
      storage: [
        {
          name: "status_count",
          kind: "计数器寄存器",
          width: "32 bit",
          depth: "1 项",
          write: "event_valid && rst_n",
          read: "status_count",
          source: "event_valid",
          sink: "status_count",
          note: "累计事件数量并自然回绕；不是 FIFO，也没有多条目缓存。",
          evidence: [{ file: "status_counter.sv", start: 9, end: 12, note: "复位清零与递增" }]
        }
      ],
      instances: []
    }
  ],

  files: {
    "demo_pipeline.sv": {
      dir: "rtl",
      lines: 55,
      code: `module demo_pipeline (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       req_valid,
    output wire       req_ready,
    input  wire [7:0] req_opcode,
    output wire       resp_valid,
    input  wire       resp_ready
);
    wire ingress_valid;
    wire ingress_ready;
    wire [7:0] request_error;
    wire work_valid;
    wire work_ready;
    wire work_done;

    ingress_stage u_ingress (
        .clk          (clk),
        .rst_n        (rst_n),
        .req_valid    (req_valid),
        .req_opcode   (req_opcode),
        .req_ready    (ingress_ready),
        .req_valid_i  (ingress_valid),
        .req_error    (request_error)
    );

    work_router u_router (
        .clk          (clk),
        .rst_n        (rst_n),
        .req_valid    (ingress_valid),
        .req_ready    (ingress_ready),
        .req_error    (request_error),
        .work_valid   (work_valid),
        .work_ready   (work_ready),
        .work_done    (work_done)
    );

    response_stage u_response (
        .clk          (clk),
        .rst_n        (rst_n),
        .work_done    (work_done),
        .resp_valid   (resp_valid),
        .resp_ready   (resp_ready)
    );

    status_counter u_status (
        .clk          (clk),
        .rst_n        (rst_n),
        .event_valid  (work_done),
        .event_error  (|request_error),
        .status_count ()
    );

    assign req_ready = ingress_ready;
endmodule`
    },
    "ingress_stage.sv": {
      dir: "rtl",
      lines: 21,
      code: `module ingress_stage (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       req_valid,
    input  wire [7:0] req_opcode,
    output reg        req_ready,
    output reg        req_valid_i,
    output reg  [7:0] req_error
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            req_ready   <= 1'b1;
            req_valid_i <= 1'b0;
            req_error   <= 8'd0;
        end else begin
            req_ready   <= 1'b1;
            req_valid_i <= req_valid;
            req_error   <= (req_valid && req_opcode == 8'd0) ? 8'h01 : 8'd0;
        end
    end
endmodule`
    },
    "work_router.sv": {
      dir: "rtl",
      lines: 46,
      code: `module work_router (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       req_valid,
    input  wire       req_ready,
    input  wire [7:0] req_error,
    output reg        work_valid,
    input  wire       work_ready,
    output reg        work_done
);
    localparam [1:0] IDLE   = 2'd0;
    localparam [1:0] ACTIVE = 2'd1;
    localparam [1:0] DONE   = 2'd2;

    reg [1:0] route_state;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            route_state <= IDLE;
            work_valid  <= 1'b0;
            work_done   <= 1'b0;
        end else begin
            work_valid <= 1'b0;
            work_done  <= 1'b0;
            case (route_state)
                IDLE: begin
                    if (req_valid && req_ready && req_error == 0) begin
                        route_state <= ACTIVE;
                        work_valid  <= 1'b1;
                    end
                end
                ACTIVE: begin
                    work_valid <= 1'b1;
                    if (work_ready) begin
                        route_state <= DONE;
                        work_done  <= 1'b1;
                    end
                end
                DONE: begin
                    route_state <= IDLE;
                end
                default: route_state <= IDLE;
            endcase
        end
    end
endmodule`
    },
    "response_stage.sv": {
      dir: "rtl",
      lines: 14,
      code: `module response_stage (
    input  wire clk,
    input  wire rst_n,
    input  wire work_done,
    output reg  resp_valid,
    input  wire resp_ready
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            resp_valid <= 1'b0;
        else if (!resp_valid || resp_ready)
            resp_valid <= work_done;
    end
endmodule`
    },
    "status_counter.sv": {
      dir: "rtl",
      lines: 14,
      code: `module status_counter (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        event_valid,
    input  wire        event_error,
    output reg  [31:0] status_count
);
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n)
            status_count <= 32'd0;
        else if (event_valid)
            status_count <= status_count + 32'd1;
    end
endmodule`
    }
  },

  signals: {
    req_valid: {
      module: "ingress_stage",
      instance: "u_ingress",
      file: "ingress_stage.sv",
      line: 4,
      kind: "input",
      width: "1 bit",
      group: "request",
      purpose: "标记一个新请求已经到达，允许输入检查模块在时钟沿采样。",
      timing: "组合输入；只在 req_ready 同时为 1 的上升沿被接受。",
      rules: ["没有 req_valid 时不更新描述符。", "错误码只在有效请求拍计算。"],
      related: ["req_ready", "req_opcode", "req_error"],
      evidence: [
        { file: "ingress_stage.sv", start: 4, end: 4, note: "端口声明" },
        { file: "ingress_stage.sv", start: 17, end: 18, note: "在时钟沿采样并更新描述符" }
      ]
    },
    req_ready: {
      module: "ingress_stage",
      instance: "u_ingress",
      file: "ingress_stage.sv",
      line: 6,
      kind: "output",
      width: "1 bit",
      group: "request",
      purpose: "告诉上游当前一拍可以接收请求；示例模块在非复位状态保持为 1。",
      timing: "时序输出，复位后的第一个 clk 上升沿更新。",
      rules: ["复位时强制为 1。", "需要增加反压时应由内部 FIFO 满条件门控。"],
      related: ["req_valid", "req_opcode"],
      evidence: [{ file: "ingress_stage.sv", start: 12, end: 16, note: "复位与正常分支都赋值为 1" }]
    },
    req_opcode: {
      module: "ingress_stage",
      instance: "u_ingress",
      file: "ingress_stage.sv",
      line: 5,
      kind: "input",
      width: "8 bit",
      group: "request",
      purpose: "选择请求类型；示例中编码 0 被判定为非法。",
      timing: "与 req_valid 同拍输入，在时钟沿与请求一起采样。",
      rules: ["编码非 0 时 req_error 清零。", "编码 0 时产生一拍的 0x01 错误码。"],
      related: ["req_valid", "req_error"],
      evidence: [{ file: "ingress_stage.sv", start: 18, end: 18, note: "操作码比较决定错误码" }]
    },
    req_valid_i: {
      module: "ingress_stage",
      instance: "u_ingress",
      file: "ingress_stage.sv",
      line: 7,
      kind: "output reg",
      width: "1 bit",
      group: "request",
      purpose: "把输入检查后的请求有效位寄存一拍，送往任务路由。",
      timing: "在 clk 上升沿采样 req_valid；复位清零。",
      rules: ["没有 req_valid 时保持 0。", "与 req_error 同拍进入路由层。"],
      related: ["req_valid", "req_error", "work_done"],
      evidence: [{ file: "ingress_stage.sv", start: 17, end: 17, note: "寄存 req_valid" }]
    },
    req_error: {
      module: "ingress_stage",
      instance: "u_ingress",
      file: "ingress_stage.sv",
      line: 8,
      kind: "output reg",
      width: "8 bit",
      group: "status",
      purpose: "将格式错误传回路由层，避免非法请求进入执行路径。",
      timing: "与 req_valid_i 同拍寄存，下一拍进入路由判断。",
      rules: ["0 表示合法。", "0x01 表示示例非法操作码。"],
      related: ["req_opcode", "req_valid"],
      evidence: [{ file: "ingress_stage.sv", start: 18, end: 18, note: "错误码组合逻辑" }]
    },
    work_valid: {
      module: "work_router",
      instance: "u_router",
      file: "work_router.sv",
      line: 7,
      kind: "output reg",
      width: "1 bit",
      group: "work",
      purpose: "告诉执行层当前有一笔任务等待接收；在 ACTIVE 状态保持。",
      timing: "IDLE 接受合法请求时置 1；ACTIVE 保持；DONE 或复位清零。",
      rules: ["只在 ACTIVE 保持。", "work_ready 为 1 时完成本次任务。"],
      related: ["work_ready", "work_done", "route_state"],
      evidence: [
        { file: "work_router.sv", start: 29, end: 29, note: "接受请求时置位" },
        { file: "work_router.sv", start: 33, end: 33, note: "ACTIVE 保持" }
      ]
    },
    work_done: {
      module: "work_router",
      instance: "u_router",
      file: "work_router.sv",
      line: 9,
      kind: "output reg",
      width: "1 bit",
      group: "work",
      purpose: "表示一笔任务已经在执行层完成，可用于生成响应和状态计数。",
      timing: "ACTIVE 中 work_ready 为 1 时，在下一拍产生一拍 work_done。",
      rules: ["无有效任务时为 0。", "同一事件同时送 response_stage 和 status_counter。"],
      related: ["work_valid", "work_ready", "resp_valid"],
      evidence: [{ file: "work_router.sv", start: 35, end: 36, note: "work_ready 时产生完成脉冲" }]
    },
    route_state: {
      module: "work_router",
      instance: "u_router",
      file: "work_router.sv",
      line: 15,
      kind: "state reg",
      width: "2 bit",
      group: "status",
      purpose: "保存路由状态机的当前状态，决定何时置 work_valid 和产生 work_done。",
      timing: "clk 上升沿更新；低有效异步复位回到 IDLE。",
      rules: ["IDLE 只接受 req_valid && req_ready && req_error == 0。", "ACTIVE 等待 work_ready。", "DONE 下一拍回到 IDLE。"],
      related: ["work_valid", "work_done", "req_error"],
      evidence: [
        { file: "work_router.sv", start: 15, end: 15, note: "状态寄存器声明" },
        { file: "work_router.sv", start: 18, end: 43, note: "复位与状态转移" }
      ]
    },
    resp_valid: {
      module: "response_stage",
      instance: "u_response",
      file: "response_stage.sv",
      line: 5,
      kind: "output reg",
      width: "1 bit",
      group: "response",
      purpose: "表示当前响应仍待下游接收；下游未接收时保持原值。",
      timing: "空闲或 resp_ready 为 1 时，在时钟沿接收新的 work_done。",
      rules: ["resp_valid 保持且 resp_ready=0 时不自发清除。", "没有新完成事件时可清除有效位。"],
      related: ["work_done", "resp_ready"],
      evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "保持或接收新的完成事件" }]
    },
    resp_ready: {
      module: "response_stage",
      instance: "u_response",
      file: "response_stage.sv",
      line: 6,
      kind: "input",
      width: "1 bit",
      group: "response",
      purpose: "表示下游在当前一拍接收响应帧。",
      timing: "组合输入；与 resp_valid 共同决定响应是否结束。",
      rules: ["与 resp_valid 同时为 1 才完成一次响应。", "即使 ready=0，输出有效位仍保持。"],
      related: ["resp_valid", "work_done"],
      evidence: [{ file: "response_stage.sv", start: 11, end: 12, note: "ready 参与保持条件" }]
    },
    event_valid: {
      module: "status_counter",
      instance: "u_status",
      file: "status_counter.sv",
      line: 4,
      kind: "input",
      width: "1 bit",
      group: "event",
      purpose: "标记本拍有一个需要计数的事件。",
      timing: "clk 上升沿采样；为 1 时 status_count 加一。",
      rules: ["复位时清零。", "本示例没有单独 clear 输入。"],
      related: ["status_count", "work_done"],
      evidence: [{ file: "status_counter.sv", start: 11, end: 12, note: "事件有效时计数加一" }]
    },
    event_error: {
      module: "status_counter",
      instance: "u_status",
      file: "status_counter.sv",
      line: 5,
      kind: "input",
      width: "1 bit",
      group: "event",
      purpose: "标记当前事件属于错误类型，供顶层汇总使用。",
      timing: "与 event_valid 同拍输入；本示例计数逻辑未单独区分错误。",
      rules: ["顶层把 request_error 归约后接入。", "计数逻辑目前只统计事件总数。"],
      related: ["event_valid", "req_error"],
      evidence: [{ file: "demo_pipeline.sv", start: 50, end: 50, note: "request_error 归约后接入" }]
    },
    status_count: {
      module: "status_counter",
      instance: "u_status",
      file: "status_counter.sv",
      line: 6,
      kind: "output reg",
      width: "32 bit",
      group: "status",
      purpose: "累计示例事件数量，便于在右侧详情中展示状态类信号。",
      timing: "event_valid 为 1 的上升沿加 1，自然回绕。",
      rules: ["复位清零。", "本示例没有单独 clear 输入。"],
      related: ["work_done", "event_valid"],
      evidence: [{ file: "status_counter.sv", start: 9, end: 12, note: "复位清零与递增" }]
    }
  },

  edges: [
    {
      id: "in_req",
      from: "__input",
      to: "ingress_stage",
      kind: "data",
      label: "请求输入",
      signals: ["req_valid", "req_opcode", "req_ready"],
      evidence: [{ file: "demo_pipeline.sv", start: 20, end: 22, note: "顶层请求端口连接到 u_ingress" }]
    },
    {
      id: "ingress_router",
      from: "ingress_stage",
      to: "work_router",
      kind: "data",
      label: "描述符 + 错误",
      signals: ["req_valid_i", "req_ready", "req_error"],
      evidence: [{ file: "demo_pipeline.sv", start: 30, end: 32, note: "u_ingress 输出连接到 u_router" }]
    },
    {
      id: "router_resp",
      from: "work_router",
      to: "response_stage",
      kind: "data",
      label: "完成事件",
      signals: ["work_done"],
      evidence: [{ file: "demo_pipeline.sv", start: 41, end: 41, note: "work_done 送入响应对齐" }]
    },
    {
      id: "router_status",
      from: "work_router",
      to: "status_counter",
      kind: "control",
      label: "完成计数",
      signals: ["work_done"],
      labelDx: 0,
      labelDy: 0,
      evidence: [{ file: "demo_pipeline.sv", start: 49, end: 49, note: "work_done 作为 event_valid" }]
    },
    {
      id: "ingress_status",
      from: "ingress_stage",
      to: "status_counter",
      kind: "error",
      label: "错误汇总",
      signals: ["req_error"],
      toAnchorDx: -35,
      labelDx: -105,
      labelDy: 9,
      evidence: [{ file: "demo_pipeline.sv", start: 50, end: 50, note: "request_error 归约后送入 event_error" }]
    },
    {
      id: "resp_out",
      from: "response_stage",
      to: "__output",
      kind: "data",
      label: "响应输出",
      signals: ["resp_valid", "resp_ready"],
      evidence: [{ file: "demo_pipeline.sv", start: 42, end: 43, note: "响应端口连接到顶层输出" }]
    }
  ],

  fsm: {
    module: "work_router",
    name: "route_state",
    file: "work_router.sv",
    note: "复位回到 IDLE；非法请求不进入 ACTIVE。",
    states: [
      { id: "IDLE", label: "IDLE", x: 56, y: 84, desc: "等待合法请求", code: 11 },
      { id: "ACTIVE", label: "ACTIVE", x: 316, y: 84, desc: "保持 work_valid，等待 work_ready", code: 12 },
      { id: "DONE", label: "DONE", x: 576, y: 84, desc: "产生一拍 work_done 后返回空闲", code: 13 }
    ],
    transitions: [
      { from: "IDLE", to: "ACTIVE", condition: "req_valid && req_ready && req_error == 0", short: "合法请求", kind: "normal", code: 27 },
      { from: "ACTIVE", to: "DONE", condition: "work_ready", short: "work_ready", kind: "normal", code: 35 },
      { from: "DONE", to: "IDLE", condition: "1", short: "1", kind: "normal", code: 40 }
    ]
  },

  scenarios: {
    request: {
      title: "一笔请求如何推进",
      note: "示例选择格式检查通过、执行完成并由下游接收的正常路径。",
      steps: [
        {
          id: "s1",
          phase: "接收",
          condition: "req_valid && req_ready",
          action: "锁存请求类型并生成内部描述符。",
          modules: ["ingress_stage"],
          signals: ["req_valid", "req_ready"],
          edge: "in_req",
          code: { file: "ingress_stage.sv", line: 17 }
        },
        {
          id: "s2",
          phase: "检查",
          condition: "req_opcode != 0",
          action: "合法请求进入路由；非法编码产生错误事件。",
          modules: ["ingress_stage", "work_router"],
          signals: ["req_opcode", "req_error"],
          edge: "ingress_router",
          code: { file: "ingress_stage.sv", line: 18 }
        },
        {
          id: "s3",
          phase: "执行",
          condition: "work_valid && work_ready",
          action: "执行层完成任务后产生 work_done。",
          modules: ["work_router"],
          signals: ["work_valid", "work_ready", "work_done"],
          edge: "router_resp",
          code: { file: "work_router.sv", line: 35 }
        },
        {
          id: "s4",
          phase: "响应",
          condition: "resp_valid && resp_ready",
          action: "下游接收后释放当前响应。",
          modules: ["response_stage"],
          signals: ["resp_valid", "resp_ready"],
          edge: "resp_out",
          code: { file: "response_stage.sv", line: 11 }
        }
      ]
    },
    backpressure: {
      title: "下游反压时保持",
      note: "resp_ready 拉低后，当前响应保持不变，新完成事件等待。",
      steps: [
        {
          id: "b1",
          phase: "建立",
          condition: "work_done",
          action: "产生一条待发送响应。",
          modules: ["work_router", "response_stage"],
          signals: ["work_done", "resp_valid"],
          edge: "router_resp",
          code: { file: "response_stage.sv", line: 12 }
        },
        {
          id: "b2",
          phase: "等待",
          condition: "resp_valid && !resp_ready",
          action: "响应有效位保持，不重复生成。",
          modules: ["response_stage"],
          signals: ["resp_valid", "resp_ready"],
          edge: "resp_out",
          code: { file: "response_stage.sv", line: 11 }
        },
        {
          id: "b3",
          phase: "恢复",
          condition: "resp_ready",
          action: "下游恢复接收。",
          modules: ["response_stage"],
          signals: ["resp_ready"],
          edge: "resp_out",
          code: { file: "response_stage.sv", line: 6 }
        },
        {
          id: "b4",
          phase: "释放",
          condition: "resp_valid && resp_ready",
          action: "当前响应完成，输出回到空闲。",
          modules: ["response_stage"],
          signals: ["resp_valid", "resp_ready"],
          edge: "resp_out",
          code: { file: "response_stage.sv", line: 11 }
        }
      ]
    },
    error: {
      title: "非法请求怎样退出",
      note: "错误路径不进入执行层，只更新错误计数并产生错误响应。",
      steps: [
        {
          id: "e1",
          phase: "接收",
          condition: "req_valid",
          action: "采样请求。",
          modules: ["ingress_stage"],
          signals: ["req_valid"],
          edge: "in_req",
          code: { file: "ingress_stage.sv", line: 17 }
        },
        {
          id: "e2",
          phase: "拒绝",
          condition: "req_opcode == 0",
          action: "置 req_error=0x01。",
          modules: ["ingress_stage"],
          signals: ["req_opcode", "req_error"],
          edge: "ingress_status",
          code: { file: "ingress_stage.sv", line: 18 }
        },
        {
          id: "e3",
          phase: "分支",
          condition: "req_error != 0",
          action: "绕过正常任务路由。",
          modules: ["ingress_stage", "work_router"],
          signals: ["req_error"],
          edge: "ingress_router",
          code: { file: "work_router.sv", line: 27 }
        },
        {
          id: "e4",
          phase: "返回",
          condition: "resp_valid",
          action: "向下游返回错误响应。",
          modules: ["response_stage"],
          signals: ["resp_valid"],
          edge: "resp_out",
          code: { file: "response_stage.sv", line: 11 }
        }
      ]
    }
  },

  validation: {
    summary: { benches: 4, cases: 16, checks: 48, status: "虚构示例" },
    benches: [
      { name: "tb_pipeline_unit", purpose: "输入检查、路由与响应的单元路径", cases: ["U1 正常请求", "U2 操作码非法", "U3 响应反压"] },
      { name: "tb_status_counter", purpose: "计数递增与复位", cases: ["C1 单事件", "C2 连续事件", "C3 复位清零"] },
      { name: "tb_pipeline_e2e", purpose: "从输入握手到响应握手", cases: ["E1 正常帧", "E2 错误帧", "E3 反压恢复"] }
    ],
    notCovered: ["真实工程时序", "上板吞吐", "未提供的波形数据"]
  }
};
