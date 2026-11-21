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
