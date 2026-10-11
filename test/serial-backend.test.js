import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  emergencyStop, runSerial, sendParams, startBalance, validateSerialSamples, waitForSerialStop,
} from '../bridge/backends/serial.js';

const gains = { AngleKp: 4, AngleKi: 0, AngleKd: 8 };

class FakeSerialPort extends EventEmitter {
  static behavior = {};

  constructor() {
    super();
    this.behavior = this.constructor.behavior ?? FakeSerialPort.behavior;
    this.frames = [];
    this.isOpen = false;
    this.closeCalls = 0;
    this.constructor.lastInstance = this;
  }

  open(callback) {
    if (this.behavior.openThrows) throw new Error('open threw');
    if (this.behavior.openCallbackNever) return;
    if (this.behavior.openError) return callback(new Error('open failed'));
    this.isOpen = true;
    callback();
  }

  write(frame, callback) {
    this.frames.push(frame);
    if (this.behavior.writeThrows) throw new Error('write threw');
    if (this.behavior.writeCallbackNeverFrame === frame) return;
    if (frame === this.behavior.writeErrorFrame) return callback(new Error('write failed'));
    const slider = /^\[slider,([^,]+),/.exec(frame);
    if (slider && this.behavior.ack !== false)
      queueMicrotask(() => this.emit('data', Buffer.from(`OK,${slider[1]}\n`)));
    const command = /^\[cmd,([^,]+),/.exec(frame)?.[1];
    if (command && this.behavior.commandAcks && this.behavior.missingCommandAck !== command)
      queueMicrotask(() => this.emit('data', Buffer.from(`OK,${command}\n`)));
    if (frame === '[cmd,Start,1]' && this.behavior.telemetry) {
      const selected = this.behavior.streamTelemetry ? this.behavior.telemetry.slice(0, 1) : this.behavior.telemetry;
      this.pendingTelemetry = this.behavior.streamTelemetry ? this.behavior.telemetry.slice(1) : [];
      const rows = selected.map((row) =>
        `T,${row.ms},${row.angle},${row.target},${row.out},${row.spdL},${row.spdR},${row.errInt}\n`).join('');
      this.emit('data', Buffer.from(rows));
      if (this.behavior.closeOnStart) {
        this.isOpen = false;
        this.emit('close');
      }
    }
    callback();
  }

  drain(callback) {
    if (this.behavior.drainThrows) throw new Error('drain threw');
    if (this.behavior.drainCallbackNever) return;
    callback(this.behavior.drainError ? new Error('drain failed') : null);
  }

  close(callback) {
    this.closeCalls++;
    this.isOpen = false;
    this.emit('close');
    if (this.behavior.closeCallbackNever) return;
    callback(this.behavior.closeError ? new Error('close failed') : null);
  }
}

function telemetryRows({ count = 21, step = 50, gapAt = -1, angle = 0 } = {}) {
  let ms = 1000;
  return Array.from({ length: count }, (_, i) => {
    if (i > 0) ms += i === gapAt ? step * 8 : step;
    return { ms, angle, target: 0, out: 0, spdL: 0, spdR: 0, errInt: 0 };
  });
}

function runWithFake(options = {}) {
  FakeSerialPort.behavior = options.behavior ?? { telemetry: telemetryRows(), commandAcks: true, streamTelemetry: true };
  let now = 0;
  const signalTarget = new EventEmitter();
  return runSerial({
    port: 'FAKE', gains, durationMs: 1000, heartbeatMs: 1000, settleMs: 0,
    ackTimeoutMs: 10, SerialPortClass: FakeSerialPort, signalTarget,
    clock: () => now,
    sleepFn: async (ms) => {
      now += ms;
      const instance = FakeSerialPort.lastInstance;
      const row = instance?.pendingTelemetry?.shift();
      if (row) instance.emit('data', Buffer.from(`T,${row.ms},${row.angle},${row.target},${row.out},${row.spdL},${row.spdR},${row.errInt}\n`));
      await new Promise((resolve) => setImmediate(resolve));
    },
    ...options,
  }).then((result) => ({ result, signalTarget }));
}

test('fake transport executes the host sequence but reports Stop/Start state as unknown', async () => {
  const { result } = await runWithFake();
  assert.equal(result.hostStatus, 'complete');
  assert.equal(result.telemetry.valid, true);
  assert.equal(result.telemetry.sampleCount, 21);
  assert.equal(result.parameterAcks.AngleKp.status, 'acknowledged');
  assert.equal(result.commandStatus.initialStop.deviceState, 'unknown');
  assert.equal(result.commandStatus.start.deviceState, 'unknown');
  assert.equal(result.commandStatus.finalStop.deviceState, 'unknown');
  assert.equal(result.deviceState, 'unknown');
});

test('open, write, and drain failures are reported without claiming device state', async (t) => {
  await t.test('open failure', async () => {
    const { result } = await runWithFake({ behavior: { openError: true } });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /打开串口失败/);
    assert.equal(result.deviceState, 'unknown');
  });
  await t.test('write failure', async () => {
    const { result } = await runWithFake({ behavior: { writeErrorFrame: '[cmd,Stop,1]' } });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /串口写入失败/);
    assert.equal(result.deviceState, 'unknown');
  });
  await t.test('drain failure', async () => {
    const { result } = await runWithFake({ behavior: { drainError: true } });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /串口排空失败/);
    assert.equal(result.deviceState, 'unknown');
  });
});

