// Стратегии-ориентиры для сравнения в собственном эмуляторе (аналоги эталонов арены).
// Производство у всех общее (из Strategy), различаются выбор типа и продажи.

import { Strategy } from './strategy.mjs';
import { mulberry32 } from './util.mjs';

/** «Наивная»: случайные типы, продаёт любому свободному покупателю за любую цену. */
export class NaiveStrategy extends Strategy {
  start(msg) {
    this.rng = mulberry32(12345);
    return super.start(msg);
  }
  _choosePlan(ctx, handlesFixed, _d, plainOnly) {
    const opts = this.types.map((ty, T) => ({ ty, T })).filter(({ ty }) => (handlesFixed === true ? ty.handles === true : true) && (!plainOnly || ty.handles !== true));
    const pick = opts[Math.floor(this.rng() * opts.length)];
    return { score: 0, T: pick.T, buyer: null, needHandles: pick.ty.handles === true && handlesFixed !== true };
  }
  _sell(ctx) {
    const t = ctx.t;
    const robots = this._items(ctx, (i) => i.kind === 'robot' && !this.offers.has(i.id));
    for (const b of this.buyers) {
      if (!robots.length) break;
      if (this._availAt(b, t) > t) continue;
      const r = robots.shift();
      ctx.cmds.push({ cmd: 'offer', buyerId: b, itemId: r.id, minPrice: 0 });
      this.offers.set(r.id, { buyerId: b, minPrice: 0, t });
      this.myCd.set(b, t + this.cd);
    }
  }
  _cleanup() {}
}

/** «Обучающаяся»: вилка цены по каждой паре (покупатель, тип), деление пополам через minPrice. */
export class LearningStrategy extends Strategy {
  start(msg) {
    const r = super.start(msg);
    this.iv = new Map(); // b#T -> {lo, hi, known}
    return r;
  }
  _iv(b, T) {
    const k = b + '#' + T;
    if (!this.iv.has(k)) this.iv.set(k, { lo: 0, hi: this.cfg.priceCeiling ?? 100, known: false });
    return this.iv.get(k);
  }
  _onSale(ev, t) {
    const off = this.offers.get(ev.itemId);
    super._onSale(ev, t);
    if (ev.reason === 'cooldown') return;
    const T = this._robotType(ev.item || {});
    if (T === undefined) return;
    const iv = this._iv(ev.buyerId, T);
    if (ev.outcome === 'sold') Object.assign(iv, { lo: ev.price * 0.97, hi: ev.price * 1.03, known: true });
    else if (off) iv.hi = Math.min(iv.hi, off.minPrice);
  }
  _value(b, T) {
    const iv = this._iv(b, T);
    const v = iv.known ? iv.lo : (iv.lo + iv.hi) / 2;
    return { v, std: 0, mean: v };
  }
  _sell(ctx) {
    const t = ctx.t;
    const robots = this._items(ctx, (i) => i.kind === 'robot' && !this.offers.has(i.id));
    for (const b of this.buyers) {
      if (!robots.length) break;
      if (this._availAt(b, t) > t) continue;
      // робот, который этому покупателю, по оценке, стоит больше всего
      robots.sort((x, y) => this._value(b, this._robotType(y)).v - this._value(b, this._robotType(x)).v);
      const r = robots[0];
      const iv = this._iv(b, this._robotType(r));
      const minPrice = Math.max(0, Math.floor((iv.known ? iv.lo : (iv.lo + iv.hi) / 2) * 100) / 100);
      if (iv.hi < 5 && t < this.H - 20) continue;
      robots.shift();
      ctx.cmds.push({ cmd: 'offer', buyerId: b, itemId: r.id, minPrice: t > this.H - 15 ? 0 : minPrice });
      this.offers.set(r.id, { buyerId: b, minPrice, t });
      this.myCd.set(b, t + this.cd);
    }
  }
}

/** «Оракул»: знает скрытых покупателей (только для локального сравнения!). */
export class OracleStrategy extends Strategy {
  constructor(hidden, opts) {
    super({ ...opts, explore: 0 });
    this.hidden = hidden;
  }
  _price(b, T) {
    const h = this.hidden.find((x) => x.id === b);
    const ty = this.types[T];
    let mm = 0;
    for (const a of this.attrNames) if (ty[a] !== h.sample[a]) mm++;
    return mm === 0 ? h.pmax : mm === 1 ? h.pmax * h.f : 0;
  }
  _value(b, T) {
    const v = this._price(b, T);
    return { v: Math.max(0, v - this.fee), std: 0, mean: v };
  }
  _offerTerms(b, T, reserve) {
    const v = this._price(b, T);
    return { gain: v - reserve - this.fee, minPrice: Math.floor(v * 0.975 * 100) / 100 };
  }
}
