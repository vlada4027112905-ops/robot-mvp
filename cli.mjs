#!/usr/bin/env node
// Локальное сравнение стратегий в собственном эмуляторе.
//   node cli.mjs --seeds 20            — 20 миров, все стратегии
//   node cli.mjs --seeds 5 --from 100  — миры 100..104
//   node cli.mjs --only bayes --verbose
//   node cli.mjs --url http://localhost:4001 --seeds 3   — прогнать удалённый сервис по HTTP

import { World } from './src/engine.mjs';
import { Strategy } from './src/strategy.mjs';
import { NaiveStrategy, LearningStrategy, OracleStrategy } from './src/baselines.mjs';
import { HttpStrategy } from './src/http-client.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

const seeds = Number(opt('seeds', 20));
const from = Number(opt('from', 1));
const only = opt('only', null);
const url = opt('url', null);
const horizon = opt('horizon', null);

const makers = {
  naive: () => new NaiveStrategy(),
  learning: () => new LearningStrategy(),
  bayes: () => new Strategy(),
  oracle: (w) => new OracleStrategy(w.hidden),
};
if (url) {
  for (const k of Object.keys(makers)) delete makers[k];
  makers.remote = () => new HttpStrategy(url);
}
const names = only ? only.split(',') : Object.keys(makers);

const results = Object.fromEntries(names.map((n) => [n, []]));
for (let s = from; s < from + seeds; s++) {
  const row = [`мир ${String(s).padStart(3)}`];
  for (const n of names) {
    const w = new World(s, { mode: 'practice', params: horizon ? { horizon: Number(horizon) } : {} });
    const strat = makers[n](w);
    const r = await w.run(strat);
    results[n].push(r);
    row.push(`${n}=${r.profit.toFixed(0).padStart(6)}`);
    if (flag('verbose') && n !== 'oracle') {
      console.log(`  [${n}] seed=${s}`, JSON.stringify(r.stats));
      if (strat.buyerSummary) console.log('   оценки:', JSON.stringify(strat.buyerSummary()));
      console.log('   правда:', JSON.stringify(r.buyers));
    }
  }
  console.log(row.join('  '));
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));
console.log('\nИтог (среднее ± разброс по мирам):');
for (const n of names) {
  const p = results[n].map((r) => r.profit);
  const inv = results[n].reduce((x, r) => x + r.stats.invalid, 0);
  const lat = Math.max(...results[n].map((r) => r.stats.maxLatencyMs));
  const sold = mean(results[n].map((r) => r.sold));
  console.log(
    `  ${n.padEnd(9)} прибыль ${mean(p).toFixed(0).padStart(6)} ± ${sd(p).toFixed(0).padStart(4)}   продано ${sold.toFixed(0).padStart(4)}   недопустимых команд ${inv}   макс. время ответа ${lat.toFixed(1)} мс`,
  );
}