test('serial operation timeouts bound open, write, drain, and close callbacks', async (t) => {
  await t.test('open callback never arrives', async () => {
    const { result } = await runWithFake({ behavior: { openCallbackNever: true }, operationTimeoutMs: 5 });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /打开串口失败: 打开串口超时/);
    assert.equal(result.deviceState, 'unknown');
  });
  await t.test('write callback never arrives', async () => {
    const { result } = await runWithFake({ behavior: { writeCallbackNeverFrame: '[cmd,Stop,1]' }, operationTimeoutMs: 5 });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /写入\/排空超时/);
    assert.equal(result.deviceState, 'unknown');
  });
  await t.test('drain callback never arrives', async () => {
    const { result } = await runWithFake({ behavior: { drainCallbackNever: true }, operationTimeoutMs: 5 });
    assert.equal(result.hostStatus, 'error');
    assert.match(result.error, /写入\/排空超时/);
    assert.equal(result.deviceState, 'unknown');
  });
  await t.test('close callback never arrives', async () => {
    const Port = class extends FakeSerialPort { static behavior = { closeCallbackNever: true }; };
    let now = 0;
    const result = await runSerial({
      port: 'FAKE', gains, durationMs: 1000, settleMs: 0, operationTimeoutMs: 5,
      SerialPortClass: Port, signalTarget: new EventEmitter(), clock: () => now,
      sleepFn: async (ms) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); },
    });
    assert.equal(result.hostStatus, 'error');
    assert.ok(result.issues.some((issue) => /关闭串口超时/.test(issue)));
    assert.equal(result.deviceState, 'unknown');
    assert.equal(Port.lastInstance.closeCalls, 1);
  });
});

test('missing Stop acknowledgement refuses parameter writes and Start with unknown device state', async () => {
  const { result } = await runWithFake({
    behavior: { telemetry: telemetryRows(), commandAcks: false }, ackTimeoutMs: 5,
  });
  assert.equal(result.hostStatus, 'error');
  assert.match(result.error, /Stop 命令未收到设备回执/);
  assert.equal(result.commandStatus.initialStop.deviceAcknowledgement, 'missing');
  assert.equal(result.deviceState, 'unknown');
  assert.ok(FakeSerialPort.lastInstance.frames.every((frame) => !frame.startsWith('[slider,') && frame !== '[cmd,Start,1]'));
  assert.equal(FakeSerialPort.lastInstance.closeCalls, 1);
});

