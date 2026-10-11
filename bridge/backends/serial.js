/** Serial execution: command ACK gates continuation; physical state remains unknown without readback. */

import { performance } from 'node:perf_hooks';
import { encodeSlider, encodeCmd, encodeHeartbeat, parseTelemetry, TUNABLE } from '../lib/protocol.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultClock = () => performance.now();
const UNKNOWN_DEVICE_STATE = 'unknown';
const DEFAULT_OPERATION_TIMEOUT_MS = 2000;

function prepareGainFrames(gains, requireAll = false) {
  if (!gains || typeof gains !== 'object' || Array.isArray(gains)) throw new Error('串口参数必须是对象；设备状态未知');
  const entries = Object.entries(gains);
  if (!entries.length || (requireAll && !TUNABLE.every((name) => Object.hasOwn(gains, name))))
    throw new Error('串口 trial 必须显式提供全部三个角度环参数；设备状态未知');
  return entries.map(([name, value]) => {
    if (!TUNABLE.includes(name) || !Number.isFinite(value)) throw new Error(`串口参数无效: ${name}；设备状态未知`);
    const encoded = encodeSlider(name, value);
    if (encoded.clamped) throw new Error(`串口参数 ${name} 越界；拒绝静默截断，设备状态未知`);
    return [name, encoded.frame];
  });
}

/** Unsigned device-tick difference, including one 32-bit wrap. */
export function elapsedDeviceMs(ms, origin) {
  return (Number(ms) - Number(origin) + 0x100000000) % 0x100000000;
}

export async function loadSerialPort() {
  try {
    const mod = await import('serialport');
    return mod.SerialPort;
  } catch {
    throw new Error('未安装 serialport。硬件模式请先执行：npm i serialport（无硬件时请用 --backend sim 或 --backend replay）');
  }
}

export async function listPorts() {
  const SerialPort = await loadSerialPort();
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer ?? '', serialNumber: p.serialNumber ?? '' }));
}

function openPort(sp, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('打开串口超时')), timeoutMs);
    const finish = (error) => {
      if (settled) {
        // A timeout cannot cancel the driver's pending open. Close a late successful open.
        if (!error && sp.isOpen) void closePort(sp, timeoutMs);
        return;
      }
      settled = true;
      clearTimeout(timer);
      sp.removeListener('error', onError);
      error ? reject(new Error(`打开串口失败: ${error.message}`)) : resolve();
    };
    const onError = (error) => finish(error);
    sp.once('error', onError);
    try {
      sp.open(finish);
    } catch (error) {
      finish(error);
    }
  });
}

function writeAndDrain(sp, frame, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) {
  if (!sp.isOpen) return Promise.reject(new Error('串口未打开'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('串口写入/排空超时；设备状态未知')), timeoutMs);
    try {
      sp.write(frame, (writeError) => {
        if (settled) return;
        if (writeError) return finish(new Error(`串口写入失败: ${writeError.message}`));
        try {
          sp.drain((drainError) => drainError
            ? finish(new Error(`串口排空失败: ${drainError.message}`))
            : finish(null, { frameWritten: true, drained: true, deviceState: UNKNOWN_DEVICE_STATE }));
        } catch (error) { finish(new Error(`串口排空失败: ${error.message}`)); }
      });
    } catch (error) { finish(new Error(`串口写入失败: ${error.message}`)); }
  });
}

function closePort(sp, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS) {
  if (!sp || !sp.isOpen) return Promise.resolve({ closed: true, alreadyClosed: Boolean(sp) });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ closed: false, error: '关闭串口超时' }), timeoutMs);
    try {
      sp.close((error) => finish({ closed: !error, error: error?.message ?? null }));
    } catch (error) {
      finish({ closed: false, error: error.message });
    }
  });
}

function makeLineReader({ sp, onTelemetry, onAck, onError }) {
  let buffer = '';
  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 8192) {
      buffer = '';
      onError(new Error('串口行缓冲区超限'));
      return;
    }
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const telemetry = parseTelemetry(line);
      if (telemetry) onTelemetry(telemetry);
      else if (/^T,/.test(line)) onError(new Error('遥测帧字段无效；设备状态未知'));
      else if (/^OK,/.test(line)) onAck({ ok: true, line });
      else if (/^E,/.test(line)) onAck({ ok: false, line });
    }
  };
  const onSerialError = (error) => onError(new Error(`串口错误: ${error.message}`));
  sp.on('data', onData);
  sp.on('error', onSerialError);
  return () => {
    sp.removeListener('data', onData);
    sp.removeListener('error', onSerialError);
  };
}

