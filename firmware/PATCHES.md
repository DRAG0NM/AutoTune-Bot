# STM32 接口改造设计

基于课程09版工程的接口设计片段。尚未完成本项目的编译、烧录及现场验收；Stop/Start确认和实际参数读回未定义，主机缺确认时拒绝继续。主机行为见[串口说明](../docs/serial.md)。

## ① 波特率提升

`Hardware/BlueSerial.c` → `BlueSerial_Init()`：

```c
/* 原值：9600 在 20Hz × 8 字段遥测下会丢帧 */
USART_InitStructure.USART_BaudRate = 115200;
```

> ⚠️ 改成有线连接后必须同步改上位机：`--baud 115200`。
> 若仍用蓝牙模块，先确认模块支持 115200，否则退回 9600 并把遥测降到 5 Hz。

---

## ② 设备时钟 + 遥测上报（20 Hz）

### 2.1 设备侧单调时钟（所有计时的唯一来源）

`User/main.c` 顶部：

```c
/* ---- 新增：设备侧唯一时间基准 ---- */
static volatile uint32_t TickMs    = 0;   /* 每个定时中断自增一次 */
static volatile uint32_t LastHbTick = 0;  /* 最近一次收到心跳时的 TickMs */
static volatile uint8_t  HbSeen    = 0;   /* 是否收到过心跳 */
```

`TIM1_UP_IRQHandler()` 开头（在所有业务逻辑之前）：

```c
TickMs++;   /* 全系统唯一时间基准：设备自己的毫秒计数 */
```

> 确认周期：原工程注释写"定时中断时间 1ms"。若TIM1中断周期不是 1ms，请按实际周期调整（例如 10ms 周期则累加 10），否则所有超时阈值都会差一个倍数。

为什么不用上位机时间戳：上位机发的是 `Date.now()`（1970 年起的 epoch），设备侧是从上电开始计数的 tick，两者不是同一个时间基准，相减没有意义。跨系统对时还会引入网络/串口抖动。设备只信自己的时钟，因此超时判断使用设备时钟。

### 2.2 遥测缓冲

`User/main.c` 顶部：

```c
/* ---- 新增：遥测缓冲与标志 ---- */
static uint8_t   TlmDiv = 0;
volatile uint8_t TlmReady = 0;
volatile float   TlmAngle, TlmTarget, TlmOut, TlmSpdL, TlmSpdR, TlmErrInt;
```

`TIM1_UP_IRQHandler()` 中，在角度环 PID 计算完成之后插入：

```c
/* ---- 新增：遥测采样（控制周期 10ms，每 5 次上报一次 → 20Hz）---- */
if (++TlmDiv >= 5)
{
    TlmDiv = 0;
    TlmAngle  = Angle;
    TlmTarget = AnglePID.Target;
    TlmOut    = AnglePID.Out;
    TlmSpdL   = LeftSpeed;    /* 按你的版本确认变量名与作用域 */
    TlmSpdR   = RightSpeed;
    TlmErrInt = AnglePID.ErrorInt;
    TlmReady  = 1;
}
```

> 为什么不在中断里直接发串口：`BlueSerial_Printf` 是阻塞式逐字节发送，20 个字符在
> 115200 下约 1.7 ms，虽然能塞进 10 ms 周期，但会挤占姿态解算的时间余量。
> 采样放中断、发送放主循环，是更稳的工程做法。

### 2.3 遥测发送

`main()` 主循环末尾（原被注释的波形打印那一行，约 `main.c:265`）：

```c
/* ---- 新增：遥测发送（替代原有被注释的 BlueSerial_Printf）---- */
if (TlmReady)
{
    TlmReady = 0;
    BlueSerial_Printf("T,%lu,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f\n",
        (unsigned long)TickMs,      /* ← 设备侧时间戳，v2 修正：原为 HostMs */
        TlmAngle, TlmTarget, TlmOut, TlmSpdL, TlmSpdR, TlmErrInt);
}
```

---

## ③ 安全护栏

`User/main.c` 顶部：

