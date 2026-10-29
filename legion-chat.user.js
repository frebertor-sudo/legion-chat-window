// ==UserScript==
// @name         Легион — чат шахты и города в отдельном окне
// @name:en      Legion — mine & town chat in a separate window
// @namespace    https://play.multidonate.ru/legion-chat-window
// @version      2.1.0
// @description  Чат шахты и города игры «Легион» (play.multidonate.ru) в отдельном окне: стримеры, вкладки города, стикеры 7TV/BTTV/FFZ, пасты, темы, закрепление поверх окон
// @description:en  Mine and town chat of the "Legion" game (play.multidonate.ru) in a separate window: channel switching, 7TV/BTTV/FFZ emotes, saved pastes, themes, always-on-top
// @author       feedfinek
// @license      MIT
// @homepageURL  https://github.com/frebertor-sudo/legion-chat-window
// @supportURL   https://github.com/frebertor-sudo/legion-chat-window/issues
// @updateURL    https://raw.githubusercontent.com/frebertor-sudo/legion-chat-window/main/legion-chat.user.js
// @downloadURL  https://raw.githubusercontent.com/frebertor-sudo/legion-chat-window/main/legion-chat.user.js
// @match        https://play.multidonate.ru/c/*
// @match        https://play.multidonate.ru/site/ver*
// @run-at       document-start
// @noframes
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
  • На странице игры (…/c/<канал>/) слева внизу кнопка «💬 Чат ⧉» — открывает окно чата.
  • Окно живёт по адресу https://play.multidonate.ru/site/ver?minechat=<канал>[&room=city]
    (служебный адрес сайта без строгой CSP — с него можно ходить в API игры под твоим входом).
  • Шахта: GET /c/<канал>/api/mine/state?c=<шахта>&mc=<номер>, отправка POST /c/<канал>/api/mine/chat/say?c=<шахта>.
  • Город: чтение требует «входа» героя на Ярмарку (POST /c/<канал>/api/city/enter) — окно делает это
    только по твоей кнопке (или сразу, если ты так настроил), дальше GET /api/city/state?c=<номер>,
    отправка POST /api/city/say; при уходе — POST /api/city/leave.
  • Список стримеров — GET /c/<канал>/api/channels.
*/

