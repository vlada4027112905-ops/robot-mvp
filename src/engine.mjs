// Собственный эмулятор завода по спецификации v1.
// Детерминирован по номеру мира (seed): поставки, скрытые покупатели и поправки цен.
// Стратегия — объект с методами start(msg), event(req) -> {commands}, finish(msg)
// (методы могут быть async: так же подключается удалённый HTTP-сервис).

import { mulberry32, hashSeed, matchesTemplate, resultProps, round2, allTypes } from './util.mjs';

const paintOp = (color) => ({
  id: `paint-${color}`,
  inputs: [{ kind: 'body', props: { color: null } }],
  inherit: 0,
  output: { kind: 'body', props: { color } },
  duration: 3,
  cost: 2,
});

export const V1_MACHINES = [
  { id: 'm-cut', ops: [{ id: 'cut', inputs: [{ kind: 'sheet' }], output: { kind: 'body', props: { color: null, handles: false } }, duration: 2, cost: 1 }] },
  { id: 'm-handles', ops: [{ id: 'add-handles', inputs: [{ kind: 'body', props: { color: null, handles: false } }], inherit: 0, output: { kind: 'body', props: { handles: true } }, duration: 2, cost: 2 }] },
  { id: 'm-paint', ops: ['red', 'green', 'blue'].map(paintOp) },
  { id: 'm-assemble', ops: [{ id: 'assemble', inputs: [{ kind: 'body', props: { color: '*' } }, { kind: 'control' }], inherit: 0, output: { kind: 'robot', props: {} }, duration: 3, cost: 3 }] },
];

export const DEFAULT_PARAMS = {
  horizon: 600,
  eventTimeoutMs: 2000,
  idleEvery: 10,
  capacity: 12,
  storageFee: { sheet: 0.1, control: 0.1, body: 0.2, robot: 0.5 },
  offerFee: 1,
  buyerCooldown: 8,
  priceCeiling: 100,
  buyers: ['b1', 'b2', 'b3', 'b4'],
  attributes: { color: ['red', 'green', 'blue'], handles: [true, false] },
  machines: V1_MACHINES,
  // скрытая часть мира (в start не передаётся)
  supply: [
    { kind: 'sheet', price: 4, minGap: 2, maxGap: 4 },
    { kind: 'control', price: 3, minGap: 2, maxGap: 4 },
  ],
  pmaxRange: [45, 75],
  fRange: [0.3, 0.6],
  noise: 0.02,
  invalidCommandFine: 0,
  maxCommands: 50,
};

const PUBLIC_KEYS = ['horizon', 'eventTimeoutMs', 'idleEvery', 'capacity', 'storageFee', 'offerFee', 'buyerCooldown', 'priceCeiling', 'buyers', 'attributes', 'machines'];

export class World {
  constructor(seed = 1, { mode = 'practice', params = {} } = {}) {
    this.seed = seed;
    this.mode = mode;
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.runId = `local-${seed}-${Date.now().toString(36)}`;
    const p = this.p;
    const supplyRng = mulberry32(hashSeed('supply', seed));
    const buyerRng = mulberry32(hashSeed('buyers', seed));
    this.noiseRng = mulberry32(hashSeed('noise', seed));
    const randInt = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

    // Скрытые покупатели
    const { names, types } = allTypes(p.attributes);
    this.attrNames = names;
    this.hidden = p.buyers.map((id) => {
      const sample = types[Math.floor(buyerRng() * types.length)];
      const pmax = round2(p.pmaxRange[0] + buyerRng() * (p.pmaxRange[1] - p.pmaxRange[0]));
      const f = round2(p.fRange[0] + buyerRng() * (p.fRange[1] - p.fRange[0]));
      return { id, sample, pmax, f };
    });

    // Расписание поставок
    this.supplyAt = new Map();
    for (const s of p.supply) {
      let t = randInt(supplyRng, 0, s.maxGap - 1);
      while (t <= p.horizon) {
        if (!this.supplyAt.has(t)) this.supplyAt.set(t, []);
        this.supplyAt.get(t).push(s);
        t += randInt(supplyRng, s.minGap, s.maxGap);
      }
    }
    this.nextId = 1;
    this.cash = 0;
    this.storage = new Map(); // id -> item
    this.machines = p.machines.map((m) => ({ ...m, busyUntil: null, job: null }));
    this.buyerCd = new Map(p.buyers.map((b) => [b, null]));
    this.stats = { sold: 0, refused: 0, invalid: 0, accepted: 0, lost: 0, timeouts: 0, events: 0, maxLatencyMs: 0, produced: 0, revenue: 0, opCost: 0, supplyCost: 0, offerFees: 0, storageFees: 0, discarded: 0 };
  }