test('set-parameter path refuses to write gains when Stop is unconfirmed', async () => {
  const Port = class extends FakeSerialPort { static behavior = { commandAcks: false }; };
  await assert.rejects(sendParams({
    port: 'FAKE', gains, settleMs: 0, ackTimeoutMs: 5, operationTimeoutMs: 5,
    SerialPortClass: Port, sleepFn: async () => {},
  }), /Stop 命令未收到设备回执/);
  assert.ok(Port.lastInstance.frames.every((frame) => !frame.startsWith('[slider,')));
  assert.equal(Port.lastInstance.closeCalls, 1);
});

test('missing Start acknowledgement refuses sampling continuation and heartbeat', async () => {
  const { result } = await runWithFake({
    behavior: { commandAcks: true, missingCommandAck: 'Start' }, ackTimeoutMs: 5,
  });
  assert.equal(result.hostStatus, 'error');
  assert.match(result.error, /Start 命令未收到设备回执/);
  assert.equal(result.commandStatus.start.deviceAcknowledgement, 'missing');
  assert.equal(result.deviceState, 'unknown');
  assert.ok(FakeSerialPort.lastInstance.frames.every((frame) => !frame.startsWith('[hb,')));
  assert.equal(FakeSerialPort.lastInstance.closeCalls, 1);
});

test('standalone Start without acknowledgement refuses sustained heartbeat and closes', async () => {
  const Port = class extends FakeSerialPort { static behavior = {}; };
  await assert.rejects(startBalance({
    port: 'FAKE', settleMs: 0, ackTimeoutMs: 5, SerialPortClass: Port,
  }), /Start 命令未收到设备回执/);
  assert.ok(Port.lastInstance.frames.every((frame) => !frame.startsWith('[hb,')));
  assert.equal(Port.lastInstance.closeCalls, 1);
});

test('invalid serial gains are rejected before any port is constructed', async () => {
  const Port = class extends FakeSerialPort {};
  for (const invalid of [{ ...gains, AngleKp: 999 }, { SpeedKp: 2 }, { AngleKp: NaN }, {}]) {
    Port.lastInstance = null;
    await assert.rejects(sendParams({ port: 'FAKE', gains: invalid, SerialPortClass: Port }), /串口/);
    assert.equal(Port.lastInstance, null);
  }
  await assert.rejects(runSerial({ port: 'FAKE', gains: { AngleKp: 4 }, SerialPortClass: Port }), /全部三个/);
  assert.equal(Port.lastInstance, null);
});

test('parameter preparation interruption refuses gains and removes signal listeners', async () => {
  const Port = class extends FakeSerialPort { static behavior = { commandAcks: true }; };
  const signalTarget = new EventEmitter();
  let firstSleep = true;
  await assert.rejects(sendParams({
    port: 'FAKE', gains, SerialPortClass: Port, signalTarget,
    sleepFn: async () => { if (firstSleep) { firstSleep = false; signalTarget.emit('SIGTERM'); } },
  }), /已中断/);
  assert.ok(Port.lastInstance.frames.every((frame) => !frame.startsWith('[slider,')));
  assert.equal(Port.lastInstance.closeCalls, 1);
  assert.equal(signalTarget.listenerCount('SIGTERM'), 0);
});

test('Start preparation interruption refuses sustained heartbeat and cleans up', async () => {
  const signalTarget = new EventEmitter();
  const Port = class extends FakeSerialPort {
    static behavior = { commandAcks: true };
    write(frame, callback) {
      if (frame === '[cmd,Start,1]') signalTarget.emit('SIGINT');
      return super.write(frame, callback);
    }
  };
  await assert.rejects(startBalance({ port: 'FAKE', settleMs: 0, SerialPortClass: Port, signalTarget }), /已中断/);
  assert.ok(Port.lastInstance.frames.every((frame) => !frame.startsWith('[hb,')));
  assert.equal(Port.lastInstance.closeCalls, 1);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
});

