// ==UserScript==
// @name         Легион — чат шахты и города в отдельном окне
// @name:en      Legion — mine & town chat in a separate window
// @namespace    https://play.multidonate.ru/legion-chat-window
// @version      3.19.1.2
// @description  Чат шахты и города игры «Легион» (play.multidonate.ru): панель прямо в игре или отдельное окно, личные диалоги, стримеры, стикеры 7TV/BTTV/FFZ, пасты, модерация, темы
// @description:en  Mine and town chat of the "Legion" game (play.multidonate.ru): in-game side panel or separate window, private messages, channel switching, emotes, pastes, moderation, themes
// @author       feedfinek
// @license      MIT
// @homepageURL  https://github.com/frebertor-sudo/legion-chat-window
// @supportURL   https://github.com/frebertor-sudo/legion-chat-window/issues
// @updateURL    https://raw.githubusercontent.com/frebertor-sudo/legion-chat-window/main/legion-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/frebertor-sudo/legion-chat-window/main/legion-chat.user.js
// @match        https://play.multidonate.ru/c/*
// @match        https://play.multidonate.ru/site/ver*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  MIT License — свободно используй, меняй и распространяй с сохранением этого уведомления.
  Неофициальный скрипт: к разработчикам игры и стримерам отношения не имеет.

  Куда ходит скрипт: только на play.multidonate.ru (под входом самого пользователя) и в открытые API стикеров —
  api.ivr.fi (id канала Twitch), 7tv.io / cdn.7tv.app, api.betterttv.net / cdn.betterttv.net, api.frankerfacez.com.
  Никакие данные пользователя никуда больше не отправляются. Настройки и пасты хранятся только в браузере.
*/

/*
  Как устроено:
  • На странице игры (…/c/<канал>/) слева внизу кнопки «💬 Чат» (панель сбоку прямо в игре) и «⧉» (отдельное окно).
  • Панель — это то же окно чата в рамке (&embed=1); код работает и как userscript, и как расширение (tools/build.py).
  • Окно живёт по адресу https://play.multidonate.ru/site/ver?minechat=<канал>[&room=city]
    (служебный адрес сайта без строгой CSP — с него можно ходить в API игры под твоим входом).
  • Шахта: GET /c/<канал>/api/mine/state?c=<шахта>&mc=<номер>, отправка POST /c/<канал>/api/mine/chat/say?c=<шахта>.
  • Город: чтение требует «входа» героя на Ярмарку (POST /c/<канал>/api/city/enter) — окно делает это
    только по твоей кнопке (или сразу, если ты так настроил), дальше GET /api/city/state?c=<номер>,
    отправка POST /api/city/say; при уходе — POST /api/city/leave.
  • Список стримеров — GET /c/<канал>/api/channels.
  • «🔀 Всё»: шахта и город текущего стримера в одной ленте по времени, с пометкой источника и фильтрами.
  • Личные (с 29.10 — своя система игры): GET /api/dm?with=, POST /api/dm/say, /api/dm/report; новые — событием «dm» канала /api/live.
    Друзья и блок — /api/friends. Вкладки собеседников общие с личкой игры (lgDm:<канал>:<ник>).
  • Если город уже открыт в игре (GET /api/city/state отвечает), чат не входит повторно и не выводит героя.
  • С 29.10 у игры единый чат: город читается GET /api/chat/feed?room=city[&c=], пишется POST /api/chat/say { text, room: 'city' [, k: 'tr'] }
    откуда угодно (герой не идёт на Ярмарку); шахта — { room: 'mine' }, если герой не в шахте. Старый путь — запасной.
  • Модерация (только у админа и модераторов чата): GET/POST <чат>/mod — удалить, мут, бан, снять, назначить модератора.
  • ⚜ Гильдии: закрытый чат через ntfy.sh — шифр AES-GCM, подписи ECDSA, ключи передаются личными игры (подробно — у модуля гильдий).
*/

(function () {
  'use strict';
  const ORIGIN = 'https://play.multidonate.ru';
  // В расширении для Firefox обычный fetch из скрипта расширения идёт без куки входа в игру;
  // content.fetch делает запрос «от имени страницы». В Chrome и в userscript такого объекта нет — там обычный fetch.
  /* global content */
  const pfetch = typeof content === 'object' && content && typeof content.fetch === 'function' ? content.fetch.bind(content) : fetch.bind(window);
  const PES = typeof content === 'object' && content && typeof content.EventSource === 'function' ? content.EventSource : window.EventSource;
  const chatUrl = (ch, room) => `${ORIGIN}/site/ver?minechat=${encodeURIComponent(ch)}${room === 'city' || room === 'all' || room === 'pm' || room === 'ping' || room === 'guild' ? '&room=' + room : ''}`;

  // ---------- 1. Страница игры: панель чата сбоку + кнопка «в отдельное окно» ----------
  const game = location.pathname.match(/^\/c\/([^/]+)\/?$/i);
  if (game) {
    if (window.top !== window) return;
    const CH = game[1].toLowerCase();
    const lg = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
    const ls = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
    const roomFor = () => { const last = lg('lgmc_last', null); return last && last.ch === CH ? last.room : null; };
    const minW = 280, maxW = () => Math.max(minW, Math.min(900, window.innerWidth - 120));
    let dock = null, frame = null, btn = null, dockFromFrame = null;
    // где панель: справа / слева (во всю высоту, ширина тянется) или плавающее окно (место и размер — свои)
    const L = Object.assign({ mode: 'r', w: lg('lgmc_dock_w', 380), x: 0, y: 0, fw: 400, fh: 620, side: 'r' }, lg('lgmc_dock_pos', {}) || {});
    const saveL = () => ls('lgmc_dock_pos', L);
    const vw = () => window.innerWidth, vh = () => window.innerHeight;

    function build() {
      dock = document.createElement('div');
      dock.id = 'lgmc-dock';
      dock.hidden = true;
      dock.innerHTML = `<div class="lgmc-bar" title="Потяни, чтобы переместить; двойной щелчок — прикрепить или открепить">
          <span class="lgmc-t" aria-hidden="true">⠿ Чат Легиона</span>
          <button type="button" data-m="l" title="Прикрепить слева" aria-label="Прикрепить слева">◧</button>
          <button type="button" data-m="f" title="Плавающее окно — можно двигать и менять размер" aria-label="Плавающее окно">❐</button>
          <button type="button" data-m="r" title="Прикрепить справа" aria-label="Прикрепить справа">◨</button>
        </div><div class="lgmc-body"></div>
        <div class="lgmc-grip" title="Потяни, чтобы изменить ширину" aria-hidden="true"></div>
        <div class="lgmc-corner" data-rz="se" title="Потяни, чтобы изменить размер" aria-hidden="true"></div><div class="lgmc-rz" data-rz="n" aria-hidden="true"></div><div class="lgmc-rz" data-rz="s" aria-hidden="true"></div><div class="lgmc-rz" data-rz="e" aria-hidden="true"></div><div class="lgmc-rz" data-rz="w" aria-hidden="true"></div><div class="lgmc-rz" data-rz="ne" aria-hidden="true"></div><div class="lgmc-rz" data-rz="nw" aria-hidden="true"></div><div class="lgmc-rz" data-rz="sw" aria-hidden="true"></div>
        <div class="lgmc-shield" hidden></div>`;
      const snap = document.createElement('div'); snap.id = 'lgmc-snap'; snap.hidden = true;
      const st = document.createElement('style');
      st.textContent = `#lgmc-dock{box-sizing:border-box;position:fixed;z-index:2147483000;display:flex;flex-direction:column;background:#120e22;box-shadow:-12px 0 30px -18px rgba(0,0,0,.7)}
        #lgmc-dock[hidden],#lgmc-snap[hidden],#lgmc-dock [hidden]{display:none}
        #lgmc-dock.m-r{top:0;right:0;bottom:0;width:var(--lgmc-w,380px);max-width:100vw;border-left:1px solid #322b4d}
        #lgmc-dock.m-l{top:0;left:0;bottom:0;width:var(--lgmc-w,380px);max-width:100vw;border-right:1px solid #322b4d;box-shadow:12px 0 30px -18px rgba(0,0,0,.7)}
        #lgmc-dock.m-f{left:var(--fx,40px);top:var(--fy,40px);width:var(--fw,400px);height:var(--fh,620px);border:1px solid #4a4068;border-radius:14px;overflow:hidden;box-shadow:0 22px 60px -14px rgba(0,0,0,.75)}
        #lgmc-dock .lgmc-bar.off{display:none}
        #lgmc-dock .lgmc-bar{flex:none;height:24px;display:flex;align-items:center;gap:2px;padding:0 4px 0 8px;background:#1b1631;color:#a59fba;font:700 11px/1 Nunito,"Segoe UI",system-ui,sans-serif;cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid #322b4d}
        #lgmc-dock.drag-move .lgmc-bar{cursor:grabbing}
        #lgmc-dock .lgmc-t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #lgmc-dock .lgmc-bar button{background:none;border:1px solid transparent;color:#f6f1fb;border-radius:4px;padding:0 5px;font:13px/18px system-ui;cursor:pointer}
        #lgmc-dock .lgmc-bar button:hover,#lgmc-dock .lgmc-bar button:focus-visible{border-color:#4a4068;outline:none}
        #lgmc-dock .lgmc-bar button[aria-pressed="true"]{background:#ff9fd0;color:#15122e;border-color:#ff9fd0}
        #lgmc-dock .lgmc-body{flex:1;min-height:0}
        #lgmc-dock iframe{display:block;width:100%;height:100%;border:0;background:#120e22}
        #lgmc-dock .lgmc-grip{position:absolute;top:0;bottom:0;width:10px;cursor:ew-resize;z-index:2}
        #lgmc-dock.m-r .lgmc-grip{left:-5px}#lgmc-dock.m-l .lgmc-grip{right:-5px}#lgmc-dock.m-f .lgmc-grip{display:none}
        #lgmc-dock .lgmc-grip:hover,#lgmc-dock.drag-w .lgmc-grip{background:linear-gradient(90deg,transparent 4px,#ff9fd0 4px,#ff9fd0 6px,transparent 6px)}
        #lgmc-dock .lgmc-corner{display:none;position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:2;background:linear-gradient(135deg,transparent 55%,#4a4068 55%,#4a4068 62%,transparent 62%,transparent 72%,#4a4068 72%,#4a4068 79%,transparent 79%)}
        #lgmc-dock.m-f .lgmc-corner{display:block}
        #lgmc-dock.mini .lgmc-rz:not([data-rz="e"]):not([data-rz="w"]),#lgmc-dock.mini .lgmc-corner{display:none!important}
        #lgmc-dock.mini{width:65px!important;border-radius:14px}
        #lgmc-dock.mini.m-r,#lgmc-dock.mini.m-l{border-radius:0}
        #lgmc-dock .lgmc-rz{display:none;position:absolute;z-index:2}
        #lgmc-dock.m-f .lgmc-rz{display:block}
        #lgmc-dock .lgmc-rz[data-rz="n"]{top:0;left:14px;right:14px;height:5px;cursor:ns-resize}
        #lgmc-dock .lgmc-rz[data-rz="s"]{bottom:0;left:14px;right:18px;height:6px;cursor:ns-resize}
        #lgmc-dock .lgmc-rz[data-rz="e"]{right:0;top:14px;bottom:18px;width:6px;cursor:ew-resize}
        #lgmc-dock .lgmc-rz[data-rz="w"]{left:0;top:14px;bottom:14px;width:6px;cursor:ew-resize}
        #lgmc-dock .lgmc-rz[data-rz="ne"]{right:0;top:0;width:14px;height:14px;cursor:nesw-resize}
        #lgmc-dock .lgmc-rz[data-rz="nw"]{left:0;top:0;width:14px;height:14px;cursor:nwse-resize}
        #lgmc-dock .lgmc-rz[data-rz="sw"]{left:0;bottom:0;width:14px;height:14px;cursor:nesw-resize}
        #lgmc-dock .lgmc-rz:hover,#lgmc-dock.drag-size .lgmc-rz.on{background:rgba(255,159,208,.35);border-radius:4px}
        #lgmc-dock .lgmc-shield{position:fixed;inset:0;z-index:3}
        #lgmc-dock{opacity:var(--lgmc-op,1);transition:opacity .15s}
        #lgmc-dock.ophov:hover,#lgmc-dock.ophov:focus-within,#lgmc-dock[class*="drag-"]{opacity:1}
        #lgmc-dock.clear{background:transparent;box-shadow:none}
        #lgmc-dock.clear iframe{background:transparent}
        #lgmc-dock.clear.m-r,#lgmc-dock.clear.m-l{border-color:rgba(74,64,104,.45)}
        #lgmc-dock.clear .lgmc-bar{background:rgba(15,12,34,.6);border-bottom-color:rgba(50,43,77,.5)}
        #lgmc-snap{position:fixed;top:0;bottom:0;z-index:2147482999;background:rgba(255,159,208,.18);border:2px dashed #ff9fd0;box-sizing:border-box;pointer-events:none}
        #lgmc-btns{position:fixed;left:10px;bottom:10px;z-index:2147483001;display:flex;border-radius:999px;overflow:hidden;border:0;opacity:.88;font:700 13px Nunito,"Segoe UI",system-ui,sans-serif}
        #lgmc-btns:hover{opacity:1}
        #lgmc-btns button{background:rgba(15,12,34,.82);color:#fff;border:0;padding:6px 10px;cursor:pointer;font:inherit}
        #lgmc-btns button+button{border-left:1px solid rgba(255,255,255,.14)}
        #lgmc-btns button[aria-pressed="true"]{background:#ff9fd0;color:#15122e}
        #lgmc-btns.in-game{display:none}
        .cy-chat>.lgmc-gc{position:absolute;top:0;left:var(--lgmc-gx,83px);height:var(--lgmc-gh,40px);display:flex;border-radius:999px;overflow:hidden;background:rgba(15,12,34,.82);color:#fff;font:700 14px/1 Nunito,"Segoe UI",system-ui,sans-serif;z-index:1}
        .cy-chat>.lgmc-gc[hidden],.cy-chat-t[aria-expanded="true"]~.lgmc-gc{display:none}
        .cy-chat>.lgmc-gc button{background:none;border:0;color:inherit;font:inherit;padding:0 12px;cursor:pointer;white-space:nowrap}
        .cy-chat>.lgmc-gc button+button{padding:0 11px;border-left:1px solid rgba(255,255,255,.14)}
        .cy-chat>.lgmc-gc button:hover,.cy-chat>.lgmc-gc button:focus-visible{background:rgba(255,255,255,.1);outline:none}
        .cy-chat>.lgmc-gc button[aria-pressed="true"],.lgmc-gh button[aria-pressed="true"]{background:#ff9fd0;color:#15122e}
        .lgmc-gh{display:flex;gap:6px;margin-left:auto}
        .lgmc-gh button{width:28px;height:28px;border:0;border-radius:8px;background:rgba(255,255,255,.1);color:#fff;font:600 14px/1 system-ui,sans-serif;cursor:pointer;padding:0}
        .lgmc-gh button:hover,.lgmc-gh button:focus-visible{background:rgba(255,255,255,.2);outline:none}
        @media (prefers-reduced-motion: no-preference){#lgmc-dock.anim{transition:left .15s,top .15s,width .15s,height .15s}}
        @media (max-width:640px){#lgmc-dock.m-r,#lgmc-dock.m-l{width:100vw!important;border:0}#lgmc-dock .lgmc-grip{display:none}}`;
      document.head.appendChild(st);
      document.body.appendChild(dock); document.body.appendChild(snap);
      const bar = dock.querySelector('.lgmc-bar'), grip = dock.querySelector('.lgmc-grip'), shield = dock.querySelector('.lgmc-shield');
      // перетаскивание: поверх рамки — прозрачный щит, иначе рамка «съедает» движение мыши
      const drag = (cls, onMove, onUp, lazy) => {
        dock.classList.add(cls); if (!lazy) shield.hidden = false;
        const move = (ev) => onMove(ev);
        const up = (ev) => { dock.classList.remove(cls); shield.hidden = true; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); if (onUp) onUp(ev); saveL(); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      };
      // ширина прикреплённой панели
      grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        drag('drag-w', (ev) => {   // уже минимума — свернуть до колонки; потянул обратно — развернуть
          const raw = L.mode === 'l' ? ev.clientX : vw() - ev.clientX, m = raw < minW - 90;
          L.mini = m; if (!m) L.w = clampW(raw); apply();
        });
      });
      // перемещение за полоску: прикреплённая — отрывается под курсором, у края — прилипает
      bar.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || e.target.closest('button')) return;
        e.preventDefault();
        const r = dock.getBoundingClientRect();
        let offX = e.clientX - r.left, offY = e.clientY - r.top, started = false, edge = null;
        const sx = e.clientX, sy = e.clientY;
        drag('drag-move', (ev) => {
          if (!started) {
            if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;   // это был щелчок, а не перенос
            started = true; shield.hidden = false;
            if (L.mode !== 'f') {   // оторвать: окно прежнего размера, курсор — на той же доле полоски
              L.side = L.mode; L.mode = 'f';
              offX = Math.round(Math.min(L.fw - 60, offX * L.fw / Math.max(1, r.width))); offY = Math.min(offY, 20);
            }
          }
          L.x = ev.clientX - offX; L.y = ev.clientY - offY;
          edge = ev.clientX <= 18 ? 'l' : ev.clientX >= vw() - 18 ? 'r' : null;
          snap.hidden = !edge;
          if (edge) { snap.style.left = edge === 'l' ? '0' : 'auto'; snap.style.right = edge === 'r' ? '0' : 'auto'; snap.style.width = clampW(L.w) + 'px'; }
          apply();
        }, () => { snap.hidden = true; if (started && edge) { L.mode = edge; L.side = edge; apply(); } }, true);
      });
      // перенос, начатый в самом чате (⠿ или пустое место шапки): рамка присылает координаты указателя
      let rm = null;
      dockFromFrame = (d) => {
        if (!frame) return;
        const fr = frame.getBoundingClientRect(), px = fr.left + (+d.x || 0), py = fr.top + (+d.y || 0);
        if (d.ph === 'start') { const r = dock.getBoundingClientRect(); rm = { offX: px - r.left, offY: py - r.top, sx: px, sy: py, r, started: false, edge: null }; return; }
        if (!rm) return;
        if (d.ph === 'move') {
          if (!rm.started) {
            if (Math.abs(px - rm.sx) + Math.abs(py - rm.sy) < 6) return;
            rm.started = true; dock.classList.add('drag-move');
            if (L.mode !== 'f') { L.side = L.mode; L.mode = 'f'; rm.offX = Math.round(Math.min(L.fw - 60, rm.offX * L.fw / Math.max(1, rm.r.width))); rm.offY = Math.min(rm.offY, 40); }
          }
          L.x = px - rm.offX; L.y = py - rm.offY;
          rm.edge = px <= 18 ? 'l' : px >= vw() - 18 ? 'r' : null;
          snap.hidden = !rm.edge;
          if (rm.edge) { snap.style.left = rm.edge === 'l' ? '0' : 'auto'; snap.style.right = rm.edge === 'r' ? '0' : 'auto'; snap.style.width = clampW(L.w) + 'px'; }
          apply(); return;
        }
        if (d.ph === 'end') { dock.classList.remove('drag-move'); snap.hidden = true; if (rm.started && rm.edge) { L.mode = rm.edge; L.side = rm.edge; apply(); } rm = null; saveL(); }
      };
      bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) setMode(L.mode === 'f' ? L.side || 'r' : 'f'); });
      bar.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) setMode(b.dataset.m); });
      // размер плавающего окна — за любой край или угол; противоположный край стоит на месте
      for (const h of dock.querySelectorAll('[data-rz]')) h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const d = h.dataset.rz, x0 = L.x, y0 = L.y, w0 = L.fw, h0 = L.fh, sx = e.clientX, sy = e.clientY;
        h.classList.add('on');
        drag('drag-size', (ev) => {
          const dx = ev.clientX - sx, dy = ev.clientY - sy;
          if (d.includes('e')) L.fw = Math.max(minW, Math.min(vw() - x0, w0 + dx));
          if (d.includes('w')) { L.fw = Math.max(minW, Math.min(x0 + w0, w0 - dx)); L.x = x0 + w0 - L.fw; }
          if (d === 'e' || d === 'w') { const raw = d === 'e' ? w0 + dx : w0 - dx; L.mini = raw < minW - 90; if (L.mini && d === 'w') L.x = x0 + w0 - 65; }
          if (d.includes('s')) L.fh = Math.max(240, Math.min(vh() - y0, h0 + dy));
          if (d.includes('n')) { L.fh = Math.max(240, Math.min(y0 + h0, h0 - dy)); L.y = y0 + h0 - L.fh; }
          apply();
        }, () => h.classList.remove('on'));
      });
      window.addEventListener('resize', apply);
      // прозрачность — из настроек чата (⚙ в окне чата, тот же localStorage): меняется сразу
      window.addEventListener('storage', (e) => { if (e.key === 'lgmc_cz') opApply(); });
      opApply();
      apply();
    }
    function opApply() {
      if (!dock) return;
      const cz = lg('lgmc_cz', {}) || {};
      const op = Math.max(0, Math.min(70, +cz.opac || 0)), clr = Math.max(0, Math.min(90, +cz.bgClear || 0));
      dock.style.setProperty('--lgmc-op', String(1 - op / 100));
      dock.classList.toggle('ophov', cz.opHover !== false);
      dock.classList.toggle('clear', clr > 0);
    }
    const clampW = (w) => Math.round(Math.max(minW, Math.min(maxW(), +w || 380)));
    function setMode(m) {
      if (m === L.mode) return;
      if (m === 'f' && (!L.x && !L.y)) { L.x = Math.max(10, vw() - L.fw - 40); L.y = 40; }   // первый раз — у правого края
      if (m !== 'f') L.side = m;
      L.mode = m;
      dock.classList.add('anim'); apply(); setTimeout(() => dock && dock.classList.remove('anim'), 200);
      saveL();
    }
    // разложить по сохранённому: удержать на экране (полоска всегда видна), прикреплённую — нужной ширины
    function apply() {
      if (!dock) return;
      L.w = clampW(L.w);
      // плавающее окно — целиком на экране: и полоска, и уголок размера всегда доступны
      L.fw = Math.max(minW, Math.min(vw(), +L.fw || 400)); L.fh = Math.max(240, Math.min(vh(), +L.fh || 620));
      L.x = Math.max(0, Math.min(vw() - L.fw, +L.x || 0)); L.y = Math.max(0, Math.min(vh() - L.fh, +L.y || 0));
      dock.classList.toggle('m-r', L.mode === 'r'); dock.classList.toggle('m-l', L.mode === 'l'); dock.classList.toggle('m-f', L.mode === 'f');
      dock.classList.toggle('mini', !!L.mini);
      dock.style.setProperty('--lgmc-w', (L.mini ? 65 : L.w) + 'px');
      dock.style.setProperty('--fx', Math.round(L.x) + 'px'); dock.style.setProperty('--fy', Math.round(L.y) + 'px');
      dock.style.setProperty('--fw', (L.mini ? 65 : Math.round(L.fw)) + 'px'); dock.style.setProperty('--fh', Math.round(L.fh) + 'px');
      for (const b of dock.querySelectorAll('[data-m]')) b.setAttribute('aria-pressed', String(b.dataset.m === L.mode));
      // боковая колонка чата — у края экрана; только когда рамка уже загрузилась (трогать пустую рамку нельзя — сорвёт запуск чата в ней)
      if (frame && frame.lgReady) try { frame.contentWindow.postMessage({ lgmc: 'side', side: L.mode, mini: !!L.mini }, location.origin); } catch {}
      // кнопки «💬 Чат / ⧉» не прячутся под панелью, прикреплённой слева
      const g = document.getElementById('lgmc-btns');
      if (g) g.style.left = !dock.hidden && L.mode === 'l' && vw() > 640 ? ((L.mini ? 65 : L.w) + 10) + 'px' : '10px';
    }

    // из какого чата игры открыли: та же комната («Всё» и «Личные», если ты там был, не сбиваются)
    const urlFor = (room) => {
      const last = roomFor(), r = !room || last === 'all' || last === 'pm' || last === 'ping' ? last : room;
      return r === 'mine' ? chatUrl(CH) + '&room=mine' : chatUrl(CH, r);
    };
    function setOpen(on, room) {
      if (on) {
        if (!dock) build();
        if (!frame) {   // рамка создаётся при открытии и убирается при закрытии — скрытый чат не опрашивает сервер
          frame = document.createElement('iframe');
          frame.title = 'Чат Легиона';
          frame.src = urlFor(room) + '&embed=1&side=' + L.mode;
          dock.querySelector('.lgmc-body').appendChild(frame);
        }
        dock.hidden = false; apply();
      } else if (dock) {
        dock.hidden = true;
        if (frame) { frame.remove(); frame = null; }
      }
      ls('lgmc_dock_open', !!on);
      if (btn) btn.setAttribute('aria-pressed', String(!!on));
      for (const b of document.querySelectorAll('.lgmc-gc [data-a="dock"],.lgmc-gh [data-a="dock"]')) b.setAttribute('aria-pressed', String(!!on));
      apply();
    }
    const popOut = (room) => { setOpen(false); window.open(urlFor(room), 'lgChat', 'popup,width=420,height=720'); };

    // кнопки прямо в чате игры (город и шахта — один и тот же компонент .cy-chat):
    // свёрнут — рядом с «💬 Чат», открыт — в шапке рядом с «свернуть». Плавающие кнопки — только там, где чата игры нет.
    function gameChats() {
      const g = document.getElementById('lgmc-btns');
      let shown = false;
      for (const c of document.querySelectorAll('.cy-chat')) {
        const room = c.closest('#tab-city') ? 'city' : 'mine';
        const t = c.querySelector(':scope > .cy-chat-t'), h = c.querySelector('.cy-chat-h');
        const on = String(!!dock && !dock.hidden);
        let p = c.querySelector(':scope > .lgmc-gc');
        if (t && !p) {
          p = document.createElement('div'); p.className = 'lgmc-gc'; p.dataset.room = room;
          p.innerHTML = `<button type="button" data-a="dock" aria-pressed="${on}" title="Открыть Чат Легиона панелью (её можно двигать)">Чат Легиона</button><button type="button" data-a="win" title="Чат Легиона отдельным окном" aria-label="Чат Легиона отдельным окном">⧉</button>`;
          t.after(p);
        }
        if (h && !h.querySelector('.lgmc-gh')) {
          const q = document.createElement('span'); q.className = 'lgmc-gh'; q.dataset.room = room;
          q.innerHTML = `<button type="button" data-a="dock" aria-pressed="${on}" title="Чат Легиона панелью" aria-label="Чат Легиона панелью">◨</button><button type="button" data-a="win" title="Чат Легиона отдельным окном" aria-label="Чат Легиона отдельным окном">⧉</button>`;
          const first = h.querySelector(':scope > button'); if (first) first.before(q); else h.appendChild(q);
        }
        if (p && t) {   // встать вплотную справа от «💬 Чат» (ширина меняется со счётчиком)
          p.style.setProperty('--lgmc-gx', (t.offsetLeft + t.offsetWidth + 6) + 'px');
          p.style.setProperty('--lgmc-gh', (t.offsetHeight || 40) + 'px');
          p.style.top = t.offsetTop + 'px';
        }
        if (c.offsetParent !== null && !c.hidden) shown = true;
      }
      if (g) g.classList.toggle('in-game', shown);
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.lgmc-gc [data-a], .lgmc-gh [data-a]'); if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const room = b.parentElement.dataset.room;
      if (b.dataset.a === 'dock') setOpen(!dock || dock.hidden, room); else popOut(room);
    }, true);

    const addUi = () => {
      if (document.getElementById('lgmc-btns')) return;
      if (!dock) build();
      const g = document.createElement('div');
      g.id = 'lgmc-btns';
      g.innerHTML = '<button type="button" data-a="dock" aria-pressed="false" title="Показать или скрыть чат (панель можно двигать за полоску сверху)">💬 Чат</button><button type="button" data-a="win" title="Открыть чат отдельным окном" aria-label="Открыть чат отдельным окном">⧉</button>';
      btn = g.querySelector('[data-a="dock"]');
      g.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]'); if (!b) return;
        if (b.dataset.a === 'dock') setOpen(dock.hidden);
        else popOut();
      });
      document.body.appendChild(g);
      if (lg('lgmc_dock_open', false)) setOpen(true);
      gameChats(); setInterval(gameChats, 700);
    };
    // команды от чата в рамке: «скрыть», «вынесен в окно»
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || typeof e.data.lgmc !== 'string') return;
      if (e.data.lgmc === 'close' || e.data.lgmc === 'popped') setOpen(false);
      if (frame && e.source === frame.contentWindow && e.data.lgmc === 'drag' && dockFromFrame) { dockFromFrame(e.data); return; }
      if (frame && e.source === frame.contentWindow && e.data.lgmc === 'mode') { if (/^[lrf]$/.test(e.data.m)) setMode(e.data.m); else if (e.data.m === 'toggle') setMode(L.mode === 'f' ? L.side || 'r' : 'f'); else if (e.data.m === 'mini' || e.data.m === 'full') { L.mini = e.data.m === 'mini'; apply(); saveL(); } return; }
      if (e.data.lgmc === 'ready' && frame && e.source === frame.contentWindow) { frame.lgReady = true; if (e.data.ctl) { const b = dock.querySelector('.lgmc-bar'); if (b) b.classList.add('off'); } try { frame.contentWindow.postMessage({ lgmc: 'side', side: L.mode, mini: !!L.mini }, location.origin); } catch {} return; }
      // окно обмена — в «Городе» игры: открыть эту вкладку
      if (e.data.lgmc === 'citytab') { const b = document.querySelector('nav [data-tab="city"], [data-tab="city"]'); if (b) b.click(); else { location.hash = '#city'; location.reload(); } return; }
      // «📍 встать в город» из панели: игра помнит город во вкладке и открывает «Город» по #city — перезагружаем страницу игры
      if (e.data.lgmc === 'town' && typeof e.data.id === 'string' && /^[a-z0-9_-]{1,32}$/i.test(e.data.id)) {
        const id = e.data.id, ch = String(e.data.ch || CH).toLowerCase();
        try { if (id === 'fair') sessionStorage.removeItem('lgCityTown'); else sessionStorage.setItem('lgCityTown', id); } catch {}
        if (ch !== CH) { window.open(`/c/${encodeURIComponent(ch)}/#city`, '_blank'); return; }
        location.hash = '#city'; location.reload();
      }
    });
    if (document.body) addUi(); else document.addEventListener('DOMContentLoaded', addUi);
    return;
  }

  // ---------- 2. Окно чата: /site/ver?minechat=<канал> ----------
  if (location.pathname !== '/site/ver') return;
  const Q = new URLSearchParams(location.search);
  const EMBED = Q.get('embed') === '1' && window.parent !== window;   // открыт панелью внутри игры
  const LAST0 = (() => { try { return JSON.parse(localStorage.getItem('lgmc_last') || 'null'); } catch { return null; } })();
  const CH0 = Q.get('minechat') === 'last' ? (LAST0 && LAST0.ch) || 'zakvielchannel' : Q.get('minechat');
  const okLogin = (s) => /^[a-z0-9_]{1,40}$/i.test(String(s || ''));
  if (!okLogin(CH0)) return;

  const CLS_ICO = { legionary: '⚔️', archer: '🏹', mage: '🔮', priest: '✨', rogue: '🗡️', necromancer: '💀', paladin: '☀️', recruit: '🌱' };
  const ROLE_ICO = { own: ['👑', 'админ чата'], mod: ['🛡', 'модератор чата'] };
  const ERR = {
    rate_limited: 'Не так быстро', forbidden: 'Нет прав', login_required: 'Войди через Twitch на сайте игры',
    mine_closed: 'Шахта закрыта', city_closed: 'Город закрыт', town_closed: 'Этот город сейчас закрыт',
  };
  const ROOMS = { mine: '⛏ Шахта', city: '🏰 Город', all: '🔀 Всё', pm: '✉ Личные', ping: '📣 Пинги', guild: '⚜ Гильдия' };
  const SRC = { mine: 'Шахта', g: 'Город', tr: 'Торг', ev: 'Событие', dm: 'Лично' };   // пометки источника в общей ленте
  const usesMine = (r) => r === 'mine' || r === 'all' || r === 'ping', usesCity = (r) => r === 'city' || r === 'all' || r === 'ping';
  // подпись комнаты: значок + название; в узком окне у неактивных остаётся только значок (название — в подсказке)
  const rlab = (r) => { const [i, ...t] = ROOMS[r].split(' '); return `<span aria-hidden="true">${i}</span><span class="rl"> ${t.join(' ')}</span>`; };
  const isMix = (r) => r === 'all' || r === 'ping';   // общая лента шахты и города: «Всё» и «Пинги»
  const TABS = { g: 'Общий', tr: 'Торговля', ev: 'Достижения', dm: 'Личные' };
  const CITY_SPAWN = { x: 2460, y: 1010, town: 'fair' };   // как в игре: Ярмарка, у входа (citymap: QW + 660, 1010)
  const LAST_KEY = 'lgmc_last', CITY_AUTO_KEY = 'lgmc_city_auto';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // цвет ника — как в чате самой игры (site-chat.js, 24.10): 16 светлых цветов, выбор по хешу FNV-1a от ника.
  // На светлой теме те же цвета темнее (--ncm), иначе жёлтый и мятный не читаются.
  const NICK_COLORS = ['#ffc94d', '#ff8a80', '#ffab6e', '#f4ff81', '#b9f6ca', '#69f0ae', '#84ffff', '#80d8ff', '#9fa8ff', '#b388ff', '#ea80fc', '#ff80ab', '#ffd180', '#a7ffeb', '#ccff90', '#ffcdd2'];
  const nickColor = (l) => { let h = 2166136261; const t = String(l || '').toLowerCase(); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return NICK_COLORS[(h >>> 0) % NICK_COLORS.length]; };
  // свои цвет и прозвище для ников (lgmc_nick: { ник: { c: '#цвет', a: 'прозвище' } }) — видны только тебе
  const NK_KEY = 'lgmc_nick';
  let NK = (() => { try { return JSON.parse(localStorage.getItem(NK_KEY) || '{}') || {}; } catch { return {}; } })();
  const nkColor = (l) => (NK[l] && /^#[0-9a-f]{6}$/i.test(NK[l].c || '') ? NK[l].c : nickColor(l));
  const aliasOf = (l) => (NK[l] && NK[l].a) || '';
  const ncol = (l) => `color-mix(in oklch, ${nkColor(l)} var(--ncm,100%), var(--ncb,#000))`;
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const S = {
    ch: CH0.toLowerCase(), chName: CH0, room: ['city', 'all', 'pm', 'ping', 'guild'].includes(Q.get('room')) ? Q.get('room') : Q.get('minechat') === 'last' && LAST0 && ['city', 'all', 'pm', 'ping', 'guild'].includes(LAST0.room) ? LAST0.room : 'mine', mine: 'home', mines: [],
    channels: [], me: '', hero: null, flags: { cc: false, tr: false, dm: false }, inCity: false, entering: false,
    tab: 'g', un: { g: 0, tr: 0, ev: 0, dm: 0 }, ign: new Set(), gen: 0,
    mc: 0, cc: 0, list: [], ids: new Set(), mix: Object.assign({ mine: true, g: true, tr: true, ev: true, dm: true }, lsGet('lgmc_mix', {})), to: lsGet('lgmc_mix_to', 'g'), timer: 0, busy: false, fails: 0, stick: true, unseen: 0, unseenTitle: 0,
  };
  // если в адресе канал не указан явно иначе — вернуть то, где был в прошлый раз (только комнату для того же канала)
  { const last = lsGet(LAST_KEY, null); if (last && last.ch === S.ch && !Q.get('room') && ROOMS[last.room]) S.room = last.room; }
  if (Q.get('minechat') === 'last') try { history.replaceState(null, '', chatUrl(S.ch, S.room) + (EMBED ? '&embed=1' : '')); } catch {}
  const BASE = () => `/c/${S.ch}`;
  const title = () => `${S.pm && S.pm.total ? `✉${S.pm.total} · ` : ''}${{ mine: 'Шахта', city: 'Город', all: 'Все чаты', pm: 'Личные', ping: 'Пинги', guild: 'Гильдия' }[S.room]} · ${S.chName}`;

  function boot() {
    // на этапе document-start корня <html> может ещё не быть — тогда создаём его сами
    if (!document.documentElement) document.appendChild(document.createElement('html'));
    document.documentElement.innerHTML =`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Чат · ${esc(S.chName)}</title>
<style>
:root{color-scheme:dark;--bg:#120e22;--panel:#1b1631;--line:#322b4d;--tx:#f6f1fb;--mut:#a59fba;--acc:#ff9fd0;--acc-tx:#ff9fd0;--on-acc:#15122e;--me:#3b2146;--bad:#ff7b7b;--ok:#6fdc8c;--ns:65%;--nl:68%;--ncm:100%;--hov:#221c3c;--pns:#1b1631;--field:rgba(255,255,255,.07);--fieldb:rgba(255,255,255,.22);--btn:rgba(255,255,255,.09);--sh:none;--hdr:var(--panel);--ncb:#000;--avm:62%;--avb:#000;--ff:Nunito,"Segoe UI",system-ui,sans-serif}
:root[data-theme="light"]{color-scheme:light;--bg:#fdfbff;--panel:#f6f0fb;--line:#e9dff1;--tx:#2a2238;--mut:#7a6f8c;--acc:#ec5fa3;--acc-tx:#c2347d;--on-acc:#2a1530;--me:#ffe7f3;--bad:#d13d4a;--ok:#239a55;--ns:75%;--nl:29%;--ncm:52%;--hov:#f3ecf9;--pns:#ffffff;--field:#ffffff;--fieldb:#e2d5ec;--btn:#ffffff;--sh:0 1px 2px rgba(70,40,110,.08),0 1px 0 rgba(255,255,255,.6) inset;--hdr:linear-gradient(180deg,#fefcff,#f5eefb);--ncb:#2b1840;--avm:64%;--avb:#3a2350}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#fdfbff;--panel:#f6f0fb;--line:#e9dff1;--tx:#2a2238;--mut:#7a6f8c;--acc:#ec5fa3;--acc-tx:#c2347d;--on-acc:#2a1530;--me:#ffe7f3;--bad:#d13d4a;--ok:#239a55;--ns:75%;--nl:29%;--ncm:52%;--hov:#f3ecf9;--pns:#ffffff;--field:#ffffff;--fieldb:#e2d5ec;--btn:#ffffff;--sh:0 1px 2px rgba(70,40,110,.08),0 1px 0 rgba(255,255,255,.6) inset;--hdr:linear-gradient(180deg,#fefcff,#f5eefb);--ncb:#2b1840;--avm:64%;--avb:#3a2350}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
[hidden]{display:none!important}
body{background:var(--bg);color:var(--tx);font:14px/1.4 var(--ff);display:flex;flex-direction:column;position:relative}
.hb{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:14px;line-height:1.3;cursor:pointer;flex:none}
.hb:hover{border-color:var(--acc)}
.hb:disabled{opacity:.45;cursor:default}
#pin[aria-pressed="true"]{background:var(--acc);border-color:var(--acc)}
#pinned{margin:auto;text-align:center;color:var(--mut);padding:24px;max-width:320px}
#pinned b{display:block;color:var(--tx);font-size:16px;margin-bottom:6px}
#pinned button{margin-top:14px;background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:8px 14px;font:600 13px var(--ff);cursor:pointer}
header{background:var(--hdr,var(--panel));border-bottom:1px solid var(--line);flex:none}
.hr{display:flex;align-items:center;gap:6px;padding:7px 10px}
.hr+.hr{padding-top:0}
#dot{width:9px;height:9px;border-radius:50%;background:var(--mut);flex:none}
#dot.ok{background:var(--ok)}#dot.bad{background:var(--bad)}
header select{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;min-width:0}
#chan{flex:1;font-weight:700;font-size:13px;max-width:100%}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;flex:none}
.seg button{background:var(--bg);color:var(--mut);border:0;padding:3px 9px;font:600 12px var(--ff);cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed="true"]{background:var(--acc);color:var(--on-acc)}
.seg button:disabled{opacity:.4;cursor:default}
.hr.r2{flex-wrap:wrap;row-gap:5px}
#ctabs{display:flex;gap:2px;flex-wrap:wrap;flex-basis:100%;min-width:0}
#ctabs[hidden]{display:none}
#ctabs button[aria-pressed]{opacity:.55}
#ctabs button[aria-pressed="true"]{opacity:1;color:var(--tx);border-color:var(--line);background:var(--bg)}
#ctabs .lbl{color:var(--mut);font:600 11px var(--ff);align-self:center;margin-right:2px}
#cbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;background:var(--me);border-bottom:1px solid var(--line);font-size:12px;flex:none}
#cbar[hidden]{display:none}
:is(#dmbar,#gdbar){display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--line);background:var(--panel);font-size:13px;flex:none}
:is(#dmbar,#gdbar)[hidden]{display:none}
:is(#dmbar,#gdbar) b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(#dmbar,#gdbar) button{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:3px 9px;font:600 12px var(--ff);cursor:pointer}
:is(#dmbar,#gdbar) button:hover{border-color:var(--acc)}
:is(#dmbar,#gdbar) form{display:flex;gap:6px;flex:1;min-width:0}
:is(#dmbar,#gdbar) input{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font:inherit;font-size:13px}
:is(#dmbar,#gdbar) input:focus{outline:none;border-color:var(--acc)}
#log li.conv{display:flex;gap:10px;align-items:center;padding:7px 8px;cursor:pointer;border:1px solid transparent}
#log li.conv:hover,#log li.conv:focus-visible{border-color:var(--line);background:var(--hov);outline:none}
#log li.conv .cv{flex:1;min-width:0}
#log li.conv .cv b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#log li.conv .cv span{display:block;color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#log li.conv .ct{color:var(--mut);font-size:11px;font-variant-numeric:tabular-nums;flex:none}
#log li.conv .cu{flex:none;min-width:18px;padding:0 5px;border-radius:9px;background:var(--acc);color:var(--on-acc);font:700 11px/18px var(--ff);text-align:center}
#log.pm{display:flex;flex-direction:column;gap:3px;padding:8px 10px 12px}
#log.pm li+li{margin-top:0}
#log li.sec{font:700 11px var(--ff);letter-spacing:.06em;text-transform:uppercase;color:var(--mut);padding:10px 4px 2px}
#log .av,:is(#dmbar,#gdbar) .av{background:color-mix(in oklch,var(--avc,#8a7a60) var(--avm,62%),var(--avb,#000))}
#log .av.cl,:is(#dmbar,#gdbar) .av.cl{background:color-mix(in srgb,var(--avc) 22%,var(--panel));box-shadow:inset 0 0 0 2px color-mix(in oklch,var(--avc) var(--ncm,100%),var(--ncb,#000));font-weight:400}
#log li.conv .av{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font:700 14px var(--ff);color:#fff;position:relative}
#log li.conv .av .on{position:absolute;right:-2px;bottom:-2px;width:11px;height:11px;border-radius:50%;background:var(--ok);border:2px solid var(--bg)}
#log li.conv .cv span.st{color:var(--ok)}
#log li.conv .acts{display:flex;gap:4px;flex:none}
#log li.conv .cv b small.lg{font-weight:400;color:var(--mut);font-size:11px}
#log li.conv .acts button,:is(#dmbar,#gdbar) .acts button,#log li.pmmore button,#log li.pm0 button{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font:600 12px var(--ff);cursor:pointer}
#log li.conv .acts button:hover,:is(#dmbar,#gdbar) .acts button:hover,#log li.pmmore button:hover{border-color:var(--acc)}
#log li.conv .acts button.ok{background:var(--acc);color:var(--on-acc);border-color:var(--acc)}
#log li.day{align-self:center;color:var(--mut);font-size:11px;padding:8px 0 2px}
#log li.b{max-width:82%;padding:6px 10px 4px;border-radius:14px 14px 14px 4px;background:var(--panel);border:1px solid var(--line);align-self:flex-start;line-height:1.38;overflow-wrap:anywhere}
#log li.b.me{align-self:flex-end;background:var(--me);border-color:transparent;border-radius:14px 14px 4px 14px}
#log li.b.cont{border-top-left-radius:6px}#log li.b.me.cont{border-top-left-radius:14px;border-top-right-radius:6px}
#log li.b .bt{float:right;margin:6px 0 -2px 10px;color:var(--mut);font-size:10px;font-variant-numeric:tabular-nums}
#log li.b.fail{opacity:.6}
#log li.pmmore{align-self:center;padding:2px 0 6px}
#log li.pm0{align-self:center;color:var(--mut);text-align:center;padding:26px 12px;font-size:13px;max-width:330px}
#log li.pm0 b{display:block;color:var(--tx);font-size:14px;margin-bottom:4px}
#log li.pm0 button{margin-top:10px}
:is(#dmbar,#gdbar) .who{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
:is(#dmbar,#gdbar) .who .av{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font:700 13px var(--ff);color:#fff}
:is(#dmbar,#gdbar) .who b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(#dmbar,#gdbar) .who small{display:block;color:var(--mut);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:is(#dmbar,#gdbar) .who small.on{color:var(--ok)}
:is(#dmbar,#gdbar) .acts{display:flex;gap:4px;flex:none}
:is(#dmbar,#gdbar) .acts button.sure{background:var(--bad);color:#fff;border-color:var(--bad)}
:is(#dmbar,#gdbar) .rep{display:flex;flex-direction:column;gap:6px;width:100%}
:is(#dmbar,#gdbar) .rep p{margin:0;color:var(--mut);font-size:12px}
:is(#dmbar,#gdbar) .rep div{display:flex;gap:6px}
:is(#dmbar,#gdbar) .bell[aria-pressed="true"]{border-color:var(--acc);background:var(--panel)}
@media (max-width:400px){#room button:not([aria-pressed="true"]) .rl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
@media (max-width:520px){#room.many button:not([aria-pressed="true"]) .rl{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
#room .rb{display:inline-block;min-width:16px;padding:0 4px;margin-left:4px;border-radius:8px;background:var(--bad);color:#fff;font-size:10px;line-height:15px;text-align:center}
#room button[aria-pressed="true"] .rb{background:var(--on-acc);color:var(--acc)}
#room .rb[hidden],#log li.conv .cu[hidden]{display:none}
#log li.strip{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 8px;scrollbar-width:thin}
#log .fchip{display:flex;flex-direction:column;align-items:center;gap:3px;width:58px;flex:none;background:none;border:1px solid transparent;border-radius:10px;padding:4px 2px;cursor:pointer;color:var(--tx);font:11px/1.2 var(--ff)}
#log .fchip:hover,#log .fchip:focus-visible{border-color:var(--line);background:var(--hov);outline:none}
#log .fchip .av{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font:700 16px var(--ff);color:#fff;position:relative}
#log .fchip .av .on{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;background:var(--ok);border:2px solid var(--bg)}
#log .fchip .av .cu{position:absolute;right:-6px;top:-4px;min-width:17px;padding:0 4px;border-radius:9px;background:var(--bad);color:#fff;font:700 10px/16px var(--ff)}
#log .fchip span.nm{max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#log .fchip.off{opacity:.55}
#log li.filt{display:flex;gap:4px;flex-wrap:wrap;padding:2px 0 2px}
#log li.filt button{background:none;color:var(--mut);border:1px solid transparent;border-radius:6px;padding:2px 9px;font:600 12px var(--ff);cursor:pointer}
#log li.filt button[aria-pressed="true"]{color:var(--acc-tx);border-color:var(--line);background:var(--panel)}
#log li.sec .gift{float:right;all:unset;float:right;cursor:pointer;color:var(--acc-tx);font:600 11px var(--ff);text-transform:none;letter-spacing:0}
#log li.sec{overflow:hidden}
.coin{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px;cursor:pointer;line-height:1.4}
.coin[aria-disabled="true"]{opacity:.4;cursor:default;filter:grayscale(1)}
#log .frm,#log li.conv .cv b .frm{display:inline;font-size:11px;margin-left:2px;opacity:.8;color:inherit}
:is(#dmbar,#gdbar) .go{background:var(--acc);color:var(--on-acc);border:0;border-radius:6px;padding:2px 8px;font:600 11px var(--ff);cursor:pointer;margin-left:6px}
#sp{position:fixed;inset:0;z-index:55;background:var(--bg);display:flex;flex-direction:column}
:is(#sp,#bmp) .sp-h{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--panel);border-bottom:1px solid var(--line);flex:none}
:is(#sp,#bmp) .sp-h b{flex:1;font-size:14px}
#sp .sp-b{flex:1;overflow-y:auto;padding:4px 12px 20px}
#sp section{padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:7px}
#sp section:last-child{border-bottom:0}
#sp h4{margin:0;font:700 11px var(--ff);letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
#sp h4 small,#sp .ta small{font-weight:400;text-transform:none;letter-spacing:0;color:var(--mut);font-size:11px}
#sp .lbl{font-size:12px;color:var(--mut)}
#sp .sws{display:flex;gap:6px;flex-wrap:wrap}
#sp .sw{display:flex;align-items:center;gap:6px;background:var(--btn,var(--panel));box-shadow:var(--sh);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:4px 9px 4px 5px;font:600 12px var(--ff);cursor:pointer}
#sp .sw i{width:18px;height:18px;border-radius:5px;border:3px solid}
#sp .sw.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
#sp .dot{width:26px;height:26px;border-radius:50%;border:2px solid var(--line);cursor:pointer;display:grid;place-items:center;font-size:13px;padding:0}
#sp .dot.on{box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--tx)}
#sp .dot.pick{background:var(--panel);position:relative;overflow:hidden}
#sp .dot.pick input{position:absolute;inset:0;opacity:0;cursor:pointer}
#sp .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#sp .bgp{width:56px;height:34px;border-radius:6px;background:center/cover;border:1px solid var(--line)}
#sp .fl{cursor:pointer}
#sp label.rng,#sp label.sel{display:flex;align-items:center;gap:8px;font-size:13px}
#sp label.rng input{flex:1;-webkit-appearance:none;appearance:none;height:6px;border-radius:99px;margin:8px 0;cursor:pointer;background:linear-gradient(var(--acc),var(--acc)) 0 0/var(--p,50%) 100% no-repeat,color-mix(in srgb,var(--tx) 14%,transparent)}
#sp label.rng input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:2px solid var(--acc);box-shadow:0 1px 3px rgba(40,20,60,.3)}
#sp label.rng input::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid var(--acc);box-shadow:0 1px 3px rgba(40,20,60,.3)}
#sp label.rng input:focus-visible{outline:2px solid color-mix(in srgb,var(--acc) 50%,transparent);outline-offset:4px}
#sp label.rng output{min-width:42px;text-align:right;color:var(--mut);font-variant-numeric:tabular-nums;font-size:12px}
#sp select,#sp textarea,#sp #czio{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:5px 7px;font:inherit;font-size:13px}
#sp textarea{width:100%;resize:vertical}
#sp textarea[data-ta="css"],#sp #czio{font-family:Consolas,"DejaVu Sans Mono",monospace;font-size:12px}
#sp label.ta{display:flex;flex-direction:column;gap:3px;font-size:13px}
#sp label.ck{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
#sp label.ck input{accent-color:var(--acc);width:16px;height:16px;flex:none}
#sp .hlr{display:flex;align-items:center;justify-content:space-between;gap:8px}
#sp .hlr .dot.pick{flex:none;font-size:0}
#sp .seg2{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;align-self:flex-start}
#sp .seg2 button{background:var(--panel);color:var(--mut);border:0;padding:4px 11px;font:600 12px var(--ff);cursor:pointer}
#sp .seg2 button+button{border-left:1px solid var(--line)}
#sp .seg2 button[aria-pressed="true"]{background:var(--acc);color:var(--on-acc)}
#sp .danger.sure{background:var(--bad);color:#fff;border-color:var(--bad)}
#sp .note{margin:0;font-size:12px;color:var(--ok)}
#sp section>.pbtn{align-self:flex-start}
#sp #pvlog{flex:none;overflow:visible;padding:6px 8px;border:1px solid var(--line);border-radius:8px;margin:0;list-style:none}
#sp button:focus-visible,#sp input:focus-visible,#sp select:focus-visible,#sp textarea:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
#czb[aria-pressed="true"]{border-color:var(--acc)}
#pmtoast{position:fixed;left:8px;right:8px;top:8px;z-index:60;display:flex;gap:8px;align-items:center;background:var(--panel);color:var(--tx);border:1px solid var(--acc);border-radius:10px;padding:8px 8px 8px 12px;box-shadow:0 10px 28px -12px rgba(0,0,0,.6);font-size:13px;cursor:pointer}
#pmtoast[hidden]{display:none}
#pmtoast span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#pmtoast button{background:var(--acc);color:var(--on-acc);border:0;border-radius:6px;padding:4px 10px;font:600 12px var(--ff);cursor:pointer}
#pmtoast button.x{background:none;color:var(--mut);padding:2px 6px;font-size:14px}
#log .dmb{position:absolute;right:2px;top:1px;background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 6px;font:12px/18px var(--ff);cursor:pointer;opacity:0}
#log li:has(.mb) .dmb{right:34px}
#log li:hover .dmb,#log .dmb:focus-visible{opacity:1}
@media (hover:none){#log .dmb{opacity:.6}}
#cbar span{flex:1;min-width:160px;color:var(--tx)}
#cbar .go{background:var(--acc);color:var(--on-acc);border:0;border-radius:6px;padding:3px 10px;font:600 12px var(--ff);cursor:pointer}
#cbar .go:disabled{opacity:.6}
#cbar label{display:flex;gap:4px;align-items:center;color:var(--mut);cursor:pointer}
#log .src{display:inline-block;font:600 10px/15px var(--ff);padding:0 5px;margin-right:4px;border-radius:4px;border:1px solid var(--line);color:var(--mut);vertical-align:1px;letter-spacing:.02em}
#log .src.k-mine{color:var(--acc-tx);border-color:var(--acc)}
#log .src.k-tr{color:var(--ok);border-color:var(--ok)}
#log .src.k-dm{color:var(--bad);border-color:var(--bad)}
#tgt{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:0 4px;font:600 12px var(--ff);max-width:92px}
#tgt[hidden]{display:none}
#ctabs button{background:none;color:var(--mut);border:1px solid transparent;border-radius:6px;padding:2px 7px;font:600 12px var(--ff);cursor:pointer;white-space:nowrap}
#ctabs button[aria-selected="true"]{color:var(--acc-tx);border-color:var(--line);background:var(--bg)}
#ctabs b{display:inline-block;min-width:16px;padding:0 4px;margin-left:3px;border-radius:8px;background:var(--acc);color:var(--on-acc);font-size:10px;line-height:15px;text-align:center}
#log{flex:1;overflow-y:auto;list-style:none;margin:0;padding:6px 10px 10px}
#log li{padding:3px 4px;border-radius:5px;overflow-wrap:anywhere}
#log li+li{margin-top:1px}
#log li.mention{background:var(--me);box-shadow:inset 3px 0 0 var(--acc)}
#log li.ev{color:var(--mut)}
#log li.sys{color:var(--mut);font-style:italic;text-align:center;font-size:12px}
#log .t{color:var(--mut);font-size:11px;margin-right:5px;font-variant-numeric:tabular-nums}
#log .n{font-weight:700;cursor:pointer}
#log .n:hover{text-decoration:underline}
#log .to{color:var(--mut);font-size:12px}
#log .aw{font-size:11px;margin-left:2px;color:var(--acc-tx)}
#log .at{color:var(--acc-tx);font-weight:600}
#empty{color:var(--mut);text-align:center;padding:30px 14px;margin:0}
#gate{margin:auto;max-width:330px;text-align:center;padding:20px 16px;color:var(--mut);font-size:13px}
#gate b{display:block;color:var(--tx);font-size:15px;margin-bottom:6px}
#gate .go{margin:14px 0 10px;background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:8px 16px;font:600 13px var(--ff);cursor:pointer}
#gate .go:disabled{opacity:.6;cursor:default}
#gate label{display:flex;gap:6px;justify-content:center;align-items:center;font-size:12px;cursor:pointer}
#more{position:absolute;left:50%;transform:translateX(-50%);bottom:64px;background:var(--acc);color:var(--on-acc);border:0;border-radius:14px;padding:4px 12px;font:600 12px var(--ff);cursor:pointer;display:none}
footer{flex:none;border-top:1px solid var(--line);background:var(--hdr,var(--panel));padding:8px 10px}
#err{color:var(--bad);font-size:12px;margin:0 0 6px}#err:empty{display:none}
#okm{color:var(--ok);font-size:12px;margin:0 0 6px}#okm:empty{display:none}
#log li{position:relative}
#log .mb{position:absolute;right:2px;top:1px;background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 6px;font:700 12px/18px var(--ff);cursor:pointer;opacity:0}
#log li:hover .mb,#log .mb:focus-visible,#log .mb[aria-expanded="true"]{opacity:1}
@media (hover:none){#log .mb{opacity:.6}}
#log .pgo{float:right;margin-left:6px;background:var(--panel);color:var(--acc-tx);border:1px solid var(--line);border-radius:5px;padding:0 7px;font:700 12px/18px var(--ff);cursor:pointer}
#log .pgo:hover,#log .pgo:focus-visible{border-color:var(--acc);outline:none}
#ctabs .pgc{margin-left:auto;opacity:1;color:var(--bad)}
#ctabs .town{margin-left:auto;opacity:1;color:var(--acc-tx);border-color:color-mix(in srgb,var(--acc) 45%,transparent)}
.mm [data-tid]{text-align:left}
.mm.tm{width:min(300px,calc(100vw - 16px))}
.mm.tm .mh small,.mm.tm small{white-space:normal;overflow:visible;text-overflow:clip}
#log li:has(.pgo) .dmb,#log li:has(.pgo) .mb{right:36px}
.mm{position:fixed;z-index:50;min-width:210px;max-width:min(300px,calc(100vw - 16px));background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:10px;padding:6px;box-shadow:0 10px 28px -10px rgba(0,0,0,.6);display:flex;flex-direction:column;gap:4px;font:13px/1.35 var(--ff),sans-serif}
.mm .mh{font-weight:700;padding:2px 6px 4px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mm .mh small{display:block;font-weight:400;color:var(--mut);font-size:11px}
.mm button{background:none;border:1px solid transparent;border-radius:6px;color:var(--tx);text-align:left;padding:4px 8px;font:inherit;cursor:pointer}
.mm button:hover,.mm button:focus-visible{border-color:var(--line);background:var(--hov);outline:none}
.mm .row{display:flex;flex-wrap:wrap;gap:3px;align-items:center;padding:0 2px}
.mm .row>span{color:var(--mut);font-size:12px;margin-right:2px}
.mm .row button{padding:2px 7px;border-color:var(--line);font-size:12px}
.mm .row input{width:58px;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:2px 5px;font:inherit;font-size:12px}
.mm .danger{color:var(--bad)}
.mm button:disabled{opacity:.6;cursor:default}
.mm .danger.sure{background:var(--bad);color:#fff;border-color:var(--bad)}
#mp{display:none;flex-direction:column;gap:8px;max-height:min(340px,50vh);overflow-y:auto;margin:0 0 8px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px}
#mp.on{display:flex}
#mp h4{margin:0;font:700 12px var(--ff);color:var(--mut);letter-spacing:.03em}
#mp ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
#mp li{display:flex;gap:6px;align-items:center;font-size:13px;padding:2px 4px;border-radius:6px}
#mp li:hover{background:var(--hov)}
#mp li b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mp li span{flex:1;color:var(--mut);font-size:12px;min-width:0}
#mp li button,#mp form button{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:600 12px var(--ff);cursor:pointer}
#mp form{display:flex;gap:6px;flex-wrap:wrap}
#mp form input,#mp form select{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:4px 6px;font:inherit;font-size:13px;min-width:0}
#mp form input{flex:1;min-width:110px}
#mp form button.sure{background:var(--bad);color:#fff;border-color:var(--bad)}
#mp .help{color:var(--mut);font-size:11px}
#mp .seg{align-self:flex-start}
#mp p{margin:0;color:var(--mut);font-size:12px}
#modb[hidden]{display:none}
form{display:flex;gap:6px;margin:0}
#in::placeholder{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#in{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;line-height:1.4;resize:none;overflow-y:hidden;display:block;height:38px;max-height:calc(6 * 1.4em + 18px)}
#f{align-items:flex-end}#f>button,#f>select{min-height:38px;align-self:flex-end}
html.pinned #f>button,html.pinned #f>select{min-height:0;align-self:stretch}
#in:focus{outline:none;border-color:var(--acc)}
#in:disabled{opacity:.6}
#send{background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:0 14px;font-size:16px;cursor:pointer}
#send:disabled{opacity:.5;cursor:default}
#log img.em{height:28px;width:auto;vertical-align:middle;margin:-4px 1px}
#log .zw{display:inline-grid;vertical-align:middle}#log .zw>img{grid-area:1/1;margin:-4px 1px}
#emb,#gpb{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:0 9px;font-size:17px;cursor:pointer}
#emb[aria-expanded="true"]{border-color:var(--acc)}
#ep{display:none;flex-direction:column;gap:6px;height:min(320px,45vh);margin:0 0 8px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px}
#ep.on{display:flex}
#ep-top{display:flex;gap:6px;align-items:center}
#eq{flex:1;min-width:0;background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
#eq:focus{outline:none;border-color:var(--acc)}
#etabs{display:flex;gap:4px;flex-wrap:wrap}
#etabs button{background:none;color:var(--mut);border:1px solid transparent;border-radius:6px;padding:2px 7px;font:600 12px var(--ff);cursor:pointer}
#etabs button[aria-selected="true"]{color:var(--acc-tx);border-color:var(--line);background:var(--panel)}
#eg{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(44px,1fr));gap:2px;align-content:start}
#eg button{background:none;border:1px solid transparent;border-radius:6px;height:44px;padding:3px;cursor:pointer;display:flex;align-items:center;justify-content:center}
#eg button:hover,#eg button:focus-visible{border-color:var(--acc);background:var(--hov);outline:none}
#eg img{max-height:34px;max-width:100%}
#eg p{grid-column:1/-1;color:var(--mut);text-align:center;font-size:12px;margin:20px 0}
#eh{color:var(--mut);font-size:11px;min-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pb{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:0 8px;font-size:15px;cursor:pointer}
#pb[aria-expanded="true"]{border-color:var(--acc)}
#emb:disabled,#pb:disabled{opacity:.5;cursor:default}
#pp{display:none;flex-direction:column;gap:6px;height:min(320px,45vh);margin:0 0 8px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px}
#pp.on{display:flex}
.pp-top{display:flex;gap:6px}
#pq{flex:1;min-width:0;background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
#pq:focus,#pp input:focus,#pp textarea:focus{outline:none;border-color:var(--acc)}
.pbtn{background:var(--acc);color:var(--on-acc);border:0;border-radius:6px;padding:4px 10px;font:600 12px var(--ff);cursor:pointer;white-space:nowrap}
.pbtn.alt{background:var(--panel);color:var(--tx);border:1px solid var(--line)}
#pl{flex:1;overflow-y:auto;list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
#pl li{display:flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:7px;padding:2px 2px 2px 0}
#pl li:hover,#pl li:focus-within{border-color:var(--line);background:var(--hov)}
#pl .pi{flex:1;min-width:0;text-align:left;background:none;border:0;color:var(--tx);padding:4px 6px;cursor:pointer;font:inherit}
#pl .pi b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pl .pi span{display:block;color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pl .px{background:none;border:1px solid transparent;border-radius:6px;color:var(--mut);padding:2px 6px;cursor:pointer;font-size:13px;flex:none}
#pl .px:hover{border-color:var(--line);color:var(--tx)}
#pl .px.sure{background:var(--bad);color:#fff;border-color:var(--bad);font:600 11px var(--ff)}
#pl p{color:var(--mut);text-align:center;font-size:12px;margin:18px 8px}
#pe{display:none;flex-direction:column;gap:6px;flex:1;min-height:0}
#pp.edit #pe{display:flex}#pp.edit .pp-top,#pp.edit #pl{display:none}
#pe input,#pe textarea{background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px}
#pe textarea{flex:1;min-height:60px;resize:none}
.pe-b{display:flex;gap:6px;align-items:center}
.pe-b small{flex:1;color:var(--mut);font-size:11px}
.pe-b small.over{color:var(--bad)}
html.pinned #pp{height:min(260px,55vh);padding:6px;margin-bottom:6px}
html.pinned #pb{padding:0 6px;font-size:14px}
/* ---- закреплённое окно (поверх всех): компактный вид ---- */
.po{display:none}
html.pinned .po{display:inline-flex}
html.pinned{--fs:13px}
html.pinned body{font-size:var(--fs);box-shadow:inset 0 3px 0 var(--acc)}
html.pinned .hr{padding:5px 6px 4px 8px;gap:4px}
html.pinned .hr+.hr{padding-top:0}
html.pinned header select{font-size:11px;padding:1px 3px}
html.pinned #chan{font-size:12px}
html.pinned .seg button{padding:1px 6px;font-size:11px}
html.pinned #ctabs button{padding:1px 5px;font-size:11px}
html.pinned #cbar{padding:4px 6px;font-size:11px}
html.pinned #tgt{font-size:11px;max-width:78px}
html.pinned .hb{padding:0 5px;font-size:12px;border-color:transparent;background:none}
html.pinned .hb:hover,html.pinned .hb[aria-pressed="true"]{border-color:var(--line);background:var(--panel)}
html.pinned #pin[aria-pressed="true"]{background:var(--acc);border-color:var(--acc)}
html.pinned #log{padding:2px 6px 6px}
html.pinned #log li{padding:1px 4px;line-height:1.35}
html.pinned #log li:hover{background:var(--hov)}
html.pinned #log li.mention:hover{background:var(--me)}
html.pinned #log .t{font-size:.78em}
html.pinned.not #log .t{display:none}
html.pinned.noi #log li>span[title]:not(.aw):not(.n):not(.to):not(.src){display:none}
html.pinned #log img.em{height:calc(var(--fs) * 2);margin:-3px 1px}
html.pinned footer{padding:5px 6px}
html.pinned #in{padding:5px 8px;font-size:var(--fs)}
html.pinned #emb{padding:0 6px;font-size:15px}
html.pinned #send{padding:0 10px;font-size:14px}
html.pinned #ep{height:min(260px,55vh);padding:6px;margin-bottom:6px}
html.pinned #eg{grid-template-columns:repeat(auto-fill,minmax(38px,1fr))}
html.pinned #eg button{height:38px}
html.pinned #more{bottom:52px}
/* «только лента»: поле ввода выезжает при наведении или фокусе */
html.pinned.mini footer{position:absolute;left:0;right:0;bottom:0;z-index:2;transform:translateY(calc(100% - 4px));transition:transform .15s ease,opacity .15s ease;opacity:0;border-top:4px solid var(--acc)}
html.pinned.mini body:hover footer,html.pinned.mini footer:focus-within{transform:none;opacity:1}
html.pinned.mini #more{bottom:12px}
html.pinned.mini #log{padding-bottom:12px}
@media (prefers-reduced-motion: reduce){html.pinned.mini footer{transition:none}}

#fbar{display:flex;gap:6px;align-items:center;padding:6px 10px;background:var(--panel);border-bottom:1px solid var(--line);flex:none}
#fq{flex:1;min-width:0;background:color-mix(in srgb,var(--tx) 7%,transparent);color:var(--tx);border:1px solid var(--acc);border-radius:10px;padding:5px 9px;font:inherit;font-size:13px;outline:none}
#fn{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums;min-width:44px;text-align:center;flex:none}
#fn.none{color:var(--bad)}
#fbar .hb[data-f="only"]{font-size:12px}
#fbar .hb[aria-pressed="true"]{background:var(--acc);color:var(--on-acc)}
@media (max-width:400px){#fbar .hb[data-f="only"]{display:none}}
#log mark.fm{background:color-mix(in srgb,var(--acc) 38%,transparent);color:inherit;border-radius:3px;padding:0 1px}
#log mark.fm.cur{background:var(--acc);color:var(--on-acc);box-shadow:0 0 0 2px var(--acc)}
#log.fonly>li:not(.fhit){display:none}
#chan option{background-color:var(--pns,#1b1631);color:var(--tx)}
#chan option.off{color:var(--mut)}
#chan option.live{font-weight:700}
#livebadge{flex:none;background:#e5484d;color:#fff;border-radius:999px;padding:2px 8px;font:800 10px/16px var(--ff);letter-spacing:.04em;text-decoration:none;white-space:nowrap;animation:lgLive 2s ease-in-out infinite}
#livebadge:hover{filter:brightness(1.1)}
@keyframes lgLive{50%{opacity:.75}}
@media (prefers-reduced-motion:reduce){#livebadge{animation:none}}
/* ответ с цитатой, подсказки ников, «пока тебя не было», избранные стикеры */
#rq{display:flex;gap:8px;align-items:center;margin:0 0 6px;padding:4px 4px 4px 8px;border-radius:8px;background:color-mix(in srgb,var(--tx) 5%,transparent);font-size:12px;color:var(--mut)}
#rq .rb{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#rq button{flex:none;width:22px;height:22px;border:0;border-radius:6px;background:none;color:var(--mut);cursor:pointer;font-size:12px}
#rq button:hover{color:var(--tx);background:color-mix(in srgb,var(--tx) 8%,transparent)}
.rqi{width:13px;height:13px;vertical-align:-2px;margin-right:5px;flex:none}
#ac{list-style:none;margin:0 0 6px;padding:4px;background:var(--pns,var(--panel));border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;gap:1px;max-height:200px;overflow-y:auto}
#ac li{display:flex;gap:8px;align-items:center;padding:4px 8px;border-radius:7px;cursor:pointer;font-size:13px}
#ac li[aria-selected="true"],#ac li:hover{background:var(--hov)}
#ac li small{color:var(--mut);margin-left:auto;font-size:11px}
#ac .av{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font:700 10px var(--ff);color:#fff;flex:none}
#log .rq{display:block;margin:0 0 1px;color:var(--mut);font-size:.84em;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
#log .rq:hover,#log .rq:focus-visible{color:var(--tx);outline:none}
#log .rq.me{color:var(--acc-tx)}
#log .rpb{position:absolute;top:1px;background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 6px;font:12px/18px var(--ff);cursor:pointer;opacity:0}
#log li:hover .rpb,#log .rpb:focus-visible{opacity:1}
@media (hover:none){#log .rpb{opacity:.6}}
#log li.flash{animation:lgFlash 1.6s ease-out}
@keyframes lgFlash{0%,40%{background:color-mix(in srgb,var(--acc) 30%,transparent)}}
#away{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:6px 10px;background:color-mix(in srgb,var(--acc) 14%,var(--panel));border-bottom:1px solid var(--line);font-size:12px;flex:none}
#away span{flex:1;min-width:0}
#away button{background:var(--acc);color:var(--on-acc);border:0;border-radius:999px;padding:2px 10px;font:700 12px var(--ff);cursor:pointer}
#away button.x{background:none;color:var(--mut);padding:0 4px}
#eg button.fav{position:relative}#eg button.fav::after{content:"★";position:absolute;right:1px;top:-2px;font-size:10px;color:var(--acc)}
#sp .keys{display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px;margin:0}
#sp .keys dt{font-family:ui-monospace,monospace;color:var(--acc-tx)}#sp .keys dd{margin:0;color:var(--mut)}
#sp .ign{display:flex;flex-direction:column;gap:4px}#sp .ign div{display:flex;align-items:center;gap:8px;font-size:13px}#sp .ign div span{flex:1}
#log .extm,:is(#dmbar,#gdbar) .extm{font-size:.78em;margin-left:3px;opacity:.85;cursor:default}
#log .at[data-at]{cursor:pointer;border-radius:3px}
#log .at[data-at]:hover,#log .at[data-at]:focus-visible{text-decoration:underline;outline:none}
#log li.uhl{background:color-mix(in srgb,var(--acc) 13%,transparent);box-shadow:inset 3px 0 0 color-mix(in srgb,var(--acc) 70%,transparent)}
#log li.uhl1{background:color-mix(in srgb,var(--acc) 22%,transparent);box-shadow:inset 3px 0 0 var(--acc)}
#log .cpb{position:absolute;top:1px;background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 6px;font:12px/18px var(--ff);cursor:pointer;opacity:0}
#log li:hover .cpb,#log .cpb:focus-visible{opacity:1}
#log .cpb.ok{color:var(--ok);border-color:var(--ok);opacity:1}
@media (hover:none){#log .cpb{opacity:.6}}
#log li.b{position:relative}
#log li.b .cpb{top:-9px;right:-6px;padding:0 5px;font-size:11px;line-height:16px;border-radius:6px}
#log li.b.me .cpb{right:auto;left:-6px}
#log .bmb{position:absolute;top:1px;background:var(--panel);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 6px;font:12px/18px var(--ff);cursor:pointer;opacity:0}
#log li:hover .bmb,#log .bmb:focus-visible,#log .bmb.on{opacity:1}
#log .bmb.on{color:#f5b400;border-color:color-mix(in srgb,#f5b400 50%,var(--line))}
#log li.bmk{box-shadow:inset -3px 0 0 #f5b400}
#onlyb{display:flex;gap:8px;align-items:center;padding:6px 10px;background:color-mix(in srgb,var(--acc) 12%,var(--panel));border-bottom:1px solid var(--line);font-size:12px;flex:none}
#onlyb span{flex:1;min-width:0}
#onlyb button{background:var(--acc);color:var(--on-acc);border:0;border-radius:999px;padding:2px 10px;font:700 12px var(--ff);cursor:pointer}
#bmp{position:fixed;inset:0;z-index:55;background:var(--bg);display:flex;flex-direction:column}
#bmp .bm-b{flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}
#bmp .bmq{background:var(--field);color:var(--tx);border:1px solid var(--fieldb);border-radius:10px;padding:6px 10px;font:inherit;font-size:13px}
#bmp .bml{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
#bmp .bml li{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:4px}
#bmp .bmh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}#bmp .bmh small{color:var(--mut);font-size:11px}
#bmp .bmt{overflow-wrap:anywhere;line-height:1.4}
#bmp .bma{display:flex;gap:6px}
#bmp .bma button{background:var(--btn,var(--panel));color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:2px 9px;font:600 12px var(--ff);cursor:pointer}
#bmp .bma button:hover{border-color:var(--acc)}
#bmp .bm0{color:var(--mut);text-align:center;margin:24px 8px}
#bmk[aria-pressed="true"]{background:var(--acc);color:var(--on-acc)}
.mm.nke{width:min(280px,calc(100vw - 16px));gap:8px}
.mm.nke .nka{background:var(--field,var(--bg));color:var(--tx);border:1px solid var(--fieldb,var(--line));border-radius:8px;padding:6px 8px;font:inherit;font-size:13px}
.mm.nke .nkc{display:flex;flex-wrap:wrap;gap:5px}
.mm.nke .dot{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer;padding:0;position:relative;overflow:hidden}
.mm.nke .dot[aria-pressed="true"]{border-color:var(--tx)}
.mm.nke .dot.pick input{position:absolute;inset:0;opacity:0;cursor:pointer}
.mm.nke .nkp{font-size:12px;color:var(--mut)}.mm.nke .nkp b{font-size:14px}
.mm.nke .nkb{display:flex;gap:6px;flex-wrap:wrap}
.mm.nke .nkb button{flex:1;background:var(--btn,var(--panel));color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:4px 8px;font:600 12px var(--ff);cursor:pointer}
.mm.nke .nkb button.ok{background:var(--acc);color:var(--on-acc);border-color:var(--acc)}
#sp .ign div small{margin-right:auto}
/* облик как в чате игры: вкладки-«пилюли», полупрозрачные кнопки, поля со скруглением 10px */
.hb{background:var(--btn);border-color:transparent;border-radius:8px;box-shadow:var(--sh)}
.hb:hover,.hb:focus-visible{border-color:var(--acc);outline:none}
header select{background:var(--field);border-color:var(--fieldb);border-radius:8px;box-shadow:var(--sh)}
#chan{font-family:Comfortaa,var(--ff);font-weight:700}
.seg{border:0;gap:3px;border-radius:999px;overflow:visible}
.seg button{background:transparent;border-radius:999px;padding:3px 10px;font-weight:700}
.seg button+button{border-left:0}
.seg button:not([aria-pressed="true"]):not(:disabled):hover{background:color-mix(in srgb,var(--tx) 9%,transparent);color:var(--tx)}
#ctabs button{border-radius:999px}
#ctabs button[aria-pressed="true"],#ctabs button[aria-selected="true"]{background:var(--acc);color:var(--on-acc);border-color:var(--acc)}
#in,:is(#dmbar,#gdbar) input,#fq{background:var(--field);border-color:var(--fieldb);border-radius:10px;box-shadow:var(--sh)}
#pb,#emb,#gpb,:is(#dmbar,#gdbar) button,#log li.conv .acts button,#log li.pmmore button{background:var(--btn);box-shadow:var(--sh)}
#send,#pb,#emb,#gpb{border-radius:10px}
:is(#dmbar,#gdbar) button,#log li.conv .acts button,#log li.pmmore button,#log li.pm0 button{border-radius:8px}
#log li.sec{font-family:Comfortaa,var(--ff)}
#room button[hidden]{display:none}
#rail{position:fixed;top:0;bottom:0;left:0;width:64px;z-index:4;box-sizing:border-box;background:var(--hdr,var(--panel));border-right:1px solid var(--line);display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;padding:6px 0 10px}
#rail::-webkit-scrollbar{display:none}
/* нижняя строка как в Telegram: одна плоская полоса, значки без рамок, стрелка — только когда есть текст */
footer{padding:2px 6px}
#f{display:flex;align-items:flex-end;gap:0}
#f>#pb{order:1}#f>#gpb{order:2}#f>#tgt{order:3}#f>#in{order:4}#f>#emb{order:5}#f>#send{order:6}
#f>#pb,#f>#emb,#f>#gpb,#f>#send{flex:none;width:40px;min-height:42px;height:42px;padding:0;border:0!important;border-radius:10px;background:none!important;box-shadow:none!important;color:var(--mut);display:grid;place-items:center;cursor:pointer;transition:color .12s}
#f>#pb:hover:not(:disabled),#f>#emb:hover:not(:disabled),#f>#gpb:hover:not(:disabled),#f>#pb[aria-expanded="true"],#f>#emb[aria-expanded="true"],#f>#gpb[aria-pressed="true"]{color:var(--acc-tx)}
#f>#pb:disabled,#f>#emb:disabled,#f>#gpb:disabled{opacity:.35;cursor:default}
#f>#gpb[hidden]{display:none}
#f>#send{color:var(--acc)}#f>#send:hover:not(:disabled){color:var(--acc-tx);background:color-mix(in srgb,var(--acc) 12%,transparent)!important}
#f>#in:placeholder-shown~#send{display:none}
#f>#in{background:transparent!important;border:0!important;box-shadow:none!important;border-radius:0;padding:11px 8px;min-height:42px;height:42px;max-height:calc(6 * 1.4em + 22px)}
#f>#in:focus{outline:none}
#f>#in::placeholder{color:color-mix(in srgb,var(--mut) 85%,transparent)}
#f>#tgt{align-self:center;margin:0 2px;background:color-mix(in srgb,var(--tx) 6%,transparent)!important;border:0!important;box-shadow:none!important;border-radius:999px;min-height:26px;height:26px;padding:0 8px;font-size:11.5px}
html.pinned #f>#in{padding:8px 6px;min-height:36px;height:36px}
html.pinned #f>#pb,html.pinned #f>#emb,html.pinned #f>#gpb,html.pinned #f>#send{width:34px;min-height:36px;height:36px}
#dctl{display:flex;align-items:center;gap:2px;flex:none}
#dctl button{border:0;background:none;color:var(--mut);border-radius:6px;padding:0 4px;font:14px/24px system-ui,sans-serif;cursor:pointer}
#dctl button:hover{color:var(--tx);background:color-mix(in srgb,var(--tx) 8%,transparent)}
#dctl button[aria-pressed="true"]{color:var(--acc-tx);background:color-mix(in srgb,var(--acc) 20%,transparent)}
#dctl #dgrip{cursor:grab;touch-action:none;font-size:16px;letter-spacing:-1px}
#dctl #dgrip:active{cursor:grabbing}
header .hr{touch-action:none}
#rail #dctl{flex-direction:column;margin-top:auto;padding-top:8px;gap:3px}
#rail #dctl button{width:44px;line-height:26px}
#rail #dctl #dgrip{order:-1}
#rail #dctl #dmini{order:-2;font:700 17px/26px var(--ff)}
#dctl #dmini[hidden]{display:none}
html.mini body{padding:0!important}
html.mini body>:not(#rail){display:none!important}
html.mini #rail{width:100%;border:0}
html.mini #rail #room button[aria-pressed="true"]::before{display:none}
#rail[hidden]{display:none}
html.rail body{padding-left:64px}
html.rail-r #rail{left:auto;right:0;border-right:0;border-left:1px solid var(--line)}
html.rail-r body{padding-left:0;padding-right:64px}
html.rail #rail #room{display:flex;flex-direction:column;gap:2px;border:0;border-radius:0;background:none;overflow:visible}
html.rail #rail #room button{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;margin:0 5px;padding:7px 2px 6px;border:0;border-radius:12px;background:none;color:var(--mut);font:700 10px/1.15 var(--ff)}
html.rail #rail #room button>span[aria-hidden]{font-size:19px;line-height:1}
html.rail #rail #room button .rl{position:static!important;width:auto!important;height:auto!important;clip:auto!important;overflow:visible!important;white-space:nowrap;max-width:54px;text-overflow:ellipsis}
html.rail #rail #room button:not(:disabled):hover{background:color-mix(in srgb,var(--tx) 8%,transparent);color:var(--tx)}
html.rail #rail #room button[aria-pressed="true"]{background:color-mix(in srgb,var(--acc) 20%,transparent);color:var(--acc-tx)}
html.rail #rail #room button[aria-pressed="true"]::before{content:'';position:absolute;left:-5px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--acc)}
html.rail-r #rail #room button[aria-pressed="true"]::before{left:auto;right:-5px;border-radius:3px 0 0 3px}
html.rail #rail #room .rb{position:absolute;top:1px;right:5px;margin:0;min-width:15px;padding:0 4px;font-size:10px;line-height:15px}
html.rail #rail #room button[aria-pressed="true"] .rb{background:var(--bad);color:#fff}
html.rail .hr.r2:not(:has(>:not([hidden]))){display:none}
#rchans{display:flex;flex-direction:column;align-items:center;gap:9px;margin:8px 0 0;padding-top:10px;border-top:1px solid var(--line)}
#rchans:empty{display:none}
#rchans .rpe{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;width:56px;padding:4px 0;border:0;border-radius:12px;background:none;color:var(--mut);cursor:pointer;font:600 9.5px/1.1 var(--ff)}
#rchans .rpe:hover{background:color-mix(in srgb,var(--tx) 8%,transparent);color:var(--tx)}
#rchans .rpe[aria-pressed="true"]{background:color-mix(in srgb,var(--acc) 20%,transparent);color:var(--acc-tx)}
#rchans .rpe .av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;font:700 15px var(--ff);color:#fff;background:color-mix(in oklch,var(--avc,#8a7a60) var(--avm,62%),var(--avb,#000))}
#rchans .rpe .av.cl{background:color-mix(in srgb,var(--avc) 22%,var(--panel));box-shadow:inset 0 0 0 2px color-mix(in oklch,var(--avc) var(--ncm,100%),var(--ncb,#000));font-weight:400;font-size:17px}
#rchans .rpe small{max-width:54px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#rchans .rpe .on{position:absolute;left:34px;top:30px;width:10px;height:10px;border-radius:50%;background:var(--ok);border:2px solid var(--hdr,var(--panel))}
#rchans .rpe .un{position:absolute;right:6px;top:1px;min-width:15px;padding:0 4px;border-radius:8px;background:var(--bad);color:#fff;font:700 10px/15px var(--ff);text-align:center}
#log li.gdf{align-self:stretch;padding:2px 2px 6px}
#log li.gdf form{display:flex;gap:6px}
#log li.gdf input{flex:1;min-width:0;background:var(--field);color:var(--tx);border:1px solid var(--fieldb);border-radius:8px;padding:5px 8px;font:inherit;font-size:13px}
#log li.gdf input:focus{outline:none;border-color:var(--acc)}
#log li.gdf button{background:var(--btn);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:4px 10px;font:600 12px var(--ff);cursor:pointer}
#log li.gdf button.ok{background:var(--acc);color:var(--on-acc);border-color:var(--acc)}
#log li.gdf button.sure,#log li.conv .acts button.sure{background:var(--bad);color:#fff;border-color:var(--bad)}
#log li.gdf .gdh{display:block;color:var(--mut);font-size:11px;margin-top:4px}
#log .gdn{margin:6px 0 0;color:var(--ok);font-size:12px}
#log li.b .gnm{display:block;font:700 12px var(--ff);margin-bottom:1px;cursor:pointer}
#log li.pm0.gds{padding:4px 12px;font-size:12px;max-width:none}
#log li.pm0.gdc{padding-top:14px}
#gdbar .acts button[aria-pressed="true"]{border-color:var(--acc)}
#log li.gdf .gdl{display:flex;gap:6px;flex-wrap:wrap}
#log li.conv.gdlk{cursor:default}
#log li.b{position:relative}
#log li.b .gdact{position:absolute;bottom:calc(100% - 4px);left:8px;z-index:3;display:flex;gap:2px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:0 4px 12px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .1s;white-space:nowrap}
#log li.b.me .gdact{left:auto;right:8px}
#log li.b:hover .gdact,#log li.b .gdact:focus-within{pointer-events:auto}
#log li.b.hot .gdact{opacity:1;pointer-events:auto}
#log li.b:hover .gdact,#log li.b .gdact:focus-within{opacity:1}
@media (hover:none){#log li.b .gdact{opacity:.7;pointer-events:auto}}
#log li.b .gdact button{height:22px;min-width:24px;padding:0 4px;border:1px solid transparent;border-radius:6px;background:none;color:var(--mut);font:12px/20px var(--ff);cursor:pointer}
#log li.b .gdact button:hover{color:var(--tx);background:color-mix(in srgb,var(--acc) 16%,transparent)}
#log li.b .gdact button.sure{background:var(--bad);border-color:var(--bad);color:#fff}
#log .gdel{color:var(--mut);font-style:italic}
#log .ged{font-style:normal;opacity:.8}
#log .grx{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
#log .grc{border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--tx) 5%,transparent);color:var(--tx);font:600 12px/20px var(--ff);padding:0 7px;cursor:pointer}
#log .grc.on{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 18%,transparent)}
#log .grp{display:flex;gap:2px;margin-top:5px;padding:3px;border:1px solid var(--line);border-radius:999px;background:var(--panel);width:max-content}
#log .grp button{border:0;background:none;font-size:18px;line-height:24px;width:30px;border-radius:999px;cursor:pointer}
#log .grp button:hover{background:color-mix(in srgb,var(--acc) 18%,transparent)}
#log li.b.gpl{min-width:min(280px,82%)}
#log .gpoll{display:flex;flex-direction:column;gap:5px;margin-top:6px}
#log .gpo{position:relative;display:flex;align-items:center;gap:8px;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--tx) 4%,transparent);color:var(--tx);font:600 13px/1.3 var(--ff);padding:6px 10px;cursor:pointer;text-align:left}
#log .gpo:hover:not(:disabled){border-color:var(--acc)}
#log .gpo.on{border-color:var(--acc)}
#log .gpo .gpb{position:absolute;left:0;top:0;bottom:0;background:color-mix(in srgb,var(--acc) 20%,transparent);transition:width .25s}
#log .gpo .gpl{position:relative;flex:1}
#log .gpo b{position:relative;font-variant-numeric:tabular-nums}
#log .gph{color:var(--mut);font-size:11px}
#log li.gdf .gpf{flex-direction:column;align-items:stretch}
#log .gtpl{display:flex;flex-wrap:wrap;gap:5px}
#log .gtpl button,#log .gadd{border:1px solid var(--line);border-radius:999px;background:var(--btn);color:var(--tx);font:600 12px/24px var(--ff);padding:0 10px;cursor:pointer;flex:none}
#log .gtpl button[aria-pressed="true"]{background:var(--acc);color:var(--on-acc);border-color:var(--acc)}
#log .gopts{display:flex;flex-direction:column;gap:5px}
#log .gopt{display:flex;gap:5px;align-items:center}
#log .gopt button{flex:none;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:none;color:var(--mut);cursor:pointer}
#log .gopt button:hover{color:var(--tx);background:color-mix(in srgb,var(--tx) 8%,transparent)}
#log .gadd{align-self:flex-start;border-style:dashed;background:none;color:var(--mut)}
#log .gadd:hover{color:var(--tx);border-color:var(--acc)}
#log .gpo.mul .gpl::before{content:'☐ ';opacity:.7}#log .gpo.mul.on .gpl::before{content:'☑ ';opacity:1}
#gpb{flex:none;font-size:16px}
#gpb[hidden]{display:none}#gpb[aria-pressed="true"]{border-color:var(--acc)}
#log li.gdf textarea{background:var(--field);color:var(--tx);border:1px solid var(--fieldb);border-radius:8px;padding:6px 8px;font:inherit;font-size:13px;resize:vertical}
#log li.gdf textarea:focus{outline:none;border-color:var(--acc)}
#gdbar .gpin{width:100%;display:flex;gap:8px;align-items:flex-start;margin-top:4px;padding:6px 8px;border-radius:8px;background:color-mix(in srgb,var(--acc) 14%,transparent);border:1px solid color-mix(in srgb,var(--acc) 40%,transparent);font-size:13px;line-height:1.35}
#gdbar .gpin .gpt{flex:1;min-width:0;overflow-wrap:anywhere;max-height:5.4em;overflow:auto}
#gdbar .gpin button{flex:none;width:22px;height:22px;padding:0;border:0;background:none;color:var(--mut);cursor:pointer}
#log li.b .gdre{position:absolute;top:-9px;right:6px;width:24px;height:20px;padding:0;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--mut);font:12px/18px var(--ff);cursor:pointer;opacity:0}
#log li.b.me .gdre{right:auto;left:6px}
#log li.b:hover .gdre,#log li.b .gdre:focus-visible{opacity:1}#log li.b .gdre:hover{color:var(--tx);border-color:var(--acc)}
@media (hover:none){#log li.b .gdre{opacity:.6}}
#log .gdq{display:block;max-width:100%;margin:1px 0 3px;padding:2px 8px;border-left:2px solid var(--acc);border-radius:4px;background:color-mix(in srgb,var(--tx) 6%,transparent);color:var(--mut);font-size:.84em;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
#log .gdq:hover,#log .gdq:focus-visible{color:var(--tx);outline:none}
#log .gdq.me{background:color-mix(in srgb,var(--acc) 14%,transparent)}
#log .gdq .rqi{width:12px;height:12px;vertical-align:-2px;margin-right:4px}
#log li.b.tome{box-shadow:inset 3px 0 0 var(--acc)}
#log .grl{display:inline-block;font:700 10px var(--ff);padding:0 6px;margin-left:6px;border-radius:999px;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--acc-tx);vertical-align:1px}
#log li.gdf .gdz{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--mut);margin-top:6px}
#log li.gdf .gdz input{flex:none;width:16px;height:16px;margin:0;padding:0;appearance:auto;-webkit-appearance:checkbox;accent-color:var(--acc);box-shadow:none}
#log li.gdrole{padding-left:42px}
#log li.conv.gdlk .acts{flex-wrap:wrap;justify-content:flex-end}
</style></head>
<body>
<nav id="rail" aria-label="Чаты и последние собеседники" hidden><div id="rchans" role="group" aria-label="Последние собеседники"></div></nav>
<header>
  <div class="hr">${EMBED ? '<span id="dctl"><button id="dmini" type="button" aria-pressed="false">«</button><button id="dgrip" type="button" title="Потяни, чтобы перенести панель; двойной щелчок — окном или прикрепить" aria-label="Перенести панель">⠿</button><button type="button" data-dm="l" title="Прикрепить слева" aria-label="Прикрепить слева">◧</button><button type="button" data-dm="f" title="Плавающее окно — двигать и менять размер" aria-label="Плавающее окно">❐</button><button type="button" data-dm="r" title="Прикрепить справа" aria-label="Прикрепить справа">◨</button></span>' : ''}<span id="dot" title="Связь"></span><select id="chan" title="Стример" aria-label="Стример"></select><a id="livebadge" target="_blank" rel="noopener" hidden>● В ЭФИРЕ</a><button id="modb" class="hb" type="button" title="Модерация чата" aria-label="Модерация чата" aria-expanded="false" hidden>🔨</button><button id="bmk" class="hb" type="button" title="Закладки — сохранённые сообщения" aria-label="Закладки" aria-pressed="false">⭐</button><button id="czb" class="hb" type="button" title="Настройки чата" aria-label="Настройки чата" aria-pressed="false">⚙</button><button id="theme" class="hb" type="button"></button><span class="po" id="pctl"><button class="hb" type="button" data-pc="dn" title="Мельче" aria-label="Шрифт мельче">A−</button><button class="hb" type="button" data-pc="up" title="Крупнее" aria-label="Шрифт крупнее">A+</button><button class="hb" type="button" data-pc="t" aria-pressed="true" title="Время у сообщений">🕒</button><button class="hb" type="button" data-pc="i" aria-pressed="true" title="Значки классов и ролей">🛡</button><button class="hb" type="button" data-pc="m" aria-pressed="false" title="Только лента: поле ввода появляется при наведении">⌨</button></span>${EMBED ? '<button id="popb" class="hb" type="button" title="Открыть отдельным окном" aria-label="Открыть отдельным окном">⧉</button><button id="closeb" class="hb" type="button" title="Скрыть чат" aria-label="Скрыть чат">✕</button>' : '<button id="pin" class="hb" type="button" aria-pressed="false">📌</button>'}</div>
  <div class="hr r2"><span class="seg" id="room" role="group" aria-label="Чат"><button type="button" data-r="mine">${rlab('mine')}</button><button type="button" data-r="city">${rlab('city')}</button><button type="button" data-r="all" title="Все чаты стримера в одной ленте">${rlab('all')}</button><button type="button" data-r="pm" title="Личные сообщения и друзья">${rlab('pm')}<b class="rb" hidden></b></button><button type="button" data-r="ping" title="Сообщения, где тебя упомянули по @нику">${rlab('ping')}<b class="rb" hidden></b></button><button type="button" data-r="guild" title="Гильдия — закрытый чат для своих" hidden>${rlab('guild')}<b class="rb" hidden></b></button></span><select id="mine" title="Шахта" hidden></select><div id="ctabs" role="tablist" hidden></div></div>
</header>
<div id="bmp" role="dialog" aria-label="Закладки" hidden></div><div id="fbar" role="search" hidden><input id="fq" type="search" maxlength="60" placeholder="Найти в сообщениях" aria-label="Найти в сообщениях" autocomplete="off" spellcheck="false"><span id="fn" aria-live="polite"></span><button type="button" class="hb" data-f="prev" title="Предыдущее (Shift+Enter)" aria-label="Предыдущее">↑</button><button type="button" class="hb" data-f="next" title="Следующее (Enter)" aria-label="Следующее">↓</button><button type="button" class="hb" data-f="only" aria-pressed="false" title="Показывать только найденные сообщения">Только найденные</button><button type="button" class="hb" data-f="close" title="Закрыть поиск (Esc)" aria-label="Закрыть поиск">✕</button></div>
<div id="cbar" hidden></div><div id="away" role="status" hidden></div><div id="onlyb" role="status" hidden></div>
<div id="dmbar" hidden></div><div id="gdbar" hidden></div>
<div id="pmtoast" role="status" hidden></div>
<div id="sp" role="dialog" aria-label="Настройки чата" hidden></div>
<ol id="log" role="log" aria-live="polite"></ol><p id="empty">Загружаю чат…</p><div id="gate" hidden></div>
<button id="more" type="button">↓ новые</button>
<footer><p id="err" role="status"></p><p id="okm" role="status"></p>
<div id="mp" role="dialog" aria-label="Модерация чата"></div>
<div id="ep" role="dialog" aria-label="Стикеры"><div id="ep-top"><input id="eq" type="search" placeholder="Найти стикер…" aria-label="Поиск стикера"></div><div id="etabs" role="tablist"></div><div id="eg"></div><div id="eh"></div></div>
<div id="pp" role="dialog" aria-label="Пасты"><div class="pp-top"><input id="pq" type="search" placeholder="Найти пасту…" aria-label="Поиск пасты"><button type="button" class="pbtn" id="pnew">＋ Новая</button></div><ul id="pl"></ul>
<div id="pe"><input id="pn" maxlength="40" placeholder="Название (например: «приветствие»)" aria-label="Название пасты"><textarea id="pt" maxlength="500" placeholder="Текст пасты — можно со стикерами" aria-label="Текст пасты"></textarea><div class="pe-b"><small id="pc">0 / 200</small><button type="button" class="pbtn alt" id="pcancel">Отмена</button><button type="button" class="pbtn" id="psave">Сохранить</button></div></div></div>
<div id="rq" hidden></div><ul id="ac" role="listbox" aria-label="Подсказки ников" hidden></ul>
<form id="f" autocomplete="off"><button id="pb" type="button" title="Сохранённые пасты" aria-label="Пасты" aria-expanded="false"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="4" width="13" height="17" rx="2.2"/><path d="M9 4V2.8h6V4M8.8 9.5h6.4M8.8 13h6.4M8.8 16.5h3.6"/></svg></button><select id="tgt" title="Куда отправить" aria-label="Куда отправить" hidden></select><button id="emb" type="button" title="Стикеры (7TV, BTTV, FFZ)" aria-label="Стикеры" aria-expanded="false"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.3 14.2a4.4 4.4 0 0 0 7.4 0"/><path d="M9 9.6h.01M15 9.6h.01" stroke-width="2.8"/></svg></button><button id="gpb" type="button" title="Сбор или опрос (или /сбор …, /опрос Вопрос | А | Б)" aria-label="Создать опрос" hidden><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20v-8M12 20V5M19 20v-5"/></svg></button><textarea id="in" rows="1" maxlength="200" placeholder="Написать…" enterkeyhint="send" aria-label="Сообщение" spellcheck="true"></textarea><button id="send" type="submit" aria-label="Отправить" title="Отправить (Enter)"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6l.05 6.5L15.5 12 3.45 13.9z"/></svg></button></form></footer>
</body>`;
    { const st0 = document.querySelector('head style'); st0.textContent = st0.textContent.replace(/#log\b/g, ':is(#log,#pvlog)'); }   // пример в настройках выглядит как лента
    const $ = (id) => document.getElementById(id);
    S.el = {
      log: $('log'), empty: $('empty'), gate: $('gate'), more: $('more'), dot: $('dot'), err: $('err'), f: $('f'),
      inp: $('in'), send: $('send'), mine: $('mine'), chan: $('chan'), room: $('room'), ctabs: $('ctabs'), cbar: $('cbar'), dmbar: $('dmbar'), tgt: $('tgt'),
    };
    S.el.log.addEventListener('scroll', () => {
      const l = S.el.log; S.stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
      if (S.stick) { S.unseen = 0; S.el.more.style.display = 'none'; }
    });
    S.el.more.onclick = () => toBottom();
    S.el.log.addEventListener('click', (e) => {   // «⋯» у сообщения — меню модерации
      const b = e.target.closest('.mb'); if (!b) return;
      e.stopPropagation();
      const li = b.closest('li'), m = li && S.list.find((x) => x._key === li.dataset.key);
      if (m) modMenu(m, b);
    }, true);
    S.el.log.addEventListener('click', (e) => {   // ✉ у ника — личная переписка; строка в списке диалогов — открыть
      const d = e.target.closest('.dmb');
      if (d) { e.stopPropagation(); pmOpen(d.dataset.l, d.dataset.n); return; }
      if (S.room === 'pm') { e.stopPropagation(); pmClick(e); }
    }, true);
    S.el.log.addEventListener('click', (e) => {   // «→» у пинга — в тот чат, ник — в поле ответа
      const g = e.target.closest('.pgo'); if (!g) return;
      e.stopPropagation();
      const li = g.closest('li'), n = li && li.querySelector('.n[data-l]'), who = n ? n.dataset.l : '';
      switchTo(g.dataset.ch, g.dataset.room).then(() => { if (who && !S.el.inp.disabled) { S.el.inp.value = `@${who} `; S.el.inp.focus(); } });
    }, true);
    S.el.log.addEventListener('keydown', (e) => { const cv = e.target.closest && e.target.closest('li.conv'); if (cv && S.room === 'pm' && (e.key === 'Enter' || e.key === ' ') && e.target === cv) { e.preventDefault(); pmOpen(cv.dataset.peer, cv.dataset.n); } });
    S.el.log.addEventListener('click', (e) => {   // клик по нику — ответить @ником
      const n = e.target.closest('.n'); if (!n || !n.dataset.l) return;
      const li = n.closest('li');
      if (isMix(S.room) && li && li.dataset.k) { const k = li.dataset.k === 'ev' ? 'g' : li.dataset.k; if ([...S.el.tgt.options].some((o) => o.value === k)) setTarget(k); }
      const v = S.el.inp.value.replace(/^@\S+\s*/, '');
      S.el.inp.value = `@${n.dataset.l} ${v}`; S.el.inp.focus();
    });
    S.el.f.addEventListener('submit', (e) => { e.preventDefault(); say(); });
    S.el.mine.onchange = () => { S.mine = S.el.mine.value; lsSet('lgmc_mine_' + S.ch, S.mine); restart(); };
    S.el.chan.onchange = () => switchTo(S.el.chan.value, S.room);
    S.el.room.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b && !b.disabled && b.dataset.r !== S.room) switchTo(S.ch, b.dataset.r); };
    S.el.ctabs.onclick = (e) => {
      const b = e.target.closest('[data-tab]'); if (b) { tabTo(b.dataset.tab); return; }
      const tw = e.target.closest('[data-town]'); if (tw) { townMenu(tw); return; }
      const pg = e.target.closest('[data-pg]');
      if (pg) {
        const a = pg.dataset.pg;
        if (a === 'clear') {
          if (!S.pg.sure) { S.pg.sure = true; renderTabs(); clearTimeout(S.pg.sureT); S.pg.sureT = setTimeout(() => { S.pg.sure = false; if (S.room === 'ping') renderTabs(); }, 4000); return; }
          S.pg.sure = false; S.pg.list = S.pg.all ? [] : S.pg.list.filter((x) => x._ch !== S.ch); pingSave();
        } else { S.pg.all = a === 'all'; lsSet('lgmc_pings_all', S.pg.all); }
        renderTabs(); renderLog(); toBottom(); return;
      }
      const f = e.target.closest('[data-mix]'); if (!f) return;
      S.mix[f.dataset.mix] = !S.mix[f.dataset.mix]; lsSet('lgmc_mix', S.mix); renderTabs(); renderLog(); toBottom();
    };
    S.el.tgt.onchange = () => setTarget(S.el.tgt.value);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { S.unseenTitle = 0; document.title = title(); poll(); if (S.room === 'pm' && S.pm.peer) pmMarkRead(S.pm.peer); }
    });
    window.addEventListener('pagehide', () => cityLeave(true));
    themeInit();
    pinInit();
    pickerInit();
    pastesInit();
    modInit();
    pmInit(); pingInit(); findInit(); comfyInit(); growInit(); gdInit();
    czInit();
    start();
    loadChannels();
  }

  // ---------- Тема: тёмная (как игра, по умолчанию) → как в системе → светлая ----------
  const THEME_KEY = 'lgmc_theme';
  const THEMES = { auto: ['🌓', 'Тема: как в системе'], light: ['☀️', 'Тема: светлая'], dark: ['🌙', 'Тема: тёмная'] };
  function themeApply(t) {
    if (!THEMES[t]) t = 'auto';
    for (const d of docs()) { if (t === 'auto') d.documentElement.removeAttribute('data-theme'); else d.documentElement.dataset.theme = t; }
    const b = S.el && S.el.theme;
    if (b) { b.textContent = THEMES[t][0]; b.title = `${THEMES[t][1]} (нажми, чтобы сменить)`; b.setAttribute('aria-label', THEMES[t][1]); b.dataset.t = t; }
  }
  function themeInit() {
    let t = 'dark'; try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch {}   // игра всегда тёмная — по умолчанию и чат тёмный
    S.el.theme = document.getElementById('theme');
    themeApply(t);
    S.el.theme.onclick = (e) => {
      const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(e.currentTarget.dataset.t) + 1) % order.length];
      themeApply(next); try { localStorage.setItem(THEME_KEY, next); } catch {}
    };
    window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) themeApply(e.newValue || 'dark'); });
  }

  // ---------- Поверх всех окон: Document Picture-in-Picture (Chrome / Edge 116+) ----------
  const PIN_KEY = 'lgmc_pin_size';
  const docs = () => (S.pip ? [document, S.pip.document] : [document]);
  const hidden = () => (S.pip ? false : document.hidden);   // плавающее окно всегда на виду
  const pinOk = () => 'documentPictureInPicture' in window;

  function pinInit() {
    if (EMBED) {   // внутри игры «поверх окон» недоступно (браузер разрешает это только самому окну) — вместо этого «⧉» и «✕»
      document.getElementById('popb').onclick = () => {
        window.open(chatUrl(S.ch, S.room), 'lgChat', 'popup,width=420,height=720');
        window.parent.postMessage({ lgmc: 'popped' }, location.origin);
      };
      document.getElementById('closeb').onclick = () => window.parent.postMessage({ lgmc: 'close' }, location.origin);
      return;
    }
    S.el.pin = document.getElementById('pin');
    if (!pinOk()) {
      S.el.pin.disabled = true;
      S.el.pin.title = 'Закрепить поверх окон можно в Chrome или Edge (версии 116+). В этом браузере — нет; на Windows помогает PowerToys «Always on Top» (Win+Ctrl+T).';
      return;
    }
    S.el.pin.title = 'Закрепить поверх всех окон';
    S.el.pin.setAttribute('aria-label', 'Закрепить поверх всех окон');
    S.el.pin.onclick = () => (S.pip ? S.pip.close() : pinOpen());
    pinStyleInit();
  }

  const PSTYLE_KEY = 'lgmc_pin_style';
  const pstyle = () => Object.assign({ fs: 13, t: true, i: true, m: false }, lsGet(PSTYLE_KEY, {}));
  function pinStyleApply(d) {
    const st = pstyle(), r = d.documentElement;
    r.classList.add('pinned');
    r.style.setProperty('--fs', st.fs + 'px');
    r.classList.toggle('not', !st.t); r.classList.toggle('noi', !st.i); r.classList.toggle('mini', !!st.m);
    for (const b of S.el.pctl.querySelectorAll('[data-pc]')) {
      const k = b.dataset.pc; if (k in st && typeof st[k] === 'boolean') b.setAttribute('aria-pressed', String(st[k]));
    }
    S.el.pctl.querySelector('[data-pc="dn"]').disabled = st.fs <= 11;
    S.el.pctl.querySelector('[data-pc="up"]').disabled = st.fs >= 20;
  }
  function pinStyleInit() {
    S.el.pctl = document.getElementById('pctl');
    S.el.pctl.onclick = (e) => {
      const b = e.target.closest('[data-pc]'); if (!b || !S.pip) return;
      const st = pstyle(), k = b.dataset.pc;
      if (k === 'dn') st.fs = Math.max(11, st.fs - 1); else if (k === 'up') st.fs = Math.min(20, st.fs + 1); else st[k] = !st[k];
      lsSet(PSTYLE_KEY, st);
      pinStyleApply(S.pip.document);
      if (S.stick) toBottom();
    };
  }

  async function pinOpen() {
    let size = { width: 380, height: 620 };
    const v = lsGet(PIN_KEY, null); if (v && v.width > 200 && v.height > 200) size = v;
    let pip;
    try { pip = await window.documentPictureInPicture.requestWindow(size); }
    catch (e) { S.el.err.textContent = 'Не удалось открыть окно поверх остальных: ' + ((e && e.message) || e); return; }
    S.pip = pip;
    const pd = pip.document;
    pd.title = title();
    const st = pd.createElement('style'); st.textContent = document.querySelector('head style').textContent; pd.head.append(st);
    pd.body.append(...document.body.childNodes);   // переносим всё вместе с обработчиками
    pd.addEventListener('keydown', S.onEsc);
    if (S.findKeys) pd.addEventListener('keydown', S.findKeys, true);   // Ctrl+F и в окне поверх всех
    if (S.hotkeys) pd.addEventListener('keydown', S.hotkeys, true);
    pinStyleApply(pd);
    czApply();
    document.body.innerHTML = '<div id="pinned"><b>📌 Чат закреплён поверх окон</b>Это окно можно свернуть, но не закрывай его — иначе плавающий чат тоже закроется.<br><button type="button" id="unpin">Вернуть чат сюда</button></div>';
    document.getElementById('unpin').onclick = () => pip.close();
    S.el.pin.setAttribute('aria-pressed', 'true'); S.el.pin.title = 'Открепить (вернуть в обычное окно)';
    themeApply(S.el.theme.dataset.t);
    pip.addEventListener('pagehide', () => {
      lsSet(PIN_KEY, { width: pip.innerWidth, height: pip.innerHeight });
      document.body.innerHTML = '';
      document.body.append(...pd.body.childNodes);
      S.pip = null;
      S.el.pin.setAttribute('aria-pressed', 'false'); S.el.pin.title = 'Закрепить поверх всех окон';
      if (S.stick) toBottom();
      schedule();
    }, { once: true });
    if (S.stick) setTimeout(toBottom, 0);
    schedule();
  }

  // ---------- Сеть ----------
  async function api(path, body, keepalive) {
    const c = new AbortController(), tm = setTimeout(() => c.abort(), 20000);
    try {
      const r = await pfetch(BASE() + path, {
        credentials: 'same-origin', signal: c.signal, keepalive: !!keepalive,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      let j = null; try { j = await r.json(); } catch {}
      return j || { ok: false, error: `HTTP ${r.status}` };
    } finally { clearTimeout(tm); }
  }

  async function loadChannels() {
    try {
      const r = await api('/api/channels');
      if (r && r.ok && Array.isArray(r.channels)) S.channels = r.channels.filter((c) => okLogin(c.login));
    } catch {}
    if (!S.channels.some((c) => c.login.toLowerCase() === S.ch)) S.channels.unshift({ login: S.ch, name: S.chName, live: false });
    // 🔴 кто-то из стримеров игры начал эфир (был не в эфире при прошлой проверке) — сказать
    const nowLive = new Set(S.channels.filter((c) => c.live).map((c) => c.login.toLowerCase()));
    if (S.liveSet && CZ.liveAlert !== false) for (const c of S.channels) { const l = c.login.toLowerCase(); if (nowLive.has(l) && !S.liveSet.has(l)) liveAlert(c); }
    S.liveSet = nowLive;
    renderChannels();
    clearTimeout(S.chanT); S.chanT = setTimeout(loadChannels, hidden() ? 300000 : 120000);   // эфиры начинаются и заканчиваются — раз в 2 минуты
  }
  // список стримеров: кто в эфире — сверху и с пометкой; у текущего, если он в эфире, — «В ЭФИРЕ» рядом (ссылка на Twitch)
  // боковая колонка (как в Telegram): комнаты значками с подписями, ниже — стримеры кружками.
  // Сторона: «авто» — у края экрана (панель в игре справа → колонка справа), иначе как выбрано в ⚙
  S.dockSide = /^[lrf]$/.test(Q.get('side') || '') ? Q.get('side') : 'l';
  function railApply() {
    if (!S.el || !S.el.room) return;
    const rail = S.el.rail || (S.el.rail = document.getElementById('rail')), r2 = S.el.r2 || (S.el.r2 = document.querySelector('.hr.r2'));
    if (!rail || !r2) return;
    const mode = CZ.rail || 'auto', on = mode !== 'off';
    const side = mode === 'left' ? 'l' : mode === 'right' ? 'r' : EMBED && S.dockSide === 'r' ? 'r' : 'l';
    for (const d of docs()) { d.documentElement.classList.toggle('rail', on); d.documentElement.classList.toggle('rail-r', on && side === 'r'); }
    if (on && S.el.room.parentElement !== rail) rail.insertBefore(S.el.room, rail.firstChild);
    if (!on && S.el.room.parentElement !== r2) r2.insertBefore(S.el.room, r2.firstChild);
    rail.hidden = !on;
    for (const d of docs()) d.documentElement.classList.toggle('mini', !!(EMBED && on && S.mini));
    const mb = document.getElementById('dmini');
    if (mb) { mb.hidden = !on; const toR = side === 'r'; mb.textContent = S.mini ? (toR ? '«' : '»') : (toR ? '»' : '«'); mb.title = S.mini ? 'Развернуть чат' : 'Свернуть до колонки (или двойной щелчок по комнате) — останутся комнаты и собеседники'; mb.setAttribute('aria-label', mb.title); mb.setAttribute('aria-pressed', String(!!S.mini)); }
    const ctl = document.getElementById('dctl');
    if (ctl) {   // ⠿ и «слева / окном / справа»: в колонке — внизу, без колонки — в начале шапки
      const hr = document.querySelector('header .hr');
      if (on && ctl.parentElement !== rail) rail.appendChild(ctl);
      if (!on && ctl.parentElement !== hr) hr.insertBefore(ctl, hr.firstChild);
      for (const b of ctl.querySelectorAll('[data-dm]')) b.setAttribute('aria-pressed', String(b.dataset.dm === S.dockSide));
    }
    railChans();
  }
  // панель в игре: перенос за ⠿ или пустое место шапки — указатель пересылаем игре, она двигает панель
  if (EMBED) {
    const post = (d) => { try { window.parent.postMessage(d, location.origin); } catch {} };
    const dragFrom = (e, el) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch {}
      post({ lgmc: 'drag', ph: 'start', x: e.clientX, y: e.clientY });
      const mv = (ev) => post({ lgmc: 'drag', ph: 'move', x: ev.clientX, y: ev.clientY });
      const up = (ev) => { post({ lgmc: 'drag', ph: 'end', x: ev.clientX, y: ev.clientY }); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    };
    const emptyHead = (t) => t.closest && t.closest('header .hr') && !t.closest('button,select,a,input,#room,#ctabs,#mine');
    document.addEventListener('pointerdown', (e) => {
      const g = e.target.closest && e.target.closest('#dgrip');
      if (g) return dragFrom(e, g);
      if (emptyHead(e.target)) dragFrom(e, e.target.closest('header .hr'));
    });
    document.addEventListener('dblclick', (e) => {
      if (!e.target.closest) return;
      if (e.target.closest('#rail #room [data-r]')) { if (!S.mini) post({ lgmc: 'mode', m: 'mini' }); return; }   // двойной щелчок по комнате — свернуть до колонки
      if (e.target.closest('#dgrip') || emptyHead(e.target)) post({ lgmc: 'mode', m: 'toggle' });
    });
    document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('#dctl [data-dm]'); if (b) post({ lgmc: 'mode', m: b.dataset.dm }); });
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target; if (!t) return;
      if (t.closest('#dmini')) { post({ lgmc: 'mode', m: S.mini ? 'full' : 'mini' }); return; }
      if (S.mini && t.closest('#rail #room [data-r], #rchans [data-rpeer]')) post({ lgmc: 'mode', m: 'full' });   // свёрнут: щелчок по комнате или собеседнику — развернуть
    }, true);
  }
  // в колонке под комнатами — последние, с кем переписывался: значок класса, непрочитанные, «в сети»
  function railChans() {
    const box = document.getElementById('rchans'); if (!box || !S.el || !S.el.rail || S.el.rail.hidden) { if (box) box.innerHTML = ''; return; }
    const P = S.pm;
    if (!S.me || !S.flags.dm || !P || !P.last) { box.innerHTML = ''; return; }
    const max = Math.max(3, Math.min(12, Math.floor((window.innerHeight - 330) / 50)));
    const peers = Object.keys(P.last).filter((l) => nickOf(l) && l !== S.me && !S.ign.has(l) && (P.last[l].at || P.un.get(l))).sort((a, b) => (P.last[b].at || 0) - (P.last[a].at || 0)).slice(0, max);
    box.innerHTML = peers.map((l) => {
      const n = P.un.get(l) || 0, f = pmFriend(l), on = !!(f && f.on), last = P.last[l] || {};
      const cur = S.room === 'pm' && P.peer === l;
      return `<button type="button" class="rpe" data-rpeer="${esc(l)}" aria-pressed="${cur}" title="${esc(dispName(l))}${on ? ' · ' + esc(f.on.t || 'в сети') : ''}${last.t ? '\n' + esc((last.mine ? 'Ты: ' : '') + last.t.slice(0, 60)) : ''}" aria-label="${esc(dispName(l))}${n ? ', непрочитанных: ' + n : ''}">${avIn(l, null, 'av')}</span>${on ? '<span class="on" aria-hidden="true"></span>' : ''}${n ? `<b class="un">${n > 99 ? '99+' : n}</b>` : ''}<small>${esc(dispName(l))}</small></button>`;
    }).join('');
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin || !e.data || e.data.lgmc !== 'side' || !/^[lrf]$/.test(e.data.side)) return;
    const mini = !!e.data.mini;
    if (S.dockSide !== e.data.side || S.mini !== mini) { S.dockSide = e.data.side; S.mini = mini; railApply(); }
  });
  if (EMBED) try { window.parent.postMessage({ lgmc: 'ready', ctl: 1 }, location.origin); } catch {}   // панель в игре: «готов» — пришли, с какой ты стороны
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('#rchans [data-rpeer]'); if (!b) return;
    const l = b.dataset.rpeer;
    if (S.room !== 'pm') await switchTo(S.ch, 'pm');
    pmOpen(l);
  });
  function renderChannels() {
    const list = S.channels.map((c, i) => [c, i]).sort((a, b) => (b[0].live ? 1 : 0) - (a[0].live ? 1 : 0) || a[1] - b[1]).map((x) => x[0]);
    S.el.chan.innerHTML = list.map((c) => `<option value="${esc(c.login.toLowerCase())}" class="${c.live ? 'live' : 'off'}">${c.live ? '🔴' : '⚪'} ${esc(c.name || c.login)} — ${c.live ? 'в эфире' : 'не в эфире'}</option>`).join('');
    S.el.chan.value = S.ch;
    const cur = S.channels.find((c) => c.login.toLowerCase() === S.ch);
    if (cur && cur.name) S.chName = cur.name;
    railChans();
    const live = !!(cur && cur.live);
    S.el.chan.title = live ? `${S.chName} — сейчас в эфире` : `${S.chName} — сейчас не в эфире`;
    S.el.chan.classList.toggle('live', live);
    const lb = document.getElementById('livebadge');
    if (lb) { lb.hidden = !live; lb.href = `https://www.twitch.tv/${encodeURIComponent(S.ch)}`; lb.title = `${S.chName} в эфире — открыть стрим на Twitch`; }
    document.title = title();
  }

  // ---------- Канал и комната ----------
  async function switchTo(ch, room) {
    if (!okLogin(ch)) return;
    if (S.reply && (S.reply.gid || room === 'guild') && typeof replyCancel === 'function') replyCancel();
    const chChanged = ch !== S.ch;
    const wasCity = usesCity(S.room) && S.inCity;
    const keepCity = wasCity && !chChanged && usesCity(room);   // Город ↔ Всё: герой остаётся на Ярмарке
    if (wasCity && !keepCity) cityLeave();
    if (S.room === 'ping' || room === 'ping') pingRead();   // вошёл в «Пинги» или ушёл из них — всё, что было, прочитано (сразу, не дожидаясь загрузки)
    S.ch = ch; S.room = room;
    const cur = S.channels.find((c) => c.login.toLowerCase() === ch); S.chName = (cur && cur.name) || ch;
    lsSet(LAST_KEY, { ch, room });
    try { history.replaceState(null, '', chatUrl(ch, room) + (EMBED ? '&embed=1' : '')); } catch {}
    renderChannels();
    if (chChanged) { S.me = ''; S.hero = null; pmReset(); emLoad(); }
    await start(keepCity);
  }

  async function start(keepCity) {
    const gen = ++S.gen;
    clearTimeout(S.timer);
    clearLog('Загружаю чат…');
    if (!keepCity) S.cityByGame = false;
    S.tab = 'g'; S.un = { g: 0, tr: 0, ev: 0 }; S.inCity = !!keepCity;
    S.el.err.textContent = '';
    try {
      const me = await api('/api/me'); if (gen !== S.gen) return;
      S.me = String((me.user && me.user.login) || '').toLowerCase();
      S.hero = me.hero || null;
      const h = S.hero || {};
      S.flags = { cc: !!h.cc, tr: !!h.ct, dm: !!h.cd };
      S.meFriends = !!me.friends;
      S.myCls = CLS_ICO[h.role] ? h.role : ''; S.myClsN = h.roleName || '';
      S.mines = Object.entries(h.mn || {}).map(([id, v]) => ({ id, nm: (v && v.nm) || id }));
    } catch { if (gen !== S.gen) return; }
    // шахты
    const saved = lsGet('lgmc_mine_' + S.ch, '');
    S.mine = S.mines.some((x) => x.id === saved) ? saved : (S.mines[0] ? S.mines[0].id : 'home');
    S.el.mine.innerHTML = S.mines.map((x) => `<option value="${esc(x.id)}">${esc(x.nm)}</option>`).join('');
    S.el.mine.value = S.mine;
    // какие комнаты доступны: шахта — если у героя на канале есть шахта; город — если чат города включён; «Всё» — если есть хоть что-то
    const rb = (r) => S.el.room.querySelector(`[data-r="${r}"]`);
    const hasMine = S.mines.length > 0, hasCity = !S.hero || S.flags.cc;
    rb('mine').disabled = !hasMine; rb('mine').title = hasMine ? 'Чат шахты' : 'На этом канале у тебя нет шахты';
    rb('city').disabled = !hasCity; rb('city').title = hasCity ? 'Чат города' : 'Чат города на этом канале выключен';
    rb('all').disabled = !hasMine && !hasCity;
    rb('pm').disabled = !S.me || !S.flags.dm; rb('pm').title = rb('pm').disabled ? (S.me ? 'Личные сообщения на этом канале выключены' : 'Войди на сайте игры, чтобы писать лично') : 'Личные сообщения и друзья';
    rb('guild').disabled = !S.me; rb('guild').title = S.me ? 'Гильдия — закрытый чат для своих' : 'Войди на сайте игры — гильдия привязана к твоему нику';
    rb('ping').disabled = !S.me; rb('ping').title = S.me ? 'Сообщения, где тебя упомянули по @нику' : 'Войди на сайте игры — пинги ищутся по твоему нику';
    if (rb(S.room).disabled) S.room = hasCity ? 'city' : 'mine';
    S.cityChk = isMix(S.room) && hasCity && !S.inCity;   // пока не узнали, открыт ли город в игре, — полоску не показываем
    pingBoot();
    pmBoot(); gdBoot();
    for (const b of S.el.room.querySelectorAll('[data-r]')) b.setAttribute('aria-pressed', String(b.dataset.r === S.room));
    S.el.mine.hidden = !usesMine(S.room) || S.mines.length < 2;
    renderTabs(); renderTargets(); updateBar(); pmBar(); gdBar(); try { railChans(); } catch {}
    modLoad(gen);
    if (hasCity) townsLoad();   // 📍 где отряд и куда можно встать
    document.title = title(); if (S.pip) S.pip.document.title = title();
    inputState();
    if (S.room === 'pm') { clearLog(''); pmEnter(); return; }
    if (S.room === 'guild') { clearLog(''); gdEnter(); return; }
    if (S.room === 'mine' && !hasMine) { clearLog('На этом канале у тебя нет шахты — переключись на 🏰 Город.'); return; }
    if (S.room === 'city' && !S.inCity) {
      if (await cityAttach(gen)) return;   // герой уже в городе (например, город открыт в игре) — просто подхватываем
      if (gen !== S.gen) return;
      if (lsGet(CITY_AUTO_KEY, false)) cityEnter(); else showGate();
      return;
    }
    if (S.room === 'ping') { pingRead(); renderLog(); }
    poll(true);   // шахта, город (если уже на Ярмарке) или всё сразу
    liveWatch();
    if (S.cityChk) cityAttach(gen).then((ok) => {
      if (gen !== S.gen) return;
      S.cityChk = false;
      if (!ok && lsGet(CITY_AUTO_KEY, false)) cityEnter(); else updateBar();
    });
  }
  const restart = () => start(usesCity(S.room) && S.inCity);

  function clearLog(msg) {
    S.el.log.classList.remove('pm');
    S.list = []; S.ids.clear(); S.mc = 0; S.cc = 0; S.el.log.innerHTML = '';
    S.el.gate.hidden = true; S.el.log.hidden = false;
    S.el.empty.hidden = !msg; S.el.empty.textContent = msg || '';
  }

  // ---------- Город: вход по кнопке ----------
  const GATE_TEXT = 'Чтобы читать и писать в чат города, твой герой зайдёт на Ярмарку этого канала — как при открытии города в игре. Его увидят другие игроки (и, возможно, на оверлее стрима). Когда переключишься или закроешь окно, герой уйдёт из города.';
  function showGate(errText) {
    S.el.log.hidden = true; S.el.empty.hidden = true; S.el.gate.hidden = false;
    const auto = lsGet(CITY_AUTO_KEY, false);
    S.el.gate.innerHTML = `<b>🏰 Чат города · ${esc(S.chName)}</b>${GATE_TEXT}
      ${errText ? `<p style="color:var(--bad)">${esc(errText)}</p>` : ''}
      <br><button type="button" class="go">Войти в город</button>
      <label><input type="checkbox" ${auto ? 'checked' : ''}> Входить сразу, не спрашивая</label>`;
    S.el.gate.querySelector('.go').onclick = () => cityEnter();
    S.el.gate.querySelector('input').onchange = (e) => lsSet(CITY_AUTO_KEY, e.target.checked);
    inputState();
  }
  // в общей ленте вместо большого экрана — полоска над лентой: шахта видна сразу, город — по кнопке
  function updateBar(errText) {
    // «Город не подключён» — только когда это правда и надо что-то решить: не пока проверяем, не пока входим сами («сразу»)
    const auto = lsGet(CITY_AUTO_KEY, false);
    const show = isMix(S.room) && !S.inCity && (!S.hero || S.flags.cc) && (!!errText || (!S.cityChk && !S.entering && !auto));
    S.el.cbar.hidden = !show;
    if (!show) { S.el.cbar.innerHTML = ''; return; }
    S.el.cbar.innerHTML = `<span title="${esc(GATE_TEXT)}">🏰 Город не подключён${errText ? ' — ' + esc(errText) : ': герой зайдёт на Ярмарку, его увидят другие'}</span><button type="button" class="go">Войти в город</button><label><input type="checkbox" ${auto ? 'checked' : ''}> сразу</label>`;
    S.el.cbar.querySelector('.go').onclick = () => cityEnter();
    S.el.cbar.querySelector('input').onchange = (e) => lsSet(CITY_AUTO_KEY, e.target.checked);
  }

  // Если герой уже на Ярмарке этого канала (город открыт в игре), повторный вход переставил бы его к воротам.
  // Поэтому сначала спрашиваем ленту (только чтение): ответила — значит, мы уже в городе, входить не надо.
  async function cityAttach(gen) {
    // 29.10: у игры единый чат — ленту города можно читать откуда угодно (GET /api/chat/feed?room=city), герой остаётся,
    // где был (на привале, в шахте…). Входить на Ярмарку не нужно. Если сервер так не умеет — по-старому (герой уже в городе?).
    let r = null; try { r = await api('/api/chat/feed?room=city'); } catch {}
    if (gen !== S.gen || !usesCity(S.room) || S.inCity) return false;
    if (r && r.ok) { S.cityFeed = true; S.inCity = true; S.cityByGame = true; S.cityCh = S.ch; cityReady(r); return true; }
    S.cityFeed = false;
    r = null; try { r = await api('/api/city/state?c=0'); } catch {}
    if (gen !== S.gen || !usesCity(S.room) || S.inCity || !r || !r.ok) return false;
    S.inCity = true; S.cityByGame = true; S.cityCh = S.ch;
    cityReady(r);
    return true;
  }
  function cityReady(r) {
    S.el.dot.className = 'ok';
    if (S.room === 'city') clearLog('');
    if (Array.isArray(r.ign)) { S.ign = new Set(r.ign.map((x) => String(x).toLowerCase())); lsSet('lgmc_ign_' + S.ch, [...S.ign]); }
    if (r.mod === 'own' || r.mod === 'mod') { S.mod.city = Object.assign(S.mod.city || { bans: [], mods: [] }, { role: r.mod }); modUi(); }
    apply(r, 'city', true);
    updateBar(); inputState(); liveWatch();
    if (CZ.hist !== false) histMerge('city', S.gen);   // + своя история города из браузера
    if (isMix(S.room) && S.ign.size) renderLog();   // игнор пришёл только сейчас — убрать уже показанное от игнорируемых
    schedule();
  }

  async function cityEnter() {
    if (S.entering) return;
    const gen = S.gen;
    S.entering = true;
    for (const go of [S.el.gate.querySelector('.go'), S.el.cbar.querySelector('.go')]) if (go) { go.disabled = true; go.textContent = 'Вхожу…'; }
    if (await cityAttach(gen)) { S.entering = false; return; }
    let r = null;
    try { r = await api('/api/city/enter', CITY_SPAWN); } catch {}
    S.entering = false;
    if (gen !== S.gen || !usesCity(S.room)) return;
    if (!r || !r.ok) {
      const t = 'Не получилось войти: ' + ((r && (ERR[r.error] || r.error)) || 'нет связи');
      if (S.room === 'city') { S.el.dot.className = 'bad'; showGate(t); } else updateBar(t);
      return;
    }
    S.inCity = true; S.cityByGame = false; S.cityCh = S.ch;
    if (!Array.isArray(r.ign)) r.ign = [];
    cityReady(r);
  }

  function cityLeave(onUnload) {
    if (!S.inCity) return;
    S.inCity = false;
    if (S.cityByGame) { S.cityByGame = false; return; }   // в город заходила игра, не мы — и выводить героя не нам
    const ch = S.cityCh || S.ch;
    const url = `/c/${ch}/api/city/leave`;
    // при закрытии окна обычный запрос может не успеть уйти — для этого есть sendBeacon
    let sent = false;
    if (onUnload && navigator.sendBeacon) { try { sent = navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' })); } catch {} }
    if (!sent) { try { pfetch(url, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} }
    if (!onUnload) S.cityCh = null;
  }

  // ---------- Опрос ----------
  const canPoll = () => (usesMine(S.room) && S.mines.length > 0) || (usesCity(S.room) && S.inCity);
  function schedule() {
    clearTimeout(S.timer);
    if (!canPoll()) return;
    const live = S.watchOn && S.pm.esOk;   // подписка работает — опрос только на всякий случай
    const base = live ? 15000 : hidden() ? 8000 : 2500;
    S.timer = setTimeout(() => poll(), S.fails ? Math.min(30000, base * 2 ** S.fails) : base);
  }

  async function poll(reset) {
    if (S.busy) { if (reset) S.pendingReset = true; return; }
    if (!canPoll()) { emptyState(); return; }
    const gen = S.gen;
    S.busy = true;
    if (reset) { S.mc = 0; S.cc = 0; }
    try {
      const jobs = [];
      if (usesMine(S.room) && S.mines.length) jobs.push(api(`/api/mine/state?c=${encodeURIComponent(S.mine)}&mc=${S.mc || 0}`).then((r) => ['mine', r]));
      if (usesCity(S.room) && S.inCity) jobs.push(api(S.cityFeed ? `/api/chat/feed?room=city${S.cc ? '&c=' + S.cc : ''}` : `/api/city/state?c=${S.cc || 0}`).then((r) => ['city', r]));
      const res = await Promise.all(jobs);
      if (gen !== S.gen) return;
      if (reset) { S.list = []; S.ids.clear(); S.el.log.innerHTML = ''; }
      const errs = [];
      for (const [src, r] of res) {
        if (r && r.ok) { apply(src === 'mine' ? r.mchat || {} : r, src, reset); continue; }
        if (src === 'city' && /не в городе/.test((r && r.error) || '')) {   // присутствие слетело (например, город закрыт в игре или в другой вкладке)
          const byGame = S.cityByGame; S.inCity = false; S.cityByGame = false;
          if (byGame && !lsGet(CITY_AUTO_KEY, false)) { if (S.room === 'city') showGate(); else updateBar(); inputState(); }   // сами мы не входили — спросим
          else cityEnter();
          continue;
        }
        errs.push((r && (ERR[r.error] || r.error)) || 'ошибка');
      }
      if (reset && S.room === 'all') pmFeedFill();
      if (reset && CZ.hist !== false) for (const [src, r] of res) if (r && r.ok) histMerge(src, gen);   // + своя история из браузера
      if (errs.length) throw new Error(errs.join('; '));
      S.fails = 0; S.el.dot.className = 'ok'; S.el.dot.title = 'На связи';
      if (S.el.err.dataset.net) { S.el.err.textContent = ''; delete S.el.err.dataset.net; }
    } catch (e) {
      if (gen !== S.gen) return;
      S.fails++; S.el.dot.className = 'bad'; S.el.dot.title = 'Нет связи';
      S.el.err.textContent = `Нет связи с игрой: ${e.message}`; S.el.err.dataset.net = '1';
      if (!S.list.length) { S.el.empty.hidden = false; S.el.empty.textContent = 'Не удалось загрузить чат. Проверь, что ты вошёл на сайт игры.'; }
    } finally {
      if (gen === S.gen) {
        S.busy = false;
        if (S.pendingReset) { S.pendingReset = false; poll(true); } else schedule();
      } else S.busy = false;
    }
  }

  // вид сообщения: шахта, или вкладка города (как в игре): Достижения — события игры, Торговля / Личные — по виду
  const kind = (m) => (m._src === 'mine' ? 'mine' : m._src === 'pm' ? 'dm' : m.tb || (m.ev ? 'ev' : m.k === 'tr' ? 'tr' : m.k === 'dm' ? 'dm' : 'g'));
  const visible = (m) => {
    if (S.ign.has(m.l) || czHidden(m)) return false;
    if (S.only && String(m.l || '').toLowerCase() !== S.only) return false;   // 👁 только этот игрок
    const k = kind(m);
    if (S.room === 'pm') return false;
    if (S.room === 'ping') return isPing(m);
    return S.room === 'mine' ? k === 'mine' : S.room === 'city' ? k === S.tab : !!S.mix[k];
  };

  function apply(d, src, initial) {
    let added = 0, resort = false, beep = false;
    for (const msg of d.chat || []) {
      if (!msg || !msg.id) continue;
      if (msg.k === 'dm' && src !== 'pm') continue;   // личные теперь своей системой (/api/dm) — из городского чата не берём, иначе задвоятся
      const key = src + ':' + msg.id;
      if (S.ids.has(key)) continue;
      const m = Object.assign({}, msg, { _src: src, _key: key });
      if (extHas(m.t)) { extAdd(m.l); m.t = extStrip(m.t); }   // 🧩 метка Чата Легиона — запомнить и убрать из текста
      S.ids.add(key);
      // лента общая для двух источников — держим её по времени
      const last = S.list[S.list.length - 1];
      S.list.push(m);
      if (last && (last.at || 0) > (m.at || 0)) { S.list.sort((x, y) => (x.at || 0) - (y.at || 0)); resort = true; }
      if (m.l && !m.sys) seenAdd(m.l, m.n, m.at, m.c, m.cn);
      if (src !== 'pm' && isPing(m)) pingAdd(m);
      if (S.ign.has(m.l)) continue;
      const k = kind(m), mine = String(m.l).toLowerCase() === S.me;
      if (visible(m)) { if (!resort) S.el.log.appendChild(row(m)); added++; }
      else if (S.room === 'city' && !initial && !mine && k !== 'ev' && k !== 'mine') { S.un[k] = (S.un[k] || 0) + 1; renderTabs(); }
      if (!initial && hidden() && !mine && visible(m)) document.title = `(${++S.unseenTitle}) ${title()}`;
      if (!initial && !mine && visible(m) && isMention(String(m.t || ''), String(m.l || '').toLowerCase())) beep = S.ch + '|' + key;
    }
    for (const id of d.chatDel || []) {   // удалённые модератором
      const key = src + ':' + id;
      if (!S.ids.has(key)) continue;
      S.ids.delete(key); S.list = S.list.filter((x) => x._key !== key);
      const li = S.el.log.querySelector(`li[data-key="${CSS.escape(key)}"]`); if (li) li.remove();
    }
    while (S.list.length > histMax()) { const old = S.list.shift(); S.ids.delete(old._key); const li = S.el.log.querySelector(`li[data-key="${CSS.escape(old._key)}"]`); if (li) li.remove(); }
    if (d.c != null) { if (src === 'mine') S.mc = Math.max(S.mc, +d.c || 0); else S.cc = Math.max(S.cc, +d.c || 0); }
    if (d.chatMe && 'muted' in d.chatMe && d.chatMe.muted) S.el.err.textContent = 'Модератор запретил тебе писать в этот чат';
    if (beep) czBeepOnce('mention', beep);
    if (added || (d.chatDel && d.chatDel.length)) histSaveSoon();
    if (resort || (initial && S.room === 'ping')) renderLog();   // в «Пингах» — вместе с сохранёнными раньше
    emptyState();
    if (added) {
      if (S.stick || initial) toBottom();
      else { S.unseen += added; S.el.more.textContent = `↓ новые (${S.unseen})`; S.el.more.style.display = 'block'; }
    }
  }

  function renderLog() {
    if (S.mmenu) modMenuClose();
    if (S.room === 'pm') { pmRender(); return; }
    if (S.room === 'guild') { gdRender(); return; }
    S.el.log.classList.remove('pm');
    S.el.log.innerHTML = '';
    pmBar(); gdBar();
    const f = document.createDocumentFragment();
    for (const m of S.room === 'ping' ? pingView() : S.list) if (S.room === 'ping' || visible(m)) f.appendChild(row(m));
    S.el.log.appendChild(f);
    emptyState();
  }

  const EMPTY = {
    mine: 'В чате шахты пока тихо.', g: 'В чате города пока тихо — напиши первым.',
    tr: 'Здесь объявления: куплю, продам, меняю.', ev: 'Здесь громкие события игры: заточки +7 и выше, достижения.',
  };
  function emptyState() {
    if (!S.el.gate.hidden) return;
    if (S.room === 'pm' || S.room === 'guild') { S.el.empty.hidden = true; return; }
    const has = !!S.el.log.firstElementChild;
    S.el.empty.hidden = has;
    if (!has && S.only) { S.el.empty.textContent = `В ленте нет сообщений ${dispName(S.only)}`; return; }
    if (has) return;
    if (S.room === 'ping') {
      S.el.empty.textContent = S.pg.all ? 'Пингов пока нет. Когда кто-то напишет @' + (S.me || 'твой_ник') + ' в шахте или городе, сообщение появится здесь.'
        : 'На этом канале пингов пока нет. Включи «Все каналы», чтобы увидеть пинги с других.';
    } else if (S.room === 'all') {
      const any = Object.keys(S.mix).some((k) => S.mix[k] && mixKinds().includes(k));
      S.el.empty.textContent = !any ? 'Все источники выключены — включи нужные над лентой.'
        : !S.mines.length && !S.inCity ? 'Войди в город, чтобы видеть его чат здесь.'
        : 'Здесь будут все чаты стримера: шахта и город.';
    } else S.el.empty.textContent = S.room === 'mine' ? (S.mines.length ? EMPTY.mine : 'На этом канале у тебя нет шахты — переключись на 🏰 Город.') : EMPTY[S.tab];
  }


  // ---------- 📣 Пинги: сообщения, где тебя позвали по @нику ----------
  // Ловятся во всех комнатах из того, что окно уже читает (шахта / город), и хранятся в браузере (300 последних, со всех каналов).
  // В комнате «Пинги» окно читает и шахту, и город, как «Всё», а показывает только пинги — свежие и сохранённые раньше.
  const PING_KEY = 'lgmc_pings', PING_SEEN = 'lgmc_pings_seen';
  S.pg = { list: [], seen: 0, all: true, sure: false, sureT: 0, saveT: 0 };
  const isPing = (m) => !!S.me && !m.sys && !m.ev && String(m.l || '').toLowerCase() !== S.me && new RegExp(`(^|[^a-z0-9_])@${S.me}(?![a-z0-9_])`, 'i').test(String(m.t || ''));
  function pingInit() {
    S.pg.list = (lsGet(PING_KEY, []) || []).filter((x) => x && x._key && x._ch);
    S.pg.seen = +lsGet(PING_SEEN, 0) || 0;
    S.pg.all = lsGet('lgmc_pings_all', true) !== false;
    if (!S.pg.seen) { S.pg.seen = Date.now(); lsSet(PING_SEEN, S.pg.seen); }   // первый запуск: старая история — не «новые»
    const back = () => { if (S.room === 'ping' && !hidden()) pingRead(); };   // окно было свёрнуто или в фоне — вернулся в «Пинги»: прочитано
    document.addEventListener('visibilitychange', back); window.addEventListener('focus', back);
    window.addEventListener('storage', (e) => {   // пинг поймало другое окно (или прочитали там)
      if (e.key !== PING_KEY && e.key !== PING_SEEN) return;
      S.pg.list = (lsGet(PING_KEY, []) || []).filter((x) => x && x._key && x._ch); S.pg.seen = +lsGet(PING_SEEN, 0) || 0;
      pingBadge(); if (S.room === 'ping') { const keep = S.stick; renderTabs(); renderLog(); if (keep) toBottom(); }
    });
  }
  function pingBoot() {
    pingBadge(); if (S.room === 'ping') pingRead();
  }
  // «прочитал пинги»: отметка — не раньше самого нового пинга (часы сервера могут спешить), сразу во всех окнах
  function pingRead(quiet) {
    const top = S.pg.list.reduce((a, x) => Math.max(a, x.at || 0), 0);
    const v = Math.max(S.pg.seen, Date.now(), top);
    if (v !== S.pg.seen) { S.pg.seen = v; lsSet(PING_SEEN, v); }
    if (!quiet) pingBadge();
  }
  function pingSave() { clearTimeout(S.pg.saveT); S.pg.saveT = setTimeout(() => lsSet(PING_KEY, S.pg.list), 300); pingBadge(); }
  function pingAdd(m) {
    const id = S.ch + '|' + m._key;
    if (S.pg.list.some((x) => x._ch + '|' + x._key === id)) return;
    const keep = ['id', 'l', 'n', 't', 'at', 'r', 'c', 'cn', 'aw', 'tb', 'k', '_src', '_key'];
    const p = { _ch: S.ch, _chn: S.chName }; for (const k of keep) if (m[k] != null) p[k] = m[k];
    if (!p.at) p.at = Date.now();
    S.pg.list.push(p); S.pg.list.sort((a, b) => (a.at || 0) - (b.at || 0));
    while (S.pg.list.length > 300) S.pg.list.shift();
    if (S.room === 'ping' && !hidden()) pingRead(true);
    pingSave(); awayNote('ping');
    // всплывашка — о пинге, которого нет перед глазами (в т. ч. пришедшем, пока окно было в другой комнате)
    if (S.room !== 'ping' && !visible(m) && p.at > S.pg.seen) pmToast(p.l, `📣 ${p.n || p.l}: ${String(p.t || '').slice(0, 80)}`, 'Пинги', 'ping');
  }
  function pingBadge() {
    const n = S.pg.list.filter((x) => (x.at || 0) > S.pg.seen).length;
    const b = S.el && S.el.room && S.el.room.querySelector('[data-r="ping"] .rb');
    if (b) { b.hidden = !n || S.room === 'ping'; b.textContent = n > 99 ? '99+' : String(n); b.parentElement.setAttribute('aria-label', n ? `Пинги, новых: ${n}` : 'Пинги'); }
  }
  function pingView() {   // сохранённые + свежие из ленты этого окна, без повторов, по времени
    const out = new Map();
    for (const p of S.pg.list) if (S.pg.all || p._ch === S.ch) out.set(p._ch + '|' + p._key, p);
    for (const m of S.list) if (isPing(m)) out.set(S.ch + '|' + m._key, Object.assign({ _ch: S.ch }, m));
    return [...out.values()].filter((m) => !S.ign.has(m.l) && !czHidden(m) && (!S.only || String(m.l || '').toLowerCase() === S.only)).sort((a, b) => (a.at || 0) - (b.at || 0));
  }


  // ---------- Поиск по сообщениям: Ctrl+F (⌘F) ----------
  // Ищет в том, что сейчас в ленте (шахта, город, «Всё», пинги, список диалогов или переписка): подсветка,
  // ↑ ↓ / Enter / Shift+Enter — по совпадениям, «Только найденные» — спрятать остальное. Новые сообщения проверяются сами.
  const FD = { q: '', hits: [], i: -1, only: false, t: 0, obs: null };
  const fnorm = (x) => x.toLowerCase().replace(/ё/g, 'е');
  function findInit() {
    S.el.fbar = document.getElementById('fbar'); S.el.fq = document.getElementById('fq'); S.el.fn = document.getElementById('fn');
    const keys = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyF' || e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А')) { e.preventDefault(); findOpen(); return; }
      if (e.key === 'F3') { e.preventDefault(); if (S.el.fbar.hidden) findOpen(); else findStep(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape' && !S.el.fbar.hidden && S.el.fbar.contains(e.target)) { e.preventDefault(); e.stopPropagation(); findClose(); }
    };
    document.addEventListener('keydown', keys, true);
    S.findKeys = keys;   // и в окне «поверх всех» (PiP) — pin() вешает его на тот документ
    S.el.fq.addEventListener('input', () => { clearTimeout(FD.t); FD.t = setTimeout(() => findRun(true), 120); });
    S.el.fq.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); findClose(); }
    });
    S.el.fbar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      const a = b.dataset.f;
      if (a === 'close') findClose();
      else if (a === 'only') { FD.only = !FD.only; b.setAttribute('aria-pressed', String(FD.only)); S.el.log.classList.toggle('fonly', FD.only && !!FD.q); if (FD.hits[FD.i]) FD.hits[FD.i].scrollIntoView({ block: 'center' }); }
      else findStep(a === 'prev' ? -1 : 1);
    });
    // лента перерисовалась или пришли новые — найти и в них (только прямые дети ленты: наши <mark> внутри строк не в счёт)
    FD.obs = new MutationObserver(() => { if (FD.q) { clearTimeout(FD.t); FD.t = setTimeout(() => findRun(false), 150); } });
    FD.obs.observe(S.el.log, { childList: true });
  }
  function findOpen() {
    const sel = String((S.pip ? S.pip.getSelection() : window.getSelection()) || '').trim();
    S.el.fbar.hidden = false;
    if (sel && sel.length <= 60 && !sel.includes('\n')) S.el.fq.value = sel;
    S.el.fq.focus(); S.el.fq.select();
    if (S.el.fq.value) findRun(true);
  }
  function findClose() {
    S.el.fbar.hidden = true; FD.q = ''; S.el.fq.value = '';
    findClear(); S.el.log.classList.remove('fonly'); S.el.fn.textContent = '';
    S.el.inp.focus();
  }
  function findClear() {
    for (const m of S.el.log.querySelectorAll('mark.fm')) { const p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
    for (const li of S.el.log.querySelectorAll('li.fhit')) li.classList.remove('fhit');
    FD.hits = []; FD.i = -1;
  }
  function findRun(jump) {
    const q = fnorm(S.el.fq.value.trim());
    const cur = FD.hits[FD.i] ? FD.hits[FD.i].closest('li') : null, curKey = cur && (cur.dataset.key || cur.dataset.id || cur.dataset.peer);
    findClear(); FD.q = q;
    S.el.log.classList.toggle('fonly', FD.only && !!q);
    if (!q) { S.el.fn.textContent = ''; S.el.fn.classList.remove('none'); return; }
    const skip = (n) => n.parentElement.closest('button, .t, .bt, .src, .ct, script, style');
    for (const li of S.el.log.children) {
      const tw = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (!n.nodeValue.trim() || skip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
      const nodes = []; while (tw.nextNode()) nodes.push(tw.currentNode);
      for (const n of nodes) {
        const low = fnorm(n.nodeValue); let at = low.indexOf(q); if (at < 0) continue;
        const f = document.createDocumentFragment(); let from = 0;
        while (at >= 0) {
          if (at > from) f.appendChild(document.createTextNode(n.nodeValue.slice(from, at)));
          const m = document.createElement('mark'); m.className = 'fm'; m.textContent = n.nodeValue.slice(at, at + q.length); f.appendChild(m); FD.hits.push(m);
          from = at + q.length; at = low.indexOf(q, from);
        }
        if (from < n.nodeValue.length) f.appendChild(document.createTextNode(n.nodeValue.slice(from)));
        n.parentNode.replaceChild(f, n);
        li.classList.add('fhit');
      }
    }
    // текущее: при наборе — самое свежее (снизу), при обновлении ленты — то же сообщение, что было
    let i = FD.hits.length - 1;
    if (!jump && curKey) { const k = FD.hits.findIndex((m) => { const l = m.closest('li'); return (l.dataset.key || l.dataset.id || l.dataset.peer) === curKey; }); if (k >= 0) i = k; }
    findGo(i, jump);
  }
  function findGo(i, scroll) {
    if (FD.hits[FD.i]) FD.hits[FD.i].classList.remove('cur');
    FD.i = FD.hits.length ? (i + FD.hits.length) % FD.hits.length : -1;
    const n = FD.hits.length;
    S.el.fn.textContent = n ? `${FD.i + 1} из ${n}` : 'нет';
    S.el.fn.classList.toggle('none', !n);
    const m = FD.hits[FD.i]; if (!m) return;
    m.classList.add('cur');
    if (scroll) { m.scrollIntoView({ block: 'center' }); S.stick = S.el.log.scrollHeight - S.el.log.scrollTop - S.el.log.clientHeight < 40; }
  }
  function findStep(d) { if (FD.hits.length) findGo(FD.i + d, true); else if (S.el.fq.value) findRun(true); }


  // ---------- 📍 Город, где стоит герой (Рябиново, Кошачий привал, Ярмарка…) ----------
  // Чат города у канала один на все города — писать можно откуда угодно. Но облачко над героем видно только там, где он стоит.
  // Встать в город — через саму игру: она помнит город во вкладке (sessionStorage lgCityTown) и открывает «Город» по #city,
  // сама ставит героя у ворот (раскладка города и проверка шагов — её). Список городов — GET /api/city/towns.
  const BIO_ICO = { meadow: '🌾', forest: '🌳', taiga: '🌲', ice: '❄️', mount: '⛰️', swamp: '🪷', ash: '🌋', desert: '🏜️', coast: '🌊', blight: '☠️', ruin: '🏚️' };
  async function townsLoad() {
    if (!S.me || (S.hero && !S.flags.cc)) { S.towns = null; return; }
    let r = null; try { r = await api('/api/city/towns'); } catch {}
    S.towns = r && r.ok ? { list: (r.list || []).filter((t) => t && t.id), here: r.here || '', fair: !!r.fair, quest: !!r.quest } : null;
    if (S.room === 'city' || isMix(S.room)) renderTabs();
  }
  const townName = (t) => (t.id === 'fair' ? 'Ярмарка' : t.id === 'camp' ? 'Кошачий привал' : t.town || t.name || t.id);
  function townChip() {
    const T = S.towns; if (!T || (!T.list.length && !T.fair)) return '';
    const here = T.list.find((t) => t.id === T.here) || T.list[0];
    return `<button type="button" class="town" data-town aria-haspopup="menu" title="Где стоит твой герой в Городе — облачко с сообщением видно там">📍 ${esc(here ? townName(here) : 'Ярмарка')}</button>`;
  }
  function townMenu(from) {
    modMenuClose(); nickMenuClose();
    const T = S.towns; if (!T) return;
    const doc = from.ownerDocument, items = [];
    for (const t of T.list) items.push([t.id, `${BIO_ICO[t.biome] || '🏘'} ${townName(t)}`, `${t.name && t.name !== townName(t) ? t.name : ''}${t.id === T.here ? (T.quest ? ' · здесь отряд похода' : ' · ты здесь') : ''}`]);
    if (T.fair && !T.list.some((t) => t.id === 'fair')) items.push(['fair', '🎪 Ярмарка', '']);
    const el = doc.createElement('div'); el.className = 'mm tm'; el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="mh">Встать в город<small>игра откроет «Город» там — герой встанет у ворот, его увидят другие, а твои сообщения появятся облачком над ним</small></div>` +
      items.map(([id, t, sub]) => `<button type="button" role="menuitem" data-tid="${esc(id)}">${esc(t)}${sub ? `<small style="display:block;color:var(--mut);font-weight:400">${esc(sub.replace(/^ · /, ''))}</small>` : ''}</button>`).join('') +
      `<div class="mh" style="border:0;padding-top:4px"><small>Писать в чат города можно и не вставая — его читают во всех городах канала.</small></div>`;
    doc.body.appendChild(el);
    const r = from.getBoundingClientRect(), vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    el.style.top = (r.bottom + 4 + h > vh - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-tid]'); if (!b) return; nickMenuClose(); townGo(b.dataset.tid); });
    const out = (e) => { if (!el.contains(e.target)) nickMenuClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nickMenuClose(); } };
    setTimeout(() => { doc.addEventListener('pointerdown', out, true); doc.addEventListener('keydown', key, true); }, 0);
    S.nmenu = { el, doc, out, key };
    const first = el.querySelector('button'); if (first) first.focus();
  }
  function townGo(id) {
    const t = S.towns && S.towns.list.find((x) => x.id === id), name = t ? townName(t) : 'Ярмарка';
    if (EMBED && window.parent !== window) {   // панель в игре: страница игры сама перейдёт в «Город» этого города
      try { window.parent.postMessage({ lgmc: 'town', id, ch: S.ch }, location.origin); okMsg(`Открываю «Город» в игре: ${name}`); return; } catch {}
    }
    // отдельное окно: новая вкладка игры получает копию sessionStorage этого окна — с выбранным городом
    try { if (id === 'fair') sessionStorage.removeItem('lgCityTown'); else sessionStorage.setItem('lgCityTown', id); } catch {}
    const w = window.open(`${ORIGIN}/c/${encodeURIComponent(S.ch)}/#city`, '_blank');
    okMsg(w ? `Открыл игру: «Город» — ${name}` : 'Браузер не дал открыть вкладку — разреши всплывающие окна для play.multidonate.ru');
  }

  // ---------- Вкладки города / фильтры общей ленты ----------
  const cityTabs = () => ['g', ...(S.flags.tr ? ['tr', 'ev'] : [])];
  const mixKinds = () => [...(S.mines.length ? ['mine'] : []), ...((!S.hero || S.flags.cc) ? cityTabs() : []), ...(S.flags.dm && S.me ? ['dm'] : [])];
  function renderTabs() {
    const show = S.room === 'city' || isMix(S.room);
    S.el.ctabs.hidden = !show;
    if (!show) return;
    if (S.room === 'ping') {   // какие пинги показывать и очистка
      S.el.ctabs.setAttribute('role', 'group'); S.el.ctabs.setAttribute('aria-label', 'Какие пинги');
      S.el.ctabs.innerHTML = `<button type="button" data-pg="ch" aria-pressed="${!S.pg.all}">Этот канал</button><button type="button" data-pg="all" aria-pressed="${S.pg.all}">Все каналы</button>${S.pg.list.length ? `<button type="button" data-pg="clear" class="pgc">${S.pg.sure ? 'Точно очистить?' : 'Очистить'}</button>` : ''}`;
      return;
    }
    if (S.room === 'all') {   // фильтры источников: что показывать в общей ленте
      S.el.ctabs.setAttribute('role', 'group'); S.el.ctabs.setAttribute('aria-label', 'Что показывать');
      S.el.ctabs.innerHTML = '<span class="lbl">Показывать:</span>' + mixKinds().map((k) => `<button type="button" data-mix="${k}" aria-pressed="${!!S.mix[k]}">${k === 'mine' ? '⛏ Шахта' : TABS[k]}</button>`).join('');
      return;
    }
    S.el.ctabs.setAttribute('role', 'tablist'); S.el.ctabs.removeAttribute('aria-label');
    const tabs = cityTabs();
    if (!tabs.includes(S.tab)) S.tab = 'g';
    S.el.ctabs.innerHTML = tabs.map((t) => `<button type="button" role="tab" data-tab="${t}" aria-selected="${t === S.tab}">${TABS[t]}${S.un[t] && t !== S.tab ? `<b>${S.un[t] > 99 ? '99+' : S.un[t]}</b>` : ''}</button>`).join('') + townChip();
  }
  function tabTo(t) {
    if (t === S.tab) return;
    S.tab = t; S.un[t] = 0; renderTabs();
    renderLog(); inputState(); toBottom();
  }

  // ---------- Личные: новая система игры (29.10) ----------
  // Переписка хранится на сервере: история — GET /api/dm?with=<ник>[&before=<id>], отправка — POST /api/dm/say { to, text },
  // жалоба — POST /api/dm/report { login, reason }. Новые личные приходят мгновенно событием «dm» канала /api/live (SSE).
  // Писать можно из любой комнаты — входить в город не нужно. Друзья и блок — /api/friends (если сервер открыл их входу).
  // Список диалогов (кто, последнее сообщение, прочитано ли) помнит браузер; вкладки собеседников общие с игрой (lgDm:<канал>:<ник>).
  S.pm = {
    conv: new Map(), more: new Map(), loaded: new Set(), loading: new Set(), last: {}, read: {}, names: {}, un: new Map(), total: 0,
    peer: null, drafts: {}, ban: null, es: null, esKey: '', esOk: false, esFails: 0, esT: 0, fbT: 0, boot: '', fr: null, frState: new Map(),
    filter: '', rep: false, toastT: 0, notify: false, sureT: 0, frT: 0, frOnline: null, view: 'all', frAlert: true,
    blocked: (l) => S.pm.frState.get(String(l || '').toLowerCase()) === 'blocked',
  };
  const PM_MAX = 300, MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const pmKey = (k) => `lgmc_pm${k}_${S.ch}_${S.me}`;
  const nickOf = (x) => { const l = String(x ?? '').toLowerCase().replace(/^@/, '').trim(); return /^[a-z0-9_]{1,25}$/.test(l) ? l : null; };
  const pmName = (l) => aliasOf(l) || S.pm.names[l] || l;
  // аватарка: значок класса героя (класс узнаём из сообщений чата — сайт отдаёт его вместе с ником), иначе — первая буква
  const clsOf = (l) => (l === S.me && S.myCls ? [S.myCls, S.myClsN] : ((seenMap().get(l) || [])[2] ? [seenMap().get(l)[2], seenMap().get(l)[3]] : null));
  function avIn(l, nm, cls = 'av') {
    const c = clsOf(l), name = nm != null ? String(nm) : pmName(l);
    return c && CLS_ICO[c[0]] ? `<span class="${cls} cl" style="--avc:${nkColor(l)}" title="${esc(c[1] || c[0])}" aria-hidden="true">${CLS_ICO[c[0]]}`
      : `<span class="${cls}" style="--avc:${nkColor(l)}" aria-hidden="true">${esc((name[0] || '?').toUpperCase())}`;
  }
  const avatar = (l, cls = 'av') => avIn(l, null, cls) + '</span>';
  const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
  const dayName = (t) => { const now = Date.now(); if (sameDay(t, now)) return 'Сегодня'; if (sameDay(t, now - 864e5)) return 'Вчера'; const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''}`; };
  const shortTime = (t) => (sameDay(t, Date.now()) ? hhmm(t) : (() => { const d = new Date(t); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`; })());
  const pmNorm = (m) => ({ id: String(m.id), fl: String(m.fl || m.l || '').toLowerCase(), fn: m.fn || m.n || m.fl || m.l, tl: String(m.tl || m.to || '').toLowerCase(), t: String(m.t ?? ''), at: +m.at || Date.now(), old: !!m.old });
  const pmPeerOf = (m) => (m.fl === S.me ? m.tl : m.fl);
  const pmSave = () => { lsSet(pmKey('last'), S.pm.last); lsSet(pmKey('read'), S.pm.read); lsSet(pmKey('names'), S.pm.names); };
  const pmSaveDrafts = () => { const d = {}; for (const [k, v] of Object.entries(S.pm.drafts)) if (v && v.trim()) d[k] = v.slice(0, 200); lsSet(pmKey('drafts'), d); };

  function pmReset() {
    const P = S.pm;
    if (P.es) { try { P.es.close(); } catch {} }
    clearTimeout(P.esT); clearInterval(P.fbT); clearTimeout(P.toastT); clearInterval(P.frT);
    Object.assign(P, { conv: new Map(), more: new Map(), loaded: new Set(), loading: new Set(), last: {}, read: {}, names: {}, un: new Map(), total: 0,
      peer: null, drafts: {}, ban: null, es: null, esKey: '', esOk: false, esFails: 0, fbT: 0, boot: '', fr: null, frState: new Map(), filter: '', rep: false, frT: 0, frOnline: null });
    pmBadge();
  }

  function pmInit() {
    S.pm.notify = lsGet('lgmc_pm_notify', false) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    S.pm.view = lsGet('lgmc_pm_view', 'all'); S.pm.frAlert = lsGet('lgmc_pm_fralert', true);
    nickMenuInit();
    S.el.pmtoast = document.getElementById('pmtoast');
    S.el.pmtoast.addEventListener('click', (e) => {
      const p = S.el.pmtoast.dataset.peer, w = S.el.pmtoast.dataset.where; S.el.pmtoast.hidden = true;
      if (e.target.closest('.x')) return;
      if (w === 'ping') { if (S.room !== 'ping') switchTo(S.ch, 'ping'); return; }
      if (w && w.startsWith('guild:')) { GD.cur = w.slice(6); GD.view = GD.cur ? 'chat' : 'home'; if (S.room !== 'guild') switchTo(S.ch, 'guild'); else { gdRender(true); inputState(); } return; }
      if (w === 'live') { try { window.open('https://www.twitch.tv/' + encodeURIComponent(p), '_blank'); } catch {} return; }
      if (w === 'tracc') { tradeAccept(p); return; }
      if (w === 'game') { tradeShowGame(); return; }
      if (w === 'list') { S.pm.peer = null; if (S.room !== 'pm') switchTo(S.ch, 'pm'); else pmRender(); return; }
      if (p) pmOpen(p);
    });
    let dT = 0;
    S.el.inp.addEventListener('input', () => { if (S.room === 'pm' && S.pm.peer) { S.pm.drafts[S.pm.peer] = S.el.inp.value; clearTimeout(dT); dT = setTimeout(pmSaveDrafts, 400); } });
    S.el.log.addEventListener('scroll', () => {   // долистал до верха переписки — подгрузить раньше
      if (S.room === 'pm' && S.pm.peer && S.el.log.scrollTop < 40 && S.pm.more.get(S.pm.peer)) pmLoad(S.pm.peer, true);
    });
  }

  // вход (или смена канала/игрока): память браузера, вкладки игры, старая переписка, канал событий, друзья, свежие диалоги
  function pmBoot() {
    if (!S.me || !S.flags.dm) { if (S.pm.boot) pmReset(); return; }
    const key = S.ch + ':' + S.me;
    if (S.pm.boot === key) { pmConnect(); return; }
    pmReset(); S.pm.boot = key;
    const P = S.pm;
    P.last = lsGet(pmKey('last'), {}) || {}; P.read = lsGet(pmKey('read'), {}) || {}; P.names = lsGet(pmKey('names'), {}) || {}; P.drafts = lsGet(pmKey('drafts'), {}) || {};
    // вкладки собеседников из лички самой игры
    const g = lsGet(`lgDm:${S.ch}:${S.me}`, null);
    for (const l of (g && Array.isArray(g.tabs) ? g.tabs : []).map(nickOf).filter((x) => x && x !== S.me)) if (!P.last[l]) P.last[l] = { at: 0, t: '', mine: false };
    // переписка из городского чата прошлых версий (до 29.10) — хранилась в браузере
    const old = lsGet('lgmc_dm_' + S.ch, []);
    if (Array.isArray(old) && old.length) {
      for (const x of old) {
        const m = pmNorm({ id: 'old:' + x.id, l: x.l, n: x.n, to: x.to, t: x.t, at: x.at, old: true });
        if (!m.tl || (m.fl !== S.me && m.tl !== S.me)) continue;
        const p = pmPeerOf(m); if (!nickOf(p)) continue;
        if (m.fl !== S.me && x.n) P.names[p] = P.names[p] || x.n;
        pmAdd(p, [m], false, true);
        P.read[p] = Math.max(P.read[p] || 0, m.at);   // старая переписка уже была прочитана в прежней версии
      }
    }
    pmConnect();
    friendsLoad();
    P.frT = setInterval(() => { if (!hidden()) friendsLoad(); }, 60000);
    // превью и непрочитанные: подгрузить несколько свежих диалогов по очереди
    const recent = Object.keys(P.last).sort((a, b) => (P.last[b].at || 0) - (P.last[a].at || 0)).slice(0, 10);
    (async () => { for (const l of recent) { if (S.pm.boot !== key) return; await pmLoad(l); } })();
    pmBadge();
  }

  // ---- канал событий: новые личные и заявки в друзья приходят сами ----
  function pmConnect() {
    const P = S.pm, key = S.ch + ':' + S.me;
    if (!S.me || !S.flags.dm || (P.es && P.esKey === key)) return;
    if (P.es) { try { P.es.close(); } catch {} }
    let es;
    try { es = new PES(BASE() + '/api/live'); } catch { P.es = null; pmFallback(true); return; }
    P.es = es; P.esKey = key;
    es.onopen = () => { P.esOk = true; P.esFails = 0; pmFallback(false); if (S.room === 'pm') { S.el.dot.className = 'ok'; S.el.dot.title = 'На связи'; } };
    es.onerror = () => {
      P.esOk = false;
      if (es.readyState === 2 && P.es === es) {   // закрыто насовсем — переподключиться позже, а пока опрашивать
        P.es = null; pmFallback(true);
        clearTimeout(P.esT); P.esT = setTimeout(pmConnect, Math.min(60000, 3000 * 2 ** P.esFails++));
      }
    };
    es.addEventListener('dm', (e) => { let d = null; try { d = JSON.parse(e.data); } catch {} if (d) pmEvent(d); });
    es.addEventListener('city', (e) => {
      let d = null; try { d = JSON.parse(e.data); } catch {} if (!d) return;
      if (d.tr !== undefined || d.trNote || d.trDone) tradeOn(d.tr, d);   // обмен: приглашения и итог
      // мгновенная лента города (подписка /api/chat/watch): новые сообщения — сразу, без ожидания опроса
      if ((d.chat || d.chatDel) && usesCity(S.room) && S.cityFeed && S.inCity) { S.liveAt = Date.now(); apply({ chat: d.chat, chatDel: d.chatDel, chatMe: d.chatMe, c: d.c }, 'city'); }
    });
    es.addEventListener('mine', (e) => {   // лента шахты — только если шахта одна (какая из нескольких — событие не говорит)
      let d = null; try { d = JSON.parse(e.data); } catch {} if (!d || d.chatRoom !== 'mine' || !(d.chat || d.chatDel)) return;
      if (usesMine(S.room) && S.mines.length === 1) { S.liveAt = Date.now(); apply({ chat: d.chat, chatDel: d.chatDel }, 'mine'); }   // номер ленты не берём: у опроса шахты свой
    });
    es.addEventListener('fr', (e) => {
      let d = null; try { d = JSON.parse(e.data); } catch {}
      friendsLoad();
      const u = d && d.from, l = u && nickOf(u.login), nm = u && (u.name || u.login);
      if (!l) return;
      if (u.name) S.pm.names[l] = u.name;
      if (d.k === 'in') pmToast(l, `👥 ${nm} зовёт тебя в друзья`, 'Открыть', 'list');
      if (d.k === 'ok') pmToast(l, `👥 ${nm} принял заявку — теперь вы друзья`, 'Написать');
      if (d.k === 'coin') pmToast(l, `🪙 ${nm} подарил тебе монету дня: +1 бронза`, 'Спасибо!');
    });
  }
  // без канала событий: раз в 15 с переспрашивать открытый диалог и пару свежих
  function pmFallback(on) {
    const P = S.pm; clearInterval(P.fbT); P.fbT = 0;
    if (!on) return;
    P.fbT = setInterval(() => {
      if (hidden()) return;
      const ls = [...new Set([P.peer, ...Object.keys(P.last).sort((a, b) => (P.last[b].at || 0) - (P.last[a].at || 0)).slice(0, 2)].filter(Boolean))];
      for (const l of ls) pmLoad(l, false, true);
    }, 15000);
  }

  function pmEvent(d) {
    const P = S.pm;
    if (d.me && 'dmBan' in d.me) {
      P.ban = d.me.dmBan || null;
      if (P.ban) S.el.err.textContent = 'Модератор закрыл тебе личку'; else okMsg('Личка снова открыта');
      inputState();
    }
    if (!d.m || !d.m.id) return;
    const m = pmNorm(d.m), mine = m.fl === S.me, l = nickOf(pmPeerOf(m)); if (!l) return;
    if (!mine && d.m.fn) P.names[l] = d.m.fn;
    const n = pmAdd(l, [m]);
    if (!n) return;
    const watching = S.room === 'pm' && P.peer === l && !hidden();
    if (!mine) {
      if (watching) pmMarkRead(l);
      else if (GD_KEYM.test(m.t)) { /* служебное: ключ для гильдии — чат обработает сам */ }
      else if (GD_INV.test(m.t)) { P.un.set(l, (P.un.get(l) || 0) + 1); pmToast(l, `⚜ ${pmName(l)} зовёт в гильдию`, 'Открыть', 'guild:'); czBeepOnce('dm', 'dm|' + (m.id || m.at)); }
      else { P.un.set(l, (P.un.get(l) || 0) + 1); awayNote('dm', l); pmToast(l, `✉ ${pmName(l)}: ${m.t}`, 'Ответить'); pmNotify(l, m); czBeepOnce('dm', 'dm|' + (m.id || m.at)); }
    }
    if (S.room === 'all') apply({ chat: [pmToFeed(m)] }, 'pm');
    if (S.room === 'pm') pmRender(P.peer === l);
    pmBadge();
  }

  // добавить сообщения в диалог (без повторов, по времени); вернуть, сколько новых
  function pmAdd(l, list, older, quiet) {
    const P = S.pm;
    const cur = P.conv.get(l) || [], ids = new Set(cur.map((x) => x.id));
    let n = 0;
    const fresh = [];
    for (const x of list) { const m = x.fl ? x : pmNorm(x); if (extHas(m.t)) { extAdd(m.fl); m.t = extStrip(m.t); } if (ids.has(m.id)) continue; ids.add(m.id); cur.push(m); fresh.push(m); n++; }
    if (fresh.length) gdScanDm(S.ch, fresh);
    if (!n && P.conv.has(l)) return 0;
    cur.sort((a, b) => a.at - b.at);
    if (cur.length > PM_MAX) cur.splice(0, cur.length - PM_MAX);
    P.conv.set(l, cur);
    const lm = cur[cur.length - 1];
    if (lm && (!P.last[l] || lm.at >= (P.last[l].at || 0))) P.last[l] = { at: lm.at, t: lm.t.slice(0, 120), mine: lm.fl === S.me };
    if (!quiet) pmSave();
    return n;
  }

  async function pmLoad(l, older, silent) {
    const P = S.pm, k = l + (older ? ':o' : '');
    if (!S.me || P.loading.has(k)) return;
    P.loading.add(k);
    const cur = P.conv.get(l) || [], first = cur.find((x) => !x.old);
    const before = older && first ? first.id : '';
    const prevH = S.el.log.scrollHeight;
    let r = null;
    try { r = await api(`/api/dm?with=${encodeURIComponent(l)}${before ? '&before=' + encodeURIComponent(before) : ''}`); } catch {}
    P.loading.delete(k);
    if (!r || !r.ok) { if (!silent && P.peer === l && S.room === 'pm') S.el.err.textContent = 'Личные: ' + ((r && (ERR[r.error] || r.error)) || 'переписка не загрузилась'); return; }
    if (r.with && r.with.name) P.names[l] = r.with.name;
    if (S.room === 'pm') { S.el.dot.className = 'ok'; S.el.dot.title = 'На связи'; }
    if (P.peer === l) inputState();   // имя собеседника могло прийти только сейчас
    const fresh = (r.list || []).map(pmNorm);
    // диалог впервые на этом устройстве — его история уже была (в игре или раньше): считаем прочитанной
    if (P.read[l] === undefined) P.read[l] = fresh.reduce((a, m) => Math.max(a, m.at), 0);
    const readAt = P.read[l] || 0;
    const n = pmAdd(l, fresh, older);
    if (!P.conv.has(l)) P.conv.set(l, []);
    P.more.set(l, !!r.more); P.loaded.add(l);
    if (!older) P.un.set(l, (P.conv.get(l) || []).filter((m) => m.fl === l && m.at > readAt).length);
    if (S.room === 'pm' && P.peer === l && !hidden()) pmMarkRead(l);
    pmSave(); pmBadge();
    if (S.room === 'pm') {
      if (P.peer === l) {
        pmRender(!older && S.stick);
        if (older) S.el.log.scrollTop += S.el.log.scrollHeight - prevH;   // подгрузили раньше — остаться на том же месте
      } else if (!P.peer) pmRender();
    }
    if (n && S.room === 'all') pmFeedFill();
  }

  function pmMarkRead(l) {
    const P = S.pm, L = P.conv.get(l) || [];
    const last = L.reduce((a, m) => Math.max(a, m.at), P.read[l] || 0);
    P.read[l] = last; P.un.set(l, 0); pmSave(); pmBadge();
  }

  function pmBadge() {
    const P = S.pm;
    P.total = [...P.un.values()].reduce((a, n) => a + n, 0);
    try { railChans(); } catch {}
    const b = S.el && S.el.room && S.el.room.querySelector('[data-r="pm"] .rb');
    if (b) { b.hidden = !P.total; b.textContent = P.total > 99 ? '99+' : String(P.total); b.parentElement.setAttribute('aria-label', P.total ? `Личные, непрочитанных: ${P.total}` : 'Личные'); }
    if (S.el) { const t = S.unseenTitle ? `(${S.unseenTitle}) ${title()}` : title(); document.title = t; if (S.pip) S.pip.document.title = t; }
  }

  // всплывашка о новом личном в любой комнате
  function pmToast(l, text, btn, where) {
    if (!l || !S.el.pmtoast) return;
    const t = S.el.pmtoast;
    t.dataset.peer = where === 'list' ? '' : l; t.dataset.where = where || '';   // tracc — ник того, кто зовёт меняться
    t.innerHTML = `<span>${esc(text)}</span><button type="button">${esc(btn || 'Открыть')}</button><button type="button" class="x" aria-label="Скрыть">✕</button>`;
    t.hidden = false;
    clearTimeout(S.pm.toastT); S.pm.toastT = setTimeout(() => { t.hidden = true; }, 8000);
  }
  // уведомление на рабочем столе — только если окно не на виду и уведомления включены
  function pmNotify(l, m) {
    if (!S.pm.notify || !hidden() && document.hasFocus()) return;
    try {
      const n = new Notification(`✉ ${pmName(l)}`, { body: m.t.slice(0, 160), tag: 'lgmc-' + l });
      n.onclick = () => { try { window.focus(); } catch {} pmOpen(l); n.close(); };
    } catch {}
  }

  // ---- классы для аватарок: игра отдаёт класс героя только рядом с его сообщениями в чатах шахты и города,
  // поэтому, открыв «Личные», читаем историю этих чатов (только чтение: город — если герой уже там, входить не будем)
  async function learnCls() {
    if (!S.me || Date.now() - (S.lcT || 0) < 300000) return;
    S.lcT = Date.now();
    const jobs = S.mines.map((m) => api(`/api/mine/state?c=${encodeURIComponent(m.id)}&mc=0`));
    if (!S.hero || S.flags.cc) jobs.push(api('/api/chat/feed?room=city').then((r) => (r && r.ok ? r : api('/api/city/state?c=0'))));
    const rs = await Promise.allSettled(jobs);
    let n = 0;
    for (const x of rs) {
      const r = x.value, chat = r && r.ok ? (r.mchat ? r.mchat.chat : r.chat) || [] : [];
      for (const m of chat) if (m && m.l && m.c) { const had = (seenMap().get(String(m.l).toLowerCase()) || [])[2]; seenAdd(m.l, m.n, m.at, m.c, m.cn); if (!had) n++; }
    }
    if (n && S.room === 'pm') { if (S.pm.peer) pmBar(); else pmRefresh(); }
  }

  // ---- комната «✉ Личные» ----
  function pmEnter() {
    learnCls();
    S.el.log.classList.add('pm');
    if (S.pm.esOk) { S.el.dot.className = 'ok'; S.el.dot.title = 'На связи'; }
    if (S.pm.peer && !S.pm.loaded.has(S.pm.peer)) pmLoad(S.pm.peer);
    pmRender(true);
    inputState();
  }

  async function pmOpen(peer, name) {
    const l = nickOf(peer); if (!l || l === S.me) return;
    if (!S.flags.dm || !S.me) { S.el.err.textContent = 'Личные сообщения на этом канале выключены'; return; }
    if (name) { S.pm.names[l] = name; pmSave(); }
    if (S.pm.peer && S.room === 'pm') S.pm.drafts[S.pm.peer] = S.el.inp.value;
    S.pm.peer = l; S.pm.rep = false;
    if (!S.pm.last[l]) S.pm.last[l] = { at: 0, t: '', mine: false };
    pmGameTab(l);
    if (S.room !== 'pm') await switchTo(S.ch, 'pm');
    if (S.pm.peer !== l) return;
    pickerOpen(false, true); pastesOpen(false, true);
    S.el.inp.value = S.pm.drafts[l] || '';
    pmRender(true); pmMarkRead(l); inputState();
    if (!S.pm.loaded.has(l)) pmLoad(l);
    if (!S.el.inp.disabled) S.el.inp.focus();
  }
  function pmBack() {
    const P = S.pm;
    if (P.peer) P.drafts[P.peer] = S.el.inp.value;
    P.peer = null; P.rep = false; S.el.inp.value = '';
    pmRender(); inputState();
    const f = S.el.dmbar.querySelector('input'); if (f) f.focus();
  }
  // вкладки собеседников — общие с личкой игры (до 8, как там)
  function pmGameTab(l) {
    const k = `lgDm:${S.ch}:${S.me}`, v = lsGet(k, null) || {};
    let tabs = Array.isArray(v.tabs) ? v.tabs.map(nickOf).filter((x) => x && x !== S.me) : [];
    tabs = tabs.filter((x) => x !== l); tabs.push(l);
    while (tabs.length > 8) tabs.shift();
    lsSet(k, Object.assign({}, v, { tabs, active: l }));
  }

  function pmBar() {
    const bar = S.el.dmbar, P = S.pm;
    const show = S.room === 'pm';
    bar.hidden = !show;
    if (!show) { bar.innerHTML = ''; return; }
    if (!P.peer) {
      const bell = typeof Notification !== 'undefined';
      bar.innerHTML = `<form autocomplete="off" style="flex:1;display:flex;gap:6px;min-width:0"><input id="pmq" maxlength="26" placeholder="Найти игрока или диалог: ник" aria-label="Найти игрока или диалог по нику — подходят и похожие ники" value="${esc(P.filter)}"><button type="submit">Написать</button></form>${bell ? `<span class="acts"><button type="button" class="bell" data-pa="bell" aria-pressed="${P.notify}" title="${P.notify ? 'Уведомления на рабочем столе включены' : 'Уведомлять на рабочем столе о новых личных'}">🔔</button></span>` : ''}${S.meFriends ? `<span class="acts"><button type="button" class="bell" data-pa="fralert" aria-pressed="${P.frAlert}" title="${P.frAlert ? 'Сообщаю, когда друзья заходят в игру' : 'Не сообщаю, когда друзья заходят в игру'}">🟢</button></span>` : ''}`;
      const inp = bar.querySelector('#pmq');
      inp.oninput = () => { P.filter = inp.value; pmRender(); const i = S.el.dmbar.querySelector('#pmq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } };
      bar.querySelector('form').onsubmit = (e) => {
        e.preventDefault();
        const v = nickOf(inp.value);
        if (!v || v.length < 2) { inp.focus(); return; }
        if (v === S.me) { S.el.err.textContent = 'Самому себе написать нельзя'; return; }
        P.filter = ''; pmOpen(v);
      };
      const fa = bar.querySelector('[data-pa="fralert"]');
      if (fa) fa.onclick = () => { P.frAlert = !P.frAlert; lsSet('lgmc_pm_fralert', P.frAlert); pmBar(); okMsg(P.frAlert ? 'Скажу, когда друзья зайдут в игру' : 'Не буду говорить, когда друзья заходят'); };
      const bb = bar.querySelector('[data-pa="bell"]');
      if (bb) bb.onclick = async () => {
        if (P.notify) { P.notify = false; lsSet('lgmc_pm_notify', false); pmBar(); return; }
        let perm = Notification.permission;
        if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch {} }
        if (perm !== 'granted') { S.el.err.textContent = 'Браузер не разрешил уведомления — включи их для play.multidonate.ru в настройках сайта'; return; }
        P.notify = true; lsSet('lgmc_pm_notify', true); pmBar(); okMsg('Уведомления о личных включены');
      };
      return;
    }
    const l = P.peer, st = P.frState.get(l), f = pmFriend(l);
    // друг в шахте или в городе — можно перейти в тот же чат
    const goRoom = f && f.on ? (f.on.w === 'mine' ? 'mine' : f.on.w === 'city' ? 'city' : null) : null;
    const goCh = f && f.on && nickOf(f.on.ch) ? nickOf(f.on.ch) : S.ch;
    const go = goRoom ? `<button type="button" class="go" data-pa="go" data-room="${goRoom}" data-ch="${esc(goCh)}" title="Открыть чат ${goRoom === 'mine' ? 'шахты' : 'города'}${goCh !== S.ch ? ' канала ' + esc(goCh) : ''}">${goRoom === 'mine' ? '⛏' : '🏰'} туда</button>` : '';
    const status = f ? (f.on ? `<small class="on">● ${esc(f.on.t || 'в сети')}${f.on.ch && f.on.ch !== S.ch ? ' · ' + esc(f.on.ch) : ''}${go}</small>` : '<small>не в сети</small>')
      : st === 'blocked' ? '<small>заблокирован</small>' : st === 'out' ? '<small>заявка в друзья отправлена</small>' : st === 'in' ? '<small>хочет в друзья</small>' : '<small>Читаете только вы двое</small>';
    if (P.rep) {
      bar.innerHTML = `<form class="rep" autocomplete="off"><p>Пожаловаться на ${esc(pmName(l))}? Модераторы канала увидят последние 30 сообщений вашей переписки.</p><input id="pmr" maxlength="300" placeholder="Что случилось (можно пусто)" aria-label="Причина жалобы"><div><button type="button" data-pa="norep">Отмена</button><button type="submit" class="pbtn">Отправить жалобу</button></div></form>`;
      bar.querySelector('[data-pa="norep"]').onclick = () => { P.rep = false; pmBar(); };
      bar.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        let r = null; try { r = await api('/api/dm/report', { login: l, reason: bar.querySelector('#pmr').value.trim().slice(0, 300) }); } catch {}
        if (r && r.ok) { P.rep = false; pmBar(); okMsg('Жалоба отправлена модераторам канала'); }
        else S.el.err.textContent = 'Жалоба: ' + ((r && (ERR[r.error] || r.error)) || 'нет связи');
      };
      bar.querySelector('#pmr').focus();
      return;
    }
    const fr = S.meFriends ? (st === 'friends' ? '' : st === 'out' ? '' : st === 'in' ? '<button type="button" data-pa="accept" title="Принять заявку в друзья">👥 Принять</button>' : st === 'blocked' ? '' : '<button type="button" data-pa="add" title="Добавить в друзья">👥＋</button>') : '';
    const blk = S.meFriends ? (st === 'blocked' ? '<button type="button" data-pa="unblock">Разблокировать</button>' : '<button type="button" data-pa="block" title="Заблокировать — не сможет писать тебе">🚫</button>') : '';
    bar.innerHTML = `<button type="button" data-pa="back" title="К диалогам (Esc)" aria-label="К диалогам">←</button><span class="who">${avatar(l)}<span style="min-width:0"><b style="color:${ncol(l)}">${esc(pmName(l))}${extBadge(l)}${f ? ' <span class="frm" title="Друг">👥</span>' : ''}</b>${status}</span></span><span class="acts">${f ? coinBtn(f) + '<button type="button" data-pa="trade" title="Предложить обмен (окно обмена откроется в игре, в «Городе»)">🔄</button>' : ''}${fr}${blk}<button type="button" data-pa="report" title="Пожаловаться модераторам">⚑</button></span>`;
    bar.onclick = async (e) => {
      const cn = e.target.closest('[data-coin]');
      if (cn) { if (cn.getAttribute('aria-disabled') !== 'true') { cn.setAttribute('aria-disabled', 'true'); giveCoin(cn.dataset.coin); } return; }
      const b = e.target.closest('[data-pa]'); if (!b) return;
      const a = b.dataset.pa;
      if (a === 'back') return pmBack();
      if (a === 'go') { if (S.pm.peer) { S.pm.drafts[S.pm.peer] = S.el.inp.value; pmSaveDrafts(); } return switchTo(b.dataset.ch, b.dataset.room); }
      if (a === 'report') { P.rep = true; return pmBar(); }
      if (a === 'trade') return tradeInvite(l);
      if (a === 'block' && !b.classList.contains('sure')) {   // блок — в два нажатия
        b.classList.add('sure'); b.textContent = 'Точно заблокировать?';
        clearTimeout(P.sureT); P.sureT = setTimeout(() => { if (b.isConnected) { b.classList.remove('sure'); b.textContent = '🚫'; } }, 4000);
        return;
      }
      if (['add', 'accept', 'block', 'unblock'].includes(a)) { b.disabled = true; await friendAct(a, l); }
    };
  }

  function pmClick(e) {
    const P = S.pm;
    const cn = e.target.closest('[data-coin]');
    if (cn) { if (cn.getAttribute('aria-disabled') !== 'true') { cn.setAttribute('aria-disabled', 'true'); giveCoin(cn.dataset.coin); } return; }
    if (e.target.closest('[data-pa="giftall"]')) { giveCoin(null); return; }
    const pv = e.target.closest('[data-pv]');
    if (pv) { P.view = pv.dataset.pv; lsSet('lgmc_pm_view', P.view); pmRender(); return; }
    const fc = e.target.closest('.fchip');
    if (fc) { pmOpen(fc.dataset.peer, fc.dataset.n); return; }
    const fa = e.target.closest('[data-fa]');
    if (fa) { const li = fa.closest('[data-peer]'); if (li) { fa.disabled = true; friendAct(fa.dataset.fa, li.dataset.peer); } return; }
    if (e.target.closest('[data-pa="older"]')) { pmLoad(P.peer, true); return; }
    if (e.target.closest('[data-pa="blocks"]')) { P.showBlocks = !P.showBlocks; pmRender(); return; }
    const cv = e.target.closest('li.conv');
    if (cv && cv.dataset.peer) pmOpen(cv.dataset.peer, cv.dataset.n);
  }

  function pmRender(stick) {
    const P = S.pm, log = S.el.log;
    if (S.room !== 'pm') return;
    log.classList.add('pm'); S.el.empty.hidden = true;
    pmBar();
    const f = document.createDocumentFragment();
    const li = (cls, html, attrs) => { const x = document.createElement('li'); if (cls) x.className = cls; x.innerHTML = html; if (attrs) for (const [k, v] of Object.entries(attrs)) x.setAttribute(k, v); f.appendChild(x); return x; };
    if (!P.peer) {
      // ---- список: заявки, диалоги, друзья без диалога, заблокированные ----
      const q = P.filter.trim().toLowerCase().replace(/^@/, '');
      const match = (l) => !q || l.includes(q) || pmName(l).toLowerCase().includes(q);
      const fr = P.fr;
      const isFr = (l) => P.frState.get(l) === 'friends';
      // полоса друзей: кто в сети — первыми, клик — сразу в переписку
      const fl = fr && fr.friends ? fr.friends.map((u) => Object.assign({}, u, { l: nickOf(u.login) })).filter((u) => u.l) : [];
      fl.sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0) || ((P.last[b.l] || {}).at || 0) - ((P.last[a.l] || {}).at || 0) || pmName(a.l).localeCompare(pmName(b.l)));
      if (fl.length && !q) {
        li('strip', fl.map((u) => { const un = P.un.get(u.l) || 0; return `<button type="button" class="fchip${u.on ? '' : ' off'}" data-peer="${esc(u.l)}" data-n="${esc(pmName(u.l))}" title="${esc(pmName(u.l))} — ${u.on ? esc(u.on.t || 'в сети') : 'не в сети'}">${avIn(u.l, pmName(u.l))}${u.on ? '<i class="on"></i>' : ''}${un ? `<i class="cu">${un > 99 ? '99+' : un}</i>` : ''}</span><span class="nm">${esc(pmName(u.l))}</span></button>`; }).join(''), { role: 'list', 'aria-label': 'Друзья' });
      }
      const anyUn = [...P.un.values()].some(Boolean);
      if (!q && (fl.length || anyUn)) li('filt', [['all', 'Все'], ['fr', 'Друзья'], ['un', 'Непрочитанные']].map(([k, t]) => `<button type="button" data-pv="${k}" aria-pressed="${P.view === k}">${t}</button>`).join(''), { role: 'group', 'aria-label': 'Показывать' });
      const view = q ? 'all' : P.view;
      const inView = (l) => view === 'all' || (view === 'fr' && isFr(l)) || (view === 'un' && (P.un.get(l) || 0) > 0);
      if (fr && fr.in && fr.in.length && !q && view !== 'un') {
        li('sec', 'Заявки в друзья');
        for (const u of fr.in) {
          const l = nickOf(u.login); if (!l) continue;
          if (u.name) P.names[l] = u.name;
          li('conv', `${avatar(l)}<span class="cv"><b>${esc(pmName(l))}</b><span>хочет добавить тебя в друзья</span></span><span class="acts"><button type="button" class="ok" data-fa="accept">Принять</button><button type="button" data-fa="decline">Отклонить</button></span>`, { 'data-peer': l, 'data-n': pmName(l) });
        }
      }
      const peers = Object.keys(P.last).filter((l) => nickOf(l) && l !== S.me && !P.blocked(l) && match(l) && inView(l))
        .sort((a, b) => ((P.un.get(b) ? 1 : 0) - (P.un.get(a) ? 1 : 0)) || ((P.last[b].at || 0) - (P.last[a].at || 0)));
      if (peers.length) li('sec', view === 'fr' ? 'Переписка с друзьями' : view === 'un' ? 'Непрочитанные' : 'Диалоги');
      for (const l of peers) {
        const x = P.last[l], u = P.un.get(l) || 0, fd = pmFriend(l);
        const prev = x.t ? `${x.mine ? 'Ты: ' : ''}${esc(x.t)}` : (P.drafts[l] ? `Черновик: ${esc(P.drafts[l])}` : 'Нет сообщений — напиши первым');
        li('conv', `${avIn(l, pmName(l))}${fd && fd.on ? '<i class="on"></i>' : ''}</span><span class="cv"><b style="color:${ncol(l)}">${esc(pmName(l))}${extBadge(l)}${isFr(l) ? ' <span class="frm" title="Друг">👥</span>' : ''}</b><span>${prev}</span></span>${x.at ? `<span class="ct">${shortTime(x.at)}</span>` : ''}${u ? `<span class="cu">${u > 99 ? '99+' : u}</span>` : ''}`,
          { tabindex: '0', 'data-peer': l, 'data-n': pmName(l), 'aria-label': `Диалог с ${pmName(l)}${u ? `, непрочитанных: ${u}` : ''}` });
      }
      const friends = view === 'un' ? [] : fl.filter((u) => !P.last[u.l] && match(u.l));
      friends.sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0) || pmName(a.l).localeCompare(pmName(b.l)));
      const canGift = fl.filter((u) => u.coin === 'ok').length;
      if (friends.length || (canGift && view !== 'un' && !q)) li('sec', `Друзья${fr.friends ? ` · ${fr.friends.length}${fr.max ? '/' + fr.max : ''}` : ''}${canGift > 1 ? `<button type="button" class="gift" data-pa="giftall" title="Подарить монету дня всем, кому можно">🪙 Подарить всем (${canGift})</button>` : ''}`);
      for (const u of friends) {
        if (u.name) P.names[u.l] = u.name;
        li('conv', `${avIn(u.l, pmName(u.l))}${u.on ? '<i class="on"></i>' : ''}</span><span class="cv"><b style="color:${ncol(u.l)}">${esc(pmName(u.l))}</b><span class="${u.on ? 'st' : ''}">${u.on ? esc(u.on.t || 'в сети') + (u.on.ch && u.on.ch !== S.ch ? ' · ' + esc(u.on.ch) : '') : 'не в сети'}</span></span><span class="acts">${coinBtn(u)}</span>`,
          { tabindex: '0', 'data-peer': u.l, 'data-n': pmName(u.l), 'aria-label': `Написать ${pmName(u.l)}` });
      }
      // ---- игроки с похожим ником: найти друга, позвать нового ----
      if (q.length >= 2 && psVariants(q).length) {
        psWant(q);
        const shown = new Set([...peers, ...friends.map((u) => u.l)]);
        const res = psResults(q, shown);
        if (res.length || PS.busy || PS.err) li('sec', `Игроки${PS.busy ? ' <small>· ищу на сайте…</small>' : PS.err ? ` <small>· ${esc(PS.err)}</small>` : ''}`);
        for (const x of res) {
          if (x.name && !P.names[x.l]) P.names[x.l] = x.name;
          const st = P.frState.get(x.l), fd = pmFriend(x.l);
          const sub = fd ? (fd.on ? esc(fd.on.t || 'в сети') : 'друг · не в сети') : st === 'out' ? 'заявка в друзья отправлена' : st === 'in' ? 'зовёт тебя в друзья' : st === 'blocked' ? 'в блоке' : x.seen ? `видели в чате · ${shortTime(x.seen)}` : 'есть в игре';
          const act = !S.meFriends ? '' : st === 'friends' ? '' : st === 'out' ? '<button type="button" data-fa="cancel" title="Отменить заявку в друзья">Отменить</button>'
            : st === 'in' ? '<button type="button" class="ok" data-fa="accept">Принять</button>' : st === 'blocked' ? '<button type="button" data-fa="unblock">Разблокировать</button>'
            : '<button type="button" class="ok" data-fa="add" title="Позвать в друзья">👥＋</button>';
          const nm = pmName(x.l);
          li('conv pl', `${avIn(x.l, nm)}${fd && fd.on ? '<i class="on"></i>' : ''}</span><span class="cv"><b style="color:${ncol(x.l)}">${esc(nm)}${nm.toLowerCase() !== x.l ? ` <small class="lg">${esc(x.l)}</small>` : ''}${st === 'friends' ? ' <span class="frm" title="Друг">👥</span>' : ''}</b><span class="${fd && fd.on ? 'st' : ''}">${sub}</span></span><span class="acts"><button type="button" data-pa="dmto" title="Написать лично" aria-label="Написать ${esc(nm)}">✉</button>${act}</span>`,
            { tabindex: '0', 'data-peer': x.l, 'data-n': nm, 'aria-label': `${nm}: ${sub.replace(/<[^>]+>/g, '')}` });
        }
      } else PS.key = '';
      const blocks = fr && fr.blocks ? fr.blocks.map((u) => Object.assign({}, u, { l: nickOf(u.login) })).filter((u) => u.l) : [];
      if (blocks.length && !q && view === 'all') {
        li('sec', `<button type="button" data-pa="blocks" style="all:unset;cursor:pointer">${P.showBlocks ? '▾' : '▸'} Заблокированные · ${blocks.length}</button>`);
        if (P.showBlocks) for (const u of blocks) li('conv', `${avatar(u.l)}<span class="cv"><b>${esc(u.name || u.l)}</b><span>не может писать тебе</span></span><span class="acts"><button type="button" data-fa="unblock">Разблокировать</button></span>`, { 'data-peer': u.l });
      }
      if (!f.querySelector('li.conv')) li('pm0', view === 'un' && !q ? '<b>Всё прочитано</b>Новых личных нет.' : view === 'fr' && !q ? (fl.length ? '<b>С друзьями пока не переписывались</b>Нажми на друга в полосе сверху.' : '<b>Друзей пока нет</b>Найди игрока по нику в поиске сверху (подойдёт и похожий ник) или нажми правой кнопкой на ник в чате.') : q ? (PS.busy ? '<b>Ищу игроков…</b>' : `<b>Никого похожего</b>Проверь ник или нажми «Написать», чтобы начать диалог с <b style="display:inline">${esc(q)}</b>.`) : '<b>Личных пока нет</b>Нажми ✉ у ника в чате шахты или города, впиши ник выше или напиши в поле внизу «@ник текст».');
    } else {
      // ---- переписка: пузыри, дни, «показать раньше» ----
      const l = P.peer, L = P.conv.get(l) || [];
      if (P.more.get(l)) li('pmmore', `<button type="button" data-pa="older">${P.loading.has(l + ':o') ? 'Загружаю…' : 'Показать раньше'}</button>`);
      if (P.blocked(l)) li('pm0', `<b>Ты заблокировал ${esc(pmName(l))}</b>Он не может тебе писать. Разблокировать можно кнопкой вверху.`);
      let prev = null;
      for (const m of L) {
        if (!prev || !sameDay(prev.at, m.at)) li('day', dayName(m.at));
        const me = m.fl === S.me, cont = prev && prev.fl === m.fl && sameDay(prev.at, m.at) && m.at - prev.at < 5 * 60000;
        li(`b${me ? ' me' : ''}${cont ? ' cont' : ''}`, `${fmtText(m.t)}<span class="bt" title="${esc(new Date(m.at).toLocaleString('ru-RU'))}">${hhmm(m.at)}</span><button type="button" class="cpb" title="Скопировать сообщение" aria-label="Скопировать сообщение">⧉</button>`, { 'data-id': m.id });
        prev = m;
      }
      if (!L.length && !P.blocked(l)) li('pm0', P.loaded.has(l) ? `<b>Здесь пока пусто</b>Напиши первым — читаете только вы двое.` : 'Загружаю переписку…');
    }
    log.innerHTML = ''; log.appendChild(f);
    if (P.peer && stick) toBottom();
  }

  // ---- отправка ----
  async function pmSay(t, tg) {
    const P = S.pm;
    let to = tg === 'pm' ? P.peer : null, text = t;
    const m = t.match(/^@([a-z0-9_]{1,25})\s+([\s\S]+)$/i);
    if (m && (!to || nickOf(m[1]) !== to)) { to = nickOf(m[1]); text = m[2].trim(); }
    if (!to) { S.el.err.textContent = 'Чтобы написать лично, начни с @ника: «@ник привет» — или выбери диалог'; return; }
    if (to === S.me) { S.el.err.textContent = 'Самому себе написать нельзя'; return; }
    if (P.blocked(to)) { S.el.err.textContent = `${pmName(to)} заблокирован — сначала разблокируй`; return; }
    S.el.send.disabled = true;
    let r = null;
    try { r = await api('/api/dm/say', { to, text: markOut(text) }); } catch {}
    if (CZ.extTell !== false) extAdd(S.me);
    S.el.send.disabled = false;
    if (r && r.ok) {
      S.el.err.textContent = '';
      const msg = r.msg ? Object.assign({}, r.msg, { t: extStrip(r.msg.t) }) : { id: 'local:' + Date.now(), fl: S.me, fn: S.me, tl: to, t: text, at: Date.now() };
      pmEvent({ m: msg });
      if (tg === 'pm') {
        S.el.inp.value = ''; delete P.drafts[to]; pmSaveDrafts();
        if (P.peer !== to) await pmOpen(to); else pmRender(true);
      } else S.el.inp.value = `@${to} `;
    } else {
      const e = (r && r.error) || 'не отправилось — нет связи';
      if (/закрыл тебе личку/.test(e)) { P.ban = P.ban || { until: 0 }; inputState(); }
      S.el.err.textContent = 'Личные: ' + (ERR[e] || e);
    }
    if (!S.el.inp.disabled) S.el.inp.focus();
  }

  // личные в общей ленте «🔀 Всё»
  const pmToFeed = (m) => ({ id: m.id, l: m.fl, n: m.fl === S.me ? S.me : (S.pm.names[m.fl] || m.fn || m.fl), t: m.t, at: m.at, k: 'dm', to: m.fl === S.me ? pmName(m.tl) : S.me });
  function pmFeedFill() {
    const all = [];
    for (const L of S.pm.conv.values()) for (const m of L) if (!m.old) all.push(m);
    all.sort((a, b) => a.at - b.at);
    if (all.length) apply({ chat: all.slice(-40).map(pmToFeed) }, 'pm', true);
  }

  // ---- друзья и блок (если сервер открыл их этому входу) ----
  const pmFriend = (l) => (S.pm.fr && S.pm.fr.friends ? S.pm.fr.friends.find((u) => String(u.login).toLowerCase() === l) : null);
  async function friendsLoad() {
    if (!S.meFriends || !S.me) return;
    const key = S.pm.boot;
    let r = null; try { r = await api('/api/friends'); } catch {}
    if (!r || !r.ok || S.pm.boot !== key) return;
    const P = S.pm;
    // друг зашёл в игру (был не в сети) — сказать, если включено
    const online = new Map((r.friends || []).filter((u) => u.on).map((u) => [String(u.login).toLowerCase(), u]));
    if (P.frOnline && P.frAlert) for (const [l, u] of online) if (!P.frOnline.has(l)) {
      pmToast(l, `🟢 ${u.name || u.login} в сети — ${u.on.t || 'в игре'}`, 'Написать'); awayNote('fr', l, u.name || u.login);
      if (P.notify && hidden()) try { const n = new Notification(`🟢 ${u.name || u.login} в сети`, { body: u.on.t || '', tag: 'lgmc-on-' + l }); n.onclick = () => { try { window.focus(); } catch {} pmOpen(l); n.close(); }; } catch {}
    }
    P.frOnline = new Set(online.keys());
    const sig0 = [...P.frState].filter(([, v]) => v === 'friends').map(([k]) => k).sort().join(',');
    P.fr = r; P.frState = new Map();
    for (const u of r.friends || []) P.frState.set(String(u.login).toLowerCase(), 'friends');
    for (const u of r.out || []) P.frState.set(String(u.login).toLowerCase(), 'out');
    for (const u of r.in || []) P.frState.set(String(u.login).toLowerCase(), 'in');
    for (const u of r.blocks || []) P.frState.set(String(u.login).toLowerCase(), 'blocked');
    for (const u of [...(r.friends || []), ...(r.in || []), ...(r.out || [])]) { const l = nickOf(u.login); if (l && u.name) P.names[l] = u.name; }
    const sig1 = [...P.frState].filter(([, v]) => v === 'friends').map(([k]) => k).sort().join(',');
    if (S.room === 'pm') pmRender();
    else if (sig0 !== sig1 && S.list.length) { const keep = S.stick; renderLog(); if (keep) toBottom(); }   // список друзей изменился — отметки 👥 у ников
  }
  const COIN_T = { given: 'Сегодня уже подарил — завтра снова', young: 'Дружбе меньше суток — завтра можно', dead: 'Герой друга пал — монета только живым', nohero: 'У друга нет героя на этом канале' };
  // монета дня: уже подарил сегодня — кнопки нет (вернётся завтра сама); нельзя по другой причине — серая с объяснением
  const coinBtn = (u) => { if (!u || !u.coin || u.coin === 'given') return ''; const ok = u.coin === 'ok', t = ok ? `Монета дня: подарить ${u.name || u.login} 1 бронзовую` : COIN_T[u.coin] || 'Сейчас нельзя'; return `<button type="button" class="coin" data-coin="${esc(u.id)}"${ok ? '' : ' aria-disabled="true"'} title="${esc(t)}" aria-label="${esc(t)}">🪙</button>`; };
  async function giveCoin(id) {
    const P = S.pm, rid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let r = null; try { r = await api('/api/friends/coin', id ? { to: id, rid } : { all: 1, rid }); } catch {}
    if (!r || !r.ok) { S.el.err.textContent = 'Монета дня: ' + ((r && ({ rate_limited: 'слишком часто — подожди минуту' }[r.error] || r.error)) || 'нет связи'); return; }
    if (P.fr) for (const f of P.fr.friends || []) if ((r.to || (id ? [id] : [])).includes(f.id)) f.coin = 'given';   // сразу серая, игра подтвердит
    okMsg(r.n > 1 ? `Дарим монету дня: ${r.n} друзьям…` : 'Дарим монету дня…');
    if (S.room === 'pm') pmRender();
    setTimeout(friendsLoad, 3000);
  }
  function nickMenuInit() {
    let lpT = 0;
    const target = (e) => { const n = e.target.closest && e.target.closest('#log .n[data-l]'); return n && S.room !== 'pm' ? n : null; };
    S.el.log.addEventListener('contextmenu', (e) => { const n = target(e); if (!n) return; e.preventDefault(); nickMenu(n); });
    S.el.log.addEventListener('pointerdown', (e) => {   // телефон: долгое нажатие
      if (e.pointerType !== 'touch') return; const n = target(e); if (!n) return;
      clearTimeout(lpT); lpT = setTimeout(() => nickMenu(n), 550);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) S.el.log.addEventListener(ev, () => clearTimeout(lpT));
  }
  function nickMenu(from) {
    modMenuClose(); nickMenuClose();
    const l = nickOf(from.dataset.l); if (!l || l === S.me) return;
    const doc = from.ownerDocument, st = S.pm.frState.get(l), name = from.textContent || l, f = pmFriend(l);
    const items = [];
    if (S.flags.dm && st !== 'blocked') items.push(['dm', '✉ Написать лично']);
    items.push(['reply', '↩ Ответить в этом чате']);
    if (S.room !== 'pm' && S.room !== 'guild') items.push(S.only === l ? ['onlyoff', '👁 Показать всех'] : ['only', '👁 Только его сообщения']);
    items.push(['nick', NK[l] ? '🎨 Свой цвет и прозвище ✓' : '🎨 Свой цвет и прозвище']);
    { const og = gdOn() && gdLoad().find((g) => gdOwn(g) && !g.gone && !gdIsMem(g, l)); if (og && S.flags.dm) items.push(['gdinv', `⚜ Позвать в «${gdName(og).slice(0, 24)}»`]); }
    items.push(S.ign.has(l) ? ['unign', '👁 Снять игнор'] : ['ign', '🙈 Игнорировать в чате']);
    if (S.meFriends) {
      if (st === 'friends') items.push(['', `👥 В друзьях${f && f.on ? ' · ' + (f.on.t || 'в сети') : ''}`, true]);
      else if (st === 'out') items.push(['', '👥 Заявка отправлена', true]);
      else if (st === 'in') items.push(['accept', '👥 Принять в друзья']);
      else if (st !== 'blocked') items.push(['add', '👥 Добавить в друзья']);
      if (st === 'friends') items.push(['trade', '🔄 Предложить обмен']);
      if (f && f.coin && f.coin !== 'given') items.push(['coin', f.coin === 'ok' ? '🪙 Подарить монету дня' : '🪙 ' + (COIN_T[f.coin] || 'Монета дня — сейчас нельзя'), f.coin !== 'ok']);
      items.push(st === 'blocked' ? ['unblock', '✅ Разблокировать'] : ['block', '🚫 Заблокировать']);
    }
    const el = doc.createElement('div'); el.className = 'mm'; el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="mh">${esc(name)}<small>${st === 'friends' ? 'друг' : st === 'blocked' ? 'заблокирован' : 'игрок'}</small></div>` +
      items.map(([k, t, off]) => `<button type="button" role="menuitem" data-k="${k}"${off ? ' disabled' : ''}${k === 'block' ? ' class="danger"' : ''}>${esc(t)}</button>`).join('');
    doc.body.appendChild(el);
    const r = from.getBoundingClientRect(), vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    el.style.top = (r.bottom + 4 + h > vh - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-k]'); if (!b || b.disabled) return;
      const k = b.dataset.k;
      if (k === 'block' && !b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Точно заблокировать?'; return; }
      if (k === 'nick') { nickEdit(l, from); return; }
      nickMenuClose();
      if (k === 'dm') return pmOpen(l, name);
      if (k === 'reply') { S.el.inp.value = `@${l} ` + S.el.inp.value.replace(/^@\S+\s*/, ''); S.el.inp.focus(); return; }
      if (k === 'coin' && f) return giveCoin(f.id);
      if (k === 'trade') return tradeInvite(l);
      if (k === 'gdinv') { const og = gdLoad().find((g) => gdOwn(g) && !g.gone && !gdIsMem(g, l)); if (og) gdInvite(og, l); return; }
      if (k === 'ign' || k === 'unign') return ignSet(l, k === 'ign');
      if (k === 'only') return onlySet(l);
      if (k === 'onlyoff') return onlySet('');
      await friendAct(k, l);
    });
    const out = (e) => { if (!el.contains(e.target)) nickMenuClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nickMenuClose(); } };
    setTimeout(() => { doc.addEventListener('pointerdown', out, true); doc.addEventListener('keydown', key, true); }, 0);
    S.nmenu = { el, doc, out, key };
    const first = el.querySelector('button:not([disabled])'); if (first) first.focus();
  }
  function nickMenuClose() {
    const m = S.nmenu; if (!m) return; S.nmenu = null;
    m.el.remove(); m.doc.removeEventListener('pointerdown', m.out, true); m.doc.removeEventListener('keydown', m.key, true);
  }
  const FR_DONE = { add: 'заявка в друзья отправлена', accept: 'теперь вы друзья', decline: 'заявка отклонена', cancel: 'заявка отменена', remove: 'удалён из друзей', block: 'заблокирован', unblock: 'разблокирован' };
  async function friendAct(op, l) {
    let r = null; try { r = await api('/api/friends', { op, login: l }); } catch {}
    if (!r || !r.ok) { S.el.err.textContent = 'Друзья: ' + ((r && ({ rate_limited: 'слишком часто — подожди минуту', friends_closed: 'друзья пока закрыты' }[r.error] || r.error)) || 'нет связи'); if (S.room === 'pm') pmRender(); return false; }
    okMsg(`${pmName(l)}: ${op === 'add' && r.state === 'friends' ? 'теперь вы друзья' : FR_DONE[op] || 'готово'}`);
    await friendsLoad();
    if (S.room === 'pm') pmRender(); else renderLog();
    return true;
  }


  // ---------- Поиск игроков по похожему нику ----------
  // Сайт ищет только по началу ника (GET /api/friends/find?q=, до 8 человек). Поверх: запросы по исправленным
  // вариантам (русская раскладка, ник по-русски, первые 3 буквы — на случай опечатки дальше) и свой список
  // «кого видели» (чаты, друзья, личные), а всё вместе ранжируется по похожести: начало, часть ника, опечатки, пропуски.
  const RU_KEYS = 'йцукенгшщзхъфывапролджэячсмитьбю', EN_KEYS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.";
  const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const SEEN_KEY = 'lgmc_seen';
  let SEEN = null, seenT = 0;
  const seenMap = () => SEEN || (SEEN = new Map(Object.entries(lsGet(SEEN_KEY, {}) || {})));
  function seenAdd(l0, n, at, c, cn) {   // [имя, когда видели, класс героя, название класса]
    const l = nickOf(l0); if (!l || l === S.me) return;
    const m = seenMap(), o = m.get(l), t = +at || Date.now();
    if (o && o[1] >= t && (!n || o[0] === n) && (!c || (o[2] === c && (!cn || o[3] === cn)))) return;
    m.set(l, [n || (o && o[0]) || l, Math.max(t, (o && o[1]) || 0), c || (o && o[2]) || '', cn || (o && o[3]) || '']);
    clearTimeout(seenT); seenT = setTimeout(seenSave, 3000);
  }
  function seenSave() {
    let a = [...seenMap()];
    if (a.length > 2000) { a.sort((x, y) => y[1][1] - x[1][1]); a = a.slice(0, 2000); SEEN = new Map(a); }
    lsSet(SEEN_KEY, Object.fromEntries(a));
  }
  function psVariants(raw) {
    const q = String(raw || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
    const out = new Set(), add = (x) => { x = x.replace(/[^a-z0-9_]/g, '').slice(0, 25); if (x.length >= 2) out.add(x); };
    if (/[а-яё]/.test(q)) {
      add([...q].map((c) => { const i = RU_KEYS.indexOf(c); return i >= 0 ? EN_KEYS[i] : c; }).join(''));   // забыл переключить раскладку
      add([...q].map((c) => TRANSLIT[c] ?? c).join(''));                                                    // написал ник по-русски
    } else add(q);
    return [...out];
  }
  function osa(a, b) {   // расстояние правки: вставка, удаление, замена, перестановка соседних
    const m = a.length, n = b.length; if (Math.abs(m - n) > 3) return 9;
    let p2 = null, p1 = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const c = [i];
      for (let j = 1; j <= n; j++) {
        c[j] = Math.min(p1[j] + 1, c[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (p2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) c[j] = Math.min(c[j], p2[j - 2] + 1);
      }
      p2 = p1; p1 = c;
    }
    return p1[n];
  }
  const squash = (x) => x.replace(/[_\d]+/g, '').replace(/(.)\1+/g, '$1');
  function psScore(l, name, q) {
    const nm = String(name || '').toLowerCase();
    if (l === q) return 100;
    if (l.startsWith(q)) return 92 - Math.min(10, (l.length - q.length) / 2);
    if (nm.startsWith(q)) return 88;
    const i = l.indexOf(q); if (i >= 0) return 80 - Math.min(8, i);
    if (nm.includes(q)) return 76;
    const sq = squash(q); if (sq.length >= 3 && squash(l).includes(sq)) return 70;   // без _ и цифр, без двойных букв
    const tol = q.length >= 7 ? 2 : q.length >= 4 ? 1 : 0;
    if (tol) {
      let d = osa(q, l);
      for (let k = q.length - 1; k <= q.length + 1; k++) if (k > 1 && k < l.length) d = Math.min(d, osa(q, l.slice(0, k)));
      if (d <= tol) return 66 - d * 6;
    }
    if (q.length >= 3) { let j = 0; for (const c of l) if (c === q[j]) j++; if (j === q.length) return 50; }   // буквы по порядку, с пропусками
    return 0;
  }
  const PS = { key: '', t: 0, n: 0, busy: false, srv: [], err: '', cache: new Map(), known: new Map() };
  function psWant(raw) {
    const vs = psVariants(raw), key = vs.join('|');
    if (key === PS.key) return;
    PS.key = key; PS.err = ''; clearTimeout(PS.t); const n = ++PS.n;
    const qs = new Set(); for (const v of vs) { qs.add(v); if (v.length >= 5) qs.add(v.slice(0, 3)); }   // начало из 3 букв — на случай опечатки дальше
    const todo = S.me ? [...qs].filter((x) => !PS.cache.has(x)) : [];
    PS.srv = [...qs].flatMap((x) => PS.cache.get(x) || []);
    PS.busy = !!todo.length;
    if (!todo.length) return;
    PS.t = setTimeout(async () => {
      for (const x of todo) {
        let r = null; try { r = await api('/api/friends/find?q=' + encodeURIComponent(x)); } catch {}
        if (n !== PS.n) return;
        if (!r || !r.ok) { PS.err = r && r.error === 'rate_limited' ? 'сайт просит подождать пару секунд' : 'сайт не ответил — ищу среди знакомых'; break; }
        for (const u of r.users || []) { const l = nickOf(u.login); if (l) PS.known.set(l, u.name || l); }
        PS.cache.set(x, r.users || []); if (PS.cache.size > 80) PS.cache.delete(PS.cache.keys().next().value);
      }
      PS.srv = [...qs].flatMap((x) => PS.cache.get(x) || []); PS.busy = false;
      pmRefresh();
    }, 350);
  }
  function psResults(raw, skip) {
    const vs = psVariants(raw); if (!vs.length) return [];
    const pool = new Map();
    const put = (l0, name, seen) => {
      const l = nickOf(l0); if (!l || l === S.me || skip.has(l)) return;
      const o = pool.get(l) || {};
      pool.set(l, { name: (name && String(name)) || o.name || S.pm.names[l] || '', seen: Math.max(+seen || 0, o.seen || 0) });
    };
    for (const [l, [n, t]] of seenMap()) put(l, n, t);
    for (const m of S.list) put(m.l, m.n, m.at);
    for (const l of Object.keys(S.pm.last)) put(l);
    const fr = S.pm.fr || {}; for (const k of ['friends', 'in', 'out', 'blocks']) for (const u of fr[k] || []) put(u.login, u.name);
    for (const [l, n] of PS.known) put(l, n);   // все, кого сайт уже показывал в этом окне
    for (const u of PS.srv) put(u.login, u.name);
    const out = [];
    for (const [l, o] of pool) {
      let sc = 0; for (const v of vs) sc = Math.max(sc, psScore(l, o.name, v));
      if (sc >= 50) out.push(Object.assign({ l, sc }, o));
    }
    const fr1 = (l) => (S.pm.frState.get(l) === 'friends' ? 1 : 0);
    out.sort((a, b) => b.sc - a.sc || fr1(b.l) - fr1(a.l) || b.seen - a.seen || a.l.localeCompare(b.l));
    return out.slice(0, 12);
  }
  function pmRefresh() {   // перерисовать список, не сбив набор в поиске
    if (S.room !== 'pm' || S.pm.peer) return;
    const a = document.activeElement, had = a && a.id === 'pmq', pos = had ? a.selectionStart : 0;
    pmRender();
    if (had) { const i = S.el.dmbar.querySelector('#pmq'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }
  }


  // ---------- 🔄 Обмен с друзьями ----------
  // Обмен в игре — лицом к лицу в «Городе» (site/trade.js): приглашение POST /api/city/trade { op: 'invite', to } (60 с на ответ),
  // принять — { op: 'accept', from }. Само окно обмена (вещи, монеты, «Готово», подтверждение) — игры, во вкладке «Город»:
  // туда и переводим. Входящие приглашения — событие «city» канала /api/live (tr.inv: [{ l, n, lv, left }]).
  const TR = { seen: new Set() };
  const trErr = (e) => 'Обмен: ' + e + (/город|town|рядом|далеко|не в/i.test(e) ? ' — обмен идёт лицом к лицу: встаньте оба в один город (📍 в комнате «Город»)' : '');
  async function tradeInvite(l) {
    let r = null; try { r = await api('/api/city/trade', { op: 'invite', to: l }); } catch {}
    if (r && r.ok !== false) {
      if (r.tr !== undefined) tradeOn(r.tr);
      okMsg(`🔄 ${pmName(l)}: приглашение к обмену отправлено — 60 с на ответ`);
      pmToast(l, `🔄 Ждём ответа ${pmName(l)}. Окно обмена откроется в игре, во вкладке «Город»`, EMBED ? 'Показать «Город»' : 'Открыть игру', 'game');
      return;
    }
    S.el.err.textContent = trErr((r && (ERR[r.error] || r.error)) || 'нет связи');
  }
  async function tradeAccept(l) {
    let r = null; try { r = await api('/api/city/trade', { op: 'accept', from: l }); } catch {}
    if (r && r.ok !== false) { okMsg(`🔄 Обмен с ${pmName(l)} — окно в игре, во вкладке «Город»`); tradeShowGame(); return; }
    S.el.err.textContent = trErr((r && (ERR[r.error] || r.error)) || 'нет связи');
  }
  function tradeShowGame() {   // окно обмена — в «Городе» игры
    if (EMBED && window.parent !== window) { try { window.parent.postMessage({ lgmc: 'citytab' }, location.origin); return; } catch {} }
    window.open(`${ORIGIN}/c/${encodeURIComponent(S.ch)}/#city`, '_blank');
  }
  function tradeOn(tr, d) {
    if (d && d.trDone && d.trDone.ok) okMsg(`🔄 Обмен с ${d.trDone.with} проведён — вещи и монеты уже у вас`);
    if (!tr || !Array.isArray(tr.inv)) return;
    for (const x of tr.inv) {
      const l = nickOf(x && x.l); if (!l) continue;
      const key = l + ':' + Math.round((Date.now() + (+x.left || 0)) / 5000);
      if (TR.seen.has(l)) continue;
      TR.seen.add(l); setTimeout(() => TR.seen.delete(l), Math.max(5000, +x.left || 60000));
      if (x.n) S.pm.names[l] = S.pm.names[l] || x.n;
      pmToast(l, `🔄 ${x.n || l}${x.lv ? ` (ур. ${+x.lv})` : ''} предлагает обмен`, 'Принять', 'tracc');
      czBeepOnce('dm', 'tr|' + key);
    }
  }


  // ====================== Удобство: ники по Tab, ответ с цитатой, горячие клавиши, «пока тебя не было», игнор ======================

  // ---- @ники: подсказки при наборе «@…», Tab / Enter / клик — подставить ----
  const ACP = { list: [], i: 0, tok: null };
  function acTok() {
    const inp = S.el.inp, v = inp.value, p = inp.selectionStart ?? v.length, pre = v.slice(0, p);
    const m = /(^|\s)(@?)([a-z0-9_]{0,25})$/i.exec(pre);
    if (!m || (!m[2] && m[3].length < 2)) return null;
    return { start: p - m[3].length - m[2].length, end: p, q: m[3].toLowerCase(), at: !!m[2] };
  }
  function acCands(q) {
    const out = new Map(), add = (l0, n, w) => { const l = nickOf(l0); if (!l || l === S.me) return; const nm = n || S.pm.names[l] || l; if (!(l.startsWith(q) || String(nm).toLowerCase().startsWith(q))) return; const o = out.get(l); if (!o || o.w < w) out.set(l, { l, n: nm, w }); };
    S.list.forEach((m, i) => add(m.l, m.n, 3 + i / 1000));   // кто писал недавно — выше
    for (const u of (S.pm.fr && S.pm.fr.friends) || []) add(u.login, u.name, 2.5);
    for (const l of Object.keys(S.pm.last)) add(l, null, 2);
    for (const [l, [n]] of seenMap()) add(l, n, 1);
    return [...out.values()].sort((a, b) => b.w - a.w || a.l.localeCompare(b.l)).slice(0, 6);
  }
  function acUpdate(force) {
    const t = acTok();
    if (!t || (!t.at && !force)) { acHide(); return; }
    ACP.tok = t; ACP.list = acCands(t.q); ACP.i = 0;
    if (!ACP.list.length || (ACP.list.length === 1 && ACP.list[0].l === t.q && t.at && !force)) { acHide(); return; }
    S.el.ac.innerHTML = ACP.list.map((c, i) => `<li role="option" data-l="${esc(c.l)}" aria-selected="${i === ACP.i}">${avIn(c.l, c.n)}</span><b style="color:${ncol(c.l)}">${esc(c.n)}</b>${String(c.n).toLowerCase() !== c.l ? `<small>${esc(c.l)}</small>` : ''}</li>`).join('');
    S.el.ac.hidden = false;
  }
  function acHide() { if (S.el.ac) S.el.ac.hidden = true; ACP.list = []; ACP.tok = null; }
  function acPick(l) {
    const t = ACP.tok || acTok(); if (!t) return;
    const inp = S.el.inp, v = inp.value, ins = '@' + l + ' ';
    const post = v.slice(t.end).replace(/^\s+/, '');
    inp.value = (v.slice(0, t.start) + ins + post).slice(0, 200);
    const pos = Math.min(200, t.start + ins.length); inp.setSelectionRange(pos, pos); inp.focus();
    acHide();
  }
  function acMove(d) { if (!ACP.list.length) return; ACP.i = (ACP.i + d + ACP.list.length) % ACP.list.length; S.el.ac.querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', String(i === ACP.i))); }

  // ---- ответ с цитатой: «@ник «начало сообщения» текст» — видно всем, у нас — цитатой, клик — к оригиналу ----
  const QUOTE_RE = /^@([a-z0-9_]{1,25}) «([^«»]{1,60})» ?([\s\S]*)$/i;
  const RQ_ICO = '<svg class="rqi" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  function quoteOf(m) { const t = String(m.t || ''), q = QUOTE_RE.exec(t); return (q ? q[3] : t).replace(/[«»]/g, '"').replace(/\s+/g, ' ').trim(); }
  function replyStart(m) {
    const l = nickOf(m.l); if (!l) return;
    let snip = quoteOf(m); if (snip.length > 32) snip = snip.slice(0, 31).trimEnd() + '…';
    S.reply = { l, n: m.n || l, snip, key: m._key, src: m._src };
    if (isMix(S.room)) { const k = kind(m) === 'ev' ? 'g' : kind(m); if ([...S.el.tgt.options].some((o) => o.value === k)) setTarget(k); }
    replyBar(); S.el.inp.focus();
  }
  function replyBar() {
    const r = S.reply, el = S.el.rq; if (!el) return;
    el.hidden = !r;
    if (r && r.edit) el.innerHTML = `<span class="rb">✏️ Правка сообщения: ${esc(r.snip)}</span><button type="button" aria-label="Отменить правку" title="Отменить (Esc)">✕</button>`;
    else if (r) el.innerHTML = `<span class="rb">${RQ_ICO}Ответ <b style="color:${ncol(r.l)}">@${esc(r.n)}</b>: ${esc(r.snip)}</span><button type="button" aria-label="Отменить ответ" title="Отменить ответ (Esc)">✕</button>`;
  }
  function replyCancel() { S.reply = null; replyBar(); }
  function replyWrap(t) {   // текст с цитатой — не длиннее 200
    const r = S.reply; if (!r) return t;
    let snip = r.snip;
    while (`@${r.l} «${snip}» ${t}`.length > 200 && snip.length > 6) snip = snip.slice(0, -2).trimEnd() + '…';
    const out = `@${r.l} «${snip}» ${t}`;
    return out.length <= 200 ? out : t;
  }
  function quoteJump(el) {
    const l = el.dataset.ql, q = fnorm(String(el.dataset.qt || '').replace(/…$/, ''));
    const m = [...S.list].reverse().find((x) => String(x.l).toLowerCase() === l && fnorm(quoteOf(x)).startsWith(q.slice(0, 20)) && x._key !== el.closest('li').dataset.key);
    const li = m && S.el.log.querySelector(`li[data-key="${CSS.escape(m._key)}"]`);
    if (!li) { okMsg('Это сообщение уже не в ленте'); return; }
    li.scrollIntoView({ block: 'center' }); li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
  }

  // ---- горячие клавиши ----
  const ROOM_KEYS = ['mine', 'city', 'all', 'pm', 'ping', 'guild'];
  function hotkeys(e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-6]$/.test(e.code)) {
      const r = ROOM_KEYS[+e.code.slice(5) - 1], b = S.el.room.querySelector(`[data-r="${r}"]`);
      if (b && !b.disabled) { e.preventDefault(); if (r !== S.room) switchTo(S.ch, r); }
    }
  }

  // ---- «пока тебя не было»: окно было скрыто дольше минуты — сводка пингов, личных и друзей в сети ----
  const AW = { at: 0, pings: 0, dms: new Map(), fr: [] };
  function awayNote(kind, l, n) {
    if (!AW.at) return;
    if (kind === 'ping') AW.pings++;
    if (kind === 'dm') AW.dms.set(l, (AW.dms.get(l) || 0) + 1);
    if (kind === 'fr' && !AW.fr.includes(n || l)) AW.fr.push(n || l);
  }
  function awayVis() {
    if (document.hidden) { AW.at = Date.now(); AW.pings = 0; AW.dms = new Map(); AW.fr = []; return; }
    const long = AW.at && Date.now() - AW.at > 60000, any = AW.pings || AW.dms.size || AW.fr.length;
    if (long && any) awayShow();
    AW.at = 0;
  }
  function awayShow() {
    const el = S.el.away, parts = [], nd = [...AW.dms.values()].reduce((a, b) => a + b, 0);
    const ru = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
    if (AW.pings) parts.push(`📣 ${AW.pings} ${ru(AW.pings, 'пинг', 'пинга', 'пингов')}`);
    if (nd) parts.push(`✉ ${nd} ${ru(nd, 'личное', 'личных', 'личных')} (${[...AW.dms.keys()].slice(0, 3).map((l) => esc(pmName(l))).join(', ')}${AW.dms.size > 3 ? '…' : ''})`);
    if (AW.fr.length) parts.push(`🟢 в сети: ${AW.fr.slice(0, 3).map(esc).join(', ')}${AW.fr.length > 3 ? '…' : ''}`);
    el.innerHTML = `<span><b>Пока тебя не было:</b> ${parts.join(' · ')}</span>${AW.pings ? '<button type="button" data-aw="ping">Пинги</button>' : ''}${nd ? '<button type="button" data-aw="pm">Личные</button>' : ''}<button type="button" class="x" data-aw="x" aria-label="Скрыть">✕</button>`;
    el.hidden = false;
  }

  // ---- игнор: у игры — POST /api/city/chat/ignore { login, on } → { ign } ----
  const dispName = (l) => aliasOf(l) || S.pm.names[l] || (seenMap().get(l) || [])[0] || l;   // имя, как в чате (а не логин)
  async function ignSet(l, on) {
    let r = null; try { r = await api('/api/city/chat/ignore', { login: l, on }); } catch {}
    if (!r || !r.ok) { S.el.err.textContent = 'Игнор: ' + ((r && (ERR[r.error] || r.error)) || 'нет связи'); return false; }
    S.ign = new Set((r.ign || []).map((x) => String(x).toLowerCase())); lsSet('lgmc_ign_' + S.ch, [...S.ign]);
    okMsg(on ? `${dispName(l)}: в игноре — его сообщений не видно, лично не пишет` : `${dispName(l)}: игнор снят`);
    if (S.room === 'pm') pmRender(); else { const keep = S.stick; renderLog(); if (keep) toBottom(); }
    if (S.el.sp && !S.el.sp.hidden) czRender();
    return true;
  }


  // ---- мгновенная лента: подписка на чаты, как у самой игры (POST /api/chat/watch { on, rooms } раз в минуту) — сообщения
  // приходят событиями «city» / «mine» того же канала /api/live; опрос остаётся страховкой, но редкий ----
  function liveWatch() {
    clearInterval(S.watchT); S.watchOn = false;
    const rooms = [...(usesCity(S.room) && S.cityFeed && S.inCity ? ['city'] : []), ...(usesMine(S.room) && S.mines.length === 1 && S.cityFeed !== false ? ['mine'] : [])];
    if (!rooms.length || !S.pm.es) return;
    const gen = S.gen;
    const w = async () => {
      if (gen !== S.gen) { clearInterval(S.watchT); return; }
      if (hidden()) return;
      let r = null; try { r = await api('/api/chat/watch', { on: true, rooms }); } catch {}
      S.watchOn = !!(r && r.ok);
    };
    w(); S.watchT = setInterval(w, 45000);
  }


  // ---------- нажал на @ник в сообщении — подсветить последние сообщения этого игрока ----------
  const UH = { l: '', t: 0 };
  function userHl(l) {
    const log = S.el.log;
    const clear = () => { for (const x of log.querySelectorAll('li.uhl')) x.classList.remove('uhl', 'uhl1'); UH.l = ''; clearTimeout(UH.t); };
    if (UH.l === l) { clear(); return; }   // второй раз — убрать
    clear();
    const rows = [...log.querySelectorAll(`li .n[data-l="${CSS.escape(l)}"]`)].map((n) => n.closest('li')).filter((x) => x && x.parentElement === log);
    if (!rows.length) { okMsg(`В ленте нет сообщений @${dispName(l)}`); return; }
    const last = rows.slice(-10);
    last.forEach((x) => x.classList.add('uhl'));
    const top = last[last.length - 1]; top.classList.add('uhl1');
    top.scrollIntoView({ block: 'center' });
    S.stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    UH.l = l;
    okTip(`Последние сообщения ${dispName(l)}: ${last.length}${rows.length > last.length ? ` из ${rows.length}` : ''} — нажми ещё раз или Esc, чтобы убрать`);
    UH.t = setTimeout(clear, 20000);
  }


  // ---------- ⧉ скопировать сообщение ----------
  async function copyText(t, btn) {
    let ok = false;
    try { await navigator.clipboard.writeText(t); ok = true; } catch {}
    if (!ok) {   // запасной путь — через скрытое поле
      const d = btn.ownerDocument, ta = d.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      d.body.appendChild(ta); ta.select(); try { ok = d.execCommand('copy'); } catch {} ta.remove();
    }
    if (ok) { btn.textContent = '✓'; btn.classList.add('ok'); setTimeout(() => { btn.textContent = '⧉'; btn.classList.remove('ok'); }, 1200); okTip('Скопировано'); }
    else S.el.err.textContent = 'Не получилось скопировать — выдели текст и нажми Ctrl+C';
  }
  function copyMsg(btn) {
    const li = btn.closest('li'); if (!li) return;
    if (li.classList.contains('b')) {   // пузырь в личных
      const m = (S.pm.conv.get(S.pm.peer) || []).find((x) => String(x.id) === li.dataset.id);
      if (m) copyText(extStrip(String(m.t || '')), btn);
      return;
    }
    const m = S.list.find((x) => x._key === li.dataset.key) || (S.room === 'ping' && pingView().find((x) => x._key === li.dataset.key));
    if (!m) return;
    const t = String(m.t || ''), q = QUOTE_RE.exec(t);
    copyText(extStrip(q ? q[3] : t).trim(), btn);   // только сам текст, без цитаты и невидимой метки
  }


  // ---------- 🔴 стример начал эфир ----------
  function liveAlert(c) {
    const l = c.login.toLowerCase(), name = c.name || c.login;
    pmToast(l, `🔴 ${name} начал эфир`, 'Смотреть', 'live');
    czBeepOnce('dm', 'live|' + l + '|' + new Date().toISOString().slice(0, 13));
    if (S.pm.notify && hidden()) try { const n = new Notification(`🔴 ${name} начал эфир`, { body: 'Легион — открыть стрим', tag: 'lgmc-live-' + l }); n.onclick = () => { try { window.open('https://www.twitch.tv/' + encodeURIComponent(l), '_blank'); } catch {} n.close(); }; } catch {}
  }

  // ---------- 👁 только сообщения одного игрока ----------
  function onlySet(l) {
    S.only = l || '';
    const b = S.el.onlyb;
    if (b) { b.hidden = !S.only; if (S.only) b.innerHTML = `<span>👁 Только сообщения <b style="color:${ncol(S.only)}">${esc(dispName(S.only))}</b></span><button type="button" data-ob="all">Показать всех</button>`; }
    if (S.room === 'pm') return;
    renderLog(); toBottom();
  }

  // ---------- 🎨 свой цвет и прозвище для ника ----------
  const NK_COLORS = ['#ff6b6b', '#ff9f43', '#feca57', '#7bed9f', '#2ed573', '#1dd1a1', '#48dbfb', '#54a0ff', '#5f27cd', '#a29bfe', '#f368e0', '#ff9ff3'];
  function nkSave(l, v) {
    if (v && (v.a || v.c)) NK[l] = v; else delete NK[l];
    lsSet(NK_KEY, NK);
    if (S.room === 'pm') pmRender(); else { const keep = S.stick; renderLog(); if (keep) toBottom(); }
    if (S.el.sp && !S.el.sp.hidden) czRender();
  }
  function nickEdit(l, from) {
    nickMenuClose(); modMenuClose();
    const doc = from.ownerDocument, cur = NK[l] || {}, real = (seenMap().get(l) || [])[0] || S.pm.names[l] || l;
    let pick = cur.c || '';
    const el = doc.createElement('div'); el.className = 'mm nke'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Свой цвет и прозвище');
    el.innerHTML = `<div class="mh">🎨 ${esc(real)}<small>цвет и прозвище видишь только ты</small></div>
      <input class="nka" maxlength="24" placeholder="Прозвище (пусто — как в игре)" value="${esc(cur.a || '')}" aria-label="Прозвище">
      <div class="nkc">${NK_COLORS.map((c) => `<button type="button" class="dot" data-c="${c}" style="background:${c}" aria-label="Цвет ${c}" aria-pressed="${pick === c}"></button>`).join('')}<label class="dot pick" title="Свой цвет" style="background:${esc(pick || nickColor(l))}"><input type="color" value="${esc(pick || nickColor(l))}" aria-label="Свой цвет"></label></div>
      <div class="nkp">Так будет: <b class="nkv">${esc(cur.a || real)}</b></div>
      <div class="nkb"><button type="button" data-nk="save" class="ok">Сохранить</button>${NK[l] ? '<button type="button" data-nk="reset">Как в игре</button>' : ''}<button type="button" data-nk="x">Отмена</button></div>`;
    doc.body.appendChild(el);
    const r = from.getBoundingClientRect(), vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight, w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    el.style.top = (r.bottom + 4 + h > vh - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    const inp = el.querySelector('.nka'), pv = el.querySelector('.nkv');
    const paint = () => { pv.textContent = inp.value.trim() || real; pv.style.color = `color-mix(in oklch, ${pick || nickColor(l)} var(--ncm,100%), var(--ncb,#000))`; el.querySelectorAll('[data-c]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === pick))); };
    paint();
    inp.addEventListener('input', paint);
    el.querySelector('input[type="color"]').addEventListener('input', (e) => { pick = e.target.value; e.target.parentElement.style.background = pick; paint(); });
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]'); if (c) { pick = c.dataset.c; paint(); return; }
      const b = e.target.closest('[data-nk]'); if (!b) return;
      const k = b.dataset.nk; nickMenuClose();
      if (k === 'save') nkSave(l, { a: inp.value.trim().slice(0, 24), c: pick });
      if (k === 'reset') nkSave(l, null);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-nk="save"]').click(); } });
    const out = (e) => { if (!el.contains(e.target)) nickMenuClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nickMenuClose(); } };
    setTimeout(() => { doc.addEventListener('pointerdown', out, true); doc.addEventListener('keydown', key, true); }, 0);
    S.nmenu = { el, doc, out, key };
    inp.focus(); inp.select();
  }

  // ---------- ⭐ закладки ----------
  const BM_KEY = 'lgmc_bm';
  const bms = () => { const v = lsGet(BM_KEY, []); return Array.isArray(v) ? v.filter((x) => x && x.id) : []; };
  const bmHas = (id) => bms().some((x) => x.id === id);
  function bmToggle(m, btn) {
    const id = S.ch + '|' + m._key, list = bms(), i = list.findIndex((x) => x.id === id);
    if (i >= 0) { list.splice(i, 1); okTip('Убрано из закладок'); }
    else {
      list.unshift({ id, ch: S.ch, chn: S.chName, src: m._src, key: m._key, l: String(m.l || '').toLowerCase(), n: m.n || m.l, t: extStrip(String(m.t || '')), at: m.at || Date.now(), saved: Date.now() });
      okTip('⭐ В закладках — открыть: ⭐ вверху');
    }
    lsSet(BM_KEY, list.slice(0, 300));
    const on = i < 0, li = btn.closest('li');
    btn.classList.toggle('on', on); btn.textContent = on ? '★' : '☆'; btn.title = on ? 'Убрать из закладок' : 'В закладки';
    if (li) li.classList.toggle('bmk', on);
    if (!S.el.bmp.hidden) bmRender();
  }
  function bmOpen(on) {
    S.el.bmp.hidden = !on; S.el.bmk.setAttribute('aria-pressed', String(on));
    if (on) { czOpen(false); bmRender(); const f = S.el.bmp.querySelector('input,button'); if (f) f.focus(); } else S.el.bmk.focus();
  }
  function bmRender() {
    const list = bms(), q = fnorm((S.bmq || '').trim());
    const shown = q ? list.filter((x) => fnorm(x.t).includes(q) || fnorm(x.n || '').includes(q)) : list;
    const dt = (t) => { const d = new Date(t); return sameDay(t, Date.now()) ? hhmm(t) : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(t)}`; };
    S.el.bmp.innerHTML = `<div class="sp-h"><b>⭐ Закладки${list.length ? ` · ${list.length}` : ''}</b><button type="button" class="hb" data-bm="close" aria-label="Закрыть закладки">✕</button></div>
      <div class="bm-b">${list.length > 5 ? `<input class="bmq" type="search" placeholder="Найти в закладках" aria-label="Найти в закладках" value="${esc(S.bmq || '')}">` : ''}
      ${shown.length ? `<ul class="bml">${shown.map((x) => `<li data-id="${esc(x.id)}"><div class="bmh"><b style="color:${ncol(x.l)}">${esc(dispName(x.l) || x.n)}</b><small>${esc(x.chn || x.ch)} · ${x.src === 'mine' ? '⛏ шахта' : '🏰 город'} · ${dt(x.at)}</small></div><div class="bmt">${fmtText(x.t)}</div><div class="bma"><button type="button" data-bm="go" title="Открыть этот чат и найти сообщение">→ К сообщению</button><button type="button" data-bm="copy" title="Скопировать текст">⧉</button><button type="button" data-bm="del" title="Убрать из закладок">✕</button></div></li>`).join('')}</ul>`
        : `<p class="bm0">${list.length ? 'Ничего не нашлось.' : 'Пока пусто. Наведи на сообщение и нажми ☆ — оно сохранится здесь.'}</p>`}</div>`;
    const qi = S.el.bmp.querySelector('.bmq');
    if (qi) qi.oninput = () => { S.bmq = qi.value; const p = qi.selectionStart; bmRender(); const n = S.el.bmp.querySelector('.bmq'); if (n) { n.focus(); n.setSelectionRange(p, p); } };
  }
  async function bmClick(e) {
    const b = e.target.closest('[data-bm]'); if (!b) return;
    const a = b.dataset.bm; if (a === 'close') { bmOpen(false); return; }
    const li = b.closest('li[data-id]'), x = li && bms().find((y) => y.id === li.dataset.id); if (!x) return;
    if (a === 'del') { lsSet(BM_KEY, bms().filter((y) => y.id !== x.id)); bmRender(); if (S.room !== 'pm') renderLog(); return; }
    if (a === 'copy') { copyText(x.t, b); return; }
    if (a === 'go') {
      bmOpen(false);
      const room = x.src === 'mine' ? 'mine' : 'city';
      const find = () => { const el = S.el.log.querySelector(`li[data-key="${CSS.escape(x.key)}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); return true; } return false; };
      if (x.ch === S.ch && (S.room === room || isMix(S.room)) && find()) return;
      await switchTo(x.ch, room);
      let n = 0; const t = setInterval(() => { if (find() || ++n > 12) { clearInterval(t); if (n > 12) okMsg('Это сообщение уже не в ленте — но в закладках оно осталось'); } }, 400);
    }
  }

  function comfyInit() {
    Object.assign(S.el, { ac: document.getElementById('ac'), rq: document.getElementById('rq'), away: document.getElementById('away'), onlyb: document.getElementById('onlyb'), bmp: document.getElementById('bmp'), bmk: document.getElementById('bmk') });
    S.el.bmk.onclick = () => bmOpen(S.el.bmp.hidden);
    S.el.bmp.addEventListener('click', bmClick);
    S.el.onlyb.addEventListener('click', (e) => { if (e.target.closest('[data-ob]')) onlySet(''); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!S.el.bmp.hidden) { e.preventDefault(); bmOpen(false); return; }
      if (S.only && !S.nmenu) onlySet('');
    });
    window.addEventListener('storage', (e) => { if (e.key === NK_KEY) { try { NK = JSON.parse(e.newValue || '{}') || {}; } catch { NK = {}; } if (S.room === 'pm') pmRender(); else renderLog(); } });
    const inp = S.el.inp;
    inp.addEventListener('input', () => acUpdate(false));
    inp.addEventListener('keydown', (e) => {
      if (!S.el.ac.hidden && ACP.list.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acMove(e.key === 'ArrowDown' ? 1 : -1); return; }
        if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); acPick(ACP.list[ACP.i].l); return; }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); acHide(); return; }
      }
      if (e.key === 'Tab' && !e.shiftKey) { const t = acTok(); if (t) { acUpdate(true); if (ACP.list.length === 1) { e.preventDefault(); acPick(ACP.list[0].l); } else if (ACP.list.length) e.preventDefault(); } return; }
      if (e.key === 'ArrowUp' && !inp.value && S.lastSent) { e.preventDefault(); inp.value = S.lastSent; inp.setSelectionRange(inp.value.length, inp.value.length); return; }
      if (e.key === 'Escape' && S.reply) { e.preventDefault(); e.stopPropagation(); replyCancel(); }
    }, true);
    inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) acHide(); }, 150));
    S.el.ac.addEventListener('pointerdown', (e) => { const li = e.target.closest('li[data-l]'); if (li) { e.preventDefault(); acPick(li.dataset.l); } });
    S.el.rq.addEventListener('click', (e) => { if (e.target.closest('button')) replyCancel(); });
    S.el.log.addEventListener('click', (e) => {
      const cpy = e.target.closest('.cpb'); if (cpy) { e.stopPropagation(); copyMsg(cpy); return; }
      const bmb = e.target.closest('.bmb'); if (bmb) { e.stopPropagation(); const li = bmb.closest('li'), m = li && S.list.find((x) => x._key === li.dataset.key) || (S.room === 'ping' && pingView().find((x) => x._key === li.dataset.key)); if (m) bmToggle(m, bmb); return; }
      const b = e.target.closest('.rpb');
      if (b) { e.stopPropagation(); const li = b.closest('li'), m = li && (S.list.find((x) => x._key === li.dataset.key) || (S.room === 'ping' && pingView().find((x) => x._key === li.dataset.key))); if (m) replyStart(m); return; }
      const q = e.target.closest('.rq'); if (q) { e.stopPropagation(); quoteJump(q); return; }
      const at = e.target.closest('.at[data-at]'); if (at) { e.stopPropagation(); userHl(at.dataset.at); }
    }, true);
    S.el.log.addEventListener('keydown', (e) => {
      const q = e.target.closest && e.target.closest('.rq'); if (q && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); quoteJump(q); return; }
      const at = e.target.closest && e.target.closest('.at[data-at]'); if (at && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); userHl(at.dataset.at); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && UH.l) { for (const x of S.el.log.querySelectorAll('li.uhl')) x.classList.remove('uhl', 'uhl1'); UH.l = ''; } });
    S.el.away.addEventListener('click', (e) => {
      const b = e.target.closest('[data-aw]'); if (!b) return;
      S.el.away.hidden = true;
      if (b.dataset.aw === 'ping' && S.room !== 'ping') switchTo(S.ch, 'ping');
      if (b.dataset.aw === 'pm') { S.pm.peer = null; if (S.room !== 'pm') switchTo(S.ch, 'pm'); else pmRender(); }
    });
    document.addEventListener('keydown', hotkeys, true);
    S.hotkeys = hotkeys;
    document.addEventListener('visibilitychange', awayVis);
    try { S.ign = new Set(lsGet('lgmc_ign_' + S.ch, []) || []); } catch {}
  }


  // ---------- 🧩 у кого тоже Чат Легиона ----------
  // Своего сервера нет, поэтому так: в конец своих сообщений (чат и личные) чат добавляет невидимую метку — два невидимых
  // символа U+2063 U+2064. Игра и люди без расширения её не видят; наш чат у других находит её, убирает из текста и ставит 🧩.
  // Кого видели с меткой — запоминаем (lgmc_ext). Обе стороны — настройками в ⚙ (показывать и отмечать — по отдельности).
  const EXT_MARK = '⁣⁤', EXT_KEY = 'lgmc_ext';
  let EXT = null;
  const extMap = () => EXT || (EXT = new Map(Object.entries(lsGet(EXT_KEY, {}) || {})));
  const extHas = (t) => typeof t === 'string' && t.includes(EXT_MARK);
  const extStrip = (t) => (typeof t === 'string' ? t.split(EXT_MARK).join('') : t);
  function extAdd(l0) {
    const l = nickOf(l0); if (!l) return;
    const m = extMap(), was = m.has(l); m.set(l, Date.now());
    if (!was || m.size % 10 === 0) { let a = [...m]; if (a.length > 3000) { a.sort((x, y) => y[1] - x[1]); a = a.slice(0, 3000); EXT = new Map(a); } lsSet(EXT_KEY, Object.fromEntries(a)); }
  }
  const isExt = (l) => CZ.extShow !== false && !!l && extMap().has(l);
  const extBadge = (l) => (isExt(l) ? '<span class="extm" title="Тоже с Чатом Легиона">🧩</span>' : '');
  const markOut = (t) => (CZ.extTell !== false && t && t.length + EXT_MARK.length <= 200 ? t + EXT_MARK : t);


  // ---------- длинная лента: своя история в браузере ----------
  // Игра отдаёт только последние ~120 сообщений города и ~40 шахты (более ранних не даёт). Поэтому чат хранит ленту сам
  // (IndexedDB «lgmc», по каналу и ленте, до histMax сообщений) и при открытии добавляет к ответу игры более ранние.
  const histMax = () => Math.max(200, Math.min(3000, +CZ.histMax || 1000));
  const HDB = { p: null, t: 0 };
  function hdb() {
    return HDB.p || (HDB.p = new Promise((res) => {
      try { const r = indexedDB.open('lgmc', 1); r.onupgradeneeded = () => r.result.createObjectStore('hist'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch { res(null); }
    }));
  }
  async function histGet(k) {
    const db = await hdb(); if (!db) return [];
    return new Promise((res) => { try { const q = db.transaction('hist').objectStore('hist').get(k); q.onsuccess = () => res(Array.isArray(q.result) ? q.result : []); q.onerror = () => res([]); } catch { res([]); } });
  }
  async function histPut(k, v) { const db = await hdb(); if (!db) return; try { db.transaction('hist', 'readwrite').objectStore('hist').put(v, k); } catch {} }
  const histKey = (src) => `${S.ch}|${src === 'mine' ? 'mine:' + S.mine : 'city'}`;
  function histSaveSoon() { if (CZ.hist === false) return; clearTimeout(HDB.t); HDB.t = setTimeout(histSave, 2500); }
  function histSave() {
    if (CZ.hist === false) return;
    for (const src of ['mine', 'city']) {
      const list = S.list.filter((m) => m._src === src && !m.sys).slice(-histMax());
      if (!list.length) continue;
      histPut(histKey(src), list.map((m) => { const o = {}; for (const [k, v] of Object.entries(m)) if (k[0] !== '_') o[k] = v; return o; }));
    }
  }
  async function histMerge(src, gen) {
    const arr = await histGet(histKey(src));
    if (gen !== S.gen || !arr.length) return;
    const keep = S.stick;
    apply({ chat: arr }, src, true);   // повторы отсеются по id, порядок — по времени
    renderLog(); if (keep) toBottom();
  }


  // ---------- поле ввода растёт вместе с текстом (до ~6 строк, дальше — прокрутка) ----------
  // Это <textarea>: Enter — отправить (переносов в сообщениях игры нет — вставленные переносы становятся пробелами).
  function growInit() {
    const inp = S.el.inp;
    const grow = () => {
      const w = inp.ownerDocument.defaultView, cs = w.getComputedStyle(inp), max = parseFloat(cs.maxHeight) || 140;
      if (!inp.value) { inp.style.height = ''; inp.style.overflowY = 'hidden'; return; }   // пусто — одна строка, длинная подсказка не раздувает поле
      inp.style.height = 'auto';
      const h = Math.min(max, inp.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
      inp.style.height = Math.ceil(h) + 'px';
      inp.style.overflowY = inp.scrollHeight + 2 > max ? 'auto' : 'hidden';
      if (S.stick) toBottom();
    };
    S.grow = grow;
    // текст ставят и кодом (ответ, стикер, паста, ↑, очистка после отправки) — растём и тогда
    const d = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    try { Object.defineProperty(inp, 'value', { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); grow(); } }); } catch {}
    inp.addEventListener('input', () => {
      if (/[\r\n]/.test(inp.value)) { const p = inp.selectionStart; inp.value = inp.value.replace(/\r?\n/g, ' '); inp.setSelectionRange(p, p); }
      grow();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && !e.defaultPrevented) { e.preventDefault(); if (!S.el.send.disabled) S.el.f.requestSubmit(); }
    });
    window.addEventListener('resize', grow);
    grow();
  }

  // ---------- Куда отправлять (в общей ленте) ----------
  const TGT = { mine: '⛏ Шахта', g: '🏰 Город', tr: '💰 Торговля', dm: '✉ Лично' };
  function renderTargets() {
    const opts = [...(S.mines.length ? ['mine'] : []), ...((!S.hero || S.flags.cc) ? ['g', ...(S.flags.tr ? ['tr'] : [])] : []), ...(S.flags.dm && S.me ? ['dm'] : [])];
    S.el.tgt.innerHTML = opts.map((k) => `<option value="${k}">${TGT[k]}</option>`).join('');
    if (!opts.includes(S.to)) S.to = opts[0] || 'g';
    S.el.tgt.value = S.to;
    S.el.tgt.hidden = !isMix(S.room) || !opts.length;
  }
  function setTarget(k) { S.to = k; S.el.tgt.value = k; lsSet('lgmc_mix_to', k); inputState(); }
  const target = () => (isMix(S.room) ? S.to : S.room === 'mine' ? 'mine' : S.room === 'pm' ? 'pm' : S.room === 'guild' ? 'guild' : S.tab);

  function inputState() {
    const t = target();
    const gate = !['mine', 'dm', 'pm', 'guild'].includes(t) && !S.inCity;
    const gdg = t === 'guild' ? gdCur() : null, gdOff = t === 'guild' && (!gdg || !!gdg.gone || !!gdg.wait || GD.view === 'home' || GD.view === 'pin');
    const ro = t === 'ev';
    const banned = (t === 'pm' || t === 'dm') && !!S.pm.ban;
    const off = !S.me || gate || ro || banned || gdOff || (t === 'pm' && !S.flags.dm);
    S.el.inp.disabled = off; S.el.send.disabled = off; S.el.emb.disabled = off; if (S.el.pb) S.el.pb.disabled = off;
    { const gp = S.el.gpb || (S.el.gpb = document.getElementById('gpb')); if (gp) { const gg = S.room === 'guild' ? gdCur() : null; gp.hidden = !(gg && !gg.gone && !gg.wait && gdIsMem(gg, S.me)); gp.setAttribute('aria-pressed', String(S.room === 'guild' && GD.view === 'poll')); } }
    if (off) { pickerOpen(false, true); pastesOpen(false, true); }
    S.el.inp.placeholder = !S.me ? 'Войди через Twitch на сайте игры, чтобы писать'
      : gate ? (S.room === 'all' ? 'Чтобы писать в город, войди в город' : 'Сначала войди в город')
      : ro ? 'Здесь только события игры'
      : banned ? 'Модератор закрыл тебе личку'
      : t === 'guild' ? (!gdg || GD.view === 'home' ? 'Выбери гильдию или создай свою' : gdg.wait ? 'Ждём, пока глава подтвердит…' : gdg.gone ? 'Гильдия недоступна' : `Написать в «${gdName(gdg)}»…`)
      : t === 'pm' ? (S.pm.peer ? `Лично для ${pmName(S.pm.peer)}…` : '@ник сообщение — новый диалог')
      : t === 'mine' ? 'Написать в чат шахты…'
      : t === 'tr' ? 'Куплю / продам / меняю…'
      : t === 'dm' ? '@ник сообщение — лично'
      : 'Написать в чат города…';
  }

  // ---------- Стикеры: эмоуты 7TV / BTTV / FFZ канала ----------
  // Чат игры хранит только текст; «стикер» — это слово-код эмоута (catJAM, HUH…),
  // картинкой его показывают 7TV и подобные. Здесь: загружаем наборы канала, рисуем коды картинками,
  // а панель выбора вставляет код в сообщение.
  const EM = new Map();          // код → { n, u (1x), u2 (2x), src, zw }
  const EM_SETS = [];            // [{ id, name, list: [codes] }]
  const EM_RECENT = 'lgmc_em_recent';
  const EM_TTL = 6 * 3600e3;

  async function getJson(u, ms = 12000) {
    const c = new AbortController(), tm = setTimeout(() => c.abort(), ms);
    try { const r = await pfetch(u, { signal: c.signal, credentials: 'omit' }); return r.ok ? await r.json() : null; }
    catch { return null; } finally { clearTimeout(tm); }
  }
  const http = (u) => (u && u.startsWith('//') ? 'https:' + u : u);

  function from7tv(list, src) {
    return (list || []).map((e) => {
      const d = e.data || {}, host = d.host && d.host.url ? http(d.host.url) : `https://cdn.7tv.app/emote/${e.id}`;
      return { n: e.name, u: `${host}/1x.webp`, u2: `${host}/2x.webp`, src, zw: !!((e.flags | (d.flags || 0)) & 256) };
    });
  }

  async function emFetch(ch) {
    const user = await getJson(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(ch)}`);
    const tid = Array.isArray(user) && user[0] && user[0].id;
    const [s7, g7, bt, bg, ff, fg] = await Promise.all([
      tid ? getJson(`https://7tv.io/v3/users/twitch/${tid}`) : null,
      getJson('https://7tv.io/v3/emote-sets/global'),
      tid ? getJson(`https://api.betterttv.net/3/cached/users/twitch/${tid}`) : null,
      getJson('https://api.betterttv.net/3/cached/emotes/global'),
      tid ? getJson(`https://api.frankerfacez.com/v1/room/id/${tid}`) : null,
      getJson('https://api.frankerfacez.com/v1/set/global'),
    ]);
    const bttv = (l, src) => (l || []).map((e) => ({ n: e.code, u: `https://cdn.betterttv.net/emote/${e.id}/1x`, u2: `https://cdn.betterttv.net/emote/${e.id}/2x`, src }));
    const ffz = (j, src, only) => (j && j.sets ? Object.entries(j.sets).filter(([id]) => !only || only.includes(+id)) : [])
      .flatMap(([, s]) => (s.emoticons || []).map((e) => ({ n: e.name, u: http(e.urls['1']), u2: http(e.urls['2'] || e.urls['1']), src })));
    return [
      { id: '7tv', name: '7TV канала', list: from7tv(s7 && s7.emote_set && s7.emote_set.emotes, '7TV') },
      { id: 'bttv', name: 'BTTV', list: [...bttv(bt && bt.channelEmotes, 'BTTV'), ...bttv(bt && bt.sharedEmotes, 'BTTV')] },
      { id: 'ffz', name: 'FFZ', list: ffz(ff, 'FFZ') },
      { id: 'glob', name: 'Глобальные', list: [...from7tv(g7 && g7.emotes, '7TV'), ...bttv(bg, 'BTTV'), ...ffz(fg, 'FFZ', fg && fg.default_sets)] },
    ];
  }

  function emUse(sets) {
    EM.clear(); EM_SETS.length = 0;
    // приоритет как у 7TV-расширения: канал 7TV > BTTV > FFZ > глобальные
    for (const s of sets) {
      const codes = [];
      for (const e of s.list) { if (!e.n || EM.has(e.n)) continue; EM.set(e.n, e); codes.push(e.n); }
      if (codes.length) EM_SETS.push({ id: s.id, name: s.name, list: codes });
    }
    if (!EM_SETS.some((s) => s.id === S.ptab) && S.ptab !== 'recent') S.ptab = 'recent';
    pickerTabs(); pickerRender();
    for (const li of S.el.log.querySelectorAll('li[data-key]')) {   // перерисовать уже показанные сообщения
      const m = S.list.find((x) => x._key === li.dataset.key); if (m) li.replaceWith(row(m));
    }
    if (S.stick) toBottom();
  }

  async function emLoad() {
    const ch = S.ch, key = 'lgmc_em_' + ch;
    const cached = lsGet(key, null);
    if (cached && cached.sets) emUse(cached.sets); else emUse([]);
    if (cached && Date.now() - cached.at < EM_TTL) return;
    const sets = await emFetch(ch);
    if (ch !== S.ch) return;   // пока грузили — переключились на другой канал
    if (!sets.some((s) => s.list.length)) { if (!cached) S.el.eh.textContent = 'Не удалось загрузить стикеры — проверь интернет'; return; }
    lsSet(key, { at: Date.now(), sets });
    emUse(sets);
  }

  // ---------- Панель выбора стикеров ----------
  S.ptab = 'recent';
  const EM_FAV = 'lgmc_em_fav';
  const favs = () => { const r = lsGet(EM_FAV, []); return Array.isArray(r) ? r : []; };
  function favToggle(n) { const f = favs(), i = f.indexOf(n); if (i >= 0) f.splice(i, 1); else f.unshift(n); lsSet(EM_FAV, f.slice(0, 60)); pickerTabs(); pickerRender(); S.el.eh.textContent = i >= 0 ? `${n} — убран из избранного` : `★ ${n} — в избранном`; }
  const recent = () => { const r = lsGet(EM_RECENT, []); return Array.isArray(r) ? r : []; };

  function pickerInit() {
    Object.assign(S.el, {
      emb: document.getElementById('emb'), ep: document.getElementById('ep'), eq: document.getElementById('eq'),
      etabs: document.getElementById('etabs'), eg: document.getElementById('eg'), eh: document.getElementById('eh'),
    });
    S.el.emb.onclick = () => pickerOpen(!S.el.ep.classList.contains('on'));
    S.el.eq.oninput = () => pickerRender();
    S.el.eq.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const b = S.el.eg.querySelector('button'); if (b) b.click(); }
      if (e.key === 'Escape') pickerOpen(false);
    };
    S.el.etabs.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.ptab = b.dataset.t; S.el.eq.value = ''; pickerTabs(); pickerRender(); };
    S.el.eg.onclick = (e) => { const b = e.target.closest('button[data-n]'); if (b) insertEmote(b.dataset.n, !e.shiftKey); };
    S.el.eg.oncontextmenu = (e) => { const b = e.target.closest('button[data-n]'); if (b) { e.preventDefault(); favToggle(b.dataset.n); } };   // правый клик — ★ в избранное
    S.el.eg.onmouseover = (e) => { const b = e.target.closest('button[data-n]'); if (b) { const em = EM.get(b.dataset.n); S.el.eh.textContent = em ? `${em.n} · ${em.src}` : b.dataset.n; } };
    S.onEsc = (e) => {
      if (e.key !== 'Escape') return;
      if (S.el.sp && !S.el.sp.hidden) { czOpen(false); return; }
      const ep = S.el.ep.classList.contains('on'), pp = S.el.pp && S.el.pp.classList.contains('on'), mp = S.el.mp && S.el.mp.classList.contains('on');
      if (ep) pickerOpen(false);
      if (pp) pastesOpen(false);
      if (mp) modPanel(false);
      if (!ep && !pp && !mp && S.room === 'pm' && S.pm.peer && !S.el.inp.value.trim() && !S.pm.rep) pmBack();   // из переписки — к диалогам
    };
    document.addEventListener('keydown', S.onEsc);
    pickerTabs();
    emLoad();
  }

  function pickerOpen(on, quiet) {
    if (on) pastesOpen(false, true);
    if (!on && !S.el.ep.classList.contains('on')) return;
    S.el.ep.classList.toggle('on', on);
    S.el.emb.setAttribute('aria-expanded', String(on));
    if (on) { if (S.ptab === 'recent' && favs().length) S.ptab = 'fav'; if (!recent().length && S.ptab === 'recent' && EM_SETS[0]) S.ptab = EM_SETS[0].id; pickerTabs(); pickerRender(); S.el.eq.focus(); }
    else if (!quiet && !S.el.inp.disabled) S.el.inp.focus();
    if (S.stick) toBottom();
  }

  function pickerTabs() {
    if (!S.el.etabs) return;
    const tabs = [{ id: 'fav', name: `★ Избранные${favs().length ? ' ' + favs().length : ''}` }, { id: 'recent', name: 'Недавние' }, ...EM_SETS.map((s) => ({ id: s.id, name: `${s.name} ${s.list.length}` }))];
    S.el.etabs.innerHTML = tabs.map((t) => `<button type="button" role="tab" data-t="${t.id}" aria-selected="${t.id === S.ptab}">${esc(t.name)}</button>`).join('');
  }

  function pickerRender() {
    if (!S.el.eg || !S.el.ep.classList.contains('on')) return;
    const q = S.el.eq.value.trim().toLowerCase();
    let codes;
    if (q) {   // поиск — по всем наборам; сначала начинающиеся с запроса
      const all = [...EM.keys()].filter((n) => n.toLowerCase().includes(q));
      codes = [...all.filter((n) => n.toLowerCase().startsWith(q)), ...all.filter((n) => !n.toLowerCase().startsWith(q))];
    } else if (S.ptab === 'fav') codes = favs().filter((n) => EM.has(n));
    else if (S.ptab === 'recent') codes = recent().filter((n) => EM.has(n));
    else codes = (EM_SETS.find((s) => s.id === S.ptab) || { list: [] }).list;
    if (!codes.length) {
      S.el.eg.innerHTML = `<p>${!EM.size ? 'Загружаю стикеры…' : q ? 'Ничего не нашлось' : S.ptab === 'fav' ? 'Нажми на стикер правой кнопкой — он появится здесь ★' : 'Здесь появятся стикеры, которые ты отправлял'}</p>`;
      return;
    }
    const fv = new Set(favs());
    S.el.eg.innerHTML = codes.map((n) => { const e = EM.get(n);   // картинки грузятся лениво — по мере прокрутки
      return `<button type="button" data-n="${esc(n)}" title="${esc(n)}"${fv.has(n) ? ' class="fav"' : ''}><img src="${esc(e.u2)}" alt="${esc(n)}" loading="lazy" decoding="async"></button>`; }).join('');
    S.el.eh.textContent = q ? `Найдено: ${codes.length}` : 'Клик — вставить, Shift+клик — не закрывать, правый клик — ★ в избранное';
  }

  function insertEmote(n, close) {
    const inp = S.el.inp, v = inp.value;
    const a = inp.selectionStart ?? v.length, b = inp.selectionEnd ?? v.length;
    const pre = v.slice(0, a), post = v.slice(b);
    const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + n + (post && /^\s/.test(post) ? '' : ' ');
    if ((pre + ins + post).length > 200) { S.el.err.textContent = 'Сообщение длиннее 200 символов — стикер не влез'; return; }
    inp.value = pre + ins + post;
    const pos = (pre + ins).length; inp.setSelectionRange(pos, pos);
    const r = recent().filter((x) => x !== n); r.unshift(n);
    lsSet(EM_RECENT, r.slice(0, 40));
    if (close) pickerOpen(false); else S.el.eq.focus();
  }

  // ---------- Пасты: сохранённые сообщения с названиями ----------
  // Хранятся в браузере (localStorage сайта игры), общие для всех каналов и комнат.
  const PASTE_KEY = 'lgmc_pastes', PASTE_MAX = 200;
  const pastes = () => { const v = lsGet(PASTE_KEY, []); return Array.isArray(v) ? v.filter((x) => x && x.id && typeof x.t === 'string') : []; };
  const pastesSave = (list) => lsSet(PASTE_KEY, list);

  function pastesInit() {
    const $ = (id) => document.getElementById(id);
    Object.assign(S.el, { pb: $('pb'), pp: $('pp'), pq: $('pq'), pl: $('pl'), pn: $('pn'), pt: $('pt'), pc: $('pc') });
    S.el.pb.onclick = () => pastesOpen(!S.el.pp.classList.contains('on'));
    S.el.pq.oninput = () => pastesRender();
    S.el.pq.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const b = S.el.pl.querySelector('.pi'); if (b) b.click(); }
    };
    $('pnew').onclick = () => pasteEdit(null);
    $('pcancel').onclick = () => { S.el.pp.classList.remove('edit'); S.el.pq.focus(); };
    $('psave').onclick = () => pasteSaveCur();
    S.el.pt.oninput = () => pasteCount();
    S.el.pn.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); S.el.pt.focus(); } };
    S.el.pt.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); pasteSaveCur(); } };
    S.el.pl.onclick = (e) => {
      const li = e.target.closest('li[data-id]'); if (!li) return;
      const id = li.dataset.id, act = e.target.closest('[data-a]');
      if (!act) return;
      if (act.dataset.a === 'use') pasteUse(id, e.shiftKey);
      else if (act.dataset.a === 'edit') pasteEdit(id);
      else if (act.dataset.a === 'del') {
        if (!act.classList.contains('sure')) {   // удаление — в два нажатия
          act.classList.add('sure'); act.textContent = 'Удалить?';
          setTimeout(() => { if (act.isConnected) { act.classList.remove('sure'); act.textContent = '🗑'; } }, 3000);
          return;
        }
        pastesSave(pastes().filter((x) => x.id !== id)); pastesRender();
      }
    };
  }

  function pastesOpen(on, quiet) {
    if (!S.el.pp) return;
    if (on) pickerOpen(false, true);
    if (!on && !S.el.pp.classList.contains('on')) return;
    S.el.pp.classList.toggle('on', on);
    S.el.pb.setAttribute('aria-expanded', String(on));
    if (on) { S.el.pp.classList.remove('edit'); S.el.pq.value = ''; pastesRender(); (pastes().length ? S.el.pq : document.getElementById('pnew')).focus(); }
    else if (!quiet && !S.el.inp.disabled) S.el.inp.focus();
    if (S.stick) toBottom();
  }

  function pastesRender() {
    const q = S.el.pq.value.trim().toLowerCase();
    const all = pastes();
    const list = q ? all.filter((x) => (x.n || '').toLowerCase().includes(q) || x.t.toLowerCase().includes(q)) : all;
    if (!list.length) {
      S.el.pl.innerHTML = `<p>${all.length ? 'Ничего не нашлось' : 'Пока пусто. Нажми «＋ Новая» — текст из поля ввода подставится сам.'}</p>`;
      return;
    }
    S.el.pl.innerHTML = list.map((x) => `<li data-id="${esc(x.id)}"><button type="button" class="pi" data-a="use" title="Вставить (Shift — заменить всё сообщение)"><b>${esc(x.n || 'Без названия')}</b><span>${esc(x.t)}</span></button><button type="button" class="px" data-a="edit" title="Изменить" aria-label="Изменить «${esc(x.n || '')}»">✏</button><button type="button" class="px" data-a="del" title="Удалить" aria-label="Удалить «${esc(x.n || '')}»">🗑</button></li>`).join('');
  }

  function pasteCount() {
    const n = S.el.pt.value.length;
    S.el.pc.textContent = n > PASTE_MAX ? `${n} / ${PASTE_MAX} — длиннее, чем пропускает чат` : `${n} / ${PASTE_MAX}`;
    S.el.pc.classList.toggle('over', n > PASTE_MAX);
  }

  function pasteEdit(id) {
    const x = id ? pastes().find((p) => p.id === id) : null;
    S.editId = x ? x.id : null;
    S.el.pn.value = x ? x.n || '' : '';
    S.el.pt.value = x ? x.t : S.el.inp.value.trim();   // новая паста — из того, что уже набрано
    pasteCount();
    S.el.pp.classList.add('edit');
    S.el.pn.focus();
  }

  function pasteSaveCur() {
    const t = S.el.pt.value.trim();
    if (!t) { S.el.pt.focus(); return; }
    const n = S.el.pn.value.trim() || t.slice(0, 24);
    const list = pastes();
    if (S.editId) { const x = list.find((p) => p.id === S.editId); if (x) { x.n = n; x.t = t; } }
    else list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), n, t });
    pastesSave(list);
    S.el.pp.classList.remove('edit');
    pastesRender(); S.el.pq.focus();
  }

  function pasteUse(id, replace) {
    const x = pastes().find((p) => p.id === id); if (!x) return;
    const inp = S.el.inp, v = replace ? '' : inp.value;
    const a = replace ? 0 : inp.selectionStart ?? v.length, b = replace ? 0 : inp.selectionEnd ?? v.length;
    const pre = v.slice(0, a), post = v.slice(b);
    const ins = (pre && !/\s$/.test(pre) ? ' ' : '') + x.t + (post && !/^\s/.test(post) ? ' ' : '');
    if ((pre + ins + post).length > PASTE_MAX) { S.el.err.textContent = `Не влезает: сообщение длиннее ${PASTE_MAX} символов`; return; }
    S.el.err.textContent = '';
    inp.value = pre + ins + post;
    pastesOpen(false);
    const pos = (pre + ins).length; inp.setSelectionRange(pos, pos);
    const list = pastes(), i = list.findIndex((p) => p.id === id);   // недавно использованные — наверх
    if (i > 0) { list.unshift(list.splice(i, 1)[0]); pastesSave(list); }
  }

  // ---------- Отрисовка сообщений ----------
  function fmtText(t) {
    // слова-коды эмоутов → картинки; @ники — подсветка; zero-width эмоуты (7TV) накладываются на предыдущий
    const out = [];
    for (const part of String(t).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { out.push(part); continue; }
      const e = CZ.emotes === false ? null : EM.get(part);
      if (e) {
        const img = `<img class="em" src="${esc(e.u)}" srcset="${esc(e.u2)} 2x" alt="${esc(part)}" title="${esc(part)} · ${e.src}" loading="lazy">`;
        if (e.zw) {
          let k = out.length - 1; while (k >= 0 && /^\s+$/.test(out[k])) k--;
          if (k >= 0 && /^<(img class="em"|span class="zw")/.test(out[k])) {
            out.splice(k + 1);
            out[k] = out[k].startsWith('<span class="zw"') ? out[k].replace(/<\/span>$/, img + '</span>') : `<span class="zw">${out[k]}${img}</span>`;
            continue;
          }
        }
        out.push(img); continue;
      }
      const m = part.match(/^@([a-z0-9_]{2,25})(.*)$/i);
      out.push(m ? `<span class="at" data-at="${esc(m[1].toLowerCase())}" role="button" tabindex="0" title="Показать последние сообщения @${esc(m[1])}">@${esc(m[1])}</span>${esc(m[2])}` : esc(part));
    }
    return out.join('');
  }

  function row(msg) {
    const li = document.createElement('li');
    const k = kind(msg);
    li.dataset.key = msg._key; li.dataset.k = k;
    const text = String(msg.t || '');
    if (msg.sys) { li.className = 'sys'; li.textContent = text; return li; }
    const other = msg._ch && msg._ch !== S.ch;   // пинг с другого канала (из сохранённых)
    const chip = isMix(S.room) ? `<span class="src k-${k}">${SRC[k]}${other ? ' · ' + esc(msg._chn || msg._ch) : ''}</span>` : '';
    if (msg.ev) {   // «Летопись»: событие игры
      li.className = 'ev';
      li.innerHTML = `<span class="t">${msg.at ? hhmm(msg.at) : ''}</span>${chip}📜 ${fmtText(text)}`;
      return li;
    }
    const l = String(msg.l || '').toLowerCase();
    if (isMention(text, l) && S.room !== 'ping') li.className = 'mention';
    const ico = msg.c ? `<span title="${esc(msg.cn || msg.c)}">${CLS_ICO[msg.c] || '◆'}</span> ` : '';
    const ri = ROLE_ICO[msg.r]; const role = ri ? `<span title="${ri[1]}">${ri[0]}</span> ` : '';
    const aw = (msg.aw || []).map((a) => `<span class="aw" title="${esc(a.n)}${a.d ? ' — ' + esc(a.d) : ''}">${esc(a.i || '✦')}</span>`).join('');
    const to = msg.k === 'dm' && msg.to ? ` <span class="to" title="Личное">→ <span class="n" data-l="${esc(String(msg.to).toLowerCase())}">${esc(msg.to)}</span></span>` : '';
    // ответ с цитатой — как на Twitch: над сообщением серая строка «💬 Ответ @ник: начало его сообщения», ниже — обычная строка
    const qm = QUOTE_RE.exec(text), ql = qm ? qm[1].toLowerCase() : '', toMe = !!qm && ql === S.me;
    const qq = qm ? `<span class="rq${toMe ? ' me' : ''}" data-ql="${esc(ql)}" data-qt="${esc(qm[2])}" title="Перейти к сообщению" role="link" tabindex="0">${RQ_ICO}${toMe ? 'Ответ тебе' : `Ответ @${esc(dispName(ql))}`}: ${esc(qm[2])}</span>` : '';
    li.innerHTML = `${qq}<span class="t">${msg.at ? hhmm(msg.at) : ''}</span>${chip}${role}${ico}<span class="n" data-l="${esc(l)}" style="color:${ncol(l)}" title="${aliasOf(l) ? `${esc(msg.n || msg.l)} (твоё прозвище) — ` : ''}Ответить @${esc(l)}">${esc(aliasOf(l) || msg.n || msg.l)}</span>${aw}${to}: ${fmtText(qm ? qm[3] : text)}`;
    if (qm) li.classList.add('hasq');
    const nEl = li.querySelector('.n[data-l]');
    const isFr = !!l && (msg._fr || S.pm.frState.get(l) === 'friends');
    if (nEl && isFr) nEl.insertAdjacentHTML('afterend', '<span class="frm" title="Друг">👥</span>');
    if (nEl && isExt(l)) nEl.insertAdjacentHTML('afterend', extBadge(l));
    // выделение: модераторы и админ чата, друзья (цвет и вкл/выкл — в ⚙)
    if (ri) li.classList.add('role', 'r-' + msg.r);
    if (isFr && l !== S.me) li.classList.add('fr');
    if (nEl && S.flags.dm && S.me && l && l !== S.me && S.room !== 'pm' && !S.pm.blocked(l)) {
      const d = document.createElement('button');
      d.type = 'button'; d.className = 'dmb'; d.textContent = '✉'; d.dataset.l = l; d.dataset.n = msg.n || msg.l;
      d.title = 'Написать лично'; d.setAttribute('aria-label', `Написать лично: ${msg.n || msg.l}`);
      nEl.after(d);
    }
    if (!other && S.room !== 'pm' && msg._src !== 'pm' && msg.k !== 'dm') {   // ↩ ответить с цитатой
      const rb = document.createElement('button'); rb.type = 'button'; rb.className = 'rpb'; rb.textContent = '↩';
      rb.title = 'Ответить с цитатой'; rb.setAttribute('aria-label', `Ответить ${msg.n || msg.l} с цитатой`); li.appendChild(rb);
    }
    if (!other) {   // ☆ в закладки
      const on = bmHas(S.ch + '|' + msg._key), bb = document.createElement('button'); bb.type = 'button'; bb.className = 'bmb' + (on ? ' on' : ''); bb.textContent = on ? '★' : '☆';
      bb.title = on ? 'Убрать из закладок' : 'В закладки'; bb.setAttribute('aria-label', bb.title); li.appendChild(bb);
      if (on) li.classList.add('bmk');
    }
    {   // ⧉ скопировать текст сообщения
      const cb = document.createElement('button'); cb.type = 'button'; cb.className = 'cpb'; cb.textContent = '⧉';
      cb.title = 'Скопировать сообщение'; cb.setAttribute('aria-label', `Скопировать сообщение ${msg.n || msg.l}`); li.appendChild(cb);
    }
    if (S.room === 'ping') {   // перейти в тот чат, где позвали (тот же канал — шахта или город)
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'pgo'; go.textContent = '→'; go.dataset.ch = msg._ch || S.ch; go.dataset.room = msg._src === 'mine' ? 'mine' : 'city';
      go.title = `Открыть чат ${msg._src === 'mine' ? 'шахты' : 'города'}${other ? ' канала ' + (msg._chn || msg._ch) : ''}`; go.setAttribute('aria-label', go.title);
      li.appendChild(go);
      if (other) return li;
    }
    if (canMod(msg._src) && l !== S.me) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'mb'; b.textContent = '⋯';
      b.title = 'Модерация'; b.setAttribute('aria-label', `Модерация: ${msg.n || msg.l}`); b.setAttribute('aria-haspopup', 'menu');
      li.appendChild(b);
    }
    // кнопки при наведении — в ряд справа: ↩, ✉, ⋯ (в «Пингах» — левее «→»)
    let rx = S.room === 'ping' ? 36 : 2;
    for (const c of ['cpb', 'bmb', 'rpb', 'dmb', 'mb']) { const x = li.querySelector('.' + c); if (x) { x.style.right = rx + 'px'; rx += 32; } }
    return li;
  }

  function toBottom() {
    S.el.log.scrollTop = S.el.log.scrollHeight; S.stick = true; S.unseen = 0; S.el.more.style.display = 'none';
  }

  // ---------- Модерация (только для админа и модераторов чата — права проверяет сервер игры) ----------
  // Как в игре: POST <чат>/mod { op: del | mute | ban | unban | mod | unmod, id, login, min }, GET <чат>/mod — роль и список ограничений.
  const MUTES = [[5, '5 мин'], [30, '30 мин'], [60, '1 ч'], [1440, '1 день'], [10080, '7 дней']];
  const ROLE_NAME = { own: 'админ чата', mod: 'модератор' };
  S.mod = { mine: null, city: null };   // { role, bans: [{ l, until, by }], mods: [] } или null — прав нет
  const modBase = (src) => (src === 'mine' ? `/api/mine/chat/mod?c=${encodeURIComponent(S.mine)}` : '/api/city/chat/mod');
  const canMod = (src) => !!(S.mod[src] && S.mod[src].role);
  const leftT = (ms) => { const m = Math.max(1, Math.ceil(ms / 60000)); return m < 60 ? `${m} мин` : m < 1440 ? `${Math.ceil(m / 60)} ч` : `${Math.ceil(m / 1440)} дн`; };
  const muteName = (min) => (MUTES.find((x) => x[0] === min) || [0, leftT(min * 60000)])[1];
  // короткие подтверждения («Скопировано», «В закладках»…) — их можно выключить в ⚙
  function okTip(t) { if (CZ.tips !== false) okMsg(t); }
  function okMsg(t) {
    S.el.okm.textContent = t; S.el.err.textContent = '';
    clearTimeout(S.okT); S.okT = setTimeout(() => { S.el.okm.textContent = ''; }, 5000);
  }

  function modInit() {
    S.el.modb = document.getElementById('modb'); S.el.mp = document.getElementById('mp'); S.el.okm = document.getElementById('okm');
    S.el.modb.onclick = () => modPanel(!S.el.mp.classList.contains('on'));
  }

  // какие чаты сейчас на экране — для них и спрашиваем права (запрос только на чтение)
  const modSources = () => [...(usesMine(S.room) && S.mines.length ? ['mine'] : []), ...(usesCity(S.room) && (!S.hero || S.flags.cc) ? ['city'] : [])];
  async function modLoad(gen, only) {
    const srcs = only ? [only] : modSources();
    if (!only) S.mod = { mine: null, city: null };
    await Promise.all(srcs.map(async (src) => {
      let r = null; try { r = await api(modBase(src)); } catch {}
      if (gen != null && gen !== S.gen) return;
      S.mod[src] = r && r.ok && (r.role === 'own' || r.role === 'mod') ? { role: r.role, bans: r.bans || [], mods: r.mods || [] } : null;
    }));
    if (gen != null && gen !== S.gen) return;
    modUi();
  }
  // показать/спрятать инструменты: кнопка 🔨, «⋯» у сообщений, подсказка про команды
  function modUi() {
    const any = canMod('mine') || canMod('city');
    S.el.modb.hidden = !any;
    if (!any) modPanel(false);
    renderLog();
    if (S.el.mp.classList.contains('on')) modPanelRender();
  }

  async function modAct(src, op, o) {
    if (!canMod(src)) return false;
    let r = null;
    try { r = await api(modBase(src), { op, id: o.id, login: o.login, min: o.min }); } catch {}
    if (!r || !r.ok) { S.el.err.textContent = 'Модерация: ' + ((r && (ERR[r.error] || r.error)) || 'нет связи'); return false; }
    const del = [...(op === 'del' ? [r.id || o.id] : []), ...(Array.isArray(r.gone) ? r.gone : [])];
    if (del.length) apply({ chatDel: del }, src);
    const who = o.n || o.login || '';
    okMsg({ del: 'Сообщение удалено', mute: `${who}: мут ${muteName(o.min)}`, ban: `${who}: бан навсегда${del.length ? ` — удалено сообщений: ${del.length}` : ''}`,
      unban: `${who}: снова может писать`, mod: `${who} — теперь модератор чата`, unmod: `${who} больше не модератор` }[op] || 'Готово');
    if (op === 'mod' || op === 'unmod') for (const m of S.list) if (m._src === src && String(m.l).toLowerCase() === String(r.login || o.login).toLowerCase()) m.r = op === 'mod' ? 'mod' : undefined;
    await modLoad(null, src);
    return true;
  }

  // ---- меню «⋯» у сообщения ----
  function modMenuClose() {
    const m = S.mmenu; if (!m) return; S.mmenu = null;
    m.el.remove(); m.from.setAttribute('aria-expanded', 'false');
    m.doc.removeEventListener('pointerdown', m.out, true); m.doc.removeEventListener('keydown', m.key, true);
  }
  function modMenu(msg, from) {
    if (S.mmenu && S.mmenu.from === from) { modMenuClose(); return; }
    modMenuClose();
    const src = msg._src, info = S.mod[src]; if (!info) return;
    const doc = from.ownerDocument, l = String(msg.l || '').toLowerCase(), name = msg.n || msg.l;
    const ban = (info.bans || []).find((x) => String(x.l).toLowerCase() === l);
    const isMod = (info.mods || []).map((x) => String(x).toLowerCase()).includes(l) || msg.r === 'mod';
    const el = doc.createElement('div'); el.className = 'mm'; el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="mh">${esc(name)}<small>${src === 'mine' ? 'чат шахты' : 'чат города'} · ты ${ROLE_NAME[info.role]}${ban ? ` · ${ban.until ? 'мут до ' + hhmm(ban.until) : 'забанен'}` : ''}</small></div>
      <button type="button" role="menuitem" data-a="del">🗑 Удалить это сообщение</button>
      <div class="row" role="group" aria-label="Мут"><span>Мут:</span>${MUTES.map(([m, t]) => `<button type="button" role="menuitem" data-a="mute" data-min="${m}">${t}</button>`).join('')}</div>
      <div class="row"><span>или</span><input type="number" min="1" max="10080" placeholder="мин" aria-label="Мут на минут"><button type="button" data-a="mutex">Мут</button></div>
      <button type="button" role="menuitem" class="danger" data-a="ban">⛔ Бан навсегда</button>
      ${ban ? `<button type="button" role="menuitem" data-a="unban">✅ Снять ${ban.until ? 'мут' : 'бан'}</button>` : ''}
      ${info.role === 'own' ? `<button type="button" role="menuitem" data-a="${isMod ? 'unmod' : 'mod'}">${isMod ? '🛡 Снять модератора' : '🛡 Сделать модератором'}</button>` : ''}`;
    doc.body.appendChild(el);
    // рядом с «⋯», не за краем окна
    const r = from.getBoundingClientRect(), vw = doc.defaultView.innerWidth, vh = doc.defaultView.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(r.right - w, vw - w - 8)) + 'px';
    el.style.top = (r.bottom + 4 + h > vh - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
    from.setAttribute('aria-expanded', 'true');
    const o = { id: msg.id, login: l, n: name };
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      const a = b.dataset.a;
      if (a === 'ban' && !b.classList.contains('sure')) {   // бан — в два нажатия: все сообщения игрока пропадут у всех
        b.classList.add('sure'); b.textContent = 'Точно забанить? Все его сообщения пропадут у всех';
        return;
      }
      let op = a, min;
      if (a === 'mute') min = +b.dataset.min;
      if (a === 'mutex') {
        min = Math.round(+el.querySelector('input').value);
        if (!(min >= 1 && min <= 10080)) { el.querySelector('input').focus(); S.el.err.textContent = 'Срок мута — от 1 до 10080 минут (7 дней)'; return; }
        op = 'mute';
      }
      modMenuClose();
      await modAct(src, op, { ...o, min });
    });
    el.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.querySelector('[data-a="mutex"]').click(); } });
    const out = (e) => { if (!el.contains(e.target) && e.target !== from) modMenuClose(); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); modMenuClose(); from.focus(); } };
    doc.addEventListener('pointerdown', out, true); doc.addEventListener('keydown', key, true);
    S.mmenu = { el, from, doc, out, key };
    const first = el.querySelector('button'); if (first) first.focus();
  }

  // ---- панель 🔨: ограничения, выдать мут/бан по нику, модераторы ----
  function modPanel(on) {
    if (!S.el.mp) return;
    if (on) { pickerOpen(false, true); pastesOpen(false, true); }
    S.el.mp.classList.toggle('on', on);
    S.el.modb.setAttribute('aria-expanded', String(on));
    if (on) { const srcs = ['mine', 'city'].filter(canMod); if (!srcs.includes(S.msrc)) S.msrc = srcs.includes(S.room === 'mine' ? 'mine' : 'city') ? (S.room === 'mine' ? 'mine' : 'city') : srcs[0]; modPanelRender(); }
    if (S.stick) toBottom();
  }
  function modPanelRender() {
    const srcs = ['mine', 'city'].filter(canMod), src = S.msrc, info = S.mod[src];
    if (!info) { S.el.mp.innerHTML = '<p>Нет прав модератора в этом чате.</p>'; return; }
    const now = Date.now();
    const bans = (info.bans || []).filter((x) => !x.until || x.until > now);
    S.el.mp.innerHTML = `${srcs.length > 1 ? `<span class="seg" role="group" aria-label="Чат">${srcs.map((x) => `<button type="button" data-ms="${x}" aria-pressed="${x === src}">${x === 'mine' ? '⛏ Шахта' : '🏰 Город'}</button>`).join('')}</span>` : ''}
      <h4>ОГРАНИЧЕНИЯ · ${src === 'mine' ? 'ЧАТ ШАХТЫ' : 'ЧАТ ГОРОДА'} · ТЫ ${ROLE_NAME[info.role].toUpperCase()}</h4>
      ${bans.length ? `<ul>${bans.map((x) => `<li><b>${esc(x.l)}</b><span>${x.until ? `мут до ${hhmm(x.until)} (ещё ${leftT(x.until - now)})` : 'бан навсегда'}${x.by ? ` · ${esc(x.by)}` : ''}</span><button type="button" data-unban="${esc(x.l)}">Снять</button></li>`).join('')}</ul>` : '<p>Сейчас ни у кого нет мута или бана.</p>'}
      <form id="mpf" autocomplete="off"><input id="mpn" maxlength="26" placeholder="ник" aria-label="Ник, кого ограничить"><select id="mpt" aria-label="Срок">${MUTES.map(([m, t]) => `<option value="${m}">мут ${t}</option>`).join('')}<option value="ban">бан навсегда</option></select><button type="submit" id="mpg">Применить</button></form>
      ${info.role === 'own' ? `<h4>МОДЕРАТОРЫ ЧАТА</h4>${(info.mods || []).length ? `<ul>${info.mods.map((x) => `<li><b>${esc(x)}</b><span></span><button type="button" data-unmod="${esc(x)}">Снять</button></li>`).join('')}</ul>` : '<p>Модераторов пока нет.</p>'}
      <form id="mpm" autocomplete="off"><input id="mpmn" maxlength="26" placeholder="ник нового модератора" aria-label="Ник нового модератора"><button type="submit">Назначить</button></form>` : ''}
      <div class="help">Команды в поле ввода: /mute ник [минут] · /ban ник · /unban ник${info.role === 'own' ? ' · /mod ник · /unmod ник' : ''} · /mods</div>`;
    const mp = S.el.mp, $q = (sel) => mp.querySelector(sel);
    mp.onclick = async (e) => {
      const ms = e.target.closest('[data-ms]'); if (ms) { S.msrc = ms.dataset.ms; modPanelRender(); return; }
      const ub = e.target.closest('[data-unban]'); if (ub) { ub.disabled = true; await modAct(src, 'unban', { login: ub.dataset.unban, n: ub.dataset.unban }); return; }
      const um = e.target.closest('[data-unmod]'); if (um) { um.disabled = true; await modAct(src, 'unmod', { login: um.dataset.unmod, n: um.dataset.unmod }); }
    };
    $q('#mpt').onchange = () => { const g = $q('#mpg'); g.classList.remove('sure'); g.textContent = 'Применить'; };
    $q('#mpf').onsubmit = async (e) => {
      e.preventDefault();
      const nick = $q('#mpn').value.trim().replace(/^@/, '').toLowerCase(), v = $q('#mpt').value, g = $q('#mpg');
      if (!/^[a-z0-9_]{2,25}$/.test(nick)) { $q('#mpn').focus(); S.el.err.textContent = 'Впиши ник игрока'; return; }
      if (v === 'ban' && !g.classList.contains('sure')) { g.classList.add('sure'); g.textContent = 'Точно? Все сообщения пропадут'; return; }
      g.disabled = true;
      const ok = v === 'ban' ? await modAct(src, 'ban', { login: nick, n: nick }) : await modAct(src, 'mute', { login: nick, n: nick, min: +v });
      if (!ok && g.isConnected) { g.disabled = false; g.classList.remove('sure'); g.textContent = 'Применить'; }
    };
    const fm = $q('#mpm');
    if (fm) fm.onsubmit = async (e) => {
      e.preventDefault();
      const nick = $q('#mpmn').value.trim().replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{2,25}$/.test(nick)) { $q('#mpmn').focus(); return; }
      await modAct(src, 'mod', { login: nick, n: nick });
    };
  }

  // ---- команды: /mute ник [минут] · /ban ник · /unban ник · /mod ник · /unmod ник · /mods ----
  async function modCommand(src, t) {
    const [c0, n0, arg] = t.slice(1).trim().split(/\s+/), cmd = String(c0 || '').toLowerCase(), nick = String(n0 || '').replace(/^@/, '').toLowerCase();
    const info = S.mod[src];
    const needNick = () => { if (/^[a-z0-9_]{2,25}$/.test(nick)) return true; S.el.err.textContent = `Укажи ник: /${cmd} ник`; return false; };
    if (cmd === 'help' || cmd === '?') { okMsg('/mute ник [минут] · /ban ник · /unban ник' + (info.role === 'own' ? ' · /mod ник · /unmod ник' : '') + ' · /mods'); return true; }
    if (cmd === 'mods') { okMsg(info.mods && info.mods.length ? `Модераторы (${info.mods.length}): ${info.mods.join(', ')}` : 'Модераторов чата пока нет'); return true; }
    if (cmd === 'mute') {
      if (!needNick()) return false;
      const m = arg == null ? 30 : Math.round(+arg);
      if (!(m >= 1 && m <= 10080)) { S.el.err.textContent = 'Срок мута — от 1 до 10080 минут (7 дней)'; return false; }
      return modAct(src, 'mute', { login: nick, n: nick, min: m });
    }
    if (cmd === 'ban' || cmd === 'unban') return needNick() && modAct(src, cmd, { login: nick, n: nick });
    if (cmd === 'mod' || cmd === 'unmod') {
      if (info.role !== 'own') { S.el.err.textContent = 'Назначать модераторов может только админ чата'; return false; }
      return needNick() && modAct(src, cmd, { login: nick, n: nick });
    }
    S.el.err.textContent = `Неизвестная команда /${cmd}. Есть: /mute, /ban, /unban${info.role === 'own' ? ', /mod, /unmod' : ''}, /mods`;
    return false;
  }

  // ---------- Настройки чата (⚙): цвета, фон, шрифт, сообщения, подсветка, звук, свой CSS ----------
  // Хранятся в браузере (lgmc_cz, картинка фона — lgmc_cz_bg) и общие для окна, панели в игре и закреплённого окна:
  // изменение в одном месте сразу применяется в остальных (событие storage).
  const CZ_KEY = 'lgmc_cz', CZ_BG = 'lgmc_cz_bg';
  const CZ_DEF = {
    dark: 'legion', light: 'legionl', accent: '', bgDim: 70, font: 'game', size: 14, density: 'normal', d2: 1,
    time: true, icons: true, awards: true, nickColor: true, emotes: true, emoteSize: 28,
    hl: '', hide: '', sound: false, volume: 50, css: '',
    hlMod: true, modColor: '#4f8df0', hlFriend: true, friendColor: '#3fbf6f',
    bgClear: 0, opac: 0, opHover: true, scrollbar: false, extShow: true, extTell: true, liveAlert: true, tips: true, guilds: false, rail: 'auto', hist: true, histMax: 1000,   // прозрачность панели в игре: фона и всего чата (%), непрозрачный при наведении
  };
  const BASE_V = { dark: { bg: '#120e22', panel: '#1b1631', me: '#3b2146', hov: '#221c3c' }, light: { bg: '#fbf7fc', panel: '#f2eaf5', me: '#fde1f0', hov: '#efe3f2' } };
  // готовые схемы: тёмные и светлые (токены — те же, что у темы)
  const SCHEMES = {
    legion: { name: 'Легион', mode: 'dark', v: null },   // как чат игры
    coal: { name: 'Уголь', mode: 'dark', v: { bg: '#17130e', panel: '#211b14', line: '#3a3024', tx: '#eadfcb', mut: '#9c8d76', me: '#3a2d14', hov: '#2b241b', acc: '#f0b84a', 'acc-tx': '#f0b84a', 'on-acc': '#1a1206' } },
    night: { name: 'Ночь', mode: 'dark', v: { bg: '#0f1420', panel: '#171e2e', line: '#2a3550', tx: '#dde5f5', mut: '#8d9ab5', me: '#22305a', hov: '#1d2640' } },
    forest: { name: 'Лес', mode: 'dark', v: { bg: '#101712', panel: '#17211a', line: '#2a3a2e', tx: '#dcead9', mut: '#8fa592', me: '#21402a', hov: '#1c2a20' } },
    oled: { name: 'Чёрный', mode: 'dark', v: { bg: '#000000', panel: '#0d0d0d', line: '#262626', tx: '#ececec', mut: '#9a9a9a', me: '#2a2416', hov: '#161616' } },
    wine: { name: 'Вино', mode: 'dark', v: { bg: '#1a1013', panel: '#24161b', line: '#3d252e', tx: '#f0dde3', mut: '#a88c96', me: '#45202d', hov: '#2c1a20' } },
    legionl: { name: 'Легион', mode: 'light', v: null },
    parchment: { name: 'Пергамент', mode: 'light', v: { bg: '#fbf7ef', panel: '#f1e9da', line: '#dccfb6', tx: '#2b2117', mut: '#6f5f48', me: '#fbe7bd', hov: '#e9dec9', acc: '#e0a42e', 'acc-tx': '#9a6206', 'on-acc': '#1a1206' } },
    snow: { name: 'Снег', mode: 'light', v: { bg: '#f6f8fb', panel: '#e9eef5', line: '#cfd8e5', tx: '#1b2430', mut: '#5a6878', me: '#dbe8ff', hov: '#e1e8f2' } },
    mint: { name: 'Мята', mode: 'light', v: { bg: '#f3faf6', panel: '#e3f1e9', line: '#c5dfd0', tx: '#17291f', mut: '#4f6b5c', me: '#cdeedb', hov: '#dbece2' } },
    rose: { name: 'Роза', mode: 'light', v: { bg: '#fdf5f7', panel: '#f6e6eb', line: '#e7c9d3', tx: '#2e1a21', mut: '#76586a', me: '#fbd9e3', hov: '#f1dde4' } },
  };
  const ACCENTS = ['#f0b84a', '#e8743b', '#e05561', '#d45ad0', '#8b6cf0', '#4f8df0', '#2fb8c9', '#3fbf6f', '#a3c43a'];
  const FONTS = {
    game: ['Как в игре', 'Nunito,"Segoe UI",system-ui,sans-serif'],
    system: ['Обычный', 'system-ui,-apple-system,"Segoe UI",sans-serif'],
    rounded: ['Округлый', '"Segoe UI Variable Text","Nunito","Varela Round","Trebuchet MS",system-ui,sans-serif'],
    serif: ['С засечками', 'Georgia,"Times New Roman",serif'],
    mono: ['Моноширинный', 'Consolas,"Cascadia Mono","DejaVu Sans Mono",monospace'],
    comic: ['Рукописный', '"Comic Sans MS","Comic Neue","Segoe Print",cursive'],
  };
  const CZ0 = lsGet(CZ_KEY, null);
  let CZ = Object.assign({}, CZ_DEF, CZ0 || {});
  // 3.11: новый облик «как в игре» — тем, у кого стояли прежние схемы по умолчанию, переключаем один раз
  if (CZ0 && !CZ0.d2) { if (CZ.dark === 'coal') CZ.dark = 'legion'; if (CZ.light === 'parchment') CZ.light = 'legionl'; if (CZ.font === 'system') CZ.font = 'game'; CZ.d2 = 1; lsSet(CZ_KEY, CZ); }
  const czWords = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 2).slice(0, 50);
  let CZ_HL = czWords(CZ.hl), CZ_HIDE = czWords(CZ.hide);
  const czHas = (text, words) => { if (!words.length) return false; const t = String(text || '').toLowerCase(); return words.some((w) => t.includes(w)); };
  const czHidden = (m) => !!CZ_HIDE.length && String(m.l || '').toLowerCase() !== S.me && czHas(m.t, CZ_HIDE);
  const isMention = (text, l) => !!S.me && l !== S.me && (new RegExp(`(^|\\s)@${S.me}(\\b|$)`, 'i').test(text) || czHas(text, CZ_HL));

  const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

  function czCss() {
    const vars = (v) => Object.entries(v).map(([k, x]) => `--${k}:${x}`).join(';');
    const d = SCHEMES[CZ.dark] && SCHEMES[CZ.dark].v, li = SCHEMES[CZ.light] && SCHEMES[CZ.light].v;
    const LIGHT = ':root[data-theme="light"]', LIGHT_AUTO = '@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){%}}';
    let css = '';
    if (d) css += `:root{${vars(d)};--pns:${d.panel}}`;
    if (li) css += `${LIGHT}{${vars(li)};--pns:${li.panel}}` + LIGHT_AUTO.replace('%', `${vars(li)};--pns:${li.panel}`);
    const rgb = hex2rgb(CZ.accent);
    if (rgb) {   // свой акцент: текстом — темнее на светлом фоне; надпись на акценте — чёрная или белая по контрасту
      const on = lum(rgb) > 0.36 ? '#1a1206' : '#ffffff';
      css += `:root{--acc:${CZ.accent};--acc-tx:${CZ.accent};--on-acc:${on}}`;
      const dark = `color-mix(in srgb, ${CZ.accent} 62%, #000)`;
      css += `${LIGHT}{--acc:${CZ.accent};--acc-tx:${dark};--on-acc:${on}}` + LIGHT_AUTO.replace('%', `--acc:${CZ.accent};--acc-tx:${dark};--on-acc:${on}`);
    }
    css += `:root{--ff:${(FONTS[CZ.font] || FONTS.game)[1]}}`;
    css += `html:not(.pinned) :is(#log,#pvlog){font-size:${Math.max(11, Math.min(22, +CZ.size || 14))}px}`;
    if (CZ.density === 'compact') css += `:is(#log,#pvlog) li{padding-top:1px;padding-bottom:1px}:is(#log,#pvlog) li+li{margin-top:0}`;
    if (CZ.density === 'airy') css += `:is(#log,#pvlog) li{padding-top:6px;padding-bottom:6px}:is(#log,#pvlog) li+li{margin-top:3px}`;
    if (!CZ.time) css += `:is(#log,#pvlog) .t{display:none}`;
    if (!CZ.icons) css += `:is(#log,#pvlog) li>span[title]:not(.aw):not(.n):not(.to):not(.src):not(.frm){display:none}`;
    // полоса прокрутки: по умолчанию спрятана везде в окне чата (колесо, тач и клавиши листают как раньше)
    if (!CZ.scrollbar) css += `*{scrollbar-width:none}*::-webkit-scrollbar{display:none;width:0;height:0}`;
    // включена — своя: тонкая, скруглённая, в цвет акцента; пока мышь не над областью — еле видна (Chrome/Edge/Opera — ::-webkit-scrollbar, Firefox — scrollbar-color)
    else css += `@supports selector(::-webkit-scrollbar){*::-webkit-scrollbar{width:10px;height:10px;background:transparent}*::-webkit-scrollbar-track,*::-webkit-scrollbar-corner{background:transparent}`
      + `*::-webkit-scrollbar-thumb{background-color:color-mix(in srgb,var(--acc) 62%,transparent);background-clip:padding-box;border:3px solid transparent;border-radius:99px;min-height:36px}`
      + `*:not(:hover)::-webkit-scrollbar-thumb{background-color:color-mix(in srgb,var(--acc) 24%,transparent)}`
      + `*::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--acc) 85%,transparent);border-width:2px}*::-webkit-scrollbar-thumb:active{background-color:var(--acc)}*::-webkit-scrollbar-button{display:none;height:0;width:0}}`
      + `@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--acc) 50%,transparent) transparent}}`;
    if (!CZ.awards) css += `:is(#log,#pvlog) .aw{display:none}`;
    if (!CZ.nickColor) css += `:is(#log,#pvlog) .n{color:var(--tx)!important}`;
    css += `html:not(.pinned) :is(#log,#pvlog) img.em{height:${Math.max(18, Math.min(56, +CZ.emoteSize || 28))}px}`;
    // выделение друзей и модераторов: полоса слева и лёгкий фон (модератор важнее друга, упоминание — важнее всех)
    const mark = (cls, c) => `:is(#log,#pvlog) li.${cls}:not(.mention){background:color-mix(in srgb, ${c} 14%, transparent);box-shadow:inset 3px 0 0 ${c}}:is(#log,#pvlog) li.${cls}:not(.mention):hover{background:color-mix(in srgb, ${c} 22%, transparent)}`;
    if (CZ.hlFriend && hex2rgb(CZ.friendColor)) css += mark('fr', CZ.friendColor);
    if (CZ.hlMod && hex2rgb(CZ.modColor)) css += mark('role', CZ.modColor);
    // прозрачный фон — только в панели внутри игры (обычное окно браузера сквозь себя не показывает): игра видна сквозь чат,
    // текст остаётся чётким и получает тень; всплывающие панели (настройки, стикеры, пасты, меню) — непрозрачные
    const clr = EMBED ? Math.max(0, Math.min(90, +CZ.bgClear || 0)) : 0;
    if (clr) {
      const al = (v, a) => { const r = hex2rgb(v); return r ? `rgba(${r[0]},${r[1]},${r[2]},${a.toFixed(2)})` : v; };
      const a = 1 - clr / 100;
      const set = (v, sh) => `--bg:${al(v.bg, a)};--panel:${al(v.panel, Math.min(1, a + 0.1))};--hov:${al(v.hov, Math.min(1, a + 0.15))};--me:${al(v.me, Math.min(1, a + 0.25))};--bgs:${v.bg};--pns:${v.panel};--tsh:${sh}`;
      const dv = Object.assign({}, BASE_V.dark, d || {}), lv = Object.assign({}, BASE_V.light, li || {});
      const dsh = '0 1px 2px rgba(0,0,0,.9),0 0 5px rgba(0,0,0,.55)', lsh = '0 0 2px rgba(255,255,255,.95),0 0 6px rgba(255,255,255,.7)';
      css += `:root{${set(dv, dsh)}}${LIGHT}{${set(lv, lsh)}}` + LIGHT_AUTO.replace('%', set(lv, lsh));
      css += `html{background:transparent!important}#sp,#pp,#ep{background:var(--bgs)!important}.mm{background:var(--pns)!important}`;
      if (clr >= 30) css += `#log,#dmbar,.hr{text-shadow:var(--tsh)}`;
    }
    const bg = CZ.bgOn !== false ? lsGet(CZ_BG, null) : null;
    if (bg) css += `#log{background:linear-gradient(color-mix(in srgb, var(--bg) ${Math.max(0, Math.min(95, +CZ.bgDim || 0))}%, transparent),color-mix(in srgb, var(--bg) ${Math.max(0, Math.min(95, +CZ.bgDim || 0))}%, transparent)),url("${bg}") center/cover no-repeat}`;
    return css + '\n/* свой CSS */\n' + String(CZ.css || '');
  }
  function czApply() {
    CZ_HL = czWords(CZ.hl); CZ_HIDE = czWords(CZ.hide);
    if (typeof gdTabVis === 'function') try { gdTabVis(); } catch {}
    try { railApply(); } catch {}
    const css = czCss();
    for (const d of docs()) {
      // шрифты игры (Nunito, Comfortaa) — с того же Google Fonts, откуда их берёт сама игра
      if (!d.getElementById('lgmc-gf')) { const lk = d.createElement('link'); lk.id = 'lgmc-gf'; lk.rel = 'stylesheet'; lk.href = 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&family=Comfortaa:wght@700&display=swap'; d.head.appendChild(lk); }
      let st = d.getElementById('lgmc-cz');
      if (!st) { st = d.createElement('style'); st.id = 'lgmc-cz'; d.head.appendChild(st); }
      st.textContent = css;
    }
  }
  function czSet(patch, rerender) {
    Object.assign(CZ, patch);
    lsSet(CZ_KEY, CZ);
    czApply();
    if (rerender) { if (S.room === 'pm') pmRender(); else { const keep = S.stick; renderLog(); if (keep) toBottom(); } }
    czPreview();
  }

  // ---- звук: короткий сигнал без файлов ----
  let AC = null;
  // Чат может быть открыт сразу в нескольких местах (панель в игре, отдельное окно, другая вкладка игры) —
  // каждое сообщение звучит один раз: кто первым отметил его в общем localStorage, тот и играет звук.
  function czBeepOnce(kind, id) {
    if (!CZ.sound) return;
    setTimeout(() => {   // небольшой разброс: окна, получившие сообщение в одну и ту же миллисекунду, не сыграют вдвоём
      try {
        const k = 'lgmc_beep', now = Date.now(), done = (JSON.parse(localStorage.getItem(k) || '[]') || []).filter((x) => now - x[1] < 15000);
        if (done.some((x) => x[0] === id)) return;
        done.push([id, now]); localStorage.setItem(k, JSON.stringify(done.slice(-30)));
      } catch {}
      czBeep(kind);
    }, Math.floor(Math.random() * 180));
  }
  function czBeep(kind) {
    if (!CZ.sound) return;
    try {
      AC = AC || new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') AC.resume();
      const t = AC.currentTime, g = AC.createGain(), o = AC.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(kind === 'dm' ? 660 : 880, t); o.frequency.setValueAtTime(kind === 'dm' ? 990 : 1175, t + 0.09);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.001, (+CZ.volume || 50) / 250), t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.connect(g).connect(AC.destination); o.start(t); o.stop(t + 0.3);
    } catch {}
  }

  // ---- панель настроек ----
  function czInit() {
    S.el.czb = document.getElementById('czb'); S.el.sp = document.getElementById('sp');
    S.el.czb.onclick = () => czOpen(S.el.sp.hidden);
    window.addEventListener('storage', (e) => {   // настроили в другом окне (или в панели в игре) — применить здесь
      if (e.key === CZ_KEY || e.key === CZ_BG) { CZ = Object.assign({}, CZ_DEF, lsGet(CZ_KEY, {}) || {}); czApply(); if (S.room === 'pm') pmRender(); else renderLog(); if (!S.el.sp.hidden) czRender(); }
    });
    czApply();
    // панель в игре: браузер рисует под рамкой сплошной фон, если её color-scheme не совпадает со страницей чата —
    // тогда прозрачность не видна. Держим их одинаковыми при любой смене темы.
    if (EMBED) {
      const sync = () => { try { window.frameElement.style.colorScheme = getComputedStyle(document.documentElement).colorScheme.includes('light') ? 'light' : 'dark'; } catch {} };
      new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', sync); } catch {}
      sync();
    }
  }
  function czOpen(on) {
    S.el.sp.hidden = !on;
    S.el.czb.setAttribute('aria-pressed', String(on));
    if (on) { pickerOpen(false, true); pastesOpen(false, true); czRender(); const f = S.el.sp.querySelector('button, input, select'); if (f) f.focus(); }
    else S.el.czb.focus();
  }
  const SAMPLE = () => {
    const now = Date.now(), me = S.me || 'ты';
    return [
      { _src: 'preview', _key: 'pv:1', id: 'pv1', l: 'kotomag', n: 'KotoMag', r: 'mod', t: 'кто идёт в шахту? там жила серебра', at: now - 180000, c: 'mage', cn: 'Котомаг', aw: [{ i: '✦', n: 'Первопроходец' }] },
      { _src: 'preview', _key: 'pv:2', id: 'pv2', l: 'rudokop77', n: 'Rudokop77', t: `@${me} пойдём вместе ${[...EM.keys()][0] || 'catJAM'}`, at: now - 120000, c: 'legionary', cn: 'Котоармеец' },
      { _src: 'preview', _key: 'pv:3', id: 'pv3', l: 'lunnayamysh', n: 'LunnayaMysh', _fr: true, t: `продам медную кирку${CZ_HL[0] ? ' — ' + CZ_HL[0] : ''}`, at: now - 60000, c: 'priest', cn: 'Мурлыка-жрец' },
    ];
  };
  function czPreview() {
    const pv = S.el.sp && S.el.sp.querySelector('#pvlog'); if (!pv || S.el.sp.hidden) return;
    pv.innerHTML = ''; for (const m of SAMPLE()) pv.appendChild(row(m));
  }
  function czRender() {
    const sp = S.el.sp, bg = lsGet(CZ_BG, null);
    const opt = (o, v) => Object.entries(o).map(([k, x]) => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(Array.isArray(x) ? x[0] : x.name)}</option>`).join('');
    const sch = (mode) => Object.entries(SCHEMES).filter(([, x]) => x.mode === mode).map(([k, x]) => `<button type="button" class="sw${CZ[mode] === k ? ' on' : ''}" data-sch="${mode}:${k}" aria-pressed="${CZ[mode] === k}" title="${esc(x.name)}"><i style="background:${(x.v || (mode === 'dark' ? { bg: '#120e22' } : { bg: '#fbf7fc' })).bg};border-color:${(x.v || (mode === 'dark' ? { panel: '#ff9fd0' } : { panel: '#f06aae' })).panel}"></i>${esc(x.name)}</button>`).join('');
    const tg = (k, t) => `<label class="ck"><input type="checkbox" data-ck="${k}"${CZ[k] ? ' checked' : ''}> ${t}</label>`;
    sp.innerHTML = `<div class="sp-h"><b>⚙ Настройки чата</b><button type="button" class="hb" data-cz="close" aria-label="Закрыть настройки">✕</button></div>
      <div class="sp-b">
        <section><h4>Пример</h4><ol id="pvlog" aria-label="Пример сообщений"></ol></section>
        <section><h4>Расположение</h4>
          <label class="sel">Вкладки чатов <select data-sel="rail">${opt({ auto: ['Сбоку — у края экрана'], left: ['Сбоку слева'], right: ['Сбоку справа'], off: ['Сверху, как раньше'] }, CZ.rail || 'auto')}</select></label>
        </section>
        <section><h4>Цвета</h4>
          <div class="lbl">Тёмная тема</div><div class="sws">${sch('dark')}</div>
          <div class="lbl">Светлая тема</div><div class="sws">${sch('light')}</div>
          <div class="lbl">Акцент</div><div class="sws acc">${['', ...ACCENTS].map((c) => `<button type="button" class="dot${(CZ.accent || '') === c ? ' on' : ''}" data-acc="${c}" title="${c || 'Как в теме'}" aria-label="Акцент ${c || 'как в теме'}" style="background:${c || 'linear-gradient(135deg,#ff9fd0 50%,#f06aae 50%)'}"></button>`).join('')}<label class="dot pick" title="Свой цвет"><input type="color" data-cz="accent" value="${hex2rgb(CZ.accent) ? CZ.accent : '#f0b84a'}" aria-label="Свой цвет акцента">🎨</label></div>
          <div class="lbl">Фон ленты</div>
          <div class="row">${bg ? `<span class="bgp" style="background-image:url('${bg}')"></span>` : ''}<label class="pbtn alt fl">🖼 ${bg ? 'Другая картинка' : 'Своя картинка'}<input type="file" accept="image/*" data-cz="bgfile" hidden></label>${bg ? '<button type="button" class="pbtn alt" data-cz="bgdel">Убрать</button>' : ''}</div>
          ${bg ? `<label class="rng">Затемнение картинки <input type="range" min="0" max="95" step="5" data-rng="bgDim" value="${CZ.bgDim}"><output>${CZ.bgDim}%</output></label>` : ''}
        </section>
        <section><h4>Текст</h4>
          <label class="sel">Шрифт <select data-sel="font">${opt(FONTS, CZ.font)}</select></label>
          <label class="rng">Размер <input type="range" min="11" max="22" step="1" data-rng="size" value="${CZ.size}"><output>${CZ.size}px</output></label>
          <div class="lbl">Плотность</div><div class="seg2">${[['compact', 'Плотно'], ['normal', 'Обычно'], ['airy', 'Свободно']].map(([k, t]) => `<button type="button" data-den="${k}" aria-pressed="${CZ.density === k}">${t}</button>`).join('')}</div>
        </section>
        <section><h4>Сообщения</h4>
          ${tg('time', 'Время')}${tg('icons', 'Значки классов и ролей')}${tg('awards', 'Награды у ников')}${tg('nickColor', 'Цветные ники')}${tg('emotes', 'Стикеры картинками')}${tg('scrollbar', 'Полоса прокрутки')}${tg('hist', 'Помнить ленту между запусками (игра отдаёт только последние ~120)')}
          <label class="sel">Сколько сообщений держать в ленте <select data-sel="histMax">${[500, 1000, 2000, 3000].map((n) => `<option value="${n}"${histMax() === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>${tg('liveAlert', 'Сообщать, когда стример игры начинает эфир 🔴')}${tg('tips', 'Подсказки над полем ввода: «Скопировано», «В закладках»…')}${tg('guilds', 'Вкладка ⚜ Гильдия — закрытый чат для своих (сама появится, если позовут)')}${tg('extShow', 'Отмечать 🧩 тех, у кого тоже Чат Легиона')}${tg('extTell', 'Показывать другим, что у меня Чат Легиона (невидимая метка в сообщениях)')}
          ${CZ.emotes ? `<label class="rng">Размер стикеров <input type="range" min="18" max="56" step="2" data-rng="emoteSize" value="${CZ.emoteSize}"><output>${CZ.emoteSize}px</output></label>` : ''}
        </section>
        <section><h4>Подсветка и фильтр</h4>
          ${[['hlMod', 'modColor', 'Выделять модераторов и админа чата'], ['hlFriend', 'friendColor', 'Выделять друзей']].map(([k, c, t]) => `<div class="row hlr">${tg(k, t)}<label class="dot pick" title="Цвет выделения" style="background:${esc(CZ[c])}"><input type="color" data-col="${c}" value="${hex2rgb(CZ[c]) ? CZ[c] : '#4f8df0'}" aria-label="Цвет: ${t.toLowerCase()}"></label></div>`).join('')}
          <label class="ta">Подсвечивать сообщения со словами <small>через запятую; твой @ник подсвечивается всегда</small><textarea data-ta="hl" rows="2" maxlength="600" placeholder="например: продам, топаз, поход">${esc(CZ.hl)}</textarea></label>
          <label class="ta">Скрывать сообщения со словами <small>свои сообщения не скрываются</small><textarea data-ta="hide" rows="2" maxlength="600" placeholder="например: спам, реклама">${esc(CZ.hide)}</textarea></label>
        </section>
        <section><h4>Игнор <small>их сообщений не видно, лично тебе не пишут; добавить — правый клик по нику</small></h4>
          <div class="ign">${S.ign.size ? [...S.ign].sort().map((l) => `<div><span style="color:${ncol(l)}">${esc(dispName(l))}</span><button type="button" class="pbtn alt" data-unign="${esc(l)}">Снять</button></div>`).join('') : '<small style="color:var(--mut)">Никого нет в игноре.</small>'}</div>
        </section>
        <section><h4>Свои цвета и прозвища <small>видишь только ты; задать — правый клик по нику → 🎨</small></h4>
          <div class="ign">${Object.keys(NK).length ? Object.keys(NK).sort().map((l) => `<div><span style="color:${ncol(l)}">${esc(aliasOf(l) || dispName(l))}</span><small style="color:var(--mut)">${esc(l)}</small><button type="button" class="pbtn alt" data-nkreset="${esc(l)}">Как в игре</button></div>`).join('') : '<small style="color:var(--mut)">Пока никого.</small>'}</div>
        </section>
        <section><h4>Горячие клавиши</h4>
          <dl class="keys"><dt>Alt+1…5</dt><dd>Шахта, Город, Всё, Личные, Пинги</dd><dt>@ник + Tab</dt><dd>дописать ник (↑ ↓ — выбрать)</dd><dt>↑</dt><dd>в пустом поле — последнее твоё сообщение</dd><dt>Ctrl+F</dt><dd>поиск по сообщениям (Enter / Shift+Enter, F3)</dd><dt>Esc</dt><dd>закрыть: ответ, поиск, стикеры, пасты, меню</dd></dl>
        </section>
        <section><h4>Город</h4>
          <label class="ck"><input type="checkbox" data-cityauto${lsGet(CITY_AUTO_KEY, false) ? ' checked' : ''}> Входить в чат города сразу, не спрашивая <small>герой заходит на Ярмарку, его видят другие</small></label>
        </section>
        <section><h4>Прозрачность <small>${EMBED ? 'панели в игре — сквозь чат видно игру' : 'действует в панели внутри игры (отдельное окно браузера прозрачным не бывает)'}</small></h4>
          <label class="rng">Прозрачность фона <input type="range" min="0" max="90" step="5" data-rng="bgClear" value="${CZ.bgClear}"><output>${CZ.bgClear}%</output></label>
          <label class="rng">Прозрачность всего чата <input type="range" min="0" max="70" step="5" data-rng="opac" value="${CZ.opac}"><output>${CZ.opac}%</output></label>
          ${tg('opHover', 'Непрозрачный, когда мышь на чате')}
        </section>
        <section><h4>Звук</h4>
          ${tg('sound', 'Сигнал при упоминании и новом личном')}
          ${CZ.sound ? `<label class="rng">Громкость <input type="range" min="10" max="100" step="10" data-rng="volume" value="${CZ.volume}"><output>${CZ.volume}%</output></label><button type="button" class="pbtn alt" data-cz="test">▶ Послушать</button>` : ''}
        </section>
        <section><h4>Свой CSS <small>для тонкой настройки, применяется сразу</small></h4>
          <textarea data-ta="css" rows="4" maxlength="20000" spellcheck="false" placeholder="#log .n { text-decoration: underline }">${esc(CZ.css)}</textarea>
        </section>
        <section><h4>Перенос и сброс</h4>
          <div class="row"><button type="button" class="pbtn alt" data-cz="export">Экспорт</button><button type="button" class="pbtn alt" data-cz="import">Импорт</button><button type="button" class="pbtn alt danger" data-cz="reset">Сбросить всё</button></div>
          <textarea id="czio" rows="3" spellcheck="false" placeholder="Сюда — настройки для импорта (JSON)" hidden></textarea>
          <p class="note" id="czmsg" role="status"></p>
        </section>
      </div>`;
    const fill = (r) => r.style.setProperty('--p', ((r.value - r.min) / ((r.max - r.min) || 1) * 100) + '%');   // заливка ползунка
    sp.querySelectorAll('input[type="range"]').forEach(fill);
    sp.addEventListener('input', (e) => { if (e.target.type === 'range') fill(e.target); });
    czPreview();
    let taT = 0;
    const note = (t) => { const n = sp.querySelector('#czmsg'); if (n) n.textContent = t; };
    sp.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cz === 'close') return czOpen(false);
      if (b.dataset.sch) { const [mode, k] = b.dataset.sch.split(':'); czSet({ [mode]: k }); return czRender(); }
      if ('acc' in b.dataset) { czSet({ accent: b.dataset.acc }); return czRender(); }
      if (b.dataset.den) { czSet({ density: b.dataset.den }); return czRender(); }
      if (b.dataset.cz === 'bgdel') { try { localStorage.removeItem(CZ_BG); } catch {} czApply(); return czRender(); }
      if (b.dataset.unign) { ignSet(b.dataset.unign, false); return; }
      if (b.dataset.nkreset) { nkSave(b.dataset.nkreset, null); return; }
      if (b.dataset.cz === 'test') { const s0 = CZ.sound; CZ.sound = true; czBeep('mention'); setTimeout(() => czBeep('dm'), 450); CZ.sound = s0; return; }
      if (b.dataset.cz === 'export') {
        const io = sp.querySelector('#czio'); io.hidden = false;
        io.value = JSON.stringify(Object.assign({ v: 1 }, CZ), null, 1); io.select();
        try { await navigator.clipboard.writeText(io.value); note('Настройки скопированы (без картинки фона). Их можно вставить в другом браузере → «Импорт».'); } catch { note('Скопируй текст из поля (Ctrl+C).'); }
        return;
      }
      if (b.dataset.cz === 'import') {
        const io = sp.querySelector('#czio');
        if (io.hidden || !io.value.trim()) { io.hidden = false; io.value = ''; io.focus(); note('Вставь настройки в поле и нажми «Импорт» ещё раз.'); return; }
        let v = null; try { v = JSON.parse(io.value); } catch {}
        if (!v || typeof v !== 'object') { note('Не похоже на настройки чата — проверь текст.'); return; }
        const clean = {}; for (const k of Object.keys(CZ_DEF)) if (k in v && typeof v[k] === typeof CZ_DEF[k]) clean[k] = v[k];
        CZ = Object.assign({}, CZ_DEF, clean); czSet({}, true); czRender(); note('Настройки применены.');
        return;
      }
      if (b.dataset.cz === 'reset') {
        if (!b.classList.contains('sure')) { b.classList.add('sure'); b.textContent = 'Точно сбросить?'; return; }
        CZ = Object.assign({}, CZ_DEF); try { localStorage.removeItem(CZ_BG); } catch {} czSet({}, true); czRender(); note('Всё как было по умолчанию.');
      }
    };
    sp.oninput = (e) => {
      const t = e.target;
      if (t.dataset.rng) { t.nextElementSibling.textContent = t.value + (t.dataset.rng === 'size' || t.dataset.rng === 'emoteSize' ? 'px' : '%'); czSet({ [t.dataset.rng]: +t.value }); }
      if (t.dataset.cz === 'accent') czSet({ accent: t.value });
      if (t.dataset.col) { czSet({ [t.dataset.col]: t.value }); t.parentElement.style.background = t.value; }
      if (t.dataset.ta) { clearTimeout(taT); taT = setTimeout(() => czSet({ [t.dataset.ta]: t.value }, t.dataset.ta !== 'css'), 350); }
    };
    sp.onchange = async (e) => {
      const t = e.target;
      if ('cityauto' in t.dataset) { lsSet(CITY_AUTO_KEY, t.checked); updateBar(); if (t.checked && isMix(S.room) && !S.inCity && !S.cityChk) cityEnter(); }
      if (t.dataset.ck) { czSet({ [t.dataset.ck]: t.checked }, t.dataset.ck === 'emotes' || t.dataset.ck === 'extShow'); if (['emotes', 'sound'].includes(t.dataset.ck)) czRender(); if (t.dataset.ck === 'sound' && t.checked) czBeep('mention'); }
      if (t.dataset.sel) czSet({ [t.dataset.sel]: t.dataset.sel === 'histMax' ? +t.value : t.value });
      if (t.dataset.cz === 'accent') czRender();
      if (t.dataset.cz === 'bgfile' && t.files && t.files[0]) {
        const url = await czShrink(t.files[0]);
        if (!url) { note('Не получилось открыть картинку.'); return; }
        try { localStorage.setItem(CZ_BG, JSON.stringify(url)); } catch { note('Картинка слишком большая для браузера — выбери поменьше.'); return; }
        czApply(); czRender();
      }
    };
  }
  // картинку фона уменьшаем (до 1600 px по большей стороне, JPEG), чтобы влезла в память браузера
  function czShrink(file) {
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
          c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          try { res(c.toDataURL('image/jpeg', 0.82)); } catch { res(null); }
        };
        img.onerror = () => res(null); img.src = fr.result;
      };
      fr.onerror = () => res(null); fr.readAsDataURL(file);
    });
  }

  // ---------- Отправка ----------
  async function say() {
    let t = S.el.inp.value.trim(); if (!t || S.el.send.disabled) return;
    let path, body;
    const tg = target();
    if (tg === 'pm' || tg === 'dm') { await pmSay(t, tg); return; }
    if (tg === 'guild') { await gdSay(t); return; }
    const raw = t;
    if (S.reply && t[0] !== '/') t = replyWrap(t);
    if (t[0] === '/' && canMod(tg === 'mine' ? 'mine' : 'city')) { if (await modCommand(tg === 'mine' ? 'mine' : 'city', t)) S.el.inp.value = ''; return; }
    if (tg === 'mine') { path = `/api/mine/chat/say?c=${encodeURIComponent(S.mine)}`; body = { text: t }; }
    else if (S.cityFeed) { path = '/api/chat/say'; body = { text: t, room: 'city' }; if (tg === 'tr') body.k = 'tr'; }   // откуда угодно — герой не идёт в город
    else {
      path = '/api/city/say'; body = { text: t };
      if (tg === 'tr') body.k = 'tr';
    }
    if (body && body.text && t[0] !== '/') { body.text = markOut(body.text); if (CZ.extTell !== false) extAdd(S.me); }
    S.el.send.disabled = true;
    try {
      let r = await api(path, body);
      // шахта: если герой сейчас не в шахте (на привале, в городе), пишем через единый чат игры — ему можно откуда угодно
      if (tg === 'mine' && !(r && r.ok) && S.cityFeed !== false) { const r2 = await api('/api/chat/say', { text: body.text, room: 'mine' }); if (r2 && (r2.ok || !/not_found|HTTP 404/.test(r2.error || ''))) r = r2; }
      if (r && r.ok) { S.el.inp.value = ''; S.el.err.textContent = ''; S.lastSent = raw; replyCancel(); acHide(); poll(); }
      else {
        const e = (r && r.error) || 'не отправилось';
        S.el.err.textContent = (ERR[e] || e) + (tg === 'mine' && /шахт/i.test(e) ? ' — чтобы писать, твой герой должен быть в шахте (открой её в игре).' : '');
        if (tg !== 'mine' && !S.cityFeed && /не в городе/.test(e)) { S.inCity = false; cityEnter(); }
      }
    } catch { S.el.err.textContent = 'Нет связи — сообщение не ушло'; }
    finally { inputState(); if (!S.el.inp.disabled) S.el.inp.focus(); }
  }


  // ====================== ⚜ Гильдии: закрытый чат для своих ======================
  // Идея — из доработки другого игрока (01.11), переписано с подписями.
  // • Сообщения шифруются ключом гильдии (AES-GCM 256) и ходят через ntfy.sh — бесплатный «почтовый ящик»;
  //   адрес выводится из ключа, так что без ключа его не узнать. Сервер видит только шифр.
  // • У каждого игрока своя пара ключей ECDSA P-256 (в этом браузере). Открытый ключ он передаёт главе
  //   ЛИЧНЫМ сообщением игры — отправителя личных проверяет сервер игры, значит, подделать нельзя.
  //   Глава подписывает состав, каждый — свои сообщения: выдать себя за другого нельзя, чужой с кодом писать не может.
  // • Приглашение (LGG2:…) глава шлёт в личные; в нём ключ гильдии и открытый ключ главы.
  // • Исключение и «сменить ключ» — новый ключ и новый адрес, оставшимся новое приглашение уходит в личные само.
  // • Сервер держит сообщения ~12 часов; пропущенное дольше подтянется от участников, кто в сети (догон).
  // • На браузер — одно подключение (Web Locks), остальные окна получают сообщения через BroadcastChannel.
  // Честно: ключ гильдии проходит через личные игры, то есть его технически может увидеть сервер игры.
  const NTFY = 'https://ntfy.sh', GD_MAX = 900;
  const GD_EMO = ['👍', '❤️', '😂', '🔥', '😮', '😢'];
  const GD_HASH = (/[#&]lgg=([^&]+)/.exec(location.hash) || [])[1] || '';   // открыли ссылку-приглашение
  const GD = { list: [], cur: '', view: '', un: new Map(), es: new Map(), keys: new Map(), sure: '', busy: false, note: '', id: null, lead: false, bc: null, inv: [], old: [], seenSync: new Set() };
  const gdLK = () => 'lgmc_g2_' + (S.me || '_');
  const gdHK = (g) => 'lgmc_g2h_' + g.id;
  const B64 = {
    enc: (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec: (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
  };
  const gdRnd = (n) => B64.enc(crypto.getRandomValues(new Uint8Array(n)));
  const gdOn = () => !!(window.crypto && crypto.subtle);
  // перечитать из общего хранилища, НЕ подменяя объекты: на них держатся ссылки в ожидающих действиях
  function gdLoad() {
    const v = lsGet(gdLK(), []), arr = Array.isArray(v) ? v.filter((g) => g && g.id) : [];
    GD.list = arr.map((x) => { const o = GD.list.find((y) => y.id === x.id); if (!o) return x; for (const k of Object.keys(o)) if (!(k in x)) delete o[k]; return Object.assign(o, x); });
    return GD.list;
  }
  function gdSave() { lsSet(gdLK(), GD.list); }
  const gdGet = (id) => GD.list.find((g) => g.id === id) || null;
  const gdCur = () => gdGet(GD.cur) || GD.list.find((g) => !g.gone) || GD.list[0] || null;
  const gdName = (g) => (g && g.name) || 'Гильдия';
  const gdMem = (g) => Object.keys((g.roster && g.roster.m) || {});
  const gdIsMem = (g, l) => !!(g.roster && g.roster.m && g.roster.m[l]);
  const gdOwn = (g) => !!g && g.owner === S.me;
  // роли: подпись и право звать — назначает только глава, лежат в подписанном составе
  const gdRole = (g, l) => (g && g.roster && g.roster.r && g.roster.r[l]) || null;
  const gdCanInv = (g) => !!g && !g.gone && (gdOwn(g) || (!g.wait && !!(gdRole(g, S.me) || {}).z));
  const GD_ROLES = ['Заместитель', 'Казначей', 'Ветеран', 'Рекрутёр', 'Новичок'];
  const gdRoleTag = (g, l) => { const r = l === g.owner ? { t: 'глава' } : gdRole(g, l); return r && r.t ? `<small class="grl">${l === g.owner ? '👑 ' : ''}${esc(r.t)}</small>` : ''; };
  // «сделать один раз на весь браузер» — окон с чатом может быть несколько
  function gdOnce(id, ttl = 60000) {
    try {
      const k = 'lgmc_g2once', now = Date.now(), done = (JSON.parse(localStorage.getItem(k) || '[]') || []).filter((x) => now - x[1] < ttl);
      if (done.some((x) => x[0] === id)) return false;
      done.push([id, now]); localStorage.setItem(k, JSON.stringify(done.slice(-60))); return true;
    } catch { return true; }
  }

  // ---- ключи ----
  async function gdIdent() {   // своя пара ECDSA: создаётся один раз на браузер и игрока
    if (GD.id && GD.id.me === S.me) return GD.id;
    const k = 'lgmc_g2id_' + S.me; let v = lsGet(k, null);
    if (!v || !v.pub || !v.jwk) {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      v = { pub: B64.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      lsSet(k, v);
    }
    GD.id = { me: S.me, pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
    return GD.id;
  }
  const PUBC = new Map();
  async function gdPubKey(b64) { if (!PUBC.has(b64)) PUBC.set(b64, await crypto.subtle.importKey('raw', B64.dec(b64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])); return PUBC.get(b64); }
  async function gdAes(g) {
    const k = g.id + ':' + g.ep;
    if (!GD.keys.has(k)) {
      const raw = B64.dec(g.key), h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
      GD.keys.set(k, { k: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']), topic: 'lgg2_' + B64.enc(h.slice(0, 15)) });
    }
    return GD.keys.get(k);
  }
  async function gdSign(obj) {
    const id = await gdIdent(), p = JSON.stringify(obj);
    const s = B64.enc(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.priv, new TextEncoder().encode(p))));
    return { p, s };
  }
  async function gdVerify(pub, env) {
    try { return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await gdPubKey(pub), B64.dec(env.s), new TextEncoder().encode(env.p)); } catch { return false; }
  }
  async function gdSeal(g, env) {
    const { k } = await gdAes(g), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(env))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return 'g2.' + B64.enc(out);
  }
  async function gdOpen(g, s) {
    try {
      if (!/^g2\./.test(s || '')) return null;
      const raw = B64.dec(s.slice(3)), { k } = await gdAes(g);
      const env = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, k, raw.slice(12))));
      return env && typeof env.p === 'string' && typeof env.s === 'string' ? env : null;
    } catch { return null; }
  }
  // проверить подписанную запись: состав и переезд — подпись главы, остальное — подпись участника из состава
  async function gdCheck(g, env) {
    let d; try { d = JSON.parse(env.p); } catch { return null; }
    if (!d || d.g !== g.id || typeof d.k !== 'string') return null;
    const f = nickOf(d.f); if (!f) return null;
    const byOwner = d.k === 'roster' || d.k === 'moved';
    const pub = byOwner ? (f === g.owner ? g.opk : null) : g.roster && g.roster.m && g.roster.m[f];
    if (!pub || !(await gdVerify(pub, env))) return null;
    d.f = f; return d;
  }

  // ---- приглашения и ключи в личных игры ----
  // LGG2:<гильдия>.<поколение>.<ключ гильдии>.<открытый ключ главы> — от главы; LGK2:<гильдия>.<мой открытый ключ> — главе
  // ссылка-приглашение: тот же код + «.<метка ссылки>~<ник главы>» — глава примет ключ по метке, а не только у тех, кого позвал сам
  const GD_INV = /LGG2:([A-Za-z0-9_-]{8})\.(\d{1,5})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{87})(?:\.([A-Za-z0-9_-]{8})~([a-z0-9_]{1,25}))?/i;
  const GD_KEYM = /LGK2:([A-Za-z0-9_-]{8})\.([A-Za-z0-9_-]{87})(?:\.([A-Za-z0-9_-]{8}))?/;
  const GD_LINK_TTL = 7 * 864e5;
  const gdLinkCode = (g, x) => `LGG2:${g.id}.${g.ep}.${g.key}.${g.opk}.${x.t}~${g.owner}`;
  const gdLinkUrl = (g, x) => `${ORIGIN}/site/ver?minechat=${encodeURIComponent(g.ch || S.ch)}&room=guild#lgg=${gdLinkCode(g, x)}`;
  const gdLinkOk = (g, x) => x && Date.now() - x.at < GD_LINK_TTL && (!x.n || (x.used || []).length < x.n);
  // разобрать ссылку или код, вставленные вручную или открытые по ссылке
  function gdParseInv(text, ch) {
    const x = GD_INV.exec(String(text || '')); if (!x || !x[5]) return null;
    const from = nickOf(x[6]); if (!from) return null;
    return { id: x[1], ep: +x[2], key: x[3], opk: x[4], tok: x[5], from, ch: ch || S.ch, at: Date.now(), name: '', link: 1 };
  }
  const GD_OLD = /LGG1:[A-Za-z0-9_-]{8}\.\d{1,4}\.[A-Za-z0-9_-]{43}/;
  const gdInvText = (g) => `⚜ Зову в гильдию «${gdName(g).slice(0, 30)}» — закрытый чат в «Чате Легиона» (github.com/frebertor-sudo/legion-chat-window): LGG2:${g.id}.${g.ep}.${g.key}.${g.opk}`;
  async function gdDm(ch, to, text) {
    try {
      const r = await pfetch(`/c/${ch}/api/dm/say`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, text }) });
      const j = await r.json().catch(() => null); return j || { ok: false, error: `HTTP ${r.status}` };
    } catch { return { ok: false, error: 'нет связи' }; }
  }
  async function gdDmRead(ch, l) {
    try { const r = await pfetch(`/c/${ch}/api/dm?with=${encodeURIComponent(l)}`, { credentials: 'same-origin' }); const j = await r.json().catch(() => null); return j && j.ok ? (j.list || []) : []; } catch { return []; }
  }
  // пришли личные (живьём или подгрузкой) — проверить, нет ли там приглашения или ключа
  function gdScanDm(ch, list) {
    if (!S.me || !gdOn()) return;
    let found = false;
    for (const m of list || []) {
      const from = nickOf(m.fl), t = String(m.t || ''); if (!from || from === S.me) continue;
      let x = GD_INV.exec(t);
      if (x) { found = true; const own = x[6] ? nickOf(x[6]) : from; gdSeeInvite({ id: x[1], ep: +x[2], key: x[3], opk: x[4], tok: x[5] || '', from: own || from, via: own && own !== from ? from : '', ch, at: m.at || 0, name: ((/«([^»]{1,40})»/.exec(t) || [])[1] || '') }); continue; }
      x = GD_KEYM.exec(t);
      if (x) { found = true; gdSeeKey({ id: x[1], pub: x[2], tok: x[3] || '', from, ch }); continue; }
      if (GD_OLD.test(t) && !GD.old.some((o) => o.from === from)) { GD.old.push({ from, at: m.at || 0 }); found = true; }
    }
    if (found) { gdTabVis(); gdBadge(); if (S.room === 'guild') gdSoft(); }
  }
  function gdSeeInvite(p) {
    gdLoad();
    const g = gdGet(p.id);
    if (g) {
      // глава сменил ключ: новое поколение от того же главы с тем же ключом главы — переходим сами
      if (!g.gone || g.gone === 'moved') if (p.ep > g.ep && p.from === g.owner && !p.via && !p.tok && p.opk === g.opk && gdOnce('mv|' + g.id + '|' + p.ep, 864e5)) gdRekeyTo(g, p);
      return;
    }
    const i = GD.inv.findIndex((x) => x.id === p.id);
    if (i < 0) GD.inv.push(p); else if (GD.inv[i].ep < p.ep) GD.inv[i] = p;
  }
  async function gdSeeKey(p) {
    gdLoad();
    const g = gdGet(p.id);
    if (!gdOwn(g) || g.gone) return;
    const was = g.roster.m[p.from];
    if (was === p.pub) { if ((g.invited || []).some((x) => x.l === p.from)) { g.invited = g.invited.filter((x) => x.l !== p.from); gdSave(); } return; }
    // принять ключ только у приглашённого (или у участника, который сменил браузер — он тоже приходит по приглашению)
    const link = p.tok ? (g.links || []).find((x) => x.t === p.tok) : null;
    const byLink = link && (gdLinkOk(g, link) || (link.used || []).includes(p.from));
    if (!(g.invited || []).some((x) => x.l === p.from) && !byLink) return;
    if (!gdOnce('key|' + g.id + '|' + p.from + '|' + p.pub, 864e5)) return;
    if (byLink && !(link.used || []).includes(p.from)) link.used = [...(link.used || []), p.from];
    if (byLink) g.mch = Object.assign({}, g.mch, { [p.from]: p.ch });
    g.roster.m[p.from] = p.pub; g.mch = Object.assign({}, g.mch, { [p.from]: p.ch }); g.invited = (g.invited || []).filter((x) => x.l !== p.from); gdSave();
    await gdRoster(g);
    gdSys(g, `${pmName(p.from)} в гильдии${byLink ? ' (по ссылке)' : ''}`);
    if (S.room === 'guild') gdSoft();
  }
  // проверить личные с теми, от кого ждём ответа (вдруг пришло, пока чат был закрыт)
  async function gdPollDm() {
    if (!S.me) return;
    gdLoad();
    for (const g of GD.list) {
      if (g.gone && g.gone !== 'moved') continue;
      if (gdOwn(g)) for (const x of g.invited || []) gdScanDm(x.ch, await gdDmRead(x.ch, x.l));
      else if (g.owner && (g.wait || g.gone === 'moved')) gdScanDm(g.ch, await gdDmRead(g.ch, g.owner));
    }
  }

  // ---- сеть: ntfy.sh ----
  async function gdPost(g, d) {
    try {
      const env = await gdSign(Object.assign({ g: g.id, f: S.me, ts: Date.now() }, d));
      const { topic } = await gdAes(g);
      // без Content-Type — «простой» запрос, без предварительного OPTIONS
      const r = await pfetch(NTFY + '/', { method: 'POST', credentials: 'omit', body: JSON.stringify({ topic, message: await gdSeal(g, env) }) });
      return r.ok ? env : r.status === 429 ? 'limit' : null;
    } catch { return null; }
  }
  // одно подключение на браузер: кто держит замок — слушает ntfy и пересылает остальным окнам
  function gdLead() {
    try { GD.bc = new BroadcastChannel('lgmc-g2'); GD.bc.onmessage = (e) => { const d = e.data || {}; if (d.me === S.me && d.t === 'n') gdIncoming(d.gid, d.ep, d.msg); if (d.t === 'sub') gdSubAll(); }; } catch {}
    const go = () => { GD.lead = true; gdSubAll(); return new Promise(() => {}); };
    try { if (navigator.locks && navigator.locks.request) { navigator.locks.request('lgmc-g2-lead', go); return; } } catch {}
    go();
  }
  function gdSubAll() {
    if (!GD.lead || !S.me) return;
    gdLoad();
    const want = new Set();
    Promise.all(GD.list.filter((g) => !g.gone).map(async (g) => { const { topic } = await gdAes(g); want.add(topic); gdSub(g, topic); })).then(() => {
      for (const [t, x] of GD.es) if (!want.has(t)) { try { x.es.close(); } catch {} GD.es.delete(t); }
    });
  }
  function gdSub(g, topic) {
    if (GD.es.has(topic)) return;
    const sk = 'lgmc_g2s_' + topic, since = lsGet(sk, '') || '12h';
    let es; try { es = new PES(`${NTFY}/${topic}/sse?since=${encodeURIComponent(since)}`); } catch { return; }
    const x = { es, gid: g.id, ep: g.ep, ok: false }; GD.es.set(topic, x);
    es.addEventListener('open', () => { x.ok = true; gdDot(); if (!x.asked) { x.asked = true; gdAskSync(g); } });
    es.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.event && m.event !== 'message') return;
      if (m.id) lsSet(sk, m.id);
      const msg = { id: m.id, time: m.time, message: m.message };
      gdIncoming(g.id, g.ep, msg);
      try { if (GD.bc) GD.bc.postMessage({ t: 'n', me: S.me, gid: g.id, ep: g.ep, msg }); } catch {}
    });
    es.onerror = () => { x.ok = false; gdDot(); };
  }
  function gdDot() { if (S.room !== 'guild' || !S.el) return; const n = [...GD.es.values()]; S.el.dot.className = !GD.lead ? 'ok' : n.some((x) => x.ok) ? 'ok' : n.length ? 'bad' : ''; S.el.dot.title = S.el.dot.className === 'bad' ? 'Нет связи с ntfy.sh — переподключаюсь' : 'Гильдия на связи'; }

  // ---- история (общая для всех окон этого браузера) ----
  function gdHist(g) { const h = lsGet(gdHK(g), []); return Array.isArray(h) ? h : []; }
  function gdKeep(g, items) {   // items: {id, f, n, t, at, sys?, env?}
    const h = gdHist(g), ids = new Set(h.map((x) => x.id)); let n = 0;
    for (const x of items) { if (!x.id || ids.has(x.id)) continue; ids.add(x.id); h.push(x); n++; }
    if (!n) return 0;
    h.sort((a, b) => a.at - b.at); if (h.length > GD_MAX) h.splice(0, h.length - GD_MAX);
    lsSet(gdHK(g), h); return n;
  }
  const gdSys = (g, t, id) => gdKeep(g, [{ id: id || 'sys:' + gdRnd(5), sys: 1, t, at: Date.now() }]);

  // ---- пришла запись ----
  async function gdIncoming(gid, ep, msg) {
    gdLoad();
    const g = gdGet(gid); if (!g || g.ep !== ep) return;
    const env = await gdOpen(g, msg.message); if (!env) return;
    await gdApply(g, env, (msg.time || 0) * 1000 || Date.now(), true);
  }
  async function gdApply(g, env, at, live) {
    const d = await gdCheck(g, env); if (!d) return;
    let changed = false;
    if (d.k === 'msg' && d.t) {
      const ts = Math.min(+d.ts || at, Date.now() + 60000);
      const re = d.re && typeof d.re === 'object' && nickOf(d.re.f) ? { id: String(d.re.id || '').slice(0, 12), f: nickOf(d.re.f), s: String(d.re.s || '').slice(0, 80) } : null;
      const po = d.poll && Array.isArray(d.poll.o) ? d.poll.o.slice(0, 6).map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean) : [];
      const n = gdKeep(g, [Object.assign({ id: String(d.id || ''), f: d.f, t: String(d.t).slice(0, 500), at: ts, env }, re ? { re } : {}, po.length >= 2 ? { poll: Object.assign({ o: po }, d.poll.multi ? { multi: 1 } : {}) } : {})]);
      changed = !!n;
      if (n && live && d.f !== S.me) {
        const viewing = S.room === 'guild' && GD.cur === g.id && GD.view === 'chat' && !hidden();
        if (!viewing) {
          GD.un.set(g.id, (GD.un.get(g.id) || 0) + 1); gdBadge();
          pmToast(d.f, `⚜ ${gdName(g)} · ${dispName(d.f)}${d.re && nickOf(d.re.f) === S.me ? ' ответил тебе' : ''}: ${po.length >= 2 ? '📊 ' : ''}${String(d.t).slice(0, 70)}`, 'Гильдия', 'guild:' + g.id);
          czBeepOnce('dm', 'g2|' + d.id);
        }
      }
    } else if (['vote', 'react', 'edit', 'del'].includes(d.k) && /^[A-Za-z0-9_-]{6,12}$/.test(String(d.p || ''))) {
      const x = { id: String(d.id || '').slice(0, 12) || gdRnd(6), k: d.k, f: d.f, p: String(d.p), at: Math.min(+d.ts || at, Date.now() + 60000), env };
      if (d.k === 'vote') { x.o = Number.isInteger(d.o) ? d.o : -1; if ('on' in d) x.on = !!d.on; }
      if (d.k === 'react') { if (!GD_EMO.includes(d.e)) return; x.e = d.e; x.on = !!d.on; }
      if (d.k === 'edit') { if (!d.t) return; x.t = String(d.t).slice(0, 500); }
      changed = !!gdKeep(g, [x]);
    } else if (d.k === 'roster') {
      const v = +d.v || 0;
      if (v > ((g.roster && g.roster.v) || 0) && d.m && typeof d.m === 'object') {
        const was = g.roster ? Object.keys(g.roster.m || {}) : [];
        const m = {}; for (const [l, p] of Object.entries(d.m)) { const n = nickOf(l); if (n && /^[A-Za-z0-9_-]{87}$/.test(p)) m[n] = p; }
        const r = {}; for (const [l, x] of Object.entries(d.r && typeof d.r === 'object' ? d.r : {})) { const n = nickOf(l); if (n && m[n] && x && (x.t || x.z)) r[n] = { t: String(x.t || '').slice(0, 20), z: !!x.z }; }
        const pin = d.pin && d.pin.t ? { t: String(d.pin.t).slice(0, 300), at: +d.pin.at || 0 } : null, pin0 = g.roster && g.roster.pin;
        if (live && pin && (!pin0 || pin0.t !== pin.t) && was.length) gdSys(g, '📌 Глава закрепил объявление', 'p' + v);
        g.roster = { v, m, r, pin }; g.name = String(d.name || g.name || '').slice(0, 40);
        if (!Object.keys(m).length) { g.gone = 'closed'; gdSys(g, 'Глава распустил гильдию', 'r' + v); }
        else if (!m[S.me] && (was.includes(S.me) || !g.wait)) { g.gone = 'kicked'; gdSys(g, 'Тебя исключили из гильдии', 'r' + v); }
        else if (g.wait && m[S.me] === (await gdIdent()).pub) { delete g.wait; gdSys(g, 'Глава подтвердил — можно писать', 'w' + v); setTimeout(() => { if (GD.lead) gdAskSync(g); }, 500); }
        if (was.length) for (const l of Object.keys(m)) if (!was.includes(l) && l !== S.me) gdSys(g, `${dispName(l)} вступил в гильдию`, 'j' + v + l);
        if (was.length) for (const l of was) if (!m[l] && l !== S.me) gdSys(g, `${dispName(l)} больше не в гильдии`, 'x' + v + l);
        gdSave(); changed = true;
        if (g.gone) gdSubAll();
      }
    } else if (d.k === 'moved' && !g.gone && !gdOwn(g)) {
      g.gone = 'moved'; gdSave(); changed = true;
      gdSys(g, 'Глава сменил ключ гильдии — новое приглашение придёт в личные, чат перейдёт на него сам', 'm' + d.ts);
      if (!gdOwn(g)) setTimeout(gdPollDm, 4000);
    } else if (d.k === 'leave' && gdOwn(g) && gdIsMem(g, d.f) && d.f !== S.me) {
      if (gdOnce('lv|' + g.id + '|' + d.f + '|' + d.ts, 864e5)) { delete g.roster.m[d.f]; gdSave(); await gdRoster(g); gdSys(g, `${dispName(d.f)} вышел из гильдии. Он знает старый ключ — можно «🔑 Сменить ключ»`); changed = true; }
    } else if (d.k === 'inv' && gdOwn(g) && d.f !== S.me && (gdRole(g, d.f) || {}).z && /^[A-Za-z0-9_-]{8}$/.test(d.tok || '')) {
      if (!(g.links || []).some((x) => x.t === d.tok)) { g.links = (g.links || []).concat({ t: d.tok, at: Math.min(+d.ts || Date.now(), Date.now()), n: d.n ? 1 : 0, used: [], by: d.f }); }
      const l = nickOf(d.l); if (l && !gdIsMem(g, l)) g.invited = (g.invited || []).filter((x) => x.l !== l).concat({ l, ch: nickOf(d.ch) || g.ch, at: Date.now(), by: d.f });
      gdSave(); changed = true;
    } else if (d.k === 'sync?' && d.f !== S.me && GD.lead) {
      gdSyncReply(g, d);
    } else if (d.k === 'sync' && Array.isArray(d.items)) {
      GD.seenSync.add(d.rq);
      let n = 0; for (const e of d.items.slice(0, 60)) if (e && typeof e.p === 'string') { const before = gdHist(g).length; await gdApply(g, e, at, false); if (gdHist(g).length > before) n++; }
      changed = n > 0;
    }
    if (changed && S.room === 'guild' && GD.cur === g.id) { const keep = S.stick; gdSoft(); if (keep && GD.view === 'chat') toBottom(); inputState(); }
    if (changed) gdTabVis();
  }

  // ---- догон истории: «у кого есть сообщения новее …?» — отвечает один, кто в сети ----
  async function gdAskSync(g) {
    if (g.wait) return;
    const h = gdHist(g).filter((x) => !x.sys), last = h.length ? h[h.length - 1].at : 0;
    await gdPost(g, { k: 'sync?', rq: gdRnd(6), since: last });
  }
  function gdSyncReply(g, d) {
    const since = +d.since || 0, items = gdHist(g).filter((x) => x.env && x.at > since);
    if (!items.length) return;
    setTimeout(async () => {
      if (GD.seenSync.has(d.rq)) return;   // уже ответил кто-то другой
      // частями по ~2,4 КБ (у ntfy предел 4 КБ на сообщение), не больше 12 частей — самое свежее важнее
      const parts = []; let cur = [], size = 0;
      for (let i = items.length - 1; i >= 0 && parts.length < 12; i--) {
        const n = JSON.stringify(items[i].env).length;
        if (size + n > 2400 && cur.length) { parts.push(cur); cur = []; size = 0; if (parts.length >= 12) break; }
        cur.unshift(items[i].env); size += n;
      }
      if (cur.length && parts.length < 12) parts.push(cur);
      for (const part of parts.reverse()) { await gdPost(g, { k: 'sync', rq: d.rq, items: part }); await new Promise((ok) => setTimeout(ok, 250)); }
    }, 400 + Math.random() * 2200);
  }

  // ---- действия ----
  async function gdRoster(g) { g.roster.v = (g.roster.v || 0) + 1; gdSave(); return gdPost(g, { k: 'roster', v: g.roster.v, name: g.name, m: g.roster.m, r: g.roster.r || {}, pin: g.roster.pin || null }); }
  // шаблоны опроса
  const GD_TPL = {
    sbor: { n: '📅 Сбор', ph: 'Например: суббота 20:00 у ворот — кто идёт?', o: ['✅ Иду', '❌ Не иду', '🤔 Может быть'] },
    yn: { n: '👍 Да / нет', ph: 'Вопрос', o: ['👍 Да', '👎 Нет'] },
    time: { n: '🕒 Время', ph: 'Во сколько собираемся?', o: ['18:00', '19:00', '20:00', '21:00'], multi: 1 },
    own: { n: '✏️ Свой', ph: 'Вопрос', o: ['', ''] },
  };
  const gdPollTpl = (k, q) => { const x = GD_TPL[k] || GD_TPL.own; return { tpl: k, q: q || '', o: x.o.slice(), multi: !!x.multi }; };
  async function gdPollSend(g, q, o, multi) {
    q = String(q || '').trim(); o = o.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
    if (!q) { S.el.err.textContent = 'Напиши вопрос'; return false; }
    if (o.length < 2) { S.el.err.textContent = 'Нужно хотя бы два варианта'; return false; }
    const env = await gdPost(g, { k: 'msg', id: gdRnd(6), t: q.slice(0, 200), poll: Object.assign({ o }, multi ? { multi: 1 } : {}) });
    if (env && typeof env === 'object') { S.el.err.textContent = ''; await gdApply(g, env, Date.now(), false); GD.pd = null; GD.view = 'chat'; gdRender(true); inputState(); return true; }
    S.el.err.textContent = env === 'limit' ? 'Слишком часто — подожди минуту' : 'Нет связи с ntfy.sh — опрос не ушёл'; return false;
  }
  // /сбор Текст  ·  /опрос Вопрос | А | Б [| …]  ·  /опрос (без текста) — открыть форму
  async function gdPollCmd(g, t) {
    const x = /^\/(сбор|опрос|poll)(?:\s+([\s\S]*))?$/i.exec(t.trim()); if (!x) return false;
    const rest = (x[2] || '').trim(), parts = rest.split('|').map((y) => y.trim()).filter(Boolean);
    if (x[1].toLowerCase() === 'сбор' && rest) { if (await gdPollSend(g, rest, GD_TPL.sbor.o, false)) S.el.inp.value = ''; return true; }
    if (parts.length >= 3) { if (await gdPollSend(g, parts[0], parts.slice(1), false)) S.el.inp.value = ''; return true; }
    GD.pd = gdPollTpl(x[1].toLowerCase() === 'сбор' ? 'sbor' : parts.length ? 'own' : 'sbor', parts[0] || '');
    if (parts.length === 2) GD.pd.o = [parts[1], ''];
    S.el.inp.value = ''; GD.view = 'poll'; gdRender(); inputState(); gdPollFocus(); return true;
  }
  function gdPollFocus(sel) { const el = S.el.log.querySelector(sel || '[data-pq]'); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch {} } }
  // событие к сообщению (голос, реакция, правка, удаление): отправить и сразу показать у себя
  async function gdEv(g, d) {
    const env = await gdPost(g, Object.assign({ id: gdRnd(6) }, d));
    if (env && typeof env === 'object') { await gdApply(g, env, Date.now(), false); gdRender(false); return true; }
    S.el.err.textContent = env === 'limit' ? 'Слишком часто — подожди минуту' : 'Нет связи с ntfy.sh — не получилось';
    return false;
  }
  async function gdCreate(name) {
    name = String(name || '').trim().slice(0, 40);
    if (!name) { S.el.err.textContent = 'Назови гильдию'; return; }
    if (!S.me) { S.el.err.textContent = 'Войди через Twitch на сайте игры'; return; }
    const id = await gdIdent();
    gdLoad();
    const g = { id: gdRnd(6), ep: 1, key: gdRnd(32), name, owner: S.me, opk: id.pub, ch: S.ch, roster: { v: 0, m: { [S.me]: id.pub } }, invited: [] };
    GD.list.push(g); GD.cur = g.id; gdSave();
    const r = await gdRoster(g);
    gdSys(g, `Гильдия «${name}» создана. Пригласи участников — им нужен «Чат Легиона» 3.18 или новее.`);
    GD.view = 'members'; gdTabVis(); gdSubAll(); try { GD.bc && GD.bc.postMessage({ t: 'sub' }); } catch {}
    gdRender(); inputState();
    if (!r) S.el.err.textContent = 'Гильдия создана, но связи с ntfy.sh сейчас нет — сообщения уйдут, когда появится';
  }
  async function gdInvite(g, who) {
    const l = nickOf(who); if (!l) { S.el.err.textContent = 'Напиши ник игрока'; return; }
    if (l === S.me) { S.el.err.textContent = 'Ты уже в гильдии'; return; }
    if (!gdCanInv(g)) { S.el.err.textContent = 'Звать в гильдию может глава или тот, кому он это разрешил'; return; }
    if (!S.flags.dm) { S.el.err.textContent = 'На этом канале личные выключены — пригласить не получится'; return; }
    let text = gdInvText(g);
    if (!gdOwn(g)) {   // заместитель: приглашение с меткой; главе — подписанная запись, чтобы он принял ключ
      const x = { t: gdRnd(6), at: Date.now(), n: 1, used: [], by: S.me };
      const ok = await gdPost(g, { k: 'inv', tok: x.t, n: 1, l, ch: S.ch });
      if (!ok || typeof ok !== 'object') { S.el.err.textContent = 'Нет связи с ntfy.sh — попробуй позже'; return; }
      text = `⚜ Зову в гильдию «${gdName(g).slice(0, 30)}» — закрытый чат в «Чате Легиона» (github.com/frebertor-sudo/legion-chat-window): ${gdLinkCode(g, x)}`;
    }
    const r = await gdDm(S.ch, l, text);
    if (r && r.ok) {
      g.invited = (g.invited || []).filter((x) => x.l !== l).concat({ l, ch: S.ch, at: Date.now() }); gdSave();
      S.el.err.textContent = ''; GD.note = `Приглашение ушло ${pmName(l)} в личные. Он появится в составе, когда примет его (тебе нужно быть в сети).`;
      if (S.room !== 'guild') { okMsg(`⚜ ${GD.note}`); GD.note = ''; }
    } else S.el.err.textContent = `Личное ${pmName(l)} не ушло: ${(r && (ERR[r.error] || r.error)) || 'нет связи'}`;
    gdRender();
  }
  async function gdJoin(p) {
    if (!S.flags.dm && p.ch === S.ch) { S.el.err.textContent = 'На этом канале личные выключены'; return; }
    const id = await gdIdent();
    const r = await gdDm(p.ch, p.from, `⚜ Вступаю в гильдию — ключ для «Чата Легиона»: LGK2:${p.id}.${id.pub}${p.tok ? '.' + p.tok : ''}`);
    if (!r || !r.ok) { S.el.err.textContent = `Не получилось ответить ${pmName(p.from)}: ${(r && (ERR[r.error] || r.error)) || 'нет связи'}`; return; }
    gdLoad();
    let g = gdGet(p.id);
    if (!g) { g = { id: p.id, ep: p.ep, key: p.key, name: p.name, owner: p.from, opk: p.opk, ch: p.ch, roster: { v: 0, m: {} }, wait: 1 }; GD.list.push(g); }
    else Object.assign(g, { ep: p.ep, key: p.key, opk: p.opk, owner: p.from, ch: p.ch, wait: 1 }), delete g.gone;
    gdSave(); GD.inv = GD.inv.filter((x) => x.id !== p.id);
    gdSys(g, `Ты принял приглашение. Ждём, пока ${pmName(p.from)} подтвердит — он должен быть в сети.`);
    GD.cur = g.id; GD.view = 'chat'; gdTabVis(); gdSubAll(); try { GD.bc && GD.bc.postMessage({ t: 'sub' }); } catch {}
    gdRender(true); inputState();
  }
  async function gdRekeyTo(g, p) {   // переход участника на новый ключ от главы
    Object.assign(g, { ep: p.ep, key: p.key, ch: p.ch }); delete g.gone; g.roster = { v: 0, m: {} }; g.wait = 1; gdSave();
    // новый ключ: моя запись в составе уже есть у главы — ждём его состав по новому адресу
    gdSys(g, 'Гильдия перешла на новый ключ');
    gdSubAll(); try { GD.bc && GD.bc.postMessage({ t: 'sub' }); } catch {}
    if (S.room === 'guild') gdSoft();
  }
  // исключить или просто сменить ключ: новый ключ и адрес, состав — на новом месте, оставшимся — приглашение в личные
  async function gdRekey(g, kick) {
    if (!gdOwn(g) || GD.busy) return;
    GD.busy = true; gdRender();
    if (kick) { delete g.roster.m[kick]; if (g.roster.r) delete g.roster.r[kick]; g.invited = (g.invited || []).filter((x) => x.l !== kick); }
    await gdRoster(g);                       // по старому ключу: исключённый узнает, что его убрали
    await gdPost(g, { k: 'moved' });
    g.ep += 1; g.key = gdRnd(32); g.roster.v += 1; g.links = []; gdSave();
    gdSubAll(); try { GD.bc && GD.bc.postMessage({ t: 'sub' }); } catch {}
    await gdRoster(g);
    gdSys(g, kick ? `${pmName(kick)} исключён. Новый ключ рассылаю остальным…` : 'Ключ сменён. Рассылаю новый остальным…');
    let bad = 0;
    for (const l of gdMem(g).filter((x) => x !== S.me)) {
      const r = await gdDm((g.mch && g.mch[l]) || g.ch || S.ch, l, gdInvText(g));
      if (!(r && r.ok)) bad++;
      await new Promise((ok) => setTimeout(ok, 1300));   // у личных игры есть ограничение на частоту
    }
    GD.busy = false; GD.note = bad ? `Не дошло до ${bad} — позови их ещё раз` : 'Готово: у оставшихся новый ключ';
    gdRender();
  }
  async function gdLeave(g) {
    if (gdOwn(g)) { g.roster.m = {}; await gdRoster(g); }   // глава уходит — гильдия распускается
    else if (!g.gone) await gdPost(g, { k: 'leave' });
    gdLoad(); GD.list = GD.list.filter((x) => x.id !== g.id); gdSave();
    try { localStorage.removeItem(gdHK(g)); } catch {}
    GD.cur = (GD.list[0] && GD.list[0].id) || ''; GD.view = GD.cur ? 'chat' : 'home';
    gdSubAll(); try { GD.bc && GD.bc.postMessage({ t: 'sub' }); } catch {}
    gdTabVis(); gdRender(); inputState();
  }
  async function gdSay(t) {
    const g = gdCur(); if (!g || g.gone || g.wait) return;
    S.el.send.disabled = true;
    if (S.reply && S.reply.gid === g.id && S.reply.edit) {
      const ok = await gdEv(g, { k: 'edit', p: S.reply.gmid, t: String(t).slice(0, 500) });
      S.el.send.disabled = false; if (ok) { replyCancel(); S.el.inp.value = ''; }
      if (!S.el.inp.disabled) S.el.inp.focus(); return;
    }
    if (/^\/(сбор|опрос|poll)(\s|$)/i.test(t.trim())) { await gdPollCmd(g, t); S.el.send.disabled = false; return; }
    const r = S.reply && S.reply.gid === g.id && !S.reply.edit ? { id: S.reply.gmid, f: S.reply.l, s: S.reply.snip } : null;
    const env = await gdPost(g, Object.assign({ k: 'msg', id: gdRnd(6), t: String(t).slice(0, 500) }, r ? { re: r } : {}));
    S.el.send.disabled = false;
    if (env && typeof env === 'object') { if (r) replyCancel(); S.el.inp.value = ''; S.el.err.textContent = ''; await gdApply(g, env, Date.now(), false); GD.view = 'chat'; gdRender(true); }
    else S.el.err.textContent = env === 'limit' ? 'Слишком часто — подожди минуту' : 'Нет связи с ntfy.sh — сообщение не ушло';
    if (!S.el.inp.disabled) S.el.inp.focus();
  }

  // ---- вид ----
  const gdHas = () => GD.list.length > 0 || GD.inv.length > 0;
  function gdTabVis() {
    const b = S.el && S.el.room && S.el.room.querySelector('[data-r="guild"]'); if (!b) return;
    b.hidden = !(CZ.guilds || gdHas() || S.room === 'guild');
    S.el.room.classList.toggle('many', !b.hidden);   // шесть вкладок: в узком окне у неактивных — только значки
  }
  function gdBadge() {
    const n = [...GD.un.values()].reduce((a, b) => a + b, 0) + GD.inv.length, b = S.el && S.el.room && S.el.room.querySelector('[data-r="guild"] .rb');
    if (b) { b.hidden = !n || S.room === 'guild'; b.textContent = n > 99 ? '99+' : String(n); }
  }
  function gdBar() {
    const bar = S.el.gdbar; if (!bar) return;
    const g = gdCur(), show = S.room === 'guild' && !!g && GD.view !== 'home';
    bar.hidden = !show; if (!show) return;
    const own = gdOwn(g), n = gdMem(g).length;
    const st = g.gone === 'kicked' ? 'тебя исключили' : g.gone === 'closed' ? 'гильдия распущена' : g.gone === 'moved' ? 'ждём новый ключ от главы' : g.wait ? 'ждём подтверждения главы' : `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'участник' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'участника' : 'участников'}${own ? ' · ты глава' : ' · глава ' + esc(pmName(g.owner))}`;
    bar.innerHTML = `<span class="who"><span class="av" style="--avc:#c9a24a" aria-hidden="true">⚜</span><span style="min-width:0"><b>${esc(gdName(g))}</b><small title="Сообщения зашифрованы и подписаны. Ключ гильдии передаётся через личные игры. Сервер ntfy.sh хранит шифр около 12 часов, старое подтягивается у участников в сети.">${st} · 🔒 шифр</small></span></span>
      <span class="acts"><button type="button" data-gd="view:chat" aria-pressed="${GD.view === 'chat'}" title="Переписка" aria-label="Переписка">💬</button><button type="button" data-gd="view:members" aria-pressed="${GD.view === 'members'}" title="Состав" aria-label="Состав">👥</button>${own && !g.gone ? `<button type="button" data-gd="view:pin" aria-pressed="${GD.view === 'pin'}" title="Объявление вверху гильдии" aria-label="Объявление">📌</button>` : ''}<button type="button" data-gd="view:home" title="Все гильдии, создать, приглашения" aria-label="Все гильдии">⚜</button></span>${g.roster && g.roster.pin && g.roster.pin.t ? `<div class="gpin" role="note"><span class="gpt">📌 ${fmtText(g.roster.pin.t)}</span>${own && !g.gone ? '<button type="button" data-gd="unpin" title="Убрать объявление" aria-label="Убрать объявление">✕</button>' : ''}</div>` : ''}`;
  }
  function gdRender(stick) {
    if (S.room !== 'guild') return;
    gdLoad();
    const log = S.el.log; log.classList.add('pm'); S.el.empty.hidden = true;
    const g = gdCur();
    if (!g) GD.view = 'home'; else if (!GD.view) GD.view = 'chat';
    if (g) GD.cur = g.id;
    gdBar(); gdBadge();
    const f = document.createDocumentFragment();
    const li = (cls, html) => { const x = document.createElement('li'); if (cls) x.className = cls; x.innerHTML = html; f.appendChild(x); return x; };
    const note = GD.note ? `<p class="gdn">${esc(GD.note)}</p>` : ''; GD.note = '';
    if (!gdOn()) li('pm0', '<b>Гильдии недоступны</b>Этот браузер не умеет шифровать (нет WebCrypto).');
    else if (GD.view === 'home') {
      li('pm0 gdc', `<b>⚜ Гильдии — закрытый чат для своих</b>Сообщения зашифрованы и подписаны: читают только участники, подделать чужое сообщение нельзя. Ключ гильдии передаётся через личные игры. Сообщения идут через ntfy.sh (сервер видит только шифр) и хранятся там около 12 часов — старое подтянется у участников, кто в сети.${note}`);
      if (GD.inv.length) { li('sec', 'Тебя зовут'); for (const p of GD.inv) li('conv', `${avatar(p.from)}<span class="cv"><b>${esc(p.name || 'Гильдия')}</b><span>${p.link ? 'ссылка от' : 'приглашение от'} ${esc(pmName(p.from))}${p.via ? ' · через ' + esc(pmName(p.via)) : ''}</span></span><span class="acts"><button type="button" class="ok" data-gd="join:${esc(p.id)}">Вступить</button><button type="button" data-gd="skip:${esc(p.id)}" aria-label="Отклонить">✕</button></span>`); }
      for (const o of GD.old) li('pm0 gds', `${esc(pmName(o.from))} зовёт в гильдию старого формата (LGG1, без подписей) — попроси пригласить заново из этой версии.`);
      if (GD.list.length) {
        li('sec', 'Мои гильдии');
        for (const x of GD.list) { const u = GD.un.get(x.id) || 0; li('conv', `<span class="av" style="--avc:#c9a24a" aria-hidden="true">⚜</span><span class="cv"><b>${esc(gdName(x))}</b><span>${x.gone === 'kicked' ? 'тебя исключили' : x.gone === 'closed' ? 'распущена' : x.wait ? 'ждём подтверждения главы' : `${gdMem(x).length} в составе${gdOwn(x) ? ' · ты глава' : ''}`}</span></span>${u ? `<span class="cu">${u}</span>` : ''}<span class="acts"><button type="button" class="ok" data-gd="open:${esc(x.id)}">Открыть</button></span>`); }
      }
      li('sec', 'Вступить по ссылке или коду');
      li('gdf', `<form data-gdf="code" autocomplete="off"><input name="v" maxlength="400" placeholder="Вставь ссылку или код LGG2:…" aria-label="Ссылка или код приглашения" spellcheck="false"><button type="submit">Вступить</button></form>`);
      li('sec', 'Создать гильдию');
      li('gdf', `<form data-gdf="create" autocomplete="off"><input name="v" maxlength="40" placeholder="Название гильдии" aria-label="Название гильдии"><button type="submit" class="ok">Создать</button></form>`);
    } else if (GD.view === 'poll' && !g.gone && !g.wait) {
      const P = GD.pd || (GD.pd = gdPollTpl('sbor'));
      li('sec', 'Сбор или опрос');
      li('gdf', `<form data-gdf="poll" class="gpf" autocomplete="off">
        <div class="gtpl" role="group" aria-label="Шаблон">${Object.entries(GD_TPL).map(([k, x]) => `<button type="button" data-gd="ptpl:${k}" aria-pressed="${P.tpl === k}">${x.n}</button>`).join('')}</div>
        <input name="q" maxlength="200" value="${esc(P.q)}" placeholder="${esc(GD_TPL[P.tpl] ? GD_TPL[P.tpl].ph : 'Вопрос')}" aria-label="Вопрос" data-pq>
        <div class="gopts">${P.o.map((o, k) => `<div class="gopt"><input name="o" maxlength="40" value="${esc(o)}" placeholder="Вариант ${k + 1}" aria-label="Вариант ${k + 1}" data-po="${k}">${P.o.length > 2 ? `<button type="button" data-gd="pdel:${k}" aria-label="Убрать вариант ${k + 1}" title="Убрать">✕</button>` : ''}</div>`).join('')}${P.o.length < 6 ? '<button type="button" class="gadd" data-gd="padd">＋ Вариант</button>' : ''}</div>
        <label class="gdz"><input type="checkbox" data-pm${P.multi ? ' checked' : ''}> можно выбрать несколько</label>
        <div class="gdl"><button type="submit" class="ok">Отправить</button><button type="button" data-gd="view:chat">Отмена</button></div></form><small class="gdh">Enter — к следующему варианту, Ctrl+Enter — отправить. Быстро из поля ввода: <b>/сбор Суббота 20:00 у ворот</b> или <b>/опрос Куда идём? | Шахта | Город</b>.</small>`);
    } else if (GD.view === 'pin' && gdOwn(g) && !g.gone) {
      const pin = g.roster.pin;
      li('sec', 'Объявление главы');
      li('gdf', `<form data-gdf="pin" class="gpf" autocomplete="off"><textarea name="t" rows="3" maxlength="300" placeholder="Что увидят все вверху гильдии" aria-label="Текст объявления">${esc((pin && pin.t) || '')}</textarea><div class="gdl"><button type="submit" class="ok">Закрепить</button>${pin ? '<button type="button" data-gd="unpin">Убрать</button>' : ''}<button type="button" data-gd="view:chat">Отмена</button></div></form><small class="gdh">Объявление видят все участники, и новенькие тоже. Можно закрепить и любое сообщение — кнопкой 📌 при наведении.</small>`);
    } else if (GD.view === 'members') {
      const own = gdOwn(g), live = !g.gone, inv = gdCanInv(g);
      if (inv) {
        li('sec', 'Пригласить игрока');
        li('gdf', `<form data-gdf="invite" autocomplete="off"><input name="v" maxlength="26" placeholder="ник игрока" aria-label="Ник игрока" spellcheck="false"><button type="submit" class="ok">Пригласить</button></form>${note}<small class="gdh">Приглашение уходит в личные игры. Игроку нужен «Чат Легиона» 3.18 или новее; в состав он попадёт, когда примет приглашение, а ты будешь в сети.</small>`);
      } else if (note) li('gdf', note);
      li('sec', `Состав · ${gdMem(g).length}`);
      for (const l of gdMem(g).sort((a, b) => (b === g.owner) - (a === g.owner) || !!gdRole(g, b) - !!gdRole(g, a) || a.localeCompare(b))) {
        const ro = gdRole(g, l);
        li('conv', `${avatar(l)}<span class="cv"><b style="color:${ncol(l)}">${esc(dispName(l))}</b><span>${l === g.owner ? '👑 глава' : ro && ro.t ? '🏷 ' + esc(ro.t) : 'участник'}${ro && ro.z ? ' · может звать' : ''}${l === S.me ? ' · это ты' : ''}</span></span>${own && live && l !== S.me ? `<span class="acts"><button type="button" data-gd="role:${esc(l)}" aria-pressed="${GD.roleEdit === l}" title="Назначить роль">🏷 Роль</button><button type="button" class="${GD.sure === l ? 'sure' : ''}" data-gd="kick:${esc(l)}"${GD.busy ? ' disabled' : ''}>${GD.sure === l ? 'Точно исключить?' : 'Исключить'}</button></span>` : ''}`);
        if (own && live && GD.roleEdit === l) li('gdf gdrole', `<form data-gdf="role" data-l="${esc(l)}" autocomplete="off"><input name="v" maxlength="20" list="gdroles" value="${esc((ro && ro.t) || '')}" placeholder="Роль для ${esc(dispName(l))}" aria-label="Название роли"><datalist id="gdroles">${GD_ROLES.map((x) => `<option value="${esc(x)}">`).join('')}</datalist><button type="submit" class="ok">Сохранить</button>${ro ? `<button type="button" data-gd="roleoff:${esc(l)}">Убрать</button>` : ''}</form><label class="gdz"><input type="checkbox" name="z"${ro && ro.z ? ' checked' : ''}> может звать в гильдию (приглашения и ссылки; в состав всё равно добавляет глава)</label>`);
      }
      if (inv) {
        const links = (g.links || []).filter((x) => gdLinkOk(g, x) && (own || x.by === S.me));
        li('sec', 'Ссылка-приглашение');
        li('gdf', `<div class="gdl"><button type="button" class="ok" data-gd="lnew:1">🔗 Ссылка на одного</button><button type="button" data-gd="lnew:0">🔗 Ссылка для всех</button></div><small class="gdh">Ничего не отправляется — скопируй и передай сам, куда удобно. По ссылке можно читать гильдию, пока ты не сменишь ключ; писать — после подтверждения (чат подтвердит сам, когда ты в сети). Ссылка действует 7 дней.</small>`);
        for (const x of links) {
          const left = x.n ? `на одного${(x.used || []).length ? ' · использована' : ''}` : `для всех · вступили: ${(x.used || []).length}`;
          const till = new Date(x.at + GD_LINK_TTL).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
          li('conv gdlk', `<span class="av" style="--avc:#c9a24a" aria-hidden="true">🔗</span><span class="cv"><b>${left}</b><span>до ${esc(till)}${(x.used || []).length ? ' · ' + x.used.map((l) => esc(dispName(l))).join(', ') : ''}</span></span><span class="acts"><button type="button" class="ok" data-gd="lcopy:${esc(x.t)}" title="Скопировать ссылку">⧉ Ссылка</button><button type="button" data-gd="lcode:${esc(x.t)}" title="Скопировать код — вставить в поле «Вступить по ссылке или коду»">⧉ Код</button><button type="button" data-gd="lrev:${esc(x.t)}" aria-label="Отозвать ссылку" title="Отозвать">✕</button></span>`);
        }
      }
      if (own && (g.invited || []).length) { li('sec', 'Приглашены, ждём ответа'); for (const x of g.invited) li('conv', `${avatar(x.l)}<span class="cv"><b>${esc(dispName(x.l))}</b><span>приглашение в личных</span></span><span class="acts"><button type="button" data-gd="uninv:${esc(x.l)}">Отозвать</button></span>`); }
      li('gdf', `${own && live ? `<button type="button" data-gd="rekey"${GD.busy ? ' disabled' : ''} title="Новый ключ и адрес — тот, кто ушёл или получил старый ключ, больше ничего не прочитает">🔑 Сменить ключ</button> ` : ''}<button type="button" class="${GD.sure === '!leave' ? 'sure' : ''}" data-gd="leave">${GD.sure === '!leave' ? (own ? 'Точно распустить?' : 'Точно выйти?') : own ? 'Распустить гильдию' : g.gone ? 'Убрать из списка' : 'Выйти из гильдии'}</button>`);
    } else {
      const L = gdHist(g), ev = new Map(), own = gdOwn(g), live = !g.gone && !g.wait;
      for (const x of L) if (x.k && x.k !== 'msg' && x.p) { if (!ev.has(x.p)) ev.set(x.p, []); ev.get(x.p).push(x); }
      const info = (m) => {
        let t = m.t, ed = 0, del = '';
        const rx = new Map(), vt = new Map();
        for (const x of (ev.get(m.id) || []).slice().sort((a, b) => a.at - b.at)) {
          if (x.k === 'edit' && x.f === m.f) { t = x.t; ed = x.at; }
          else if (x.k === 'del' && (x.f === m.f || x.f === g.owner)) del = x.f;
          else if (x.k === 'react') { const st = rx.get(x.e) || new Set(); if (x.on) st.add(x.f); else st.delete(x.f); rx.set(x.e, st); }
          else if (x.k === 'vote' && m.poll) {
            if (m.poll.multi) { if (x.o >= 0 && x.o < m.poll.o.length) { const st = new Set(vt.get(x.f) || []); if (x.on === false) st.delete(x.o); else st.add(x.o); if (st.size) vt.set(x.f, st); else vt.delete(x.f); } }
            else if (x.o >= 0 && x.o < m.poll.o.length) vt.set(x.f, x.o); else vt.delete(x.f);
          }
        }
        return { t, ed, del, rx, vt };
      };
      let prev = null, day = 0;
      for (const m of L) {
        if (m.k && m.k !== 'msg') continue;
        if (!day || !sameDay(day, m.at)) { li('day', dayName(m.at)); day = m.at; }
        if (m.sys) { li('pm0 gds', esc(m.t)); prev = null; continue; }
        const me = m.f === S.me, cont = prev && prev.f === m.f && sameDay(prev.at, m.at) && m.at - prev.at < 5 * 60000;
        const i = info(m), id = esc(m.id);
        const name = !me && !cont ? `<span class="gnm"><span class="n" data-l="${esc(m.f)}" style="color:${ncol(m.f)}">${esc(dispName(m.f))}</span>${gdRoleTag(g, m.f)}</span>` : '';
        const tm = `<span class="bt" title="${esc(new Date(m.at).toLocaleString('ru-RU'))}${i.ed ? ' · изменено ' + esc(new Date(i.ed).toLocaleString('ru-RU')) : ''}">${i.ed ? '<i class="ged">изм.</i> ' : ''}${hhmm(m.at)}</span>`;
        let body;
        if (i.del) body = `${name}<span class="gdel">${i.del === m.f ? 'Сообщение удалено' : 'Удалено главой'}</span>${tm}`;
        else {
          let poll = '';
          if (m.poll) {
            const tot = i.vt.size, multi = !!m.poll.multi, has = (v, k) => (multi ? v.has(k) : v === k), mv = i.vt.get(S.me);
            poll = `<div class="gpoll">${m.poll.o.map((o, k) => { const who = [...i.vt].filter(([, v]) => has(v, k)).map(([l]) => dispName(l)); const pc = tot ? Math.round(who.length * 100 / tot) : 0; return `<button type="button" class="gpo${mv !== undefined && has(mv, k) ? ' on' : ''}${multi ? ' mul' : ''}" data-gd="vote:${id}:${k}" title="${esc(who.join(', ') || 'пока никто')}"${live ? '' : ' disabled'}><span class="gpb" style="width:${pc}%"></span><span class="gpl">${esc(o)}</span><b>${who.length}</b></button>`; }).join('')}<small class="gph">${multi ? 'можно выбрать несколько · ' : ''}${tot ? `ответили: ${tot}` : 'нажми, чтобы ответить'}${mv !== undefined ? ' · нажми ещё раз, чтобы снять' : ''}</small></div>`;
          }
          const rx = [...i.rx].filter(([, st]) => st.size).map(([e, st]) => `<button type="button" class="grc${st.has(S.me) ? ' on' : ''}" data-gd="react:${id}:${e}" title="${esc([...st].map(dispName).join(', '))}"${live ? '' : ' disabled'}>${e} ${st.size}</button>`).join('');
          const pick = GD.rpick === m.id ? `<div class="grp">${GD_EMO.map((e) => `<button type="button" data-gd="react:${id}:${e}" aria-label="Реакция ${e}">${e}</button>`).join('')}</div>` : '';
          const acts = live ? `<span class="gdact"><button type="button" data-gd="re:${id}" title="Ответить" aria-label="Ответить">↩</button><button type="button" data-gd="rpick:${id}" title="Реакция" aria-label="Реакция">☺</button>${me && !m.poll ? `<button type="button" data-gd="edit:${id}" title="Изменить" aria-label="Изменить">✏️</button>` : ''}${own ? `<button type="button" data-gd="pinm:${id}" title="Закрепить как объявление" aria-label="Закрепить">📌</button>` : ''}${me || own ? `<button type="button" class="${GD.sure === 'del:' + m.id ? 'sure' : ''}" data-gd="del:${id}" title="Удалить" aria-label="Удалить">${GD.sure === 'del:' + m.id ? 'Точно?' : '🗑'}</button>` : ''}</span>` : '';
          body = `${name}${m.re ? `<span class="gdq${m.re.f === S.me ? ' me' : ''}" data-gq="${esc(m.re.id)}" role="button" tabindex="0" title="К сообщению">${RQ_ICO}<b style="color:${ncol(m.re.f)}">@${esc(dispName(m.re.f))}</b>: ${esc(m.re.s)}</span>` : ''}${m.poll ? '<b class="gpq">📊 </b>' : ''}${fmtText(i.t)}${poll}${rx ? `<div class="grx">${rx}</div>` : ''}${pick}${acts}${tm}`;
        }
        const x = li(`b${me ? ' me' : ''}${cont ? ' cont' : ''}${i.del ? ' gdd' : ''}${m.poll ? ' gpl' : ''}${GD.sure === 'del:' + m.id || GD.rpick === m.id ? ' hot' : ''}`, body);
        x.dataset.key = 'g:' + m.id; if (m.re && m.re.f === S.me && !me) x.classList.add('tome');
        prev = m;
      }
      if (!L.some((m) => !m.sys && (!m.k || m.k === 'msg'))) li('pm0', g.gone === 'kicked' ? '<b>Гильдия недоступна</b>Тебя исключили.' : g.gone === 'closed' ? '<b>Гильдия распущена</b>' : g.wait ? '<b>Почти готово</b>Глава подтвердит тебя, когда будет в сети, — тогда можно писать.' : '<b>Здесь пока тихо</b>Напиши первым — прочитают только участники гильдии.');
      GD.un.delete(g.id); gdBadge();
    }
    log.innerHTML = ''; log.appendChild(f);
    if (GD.view === 'chat' && stick !== false) toBottom();
  }
  // перерисовать, не сбив набор в поле гильдии
  function gdSoft() { const a = document.activeElement; if (a && a.closest && a.closest('[data-gdf]') && S.el.log.contains(a)) gdBar(); else gdRender(false); }
  function gdEnter() {
    gdLoad(); GD.sure = '';
    const g = gdCur(); GD.view = GD.fromLink ? 'home' : g ? (GD.view === 'members' ? 'members' : 'chat') : 'home'; GD.fromLink = false;
    if (g) GD.cur = g.id;
    gdDot(); gdRender(true); inputState(); gdBadge();
    gdPollDm();
  }
  function gdCopy(t, btn) { const lab = btn.textContent; copyText(t, btn); setTimeout(() => { if (btn.isConnected) { btn.textContent = lab; btn.classList.remove('ok'); } }, 1300); }
  // принять ссылку или код: показать «Тебя зовут» (или сразу вступить, если вставили вручную)
  function gdTakeLink(text, now) {
    const p = gdParseInv(text);
    if (!p) { if (now) S.el.err.textContent = 'Это не похоже на ссылку-приглашение в гильдию'; return null; }
    if (p.from === S.me) { if (now) S.el.err.textContent = 'Это твоя же ссылка'; return null; }
    gdLoad(); const g = gdGet(p.id);
    if (g && !g.gone && !g.wait && g.ep >= p.ep) { GD.cur = g.id; GD.view = 'chat'; if (now) { gdRender(true); inputState(); } return null; }
    GD.inv = GD.inv.filter((x) => x.id !== p.id).concat(p);
    gdTabVis(); gdBadge();
    if (now) gdJoin(p);
    return p;
  }
  // «Точно?» — само снимается через 4 с, по Esc и по щелчку в любом другом месте
  function gdSure(v) {
    GD.sure = v; clearTimeout(GD.sureT);
    if (v) GD.sureT = setTimeout(() => gdSure(''), 4000);
    if (S.room === 'guild') gdRender(false);
  }
  function gdClick(e) {
    const b = e.target.closest('[data-gd]'); if (!b || b.disabled) return;
    e.stopPropagation();
    const [a, ...rest] = b.dataset.gd.split(':'), v = rest.join(':'), g = gdCur();
    if (a === 'vote' || a === 'react') {
      const [mid, w] = [rest[0], rest.slice(1).join(':')];
      if (!gdIsMem(g, S.me) || g.gone || g.wait) return;
      if (a === 'vote') {
        const pm = gdHist(g).find((x) => x.id === mid && x.poll), mv = gdHist(g).filter((x) => x.k === 'vote' && x.p === mid && x.f === S.me).sort((p, q) => p.at - q.at);
        if (pm && pm.poll.multi) { const st = new Set(); for (const x of mv) if (x.o >= 0) { if (x.on === false) st.delete(x.o); else st.add(x.o); } gdEv(g, { k: 'vote', p: mid, o: +w, on: !st.has(+w) }); }
        else { const mine = mv[mv.length - 1]; gdEv(g, { k: 'vote', p: mid, o: mine && mine.o === +w ? -1 : +w }); }
      } else {
        const on = !gdHist(g).filter((x) => x.k === 'react' && x.p === mid && x.f === S.me && x.e === w).sort((p, q) => q.at - p.at).some((x, k) => k === 0 && x.on);
        GD.rpick = ''; gdEv(g, { k: 'react', p: mid, e: w, on });
      }
      return;
    }
    if (a === 'ptpl') { const q = GD.pd ? GD.pd.q : ''; GD.pd = gdPollTpl(v, q); gdRender(); gdPollFocus(); return; }
    if (a === 'padd' && GD.pd && GD.pd.o.length < 6) { GD.pd.o.push(''); GD.pd.tpl = GD.pd.tpl === 'own' ? 'own' : GD.pd.tpl; gdRender(); gdPollFocus(`[data-po="${GD.pd.o.length - 1}"]`); return; }
    if (a === 'pdel' && GD.pd && GD.pd.o.length > 2) { GD.pd.o.splice(+v, 1); gdRender(); return; }
    if (a === 'rpick') { GD.rpick = GD.rpick === v ? '' : v; gdRender(false); return; }
    if (a === 'edit') {
      const m = gdHist(g).find((x) => x.id === v && (!x.k || x.k === 'msg') && x.f === S.me); if (!m) return;
      const last = gdHist(g).filter((x) => x.k === 'edit' && x.p === v && x.f === S.me).sort((p, q) => q.at - p.at)[0], t = last ? last.t : m.t;
      S.reply = { l: S.me, n: '', snip: t.replace(/\s+/g, ' ').slice(0, 40), key: 'g:' + v, gid: g.id, gmid: v, edit: true };
      replyBar(); S.el.inp.value = t; if (!S.el.inp.disabled) { S.el.inp.focus(); S.el.inp.setSelectionRange(t.length, t.length); }
      return;
    }
    if (a === 'del') { if (GD.sure !== 'del:' + v) { gdSure('del:' + v); return; } GD.sure = ''; gdEv(g, { k: 'del', p: v }); return; }
    if (a === 'pinm' && gdOwn(g)) {
      const m = gdHist(g).find((x) => x.id === v && (!x.k || x.k === 'msg')); if (!m) return;
      const last = gdHist(g).filter((x) => x.k === 'edit' && x.p === v && x.f === m.f).sort((p, q) => q.at - p.at)[0];
      g.roster.pin = { t: ((last ? last.t : m.t) || '').slice(0, 300), at: Date.now() }; gdRoster(g).then(() => gdRender(false)); gdRender(false); return;
    }
    if (a === 'unpin' && gdOwn(g)) { g.roster.pin = null; GD.view = 'chat'; gdRoster(g).then(() => gdRender(false)); gdRender(true); return; }
    if (a === 're') {
      const m = gdHist(g).find((x) => x.id === v && !x.sys); if (!m) return;
      let snip = String(m.t).replace(/\s+/g, ' ').trim(); if (snip.length > 40) snip = snip.slice(0, 39).trimEnd() + '…';
      S.reply = { l: m.f, n: dispName(m.f), snip, key: 'g:' + m.id, gid: g.id, gmid: m.id };
      replyBar(); if (!S.el.inp.disabled) S.el.inp.focus(); return;
    }
    if (a === 'view') { GD.view = v; GD.sure = ''; GD.rpick = ''; gdRender(v === 'chat'); inputState(); return; }
    if (a === 'open') { GD.cur = v; GD.view = 'chat'; if (S.reply && S.reply.gid !== v) replyCancel(); gdRender(true); inputState(); return; }
    if (a === 'join') { const p = GD.inv.find((x) => x.id === v); if (p) gdJoin(p); return; }
    if (a === 'skip') { GD.inv = GD.inv.filter((x) => x.id !== v); gdTabVis(); gdRender(); return; }
    if (!g) return;
    if (a === 'lnew') {
      if (!gdCanInv(g)) return;
      const x = { t: gdRnd(6), at: Date.now(), n: v === '1' ? 1 : 0, used: [], by: S.me };
      g.links = (g.links || []).filter((y) => gdLinkOk(g, y)).concat(x); gdSave();
      GD.note = gdOwn(g) ? 'Ссылка готова — нажми «⧉ Ссылка», чтобы скопировать' : 'Ссылка готова. По ней вступят, когда глава будет в сети';
      if (!gdOwn(g)) gdPost(g, { k: 'inv', tok: x.t, n: x.n });
      gdRender(); return;
    }
    if (a === 'role') { if (!gdOwn(g)) return; GD.roleEdit = GD.roleEdit === v ? '' : v; gdRender(); const i = S.el.log.querySelector('[data-gdf="role"] input[name="v"]'); if (i) i.focus(); return; }
    if (a === 'roleoff') { if (!gdOwn(g) || !g.roster.r) return; delete g.roster.r[v]; GD.roleEdit = ''; GD.note = `${dispName(v)}: роль снята`; gdRoster(g).then(() => gdRender()); gdRender(); return; }
    if (a === 'lcopy' || a === 'lcode') { const x = (g.links || []).find((y) => y.t === v); if (x) gdCopy(a === 'lcopy' ? gdLinkUrl(g, x) : gdLinkCode(g, x), b); return; }
    if (a === 'lrev') { g.links = (g.links || []).filter((x) => x.t !== v); gdSave(); gdRender(); return; }
    if (a === 'uninv') { g.invited = (g.invited || []).filter((x) => x.l !== v); gdSave(); gdRender(); return; }
    if (a === 'rekey') { gdRekey(g, ''); return; }
    if (a === 'kick') { if (GD.sure !== v) { gdSure(v); return; } GD.sure = ''; gdRekey(g, v); return; }
    if (a === 'leave') { if (GD.sure !== '!leave') { gdSure('!leave'); return; } GD.sure = ''; gdLeave(g); }
  }
  function gdBoot() {   // после /api/me: знаем, кто мы
    if (!S.me || !gdOn()) { gdTabVis(); return; }
    if (GD.bootMe === S.me) { gdTabVis(); gdBadge(); return; }
    GD.bootMe = S.me; GD.inv = []; GD.old = []; GD.id = null;
    gdLoad(); gdTabVis(); gdBadge();
    if (!GD.bc) gdLead(); else gdSubAll();
    setTimeout(gdPollDm, 3000);
    if (GD_HASH && !GD.hashDone) {
      GD.hashDone = true;
      let code = GD_HASH; try { code = decodeURIComponent(code); } catch {}
      if (gdTakeLink(code, false)) { GD.view = 'home'; GD.fromLink = true; }
      try { history.replaceState(null, '', location.pathname + location.search); } catch {}
    }
  }
  function gdInit() {
    S.el.gdbar = document.getElementById('gdbar');
    for (const el of [S.el.log, S.el.gdbar]) el.addEventListener('click', (e) => { if (S.room === 'guild') gdClick(e); }, true);
    const jump = (q) => {
      const li = S.el.log.querySelector(`li[data-key="g:${CSS.escape(q.dataset.gq)}"]`);
      if (!li) { okTip('Этого сообщения уже нет в истории'); return; }
      li.scrollIntoView({ block: 'center', behavior: 'smooth' }); li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
    };
    S.el.log.addEventListener('click', (e) => { const q = S.room === 'guild' && e.target.closest('.gdq'); if (q) { e.stopPropagation(); jump(q); } }, true);
    S.el.log.addEventListener('keydown', (e) => { const q = S.room === 'guild' && e.target.closest && e.target.closest('.gdq'); if (q && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); jump(q); } });
    S.el.log.addEventListener('submit', (e) => {
      const fm = e.target.closest('[data-gdf]'); if (!fm || S.room !== 'guild') return;
      e.preventDefault(); const v = (fm.querySelector('input') || {}).value || '';
      if (fm.dataset.gdf === 'poll') {
        const g = gdCur(); if (!g || g.gone || g.wait || !GD.pd) return;
        gdPollSend(g, GD.pd.q, GD.pd.o, GD.pd.multi);
        return;
      }
      if (fm.dataset.gdf === 'pin') {
        const g = gdCur(); if (!g || !gdOwn(g) || g.gone) return;
        const t = (fm.querySelector('[name="t"]').value || '').trim().slice(0, 300);
        g.roster.pin = t ? { t, at: Date.now() } : null; GD.view = 'chat';
        gdRoster(g).then(() => gdRender(false)); gdRender(true); inputState(); return;
      }
      if (fm.dataset.gdf === 'role') {
        const g = gdCur(), l = nickOf(fm.dataset.l), zb = fm.parentElement && fm.parentElement.querySelector('[name="z"]'), z = !!(zb && zb.checked);
        if (!g || !gdOwn(g) || !l || !gdIsMem(g, l)) return;
        const t = v.trim().slice(0, 20); g.roster.r = Object.assign({}, g.roster.r);
        if (t || z) g.roster.r[l] = { t, z }; else delete g.roster.r[l];
        GD.roleEdit = ''; GD.note = t || z ? `${dispName(l)}: ${t || 'без названия'}${z ? ' · может звать' : ''}` : `${dispName(l)}: роль снята`;
        gdRoster(g).then(() => gdRender()); gdRender(); return;
      }
      if (fm.dataset.gdf === 'code') gdTakeLink(v, true); else if (fm.dataset.gdf === 'create') gdCreate(v); else if (fm.dataset.gdf === 'invite' && gdCur()) gdInvite(gdCur(), v);
    }, true);
    document.addEventListener('pointerdown', (e) => { if (S.room === 'guild' && GD.sure && !(e.target.closest && e.target.closest('.sure'))) gdSure(''); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.room === 'guild' && GD.sure) { e.preventDefault(); gdSure(''); } }, true);
    S.el.log.addEventListener('input', (e) => {
      if (S.room !== 'guild' || !GD.pd) return;
      const t = e.target;
      if (t.matches('[data-pq]')) GD.pd.q = t.value;
      else if (t.matches('[data-po]')) GD.pd.o[+t.dataset.po] = t.value;
      else if (t.matches('[data-pm]')) GD.pd.multi = t.checked;
    });
    S.el.log.addEventListener('change', (e) => { if (S.room === 'guild' && GD.pd && e.target.matches('[data-pm]')) GD.pd.multi = e.target.checked; });
    S.el.log.addEventListener('keydown', (e) => {
      if (S.room !== 'guild' || !GD.pd || e.key !== 'Enter') return;
      const t = e.target; if (!t.closest || !t.closest('[data-gdf="poll"]')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const g = gdCur(); if (g) gdPollSend(g, GD.pd.q, GD.pd.o, GD.pd.multi); return; }
      if (t.matches('[data-pq]')) { gdPollFocus('[data-po="0"]'); return; }
      if (t.matches('[data-po]')) {
        const k = +t.dataset.po;
        if (k + 1 < GD.pd.o.length) gdPollFocus(`[data-po="${k + 1}"]`);
        else if (GD.pd.o.length < 6 && t.value.trim()) { GD.pd.o.push(''); gdRender(); gdPollFocus(`[data-po="${k + 1}"]`); }
      }
    });
    { const gp = document.getElementById('gpb'); S.el.gpb = gp; if (gp) gp.addEventListener('click', () => { if (S.room !== 'guild') return; if (GD.view === 'poll') { GD.view = 'chat'; gdRender(true); } else { GD.pd = GD.pd || gdPollTpl('sbor'); GD.view = 'poll'; gdRender(); gdPollFocus(); } inputState(); }); }
    window.addEventListener('storage', (e) => {   // другое окно изменило гильдии или переписку
      if (!e.key || !(e.key === gdLK() || e.key.startsWith('lgmc_g2h_'))) return;
      gdLoad(); gdTabVis();
      if (S.room === 'guild') { const keep = S.stick; gdSoft(); if (keep && GD.view === 'chat') toBottom(); inputState(); }
    });
    setInterval(() => { if (S.me && !hidden()) gdPollDm(); }, 90000);
  }

  window.__lgMineChat = S;   // для отладки
  try { window.stop(); } catch {}
  boot();
})();