  startMessage() {
    const msg = { runId: this.runId, mode: this.mode };
    for (const k of PUBLIC_KEYS) msg[k] = JSON.parse(JSON.stringify(this.p[k]));
    return msg;
  }

  basePrice(buyerId, props) {
    const b = this.hidden.find((h) => h.id === buyerId);
    let mism = 0;
    for (const a of this.attrNames) if (props?.[a] !== b.sample[a]) mism++;
    if (mism === 0) return b.pmax;
    if (mism === 1) return b.pmax * b.f;
    return 0;
  }

  busyCount() {
    return this.machines.filter((m) => m.busyUntil !== null).length;
  }

  free() {
    return this.p.capacity - this.storage.size - this.busyCount();
  }

  snapshot(t) {
    return {
      cash: round2(this.cash),
      storage: { capacity: this.p.capacity, free: this.free(), items: [...this.storage.values()].map((i) => JSON.parse(JSON.stringify(i))) },
      machines: this.machines.map((m) => ({ id: m.id, busyUntil: m.busyUntil })),
      buyers: this.p.buyers.map((id) => {
        const cd = this.buyerCd.get(id);
        return { id, cooldownUntil: cd !== null && cd > t ? cd : null };
      }),
    };
  }

  newItem(kind, props) {
    return { id: `i-${this.nextId++}`, kind, props: props || {} };
  }

  exec(t, cmds, currentSupply, followUps) {
    const report = [];
    const list = Array.isArray(cmds) ? cmds.slice(0, this.p.maxCommands) : [];
    list.forEach((c, i) => {
      const reason = this.execOne(t, c, currentSupply, followUps);
      if (reason) {
        this.stats.invalid++;
        this.cash -= this.p.invalidCommandFine;
        report.push({ cmd: i, ok: false, reason });
      } else report.push({ cmd: i, ok: true });
    });
    return report;
  }

  execOne(t, c, cur, followUps) {
    const p = this.p;
    switch (c && c.cmd) {
      case 'accept': {
        if (!cur || cur.accepted || c.itemId !== cur.item.id) return 'not_offered';
        if (this.free() <= 0) return 'storage_full';
        cur.accepted = true;
        this.storage.set(cur.item.id, cur.item);
        this.cash -= cur.price;
        this.stats.supplyCost += cur.price;
        this.stats.accepted++;
        return null;
      }
      case 'start': {
        const m = this.machines.find((x) => x.id === c.machineId);
        if (!m) return 'unknown_machine';
        const op = m.ops.find((o) => o.id === c.opId);
        if (!op) return 'unknown_op';
        if (m.busyUntil !== null) return 'machine_busy';
        const ids = c.itemIds;
        if (!Array.isArray(ids) || ids.length !== op.inputs.length || new Set(ids).size !== ids.length) return 'bad_inputs';
        const items = ids.map((id) => this.storage.get(id));
        if (items.some((it, k) => !it || !matchesTemplate(it, op.inputs[k]))) return 'bad_inputs';
        for (const id of ids) this.storage.delete(id);
        this.cash -= op.cost || 0;
        this.stats.opCost += op.cost || 0;
        m.busyUntil = t + op.duration;
        m.job = { op, out: this.newItem(op.output.kind, resultProps(op, items)) };
        return null;
      }
      case 'offer': {
        const it = this.storage.get(c.itemId);
        if (!it || it.kind !== 'robot') return 'no_such_robot';
        if (!this.buyerCd.has(c.buyerId)) return 'unknown_buyer';
        const minPrice = Number.isFinite(c.minPrice) ? c.minPrice : 0;
        this.cash -= p.offerFee;
        this.stats.offerFees += p.offerFee;
        const cd = this.buyerCd.get(c.buyerId);
        const ev = { type: 'sale_result', buyerId: c.buyerId, itemId: it.id, item: JSON.parse(JSON.stringify(it)) };
        if (cd !== null && cd > t) {
          Object.assign(ev, { outcome: 'refused', reason: 'cooldown' });
          this.stats.refused++;
        } else {
          const base = this.basePrice(c.buyerId, it.props);
          const noise = 1 + (this.noiseRng() * 2 - 1) * p.noise;
          const price = Math.min(p.priceCeiling, round2(base * noise));
          this.buyerCd.set(c.buyerId, t + p.buyerCooldown);
          if (price >= minPrice) {
            this.storage.delete(it.id);
            this.cash += price;
            this.stats.revenue += price;
            this.stats.sold++;
            Object.assign(ev, { outcome: 'sold', price });
          } else {
            this.stats.refused++;
            Object.assign(ev, { outcome: 'refused', reason: 'below_min_price' });
          }
        }
        followUps.push(ev);
        return null;
      }
      case 'discard': {
        if (!this.storage.has(c.itemId)) return 'no_such_item';
        this.storage.delete(c.itemId);
        this.stats.discarded++;
        return null;
      }
      default:
        return 'unknown_command';
    }
  }

