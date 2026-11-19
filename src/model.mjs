// Байесовская модель одного покупателя.
//
// Форма правила известна: у покупателя скрыты образец s (один из типов роботов),
// максимальная цена Pmax и коэффициент f. Базовая цена за робот типа T:
//   0 расхождений -> Pmax, 1 -> Pmax*f, 2 и больше -> 0;
// в сделке к ней добавляется поправка ±noise (по спецификации 2%).
//
// Мы держим апостериорное распределение на сетке (s, Pmax, f) и обновляем его
// по каждому ответу: «продано по p» и «отказ при minPrice = m».
// Так одна продажа сразу уточняет цены этого покупателя на все 6 типов.
// Априорные диапазоны из спецификации заданы «мягко»: вне их вес мал, но не ноль,
// поэтому модель не ломается, если в другом раунде диапазоны изменятся.

const EPS = 1e-3;

export class BuyerModel {
  constructor({ types, attrNames, priceCeiling = 100, pmaxPrior = [45, 75], fPrior = [0.3, 0.6], outsideWeight = 0.03, noise = 0.025 }) {
    this.types = types;
    this.attrNames = attrNames;
    this.noise = noise;
    this.ceiling = priceCeiling;
    this.binW = 0.5;
    this.nB = Math.ceil(priceCeiling / this.binW) + 2;
    this.P = [];
    for (let p = this.binW; p <= priceCeiling + 1e-9; p += this.binW) this.P.push(p);
    this.F = [];
    for (let f = 0.02; f <= 0.98 + 1e-9; f += 0.01) this.F.push(Math.round(f * 100) / 100);
    this.nS = types.length;
    this.nP = this.P.length;
    this.nF = this.F.length;
    this.mism = types.map((s) => types.map((t) => attrNames.reduce((n, a) => n + (s[a] !== t[a] ? 1 : 0), 0)));
    this.w = new Float64Array(this.nS * this.nP * this.nF);
    // априорные веса
    const wp = this.P.map((p) => (p >= pmaxPrior[0] - 1e-9 && p <= pmaxPrior[1] + 1e-9 ? 1 : outsideWeight));
    const wf = this.F.map((f) => (f >= fPrior[0] - 1e-9 && f <= fPrior[1] + 1e-9 ? 1 : outsideWeight));
    let i = 0;
    for (let s = 0; s < this.nS; s++)
      for (let a = 0; a < this.nP; a++)
        for (let b = 0; b < this.nF; b++) this.w[i++] = wp[a] * wf[b];
    this.history = [];
    this._normalize();
    this._recompute();
  }

  binOf(x) {
    const k = Math.round(x / this.binW);
    return k < 0 ? 0 : k >= this.nB ? this.nB - 1 : k;
  }

  _lik(B, obs) {
    const nz = this.noise;
    if (obs.outcome === 'sold') {
      const p = obs.price;
      if (B <= 1e-9) return p <= 0.011 ? 50 : EPS;
      return Math.abs(p - B) <= nz * B + 0.011 ? 1 / (2 * nz * B + 0.022) : EPS * 0.01;
    }
    // отказ по цене при minPrice = m: B*(1+e) < m
    const m = obs.minPrice;
    if (B <= 1e-9) return m > 0 ? 1 : EPS;
    const lo = B * (1 - nz);
    const hi = B * (1 + nz);
    if (m <= lo) return EPS;
    if (m >= hi) return 1;
    return Math.max(EPS, (m - lo) / (hi - lo));
  }

  /** obs: { typeIdx, outcome: 'sold'|'refused', price?, minPrice? } */
  observe(obs) {
    this.history.push(obs);
    const T = obs.typeIdx;
    const { nP, nF, P, F, w } = this;
    for (let s = 0; s < this.nS; s++) {
      const mm = this.mism[s][T];
      const base = s * nP * nF;
      if (mm === 0) {
        for (let a = 0; a < nP; a++) {
          const L = this._lik(P[a], obs);
          const o = base + a * nF;
          for (let b = 0; b < nF; b++) w[o + b] *= L;
        }
      } else if (mm === 1) {
        for (let a = 0; a < nP; a++) {
          const o = base + a * nF;
          for (let b = 0; b < nF; b++) w[o + b] *= this._lik(P[a] * F[b], obs);
        }
      } else {
        const L = this._lik(0, obs);
        for (let k = 0; k < nP * nF; k++) w[base + k] *= L;
      }
    }
    this._normalize();
    this._recompute();
  }

