// Стратегия «Байесовский планировщик».
// Один экземпляр на прогон (runId). Методы: start(msg), event(req) -> {commands}, finish(msg).
// Подробное описание — в STRATEGY.md.

import { BuyerModel, bestThreshold } from './model.mjs';
import { matchesTemplate, allTypes, typeKey } from './util.mjs';

const DEFAULTS = {
  holdCostPerTick: 1.5, // доплата за такт ожидания на каждое недостающее до 4 свободное место склада
  planWaitCost: 2.5, // штраф за такт ожидания окна покупателя при выборе типа к производству
  refuseCost: 1.5, // потеря от отказа: простой покупателя
  explore: 0.5, // оптимизм при выборе типа к производству (доля std)
  maxRaw: 5, // не держать больше стольких заготовок одного вида
  maxBodiesUnpainted: 2,
  maxBodiesPainted: 3,
  rawImbalance: 3,
  noise: 0.025,
};

export class Strategy {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
  }

  start(msg) {
    this.cfg = msg;
    this.H = msg.horizon;
    this.cd = msg.buyerCooldown ?? 8;
    this.fee = msg.offerFee ?? 1;
    this.buyers = msg.buyers;
    const { names, types } = allTypes(msg.attributes || { color: ['red', 'green', 'blue'], handles: [true, false] });
    this.attrNames = names;
    this.types = types;
    this.typeIdx = new Map(types.map((ty, i) => [typeKey(ty, names), i]));
    this.models = new Map(
      this.buyers.map((b) => [b, new BuyerModel({ types, attrNames: names, priceCeiling: msg.priceCeiling ?? 100, noise: this.o.noise })]),
    );
    this._parseMachines(msg.machines || []);
    this.myCd = new Map(); // buyerId -> такт, с которого снова доступен (по нашим предложениям)
    this.plan = new Map(); // itemId -> { buyer, typeIdx }
    this.jobs = new Map(); // machineId -> { inputIds, plan }
    this.offers = new Map(); // itemId -> { buyerId, minPrice, t }
    this.stats = { invalid: 0, invalidReasons: {}, offers: 0, sold: 0, refused: 0, revenue: 0, events: 0 };
    this.sales = []; // журнал продаж/отказов
    return { ok: true };
  }

  _parseMachines(machines) {
    this.machines = machines;
    this.role = { cut: [], handles: [], paint: [], assemble: [] }; // [{machine, op}]
    for (const m of machines) {
      for (const op of m.ops || []) {
        const out = op.output || {};
        const outProps = out.props || {};
        const inKinds = (op.inputs || []).map((i) => i.kind);
        if (out.kind === 'robot') this.role.assemble.push({ m: m.id, op });
        else if (inKinds.includes('sheet') && out.kind === 'body') this.role.cut.push({ m: m.id, op });
        else if (out.kind === 'body' && outProps.handles === true) this.role.handles.push({ m: m.id, op });
        else if (out.kind === 'body' && typeof outProps.color === 'string') this.role.paint.push({ m: m.id, op, color: outProps.color });
      }
    }
    this.opDur = {
      cut: this.role.cut[0]?.op.duration ?? 2,
      handles: this.role.handles[0]?.op.duration ?? 2,
      paint: this.role.paint[0]?.op.duration ?? 3,
      assemble: this.role.assemble[0]?.op.duration ?? 3,
    };
    this.opCost = {
      handles: this.role.handles[0]?.op.cost ?? 2,
    };
  }

  // ---------- вспомогательное ----------

  _robotType(item) {
    return this.typeIdx.get(typeKey(item.props, this.attrNames));
  }

  _availAt(b, t) {
    const st = this.state.buyers?.find((x) => x.id === b);
    let a = t;
    if (st && st.cooldownUntil !== null && st.cooldownUntil !== undefined) a = Math.max(a, st.cooldownUntil);
    const mine = this.myCd.get(b);
    if (mine !== undefined) a = Math.max(a, mine);
    return a;
  }

  /** Ценность продажи типа T покупателю b при лучшем пороге (без альтернатив). */
  _value(b, T) {
    const key = b + '#' + T;
    if (this._vcache.has(key)) return this._vcache.get(key);
    const d = this.models.get(b).dist(T);
    const r = bestThreshold(d, 0, this.fee, this.o.refuseCost, this.o.noise);
    const v = { v: Math.max(0, r.gain), std: d.std, mean: d.mean };
    this._vcache.set(key, v);
    return v;
  }

  // ---------- обработка события ----------

  event(req) {
    const t = req.t;
    this.t = t;
    this.state = req.state;
    this._vcache = new Map();
    this.stats.events++;
    for (const r of req.report || []) {
      if (!r.ok) {
        this.stats.invalid++;
        this.stats.invalidReasons[r.reason] = (this.stats.invalidReasons[r.reason] || 0) + 1;
      }
    }
    const ev = req.event || {};
    if (ev.type === 'sale_result') this._onSale(ev, t);
    if (ev.type === 'machine_done') this._onDone(ev);

    const cmds = [];
    const inv = new Map((req.state.storage?.items || []).map((i) => [i.id, i]));
    const ctx = {
      t,
      cmds,
      inv,
      free: req.state.storage?.free ?? 0,
      busy: new Map((req.state.machines || []).map((m) => [m.id, m.busyUntil !== null && m.busyUntil !== undefined])),
      used: new Set(),
    };

    this._produce(ctx);
    if (ev.type === 'supply') this._supply(ctx, ev);
    this._produce(ctx);
    this._sell(ctx);
    this._cleanup(ctx);
    this._gcPlans(ctx);
    return { commands: cmds.slice(0, 50) };
  }

  _onSale(ev, t) {
    const off = this.offers.get(ev.itemId);
    this.offers.delete(ev.itemId);
    const T = this._robotType(ev.item || {});
    const entry = { t, buyerId: ev.buyerId, itemId: ev.itemId, type: ev.item?.props, outcome: ev.outcome, price: ev.price, reason: ev.reason, minPrice: off?.minPrice };
    this.sales.push(entry);
    if (ev.outcome === 'sold') {
      this.stats.sold++;
      this.stats.revenue += ev.price || 0;
      this.plan.delete(ev.itemId);
    } else this.stats.refused++;
    if (ev.reason === 'cooldown') return; // о цене ничего не узнали
    const model = this.models.get(ev.buyerId);
    if (!model || T === undefined) return;
    if (ev.outcome === 'sold') model.observe({ typeIdx: T, outcome: 'sold', price: ev.price });
    else model.observe({ typeIdx: T, outcome: 'refused', minPrice: off ? off.minPrice : 0 });
  }

  _onDone(ev) {
    const job = this.jobs.get(ev.machineId);
    this.jobs.delete(ev.machineId);
    if (job && job.plan && ev.item) this.plan.set(ev.item.id, job.plan);
  }

  _gcPlans(ctx) {
    for (const id of this.plan.keys()) if (!ctx.inv.has(id)) this.plan.delete(id);
  }

  _start(ctx, machineId, op, items, plan) {
    ctx.cmds.push({ cmd: 'start', machineId, opId: op.id, itemIds: items.map((i) => i.id) });
    for (const i of items) {
      ctx.inv.delete(i.id);
      ctx.used.add(i.id);
    }
    ctx.free += items.length - 1;
    ctx.busy.set(machineId, true);
    ctx.slots = null;
    this.jobs.set(machineId, { inputIds: items.map((i) => i.id), plan: plan || null });
  }

  _items(ctx, pred) {
    const out = [];
    for (const it of ctx.inv.values()) if (!ctx.used.has(it.id) && pred(it)) out.push(it);
    return out;
  }

  _counts(ctx) {
    const c = { sheet: 0, control: 0, bodyRaw: 0, bodyPainted: 0, robot: 0 };
    for (const it of ctx.inv.values()) {
      if (it.kind === 'sheet') c.sheet++;
      else if (it.kind === 'control') c.control++;
      else if (it.kind === 'robot') c.robot++;
      else if (it.kind === 'body') {
        if (it.props?.color === null || it.props?.color === undefined) c.bodyRaw++;
        else c.bodyPainted++;
      }
    }
    // предметы в станках
    for (const [mid, j] of this.jobs) {
      if (!ctx.busy.get(mid)) continue;
      const r = this._roleOfMachine(mid);
      if (r === 'cut' || r === 'handles') c.bodyRaw++;
      else if (r === 'paint') c.bodyPainted++;
    }
    return c;
  }

  _roleOfMachine(mid) {
    for (const r of Object.keys(this.role)) if (this.role[r].some((x) => x.m === mid)) return r;
    return null;
  }

  /**
   * Окна покупателей после раскладки всего задела (роботы на складе, окрашенные корпуса,
   * корпуса в станках с известным типом). Возвращает Map buyer -> такт ближайшего свободного окна.
   */
  _slots(ctx) {
    if (ctx.slots) return ctx.slots;
    const t = ctx.t;
    const backlog = [];
    for (const it of ctx.inv.values()) {
      if (it.kind === 'robot' || (it.kind === 'body' && it.props?.color != null)) {
        const T = this._robotType(it);
        if (T !== undefined) backlog.push(T);
      }
    }
    for (const [mid, j] of this.jobs) if (ctx.busy.get(mid) && j.plan && j.plan.typeIdx !== undefined) backlog.push(j.plan.typeIdx);
    const next = new Map(this.buyers.map((b) => [b, Math.max(t, this._availAt(b, t))]));
    for (const T of backlog) {
      let best = null;
      for (const b of this.buyers) {
        const net = this._value(b, T).v - this.o.planWaitCost * (next.get(b) - t);
        if (!best || net > best.net) best = { b, net };
      }
      if (best && best.net > 0) next.set(best.b, next.get(best.b) + this.cd);
    }
    ctx.slots = next;
    return next;
  }

  /** Выбрать тип робота (и целевого покупателя) для корпуса. handlesFixed: true/false/null. */
  _choosePlan(ctx, handlesFixed, extraDelay, plainOnly = false) {
    const t = ctx.t;
    const c = this._counts(ctx);
    let best = null;
    for (let T = 0; T < this.types.length; T++) {
      const ty = this.types[T];
      if (handlesFixed === true && ty.handles !== true) continue;
      if (plainOnly && ty.handles === true) continue;
      const needHandles = ty.handles === true && handlesFixed !== true;
      const ready = t + extraDelay + (needHandles ? this.opDur.handles : 0) + this.opDur.paint + this.opDur.assemble + this.opDur.paint * c.bodyPainted;
      for (const b of this.buyers) {
        const val = this._value(b, T);
        const saleAt = Math.max(ready, this._slots(ctx).get(b));
        if (saleAt > this.H) continue;
        const score = val.v + this.o.explore * val.std - this.o.planWaitCost * (saleAt - ready) - (needHandles ? this.opCost.handles : 0);
        if (!best || score > best.score) best = { score, T, buyer: b, needHandles };
      }
    }
    return best;
  }

  // ---------- производство ----------

  _produce(ctx) {
    const t = ctx.t;
    const H = this.H;
    const D = this.opDur;
    let progress = true;
    let guard = 0;
    while (progress && guard++ < 20) {
      progress = false;
      // 1) сборка: окрашенный корпус + элемент управления
      for (const a of this.role.assemble) {
        if (ctx.busy.get(a.m)) continue;
        if (t + D.assemble > H) continue;
        const bodies = this._items(ctx, (i) => matchesTemplate(i, a.op.inputs[0]));
        const ctrls = this._items(ctx, (i) => matchesTemplate(i, a.op.inputs[1]));
        if (!bodies.length || !ctrls.length) continue;
        // выгоднее всего сначала собрать тот тип, у которого лучший покупатель
        bodies.sort((x, y) => this._bestValueOfProps(y.props) - this._bestValueOfProps(x.props));
        const body = bodies[0];
        this._start(ctx, a.m, a.op, [body, ctrls[0]], { ...(this.plan.get(body.id) || {}), typeIdx: this._robotType(body) });
        progress = true;
      }
      const c = this._counts(ctx);
      // 2) покраска
      for (const p of uniqueMachines(this.role.paint)) {
        if (ctx.busy.get(p)) continue;
        if (t + D.paint + D.assemble > H) continue;
        if (c.bodyPainted >= this.o.maxBodiesPainted) continue;
        const ops = this.role.paint.filter((x) => x.m === p);
        const cand = this._items(ctx, (i) => ops.some((o) => matchesTemplate(i, o.op.inputs[0])));
        if (!cand.length) continue;
        // корпуса с ручками (уже прошли ручки) — в первую очередь
        cand.sort((x, y) => (y.props?.handles === true) - (x.props?.handles === true));
        let started = false;
        for (const body of cand) {
          const hasH = body.props?.handles === true;
          const plan = this._choosePlan(ctx, hasH ? true : null, 0);
          let T;
          let buyer = plan ? plan.buyer : null;
          if (!plan) T = this._fallbackType(hasH);
          else if (plan.needHandles && this.role.handles.length) {
            // корпусу нужны ручки — красить его сейчас нельзя; но если станок ручек занят,
            // а альтернатива без ручек почти так же хороша, красим без ручек
            const alt = this._choosePlan(ctx, false, 0, true);
            const handlesBusy = this.role.handles.every((h) => ctx.busy.get(h.m));
            if (handlesBusy && alt && alt.score >= plan.score - 3 && this.types[alt.T].handles !== true) {
              T = alt.T;
              buyer = alt.buyer;
            } else continue;
          } else T = plan.T;
          const color = this.types[T]?.color;
          const op = ops.find((o) => o.color === color && matchesTemplate(body, o.op.inputs[0])) || ops.find((o) => matchesTemplate(body, o.op.inputs[0]));
          if (!op) continue;
          this._start(ctx, p, op.op, [body], { buyer, typeIdx: T });
          c.bodyPainted++;
          progress = started = true;
          break;
        }
        if (started) continue;
      }
      // 3) ручки
      for (const h of this.role.handles) {
        if (ctx.busy.get(h.m)) continue;
        if (t + D.handles + D.paint + D.assemble > H) continue;
        const cand = this._items(ctx, (i) => matchesTemplate(i, h.op.inputs[0]));
        for (const body of cand) {
          const plan = this._choosePlan(ctx, null, 0);
          if (!plan || !plan.needHandles) continue;
          this._start(ctx, h.m, h.op, [body], { buyer: plan.buyer, typeIdx: plan.T });
          progress = true;
          break;
        }
      }
      // 4) резка
      for (const k of this.role.cut) {
        if (ctx.busy.get(k.m)) continue;
        if (t + D.cut + D.paint + D.assemble > H) continue;
        const cc = this._counts(ctx);
        if (cc.bodyRaw >= this.o.maxBodiesUnpainted) continue;
        const sheets = this._items(ctx, (i) => matchesTemplate(i, k.op.inputs[0]));
        if (!sheets.length) continue;
        this._start(ctx, k.m, k.op, [sheets[0]], null);
        progress = true;
      }
    }
  }

  _fallbackType(hasHandles) {
    const i = this.types.findIndex((ty) => (hasHandles ? ty.handles === true : ty.handles !== true));
    return i >= 0 ? i : 0;
  }

  _bestValueOfProps(props) {
    const T = this._robotType({ props });
    if (T === undefined) return 0;
    let best = 0;
    for (const b of this.buyers) best = Math.max(best, this._value(b, T).v);
    return best;
  }

  // ---------- поставки ----------

  _supply(ctx, ev) {
    const it = ev.item;
    if (!it || ctx.free <= 0) return;
    const t = ctx.t;
    const D = this.opDur;
    const c = this._counts(ctx);
    const bodiesAll = c.bodyRaw + c.bodyPainted;
    let ok = false;
    if (it.kind === 'sheet') {
      const left = this.H - t;
      ok = left >= D.cut + D.paint + D.assemble + D.paint * (c.sheet + bodiesAll) * 0.9;
      ok = ok && c.sheet < this.o.maxRaw && c.sheet + bodiesAll - c.control <= this.o.rawImbalance;
    } else if (it.kind === 'control') {
      const left = this.H - t;
      ok = left >= D.assemble + D.assemble * c.control * 0.9 + (bodiesAll === 0 ? D.cut + D.paint : 0);
      ok = ok && c.control < this.o.maxRaw && c.control - (c.sheet + bodiesAll) <= this.o.rawImbalance;
    } else {
      ok = false;
    }
    // когда остаётся одно место — берём только дефицитный вид
    if (ok && ctx.free === 1) {
      const sheetSide = c.sheet + bodiesAll;
      ok = it.kind === 'sheet' ? sheetSide <= c.control : c.control <= sheetSide;
    }
    if (ok) {
      ctx.cmds.push({ cmd: 'accept', itemId: it.id });
      ctx.inv.set(it.id, it);
      ctx.free -= 1;
    }
  }

  // ---------- продажи ----------

  _offerTerms(b, T, reserve) {
    return bestThreshold(this.models.get(b).dist(T), reserve, this.fee, this.o.refuseCost, this.o.noise);
  }

  /** Цена такта ожидания робота: плата за хранение + давление на склад (теряются поставки). */
  _holdCost(free) {
    const base = this.cfg.storageFee?.robot ?? 0.5;
    return base + this.o.holdCostPerTick * Math.max(0, 4 - free);
  }

  /**
   * Продажи. Роботы на складе жадно раскладываются по будущим «окнам» покупателей
   * (окно — момент, когда покупатель снова принимает предложения; после сделки — +cooldown).
   * Робот, получивший окно «сейчас», предлагается этому покупателю; minPrice — порог,
   * при котором сделка выгоднее лучшей альтернативы (следующего окна у другого покупателя).
   */
  _sell(ctx) {
    const t = ctx.t;
    const robots = this._items(ctx, (i) => i.kind === 'robot' && !this.offers.has(i.id))
      .map((r) => ({ r, T: this._robotType(r) }))
      .filter((x) => x.T !== undefined);
    if (!robots.length) return;
    const hold = this._holdCost(ctx.free);
    const next = new Map(this.buyers.map((b) => [b, Math.max(t, this._availAt(b, t))]));
    const assigned = [];
    const left = [...robots];
    while (left.length) {
      let best = null;
      for (const x of left) {
        for (const b of this.buyers) {
          const when = next.get(b);
          if (when > this.H) continue;
          const net = this._value(b, x.T).v - hold * (when - t);
          if (!best || net > best.net) best = { x, b, when, net };
        }
      }
      if (!best || best.net <= 0) break;
      assigned.push(best);
      left.splice(left.indexOf(best.x), 1);
      next.set(best.b, best.when + this.cd);
    }
    for (const a of assigned) {
      if (a.when > t) continue;
      // альтернатива: следующее окно любого покупателя (после раскладки остальных роботов)
      let reserve = 0;
      for (const b2 of this.buyers) {
        const when = b2 === a.b ? next.get(b2) : next.get(b2);
        if (when > this.H) continue;
        const v = this._value(b2, a.x.T).v - hold * (when - t);
        if (b2 !== a.b && v > reserve) reserve = v;
      }
      const res = this._offerTerms(a.b, a.x.T, reserve);
      if (res.gain <= 0) continue;
      ctx.cmds.push({ cmd: 'offer', buyerId: a.b, itemId: a.x.r.id, minPrice: res.minPrice });
      this.offers.set(a.x.r.id, { buyerId: a.b, minPrice: res.minPrice, t });
      this.myCd.set(a.b, t + this.cd);
      this.stats.offers++;
    }
  }

  // ---------- утилизация ----------

  _cleanup(ctx) {
    const t = ctx.t;
    const D = this.opDur;
    for (const it of [...ctx.inv.values()]) {
      if (ctx.used.has(it.id) || this.offers.has(it.id)) continue;
      let drop = false;
      if (it.kind === 'robot') {
        // никто не даст за него больше комиссии, либо смена закончилась
        const T = this._robotType(it);
        const best = T === undefined ? 0 : Math.max(...this.buyers.map((b) => this._value(b, T).v));
        const anyBuyerLater = this.buyers.some((b) => this._availAt(b, t) <= this.H);
        drop = best < 0.3 && t > 20 ? true : !anyBuyerLater;
        if (t >= this.H && this.buyers.every((b) => this._availAt(b, t) > t)) drop = true;
      } else if (it.kind === 'sheet') drop = t + D.cut + D.paint + D.assemble > this.H;
      else if (it.kind === 'control') drop = t + D.assemble > this.H;
      else if (it.kind === 'body') {
        const painted = it.props?.color !== null && it.props?.color !== undefined;
        drop = t + D.assemble + (painted ? 0 : D.paint) > this.H;
      }
      if (drop) {
        ctx.cmds.push({ cmd: 'discard', itemId: it.id });
        ctx.inv.delete(it.id);
        ctx.used.add(it.id);
        ctx.free += 1;
      }
    }
  }

  finish(msg) {
    this.result = msg;
    return { ok: true };
  }

  /** Текущие оценки (для /debug и интерфейса). */
  beliefs() {
    const out = [];
    for (const b of this.buyers || []) {
      const m = this.models.get(b);
      for (let T = 0; T < this.types.length; T++) {
        const d = m.dist(T);
        out.push({ buyerId: b, ...this.types[T], low: m.quantile(T, 0.1), high: m.quantile(T, 0.9), mean: Math.round(d.mean * 10) / 10 });
      }
    }
    return out;
  }

  buyerSummary() {
    return (this.buyers || []).map((b) => {
      const m = this.models.get(b);
      const probs = m.sampleProbs();
      let bi = 0;
      probs.forEach((p, i) => {
        if (p > probs[bi]) bi = i;
      });
      return { buyerId: b, sample: this.types[bi], confidence: probs[bi], pmax: Math.round(m.meanP * 10) / 10, f: Math.round(m.meanF * 100) / 100 };
    });
  }
}

function uniqueMachines(list) {
  return [...new Set(list.map((x) => x.m))];
}
