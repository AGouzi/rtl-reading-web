# 数据模型契约

参考页的 `data.js` 是渲染器的输入格式，不是工程事实。工程名、模块名、信号名、主题、状态名和验证内容都可以替换；运行时脚本不依赖某个示例工程。

页面先调用 `RTLReaderData.resolve()`，再对可选字段做保守补齐。补齐不会把缺失的源码、连线或验证结果伪装成事实；结构性错误由 `scripts/verify_reader.cjs` 报出。

解析顺序是：显式 `window.RTL_READING_DATA` → 显式 `window.RTL_READING_DATA_GLOBAL` → 自动扫描。自动扫描发现多个候选对象时会显式失败，要求设置 `RTL_READING_DATA_GLOBAL`；不会静默选择其中一个。

## 最小输入

```js
window.RTL_READING_DATA = {
  meta: {
    title: "cpu_top",
    headline: "取指与执行路径"
  },
  modules: [
    {
      name: "cpu_top",
      parent: null,
      file: "cpu_top.v",
      start: 1,
      end: 40,
      role: "说明这个模块输入什么、做什么、输出什么。"
    }
  ],
  files: {
    "cpu_top.v": {
      code: "module cpu_top;\nendmodule\n"
    }
  },
  signals: {}
};
```

`modules` 必须是非空数组，`files` 必须是对象，且每个源码文件的 `code` 必须是字符串。模块的 `name` 唯一；有 `parent` 时父模块必须存在；`file/start/end` 必须能在同一源码快照中核对。`files` 的 `lines` 可由 `code` 自动计算，但源码必须完整保留，不能用摘要替代。

`signals` 是按标识符索引的对象。信号缺省字段会补为空字符串或空数组；若希望右栏有可读内容，应提供真实的 `purpose`、`kind`、`width`、`timing`、`evidence`。页面会用 `semantics.js` 从声明和源码位置补建未登记对象，但 `data.signals` 的展示字段不能反过来冒充 AST 证据。

## 可选页面数据

| 键 | 作用 | 缺失时的行为 |
| --- | --- | --- |
| `meta` | 标题、导语、品牌、来源边界和可选展示标签 | 使用根模块名和通用文案 |
| `edges` | 模块/外部对象之间的连线 | 结构图只显示模块，不生成假边 |
| `externals` | 外部边界对象（端口/外部世界）；模块间跨子树的连线不需要塞进 `externals`，渲染器会自动生成边界节点 | 不显示外部节点 |
| `layout` | 图节点固定坐标 | 使用自动布局 |
| `portGroups` | 端口分组显示名 | 使用数据中的分组键 |
| `scenarios` | 事务场景与步骤 | 数据流页显示明确空状态 |
| `fsm` | 状态机和转移 | 控制流页显示其他可用内容或空状态 |
| `validation` | 已验证范围、测试平台和未覆盖项 | 验证页显示空状态 |
| `wave` | VCD 数据源及查看器配置 | 时序页显示空状态 |
| `readingPath` | 总览阅读入口 | 使用“看结构 / 跟事务 / 读代码” |
| `codeShortcuts` | 代码页文件快捷入口 | 从前三个真实模块生成 |
| `defaults` | 初始模块、文件、信号、场景和 FSM 状态 | 根模块及其真实首项；不优先选择名为 `request` 的场景 |

`meta` 的通用标签可自定义：

```js
meta: {
  title: "cpu_top",
  headline: "取指与执行路径",
  moduleBadge: "审查快照",       // 可省略
  validationLabel: "验证记录",   // 可省略
  validationSource: "仿真报告",  // 可省略
  legendNote: "总线按实例端口聚合" // 可省略
}
```

不要使用 `meta.demo` 控制运行时行为，也不要把示例标题、默认场景、演示按钮或虚构统计写进 `app.js`。参考页可以用 `moduleBadge: "虚构示例"` 标识自身，但那是数据，不是渲染器规则。

## 连线与层级

`edges` 每项至少包含 `from`、`to`；推荐同时提供 `id`、`label`、`kind`、`signals`、`evidence`。端点可以是模块名，也可以是 `externals` 中的边界 ID。引用不存在的端点应由验收脚本报错，或在页面中省略并明确标注，不能静默生成悬空线。

结构图以当前焦点模块的直接子模块为可见节点。端点属于更深层模块时，渲染器投影到最近的可见祖先，并在连线详情保留 `originalFrom`/`originalTo` 和“跨越了当前层级”的说明。钻取到有父模块的中间层时，焦点模块自身和外部兄弟/父模块作为边界节点保留，详情标注“跨越了当前模块边界”；不能因为端点不在 `D.externals` 中就丢边。同一可见子树内部的边留给下钻图，不应在父层重复。

## 数据建模顺序

1. 从本次 RTL 快照提取模块、文件、实例端口和真实行号。
2. 从声明与参数表达式生成信号位宽、位置和证据。
3. 先建立存储/握手/状态事实，再生成 `edges`、`scenarios` 和 `fsm`。
4. 只把有证据的事务、波形和验证报告放进页面；没有数据时保留空状态。
5. 用 `node scripts/verify_reader.cjs <页面目录>` 检查结构、真实 DOM 交互和无控制台错误。

参考页中的 `demo_pipeline` 只用于展示视觉和交互，不是新工程的默认数据、命名或业务逻辑。