  /** Прогон всей смены. strategy: {start, event, finish}; опционально onTick(t, world) для записи. */
  async run(strategy, { onTick } = {}) {
    const p = this.p;
    await strategy.start(this.startMessage());
    let seq = 0;
    let lastReport = [];
    for (let t = 0; t <= p.horizon; t++) {
      const queue = [];
      for (const m of this.machines) {
        if (m.busyUntil === t) {
          const out = m.job.out;
          this.storage.set(out.id, out);
          if (out.kind === 'robot') this.stats.produced++;
          queue.push({ type: 'machine_done', machineId: m.id, opId: m.job.op.id, item: JSON.parse(JSON.stringify(out)) });
          m.busyUntil = null;
          m.job = null;
        }
      }
      for (const s of this.supplyAt.get(t) || []) {
        queue.push({ type: 'supply', item: this.newItem(s.kind, {}), price: s.price });
      }
      if (queue.length === 0 && p.idleEvery > 0 && t % p.idleEvery === 0) queue.push({ type: 'idle' });

      while (queue.length) {
        const ev = queue.shift();
        const cur = ev.type === 'supply' ? { item: ev.item, price: ev.price, accepted: false } : null;
        const req = { seq: seq++, t, event: JSON.parse(JSON.stringify(ev)), state: this.snapshot(t), report: lastReport };
        const t0 = performance.now();
        let resp;
        try {
          resp = await strategy.event(req);
        } catch (e) {
          resp = null;
        }
        const dt = performance.now() - t0;
        this.stats.events++;
        this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, dt);
        let cmds = resp && Array.isArray(resp.commands) ? resp.commands : [];
        if (!resp || dt > p.eventTimeoutMs) {
          this.stats.timeouts++;
          cmds = [];
        }
        const followUps = [];
        lastReport = this.exec(t, cmds, cur, followUps);
        if (cur && !cur.accepted) this.stats.lost++;
        queue.unshift(...followUps);
      }
      let fee = 0;
      for (const it of this.storage.values()) fee += p.storageFee[it.kind] || 0;
      this.cash -= fee;
      this.stats.storageFees += fee;
      if (onTick) onTick(t, this);
    }
    const result = {
      profit: round2(this.cash),
      sold: this.stats.sold,
      refused: this.stats.refused,
      buyers: this.mode === 'practice' ? this.hidden.map((h) => ({ id: h.id, sample: h.sample, pmax: h.pmax, f: h.f })) : undefined,
    };
    await strategy.finish(result);
    return { ...result, stats: { ...this.stats, revenue: round2(this.stats.revenue), storageFees: round2(this.stats.storageFees) } };
  }
}
