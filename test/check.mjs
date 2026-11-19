// Проверка устойчивости: стратегия не падает и не выдаёт недопустимых команд
// на разных мирах и при изменённых параметрах (короткая смена как в проверке API,
// маленький склад, другие диапазоны цен, другие паузы покупателей).
import { World } from '../src/engine.mjs';
import { Strategy } from '../src/strategy.mjs';

const variants = [
  { name: 'v1 (600 тактов)', params: {} },
  { name: 'проверка API (60 тактов)', params: { horizon: 60 }, mode: 'check' },
  { name: 'склад 6', params: { capacity: 6 } },
  { name: 'склад 30', params: { capacity: 30 } },
  { name: 'пауза покупателя 3', params: { buyerCooldown: 3 } },
  { name: 'пауза покупателя 20', params: { buyerCooldown: 20 } },
  { name: 'цены 20…95, f 0.1…0.9', params: { pmaxRange: [20, 95], fRange: [0.1, 0.9] } },
  { name: '6 покупателей', params: { buyers: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] } },
  { name: 'дорогое хранение', params: { storageFee: { sheet: 0.5, control: 0.5, body: 1, robot: 3 } } },
  { name: 'частые поставки', params: { supply: [{ kind: 'sheet', price: 4, minGap: 1, maxGap: 2 }, { kind: 'control', price: 3, minGap: 1, maxGap: 2 }] } },
];

let failed = 0;
for (const v of variants) {
  const profits = [];
  let invalid = 0;
  let maxLat = 0;
  for (let seed = 1; seed <= 5; seed++) {
    const w = new World(seed * 7919, { mode: v.mode || 'practice', params: v.params });
    let crashed = null;
    const s = new Strategy();
    const wrapped = {
      start: (m) => s.start(m),
      event: (r) => {
        try {
          return s.event(r);
        } catch (e) {
          crashed = e;
          throw e;
        }
      },
      finish: (m) => s.finish(m),
    };
    const r = await w.run(wrapped);
    if (crashed) {
      console.error(`  ✗ ${v.name}, мир ${seed}: исключение`, crashed);
      failed++;
    }
    invalid += r.stats.invalid;
    maxLat = Math.max(maxLat, r.stats.maxLatencyMs);
    profits.push(r.profit);
  }
  const ok = invalid === 0;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${v.name.padEnd(28)} недопустимых: ${invalid}  прибыль: ${profits.map((p) => p.toFixed(0)).join(', ')}  макс. ответ ${maxLat.toFixed(1)} мс`);
}
if (failed) {
  console.error(`\nПровалено: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки пройдены');
