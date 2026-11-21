// Панель управления сменой завода роботов: опрос API (/ui/runs) и визуализация
(() => {
  // Короткие хелперы: поиск элемента по id и чтение значения CSS-переменной из :root
  const $ = (id) => document.getElementById(id);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  // Справочники типов деталей на складе, цветов корпусов/роботов и причин отказа покупателей
  const KIND = [
    { k: 'sheet', name: 'листы', c: '--s1' },
    { k: 'control', name: 'управление', c: '--s2' },
    { k: 'body', name: 'корпуса', c: '--s3' },
    { k: 'robot', name: 'роботы', c: '--s4' },
  ];
  const COLOR_RU = { red: 'красный', green: 'зелёный', blue: 'синий' };
  const ROBOT_DOT = { red: '#ff3b00', green: '#009957', blue: '#0047ff' };
  const WHY_RU = { below_min_price: 'ниже minPrice', cooldown: 'пауза' };

  // Форматирование чисел под русскую локаль (пробелы между разрядами, запятая для дробных)
  const fmt = (x, d = 0) =>
    x == null || Number.isNaN(x)
      ? '—'
      : Number(x).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });

  // Уникальный ключ конфигурации робота ("red|1") и человекочитаемое название ("красный, с ручками")
  const typeKey = (p) => (p ? `${p.color}|${p.handles ? 1 : 0}` : '');
  const typeName = (p) => (p ? `${COLOR_RU[p.color] || p.color}${p.handles ? ', с ручками' : ', без ручек'}` : '—');

  // Глобальное состояние интерфейса
  let data = null;          // полный JSON-снимок текущего выбранного прогона
  let selected = '';        // runId активного прогона
  let tick = 0;             // текущий такт, выбранный на таймлайне
  let playing = null;       // ID таймера setInterval при автопроигрывании смены
  let activeView = 'overview'; // активная вкладка ('overview' | 'floor' | 'model' | 'sales')
  let lastSyncAt = 0;       // timestamp последнего успешного ответа от сервера

  // Состояние фильтров журнала сделок
  let salesExpanded = false;
  let filterBuyer = '';
  let filterRobot = '';
  let filterOutcome = '';
  let lastBuyerOpts = '';   // кэш списка опций в <select>, чтобы не перерисовывать их каждый тик
  let lastRobotOpts = '';

  const tip = $('tip');     // DOM-элемент всплывающей подсказки над графиками
  const frames = {};        // сохраняем координаты осей каждого графика для обработки наведения мыши

  // ---------- Переключение темы (светлая по умолчанию) ----------
  const themeBtn = $('themeBtn');
  const syncThemeBtn = () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'light';
    if (themeBtn) themeBtn.textContent = cur === 'light' ? 'DARK' : 'LIGHT';
  };
  // Восстанавливаем сохранённую тему из localStorage при загрузке страницы
  try {
    const saved = localStorage.getItem('factory-studio-theme');
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
      try { localStorage.setItem('factory-studio-theme', next); } catch {}
      syncThemeBtn();
      drawAll(); // перерисовываем Canvas-графики под цвета новой темы
    });
  }

  // ---------- Навигация по вкладкам ----------
  function setView(name) {
    activeView = name;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${name}`);
    });
    // Плеер тактов нужен только на вкладках "Обзор" и "Цех"
    $('timelineBar').hidden = !(name === 'overview' || name === 'floor');

    // При возврате на "Обзор" перерисовываем графики в следующем кадре, когда у canvas снова появится ширина
    if (data && name === 'overview') {
      requestAnimationFrame(() => {
        drawCash();
        drawStorage();
        drawMachines();
        drawFlow();
      });
    }
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // ---------- Индикатор автообновления ----------
  // Раз в секунду обновляет счётчик времени с последней синхронизации в шапке
  setInterval(() => {
    const el = $('syncLbl');
    if (!el) return;
    if (!lastSyncAt) {
      el.textContent = 'ожидание API…';
      return;
    }
    const sec = Math.max(0, Math.floor((Date.now() - lastSyncAt) / 1000));
    el.textContent = sec === 0 ? 'sync: now' : `sync: ${sec}s`;
  }, 1000);

  // ---------- Каркас графиков ----------
  // Подготовка Canvas под Retina/HiDPI экраны (масштабирование по devicePixelRatio, чтобы линии не мылились)
  function setup(canvas) {
    if (!canvas) return null;
    const w = canvas.clientWidth;
    if (!w) return null;
    const dpr = window.devicePixelRatio || 1;
    const h = Number(canvas.getAttribute('height')) || 232;
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

  // Подбор "красивых" круглых шагов для делений на осях координат (шаги вида 1, 2, 2.5, 5, 10 * 10^n)
  function niceTicks(lo, hi, n = 4) {
    if (hi === lo) hi = lo + 1;
    const raw = (hi - lo) / n;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
    return { ticks: out, lo: Math.min(lo, out[0]), hi: Math.max(hi, out[out.length - 1]) };
  }

  // Отрисовка координатной сетки, подписей осей X/Y и возврат функций перевода данных в пиксели (sx, sy)
  function frame(canvas, xMax, yLo, yHi, { left = 54, yFmt = (v) => fmt(v) } = {}) {
    const s = setup(canvas);
    if (!s) return null;
    const { ctx, w, h } = s;
    const pad = { l: left, r: 16, t: 22, b: 24 };
    const yt = niceTicks(yLo, yHi);
    const sx = (t) => pad.l + (t / Math.max(1, xMax)) * (w - pad.l - pad.r);
    const sy = (v) => pad.t + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (h - pad.t - pad.b);

    ctx.font = '10.5px "JetBrains Mono", monospace';
    ctx.fillStyle = css('--text-3');
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // Горизонтальные линии сетки и значения по оси Y
    for (const v of yt.ticks) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(yFmt(v), pad.l - 8, y);
    }

    // Подписи тактов по оси X
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xs = niceTicks(0, xMax, 6).ticks.filter((v) => v <= xMax);
    for (const v of xs) ctx.fillText(fmt(v), sx(v), h - pad.b + 7);

    // Опорная горизонтальная линия нуля (если график уходит в минус)
    if (yt.lo <= 0 && yt.hi >= 0) {
      ctx.strokeStyle = css('--ink');
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([4, 3]);
      const y0 = Math.round(sy(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(pad.l, y0);
      ctx.lineTo(w - pad.r, y0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    return { ctx, w, h, pad, sx, sy };
  }

  // Вертикальный маркер текущего выбранного такта на графике
  function cursor(f, t) {
    const { ctx, pad, sx, h } = f;
    const x = Math.round(sx(t)) + 0.5;
    const col = css('--signal');
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, pad.t - 4);
    ctx.lineTo(x, h - pad.b);
    ctx.stroke();

    // Верхний квадратный маркер курсора
    ctx.fillStyle = col;
    ctx.fillRect(x - 3, pad.t - 8, 6, 6);
  }

  // Навешивание интерактивности на график: тултип при наведении и переход на такт по клику
  function hoverable(canvas, getFrame, html) {
    canvas.addEventListener('mousemove', (e) => {
      const f = getFrame();
      if (!f || !data) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const xMax = data.series.length - 1;
      // Пересчитываем X-координату мыши в ближайший такт
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
      $('follow').checked = false; // отключаем автоследование за концом, раз юзер сам выбрал такт
    });
  }

  // ---------- Графики ----------
  // 1. График баланса (денег) по тактам с градиентной заливкой под линией
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
      grad.addColorStop(0, col + '2e');
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
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p.cash)) : ctx.moveTo(sx(p.t), sy(p.cash))));
    ctx.stroke();

    const last = s[s.length - 1];
    if (last) {
      const lx = sx(last.t);
      const ly = sy(last.cash);
      ctx.fillStyle = col;
      ctx.fillRect(lx - 3.5, ly - 3.5, 7, 7);
      $('cashTag').textContent = `FINAL ${fmt(last.cash, 1)}`;
    }
    cursor(f, tick);
  }

  // 2. График с накоплением (stacked area) заполненности склада по 4 видам деталей + пунктир лимита вместимости
  function drawStorage() {
    const s = data.series;
    const f = frame($('cStorage'), data.horizon, 0, data.capacity || 12, { left: 36 });
    if (!f) return;
    frames.storage = f;
    const { ctx, sx, sy } = f;
    const acc = s.map(() => 0); // накопленная высота предыдущих слоёв на каждом такте

    for (const K of KIND) {
      const top = s.map((p, i) => acc[i] + (p.kinds[K.k] || 0));
      ctx.fillStyle = css(K.c);
      ctx.globalAlpha = 0.86;
      ctx.beginPath();
      // Верхняя ступенчатая граница слоя
      s.forEach((p, i) => {
        const x0 = sx(p.t);
        const x1 = sx(p.t + 1);
        if (i === 0) ctx.moveTo(x0, sy(top[i]));
        else ctx.lineTo(x0, sy(top[i]));
        ctx.lineTo(x1, sy(top[i]));
      });
      // Нижняя граница слоя в обратном порядке для замыкания полигона
      for (let i = s.length - 1; i >= 0; i--) {
        ctx.lineTo(sx(s[i].t + 1), sy(acc[i]));
        ctx.lineTo(sx(s[i].t), sy(acc[i]));
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      top.forEach((v, i) => (acc[i] = v));
    }

    // Линия максимальной вместимости склада (capacity)
    ctx.strokeStyle = css('--ink');
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    const cy = Math.round(sy(data.capacity)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(f.pad.l, cy);
    ctx.lineTo(f.w - f.pad.r, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--text-2');
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`CAP ${data.capacity}`, f.pad.l + 4, cy - 3);
    cursor(f, tick);
  }

  // 3. График кумулятивного выпуска роботов (produced) и продаж (sold)
  function drawFlow() {
    const s = data.series;
    const hi = Math.max(5, ...s.map((p) => p.produced));
    const f = frame($('cFlow'), data.horizon, 0, hi, { left: 40 });
    if (!f) return;
    frames.flow = f;
    const { ctx, sx, sy } = f;
    const lines = [
      ['produced', '--cobalt'],
      ['sold', '--emerald'],
    ];
    for (const [k, c] of lines) {
      ctx.strokeStyle = css(c);
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(sx(p.t), sy(p[k])) : ctx.moveTo(sx(p.t), sy(p[k]))));
      ctx.stroke();
    }
    cursor(f, tick);
  }

  // 4. Диаграмма Ганта загрузки каждого станка по тактам + процент утилизации справа
  function drawMachines() {
    const s = setup($('cMachines'));
    if (!s) return;
    const { ctx, w, h } = s;
    const pad = { l: 90, r: 48, t: 14, b: 24 };
    const ms = data.machines;
    const rowH = (h - pad.t - pad.b) / Math.max(1, ms.length);
    const sx = (t) => pad.l + (t / Math.max(1, data.horizon)) * (w - pad.l - pad.r);
    frames.machines = { pad, sx, w, h, ctx, rowH };

    ms.forEach((m, i) => {
      const y = pad.t + i * rowH;
      const barY = y + rowH * 0.24;
      const barH = Math.max(7, rowH * 0.52);

      // Фоновая полоса простоя станка
      ctx.fillStyle = css('--grid');
      ctx.fillRect(pad.l, barY, w - pad.l - pad.r, barH);

      // Отрисовка непрерывных отрезков работы станка (склеиваем соседние такты в один прямоугольник)
      ctx.fillStyle = css('--cobalt');
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

      // Название станка слева
      ctx.fillStyle = css('--text-2');
      ctx.font = '600 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(m, pad.l - 10, y + rowH / 2);

      // Процент загрузки за смену справа
      ctx.fillStyle = css('--ink');
      ctx.textAlign = 'left';
      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.fillText(`${Math.round((data.util[m] || 0) * 100)}%`, w - pad.r + 8, y + rowH / 2);
    });

    // Подписи тактов снизу
    ctx.fillStyle = css('--text-3');
    ctx.font = '10.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of niceTicks(0, data.horizon, 6).ticks.filter((v) => v <= data.horizon)) {
      ctx.fillText(fmt(v), sx(v), h - pad.b + 7);
    }
    cursor({ ctx, pad, sx, h }, tick);
  }

  // ---------- Отрисовка интерфейса ----------
  // Заполнение цветовых легенд для склада и графика выпуска/продаж
  function legends() {
    const stHtml = KIND.map((K) => `<span><i style="background:${css(K.c)}"></i>${K.name}</span>`).join('');
    $('lgStorage').innerHTML = stHtml;
    $('lgFloor').innerHTML = stHtml;
    $('lgFlow').innerHTML =
      `<span><i style="background:${css('--cobalt')}"></i>выпущено</span>` +
      `<span><i style="background:${css('--emerald')}"></i>продано</span>`;
  }

  // Рендер 4 главных KPI-карточек, чипов вторичных метрик и статусов в сайдбаре/шапке
  function kpis() {
    const s = data.stats;
    const last = data.series[data.series.length - 1] || {};
    const avg = s.sold ? s.revenue / s.sold : 0;
    const profit = data.finish?.profit ?? last.cash;
    const refPct = s.sold + s.refused ? Math.round((100 * s.refused) / (s.sold + s.refused)) : 0;
    const pctDone = Math.min(100, Math.round((data.t / Math.max(1, data.horizon)) * 100));

    $('kpis').innerHTML = `
      <div class="kpi-card hero">
        <div class="kpi-head">
          <span class="kpi-title">Прибыль смены</span>
          <span class="kpi-code mono">KPI.01</span>
        </div>
        <div class="kpi-num">${fmt(profit, 1)}</div>
        <div class="kpi-foot mono">
          <span>${data.done ? 'СМЕНА ЗАВЕРШЕНА' : `ТАКТ ${data.t} / ${data.horizon}`}</span>
          <span>${pctDone}%</span>
        </div>
        <div class="kpi-prog"><i style="width:${pctDone}%"></i></div>
      </div>

      <div class="kpi-card accent-blue">
        <div class="kpi-head">
          <span class="kpi-title">Выпущено</span>
          <span class="kpi-code mono">KPI.02</span>
        </div>
        <div class="kpi-num">${fmt(s.produced)}</div>
        <div class="kpi-foot mono"><span>заготовок: ${fmt(s.accepted)}</span></div>
      </div>

      <div class="kpi-card accent-orange">
        <div class="kpi-head">
          <span class="kpi-title">Продано</span>
          <span class="kpi-code mono">KPI.03</span>
        </div>
        <div class="kpi-num">${fmt(s.sold)}</div>
        <div class="kpi-foot mono"><span>выручка: ${fmt(s.revenue)}</span></div>
      </div>

      <div class="kpi-card accent-ink">
        <div class="kpi-head">
          <span class="kpi-title">Средняя цена</span>
          <span class="kpi-code mono">KPI.04</span>
        </div>
        <div class="kpi-num">${fmt(avg, 1)}</div>
        <div class="kpi-foot mono"><span>офферов: ${fmt(s.offers)}</span></div>
      </div>
    `;

    // Вторичные метрики (отказы >= 25% или любые ошибки API подсвечиваются красным)
    const chips = [
      ['ОТКАЗЫ', `${fmt(s.refused)} (${refPct}%)`, s.refused > 0 && refPct >= 25],
      ['ОШИБКИ API', fmt(s.invalid), s.invalid > 0],
      ['ОТКЛИК', `${fmt(s.maxLatencyMs, 1)} / ${fmt(s.avgLatencyMs, 2)} мс`, false],
    ];
    $('subChips').innerHTML = chips
      .map(
        ([k, v, bad]) =>
          `<div class="ticker-chip mono${bad ? ' bad' : ''}"><span class="tk">${k}</span><span class="tv">${v}</span></div>`
      )
      .join('');

    $('bcRun').textContent = data.runId || 'IDLE';
    $('liveDot').classList.toggle('on', !data.done);
    $('statusText').textContent = data.done ? 'ЗАВЕРШЁН' : 'LIVE';
    $('navSalesBadge').textContent = String((data.sales || []).length);
  }

  // Отрисовка вкладки "Состояние цеха" на конкретном такте tick: слоты склада, станки и покупатели
  function snapshot() {
    const p = data.series[Math.min(tick, data.series.length - 1)];
    const tVal = p ? p.t : 0;
    const hor = data.horizon || 0;
    $('atT').textContent = tVal;
    $('tickLbl').textContent = `T: ${String(tVal).padStart(3, '0')} / ${String(hor).padStart(3, '0')}`;
    $('navTickBadge').textContent = `t=${tVal}`;
    if (!p) return;

    const cap = data.capacity || 12;
    const cells = [];
    // Сколько ячеек склада зарезервировано под детали, которые прямо сейчас делаются на станках
    const busyNow = Object.values(p.busyUntil || {}).filter((v) => v != null && v > p.t).length;
    let slotIdx = 1;

    // 1. Занятые ячейки склада (с цветной точкой для покрашенных деталей и значком ручек ⊓)
    for (const it of p.items) {
      const K = KIND.find((x) => x.k === it.k);
      const col = css(K?.c || '--cobalt');
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
      const num = String(slotIdx++).padStart(2, '0');
      cells.push(
        `<div class="cell full" style="--c:${col}" title="${it.k}${it.c ? ', ' + it.c : ''}${it.h ? ', ручки' : ''}"><span class="cell-idx">${num}</span>${dot}<span>${label}${it.h ? ' ⊓' : ''}</span></div>`
      );
    }
    // 2. Зарезервированные ячейки под текущие операции станков
    for (let i = 0; i < busyNow; i++) {
      const num = String(slotIdx++).padStart(2, '0');
      cells.push(`<div class="cell reserved"><span class="cell-idx">${num}</span><span>РЕЗЕРВ</span></div>`);
    }
    // 3. Оставшиеся пустые ячейки до лимита склада
    while (cells.length < cap) {
      const num = String(slotIdx++).padStart(2, '0');
      cells.push(`<div class="cell"><span class="cell-idx">${num}</span><span>—</span></div>`);
    }
    $('cells').innerHTML = cells.join('');
    $('floorSummary').textContent = `СКЛАД: ${p.items.length} ЗАНЯТО · ${busyNow} РЕЗЕРВ · ЛИМИТ ${cap}`;

    // Статус каждого станка на выбранном такте
    let busyMachines = 0;
    $('mstate').innerHTML = data.machines
      .map((m) => {
        const bu = p.busyUntil?.[m];
        const on = bu != null && bu > p.t;
        if (on) busyMachines++;
        return `<div class="hw-row"><span class="hw-name mono"><i class="hw-led ${on ? 'busy' : ''}"></i>${m}</span><span class="hw-badge ${on ? 'busy' : 'ok'}">${on ? `ЗАНЯТ → t=${bu}` : 'СВОБОДЕН'}</span></div>`;
      })
      .join('');
    $('machinesSummary').textContent = `${busyMachines} / ${data.machines.length} ACTIVE`;

    // Статус каждого покупателя (принимает заказ или на кулдауне после покупки)
    const bs = p.buyers || [];
    let readyBuyers = 0;
    $('bstate').innerHTML = bs
      .map((b) => {
        const ready = b.cd == null;
        if (ready) readyBuyers++;
        return `<div class="hw-row"><span class="hw-name mono"><i class="hw-led ${ready ? '' : 'warn'}"></i>${b.id}</span><span class="hw-badge ${ready ? 'ok' : 'warn'}">${ready ? 'ПРИНИМАЕТ' : `ПАУЗА → t=${b.cd}`}</span></div>`;
      })
      .join('');
    $('buyersSummary').textContent = `${readyBuyers} / ${bs.length} READY`;
  }

  // Отрисовка вкладки "Модель покупателей": таблица байесовских оценок цен по всем типам роботов
  function beliefs() {
    const bl = data.beliefs || [];
    if (!bl.length) {
      $('beliefs').innerHTML = '<p class="empty-note">Нет данных: выбранная стратегия не ведёт байесовскую модель покупателей.</p>';
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
    const truth = data.finish?.buyers || null; // истинные скрытые параметры (приходят только после завершения смены)

    // Максимум для масштабирования прогресс-баров в столбце каждого покупателя
    const maxByBuyer = {};
    for (const b of buyers) {
      const s = sum.find((x) => x.buyerId === b);
      const maxMean = Math.max(...bl.filter((x) => x.buyerId === b).map((x) => x.mean || 0), 1);
      maxByBuyer[b] = Math.max(s?.pmax || 0, maxMean);
    }

    let html = '<table><thead><tr><th>Тип робота</th>' + buyers.map((b) => `<th>${b}</th>`).join('') + '</tr></thead><tbody>';

    // Строки матрицы: конфигурация робота -> ожидаемая цена (mean) и 80%-доверительный интервал (low–high)
    for (const ty of types) {
      html += `<tr><td><span class="sw" style="background:${ROBOT_DOT[ty.color] || '#999'}"></span>${typeName(ty)}</td>`;
      for (const b of buyers) {
        const row = bl.find((x) => x.buyerId === b && x.color === ty.color && x.handles === ty.handles);
        if (!row) {
          html += '<td>—</td>';
          continue;
        }
        const best = Math.max(...bl.filter((x) => x.buyerId === b).map((x) => x.mean));
        const isBest = row.mean === best; // лучший вариант робота для этого покупателя
        const pct = Math.max(4, Math.min(100, Math.round((row.mean / maxByBuyer[b]) * 100)));
        html += `<td class="${isBest ? 'best' : ''}">
          <div class="price-cell">
            <div class="price-top">
              <span class="p-num">${fmt(row.mean, 1)}${isBest ? '<span class="best-tag">TOP</span>' : ''}</span>
              <span class="p-rng">${fmt(row.low)}–${fmt(row.high)}</span>
            </div>
            <div class="price-bar"><i style="width:${pct}%"></i></div>
          </div>
        </td>`;
      }
      html += '</tr>';
    }

    // Итоговая строка: наиболее вероятный целевой образец (sample) и уверенность модели в %
    html +=
      '<tr class="row-meta"><td><b>Образец по модели</b></td>' +
      buyers
        .map((b) => {
          const s = sum.find((x) => x.buyerId === b);
          return `<td>${s ? `${typeName(s.sample)} <span class="p-rng">${Math.round(s.confidence * 100)}%</span>` : '—'}</td>`;
        })
        .join('') +
      '</tr>';

    // Оценка потолка цены (Pmax) и коэффициента штрафа за несовпадение (f)
    html +=
      '<tr class="row-meta"><td><b>Pmax / f по модели</b></td>' +
      buyers
        .map((b) => {
          const s = sum.find((x) => x.buyerId === b);
          return `<td class="mono">${s ? `${fmt(s.pmax, 1)} / ${fmt(s.f, 2)}` : '—'}</td>`;
        })
        .join('') +
      '</tr>';

    // После окончания смены показываем реальные параметры покупателей и подсвечиваем, угадала ли модель
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

  // Фильтрация списка сделок (свежие сверху)
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

  // Актуализация выпадающих списков покупателей и типов роботов в фильтре журнала
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

  // Отрисовка таблицы журнала сделок (по умолчанию первые 15 записей, с кнопкой раскрытия)
  function sales() {
    syncSalesFilters();
    const filtered = getFilteredSales();
    const total = (data?.sales || []).length;
    $('salesCount').textContent = filtered.length === total ? String(total) : `${filtered.length} / ${total}`;

    if (!filtered.length) {
      $('sales').innerHTML = '<p class="empty-note">Сделок по выбранным фильтрам пока нет.</p>';
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
              r.outcome === 'sold' ? 'ПРОДАН' : 'ОТКАЗ · ' + (WHY_RU[r.reason] || r.reason || '—')
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
        ? 'СВЕРНУТЬ ДО 15'
        : `ПОКАЗАТЬ ВСЕ (${filtered.length})`;
    } else {
      foot.hidden = true;
    }
  }

  // Генерация и скачивание CSV-файла по отфильтрованным сделкам (с BOM для корректного открытия кириллицы в Excel)
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

  // ---------- Обновление всех представлений ----------
  // Главная функция перерисовки всего дашборда при получении свежих данных с сервера
  function drawAll() {
    if (!data) return;
    const max = Math.max(0, data.series.length - 1);
    const slider = $('tick');
    slider.max = max;
    // Если включён чекбокс "Следить", автоматически двигаем курсор в конец смены
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

  // Перемотка на конкретный такт t (перерисовывает только курсоры графиков и срез цеха)
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

  // Запуск/пауза ускоренного воспроизведения смены (+2 такта каждые 30 мс)
  function togglePlay() {
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
  }

  // ---------- Всплывающие подсказки графиков ----------
  const tickTip = (t, rows) => `<b>TAKT ${t}</b><br>` + rows.join('<br>');
  hoverable($('cCash'), () => frames.cash, (t) => {
    const p = data.series[t];
    return p && tickTip(t, [`деньги: <b>${fmt(p.cash, 1)}</b>`, `выручка: ${fmt(p.revenue)}`]);
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
        `<span class="sw" style="background:${css('--cobalt')}"></span>выпущено: <b>${p.produced}</b>`,
        `<span class="sw" style="background:${css('--emerald')}"></span>продано: <b>${p.sold}</b>`,
      ])
    );
  });
  hoverable($('cMachines'), () => frames.machines, (t, y) => {
    const f = frames.machines;
    const i = Math.floor((y - f.pad.t) / f.rowH); // определяем, на строку какого станка наведена мышь
    const m = data.machines[i];
    if (!m) return '';
    const on = data.busy[m]?.[t];
    return tickTip(t, [`${m}: <b>${on ? 'работает' : 'простаивает'}</b>`, `загрузка: ${Math.round((data.util[m] || 0) * 100)}%`]);
  });

  // ---------- Опрос API ----------
  // Запрос списка всех доступных прогонов (локальных и с арены)
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
        : '<option value="">— нет активных прогонов —</option>';
      if (cur && list.some((r) => r.runId === cur)) sel.value = cur;
      if (!selected && list.length) select(list[0].runId); // автовыбор первого прогона при старте
    } catch {}
  }

  // Загрузка полных данных выбранного прогона
  async function loadRun() {
    if (!selected) return;
    try {
      const r = await fetch('/ui/runs/' + encodeURIComponent(selected));
      if (!r.ok) return;
      data = await r.json();
      lastSyncAt = Date.now();
      $('hint').hidden = true; // прячем приветственный баннер
      drawAll();
    } catch {}
  }

  // Смена активного прогона
  function select(id) {
    selected = id;
    $('runSel').value = id;
    $('follow').checked = true;
    salesExpanded = false;
    loadRun();
  }

  // ---------- События ----------
  $('runSel').addEventListener('change', (e) => select(e.target.value));

  // Кнопка "Запустить симуляцию": отправляет параметры на сервер и переключается на новый прогон
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

  $('playBtn').addEventListener('click', togglePlay);

  // Управление с клавиатуры (Пробел — пауза/старт, стрелки — шаг по тактам)
  window.addEventListener('keydown', (e) => {
    if (!data) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space' && (activeView === 'overview' || activeView === 'floor')) {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      $('follow').checked = false;
      setTick(Math.max(0, tick - 1));
    } else if (e.code === 'ArrowRight') {
      $('follow').checked = false;
      setTick(Math.min(data.series.length - 1, tick + 1));
    }
  });

  // Обработчики фильтров журнала сделок и экспорта
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

  // Перерисовка графиков при изменении размера окна браузера
  window.addEventListener('resize', () => {
    if (data && activeView === 'overview') {
      drawCash();
      drawStorage();
      drawMachines();
      drawFlow();
    }
  });

  // Запуск фонового поллинга: список прогонов обновляем раз в 2 сек, данные активного прогона — каждые 600 мс (пока он не завершится)
  loadRuns();
  setInterval(loadRuns, 2000);
  setInterval(() => {
    if (data && data.done && data.runId === selected) return;
    loadRun();
  }, 600);
})();