function waitForParameterAck(name, waiters, timeoutMs) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      waiters.delete(name);
      reject(new Error(`参数 ${name} 回执超时；设备状态未知`));
    }, timeoutMs);
    waiters.set(name, (ack) => {
      clearTimeout(timer);
      waiters.delete(name);
      if (!ack.ok) reject(new Error(`设备拒绝参数 ${name}: ${ack.line}; 设备状态未知`));
      else if (ack.line !== `OK,${name}`) reject(new Error(`参数 ${name} 回执格式无效: ${ack.line}; 设备状态未知`));
      else resolve({ status: 'acknowledged', acknowledgement: ack.line });
    });
  });
  return { promise, cancel: () => { clearTimeout(timer); waiters.delete(name); } };
}

function waitForCommandAck(command, waiters, timeoutMs) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      waiters.delete(command);
      reject(new Error(`${command} 命令未收到设备回执；状态未知，拒绝继续`));
    }, timeoutMs);
    waiters.set(command, (ack) => {
      clearTimeout(timer);
      waiters.delete(command);
      if (!ack.ok || ack.line !== `OK,${command}`)
        reject(new Error(`${command} 命令未获设备确认: ${ack.line}; 状态未知，拒绝继续`));
      else resolve({ status: 'acknowledged', acknowledgement: ack.line });
    });
  });
  return { promise, cancel: () => { clearTimeout(timer); waiters.delete(command); } };
}

async function sendCommandAndWait(sp, command, waiters, ackTimeoutMs, operationTimeoutMs) {
  const ack = waitForCommandAck(command, waiters, ackTimeoutMs);
  try {
    const [, acknowledgement] = await Promise.all([
      writeAndDrain(sp, encodeCmd(command), operationTimeoutMs), ack.promise,
    ]);
    return acknowledgement;
  } catch (error) {
    ack.cancel();
    throw error;
  }
}

export function validateSerialSamples(samples, {
  durationMs,
  minSamples = 20,
  minCoverageFraction = 0.8,
  maxSampleGapMs = 250,
  maxStartTelemetryDelayMs = 500,
  firstTelemetryDelayMs = Infinity,
  tickAnomaly = false,
} = {}) {
  const issues = [];
  if (!Number.isInteger(minSamples) || minSamples < 2) issues.push('minSamples 配置无效');
  if (samples.length < minSamples) issues.push(`样本不足: ${samples.length}/${minSamples}`);
  if (!Number.isFinite(firstTelemetryDelayMs) || firstTelemetryDelayMs > maxStartTelemetryDelayMs)
    issues.push(`Start 后首样本超时: ${Number.isFinite(firstTelemetryDelayMs) ? Math.round(firstTelemetryDelayMs) : '未收到'}ms`);
  if (tickAnomaly) issues.push('设备 tick 重复、倒退或跳变');

  let maxGapMs = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (!sample || !['ms', 'angle', 'target', 'out', 'spdL', 'spdR', 'errInt'].every((key) => Number.isFinite(sample[key]))) {
      issues.push(`样本 ${i + 1} 含无效字段`);
      continue;
    }
    if (i > 0) {
      const gap = sample.ms - samples[i - 1].ms;
      if (gap <= 0) issues.push(`样本 ${i + 1} 的时间未递增`);
      maxGapMs = Math.max(maxGapMs, gap);
    }
  }
  if (samples.length > 1 && maxGapMs > maxSampleGapMs) issues.push(`最大样本间隔超限: ${maxGapMs}ms`);

  const coverageMs = samples.length > 1 ? samples.at(-1).ms - samples[0].ms : 0;
  const coverageFraction = durationMs > 0 ? coverageMs / durationMs : 0;
  if (coverageFraction < minCoverageFraction)
    issues.push(`遥测覆盖率不足: ${(coverageFraction * 100).toFixed(1)}%`);

  return {
    valid: issues.length === 0,
    sampleCount: samples.length,
    coverageMs,
    coverageFraction: Number(coverageFraction.toFixed(4)),
    maxGapMs,
    firstTelemetryDelayMs: Number.isFinite(firstTelemetryDelayMs) ? Math.round(firstTelemetryDelayMs) : null,
    issues,
  };
}