(function () {
  'use strict';
  const ORIGIN = 'https://play.multidonate.ru';
  const chatUrl = (ch, room) => `${ORIGIN}/site/ver?minechat=${encodeURIComponent(ch)}${room === 'city' ? '&room=city' : ''}`;

  // ---------- 1. Страница игры: кнопка «вынести чат в окно» ----------
  const game = location.pathname.match(/^\/c\/([^/]+)\/?$/i);
  if (game) {
    const CH = game[1];
    const addBtn = () => {
      if (document.getElementById('lgmc-pop')) return;
      const b = document.createElement('button');
      b.id = 'lgmc-pop';
      b.type = 'button';
      b.textContent = '💬 Чат ⧉';
      b.title = 'Открыть чат шахты и города в отдельном окне';
      b.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:2147483647;padding:6px 10px;border-radius:8px;border:1px solid #6b5a3a;background:#2a2218;color:#f1d9a5;font:600 13px system-ui,sans-serif;cursor:pointer;opacity:.85';
      b.onmouseenter = () => (b.style.opacity = '1');
      b.onmouseleave = () => (b.style.opacity = '.85');
      b.onclick = () => window.open(chatUrl(CH), 'lgChat', 'popup,width=420,height=720');
      document.body.appendChild(b);
    };
    if (document.body) addBtn(); else document.addEventListener('DOMContentLoaded', addBtn);
    return;
  }

  // ---------- 2. Окно чата: /site/ver?minechat=<канал> ----------
  if (location.pathname !== '/site/ver') return;
  const Q = new URLSearchParams(location.search);
  const CH0 = Q.get('minechat');
  const okLogin = (s) => /^[a-z0-9_]{1,40}$/i.test(String(s || ''));
  if (!okLogin(CH0)) return;

  const CLS_ICO = { legionary: '⚔️', archer: '🏹', mage: '🔮', priest: '✨', rogue: '🗡️', necromancer: '💀', paladin: '☀️', recruit: '🌱' };
  const ROLE_ICO = { own: ['👑', 'админ чата'], mod: ['🛡', 'модератор чата'] };
  const ERR = {
    rate_limited: 'Не так быстро', forbidden: 'Нет прав', login_required: 'Войди через Twitch на сайте игры',
    mine_closed: 'Шахта закрыта', city_closed: 'Город закрыт', town_closed: 'Этот город сейчас закрыт',
  };
  const ROOMS = { mine: '⛏ Шахта', city: '🏰 Город' };
  const TABS = { g: 'Общий', tr: 'Торговля', ev: 'Достижения', dm: 'Личные' };
  const CITY_SPAWN = { x: 2460, y: 1010, town: 'fair' };   // как в игре: Ярмарка, у входа (citymap: QW + 660, 1010)
  const LAST_KEY = 'lgmc_last', CITY_AUTO_KEY = 'lgmc_city_auto';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const S = {
    ch: CH0.toLowerCase(), chName: CH0, room: Q.get('room') === 'city' ? 'city' : 'mine', mine: 'home', mines: [],
    channels: [], me: '', hero: null, flags: { cc: false, tr: false, dm: false }, inCity: false, entering: false,
    tab: 'g', un: { g: 0, tr: 0, ev: 0, dm: 0 }, ign: new Set(), gen: 0,
    c: 0, list: [], ids: new Set(), timer: 0, busy: false, fails: 0, stick: true, unseen: 0, unseenTitle: 0,
  };
  // если в адресе канал не указан явно иначе — вернуть то, где был в прошлый раз (только комнату для того же канала)
  { const last = lsGet(LAST_KEY, null); if (last && last.ch === S.ch && !Q.get('room') && ROOMS[last.room]) S.room = last.room; }
  const BASE = () => `/c/${S.ch}`;
  const title = () => `${S.room === 'city' ? 'Город' : 'Шахта'} · ${S.chName}`;

  function boot() {
    // на этапе document-start корня <html> может ещё не быть — тогда создаём его сами
    if (!document.documentElement) document.appendChild(document.createElement('html'));
    document.documentElement.innerHTML =`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Чат · ${esc(S.chName)}</title>
<style>
:root{color-scheme:dark;--bg:#17130e;--panel:#211b14;--line:#3a3024;--tx:#eadfcb;--mut:#9c8d76;--acc:#f0b84a;--acc-tx:#f0b84a;--on-acc:#1a1206;--me:#3a2d14;--bad:#e06a5a;--ok:#6fbf73;--ns:65%;--nl:68%;--hov:#2b241b}
:root[data-theme="light"]{color-scheme:light;--bg:#fbf7ef;--panel:#f1e9da;--line:#dccfb6;--tx:#2b2117;--mut:#6f5f48;--acc:#e0a42e;--acc-tx:#9a6206;--on-acc:#1a1206;--me:#fbe7bd;--bad:#b8402f;--ok:#2f8f3a;--ns:75%;--nl:29%;--hov:#e9dec9}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#fbf7ef;--panel:#f1e9da;--line:#dccfb6;--tx:#2b2117;--mut:#6f5f48;--acc:#e0a42e;--acc-tx:#9a6206;--on-acc:#1a1206;--me:#fbe7bd;--bad:#b8402f;--ok:#2f8f3a;--ns:75%;--nl:29%;--hov:#e9dec9}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--tx);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;position:relative}
.hb{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:2px 7px;font-size:14px;line-height:1.3;cursor:pointer;flex:none}
.hb:hover{border-color:var(--acc)}
.hb:disabled{opacity:.45;cursor:default}
#pin[aria-pressed="true"]{background:var(--acc);border-color:var(--acc)}
#pinned{margin:auto;text-align:center;color:var(--mut);padding:24px;max-width:320px}
#pinned b{display:block;color:var(--tx);font-size:16px;margin-bottom:6px}
#pinned button{margin-top:14px;background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:8px 14px;font:600 13px system-ui;cursor:pointer}
header{background:var(--panel);border-bottom:1px solid var(--line);flex:none}
.hr{display:flex;align-items:center;gap:6px;padding:7px 10px}
.hr+.hr{padding-top:0}
#dot{width:9px;height:9px;border-radius:50%;background:var(--mut);flex:none}
#dot.ok{background:var(--ok)}#dot.bad{background:var(--bad)}
header select{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px;min-width:0}
#chan{flex:1;font-weight:700;font-size:13px;max-width:100%}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;flex:none}
.seg button{background:var(--bg);color:var(--mut);border:0;padding:3px 9px;font:600 12px system-ui;cursor:pointer}
.seg button+button{border-left:1px solid var(--line)}
.seg button[aria-pressed="true"]{background:var(--acc);color:var(--on-acc)}
.seg button:disabled{opacity:.4;cursor:default}
.hr.r2{flex-wrap:wrap;row-gap:5px}
#ctabs{display:flex;gap:2px;flex-wrap:wrap;flex-basis:100%;min-width:0}
#ctabs[hidden]{display:none}
#ctabs button{background:none;color:var(--mut);border:1px solid transparent;border-radius:6px;padding:2px 7px;font:600 12px system-ui;cursor:pointer;white-space:nowrap}
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
#gate .go{margin:14px 0 10px;background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:8px 16px;font:600 13px system-ui;cursor:pointer}
#gate .go:disabled{opacity:.6;cursor:default}
#gate label{display:flex;gap:6px;justify-content:center;align-items:center;font-size:12px;cursor:pointer}
#more{position:absolute;left:50%;transform:translateX(-50%);bottom:64px;background:var(--acc);color:var(--on-acc);border:0;border-radius:14px;padding:4px 12px;font:600 12px system-ui;cursor:pointer;display:none}
footer{flex:none;border-top:1px solid var(--line);background:var(--panel);padding:8px 10px}
#err{color:var(--bad);font-size:12px;margin:0 0 6px}#err:empty{display:none}
form{display:flex;gap:6px;margin:0}
#in{flex:1;min-width:0;background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
#in:focus{outline:none;border-color:var(--acc)}
#in:disabled{opacity:.6}
#send{background:var(--acc);color:var(--on-acc);border:0;border-radius:8px;padding:0 14px;font-size:16px;cursor:pointer}
#send:disabled{opacity:.5;cursor:default}
#log img.em{height:28px;width:auto;vertical-align:middle;margin:-4px 1px}
#log .zw{display:inline-grid;vertical-align:middle}#log .zw>img{grid-area:1/1;margin:-4px 1px}
#emb{background:var(--bg);color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:0 9px;font-size:17px;cursor:pointer}
#emb[aria-expanded="true"]{border-color:var(--acc)}
#ep{display:none;flex-direction:column;gap:6px;height:min(320px,45vh);margin:0 0 8px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px}
#ep.on{display:flex}
#ep-top{display:flex;gap:6px;align-items:center}
#eq{flex:1;min-width:0;background:var(--panel);color:var(--tx);border:1px solid var(--line);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
#eq:focus{outline:none;border-color:var(--acc)}
#etabs{display:flex;gap:4px;flex-wrap:wrap}
#etabs button{background:none;color:var(--mut);border:1px solid transparent;border-radius:6px;padding:2px 7px;font:600 12px system-ui;cursor:pointer}
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
.pbtn{background:var(--acc);color:var(--on-acc);border:0;border-radius:6px;padding:4px 10px;font:600 12px system-ui;cursor:pointer;white-space:nowrap}
.pbtn.alt{background:var(--panel);color:var(--tx);border:1px solid var(--line)}
#pl{flex:1;overflow-y:auto;list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
#pl li{display:flex;align-items:center;gap:4px;border:1px solid transparent;border-radius:7px;padding:2px 2px 2px 0}
#pl li:hover,#pl li:focus-within{border-color:var(--line);background:var(--hov)}
#pl .pi{flex:1;min-width:0;text-align:left;background:none;border:0;color:var(--tx);padding:4px 6px;cursor:pointer;font:inherit}
#pl .pi b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pl .pi span{display:block;color:var(--mut);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pl .px{background:none;border:1px solid transparent;border-radius:6px;color:var(--mut);padding:2px 6px;cursor:pointer;font-size:13px;flex:none}
#pl .px:hover{border-color:var(--line);color:var(--tx)}
#pl .px.sure{background:var(--bad);color:#fff;border-color:var(--bad);font:600 11px system-ui}
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
html.pinned .hb{padding:0 5px;font-size:12px;border-color:transparent;background:none}
html.pinned .hb:hover,html.pinned .hb[aria-pressed="true"]{border-color:var(--line);background:var(--panel)}
html.pinned #pin[aria-pressed="true"]{background:var(--acc);border-color:var(--acc)}
html.pinned #log{padding:2px 6px 6px}
html.pinned #log li{padding:1px 4px;line-height:1.35}
html.pinned #log li:hover{background:var(--hov)}
html.pinned #log li.mention:hover{background:var(--me)}
html.pinned #log .t{font-size:.78em}
html.pinned.not #log .t{display:none}
html.pinned.noi #log li>span[title]:not(.aw):not(.n):not(.to){display:none}
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
</style></head>
<body>
<header>
  <div class="hr"><span id="dot" title="Связь"></span><select id="chan" title="Стример" aria-label="Стример"></select><button id="theme" class="hb" type="button"></button><span class="po" id="pctl"><button class="hb" type="button" data-pc="dn" title="Мельче" aria-label="Шрифт мельче">A−</button><button class="hb" type="button" data-pc="up" title="Крупнее" aria-label="Шрифт крупнее">A+</button><button class="hb" type="button" data-pc="t" aria-pressed="true" title="Время у сообщений">🕒</button><button class="hb" type="button" data-pc="i" aria-pressed="true" title="Значки классов и ролей">🛡</button><button class="hb" type="button" data-pc="m" aria-pressed="false" title="Только лента: поле ввода появляется при наведении">⌨</button></span><button id="pin" class="hb" type="button" aria-pressed="false">📌</button></div>
  <div class="hr r2"><span class="seg" id="room" role="group" aria-label="Чат"><button type="button" data-r="mine">${ROOMS.mine}</button><button type="button" data-r="city">${ROOMS.city}</button></span><select id="mine" title="Шахта" hidden></select><div id="ctabs" role="tablist" hidden></div></div>
</header>
<ol id="log" role="log" aria-live="polite"></ol><p id="empty">Загружаю чат…</p><div id="gate" hidden></div>
<button id="more" type="button">↓ новые</button>
<footer><p id="err" role="status"></p>
<div id="ep" role="dialog" aria-label="Стикеры"><div id="ep-top"><input id="eq" type="search" placeholder="Найти стикер…" aria-label="Поиск стикера"></div><div id="etabs" role="tablist"></div><div id="eg"></div><div id="eh"></div></div>
<div id="pp" role="dialog" aria-label="Пасты"><div class="pp-top"><input id="pq" type="search" placeholder="Найти пасту…" aria-label="Поиск пасты"><button type="button" class="pbtn" id="pnew">＋ Новая</button></div><ul id="pl"></ul>
<div id="pe"><input id="pn" maxlength="40" placeholder="Название (например: «приветствие»)" aria-label="Название пасты"><textarea id="pt" maxlength="500" placeholder="Текст пасты — можно со стикерами" aria-label="Текст пасты"></textarea><div class="pe-b"><small id="pc">0 / 200</small><button type="button" class="pbtn alt" id="pcancel">Отмена</button><button type="button" class="pbtn" id="psave">Сохранить</button></div></div></div>
<form id="f" autocomplete="off"><button id="pb" type="button" title="Сохранённые пасты" aria-label="Пасты" aria-expanded="false">📋</button><button id="emb" type="button" title="Стикеры (7TV, BTTV, FFZ)" aria-label="Стикеры" aria-expanded="false">😺</button><input id="in" maxlength="200" placeholder="Написать…" enterkeyhint="send" aria-label="Сообщение"><button id="send" type="submit" aria-label="Отправить">➤</button></form></footer>
</body>`;
    const $ = (id) => document.getElementById(id);
    S.el = {
      log: $('log'), empty: $('empty'), gate: $('gate'), more: $('more'), dot: $('dot'), err: $('err'), f: $('f'),
      inp: $('in'), send: $('send'), mine: $('mine'), chan: $('chan'), room: $('room'), ctabs: $('ctabs'),
    };
    S.el.log.addEventListener('scroll', () => {
      const l = S.el.log; S.stick = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
      if (S.stick) { S.unseen = 0; S.el.more.style.display = 'none'; }
    });
    S.el.more.onclick = () => toBottom();
    S.el.log.addEventListener('click', (e) => {   // клик по нику — ответить @ником
      const n = e.target.closest('.n'); if (!n || !n.dataset.l) return;
      const v = S.el.inp.value.replace(/^@\S+\s*/, '');
      S.el.inp.value = `@${n.dataset.l} ${v}`; S.el.inp.focus();
    });
    S.el.f.addEventListener('submit', (e) => { e.preventDefault(); say(); });
    S.el.mine.onchange = () => { S.mine = S.el.mine.value; lsSet('lgmc_mine_' + S.ch, S.mine); restart(); };
    S.el.chan.onchange = () => switchTo(S.el.chan.value, S.room);
    S.el.room.onclick = (e) => { const b = e.target.closest('[data-r]'); if (b && !b.disabled && b.dataset.r !== S.room) switchTo(S.ch, b.dataset.r); };
    S.el.ctabs.onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) tabTo(b.dataset.tab); };
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { S.unseenTitle = 0; document.title = title(); poll(); }
    });
    window.addEventListener('pagehide', () => cityLeave(true));
    themeInit();
    pinInit();
    pickerInit();
    pastesInit();
    start();
    loadChannels();
  }

  // ---------- Тема: как в системе → светлая → тёмная ----------
  const THEME_KEY = 'lgmc_theme';
  const THEMES = { auto: ['🌓', 'Тема: как в системе'], light: ['☀️', 'Тема: светлая'], dark: ['🌙', 'Тема: тёмная'] };
  function themeApply(t) {
    if (!THEMES[t]) t = 'auto';
    for (const d of docs()) { if (t === 'auto') d.documentElement.removeAttribute('data-theme'); else d.documentElement.dataset.theme = t; }
    const b = S.el && S.el.theme;
    if (b) { b.textContent = THEMES[t][0]; b.title = `${THEMES[t][1]} (нажми, чтобы сменить)`; b.setAttribute('aria-label', THEMES[t][1]); b.dataset.t = t; }
  }
  function themeInit() {
    let t = 'auto'; try { t = localStorage.getItem(THEME_KEY) || 'auto'; } catch {}
    S.el.theme = document.getElementById('theme');
    themeApply(t);
    S.el.theme.onclick = (e) => {
      const order = ['auto', 'light', 'dark'], next = order[(order.indexOf(e.currentTarget.dataset.t) + 1) % order.length];
      themeApply(next); try { localStorage.setItem(THEME_KEY, next); } catch {}
    };
    window.addEventListener('storage', (e) => { if (e.key === THEME_KEY) themeApply(e.newValue || 'auto'); });
  }

  // ---------- Поверх всех окон: Document Picture-in-Picture (Chrome / Edge 116+) ----------
  const PIN_KEY = 'lgmc_pin_size';
  const docs = () => (S.pip ? [document, S.pip.document] : [document]);
  const hidden = () => (S.pip ? false : document.hidden);   // плавающее окно всегда на виду
  const pinOk = () => 'documentPictureInPicture' in window;

  function pinInit() {
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
    pinStyleApply(pd);
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
      const r = await fetch(BASE() + path, {
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
    renderChannels();
  }
  function renderChannels() {
    S.el.chan.innerHTML = S.channels.map((c) => `<option value="${esc(c.login.toLowerCase())}">${esc(c.name || c.login)}${c.live ? ' 🔴' : ''}</option>`).join('');
    S.el.chan.value = S.ch;
    const cur = S.channels.find((c) => c.login.toLowerCase() === S.ch);
    if (cur && cur.name) S.chName = cur.name;
    S.el.chan.title = cur && cur.live ? `${S.chName} — сейчас в эфире` : S.chName;
    document.title = title();
  }

  // ---------- Канал и комната ----------
  async function switchTo(ch, room) {
    if (!okLogin(ch)) return;
    if (S.room === 'city' && (ch !== S.ch || room !== 'city')) cityLeave();
    const chChanged = ch !== S.ch;
    S.ch = ch; S.room = room;
    const cur = S.channels.find((c) => c.login.toLowerCase() === ch); S.chName = (cur && cur.name) || ch;
    lsSet(LAST_KEY, { ch, room });
    try { history.replaceState(null, '', chatUrl(ch, room)); } catch {}
    renderChannels();
    if (chChanged) { S.me = ''; S.hero = null; emLoad(); }
    await start();
  }

  async function start() {
    const gen = ++S.gen;
    clearTimeout(S.timer);
    clearLog('Загружаю чат…');
    S.tab = 'g'; S.un = { g: 0, tr: 0, ev: 0, dm: 0 }; S.inCity = false;
    S.el.err.textContent = '';
    try {
      const me = await api('/api/me'); if (gen !== S.gen) return;
      S.me = String((me.user && me.user.login) || '').toLowerCase();
      S.hero = me.hero || null;
      const h = S.hero || {};
      S.flags = { cc: !!h.cc, tr: !!h.ct, dm: !!h.cd };
      S.mines = Object.entries(h.mn || {}).map(([id, v]) => ({ id, nm: (v && v.nm) || id }));
    } catch { if (gen !== S.gen) return; }
    // шахты
    const saved = lsGet('lgmc_mine_' + S.ch, '');
    S.mine = S.mines.some((x) => x.id === saved) ? saved : (S.mines[0] ? S.mines[0].id : 'home');
    S.el.mine.innerHTML = S.mines.map((x) => `<option value="${esc(x.id)}">${esc(x.nm)}</option>`).join('');
    S.el.mine.value = S.mine;
    // какие комнаты доступны: шахта — если у героя на канале есть шахта; город — если чат города включён
    const rb = (r) => S.el.room.querySelector(`[data-r="${r}"]`);
    rb('mine').disabled = !S.mines.length; rb('mine').title = S.mines.length ? 'Чат шахты' : 'На этом канале у тебя нет шахты';
    rb('city').disabled = !!S.hero && !S.flags.cc; rb('city').title = rb('city').disabled ? 'Чат города на этом канале выключен' : 'Чат города';
    if (rb(S.room).disabled) S.room = !rb('city').disabled ? 'city' : 'mine';
    for (const b of S.el.room.querySelectorAll('[data-r]')) b.setAttribute('aria-pressed', String(b.dataset.r === S.room));
    S.el.mine.hidden = S.room !== 'mine' || S.mines.length < 2;
    renderTabs();
    document.title = title(); if (S.pip) S.pip.document.title = title();
    inputState();
    if (S.room === 'mine') {
      if (!S.mines.length) { clearLog('На этом канале у тебя нет шахты — переключись на 🏰 Город.'); return; }
      poll(true);
    } else if (lsGet(CITY_AUTO_KEY, false)) cityEnter();
    else showGate();
  }
  const restart = () => start();

  function clearLog(msg) {
    S.list = []; S.ids.clear(); S.c = 0; S.el.log.innerHTML = '';
    S.el.gate.hidden = true; S.el.log.hidden = false;
    S.el.empty.hidden = !msg; S.el.empty.textContent = msg || '';
  }

  // ---------- Город: вход по кнопке ----------
  function showGate(errText) {
    S.el.log.hidden = true; S.el.empty.hidden = true; S.el.gate.hidden = false;
    const auto = lsGet(CITY_AUTO_KEY, false);
    S.el.gate.innerHTML = `<b>🏰 Чат города · ${esc(S.chName)}</b>Чтобы читать и писать в чат города, твой герой зайдёт на Ярмарку этого канала — как при открытии города в игре. Его увидят другие игроки (и, возможно, на оверлее стрима). Когда переключишься или закроешь окно, герой уйдёт из города.
      ${errText ? `<p style="color:var(--bad)">${esc(errText)}</p>` : ''}
      <br><button type="button" class="go">Войти в город</button>
      <label><input type="checkbox" ${auto ? 'checked' : ''}> Входить сразу, не спрашивая</label>`;
    S.el.gate.querySelector('.go').onclick = () => cityEnter();
    S.el.gate.querySelector('input').onchange = (e) => lsSet(CITY_AUTO_KEY, e.target.checked);
    inputState();
  }

  async function cityEnter() {
    if (S.entering) return;
    const gen = S.gen;
    S.entering = true;
    const go = S.el.gate.querySelector('.go'); if (go) { go.disabled = true; go.textContent = 'Вхожу…'; }
    let r = null;
    try { r = await api('/api/city/enter', CITY_SPAWN); } catch {}
    S.entering = false;
    if (gen !== S.gen || S.room !== 'city') return;
    if (!r || !r.ok) { S.el.dot.className = 'bad'; showGate('Не получилось войти: ' + ((r && (ERR[r.error] || r.error)) || 'нет связи')); return; }
    S.inCity = true; S.cityCh = S.ch;
    S.el.dot.className = 'ok';
    clearLog('');
    S.mod = r.mod === 'own' || r.mod === 'mod' ? r.mod : null;
    S.ign = new Set(Array.isArray(r.ign) ? r.ign : []);
    apply(r, true);
    inputState();
    schedule();
  }

  function cityLeave(onUnload) {
    if (!S.inCity) return;
    S.inCity = false;
    const ch = S.cityCh || S.ch;
    const url = `/c/${ch}/api/city/leave`;
    // при закрытии окна обычный запрос может не успеть уйти — для этого есть sendBeacon
    let sent = false;
    if (onUnload && navigator.sendBeacon) { try { sent = navigator.sendBeacon(url, new Blob(['{}'], { type: 'application/json' })); } catch {} }
    if (!sent) { try { fetch(url, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {} }
    if (!onUnload) S.cityCh = null;
  }

  // ---------- Опрос ----------
  function schedule() {
    clearTimeout(S.timer);
    if (S.room === 'city' && !S.inCity) return;
    const base = hidden() ? 8000 : 2500;
    S.timer = setTimeout(() => poll(), S.fails ? Math.min(30000, base * 2 ** S.fails) : base);
  }

  async function poll(reset) {
    if (S.busy) { if (reset) S.pendingReset = true; return; }
    if (S.room === 'city' && !S.inCity) return;
    const gen = S.gen;
    S.busy = true;
    if (reset) S.c = 0;
    try {
      let r, d;
      if (S.room === 'mine') {
        r = await api(`/api/mine/state?c=${encodeURIComponent(S.mine)}&mc=${S.c || 0}`);
        d = r && r.mchat;
      } else {
        r = await api(`/api/city/state?c=${S.c || 0}`);
        d = r;
      }
      if (gen !== S.gen) return;
      if (!r.ok) {
        if (S.room === 'city' && /не в городе/.test(r.error || '')) {   // присутствие слетело (например, город открыт и закрыт в другой вкладке) — заходим снова
          S.inCity = false; cityEnter(); return;
        }
        throw new Error(ERR[r.error] || r.error || 'ошибка');
      }
      S.fails = 0; S.el.dot.className = 'ok'; S.el.dot.title = 'На связи';
      if (reset) { S.list = []; S.ids.clear(); S.el.log.innerHTML = ''; }
      apply(d || {}, reset);
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

  // вкладка сообщения (как в игре): Достижения — события игры, Торговля / Личные — по виду; в шахте всё — «Общий»
  const tabOf = (m) => (S.room === 'mine' ? 'g' : m.tb || (m.ev ? 'ev' : m.k === 'tr' ? 'tr' : m.k === 'dm' ? 'dm' : 'g'));
  const visible = (m) => !S.ign.has(m.l) && tabOf(m) === S.tab;

  function apply(d, initial) {
    let added = 0;
    for (const msg of d.chat || []) {
      if (!msg || !msg.id || S.ids.has(msg.id)) continue;
      if (S.room === 'mine' && msg.k === 'dm') continue;
      S.ids.add(msg.id); S.list.push(msg);
      if (S.ign.has(msg.l)) continue;
      const tb = tabOf(msg), mine = String(msg.l).toLowerCase() === S.me;
      if (tb === S.tab) { S.el.log.appendChild(row(msg)); added++; }
      else if (!initial && !mine && tb !== 'ev') { S.un[tb] = (S.un[tb] || 0) + 1; renderTabs(); }
      if (!initial && hidden() && !mine && tb === S.tab) document.title = `(${++S.unseenTitle}) ${title()}`;
    }
    for (const id of d.chatDel || []) {   // удалённые модератором
      if (!S.ids.has(id)) continue;
      S.ids.delete(id); S.list = S.list.filter((x) => x.id !== id);
      const li = S.el.log.querySelector(`li[data-id="${CSS.escape(id)}"]`); if (li) li.remove();
    }
    while (S.list.length > 400) { const old = S.list.shift(); S.ids.delete(old.id); const li = S.el.log.querySelector(`li[data-id="${CSS.escape(old.id)}"]`); if (li) li.remove(); }
    if (d.c != null) S.c = Math.max(S.c, +d.c || 0);
    if (d.chatMe && 'muted' in d.chatMe && d.chatMe.muted) S.el.err.textContent = 'Модератор запретил тебе писать в этот чат';
    emptyState();
    if (added) {
      if (S.stick || initial) toBottom();
      else { S.unseen += added; S.el.more.textContent = `↓ новые (${S.unseen})`; S.el.more.style.display = 'block'; }
    }
  }

  const EMPTY = {
    mine: 'В чате шахты пока тихо.', g: 'В чате города пока тихо — напиши первым.',
    tr: 'Здесь объявления: куплю, продам, меняю.', ev: 'Здесь громкие события игры: заточки +7 и выше, достижения.',
    dm: 'Личных пока нет. Чтобы написать лично, начни сообщение с @ника.',
  };
  function emptyState() {
    if (!S.el.gate.hidden) return;
    const has = !!S.el.log.firstElementChild;
    S.el.empty.hidden = has;
    if (!has) S.el.empty.textContent = S.room === 'mine' ? EMPTY.mine : EMPTY[S.tab];
  }

  // ---------- Вкладки чата города ----------
  function renderTabs() {
    const show = S.room === 'city';
    S.el.ctabs.hidden = !show;
    if (!show) return;
    const tabs = ['g', ...(S.flags.tr ? ['tr', 'ev'] : []), ...(S.flags.dm ? ['dm'] : [])];
    if (!tabs.includes(S.tab)) S.tab = 'g';
    S.el.ctabs.innerHTML = tabs.map((t) => `<button type="button" role="tab" data-tab="${t}" aria-selected="${t === S.tab}">${TABS[t]}${S.un[t] && t !== S.tab ? `<b>${S.un[t] > 99 ? '99+' : S.un[t]}</b>` : ''}</button>`).join('');
  }
  function tabTo(t) {
    if (t === S.tab) return;
    S.tab = t; S.un[t] = 0; renderTabs();
    S.el.log.innerHTML = '';
    for (const m of S.list) if (visible(m)) S.el.log.appendChild(row(m));
    emptyState(); inputState(); toBottom();
  }

  function inputState() {
    const gate = S.room === 'city' && !S.inCity;
    const ro = S.room === 'city' && S.tab === 'ev';
    const off = !S.me || gate || ro;
    S.el.inp.disabled = off; S.el.send.disabled = off; S.el.emb.disabled = off; if (S.el.pb) S.el.pb.disabled = off;
    if (off) { pickerOpen(false, true); pastesOpen(false, true); }
    S.el.inp.placeholder = !S.me ? 'Войди через Twitch на сайте игры, чтобы писать'
      : gate ? 'Сначала войди в город'
      : ro ? 'Здесь только события игры'
      : S.room === 'mine' ? 'Написать в чат шахты…'
      : S.tab === 'tr' ? 'Куплю / продам / меняю…'
      : S.tab === 'dm' ? '@ник сообщение — лично'
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
    try { const r = await fetch(u, { signal: c.signal, credentials: 'omit' }); return r.ok ? await r.json() : null; }
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
    for (const li of S.el.log.querySelectorAll('li[data-id]')) {   // перерисовать уже показанные сообщения
      const m = S.list.find((x) => x.id === li.dataset.id); if (m) li.replaceWith(row(m));
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
    S.el.eg.onmouseover = (e) => { const b = e.target.closest('button[data-n]'); if (b) { const em = EM.get(b.dataset.n); S.el.eh.textContent = em ? `${em.n} · ${em.src}` : b.dataset.n; } };
    S.onEsc = (e) => { if (e.key !== 'Escape') return; if (S.el.ep.classList.contains('on')) pickerOpen(false); if (S.el.pp && S.el.pp.classList.contains('on')) pastesOpen(false); };
    document.addEventListener('keydown', S.onEsc);
    pickerTabs();
    emLoad();
  }

  function pickerOpen(on, quiet) {
    if (on) pastesOpen(false, true);
    if (!on && !S.el.ep.classList.contains('on')) return;
    S.el.ep.classList.toggle('on', on);
    S.el.emb.setAttribute('aria-expanded', String(on));
    if (on) { if (!recent().length && S.ptab === 'recent' && EM_SETS[0]) S.ptab = EM_SETS[0].id; pickerTabs(); pickerRender(); S.el.eq.focus(); }
    else if (!quiet && !S.el.inp.disabled) S.el.inp.focus();
    if (S.stick) toBottom();
  }

  function pickerTabs() {
    if (!S.el.etabs) return;
    const tabs = [{ id: 'recent', name: 'Недавние' }, ...EM_SETS.map((s) => ({ id: s.id, name: `${s.name} ${s.list.length}` }))];
    S.el.etabs.innerHTML = tabs.map((t) => `<button type="button" role="tab" data-t="${t.id}" aria-selected="${t.id === S.ptab}">${esc(t.name)}</button>`).join('');
  }

  function pickerRender() {
    if (!S.el.eg || !S.el.ep.classList.contains('on')) return;
    const q = S.el.eq.value.trim().toLowerCase();
    let codes;
    if (q) {   // поиск — по всем наборам; сначала начинающиеся с запроса
      const all = [...EM.keys()].filter((n) => n.toLowerCase().includes(q));
      codes = [...all.filter((n) => n.toLowerCase().startsWith(q)), ...all.filter((n) => !n.toLowerCase().startsWith(q))];
    } else if (S.ptab === 'recent') codes = recent().filter((n) => EM.has(n));
    else codes = (EM_SETS.find((s) => s.id === S.ptab) || { list: [] }).list;
    if (!codes.length) {
      S.el.eg.innerHTML = `<p>${!EM.size ? 'Загружаю стикеры…' : q ? 'Ничего не нашлось' : 'Здесь появятся стикеры, которые ты отправлял'}</p>`;
      return;
    }
    S.el.eg.innerHTML = codes.map((n) => { const e = EM.get(n);   // картинки грузятся лениво — по мере прокрутки
      return `<button type="button" data-n="${esc(n)}" title="${esc(n)}"><img src="${esc(e.u2)}" alt="${esc(n)}" loading="lazy" decoding="async"></button>`; }).join('');
    S.el.eh.textContent = q ? `Найдено: ${codes.length}` : 'Клик — вставить, Shift+клик — вставить и не закрывать';
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
      const e = EM.get(part);
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
      out.push(m ? `<span class="at">@${esc(m[1])}</span>${esc(m[2])}` : esc(part));
    }
    return out.join('');
  }

  function row(msg) {
    const li = document.createElement('li');
    li.dataset.id = msg.id;
    const text = String(msg.t || '');
    if (msg.sys) { li.className = 'sys'; li.textContent = text; return li; }
    if (msg.ev) {   // «Летопись»: событие игры
      li.className = 'ev';
      li.innerHTML = `<span class="t">${msg.at ? hhmm(msg.at) : ''}</span>📜 ${fmtText(text)}`;
      return li;
    }
    const l = String(msg.l || '').toLowerCase();
    if (S.me && l !== S.me && new RegExp(`(^|\\s)@${S.me}(\\b|$)`, 'i').test(text)) li.className = 'mention';
    const ico = msg.c ? `<span title="${esc(msg.cn || msg.c)}">${CLS_ICO[msg.c] || '◆'}</span> ` : '';
    const ri = ROLE_ICO[msg.r]; const role = ri ? `<span title="${ri[1]}">${ri[0]}</span> ` : '';
    const aw = (msg.aw || []).map((a) => `<span class="aw" title="${esc(a.n)}${a.d ? ' — ' + esc(a.d) : ''}">${esc(a.i || '✦')}</span>`).join('');
    const to = msg.k === 'dm' && msg.to ? ` <span class="to" title="Личное">→ <span class="n" data-l="${esc(String(msg.to).toLowerCase())}">${esc(msg.to)}</span></span>` : '';
    li.innerHTML = `<span class="t">${msg.at ? hhmm(msg.at) : ''}</span>${role}${ico}<span class="n" data-l="${esc(l)}" style="color:hsl(${hue(l)} var(--ns) var(--nl))" title="Ответить @${esc(l)}">${esc(msg.n || msg.l)}</span>${aw}${to}: ${fmtText(text)}`;
    return li;
  }

  function toBottom() {
    S.el.log.scrollTop = S.el.log.scrollHeight; S.stick = true; S.unseen = 0; S.el.more.style.display = 'none';
  }

  // ---------- Отправка ----------
  async function say() {
    let t = S.el.inp.value.trim(); if (!t || S.el.send.disabled) return;
    let path, body;
    if (S.room === 'mine') { path = `/api/mine/chat/say?c=${encodeURIComponent(S.mine)}`; body = { text: t }; }
    else {
      path = '/api/city/say'; body = { text: t };
      if (S.tab === 'tr') body.k = 'tr';
      if (S.tab === 'dm') {   // лично: «@ник текст»
        const m = t.match(/^@([a-z0-9_]{2,25})\s+([\s\S]+)$/i);
        if (!m) { S.el.err.textContent = 'Чтобы написать лично, начни с @ника: «@ник привет»'; return; }
        body = { text: m[2].trim(), to: m[1].toLowerCase() };
      }
    }
    S.el.send.disabled = true;
    try {
      const r = await api(path, body);
      if (r && r.ok) { S.el.inp.value = S.tab === 'dm' && body.to ? `@${body.to} ` : ''; S.el.err.textContent = ''; poll(); }
      else {
        const e = (r && r.error) || 'не отправилось';
        S.el.err.textContent = (ERR[e] || e) + (S.room === 'mine' && /шахт/i.test(e) ? ' — чтобы писать, твой герой должен быть в шахте (открой её в игре).' : '');
        if (S.room === 'city' && /не в городе/.test(e)) { S.inCity = false; cityEnter(); }
      }
    } catch { S.el.err.textContent = 'Нет связи — сообщение не ушло'; }
    finally { inputState(); if (!S.el.inp.disabled) S.el.inp.focus(); }
  }

  window.__lgMineChat = S;   // для отладки
  try { window.stop(); } catch {}
  boot();
})();
