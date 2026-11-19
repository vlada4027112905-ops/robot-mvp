// Пульт смены: опрашивает сервис (/ui/runs) и рисует ход производства на canvas.
(() => {
  const $ = (id) => document.getElementById(id);
  const root = document.querySelector('.viz-root');
  const css = (v) => getComputedStyle(root).getPropertyValue(v).trim();
  const KIND = [
    { k: 'sheet', name: 'листы', c: '--s1' },
    { k: 'control', name: 'элементы управления', c: '--s2' },
    { k: 'body', name: 'корпуса', c: '--s3' },
    { k: 'robot', name: 'роботы', c: '--s4' },
  ];
  const COLOR_RU = { red: 'красный', green: 'зелёный', blue: 'синий' };
  const ROBOT_DOT = { red: '#d93a3a', green: '#2f9e44', blue: '#2f6fdb' };
  const fmt = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : Number(x).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const typeName = (p) => (p ? `${COLOR_RU[p.color] || p.color}${p.handles ? ', с ручками' : ', без ручек'}` : '—');

  let data = null;
  let selected = '';
  let tick = 0;
  let playing = null;
  const tip = $('tip');

  // ---------- общий каркас графика ----------
  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = Number(canvas.getAttribute('height'));
    if (canvas.width !== Math.round(w * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.height = h + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function niceTicks(lo, hi, n = 4) {
    if (hi === lo) hi = lo + 1;
    const raw = (hi - lo) / n;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return { ticks: out, lo: Math.min(lo, out[0]), hi: Math.max(hi, out[out.length - 1]) };
  }

  function frame(canvas, xMax, yLo, yHi, { left = 52, yFmt = (v) => fmt(v) } = {}) {
    const { ctx, w, h } = setup(canvas);
    const pad = { l: left, r: 14, t: 20, b: 22 };
    const yt = niceTicks(yLo, yHi);
    const sx = (t) => pad.l + (t / Math.max(1, xMax)) * (w - pad.l - pad.r);
    const sy = (v) => pad.t + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (h - pad.t - pad.b);
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = css('--text-muted');
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.ticks) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(yFmt(v), pad.l - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xs = niceTicks(0, xMax, 6).ticks.filter((v) => v <= xMax);
    for (const v of xs) ctx.fillText(fmt(v), sx(v), h - pad.b + 6);
    if (yt.lo < 0 && yt.hi > 0) {
      ctx.strokeStyle = css('--text-muted');
      ctx.beginPath();
      ctx.moveTo(pad.l, Math.round(sy(0)) + 0.5);
      ctx.lineTo(w - pad.r, Math.round(sy(0)) + 0.5);
      ctx.stroke();
    }
    return { ctx, w, h, pad, sx, sy };
  }

  function cursor(f, t) {
    const { ctx, pad, sx, h } = f;
    const x = Math.round(sx(t)) + 0.5;
    ctx.strokeStyle = css('--text-secondary');
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function hoverable(canvas, getFrame, html) {
    canvas.addEventListener('mousemove', (e) => {
      const f = getFrame();
      if (!f || !data) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const xMax = data.series.length - 1;
      const t = Math.max(0, Math.min(xMax, Math.round(((x - f.pad.l) / (f.w - f.pad.l - f.pad.r)) * Math.max(1, data.horizon))));
      const content = html(t, e.clientY - r.top);
      if (!content) return (tip.hidden = true);
      tip.innerHTML = content;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + 'px';
      tip.style.top = e.clientY + 14 + 'px';
    });
    canvas.addEventListener('mouseleave', () => (tip.hidden = true));
    canvas.addEventListener('click', (e) => {
      const f = getFrame();
      if (!f || !data) return;
      const r = canvas.getBoundingClientRect();
      const t = Math.round(((e.clientX - r.left - f.pad.l) / (f.w - f.pad.l - f.pad.r)) * data.horizon);
      setTick(Math.max(0, Math.min(data.series.length - 1, t)));
      $('follow').checked = false;
    });
  }

  // ---------- графики ----------
  const frames = {};

  function drawCash() {
    const s = data.series;
    const vals = s.map((x) => x.cash);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(10, ...vals);
    const f = frame($('cCash'), data.horizon, lo, hi);
    frames.cash = f;
    const { ctx, sx, sy } = f;
    ctx.strokeStyle = css('--s1');
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.cash)) : ctx.moveTo(sx(p.t), sy(p.cash))));
    ctx.stroke();
    const last = s[s.length - 1];
    if (last) {
      ctx.fillStyle = css('--s1');
      ctx.beginPath();
      ctx.arc(sx(last.t), sy(last.cash), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = css('--text-primary');
      ctx.font = '600 12px system-ui';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmt(last.cash), sx(last.t) - 6, sy(last.cash) - 4);
    }
    cursor(f, tick);
  }

  function drawStorage() {
    const s = data.series;
    const f = frame($('cStorage'), data.horizon, 0, data.capacity || 12, { left: 36 });
    frames.storage = f;
    const { ctx, sx, sy } = f;
    const acc = s.map(() => 0);
    for (const K of KIND) {
      const top = s.map((p, i) => acc[i] + (p.kinds[K.k] || 0));
      ctx.fillStyle = css(K.c);
      ctx.beginPath();
      s.forEach((p, i) => {
        const x0 = sx(p.t);
        const x1 = sx(p.t + 1);
        if (i === 0) ctx.moveTo(x0, sy(top[i]));
        else ctx.lineTo(x0, sy(top[i]));
        ctx.lineTo(x1, sy(top[i]));
      });
      for (let i = s.length - 1; i >= 0; i--) {
        ctx.lineTo(sx(s[i].t + 1), sy(acc[i]));
        ctx.lineTo(sx(s[i].t), sy(acc[i]));
      }
      ctx.closePath();
      ctx.fill();
      top.forEach((v, i) => (acc[i] = v));
    }
    ctx.strokeStyle = css('--text-primary');
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1;
    const cy = Math.round(sy(data.capacity)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(f.pad.l, cy);
    ctx.lineTo(f.w - f.pad.r, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--text-secondary');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`вместимость ${data.capacity}`, f.pad.l + 4, cy - 2);
    cursor(f, tick);
  }

  function drawFlow() {
    const s = data.series;
    const hi = Math.max(5, ...s.map((p) => p.produced));
    const f = frame($('cFlow'), data.horizon, 0, hi, { left: 40 });
    frames.flow = f;
    const { ctx, sx, sy } = f;
    const lines = [
      ['produced', '--s1'],
      ['sold', '--s2'],
    ];
    for (const [k, c] of lines) {
      ctx.strokeStyle = css(c);
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p[k])) : ctx.moveTo(sx(p.t), sy(p[k]))));
      ctx.stroke();
    }
    cursor(f, tick);
  }

  function drawMachines() {
    const canvas = $('cMachines');
    const { ctx, w, h } = setup(canvas);
    const pad = { l: 92, r: 52, t: 6, b: 22 };
    const ms = data.machines;
    const rowH = (h - pad.t - pad.b) / Math.max(1, ms.length);
    const sx = (t) => pad.l + (t / Math.max(1, data.horizon)) * (w - pad.l - pad.r);
    frames.machines = { pad, sx, w, h, ctx, rowH };
    ctx.font = '12px system-ui';
    ms.forEach((m, i) => {
      const y = pad.t + i * rowH;
      ctx.fillStyle = css('--grid');
      ctx.fillRect(pad.l, y + rowH * 0.2, w - pad.l - pad.r, rowH * 0.6);
      ctx.fillStyle = css('--s1');
      const arr = data.busy[m] || [];
      let k = 0;
      while (k < arr.length) {
        if (!arr[k]) {
          k++;
          continue;
        }
        let j = k;
        while (j < arr.length && arr[j]) j++;
        ctx.fillRect(sx(k), y + rowH * 0.2, Math.max(1, sx(j) - sx(k) - 0.5), rowH * 0.6);
        k = j;
      }
      ctx.fillStyle = css('--text-primary');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(m, pad.l - 8, y + rowH / 2);
      ctx.textAlign = 'left';
      ctx.font = '600 12px system-ui';
      ctx.fillText(`${Math.round((data.util[m] || 0) * 100)}%`, w - pad.r + 8, y + rowH / 2);
      ctx.font = '12px system-ui';
    });
    ctx.fillStyle = css('--text-muted');
    ctx.font = '11px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of niceTicks(0, data.horizon, 6).ticks.filter((v) => v <= data.horizon)) ctx.fillText(fmt(v), sx(v), h - pad.b + 6);
    cursor({ ctx, pad, sx, h }, tick);
  }

  // ---------- подписи и состояние ----------
  function legends() {
    $('lgStorage').innerHTML = KIND.map((K) => `<span><i style="background:${css(K.c)}"></i>${K.name}</span>`).join('');
    $('lgFlow').innerHTML = `<span><i style="background:${css('--s1')}"></i>выпущено</span><span><i style="background:${css('--s2')}"></i>продано</span>`;
  }

  function kpis() {
    const s = data.stats;
    const last = data.series[data.series.length - 1] || {};
    const avg = s.sold ? s.revenue / s.sold : 0;
    const items = [
      ['Прибыль', fmt(data.finish?.profit ?? last.cash, 1), data.done ? 'смена завершена' : `идёт: t = ${data.t} из ${data.horizon}`],
      ['Выпущено роботов', fmt(s.produced), `принято заготовок: ${fmt(s.accepted)}`],
      ['Продано', fmt(s.sold), `выручка ${fmt(s.revenue)}`],
      ['Средняя цена', fmt(avg, 1), `предложений: ${fmt(s.offers)}`],
      ['Отказы покупателей', fmt(s.refused), s.sold + s.refused ? `${Math.round((100 * s.refused) / (s.sold + s.refused))}% предложений` : ''],
      ['Недопустимые команды', fmt(s.invalid), Object.entries(s.invalidReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || 'нет'],
      ['Время ответа', `${fmt(s.maxLatencyMs, 1)} мс`, `среднее ${fmt(s.avgLatencyMs, 2)} мс, событий ${fmt(s.events)}`],
    ];
    $('kpis').innerHTML = items.map(([l, v, sub]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');
  }

  function snapshot() {
    const p = data.series[Math.min(tick, data.series.length - 1)];
    $('atT').textContent = p ? p.t : '';
    $('tickLbl').textContent = `t = ${p ? p.t : 0}`;
    if (!p) return;
    const cells = [];
    const busyNow = Object.values(p.busyUntil || {}).filter((v) => v != null && v > p.t).length;
    for (const it of p.items) {
      const K = KIND.find((x) => x.k === it.k);
      const col = css(K?.c || '--s1');
      let label = K ? K.name.split(' ')[0] : it.k;
      let dot = '';
      if (it.k === 'robot' || (it.k === 'body' && it.c)) dot = `<span class="dot" style="background:${ROBOT_DOT[it.c] || '#999'}"></span>`;
      if (it.k === 'body' && !it.c) label = 'корпус';
      if (it.k === 'body' && it.c) label = 'окрашен';
      if (it.k === 'robot') label = 'робот';
      if (it.k === 'sheet') label = 'лист';
      if (it.k === 'control') label = 'упр.';
      cells.push(`<div class="cell full" style="border-color:${col};box-shadow:inset 0 -4px 0 ${col}" title="${it.k}${it.c ? ', ' + it.c : ''}${it.h ? ', ручки' : ''}">${dot}<span>${label}${it.h ? ' ⊓' : ''}</span></div>`);
    }
    for (let i = 0; i < busyNow; i++) cells.push('<div class="cell reserved">резерв</div>');
    while (cells.length < (data.capacity || 12)) cells.push('<div class="cell"></div>');
    $('cells').innerHTML = cells.join('');
    $('mstate').innerHTML = data.machines
      .map((m) => {
        const bu = p.busyUntil?.[m];
        const on = bu != null && bu > p.t;
        return `<div class="row"><span class="mono">${m}</span><span class="badge ${on ? 'on' : ''}">${on ? `работает до ${bu}` : 'свободен'}</span></div>`;
      })
      .join('');
    $('bstate').innerHTML = (p.buyers || [])
      .map((b) => `<div class="row"><span class="mono">${b.id}</span><span class="badge ${b.cd == null ? 'on' : ''}">${b.cd == null ? 'принимает' : `пауза до ${b.cd}`}</span></div>`)
      .join('');
  }

  function beliefs() {
    const bl = data.beliefs || [];
    if (!bl.length) {
      $('beliefs').innerHTML = '<p class="note">Нет данных: стратегия этого прогона не ведёт вероятностную модель.</p>';
      return;
    }
    const buyers = [...new Set(bl.map((b) => b.buyerId))];
    const types = [];
    for (const b of bl) if (!types.some((t) => t.color === b.color && t.handles === b.handles)) types.push({ color: b.color, handles: b.handles });
    const truth = data.finish?.buyers || null;
    let html = '<table><thead><tr><th>Тип робота</th>' + buyers.map((b) => `<th>${b}</th>`).join('') + '</tr></thead><tbody>';
    for (const ty of types) {
      html += `<tr><td>${typeName(ty)}</td>`;
      for (const b of buyers) {
        const row = bl.find((x) => x.buyerId === b && x.color === ty.color && x.handles === ty.handles);
        const best = Math.max(...bl.filter((x) => x.buyerId === b).map((x) => x.mean));
        html += `<td class="${row.mean === best ? 'best' : ''}">${fmt(row.mean, 1)} <span class="rng">${fmt(row.low)}–${fmt(row.high)}</span></td>`;
      }
      html += '</tr>';
    }
    const sum = data.buyerSummary || [];
    html += '<tr><td><b>Образец по модели</b></td>' + buyers.map((b) => {
      const s = sum.find((x) => x.buyerId === b);
      return `<td>${s ? `${typeName(s.sample)} <span class="rng">${Math.round(s.confidence * 100)}%</span>` : '—'}</td>`;
    }).join('') + '</tr>';
    html += '<tr><td><b>Pmax / f по модели</b></td>' + buyers.map((b) => {
      const s = sum.find((x) => x.buyerId === b);
      return `<td>${s ? `${fmt(s.pmax, 1)} / ${fmt(s.f, 2)}` : '—'}</td>`;
    }).join('') + '</tr>';
    if (truth) {
      html += '<tr><td><b>На самом деле</b></td>' + buyers.map((b) => {
        const h = truth.find((x) => x.id === b);
        const s = sum.find((x) => x.buyerId === b);
        const okS = h && s && h.sample.color === s.sample.color && h.sample.handles === s.sample.handles;
        return `<td>${h ? `<span class="${okS ? 'ok' : 'no'}">${typeName(h.sample)}</span> <span class="rng">${fmt(h.pmax, 1)} / ${fmt(h.f, 2)}</span>` : '—'}</td>`;
      }).join('') + '</tr>';
    }
    $('beliefs').innerHTML = html + '</tbody></table>';
  }

  function sales() {
    const rows = (data.sales || []).slice().reverse();
    if (!rows.length) {
      $('sales').innerHTML = '<p class="note">Сделок пока нет.</p>';
      return;
    }
    const why = { below_min_price: 'цена ниже minPrice', cooldown: 'пауза покупателя' };
    $('sales').innerHTML =
      '<table><thead><tr><th>Такт</th><th>Покупатель</th><th>Робот</th><th>Итог</th><th>Цена</th></tr></thead><tbody>' +
      rows
        .map((r) => `<tr><td>${r.t}</td><td>${r.buyerId}</td><td><span class="sw" style="background:${ROBOT_DOT[r.props?.color] || '#999'}"></span>${typeName(r.props)}</td><td class="${r.outcome === 'sold' ? 'ok' : 'no'}">${r.outcome === 'sold' ? 'продан' : 'отказ: ' + (why[r.reason] || r.reason || '')}</td><td>${r.price != null ? fmt(r.price, 2) : ''}</td></tr>`)
        .join('') +
      '</tbody></table>';
  }

  function render() {
    if (!data) return;
    const max = Math.max(0, data.series.length - 1);
    const slider = $('tick');
    slider.max = max;
    if ($('follow').checked && !playing) tick = max;
    tick = Math.min(tick, max);
    slider.value = tick;
    legends();
    kpis();
    drawCash();
    drawStorage();
    drawMachines();
    drawFlow();
    snapshot();
    beliefs();
    sales();
  }

  function setTick(t) {
    tick = t;
    $('tick').value = t;
    drawCash();
    drawStorage();
    drawMachines();
    drawFlow();
    snapshot();
  }

  // ---------- подсказки при наведении ----------
  const tickTip = (t, rows) => `<b>такт ${t}</b><br>` + rows.join('<br>');
  hoverable($('cCash'), () => frames.cash, (t) => {
    const p = data.series[t];
    return p && tickTip(t, [`деньги: <b>${fmt(p.cash, 1)}</b>`, `выручка с начала: ${fmt(p.revenue)}`]);
  });
  hoverable($('cStorage'), () => frames.storage, (t) => {
    const p = data.series[t];
    if (!p) return '';
    const used = KIND.reduce((a, K) => a + (p.kinds[K.k] || 0), 0);
    return tickTip(t, KIND.slice().reverse().map((K) => `<span class="sw" style="background:${css(K.c)}"></span>${K.name}: <b>${p.kinds[K.k] || 0}</b>`).concat([`занято ${used} из ${data.capacity}`]));
  });
  hoverable($('cFlow'), () => frames.flow, (t) => {
    const p = data.series[t];
    return p && tickTip(t, [`<span class="sw" style="background:${css('--s1')}"></span>выпущено: <b>${p.produced}</b>`, `<span class="sw" style="background:${css('--s2')}"></span>продано: <b>${p.sold}</b>`]);
  });
  hoverable($('cMachines'), () => frames.machines, (t, y) => {
    const f = frames.machines;
    const i = Math.floor((y - f.pad.t) / f.rowH);
    const m = data.machines[i];
    if (!m) return '';
    const on = data.busy[m]?.[t];
    return tickTip(t, [`${m}: <b>${on ? 'работает' : 'простаивает'}</b>`, `загрузка за смену: ${Math.round((data.util[m] || 0) * 100)}%`]);
  });

  // ---------- загрузка данных ----------
  async function loadRuns() {
    try {
      const list = await (await fetch('/ui/runs')).json();
      const sel = $('runSel');
      const cur = sel.value;
      const label = (r) => `${r.source === 'local' ? 'симуляция' : 'арена/' + r.mode} · ${r.runId} · ${r.done ? 'прибыль ' + fmt(r.profit) : 't=' + r.t}`;
      sel.innerHTML = list.length ? list.map((r) => `<option value="${r.runId}">${label(r)}</option>`).join('') : '<option value="">— нет прогонов —</option>';
      if (cur && list.some((r) => r.runId === cur)) sel.value = cur;
      if (!selected && list.length) select(list[0].runId);
    } catch {}
  }

  async function loadRun() {
    if (!selected) return;
    try {
      const r = await fetch('/ui/runs/' + encodeURIComponent(selected));
      if (!r.ok) return;
      data = await r.json();
      $('hint').hidden = true;
      render();
    } catch {}
  }

  function select(id) {
    selected = id;
    $('runSel').value = id;
    $('follow').checked = true;
    loadRun();
  }

  $('runSel').addEventListener('change', (e) => select(e.target.value));
  $('simBtn').addEventListener('click', async () => {
    const body = { seed: Number($('seed').value) || 1, strategy: $('strat').value, delayMs: Number($('speed').value) };
    const r = await (await fetch('/ui/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    await loadRuns();
    select(r.runId);
  });
  $('tick').addEventListener('input', (e) => {
    $('follow').checked = false;
    setTick(Number(e.target.value));
  });
  $('playBtn').addEventListener('click', () => {
    if (playing) {
      clearInterval(playing);
      playing = null;
      $('playBtn').textContent = '▶';
      return;
    }
    if (!data) return;
    $('follow').checked = false;
    if (tick >= data.series.length - 1) tick = 0;
    $('playBtn').textContent = '❚❚';
    playing = setInterval(() => {
      if (tick >= data.series.length - 1) {
        clearInterval(playing);
        playing = null;
        $('playBtn').textContent = '▶';
        return;
      }
      setTick(tick + 2);
    }, 30);
  });
  window.addEventListener('resize', render);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

  loadRuns();
  setInterval(loadRuns, 2000);
  setInterval(() => {
    if (data && data.done && data.runId === selected) return;
    loadRun();
  }, 600);
})();