function installSignals(controller, signalTarget) {
  let interruptedBy = null;
  const onInt = () => { interruptedBy = 'SIGINT'; controller.abort(); };
  const onTerm = () => { interruptedBy = 'SIGTERM'; controller.abort(); };
  signalTarget.once('SIGINT', onInt);
  signalTarget.once('SIGTERM', onTerm);
  return {
    get interruptedBy() { return interruptedBy; },
    remove() {
      signalTarget.removeListener('SIGINT', onInt);
      signalTarget.removeListener('SIGTERM', onTerm);
    },
  };
}

/** Current firmware has no Stop/Start ACK: refuse continuation until the protocol is verified. */
export async function runSerial({
  port,
  baud = 115200,
  gains = {},
  durationMs = 3000,
  heartbeatMs = 100,
  settleMs = 250,
  ackTimeoutMs = 500,
  minSamples = 20,
  minCoverageFraction = 0.8,
  maxSampleGapMs = 250,
  maxStartTelemetryDelayMs = 500,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  fallLimitDeg = 50,
  onSample = null,
  dryRun = false,
  SerialPortClass = null,
  clock = defaultClock,
  sleepFn = sleep,
  signalTarget = process,
}) {
  if (dryRun) return { samples: [], timedOut: false, deviceState: UNKNOWN_DEVICE_STATE, dryRun: true };

  const gainFrames = prepareGainFrames(gains, true);

  const controller = new AbortController();
  const signals = installSignals(controller, signalTarget);
  const samples = [];
  const waiters = new Map();
  const parameterAcks = {};
  const issues = [];
  let sp = null;
  let removeListeners = () => {};
  let runtimeError = null;
  let collecting = false;
  let deviceT0 = null;
  let startSentAt = null;
  let firstTelemetryDelayMs = Infinity;
  let lastTelemetryAt = null;
  let tickAnomaly = false;
  let heartbeatTimer = null;
  let heartbeatBusy = false;
  let heartbeatPromise = null;
  let closing = false;
  let onClose = null;
  const commandStatus = { initialStop: null, start: null, finalStop: null };

  const onTelemetry = (t) => {
    if (!collecting || controller.signal.aborted) return;
    lastTelemetryAt = clock();
    if (deviceT0 === null) {
      deviceT0 = t.ms;
      firstTelemetryDelayMs = clock() - startSentAt;
      if (firstTelemetryDelayMs > maxStartTelemetryDelayMs)
        onError(new Error('Start 后首样本超时；状态未知，结束采集'));
    }
    const elapsed = elapsedDeviceMs(t.ms, deviceT0);
    const previous = samples.at(-1);
    if (previous && (elapsed <= previous.ms || elapsed - previous.ms > 0x7fffffff)) tickAnomaly = true;
    if (previous && elapsed - previous.ms > maxSampleGapMs)
      onError(new Error('设备遥测样本间隔超限；状态未知，结束采集'));
    const sample = { ...t, ms: elapsed };
    samples.push(sample);
    if (tickAnomaly) onError(new Error('设备 tick 重复、倒退或跳变；状态未知，结束采集'));
    if (Math.abs(t.angle) > fallLimitDeg) onError(new Error(`遥测角度越限: ${t.angle}°；状态未知，结束采集`));
    try { onSample?.(sample); } catch (error) { runtimeError = new Error(`样本处理失败: ${error.message}`); controller.abort(); }
  };
  const onAck = (ack) => {
    const name = ack.line.split(',').at(-1);
    const waiter = waiters.get(name);
    waiter?.(ack);
  };
  const onError = (error) => { runtimeError ??= error; controller.abort(); };

  const parameterFrames = async () => {
    for (const [name, frame] of gainFrames) {
      if (controller.signal.aborted) throw new Error(`准备阶段已中断 (${signals.interruptedBy ?? 'abort'}); 设备状态未知`);
      const ack = waitForParameterAck(name, waiters, ackTimeoutMs);
      try {
        const [, acknowledgement] = await Promise.all([writeAndDrain(sp, frame, operationTimeoutMs), ack.promise]);
        parameterAcks[name] = acknowledgement;
      } catch (error) {
        ack.cancel();
        throw error;
      }
      await sleepFn(120);
    }
  };

  try {
    const PortClass = SerialPortClass ?? await loadSerialPort();
    sp = new PortClass({ path: port, baudRate: baud, autoOpen: false });
    await openPort(sp, operationTimeoutMs);
    removeListeners = makeLineReader({ sp, onTelemetry, onAck, onError });
    onClose = () => { if (!closing && !controller.signal.aborted) onError(new Error('串口意外关闭')); };
    sp.on('close', onClose);

    if (controller.signal.aborted) throw new Error(`打开后已中断 (${signals.interruptedBy}); 设备状态未知`);
    try {
      await sendCommandAndWait(sp, 'Stop', waiters, ackTimeoutMs, operationTimeoutMs);
      commandStatus.initialStop = { transport: 'drained', deviceAcknowledgement: 'acknowledged', deviceState: UNKNOWN_DEVICE_STATE };
    } catch (error) {
      commandStatus.initialStop = { transport: 'attempted', deviceAcknowledgement: 'missing', deviceState: UNKNOWN_DEVICE_STATE };
      throw error;
    }
    await sleepFn(settleMs);
    if (controller.signal.aborted) throw new Error(`写参前已中断 (${signals.interruptedBy}); 未启动; 设备状态未知`);

    await parameterFrames();
    if (controller.signal.aborted) throw new Error(`启动前已中断 (${signals.interruptedBy}); 设备状态未知`);

    samples.length = 0;
    deviceT0 = null;
    collecting = true;
    startSentAt = clock();
    try {
      await sendCommandAndWait(sp, 'Start', waiters, ackTimeoutMs, operationTimeoutMs);
      commandStatus.start = { transport: 'drained', deviceAcknowledgement: 'acknowledged', deviceState: UNKNOWN_DEVICE_STATE };
    } catch (error) {
      commandStatus.start = { transport: 'attempted', deviceAcknowledgement: 'missing', deviceState: UNKNOWN_DEVICE_STATE };
      throw error;
    }

    heartbeatTimer = setInterval(() => {
      if (heartbeatBusy || controller.signal.aborted || !sp?.isOpen) return;
      heartbeatBusy = true;
      heartbeatPromise = writeAndDrain(sp, encodeHeartbeat(), operationTimeoutMs).catch(onError).finally(() => { heartbeatBusy = false; });
    }, heartbeatMs);

    const deadline = startSentAt + durationMs;
    while (clock() < deadline && !controller.signal.aborted) {
      if (runtimeError) throw runtimeError;
      if (lastTelemetryAt === null && clock() - startSentAt > maxStartTelemetryDelayMs)
        throw new Error('Start 后首样本超时；状态未知，结束采集');
      if (lastTelemetryAt !== null && clock() - lastTelemetryAt > maxSampleGapMs)
        throw new Error('遥测断流超时；状态未知，结束采集');
      await sleepFn(Math.min(50, Math.max(1, deadline - clock())));
      if (!sp.isOpen) throw new Error('采集中串口关闭; 设备状态未知');
    }
    if (runtimeError) throw runtimeError;
  } catch (error) {
    runtimeError ??= error;
  } finally {
    collecting = false;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (heartbeatPromise) await heartbeatPromise;
    if (sp?.isOpen) {
      try {
        await writeAndDrain(sp, encodeCmd('Stop'), operationTimeoutMs);
        commandStatus.finalStop = { transport: 'drained', deviceAcknowledgement: 'unsupported', deviceState: UNKNOWN_DEVICE_STATE };
      } catch (error) {
        commandStatus.finalStop = { transport: 'failed', error: error.message, deviceState: UNKNOWN_DEVICE_STATE };
        issues.push(`清理 Stop 发送失败: ${error.message}`);
      }
      await sleepFn(settleMs);
    }
    closing = true;
    const closed = await closePort(sp, operationTimeoutMs);
    if (!closed.closed) issues.push(`串口关闭失败: ${closed.error}`);
    if (onClose) sp?.removeListener('close', onClose);
    removeListeners();
    signals.remove();
  }

  const telemetry = validateSerialSamples(samples, {
    durationMs, minSamples, minCoverageFraction, maxSampleGapMs,
    maxStartTelemetryDelayMs, firstTelemetryDelayMs, tickAnomaly,
  });
  issues.push(...telemetry.issues);
  if (runtimeError) issues.push(runtimeError.message);
  return {
    samples,
    timedOut: samples.length === 0,
    interrupted: Boolean(signals.interruptedBy),
    signal: signals.interruptedBy,
    deviceState: UNKNOWN_DEVICE_STATE,
    commandStatus,
    parameterAcks,
    telemetry,
    hostStatus: runtimeError || issues.some((issue) => issue.startsWith('清理') || issue.startsWith('串口关闭'))
      ? 'error'
      : telemetry.valid ? 'complete' : 'incomplete',
    error: runtimeError?.message ?? null,
    issues: [...new Set(issues)],
  };
}

