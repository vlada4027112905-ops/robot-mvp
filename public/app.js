// Панель управления сменой завода роботов: опрос API (/ui/runs) и визуализация
(() => {
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  const KIND = [
    { k: 'sheet', name: 'листы', c: '--s1' },
    { k: 'control', name: 'управление', c: '--s2' },
    { k: 'body', name: 'корпуса', c: '--s3' },
    { k: 'robot', name: 'роботы', c: '--s4' },
  ];
  const COLOR_RU = { red: 'красный', green: 'зелёный', blue: 'синий' };
  const ROBOT_DOT = { red: '#e11d48', green: '#059669', blue: '#2563eb' };
  const WHY_RU = { below_min_price: 'ниже minPrice', cooldown: 'пауза' };
  const VIEW_TITLES = {
    overview: 'Обзор и графики',
    floor: 'Состояние цеха',
    model: 'Модель покупателей',
    sales: 'Журнал сделок',
  };

  const fmt = (x, d = 0) =>
    x == null || Number.isNaN(x)
      ? '—'
      : Number(x).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

  const typeKey = (p) => (p ? `${p.color}|${p.handles ? 1 : 0}` : '');
  const typeName = (p) => (p ? `${COLOR_RU[p.color] || p.color}${p.handles ? ', с ручками' : ', без ручек'}` : '—');

  let data = null;
  let selected = '';
  let tick = 0;
  let playing = null;
  let activeView = 'overview';
  let lastSyncAt = 0;

  // Фильтры и отображение журнала сделок
  let salesExpanded = false;
  let filterBuyer = '';
  let filterRobot = '';
  let filterOutcome = '';
  let lastBuyerOpts = '';
  let lastRobotOpts = '';

  const tip = $('tip');
  const frames = {};

  // ---------- Переключение темы (по умолчанию светлая) ----------
  const themeBtn = $('themeBtn');
  const syncThemeBtn = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    if (themeBtn) themeBtn.textContent = cur === 'light' ? 'Тёмная тема' : 'Светлая тема';
  };
  try {
    const saved = localStorage.getItem('factory-ui-theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch {}
  syncThemeBtn();

  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      const next = cur === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('factory-ui-theme', next); } catch {}
      syncThemeBtn();
      render();
    });
  }

  // ---------- Навигация между разделами ----------
  function setView(viewName) {
    if (!VIEW_TITLES[viewName]) return;
    activeView = viewName;
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    document.querySelectorAll('.view').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    $('viewTitle').textContent = VIEW_TITLES[viewName];

    // Показываем полосу таймлайна там, где она управляет данными
    const showTimeline = viewName === 'overview' || viewName === 'floor';
    $('timelineBar').hidden = !showTimeline;

    if (data && viewName === 'overview') {
      requestAnimationFrame(() => {
        drawCash();
        drawStorage();
        drawMachines();
        drawFlow();
      });
    }
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // ---------- Индикатор автообновления ----------
  setInterval(() => {
    const el = $('syncLbl');
    if (!el) return;
    if (!lastSyncAt) {
      el.textContent = 'ожидание API…';
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - lastSyncAt) / 1000));
    el.textContent = sec === 0 ? 'обновлено сейчас' : `обновлено ${sec} с назад`;
  }, 1000);

  // ---------- Вспомогательные функции для графиков ----------
  function setup(canvas) {
    if (!canvas) return null;
    const w = canvas.clientWidth;
    if (!w) return null;
    const dpr = window.devicePixelRatio || 1;
    const h = Number(canvas.getAttribute('height')) || 224;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
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

  function frame(canvas, xMax, yLo, yHi, { left = 54, yFmt = (v) => fmt(v) } = {}) {
    const s = setup(canvas);
    if (!s) return null;
    const { ctx, w, h } = s;
    const pad = { l: left, r: 16, t: 18, b: 24 };
    const yt = niceTicks(yLo, yHi);
    const sx = (t) => pad.l + (t / Math.max(1, xMax)) * (w - pad.l - pad.r);
    const sy = (v) => pad.t + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (h - pad.t - pad.b);

    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = css('--text-3');
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
      ctx.fillText(yFmt(v), pad.l - 8, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xs = niceTicks(0, xMax, 6).ticks.filter((v) => v <= xMax);
    for (const v of xs) ctx.fillText(fmt(v), sx(v), h - pad.b + 7);

    // Опорная горизонтальная линия нуля
    if (yt.lo <= 0 && yt.hi >= 0) {
      ctx.strokeStyle = css('--border-strong');
      ctx.setLineDash([4, 4]);
      const y0 = Math.round(sy(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y0);
      ctx.lineTo(w - pad.r, y0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    return { ctx, w, h, pad, sx, sy };
  }

  function cursor(f, t) {
    const { ctx, pad, sx, h } = f;
    const x = Math.round(sx(t)) + 0.5;
    ctx.strokeStyle = css('--ink');
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function hoverable(canvas, getFrame, html) {
    canvas.addEventListener('mousemove', (e) => {
      const f = getFrame();
      if (!f || !data) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const xMax = data.series.length - 1;
      const t = Math.max(
        0,
        Math.min(xMax, Math.round(((x - f.pad.l) / (f.w - f.pad.l - f.pad.r)) * Math.max(1, data.horizon)))
      );
      const content = html(t, e.clientY - r.top);
      if (!content) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = content;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - tw - 12, e.clientX + 14) + 'px';
      tip.style.top = Math.min(window.innerHeight - th - 12, e.clientY + 14) + 'px';
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
    canvas.addEventListener('click', (e) => {
      const f = getFrame();
      if (!f || !data) return;
      const r = canvas.getBoundingClientRect();
      const t = Math.round(((e.clientX - r.left - f.pad.l) / (f.w - f.pad.l - f.pad.r)) * data.horizon);
      setTick(Math.max(0, Math.min(data.series.length - 1, t)));
      $('follow').checked = false;
    });
  }

  // ---------- Отрисовка графиков ----------
  function drawCash() {
    const s = data.series;
    const vals = s.map((x) => x.cash);
    const lo = Math.min(0, ...vals);
    const hi = Math.max(10, ...vals);
    const f = frame($('cCash'), data.horizon, lo, hi);
    if (!f) return;
    frames.cash = f;
    const { ctx, sx, sy, pad, h } = f;
    const col = css('--emerald');

    if (s.length > 1) {
      const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      grad.addColorStop(0, col + '2b');
      grad.addColorStop(1, col + '00');
      ctx.fillStyle = grad;
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.cash)) : ctx.moveTo(sx(p.t), sy(p.cash))));
      ctx.lineTo(sx(s[s.length - 1].t), h - pad.b);
      ctx.lineTo(sx(s[0].t), h - pad.b);
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = col;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.cash)) : ctx.moveTo(sx(p.t), sy(p.cash))));
    ctx.stroke();

    const last = s[s.length - 1];
    if (last) {
      const lx = sx(last.t);
      const ly = sy(last.cash);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(lx, ly, 4, 0, Math.PI * 2);
      ctx.fill();
      $('cashTag').textContent = `итог: ${fmt(last.cash, 1)}`;
    }
    cursor(f, tick);
  }

  function drawStorage() {
    const s = data.series;
    const f = frame($('cStorage'), data.horizon, 0, data.capacity || 12, { left: 36 });
    if (!f) return;
    frames.storage = f;
    const { ctx, sx, sy } = f;
    const acc = s.map(() => 0);

    for (const K of KIND) {
      const top = s.map((p, i) => acc[i] + (p.kinds[K.k] || 0));
      ctx.fillStyle = css(K.c);
      ctx.globalAlpha = 0.82;
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
      ctx.globalAlpha = 1;
      top.forEach((v, i) => (acc[i] = v));
    }

    ctx.strokeStyle = css('--text-3');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    const cy = Math.round(sy(data.capacity)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(f.pad.l, cy);
    ctx.lineTo(f.w - f.pad.r, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--text-3');
    ctx.font = '10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`лимит ${data.capacity}`, f.pad.l + 4, cy - 3);
    cursor(f, tick);
  }

  function drawFlow() {
    const s = data.series;
    const hi = Math.max(5, ...s.map((p) => p.produced));
    const f = frame($('cFlow'), data.horizon, 0, hi, { left: 40 });
    if (!f) return;
    frames.flow = f;
    const { ctx, sx, sy } = f;
    const lines = [
      ['produced', '--blue'],
      ['sold', '--emerald'],
    ];
    for (const [k, c] of lines) {
      ctx.strokeStyle = css(c);
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p[k])) : ctx.moveTo(sx(p.t), sy(p[k]))));
      ctx.stroke();
    }
    cursor(f, tick);
  }

  function drawMachines() {
    const s = setup($('cMachines'));
    if (!s) return;
    const { ctx, w, h } = s;
    const pad = { l: 92, r: 50, t: 8, b: 24 };
    const ms = data.machines;
    const rowH = (h - pad.t - pad.b) / Math.max(1, ms.length);
    const sx = (t) => pad.l + (t / Math.max(1, data.horizon)) * (w - pad.l - pad.r);
    frames.machines = { pad, sx, w, h, ctx, rowH };

    ms.forEach((m, i) => {
      const y = pad.t + i * rowH;
      const barY = y + rowH * 0.25;
      const barH = Math.max(7, rowH * 0.5);

      ctx.fillStyle = css('--grid');
      ctx.fillRect(pad.l, barY, w - pad.l - pad.r, barH);

      ctx.fillStyle = css('--blue');
      const arr = data.busy[m] || [];
      let k = 0;
      while (k < arr.length) {
        if (!arr[k]) { k++; continue; }
        let j = k;
        while (j < arr.length && arr[j]) j++;
        const bw = Math.max(1.5, sx(j) - sx(k) - 0.5);
        ctx.fillRect(sx(k), barY, bw, barH);
        k = j;
      }

      ctx.fillStyle = css('--text-2');
      ctx.font = '500 11.5px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(m, pad.l - 10, y + rowH / 2);

      ctx.fillStyle = css('--text');
      ctx.textAlign = 'left';
      ctx.font = '600 11.5px "JetBrains Mono", monospace';
      ctx.fillText(`${Math.round((data.util[m] || 0) * 100)}%`, w - pad.r + 8, y + rowH / 2);
    });

    ctx.fillStyle = css('--text-3');
    ctx.font = '10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of niceTicks(0, data.horizon, 6).ticks.filter((v) => v <= data.horizon)) {
      ctx.fillText(fmt(v), sx(v), h - pad.b + 7);
    }
    cursor({ ctx, pad, sx, h }, tick);
  }

  // ---------- Блоки данных ----------
  function legends() {
    const stHtml = KIND.map((K) => `<span><i style="background:${css(K.c)}"></i>${K.name}</span>`).join('');
    $('lgStorage').innerHTML = stHtml;
    $('lgFloor').innerHTML = stHtml;
    $('lgFlow').innerHTML =
      `<span><i style="background:${css('--blue')}"></i>выпущено</span>` +
      `<span><i style="background:${css('--emerald')}"></i>продано</span>`;
  }

  function kpis() {
    const s = data.stats;
    const last = data.series[data.series.length - 1] || {};
    const avg = s.sold ? s.revenue / s.sold : 0;
    const profit = data.finish?.profit ?? last.cash;
    const refPct = s.sold + s.refused ? Math.round((100 * s.refused) / (s.sold + s.refused)) : 0;

    // 4 главных KPI
    const hero = [
      ['kpi-profit', 'Прибыль', fmt(profit, 1), data.done ? 'смена завершена' : `такт ${data.t} из ${data.horizon}`],
      ['kpi-produced', 'Выпущено роботов', fmt(s.produced), `принято заготовок: ${fmt(s.accepted)}`],
      ['kpi-sold', 'Продано', fmt(s.sold), `выручка: ${fmt(s.revenue)}`],
      ['kpi-price', 'Средняя цена', fmt(avg, 1), `предложений: ${fmt(s.offers)}`],
    ];
    $('kpis').innerHTML = hero
      .map(
        ([cls, l, v, sub]) => `
        <div class="kpi ${cls}">
          <div class="kpi-label">${l}</div>
          <div class="kpi-val">${v}</div>
          <div class="kpi-sub">${sub}</div>
        </div>`
      )
      .join('');

    // Вторичные метрики — компактная полоса чипов
    const chips = [
      ['Отказы', `${fmt(s.refused)} (${refPct}%)`, s.refused > 0 && refPct >= 25],
      ['Ошибки API', fmt(s.invalid), s.invalid > 0],
      ['Отклик (макс / ср)', `${fmt(s.maxLatencyMs, 1)} / ${fmt(s.avgLatencyMs, 2)} мс`, false],
    ];
    $('subChips').innerHTML = chips
      .map(
        ([k, v, bad]) =>
          `<div class="chip${bad ? ' chip-bad' : ''}"><span class="chip-k">${k}</span><span class="chip-v mono">${v}</span></div>`
      )
      .join('');

    // Индикаторы в сайдбаре и шапке
    $('bcRun').textContent = data.runId || 'нет прогона';
    $('liveDot').classList.toggle('on', !data.done);
    $('statusText').textContent = data.done ? 'Смена завершена' : 'Идёт симуляция';
    $('statusMeta').textContent = `${data.runId} · t = ${data.t} / ${data.horizon}`;
    const pct = Math.min(100, Math.round((data.t / Math.max(1, data.horizon)) * 100));
    $('statusBar').style.width = `${pct}%`;
    $('navSalesBadge').textContent = String((data.sales || []).length);
  }

  function snapshot() {
    const p = data.series[Math.min(tick, data.series.length - 1)];
    const tVal = p ? p.t : 0;
    $('atT').textContent = tVal;
    $('tickLbl').textContent = `t = ${tVal}`;
    $('navTickBadge').textContent = `t=${tVal}`;
    if (!p) return;

    const cap = data.capacity || 12;
    const cells = [];
    const busyNow = Object.values(p.busyUntil || {}).filter((v) => v != null && v > p.t).length;
    for (const it of p.items) {
      const K = KIND.find((x) => x.k === it.k);
      const col = css(K?.c || '--blue');
      let label = K ? K.name.split(' ')[0] : it.k;
      let dot = '';
      if (it.k === 'robot' || (it.k === 'body' && it.c)) {
        dot = `<span class="dot" style="background:${ROBOT_DOT[it.c] || '#999'}"></span>`;
      }
      if (it.k === 'body' && !it.c) label = 'корпус';
      if (it.k === 'body' && it.c) label = 'окрашен';
      if (it.k === 'robot') label = 'робот';
      if (it.k === 'sheet') label = 'лист';
      if (it.k === 'control') label = 'упр.';
      cells.push(
        `<div class="cell full" style="--c:${col}" title="${it.k}${it.c ? ', ' + it.c : ''}${it.h ? ', ручки' : ''}">${dot}<span>${label}${it.h ? ' ⊓' : ''}</span></div>`
      );
    }
    for (let i = 0; i < busyNow; i++) cells.push('<div class="cell reserved">резерв</div>');
    while (cells.length < cap) cells.push('<div class="cell">—</div>');
    $('cells').innerHTML = cells.join('');

    $('floorSummary').textContent = `Склад: ${p.items.length} занято · ${busyNow} резерв · лимит ${cap}`;

    let busyMachines = 0;
    $('mstate').innerHTML = data.machines
      .map((m) => {
        const bu = p.busyUntil?.[m];
        const on = bu != null && bu > p.t;
        if (on) busyMachines++;
        return `<div class="state-row"><span class="mono">${m}</span><span class="badge ${on ? 'badge-busy' : 'badge-ok'}">${on ? `занят до t=${bu}` : 'свободен'}</span></div>`;
      })
      .join('');
    $('machinesSummary').textContent = `${busyMachines} из ${data.machines.length} в работе`;

    const bs = p.buyers || [];
    let readyBuyers = 0;
    $('bstate').innerHTML = bs
      .map((b) => {
        const ready = b.cd == null;
        if (ready) readyBuyers++;
        return `<div class="state-row"><span class="mono">${b.id}</span><span class="badge ${ready ? 'badge-ok' : 'badge-warn'}">${ready ? 'принимает' : `пауза до t=${b.cd}`}</span></div>`;
      })
      .join('');
    $('buyersSummary').textContent = `${readyBuyers} из ${bs.length} готовы`;
  }

  function beliefs() {
    const bl = data.beliefs || [];
    if (!bl.length) {
      $('beliefs').innerHTML = '<p class="empty-note">Нет данных: выбранная стратегия не строит вероятностную модель покупателей.</p>';
      return;
    }

    const buyers = [...new Set(bl.map((b) => b.buyerId))];
    const types = [];
    for (const b of bl) {
      if (!types.some((t) => t.color === b.color && t.handles === b.handles)) {
        types.push({ color: b.color, handles: b.handles });
      }
    }
    const sum = data.buyerSummary || [];
    const truth = data.finish?.buyers || null;

    // Опорный максимум Pmax для шкалы прогресс-баров по каждому покупателю
    const maxByBuyer = {};
    for (const b of buyers) {
      const s = sum.find((x) => x.buyerId === b);
      const maxMean = Math.max(...bl.filter((x) => x.buyerId === b).map((x) => x.mean || 0), 1);
      maxByBuyer[b] = Math.max(s?.pmax || 0, maxMean);
    }

    let html = '<table><thead><tr><th>Тип робота</th>' + buyers.map((b) => `<th>${b}</th>`).join('') + '</tr></thead><tbody>';

    for (const ty of types) {
      html += `<tr><td><span class="sw" style="background:${ROBOT_DOT[ty.color] || '#999'}"></span>${typeName(ty)}</td>`;
      for (const b of buyers) {
        const row = bl.find((x) => x.buyerId === b && x.color === ty.color && x.handles === ty.handles);
        if (!row) {
          html += '<td>—</td>';
          continue;
        }
        const best = Math.max(...bl.filter((x) => x.buyerId === b).map((x) => x.mean));
        const pct = Math.max(4, Math.min(100, Math.round((row.mean / maxByBuyer[b]) * 100)));
        html += `<td class="${row.mean === best ? 'best' : ''}">
          <div class="price-cell">
            <div class="price-top">
              <span class="p-num">${fmt(row.mean, 1)}</span>
              <span class="p-rng">${fmt(row.low)}–${fmt(row.high)}</span>
            </div>
            <div class="price-bar"><i style="width:${pct}%"></i></div>
          </div>
        </td>`;
      }
      html += '</tr>';
    }

    html +=
      '<tr class="row-meta"><td><b>Образец по модели</b></td>' +
      buyers
        .map((b) => {
          const s = sum.find((x) => x.buyerId === b);
          return `<td>${s ? `${typeName(s.sample)} <span class="p-rng">${Math.round(s.confidence * 100)}%</span>` : '—'}</td>`;
        })
        .join('') +
      '</tr>';

    html +=
      '<tr class="row-meta"><td><b>Pmax / f по модели</b></td>' +
      buyers
        .map((b) => {
          const s = sum.find((x) => x.buyerId === b);
          return `<td class="mono">${s ? `${fmt(s.pmax, 1)} / ${fmt(s.f, 2)}` : '—'}</td>`;
        })
        .join('') +
      '</tr>';

    if (truth) {
      html +=
        '<tr class="row-meta"><td><b>Истинные параметры</b></td>' +
        buyers
          .map((b) => {
            const h = truth.find((x) => x.id === b);
            const s = sum.find((x) => x.buyerId === b);
            const okS = h && s && h.sample.color === s.sample.color && h.sample.handles === s.sample.handles;
            return `<td>${
              h
                ? `<span class="${okS ? 'ok' : 'no'}">${typeName(h.sample)}</span> <span class="p-rng">${fmt(h.pmax, 1)} / ${fmt(h.f, 2)}</span>`
                : '—'
            }</td>`;
          })
          .join('') +
        '</tr>';
    }

    $('beliefs').innerHTML = html + '</tbody></table>';
  }

  function getFilteredSales() {
    const all = (data?.sales || []).slice().reverse();
    return all.filter((r) => {
      if (filterBuyer && r.buyerId !== filterBuyer) return false;
      if (filterRobot && typeKey(r.props) !== filterRobot) return false;
      if (filterOutcome === 'sold' && r.outcome !== 'sold') return false;
      if (filterOutcome === 'refused' && r.outcome === 'sold') return false;
      return true;
    });
  }

  function syncSalesFilters() {
    const all = data?.sales || [];
    const buyers = [...new Set(all.map((r) => r.buyerId))].sort();
    const bKey = buyers.join('|');
    if (bKey !== lastBuyerOpts) {
      lastBuyerOpts = bKey;
      const sel = $('fBuyer');
      sel.innerHTML =
        '<option value="">Все покупатели</option>' +
        buyers.map((b) => `<option value="${b}">${b}</option>`).join('');
      if (buyers.includes(filterBuyer)) sel.value = filterBuyer;
      else filterBuyer = '';
    }

    const robotMap = new Map();
    for (const r of all) {
      if (r.props) robotMap.set(typeKey(r.props), typeName(r.props));
    }
    const rEntries = [...robotMap.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    const rKey = rEntries.map((x) => x[0]).join('|');
    if (rKey !== lastRobotOpts) {
      lastRobotOpts = rKey;
      const sel = $('fRobot');
      sel.innerHTML =
        '<option value="">Все типы роботов</option>' +
        rEntries.map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
      if (robotMap.has(filterRobot)) sel.value = filterRobot;
      else filterRobot = '';
    }
  }

  function sales() {
    syncSalesFilters();
    const filtered = getFilteredSales();
    const total = (data?.sales || []).length;
    $('salesCount').textContent = filtered.length === total ? String(total) : `${filtered.length} из ${total}`;

    if (!filtered.length) {
      $('sales').innerHTML = '<p class="empty-note">Сделок по заданным условиям пока нет.</p>';
      $('salesFoot').hidden = true;
      return;
    }

    const limit = 15;
    const shown = salesExpanded ? filtered : filtered.slice(0, limit);

    $('sales').innerHTML =
      '<table><thead><tr><th>Такт</th><th>Покупатель</th><th>Робот</th><th>Итог</th><th>Цена</th></tr></thead><tbody>' +
      shown
        .map(
          (r) =>
            `<tr>` +
            `<td class="mono">${r.t}</td>` +
            `<td class="mono">${r.buyerId}</td>` +
            `<td><span class="sw" style="background:${ROBOT_DOT[r.props?.color] || '#999'}"></span>${typeName(r.props)}</td>` +
            `<td><span class="${r.outcome === 'sold' ? 'pill-ok' : 'pill-no'}">${
              r.outcome === 'sold' ? 'продан' : 'отказ · ' + (WHY_RU[r.reason] || r.reason || '—')
            }</span></td>` +
            `<td class="mono">${r.price != null ? fmt(r.price, 2) : '—'}</td>` +
            `</tr>`
        )
        .join('') +
      '</tbody></table>';

    const foot = $('salesFoot');
    if (filtered.length > limit) {
      foot.hidden = false;
      $('toggleSalesBtn').textContent = salesExpanded
        ? 'Свернуть до последних 15'
        : `Показать все записи (${filtered.length})`;
    } else {
      foot.hidden = true;
    }
  }

  function exportSalesCsv() {
    const rows = getFilteredSales();
    if (!rows.length) return;
    const header = ['t', 'buyerId', 'robot', 'outcome', 'reason', 'price'];
    const lines = [
      header.join(';'),
      ...rows.map((r) => [
        r.t,
        r.buyerId,
        `"${typeName(r.props)}"`,
        r.outcome,
        r.reason || '',
        r.price != null ? String(r.price).replace('.', ',') : '',
      ].join(';')),
    ];
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-${data?.runId || 'run'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- Общий рендер ----------
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
    if (activeView === 'overview') {
      drawCash();
      drawStorage();
      drawMachines();
      drawFlow();
    }
    snapshot();
    beliefs();
    sales();
  }

  function setTick(t) {
    tick = t;
    $('tick').value = t;
    if (activeView === 'overview') {
      drawCash();
      drawStorage();
      drawMachines();
      drawFlow();
    }
    snapshot();
  }

  // ---------- Подсказки при наведении на графики ----------
  const tickTip = (t, rows) => `<b>такт ${t}</b><br>` + rows.join('<br>');
  hoverable($('cCash'), () => frames.cash, (t) => {
    const p = data.series[t];
    return p && tickTip(t, [`деньги: <b>${fmt(p.cash, 1)}</b>`, `выручка с начала: ${fmt(p.revenue)}`]);
  });
  hoverable($('cStorage'), () => frames.storage, (t) => {
    const p = data.series[t];
    if (!p) return '';
    const used = KIND.reduce((a, K) => a + (p.kinds[K.k] || 0), 0);
    return tickTip(
      t,
      KIND.slice()
        .reverse()
        .map((K) => `<span class="sw" style="background:${css(K.c)}"></span>${K.name}: <b>${p.kinds[K.k] || 0}</b>`)
        .concat([`занято ${used} из ${data.capacity}`])
    );
  });
  hoverable($('cFlow'), () => frames.flow, (t) => {
    const p = data.series[t];
    return (
      p &&
      tickTip(t, [
        `<span class="sw" style="background:${css('--blue')}"></span>выпущено: <b>${p.produced}</b>`,
        `<span class="sw" style="background:${css('--emerald')}"></span>продано: <b>${p.sold}</b>`,
      ])
    );
  });
  hoverable($('cMachines'), () => frames.machines, (t, y) => {
    const f = frames.machines;
    const i = Math.floor((y - f.pad.t) / f.rowH);
    const m = data.machines[i];
    if (!m) return '';
    const on = data.busy[m]?.[t];
    return tickTip(t, [`${m}: <b>${on ? 'работает' : 'простаивает'}</b>`, `загрузка за смену: ${Math.round((data.util[m] || 0) * 100)}%`]);
  });

  // ---------- Загрузка данных с сервера ----------
  async function loadRuns() {
    try {
      const list = await (await fetch('/ui/runs')).json();
      lastSyncAt = Date.now();
      const sel = $('runSel');
      const cur = sel.value;
      const label = (r) =>
        `${r.source === 'local' ? 'симуляция' : 'арена/' + r.mode} · ${r.runId} · ${
          r.done ? 'прибыль ' + fmt(r.profit) : 't=' + r.t
        }`;
      sel.innerHTML = list.length
        ? list.map((r) => `<option value="${r.runId}">${label(r)}</option>`).join('')
        : '<option value="">— нет прогонов —</option>';
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
      lastSyncAt = Date.now();
      $('hint').hidden = true;
      render();
    } catch {}
  }

  function select(id) {
    selected = id;
    $('runSel').value = id;
    $('follow').checked = true;
    salesExpanded = false;
    loadRun();
  }

  // ---------- Обработчики событий ----------
  $('runSel').addEventListener('change', (e) => select(e.target.value));

  $('simBtn').addEventListener('click', async () => {
    const body = {
      seed: Number($('seed').value) || 1,
      strategy: $('strat').value,
      delayMs: Number($('speed').value),
    };
    const r = await (
      await fetch('/ui/simulate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
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

  $('fBuyer').addEventListener('change', (e) => {
    filterBuyer = e.target.value;
    salesExpanded = false;
    sales();
  });

  $('fRobot').addEventListener('change', (e) => {
    filterRobot = e.target.value;
    salesExpanded = false;
    sales();
  });

  $('fOutcome').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    filterOutcome = btn.dataset.val || '';
    $('fOutcome').querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === btn));
    salesExpanded = false;
    sales();
  });

  $('toggleSalesBtn').addEventListener('click', () => {
    salesExpanded = !salesExpanded;
    sales();
  });

  $('csvBtn').addEventListener('click', exportSalesCsv);

  window.addEventListener('resize', () => {
    if (data && activeView === 'overview') {
      drawCash();
      drawStorage();
      drawMachines();
      drawFlow();
    }
  });

  loadRuns();
  setInterval(loadRuns, 2000);
  setInterval(() => {
    if (data && data.done && data.runId === selected) return;
    loadRun();
  }, 600);
})();
