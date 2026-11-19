// Запись хода смены для интерфейса: по тактам — деньги, склад, загрузка станков, выпуск, продажи.

export class Recorder {
  constructor(runId, startMsg, source) {
    this.runId = runId;
    this.source = source; // 'arena' | 'local'
    this.mode = startMsg.mode;
    this.created = Date.now();
    this.horizon = startMsg.horizon;
    this.capacity = startMsg.capacity;
    this.machines = (startMsg.machines || []).map((m) => m.id);
    this.opDur = {};
    for (const m of startMsg.machines || []) for (const op of m.ops || []) this.opDur[m.id + '/' + op.id] = op.duration;
    this.robotOps = new Set();
    for (const m of startMsg.machines || []) for (const op of m.ops || []) if (op.output?.kind === 'robot') this.robotOps.add(op.id);
    this.ticks = new Map(); // t -> snapshot
    this.busy = Object.fromEntries(this.machines.map((m) => [m, new Uint8Array(this.horizon + 1)]));
    this.produced = 0;
    this.sold = 0;
    this.refused = 0;
    this.revenue = 0;
    this.offers = 0;
    this.accepted = 0;
    this.events = 0;
    this.invalid = 0;
    this.invalidReasons = {};
    this.errors = 0;
    this.latency = { max: 0, sum: 0 };
    this.sales = [];
    this.lastT = 0;
    this.finished = null;
  }

  _mark(m, from, to) {
    const arr = this.busy[m];
    if (!arr) return;
    for (let k = Math.max(0, from); k < Math.min(arr.length, to); k++) arr[k] = 1;
  }

  onEvent(req, resp, ms, error) {
    const t = req.t;
    this.lastT = Math.max(this.lastT, t);
    this.events++;
    if (error) this.errors++;
    this.latency.max = Math.max(this.latency.max, ms);
    this.latency.sum += ms;
    for (const r of req.report || []) {
      if (!r.ok) {
        this.invalid++;
        this.invalidReasons[r.reason] = (this.invalidReasons[r.reason] || 0) + 1;
      }
    }
    const ev = req.event || {};
    if (ev.type === 'machine_done' && this.robotOps.has(ev.opId)) this.produced++;
    if (ev.type === 'sale_result') {
      if (ev.outcome === 'sold') {
        this.sold++;
        this.revenue += ev.price || 0;
      } else this.refused++;
      this.sales.push({ t, buyerId: ev.buyerId, props: ev.item?.props, outcome: ev.outcome, price: ev.price, reason: ev.reason });
      if (this.sales.length > 400) this.sales.shift();
    }
    const st = req.state || {};
    for (const m of st.machines || []) if (m.busyUntil !== null && m.busyUntil !== undefined) this._mark(m.id, t, m.busyUntil);
    const busyUntil = Object.fromEntries((st.machines || []).map((m) => [m.id, m.busyUntil]));
    for (const c of resp?.commands || []) {
      if (c.cmd === 'start') {
        const d = this.opDur[c.machineId + '/' + c.opId] || 1;
        this._mark(c.machineId, t, t + d);
        busyUntil[c.machineId] = t + d;
      } else if (c.cmd === 'offer') this.offers++;
      else if (c.cmd === 'accept') this.accepted++;
    }
    const kinds = { sheet: 0, control: 0, body: 0, robot: 0 };
    for (const it of st.storage?.items || []) kinds[it.kind] = (kinds[it.kind] || 0) + 1;
    this.ticks.set(t, {
      t,
      cash: st.cash ?? 0,
      kinds,
      items: (st.storage?.items || []).map((i) => ({ k: i.kind, c: i.props?.color ?? null, h: i.props?.handles ?? null })),
      buyers: (st.buyers || []).map((b) => ({ id: b.id, cd: b.cooldownUntil })),
      busyUntil,
      produced: this.produced,
      sold: this.sold,
      revenue: Math.round(this.revenue * 100) / 100,
    });
  }

  finish(msg) {
    this.finished = msg;
  }

  summary() {
    const last = this.ticks.get(this.lastT);
    return {
      runId: this.runId,
      source: this.source,
      mode: this.mode,
      created: this.created,
      horizon: this.horizon,
      t: this.lastT,
      profit: this.finished?.profit ?? last?.cash ?? 0,
      sold: this.sold,
      done: !!this.finished,
    };
  }

  /** Полные данные: такты без событий заполняются последним известным состоянием. */
  full(extra = {}) {
    const series = [];
    let prev = null;
    for (let t = 0; t <= this.lastT; t++) {
      const s = this.ticks.get(t) || (prev ? { ...prev, t } : null);
      if (s) series.push(s);
      prev = s;
    }
    const util = {};
    for (const m of this.machines) {
      const arr = this.busy[m];
      let n = 0;
      for (let k = 0; k <= this.lastT; k++) n += arr[k];
      util[m] = this.lastT ? n / (this.lastT + 1) : 0;
    }
    return {
      ...this.summary(),
      capacity: this.capacity,
      machines: this.machines,
      busy: Object.fromEntries(this.machines.map((m) => [m, Array.from(this.busy[m].slice(0, this.lastT + 1))])),
      util,
      series,
      stats: {
        produced: this.produced,
        sold: this.sold,
        refused: this.refused,
        revenue: Math.round(this.revenue * 100) / 100,
        offers: this.offers,
        accepted: this.accepted,
        events: this.events,
        invalid: this.invalid,
        invalidReasons: this.invalidReasons,
        errors: this.errors,
        maxLatencyMs: Math.round(this.latency.max * 10) / 10,
        avgLatencyMs: this.events ? Math.round((this.latency.sum / this.events) * 100) / 100 : 0,
      },
      sales: this.sales.slice(-120),
      finish: this.finished,
      ...extra,
    };
  }
}