```c
/* ---- 新增：参数限幅宏 ---- */
#define PCLAMP(v,lo,hi)  ((v)<(lo)?(lo):((v)>(hi)?(hi):(v)))
```

### 3.1 参数硬限幅（保留原设计）

在 `BlueSerial_RxFlag` 处理块内，把 9 个滑杆赋值全部改成带限幅：

```c
if      (strcmp(Name, "AngleKp") == 0) { AnglePID.Kp = PCLAMP(atof(Value),  0.0f, 20.0f); }
else if (strcmp(Name, "AngleKi") == 0) { AnglePID.Ki = PCLAMP(atof(Value),  0.0f,  5.0f); }
else if (strcmp(Name, "AngleKd") == 0) { AnglePID.Kd = PCLAMP(atof(Value),  0.0f, 20.0f); }
else if (strcmp(Name, "SpeedKp") == 0) { SpeedPID.Kp = PCLAMP(atof(Value),  0.0f, 20.0f); }
/* ...其余同理... */
```

### 3.2 参数只在停机时接受（v2 新增）

在滑杆解析之前加一道门：

```c
else if (strcmp(Tag, "slider") == 0)
{
    char *Name  = strtok(NULL, ",");
    char *Value = strtok(NULL, ",");

    /* ★ v2 新增：运行中拒绝改参数。
       运行中 Kp 跳变会让 PID 输出瞬间跳一下，这是最容易把车掀翻的时刻。
       上位机的实验流程必须是：停 → 写参数 → 启动 → 采集 → 停。 */
    if (RunFlag)
    {
        BlueSerial_Printf("E,busy,%s\n", Name);   /* 回一条错误帧，上位机可记录 */
    }
    else
    {
        if (strcmp(Name, "AngleKp") == 0) { AnglePID.Kp = PCLAMP(atof(Value), 0.0f, 20.0f); }
        /* ...其余 8 个同理，保留原有赋值逻辑... */
        BlueSerial_Printf("OK,%s\n", Name);       /* 回一条确认帧 */
    }
}
```

### 3.3 急停 / 启动命令（v2 修正）

追加到 `else if` 链：

```c
else if (strcmp(Tag, "cmd") == 0)
{
    char *Cmd = strtok(NULL, ",");

    /* ★ v2 修正：动作是 RunFlag = 0，而不是清零 PWM。
       原因：PWM 清零后 10ms 中断里的 PID 会立刻把输出写回去，急停无效；
       而 RunFlag=0 会让中断走停止分支，才是真正停住。 */
    if (strcmp(Cmd, "Stop") == 0)
    {
        RunFlag  = 0;
        HbSeen   = 0;      /* 同时解除看门狗使能，避免停机期间误触发 */
    }
    if (strcmp(Cmd, "Start") == 0)
    {
        RunFlag = 0;                                       /* 先确保处于停止态 */
        PID_Init(&AnglePID);                               /* 清掉上一轮遗留的积分与状态 */
        PID_Init(&SpeedPID);
        PID_Init(&TurnPID);
        AnglePID.Out = 0; SpeedPID.Out = 0; TurnPID.Out = 0;
        RunFlag = 1;                                       /* 再启动 */
    }
    if (strcmp(Cmd, "Zero") == 0)                          /* 保留：仅复位 PID 状态，不改变运行态 */
    {
        PID_Init(&AnglePID); PID_Init(&SpeedPID); PID_Init(&TurnPID);
        AnglePID.Out = 0; SpeedPID.Out = 0; TurnPID.Out = 0;
    }
}
else if (strcmp(Tag, "hb") == 0)
{
    /* ★ v2 修正：丢弃上位机时间戳，只记录"收到时的设备时刻" */
    (void)strtok(NULL, ",");
    LastHbTick = TickMs;
    HbSeen     = 1;
}
```

### 3.4 心跳看门狗（v2 修正）

主循环中：

```c
/* ---- v2 修正：心跳看门狗 ----
   要点 a：只用设备侧时钟，不与上位机对时
   要点 b：用 (uint32_t)(a - b) 的差值形式，天然处理 32 位回绕
   要点 c：超时动作是 RunFlag = 0，不是清 PWM */
if (HbSeen && (uint32_t)(TickMs - LastHbTick) > 500)
{
    RunFlag = 0;
    HbSeen  = 0;
}
```