export async function sendParams({
  port, baud = 115200, gains, resume = false, settleMs = 250, ackTimeoutMs = 500,
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, SerialPortClass = null, sleepFn = sleep, signalTarget = process,
}) {
  const gainFrames = prepareGainFrames(gains);
  const PortClass = SerialPortClass ?? await loadSerialPort();
  const sp = new PortClass({ path: port, baudRate: baud, autoOpen: false });
  const waiters = new Map();
  const acks = {};
  const controller = new AbortController();
  const signals = installSignals(controller, signalTarget);
  let operationError = null;
  const checkContinuation = () => {
    if (operationError) throw operationError;
    if (controller.signal.aborted) throw new Error(`参数下发已中断 (${signals.interruptedBy}); 状态未知，拒绝继续`);
  };
  const removeListeners = makeLineReader({ sp, onTelemetry: () => {}, onAck: (ack) => waiters.get(ack.line.split(',').at(-1))?.(ack), onError: (error) => { operationError ??= error; controller.abort(); } });
  try {
    await openPort(sp, operationTimeoutMs);
    checkContinuation();
    await sendCommandAndWait(sp, 'Stop', waiters, ackTimeoutMs, operationTimeoutMs);
    await sleepFn(settleMs);
    for (const [name, frame] of gainFrames) {
      checkContinuation();
      const ack = waitForParameterAck(name, waiters, ackTimeoutMs);
      try {
        const [, acknowledgement] = await Promise.all([writeAndDrain(sp, frame, operationTimeoutMs), ack.promise]);
        acks[name] = acknowledgement;
      } catch (error) {
        ack.cancel();
        throw error;
      }
      await sleepFn(120);
    }
    checkContinuation();
    if (resume) {
      await sendCommandAndWait(sp, 'Start', waiters, ackTimeoutMs, operationTimeoutMs);
      checkContinuation();
      await writeAndDrain(sp, encodeHeartbeat(), operationTimeoutMs);
    }
    return { deviceState: UNKNOWN_DEVICE_STATE, stopAcknowledgement: 'acknowledged', startAcknowledgement: resume ? 'acknowledged' : null, parameterAcks: acks };
  } catch (error) {
    operationError ??= error;
    throw error;
  } finally {
    const cleanupIssues = [];
    if (sp.isOpen) {
      try { await writeAndDrain(sp, encodeCmd('Stop'), operationTimeoutMs); }
      catch (error) { cleanupIssues.push(`清理 Stop 失败: ${error.message}`); }
      await sleepFn(settleMs);
    }
    const closed = await closePort(sp, operationTimeoutMs);
    if (!closed.closed) cleanupIssues.push(`关闭串口失败: ${closed.error}`);
    removeListeners();
    signals.remove();
    if (cleanupIssues.length) throw new Error([operationError?.message, ...cleanupIssues, '设备状态未知'].filter(Boolean).join('；'));
  }
}

