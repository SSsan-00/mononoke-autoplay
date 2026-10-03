import { SNAPSHOT_EXPRESSION, legalActions } from "./state.js";

const GAME_SOURCE_SUFFIX = "/js/screens/game.js";

// Debugger.paused はコマンド完了より先に届く場合があります。
// 小さなキューでイベントを取りこぼさず、停止処理の重複も防ぎます。
class PauseQueue {
  events = [];
  waiter = null;
  push(event) {
    if (this.waiter) this.waiter(event);
    else this.events.push(event);
  }
  next(timeoutMs) {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(
          new Error(
            "ゲームの停止イベントが届きません。ゲーム画面を開き、一時停止を解除してください。",
          ),
        );
      }, timeoutMs);
      this.waiter = (event) => {
        clearTimeout(timer);
        this.waiter = null;
        resolve(event);
      };
    });
  }
}

export class GameAdapter {
  constructor(page, { timeoutMs = 30000 } = {}) {
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.queue = new PauseQueue();
    this.paused = false;
    this.frameId = null;
    this.breakpointId = null;
    this.terminalBreakpointId = null;
    this.scriptId = null;
    this.location = null;
    this.stepLocation = null;
  }

  async attach() {
    this.session = await this.page.context().newCDPSession(this.page);
    const scriptReady = new Promise((resolve) => {
      this.session.on("Debugger.scriptParsed", (event) => {
        if ((event.url || "").split("?")[0].endsWith(GAME_SOURCE_SUFFIX))
          resolve(event);
      });
    });
    this.session.on("Debugger.paused", (event) => {
      this.paused = true;
      this.queue.push(event);
    });
    this.session.on("Debugger.resumed", () => {
      this.paused = false;
      this.frameId = null;
    });
    await this.session.send("Debugger.enable");
    // enableの応答とscriptParsedの通知は非同期です。通知を取りこぼさず待ちます。
    let timer;
    let script;
    try {
      script = await Promise.race([
        scriptReady,
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "ゲーム画面のJavaScriptが見つかりません。対象URLまたはゲームの更新を確認してください。",
                ),
              ),
            Math.min(this.timeoutMs, 30000),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    this.scriptId = script.scriptId;
    const { scriptSource } = await this.session.send(
      "Debugger.getScriptSource",
      { scriptId: this.scriptId },
    );
    // 行番号を固定せず、今回確認したゲームループの接点を探します。
    const lines = scriptSource.split("\n");
    const lineNumber = lines.findIndex(
      (line) => line.trim() === "if (!paused && !finished) {",
    );
    if (
      lineNumber < 0 ||
      lines.filter((line) => line.trim() === "if (!paused && !finished) {")
        .length !== 1
    ) {
      throw new Error(
        "ゲームループの構造が変わっています。安全に停止する場所を特定できません。",
      );
    }
    this.location = { scriptId: this.scriptId, lineNumber, columnNumber: 0 };
    const stepLine = lines.findIndex((line) => line.trim() === "sim.step();");
    if (
      stepLine < 0 ||
      lines.filter((line) => line.trim() === "sim.step();").length !== 1 ||
      lines[stepLine + 1]?.trim() !== "feedHeld();"
    ) {
      throw new Error("固定ステップの処理位置を特定できません。");
    }
    // 描画フレームに複数ステップが含まれても、移動終了直後に判断します。
    this.stepLocation = {
      scriptId: this.scriptId,
      lineNumber: stepLine + 1,
      columnNumber: 0,
    };
    // 重い描画で次のRAFが遅れると、敗北後の画面遷移が先に発生します。
    // 同じフレーム内のhandleEvents直前でも最終状態を捕捉します。
    const terminalLine = lines.findIndex(
      (line) => line.trim() === "handleEvents();",
    );
    if (terminalLine < 0)
      throw new Error("終了イベントの処理位置を特定できません。");
    const terminal = await this.session.send("Debugger.setBreakpoint", {
      location: {
        scriptId: this.scriptId,
        lineNumber: terminalLine,
        columnNumber: 0,
      },
      condition:
        "sim.state.status === 'cleared' || sim.state.status === 'failed'",
    });
    this.terminalBreakpointId = terminal.breakpointId;
  }

  async setBreakpoint(afterMs) {
    if (this.breakpointId) {
      await this.session.send("Debugger.removeBreakpoint", {
        breakpointId: this.breakpointId,
      });
      this.breakpointId = null;
    }
    const { breakpointId } = await this.session.send("Debugger.setBreakpoint", {
      location: this.frameId ? this.stepLocation : this.location,
      // 移動完了後に判断。終了・敗北演出も見逃さない条件にします。
      // 初回はフレーム入口、入力後は固定ステップ直後に停止します。
      condition: `!paused && (sim.state.status !== 'playing' || (!sim.isMoving() && sim.state.elapsedMs >= ${Number(afterMs) - 0.00001}))`,
    });
    this.breakpointId = breakpointId;
  }

  async nextState() {
    const event = await this.queue.next(this.timeoutMs);
    const frame = event.callFrames.find(
      (f) =>
        f.functionName === "frame" && f.location.scriptId === this.scriptId,
    );
    if (!frame) throw new Error("想定外の場所でデバッガが停止しました。");
    this.frameId = frame.callFrameId;
    const raw = await this.evaluate(SNAPSHOT_EXPRESSION);
    const state = JSON.parse(raw);
    if (
      !Number.isInteger(state.player.x) ||
      !Number.isInteger(state.player.y)
    ) {
      throw new Error("プレイヤー座標の形式が変わっています。");
    }
    return state;
  }

  async evaluate(expression) {
    const response = await this.session.send("Debugger.evaluateOnCallFrame", {
      callFrameId: this.frameId,
      expression,
      returnByValue: true,
    });
    if (response.exceptionDetails)
      throw new Error("ゲームスコープ内の評価に失敗しました。");
    return response.result.value;
  }

  async act(action, state, minimumIntervalMs = 100) {
    if (!legalActions(state).includes(action))
      throw new Error(`盤面外への入力を拒否しました: ${action}`);
    if (action !== "wait") {
      // 通常のキー操作が最終的に呼ぶ同じ入力関数へ、方向だけ渡します。
      // HP・敵・時間などの書き換えや、ソースの差し替えは行いません。
      await this.evaluate(`sim.input(${JSON.stringify(action)})`);
    }
    await this.setBreakpoint(state.elapsedMs + minimumIntervalMs);
    await this.resume();
  }

  async resume() {
    if (this.paused) await this.session.send("Debugger.resume");
  }

  async close() {
    if (!this.session) return;
    try {
      if (this.breakpointId)
        await this.session.send("Debugger.removeBreakpoint", {
          breakpointId: this.breakpointId,
        });
      if (this.terminalBreakpointId)
        await this.session.send("Debugger.removeBreakpoint", {
          breakpointId: this.terminalBreakpointId,
        });
    } finally {
      try {
        await this.resume();
      } finally {
        await this.session.detach();
      }
    }
  }
}