---

## ④ 回归测试清单（改完必须逐条验证）

> 在全部通过之前，车必须处于架空或手持状态，不得放开运行。

| # | 测试项 | 期望结果 | 关联问题 |
|---|---|---|---|
| 1 | Keil 编译 | 0 Error 0 Warning | — |
| 2 | 串口助手 115200 接左侧串口 | 收到 `T,...` 行（约 20 行/秒） | ① ② |
| 3 | 观察遥测第一列 | 数值连续递增，量级是"上电以来的毫秒数"（不是 1.7e12 那种 epoch） | v2 缺陷 3 |
| 4 | 发 `[slider,AngleKp,7]`（停机时） | OLED 上 Kp 变为 7.00，并收到 `OK,AngleKp` | ③ |
| 5 | 发 `[slider,AngleKp,99]` | Kp 被限幅为 20（不是 99） | ③ |
| 6 | 先按 K1 启动，再发 `[slider,AngleKp,9]` | 被拒绝，OLED 数值不变，收到 `E,busy,AngleKp` | v2 新增 |
| 7 | 发 `[cmd,Stop,1]` | 电机停转，且观察 10 秒不会自行恢复 | v2 缺陷 2 |
| 8 | 发 `[hb,0]` 后停止发送心跳 | 500 ms 内电机停转 | v2 缺陷 1 |
| 9 | 连续发心跳 10 秒（不发其它命令） | 车不会被误停机（v1 会每 100ms 清一次 PWM） | v2 缺陷 1 |
| 10 | 发 `[cmd,Start,1]` | 车开始平衡，PID 从干净状态起算 | ③ |
| 11 | 架空状态下改 `AngleKd` 后启动 | 遥测曲线随倾斜变化，无异常 | — |
| 12 | 原遥控器功能 | 仍可遥控前进/转向（原协议未被破坏） | — |

测试 7、8、9 是 v2 的核心验收项——用于检查急停与心跳超时。

---

## 与上位机的契约（改一侧必须同步改另一侧）

| 方向 | 帧 | 说明 |
|---|---|---|
| PC → 车 | `[slider,<Name>,<Value>]` | 原有协议 + 限幅；仅在停机时接受 |
| PC → 车 | `[cmd,Stop,1]` | 停机（`RunFlag = 0`） |
| PC → 车 | `[cmd,Start,1]` | 复位 PID 并启动（`PID_Init` → `RunFlag = 1`） |
| PC → 车 | `[cmd,Zero,1]` | 仅复位 PID 状态，不改变运行态 |
| PC → 车 | `[hb,<任意值>]` | 心跳；值被忽略，只取到达时刻 |
| 车 → PC | `T,<TickMs>,<angle>,<target>,<out>,<spdL>,<spdR>,<errInt>\n` | 遥测，时间戳为设备侧毫秒 |
| 车 → PC | `E,<code>,<name>\n` | 错误帧（如 `E,busy,AngleKp`） |
| 车 → PC | `OK,<name>\n` | 参数写入确认 |

上位机对应实现：
- 协议与限幅表 —— [`bridge/lib/protocol.js`](../bridge/lib/protocol.js)
- 实验时序（停→写参→启动→采集→停）—— [`bridge/backends/serial.js`](../bridge/backends/serial.js)

> 两侧的参数限幅表必须逐值一致（`PCLAMP` ↔ `PARAM_LIMITS`）。改了一侧忘了另一侧，
> 会出现"以为下发成功、其实被固件截断"的静默错误。

---

## 参数限幅表（固件侧取值）

| 参数 | 下限 | 上限 |
|---|---|---|
| AngleKp | 0 | 20 |
| AngleKi | 0 | 5 |
| AngleKd | 0 | 20 |
| SpeedKp | 0 | 20 |
| SpeedKi | 0 | 5 |
| SpeedKd | 0 | 20 |
| TurnKp | 0 | 20 |
| TurnKi | 0 | 10 |
| TurnKd | 0 | 20 |
| Offset | 0 | 30 |