export async function startBalance({
  port, baud = 115200, heartbeatMs = 100, settleMs = 250,
  ackTimeoutMs = 500, operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, SerialPortClass = null, signalTarget = process,
}) {
  const PortClass = SerialPortClass ?? await loadSerialPort();
  const sp = new PortClass({ path: port, baudRate: baud, autoOpen: false });
  const controller = new AbortController();
  const signals = installSignals(controller, signalTarget);
  let hbTimer = null;
  let stopped = false;
  let heartbeatError = null;
  let resolveFailure;
  const failure = new Promise((resolve) => { resolveFailure = resolve; });
  let heartbeatPromise = null;
  let heartbeatBusy = false;
  const onError = (error) => {
    heartbeatError ??= new Error(`串口错误: ${error.message}`);
    if (hbTimer) clearInterval(hbTimer);
    resolveFailure(heartbeatError);
  };
  const checkContinuation = () => {
    if (controller.signal.aborted) throw new Error(`启动准备已中断 (${signals.interruptedBy}); 状态未知，拒绝继续`);
    if (heartbeatError) throw heartbeatError;
  };
  const onClose = () => {
    if (!stopped) onError(new Error('串口意外关闭'));
  };
  let removeCommandReader = () => {};
  sp.on('error', onError);
  sp.on('close', onClose);
  const stop = async () => {
    if (stopped) return { deviceState: UNKNOWN_DEVICE_STATE, idempotent: true, error: heartbeatError?.message ?? null };
    stopped = true;
    if (hbTimer) clearInterval(hbTimer);
    if (heartbeatPromise) await heartbeatPromise;
    let stopTransport = 'failed';
    try { await writeAndDrain(sp, encodeCmd('Stop'), operationTimeoutMs); stopTransport = 'drained'; } catch (error) { heartbeatError ??= error; }
    await sleep(settleMs);
    const closed = await closePort(sp, operationTimeoutMs);
    sp.removeListener('error', onError);
    sp.removeListener('close', onClose);
    return { deviceState: UNKNOWN_DEVICE_STATE, stopTransport, closeStatus: closed, error: heartbeatError?.message ?? null };
  };
  try {
    await openPort(sp, operationTimeoutMs);
    checkContinuation();
    const commandWaiters = new Map();
    removeCommandReader = makeLineReader({ sp, onTelemetry: () => {}, onAck: (ack) => commandWaiters.get(ack.line.split(',').at(-1))?.(ack), onError });
    await sendCommandAndWait(sp, 'Start', commandWaiters, ackTimeoutMs, operationTimeoutMs);
    removeCommandReader();
    removeCommandReader = () => {};
    checkContinuation();
    await writeAndDrain(sp, encodeHeartbeat(), operationTimeoutMs);
    checkContinuation();
    hbTimer = setInterval(() => {
      if (stopped || heartbeatBusy || !sp.isOpen) return;
      heartbeatBusy = true;
      heartbeatPromise = writeAndDrain(sp, encodeHeartbeat(), operationTimeoutMs).catch(onError).finally(() => { heartbeatBusy = false; });
    }, heartbeatMs);
    signals.remove();
    return { stop, failure, port, running: null, deviceState: UNKNOWN_DEVICE_STATE, startAcknowledgement: 'acknowledged' };
  } catch (error) {
    await stop();
    removeCommandReader();
    signals.remove();
    throw error;
  }
}