  _normalize() {
    let sum = 0;
    for (let k = 0; k < this.w.length; k++) sum += this.w[k];
    if (!(sum > 0) || !Number.isFinite(sum)) {
      this.w.fill(1);
      sum = this.w.length;
    }
    for (let k = 0; k < this.w.length; k++) this.w[k] /= sum;
  }

  _recompute() {
    const { nS, nP, nF, P, F, w } = this;
    this.margP = [];
    this.margQ = [];
    this.mass = new Float64Array(nS);
    this.meanP = 0;
    this.meanF = 0;
    for (let s = 0; s < nS; s++) {
      const mp = new Float64Array(nP);
      const mq = new Float64Array(this.nB);
      let ms = 0;
      for (let a = 0; a < nP; a++) {
        const o = s * nP * nF + a * nF;
        let rowSum = 0;
        for (let b = 0; b < nF; b++) {
          const x = w[o + b];
          if (x === 0) continue;
          rowSum += x;
          mq[this.binOf(P[a] * F[b])] += x;
          this.meanF += x * F[b];
        }
        mp[a] = rowSum;
        ms += rowSum;
        this.meanP += rowSum * P[a];
      }
      this.margP.push(mp);
      this.margQ.push(mq);
      this.mass[s] = ms;
    }
    this._distCache = new Map();
  }

  /** Распределение базовой цены за тип T: массив вероятностей по корзинам шириной binW. */
  dist(T) {
    let d = this._distCache.get(T);
    if (d) return d;
    const p = new Float64Array(this.nB);
    for (let s = 0; s < this.nS; s++) {
      const mm = this.mism[s][T];
      if (mm === 0) {
        const mp = this.margP[s];
        for (let a = 0; a < this.nP; a++) p[this.binOf(this.P[a])] += mp[a];
      } else if (mm === 1) {
        const mq = this.margQ[s];
        for (let k = 0; k < this.nB; k++) p[k] += mq[k];
      } else p[0] += this.mass[s];
    }
    // суффиксные суммы для быстрого подбора порога
    const SP = new Float64Array(this.nB + 1);
    const SPB = new Float64Array(this.nB + 1);
    for (let k = this.nB - 1; k >= 0; k--) {
      SP[k] = SP[k + 1] + p[k];
      SPB[k] = SPB[k + 1] + p[k] * k * this.binW;
    }
    const mean = SPB[0];
    let v = 0;
    for (let k = 0; k < this.nB; k++) v += p[k] * (k * this.binW - mean) ** 2;
    d = { p, SP, SPB, mean, std: Math.sqrt(Math.max(0, v)), binW: this.binW };
    this._distCache.set(T, d);
    return d;
  }

  quantile(T, q) {
    const d = this.dist(T);
    let acc = 0;
    for (let k = 0; k < d.p.length; k++) {
      acc += d.p[k];
      if (acc >= q) return k * this.binW;
    }
    return this.ceiling;
  }

  /** Вероятности образцов (для интерфейса). */
  sampleProbs() {
    return Array.from(this.mass);
  }
}

/**
 * Лучший порог продажи. Продажа происходит, если цена покупателя >= порога;
 * выручка — сама цена покупателя. reserve — сколько робот стоит без этой сделки.
 * Возвращает { gain, k, minPrice, pSell }.
 */
export function bestThreshold(d, reserve, fee, refuseCost, noise = 0.025) {
  let best = { gain: -Infinity, k: 0, pSell: 1 };
  const n = d.p.length;
  for (let k = 0; k < n; k++) {
    if (k > 0 && d.p[k] === 0 && d.p[k - 1] === 0) continue;
    const sp = d.SP[k];
    if (sp < 1e-6) break;
    const gain = d.SPB[k] - reserve * sp - fee - (1 - sp) * refuseCost;
    if (gain > best.gain) best = { gain, k, pSell: sp };
  }
  const thr = best.k * d.binW - d.binW / 2;
  best.minPrice = thr <= 0 ? 0 : Math.max(0, Math.floor(thr * (1 - noise) * 100) / 100);
  return best;
}
