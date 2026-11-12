window.DEMO = {
  meta: {
    title: "demo_pipeline",
    subtitle: "输入帧 → 路由处理 → 响应帧",
    clock: "125 MHz",
    reset: "rst_n，异步低有效",
    note: "全部 RTL、信号和验证记录均为虚构示例"
  },
  modules: [
    {
      name: "demo_pipeline",
      label: "顶层",
      parent: null,
      file: "demo_pipeline.sv",
      start: 1,
      end: 92,
      role: "连接输入、路由、响应和状态计数四个子模块，负责一笔请求从接收到应答的外层控制。",
      note: "顶层只做实例连接和错误汇总，不保存业务数据。",
      ports: [
        { name: "clk", dir: "input", width: "1", desc: "主时钟" },
        { name: "rst_n", dir: "input", width: "1", desc: "异步低有效复位" },
        { name: "req_valid", dir: "input", width: "1", desc: "请求帧有效" },
        { name: "req_ready", dir: "output", width: "1", desc: "允许接收请求" },
        { name: "resp_valid", dir: "output", width: "1", desc: "响应帧有效" },
        { name: "resp_ready", dir: "input", width: "1", desc: "下游接收响应" }
      ],
      instances: ["ingress_stage", "work_router", "response_stage", "status_counter"]
    },
    {
      name: "ingress_stage",
      label: "输入检查",
      parent: "demo_pipeline",
      file: "ingress_stage.sv",
      start: 1,
      end: 64,
      role: "接收输入拍，检查字段边界，生成一条内部请求描述符。",
      note: "格式错误只产生一拍的错误事件，不进入路由。",
      ports: [
        { name: "req_valid", dir: "input", width: "1", desc: "外部请求有效" },
        { name: "req_opcode", dir: "input", width: "8", desc: "请求类型" },
        { name: "req_ready", dir: "output", width: "1", desc: "检查层接收许可" },
        { name: "req_error", dir: "output", width: "8", desc: "格式错误码" }
      ],
      instances: []
    },
    {
      name: "work_router",
      label: "任务路由",
      parent: "demo_pipeline",
      file: "work_router.sv",
      start: 1,
      end: 79,
      role: "根据请求类型选择快速通道或分块处理，并保存本笔请求的去向。",
      note: "在请求帧第一拍锁存目标，后续载荷跟随同一目标。",
      ports: [
        { name: "req_valid", dir: "input", width: "1", desc: "内部请求有效" },
        { name: "req_opcode", dir: "input", width: "8", desc: "请求类型" },
        { name: "work_valid", dir: "output", width: "1", desc: "任务输出有效" },
        { name: "work_ready", dir: "input", width: "1", desc: "执行层反压" }
      ],
      instances: []
    },
    {
      name: "response_stage",
      label: "响应对齐",
      parent: "demo_pipeline",
      file: "response_stage.sv",
      start: 1,
      end: 71,
      role: "合并执行结果与错误状态，生成响应帧并保护当前帧不被中途打断。",
      note: "响应只在帧边界切换，错误响应具有较高优先级。",
      ports: [
        { name: "work_done", dir: "input", width: "1", desc: "执行完成" },
        { name: "resp_valid", dir: "output", width: "1", desc: "响应帧有效" },
        { name: "resp_ready", dir: "input", width: "1", desc: "下游接收许可" }
      ],
      instances: []
    },
    {
      name: "status_counter",
      label: "状态计数",
      parent: "demo_pipeline",
      file: "status_counter.sv",
      start: 1,
      end: 55,
      role: "统计完成、丢弃和错误次数，并把计数暴露给右侧信号详情。",
      note: "清零优先于同一拍的计数事件。",
      ports: [
        { name: "event_valid", dir: "input", width: "1", desc: "事件有效" },
        { name: "event_error", dir: "input", width: "1", desc: "错误事件" },
        { name: "status_count", dir: "output", width: "32", desc: "累计事件数" }
      ],
      instances: []
    }
  ],
  files: {
    "demo_pipeline.sv": {
      dir: "rtl",
      lines: 92,
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
      lines: 64,
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
      lines: 79,
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
    localparam [7:0] ERR_NONE = 8'd0;
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            work_valid <= 1'b0;
            work_done  <= 1'b0;
        end else begin
            work_valid <= req_valid && req_ready && req_error == ERR_NONE;
            work_done  <= work_valid && work_ready;
        end
    end
endmodule`
    },
    "response_stage.sv": {
      dir: "rtl",
      lines: 71,
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
      lines: 55,
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
      file: "ingress_stage.sv",
      line: 4,
      kind: "input",
      width: "1 bit",
      purpose: "标记一个新请求已经到达，允许输入检查模块在时钟沿采样。",
      timing: "组合输入；只在 req_ready 同时为 1 的上升沿被接受。",
      rules: ["没有 req_valid 时不更新描述符。", "错误码只在有效请求拍计算。"],
      related: ["req_ready", "req_opcode", "req_error"]
    },
    req_ready: {
      module: "ingress_stage",
      file: "ingress_stage.sv",
      line: 5,
      kind: "output",
      width: "1 bit",
      purpose: "告诉上游当前一拍可以接收请求；示例模块在非复位状态保持为 1。",
      timing: "时序输出，复位后的第一个 clk 上升沿更新。",
      rules: ["复位时强制为 1。", "需要增加反压时应由内部 FIFO 满条件门控。"],
      related: ["req_valid", "req_opcode"]
    },
    req_opcode: {
      module: "ingress_stage",
      file: "ingress_stage.sv",
      line: 6,
      kind: "input",
      width: "8 bit",
      purpose: "选择请求类型；示例中编码 0 被判定为非法。",
      timing: "与 req_valid 同拍输入，在时钟沿与请求一起采样。",
      rules: ["编码非 0 时 req_error 清零。", "编码 0 时产生一拍的 0x01 错误码。"],
      related: ["req_valid", "req_error"]
    },
    work_done: {
      module: "work_router",
      file: "work_router.sv",
      line: 9,
      kind: "output reg",
      width: "1 bit",
      purpose: "表示一笔任务已经在执行层完成，可用于生成响应和状态计数。",
      timing: "在 work_valid 与 work_ready 同时为 1 的下一拍置 1。",
      rules: ["无有效任务时为 0。", "同一事件同时送 response_stage 和 status_counter。"],
      related: ["work_valid", "req_ready", "resp_valid"]
    },
    resp_valid: {
      module: "response_stage",
      file: "response_stage.sv",
      line: 5,
      kind: "output reg",
      width: "1 bit",
      purpose: "表示当前响应仍待下游接收；下游未接收时保持原值。",
      timing: "空闲或 resp_ready 为 1 时，在时钟沿接收新的 work_done。",
      rules: ["resp_valid 保持且 resp_ready=0 时不自发清除。", "没有新完成事件时可清除有效位。"],
      related: ["work_done", "resp_ready"]
    },
    resp_ready: {
      module: "response_stage",
      file: "response_stage.sv",
      line: 6,
      kind: "input",
      width: "1 bit",
      purpose: "表示下游在当前一拍接收响应帧。",
      timing: "组合输入；与 resp_valid 共同决定响应是否结束。",
      rules: ["与 resp_valid 同时为 1 才完成一次响应。", "即使 ready=0，输出有效位仍保持。"],
      related: ["resp_valid", "work_done"]
    },
    status_count: {
      module: "status_counter",
      file: "status_counter.sv",
      line: 6,
      kind: "output reg",
      width: "32 bit",
      purpose: "累计示例事件数量，便于在右侧详情中展示状态类信号。",
      timing: "event_valid 为 1 的上升沿加 1，自然回绕。",
      rules: ["复位清零。", "本示例没有单独 clear 输入。"],
      related: ["work_done", "resp_valid"]
    },
    req_error: {
      module: "ingress_stage",
      file: "ingress_stage.sv",
      line: 7,
      kind: "output reg",
      width: "8 bit",
      purpose: "将格式错误传回路由层，避免非法请求进入执行路径。",
      timing: "与 req_valid_i 同拍寄存，下一拍进入路由判断。",
      rules: ["0 表示合法。", "0x01 表示示例非法操作码。"],
      related: ["req_opcode", "req_valid"]
    }
  },
  edges: [
    { from: "ingress_stage", to: "work_router", label: "request", kind: "request" },
    { from: "work_router", to: "response_stage", label: "done", kind: "data" },
    { from: "work_router", to: "status_counter", label: "event", kind: "control" },
    { from: "response_stage", to: "demo_pipeline", label: "response", kind: "data" }
  ],
  scenarios: {
    request: {
      title: "一笔请求如何推进",
      note: "示例选择格式检查通过、执行完成并由下游接收的正常路径。",
      steps: [
        ["01", "接收", "req_valid && req_ready", "锁存请求类型并生成内部描述符。"],
        ["02", "检查", "req_opcode != 0", "合法请求进入路由；非法编码产生错误事件。"],
        ["03", "执行", "work_valid && work_ready", "执行层完成任务后产生 work_done。"],
        ["04", "响应", "resp_valid && resp_ready", "下游接收后释放当前响应。"]
      ]
    },
    backpressure: {
      title: "下游反压时保持",
      note: "resp_ready 拉低后，当前响应保持不变，新完成事件等待。",
      steps: [
        ["01", "建立", "work_done", "产生一条待发送响应。"],
        ["02", "等待", "resp_valid && !resp_ready", "响应有效位保持，不重复生成。"],
        ["03", "恢复", "resp_ready", "下游恢复接收。"],
        ["04", "释放", "resp_valid && resp_ready", "当前响应完成，输出回到空闲。"]
      ]
    },
    error: {
      title: "非法请求怎样退出",
      note: "错误路径不进入执行层，只更新错误计数并产生错误响应。",
      steps: [
        ["01", "接收", "req_valid", "采样请求。"],
        ["02", "拒绝", "req_opcode == 0", "置 req_error=0x01。"],
        ["03", "分支", "req_error != 0", "绕过正常任务路由。"],
        ["04", "返回", "resp_valid", "向下游返回错误响应。"]
      ]
    }
  },
  validation: {
    summary: { benches: 3, cases: 9, checks: 27, status: "虚构示例" },
    benches: [
      { name: "tb_pipeline_unit", purpose: "输入检查、路由与响应的单元路径", cases: ["U1 正常请求", "U2 操作码非法", "U3 响应反压"] },
      { name: "tb_status_counter", purpose: "计数递增与复位", cases: ["C1 单事件", "C2 连续事件", "C3 复位清零"] },
      { name: "tb_pipeline_e2e", purpose: "从输入握手到响应握手", cases: ["E1 正常帧", "E2 错误帧", "E3 反压恢复"] }
    ],
    notCovered: ["真实工程时序", "上板吞吐", "未提供的波形数据"]
  }
};