test('synchronous driver exceptions are bounded and reported', async (t) => {
  for (const behavior of [{ openThrows: true }, { writeThrows: true }, { drainThrows: true }]) {
    await t.test(Object.keys(behavior)[0], async () => {
      const { result } = await runWithFake({ behavior, operationTimeoutMs: 5 });
      assert.equal(result.hostStatus, 'error');
      assert.match(result.error, /threw/);
      assert.equal(result.deviceState, 'unknown');
    });
  }
});

test('ACK timeout while a write is hung is handled without an unhandled rejection', async () => {
  const { result } = await runWithFake({
    behavior: { commandAcks: true, writeCallbackNeverFrame: '[slider,AngleKp,4]' },
    ackTimeoutMs: 5, operationTimeoutMs: 20,
  });
  assert.match(result.error, /回执超时/);
  assert.equal(result.hostStatus, 'error');
  assert.ok(FakeSerialPort.lastInstance.frames.every((frame) => frame !== '[cmd,Start,1]'));
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test('telemetry faults abort sampling and attempt final Stop', async (t) => {
  const duplicate = telemetryRows();
  duplicate[1].ms = duplicate[0].ms;
  const cases = [
    [{ commandAcks: true }, /首样本超时/],
    [{ commandAcks: true, telemetry: telemetryRows({ count: 1 }) }, /断流超时/],
    [{ commandAcks: true, telemetry: duplicate }, /tick/],
    [{ commandAcks: true, telemetry: telemetryRows({ angle: 51 }) }, /角度越限/],
  ];
  for (const [behavior, message] of cases) {
    await t.test(String(message), async () => {
      const { result } = await runWithFake({ behavior });
      assert.equal(result.hostStatus, 'error');
      assert.match(result.error, message);
      assert.equal(result.deviceState, 'unknown');
      assert.equal(FakeSerialPort.lastInstance.frames.at(-1), '[cmd,Stop,1]');
      assert.equal(FakeSerialPort.lastInstance.closeCalls, 1);
    });
  }
});

test('cleanup close errors cannot be reported as successful set or Stop', async () => {
  const Port = class extends FakeSerialPort { static behavior = { commandAcks: true, closeError: true }; };
  await assert.rejects(sendParams({ port: 'FAKE', gains, SerialPortClass: Port, sleepFn: async () => {} }), /关闭串口失败/);
  await assert.rejects(emergencyStop({ port: 'FAKE', SerialPortClass: Port, sleepFn: async () => {} }), /关闭串口失败/);
});

test('missing slider acknowledgement prevents Start and closes the transport', async () => {
  const Port = class extends FakeSerialPort { static behavior = { ack: false, commandAcks: true }; };
  let now = 0;
  const result = await runSerial({
    port: 'FAKE', gains, durationMs: 1000, settleMs: 0, ackTimeoutMs: 5,
    SerialPortClass: Port, signalTarget: new EventEmitter(), clock: () => now,
    sleepFn: async (ms) => { now += ms; await new Promise((resolve) => setImmediate(resolve)); },
  });
  const instance = Port.lastInstance;
  assert.equal(result.hostStatus, 'error');
  assert.match(result.error, /回执超时/);
  assert.equal(result.commandStatus.start, null);
  assert.equal(result.deviceState, 'unknown');
  assert.ok(instance.frames.every((frame) => frame !== '[cmd,Start,1]'));
  assert.equal(instance.closeCalls, 1);
});

test('interrupt during preparation prevents parameter writes and Start', async () => {
  const Port = class extends FakeSerialPort {
    constructor(options) { super(options); Port.lastInstance = this; }
  };
  Port.behavior = { commandAcks: true };
  let now = 0;
  const signalTarget = new EventEmitter();
  let firstSleep = true;
  const result = await runSerial({
    port: 'FAKE', gains, durationMs: 1000, settleMs: 1, SerialPortClass: Port,
    signalTarget, clock: () => now,
    sleepFn: async (ms) => {
      now += ms;
      if (firstSleep) { firstSleep = false; signalTarget.emit('SIGINT'); }
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  assert.equal(result.interrupted, true);
  assert.equal(result.signal, 'SIGINT');
  assert.equal(result.deviceState, 'unknown');
  assert.ok(Port.lastInstance.frames.every((frame) => !frame.startsWith('[slider,') && frame !== '[cmd,Start,1]'));
});

test('telemetry completeness rejects truncation, large gaps, delayed start, and tick anomalies', () => {
  const valid = telemetryRows();
  assert.equal(validateSerialSamples(valid, {
    durationMs: 1000, firstTelemetryDelayMs: 20,
  }).valid, true);
  assert.equal(validateSerialSamples(valid.slice(0, 10), {
    durationMs: 1000, firstTelemetryDelayMs: 20,
  }).valid, false);
  assert.match(validateSerialSamples(telemetryRows({ gapAt: 10 }), {
    durationMs: 1000, firstTelemetryDelayMs: 20,
  }).issues.join(' '), /间隔超限/);
  assert.match(validateSerialSamples(valid, {
    durationMs: 1000, firstTelemetryDelayMs: 501,
  }).issues.join(' '), /首样本超时/);
  assert.match(validateSerialSamples(valid, {
    durationMs: 1000, firstTelemetryDelayMs: 20, tickAnomaly: true,
  }).issues.join(' '), /tick/);
});

test('unexpected close during sampling aborts the trial and keeps device state unknown', async () => {
  const { result } = await runWithFake({ behavior: { telemetry: telemetryRows(), closeOnStart: true, commandAcks: true } });
  assert.equal(result.hostStatus, 'error');
  assert.equal(result.deviceState, 'unknown');
  assert.match(result.error, /意外关闭|串口关闭/);
});

test('start session stop is idempotent and an emergency stop reports unknown state', async () => {
  const Port = class extends FakeSerialPort { constructor(options) { super(options); Port.lastInstance = this; } };
  Port.behavior = { commandAcks: true };
  const session = await startBalance({ port: 'FAKE', heartbeatMs: 1000, settleMs: 0, SerialPortClass: Port });
  assert.equal(session.running, null);
  const first = await session.stop();
  const second = await session.stop();
  assert.equal(first.deviceState, 'unknown');
  assert.equal(second.idempotent, true);
  assert.equal(Port.lastInstance.closeCalls, 1);

  Port.behavior = {};
  const stopped = await emergencyStop({ port: 'FAKE', SerialPortClass: Port, sleepFn: async () => {} });
  assert.equal(stopped.attempts, 5);
  assert.equal(stopped.deviceState, 'unknown');
});

test('start session heartbeat failure wakes the waiter and cleans up the host transport', async () => {
  const Port = class extends FakeSerialPort {
    static behavior = { commandAcks: true };
    constructor(options) { super(options); this.heartbeats = 0; Port.lastInstance = this; }
    write(frame, callback) {
      if (frame.startsWith('[hb,')) {
        this.heartbeats++;
        if (this.heartbeats > 1) return callback(new Error('heartbeat failed'));
      }
      return super.write(frame, callback);
    }
  };
  const session = await startBalance({ port: 'FAKE', heartbeatMs: 5, settleMs: 0, SerialPortClass: Port });
  const result = await waitForSerialStop(session, new EventEmitter());
  assert.equal(result.signal, 'SERIAL_ERROR');
  assert.match(result.error, /heartbeat failed/);
  assert.equal(result.deviceState, 'unknown');
  assert.equal(result.cleanup.closeStatus.closed, true);
  assert.equal(Port.lastInstance.closeCalls, 1);
});