export function waitForSerialStop(session, signalTarget = process) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async (signal, error = null) => {
      if (done) return;
      done = true;
      signalTarget.removeListener('SIGINT', onInt);
      signalTarget.removeListener('SIGTERM', onTerm);
      const cleanup = await session.stop();
      resolve({ signal, error: error?.message ?? null, cleanup, deviceState: UNKNOWN_DEVICE_STATE });
    };
    const onInt = () => finish('SIGINT');
    const onTerm = () => finish('SIGTERM');
    signalTarget.once('SIGINT', onInt);
    signalTarget.once('SIGTERM', onTerm);
    session.failure?.then((error) => finish('SERIAL_ERROR', error));
  });
}

export async function emergencyStop({ port, baud = 115200, operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, SerialPortClass = null, sleepFn = sleep }) {
  const PortClass = SerialPortClass ?? await loadSerialPort();
  const sp = new PortClass({ path: port, baudRate: baud, autoOpen: false });
  let sent = 0;
  let serialError = null;
  const onError = (error) => { serialError ??= new Error(`串口错误: ${error.message}`); };
  sp.on('error', onError);
  try {
    await openPort(sp, operationTimeoutMs);
    for (let i = 0; i < 5; i++) {
      await writeAndDrain(sp, encodeCmd('Stop'), operationTimeoutMs);
      if (serialError) throw serialError;
      sent++;
      await sleepFn(80);
    }
    await sleepFn(200);
    return { attempts: sent, deviceState: UNKNOWN_DEVICE_STATE, acknowledgement: 'unsupported' };
  } finally {
    const closed = await closePort(sp, operationTimeoutMs);
    sp.removeListener('error', onError);
    if (!closed.closed) throw new Error(`关闭串口失败: ${closed.error}；设备状态未知`);
  }
}
