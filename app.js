import { getToken, signOut, AuthError, getClientId, setClientId, getSilentError } from "./auth.js";
import * as api from "./api.js";

// ---------------------------------------------------------------- helpers
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const HOUR_PX = 48;
const PX_MIN = HOUR_PX / 60;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY_MS = 864e5;

const pad = (n) => String(n).padStart(2, "0");
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfWeek = (d) => addDays(startOfDay(d), -d.getDay()); // Sunday start
const today = () => startOfDay(new Date());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtTime = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtHour = (i) => new Date(2000, 0, 1, i).toLocaleTimeString([], { hour: "numeric" });

// ---------------------------------------------------------------- state
const state = {
  view: "month",
  cursor: today(),
  calendars: [],
  hidden: new Set(),
  hiddenInit: false,
  colors: null,
  events: [],
  signedIn: false,
  scrollTop: null,
  taskLists: [],
  taskBlink: new Set(), // task ids you set to blink (tasks can't store custom data, so this is kept locally)
  tasksWarned: false,
};
const SETUP_URL = "https://github.com/OceanicKr/calendar-newtab/blob/main/docs/SETUP.md";
const TASK_COLOR = "#5fe0d2";
let loadSeq = 0;

const savePrefs = () =>
  chrome.storage.local.set({
    prefs: { v: 2, view: state.view, hidden: [...state.hidden], hiddenInit: state.hiddenInit },
  });

function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function handleError(err) {
  console.error(err);
  if (err instanceof AuthError) { state.signedIn = false; renderAll(); return; }
  toast(err.message || String(err));
}

// ---------------------------------------------------------------- clock + search
function tick() {
  const now = new Date();
  $("#time").textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("#date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
tick();
setInterval(tick, 1000);

$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#q").value.trim();
  if (text) chrome.search.query({ text, disposition: "CURRENT_TAB" });
});

// ---------------------------------------------------------------- range / nav
function range() {
  const c = state.cursor;
  switch (state.view) {
    case "day": return [c, addDays(c, 1)];
    case "week": { const s = startOfWeek(c); return [s, addDays(s, 7)]; }
    case "month": { const s = startOfWeek(new Date(c.getFullYear(), c.getMonth(), 1)); return [s, addDays(s, 42)]; }
    default: return [c, addDays(c, 30)]; // agenda
  }
}

function rangeTitle() {
  const c = state.cursor;
  if (state.view === "day") return c.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (state.view === "week") {
    const [a, b] = range(); const last = addDays(b, -1);
    const sameMonth = a.getMonth() === last.getMonth();
    return sameMonth
      ? a.toLocaleDateString([], { month: "long", year: "numeric" })
      : `${a.toLocaleDateString([], { month: "short" })} – ${last.toLocaleDateString([], { month: "short", year: "numeric" })}`;
  }
  if (state.view === "month") return c.toLocaleDateString([], { month: "long", year: "numeric" });
  return `From ${c.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function nav(dir) {
  const c = state.cursor;
  if (state.view === "day") state.cursor = addDays(c, dir);
  else if (state.view === "week") state.cursor = addDays(c, 7 * dir);
  else if (state.view === "month") state.cursor = new Date(c.getFullYear(), c.getMonth() + dir, 1);
  else state.cursor = addDays(c, 30 * dir);
  state.scrollTop = null;
  load();
}

function setView(v) {
  state.view = v;
  state.scrollTop = null;
  savePrefs();
  load();
}

// ---------------------------------------------------------------- data
function normalize(e, cal) {
  const allDay = !!e.start.date;
  const start = allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime);
  const end = allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime);
  const ec = e.colorId && state.colors?.event?.[e.colorId];
  return Object.assign(e, {
    _cal: cal,
    _allDay: allDay,
    _start: start,
    _end: end,
    _color: ec?.background || cal.backgroundColor || "#8ab4f8",
    _fg: ec?.foreground || cal.foregroundColor || "#000",
    _editable: ["owner", "writer"].includes(cal.accessRole) && (!e.eventType || e.eventType === "default"),
  });
}

function normalizeTask(t, list) {
  const d = parseYmd(t.due.slice(0, 10)); // due is a date stored as midnight UTC
  return Object.assign(t, {
    _task: true,
    _list: list,
    _allDay: true,
    _start: d,
    _end: addDays(d, 1),
    _color: TASK_COLOR,
    _fg: "#04201e",
    _editable: true,
    _done: t.status === "completed",
    summary: t.title || "",
  });
}

function warnTasks(err) {
  console.warn("Tasks:", err);
  if (state.tasksWarned) return;
  state.tasksWarned = true;
  toast(`Couldn't load Google Tasks (${err.message || err}). Is the Tasks API enabled in Google Cloud?`, 9000);
}

async function load() {
  renderChrome();
  if (!state.signedIn) return;
  const seq = ++loadSeq;
  const [a, b] = range();
  $("#spinner").hidden = false;
  try {
    const cals = state.calendars.filter((c) => !state.hidden.has(c.id));
    const tlists = state.taskLists.filter((l) => !state.hidden.has("tasks:" + l.id));
    const [lists, tasks] = await Promise.all([
      Promise.all(
        cals.map((c) =>
          api.listEvents(c.id, a, b)
            .then((items) => items.filter((e) => e.status !== "cancelled").map((e) => normalize(e, c)))
            .catch((err) => { if (err instanceof AuthError) throw err; console.warn(c.summary, err); return []; })
        )
      ),
      Promise.all(
        tlists.map((l) =>
          api.listTasks(l.id, addDays(a, -1), addDays(b, 1))
            .then((ts) => ts.filter((t) => t.due && !t.deleted).map((t) => normalizeTask(t, l)))
            .catch((err) => { if (err instanceof AuthError) throw err; warnTasks(err); return []; })
        )
      ),
    ]);
    if (seq !== loadSeq) return; // a newer load started
    state.events = [...lists.flat(), ...tasks.flat()];
    renderView();
  } catch (err) {
    handleError(err);
  } finally {
    if (seq === loadSeq) $("#spinner").hidden = true;
  }
}

async function bootstrap() {
  const [cals, colors, taskLists] = await Promise.all([
    api.listCalendars(),
    api.getColors(),
    api.listTaskLists().catch((err) => { if (err instanceof AuthError) throw err; warnTasks(err); return []; }),
  ]);
  state.colors = colors;
  state.taskLists = taskLists;
  state.calendars = cals.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  if (!state.hiddenInit) {
    state.hidden = new Set(cals.filter((c) => c.selected === false).map((c) => c.id));
    state.hiddenInit = true;
    savePrefs();
  }
  renderAll();
}

function eventsOnDay(d) {
  const e1 = addDays(d, 1);
  return state.events
    .filter((e) => e._start < e1 && e._end > d)
    .sort((a, b) => (b._allDay - a._allDay) || (a._start - b._start));
}

const writableCals = () => state.calendars.filter((c) => ["owner", "writer"].includes(c.accessRole));
const primaryCal = () => state.calendars.find((c) => c.primary) || writableCals()[0];

// ---------------------------------------------------------------- render
function renderAll() {
  renderChrome();
  renderSidebar();
  if (state.signedIn) load(); else renderView();
}

function renderChrome() {
  $("#side").hidden = !state.signedIn;
  $("#toolbar").hidden = !state.signedIn;
  $("#rangeTitle").textContent = rangeTitle();
  document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
}

function renderSidebar() {
  const list = $("#calList");
  list.replaceChildren(
    ...state.calendars.map((c) =>
      h("label", { class: "calrow", style: `--c:${c.backgroundColor}`, title: c.summaryOverride || c.summary },
        h("input", {
          type: "checkbox",
          checked: !state.hidden.has(c.id),
          onchange: (ev) => {
            if (ev.target.checked) state.hidden.delete(c.id); else state.hidden.add(c.id);
            savePrefs();
            load();
          },
        }),
        h("span", {}, c.summaryOverride || c.summary)
      )
    )
  );
  $("#taskTitle").hidden = !state.taskLists.length;
  $("#taskListList").replaceChildren(
    ...state.taskLists.map((l) =>
      h("label", { class: "calrow", style: `--c:${TASK_COLOR}`, title: l.title },
        h("input", {
          type: "checkbox",
          checked: !state.hidden.has("tasks:" + l.id),
          onchange: (ev) => {
            const key = "tasks:" + l.id;
            if (ev.target.checked) state.hidden.delete(key); else state.hidden.add(key);
            savePrefs();
            load();
          },
        }),
        h("span", {}, l.title)
      )
    )
  );
}

function renderView() {
  const view = $("#view");
  if (!state.signedIn) {
    view.replaceChildren(
      h("div", { class: "connect" },
        h("h3", {}, "Connect your Google Calendar"),
        h("p", {}, "One-time setup, about 5 minutes. ",
          h("a", { href: SETUP_URL, target: "_blank" }, "Step-by-step guide")),
        h("ol", { class: "steps" },
          h("li", {},
            h("div", {}, "In Google Cloud, create an OAuth client (type ", h("b", {}, "Web application"), ") and add this as an authorized redirect URI:"),
            h("div", { class: "copyrow" },
              h("code", { id: "redir" }, chrome.identity.getRedirectURL()),
              h("button", {
                class: "copy", type: "button",
                onclick: async (ev) => {
                  await navigator.clipboard.writeText(chrome.identity.getRedirectURL());
                  ev.target.textContent = "Copied";
                },
              }, "Copy"))),
          h("li", {},
            h("div", {}, "Paste the client ID it gives you:"),
            h("input", { id: "clientIdInput", class: "cid", placeholder: "1234567890-abc...apps.googleusercontent.com", spellcheck: "false", autocomplete: "off" })),
          h("li", {}, h("div", {}, "Connect and pick your Google account."))),
        h("button", { onclick: connect }, "Connect Google Calendar"),
        h("div", { id: "authErr", class: "diag err" }))
    );
    getClientId().then((id) => { const el = $("#clientIdInput"); if (el && !el.value) el.value = id; });
    getSilentError().then((e) => {
      const box = $("#authErr");
      if (e && box && !box.textContent) box.textContent = `Automatic sign-in failed ${new Date(e.at).toLocaleString()}: ${e.reason}`;
    });
    return;
  }
  const oldBody = $(".tg-body");
  if (oldBody && state.scrollTop != null) state.scrollTop = oldBody.scrollTop;

  if (state.view === "day") view.replaceChildren(renderTimeGrid([state.cursor]));
  else if (state.view === "week") { const [a] = range(); view.replaceChildren(renderTimeGrid([...Array(7)].map((_, i) => addDays(a, i)))); }
  else if (state.view === "month") view.replaceChildren(renderMonth());
  else view.replaceChildren(renderAgenda());

  const body = $(".tg-body");
  if (body) body.scrollTop = body._scroll; // must run after it's in the DOM
}


// ---------------------------------------------------------------- blink
// You choose what blinks: tick "Blink in yellow" in the editor, or right-click an
// event. The choice is stored on the Google event itself, so it follows you.
const isBlink = (e) => (e._task ? state.taskBlink.has(e.id) : e.extendedProperties?.private?.blink === "1");
const saveTaskBlink = () => chrome.storage.local.set({ taskBlink: [...state.taskBlink] });
const blinkCls = (e) => (isBlink(e) ? " blink" : "");

async function toggleBlink(e) {
  if (e._task) {
    const on = !isBlink(e);
    if (on) state.taskBlink.add(e.id); else state.taskBlink.delete(e.id);
    saveTaskBlink();
    renderView();
    toast(on ? `"${e.summary || "(No title)"}" will blink` : "Blink turned off");
    return;
  }
  if (!e._editable) { toast("This event is read-only, so it can't be set to blink."); return; }
  const on = !isBlink(e);
  e.extendedProperties = { ...(e.extendedProperties || {}), private: { ...(e.extendedProperties?.private || {}), blink: on ? "1" : "0" } };
  renderView(); // instant feedback
  try {
    await api.patchEvent(e._cal.id, e.id, { extendedProperties: { private: { blink: on ? "1" : "0" } } });
    toast(on ? `"${e.summary || "(No title)"}" will blink` : "Blink turned off");
  } catch (err) {
    handleError(err);
    load();
  }
}
const onRightClick = (e) => (ev) => { ev.preventDefault(); ev.stopPropagation(); toggleBlink(e); };

// ---------------------------------------------------------------- tasks
const taskCheck = (e) =>
  h("span", {
    class: "tcheck", title: e._done ? "Mark as not done" : "Mark as done",
    onclick: (ev) => { ev.stopPropagation(); toggleDone(e); },
  }, e._done ? "\u2713" : "");

async function toggleDone(e) {
  const done = !e._done;
  e._done = done;
  e.status = done ? "completed" : "needsAction";
  renderView();
  try {
    await api.patchTask(e._list.id, e.id, done ? { status: "completed" } : { status: "needsAction", completed: null });
    toast(done ? "Task completed" : "Task reopened");
  } catch (err) {
    handleError(err);
    load();
  }
}

function chip(e) {
  const label = e.summary || "(No title)";
  if (e._task) {
    return h("div", {
      class: "chip task" + (e._done ? " done" : "") + blinkCls(e), title: `Task: ${label}`, oncontextmenu: onRightClick(e),
      onclick: (ev) => { ev.stopPropagation(); openTaskEditor(e); },
    }, taskCheck(e), h("span", { class: "tlabel" }, label));
  }
  if (e._allDay) {
    return h("div", {
      class: "chip" + blinkCls(e), style: `background:${e._color};color:${e._fg}`, title: label, oncontextmenu: onRightClick(e),
      onclick: (ev) => { ev.stopPropagation(); openEditor(e); },
    }, label);
  }
  return h("div", {
    class: "chip timed" + blinkCls(e), title: `${fmtTime(e._start)} ${label}`, oncontextmenu: onRightClick(e),
    onclick: (ev) => { ev.stopPropagation(); openEditor(e); },
  }, h("span", { class: "dot", style: `background:${e._color}` }), `${fmtTime(e._start)} ${label}`);
}

// --- day / week
function renderTimeGrid(days) {
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;
  const now = new Date();

  const head = h("div", { class: "tg-head", style: `grid-template-columns:${cols}` }, h("div"),
    days.map((d) => h("div", {
      class: "tg-dayhead" + (sameDay(d, now) ? " today" : ""),
      onclick: () => { state.cursor = d; setView("day"); },
    }, h("span", { class: "dow" }, d.toLocaleDateString([], { weekday: "short" })), h("span", { class: "dnum" }, d.getDate()))));

  const allday = h("div", { class: "tg-allday", style: `grid-template-columns:${cols}` },
    h("div", { class: "gutter-label" }, "all-day"),
    days.map((d) => {
      const cell = h("div", { class: "ad-cell", onclick: (ev) => { if (ev.target === cell) openEditor(null, { start: d, allDay: true }); } });
      eventsOnDay(d).filter((e) => e._allDay).forEach((e) => cell.append(chip(e)));
      return cell;
    }));

  const inner = h("div", { class: "tg-inner", style: `grid-template-columns:${cols};height:${24 * HOUR_PX}px` });
  const gutter = h("div", { class: "tg-gutter" });
  for (let i = 1; i < 24; i++) gutter.append(h("div", { class: "hour-label", style: `top:${i * HOUR_PX}px` }, fmtHour(i)));
  inner.append(gutter);

  for (const d of days) {
    const col = h("div", { class: "tg-col" + (sameDay(d, now) ? " today" : "") });
    col.addEventListener("click", (ev) => {
      if (ev.target !== col) return;
      const min = Math.floor(ev.offsetY / PX_MIN / 30) * 30;
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, min);
      openEditor(null, { start: s, end: new Date(s.getTime() + 3600e3) });
    });
    for (const it of layoutDay(d)) col.append(eventBlock(it));
    if (sameDay(d, now)) {
      col.append(h("div", { class: "now-line", style: `top:${(now.getHours() * 60 + now.getMinutes()) * PX_MIN}px` }));
    }
    inner.append(col);
  }

  const body = h("div", { class: "tg-body", onscroll: () => (state.scrollTop = body.scrollTop) }, inner);
  body._scroll = state.scrollTop ?? Math.max(0, (days.some((d) => sameDay(d, now)) ? now.getHours() - 2 : 7) * HOUR_PX);
  return h("div", { class: "tg" }, head, allday, body);
}

// Side-by-side layout for overlapping timed events in one day column.
function layoutDay(d) {
  const ds = d.getTime(), de = addDays(d, 1).getTime();
  const items = state.events
    .filter((e) => !e._allDay && e._start < de && e._end > ds)
    .map((e) => ({ e, s: Math.max(e._start, ds), en: Math.min(e._end, de) }))
    .sort((a, b) => a.s - b.s || b.en - a.en);

  const out = [];
  let cluster = [], colEnds = [], clusterEnd = 0;
  const flush = () => { for (const it of cluster) { it.n = colEnds.length; out.push(it); } cluster = []; colEnds = []; clusterEnd = 0; };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush();
    let c = colEnds.findIndex((end) => end <= it.s);
    if (c < 0) { c = colEnds.length; colEnds.push(0); }
    colEnds[c] = it.en;
    it.col = c;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.en);
  }
  flush();

  return out.map((it) => ({
    e: it.e,
    top: ((it.s - ds) / 6e4) * PX_MIN,
    height: Math.max(15, (it.en - it.s) / 6e4) * PX_MIN - 2,
    left: (it.col / it.n) * 100,
    width: 100 / it.n,
  }));
}

function eventBlock({ e, top, height, left, width }) {
  const el = h("div", {
    class: "ev" + blinkCls(e),
    oncontextmenu: onRightClick(e),
    title: `${e.summary || "(No title)"}\n${fmtTime(e._start)} – ${fmtTime(e._end)}${e.location ? "\n" + e.location : ""}`,
    style: `top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${width}% - 4px);background:${e._color};color:${e._fg}`,
  },
    h("div", { class: "ev-title" }, e.summary || "(No title)"),
    height > 30 ? h("div", { class: "ev-time" }, `${fmtTime(e._start)} – ${fmtTime(e._end)}`) : null);
  attachDrag(el, e);
  return el;
}

// Drag an event to another time/day (15-minute snapping). A plain click opens it.
function attachDrag(el, e) {
  el.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    const cols = [...document.querySelectorAll(".tg-col")];
    const startCol = cols.findIndex((c) => c.contains(el));
    let dragging = false, dayShift = 0, minShift = 0;

    const move = (mv) => {
      const dx = mv.clientX - down.clientX, dy = mv.clientY - down.clientY;
      if (!dragging) {
        if (!e._editable || Math.hypot(dx, dy) < 5) return;
        dragging = true;
        el.classList.add("dragging");
      }
      minShift = Math.round(dy / PX_MIN / 15) * 15;
      const t = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return mv.clientX >= r.left && mv.clientX < r.right; });
      if (t >= 0) dayShift = t - startCol;
      const colW = cols[0].getBoundingClientRect().width;
      el.style.transform = `translate(${dayShift * colW}px, ${minShift * PX_MIN}px)`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!dragging) { openEditor(e); return; }
      if (!dayShift && !minShift) { el.style.transform = ""; el.classList.remove("dragging"); return; }
      const shift = dayShift * DAY_MS + minShift * 6e4;
      saveTimes(e, new Date(e._start.getTime() + shift), new Date(e._end.getTime() + shift));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

async function saveTimes(e, start, end) {
  const oldStart = e._start, oldEnd = e._end;
  e._start = start; e._end = end; // optimistic
  renderView();
  try {
    await api.patchEvent(e._cal.id, e.id, {
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
    });
    toast(`Moved "${e.summary || "(No title)"}"`);
  } catch (err) {
    e._start = oldStart; e._end = oldEnd;
    handleError(err);
  }
  load();
}

// --- month
function renderMonth() {
  const [a] = range();
  const m = state.cursor.getMonth();
  const now = new Date();
  const grid = h("div", { class: "month" });
  for (let i = 0; i < 7; i++) grid.append(h("div", { class: "mdow" }, addDays(a, i).toLocaleDateString([], { weekday: "short" })));

  for (let i = 0; i < 42; i++) {
    const d = addDays(a, i);
    const evs = eventsOnDay(d);
    const cell = h("div", {
      class: "mcell" + (d.getMonth() !== m ? " other" : "") + (sameDay(d, now) ? " today" : ""),
      onclick: (ev) => { if (ev.target === cell) openEditor(null, { start: d, allDay: true }); },
    });
    cell.append(h("div", { class: "mnum", onclick: () => { state.cursor = d; setView("day"); } }, d.getDate()));
    // How many chip rows fit in a cell (cell = 1/6 of the grid minus gaps, minus the date number).
    const cellH = ($("#view").clientHeight - 40) / 6 - 6;
    const fits = Math.max(1, Math.floor((cellH - 38) / 21));
    const shown = evs.length > fits ? Math.max(0, fits - 1) : evs.length; // leave a row for "+N more"
    evs.slice(0, shown).forEach((e) => cell.append(chip(e)));
    if (evs.length > shown) {
      cell.append(h("div", { class: "more", onclick: () => { state.cursor = d; setView("day"); } }, `+${evs.length - shown} more`));
    }
    grid.append(cell);
  }
  return grid;
}

// --- schedule
function renderAgenda() {
  const [a, b] = range();
  const now = new Date();
  const list = h("div", { class: "agenda" });
  for (let d = a; d < b; d = addDays(d, 1)) {
    const evs = eventsOnDay(d);
    if (!evs.length) continue;
    list.append(h("div", { class: "ag-day" + (sameDay(d, now) ? " today" : "") },
      h("div", { class: "ag-date" },
        h("span", { class: "dnum" }, d.getDate()),
        h("span", {}, d.toLocaleDateString([], { month: "short", weekday: "short" }))),
      h("div", { class: "ag-items" },
        evs.map((e) => h("div", { class: "ag-item" + (e._task ? " is-task" : "") + blinkCls(e), onclick: () => openEditor(e), oncontextmenu: onRightClick(e) },
          e._task ? taskCheck(e) : h("span", { class: "dot", style: `background:${e._color}` }),
          h("span", { class: "ag-time" }, e._task ? (e._done ? "Task \u00b7 done" : "Task") : e._allDay ? "All day" : `${fmtTime(e._start)} – ${fmtTime(e._end)}`),
          h("span", { class: e._task && e._done ? "tdone" : "" }, e.summary || "(No title)"))))));
  }
  if (!list.children.length) list.append(h("div", { class: "empty" }, "Nothing scheduled in the next 30 days."));
  return list;
}

// ---------------------------------------------------------------- editor
const dlg = $("#editor");
const form = $("#evform");
let editing = null;

function syncAllDay() {
  const allDay = form.allDay.checked;
  form.st.hidden = allDay;
  form.et.hidden = allDay;
}
form.allDay.addEventListener("change", syncAllDay);

// Keep end after start when the start changes (like Google Calendar does).
let lastStart = null;
const formStart = () => form.allDay.checked ? parseYmd(form.sd.value) : new Date(`${form.sd.value}T${form.st.value || "00:00"}`);
const formEnd = () => form.allDay.checked ? parseYmd(form.ed.value) : new Date(`${form.ed.value}T${form.et.value || "00:00"}`);
function onStartChange() {
  if (!form.sd.value) return;
  const s = formStart();
  if (lastStart && form.ed.value) {
    const e = new Date(formEnd().getTime() + (s - lastStart));
    form.ed.value = ymd(e);
    if (!form.allDay.checked) form.et.value = hm(e);
  }
  lastStart = s;
}
form.sd.addEventListener("change", onStartChange);
form.st.addEventListener("change", onStartChange);

function openEditor(e, defaults = {}) {
  if (e?._task) return openTaskEditor(e);
  editing = e;
  const cals = writableCals();
  const readOnly = e && !e._editable;
  const calOpts = e && !cals.includes(e._cal) ? [e._cal, ...cals] : cals;
  form.cal.replaceChildren(...calOpts.map((c) => h("option", { value: c.id }, c.summaryOverride || c.summary)));

  let start, end, allDay;
  if (e) {
    start = e._start; allDay = e._allDay;
    end = allDay ? addDays(e._end, -1) : e._end;
    form.summary.value = e.summary || "";
    form.location.value = e.location || "";
    form.description.value = e.description || "";
    form.blink.checked = isBlink(e);
    form.cal.value = e._cal.id;
  } else {
    allDay = !!defaults.allDay;
    start = defaults.start || new Date();
    end = defaults.end || (allDay ? start : new Date(start.getTime() + 3600e3));
    form.summary.value = form.location.value = form.description.value = "";
    form.blink.checked = false;
    form.cal.value = primaryCal()?.id;
  }
  form.allDay.checked = allDay;
  form.sd.value = ymd(start); form.st.value = hm(start);
  form.ed.value = ymd(end); form.et.value = hm(end);
  lastStart = formStart();
  syncAllDay();

  for (const el of form.elements) if (el.name) el.disabled = !!readOnly;
  $("#saveBtn").hidden = !!readOnly;
  $("#delBtn").hidden = !e || readOnly;
  $("#edLink").hidden = !e?.htmlLink;
  if (e?.htmlLink) $("#edLink").href = e.htmlLink;
  $("#edNote").textContent =
    readOnly ? "You can't edit this event here (read-only calendar or special event type)." :
    e?.recurringEventId ? "Repeating event: changes apply to this occurrence only." : "";

  dlg.showModal();
  if (!readOnly) form.summary.focus();
}

$("#cancelBtn").addEventListener("click", () => dlg.close());
dlg.addEventListener("click", (ev) => { // click on the backdrop closes
  const r = dlg.getBoundingClientRect();
  if (ev.target === dlg && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) dlg.close();
});

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const allDay = form.allDay.checked;
  const s = formStart(), en = formEnd();
  if (allDay ? en < s : en <= s) { toast("End must be after start"); return; }

  const body = {
    summary: form.summary.value.trim() || "(No title)",
    location: form.location.value.trim(),
    description: form.description.value,
    extendedProperties: { private: { blink: form.blink.checked ? "1" : "0" } },
    start: allDay ? { date: ymd(s), dateTime: null, timeZone: null } : { dateTime: s.toISOString(), timeZone: TZ, date: null },
    end: allDay ? { date: ymd(addDays(en, 1)), dateTime: null, timeZone: null } : { dateTime: en.toISOString(), timeZone: TZ, date: null },
  };
  const calId = form.cal.value;
  $("#saveBtn").disabled = true;
  try {
    if (editing) {
      await api.patchEvent(editing._cal.id, editing.id, body);
      if (calId !== editing._cal.id) await api.moveEvent(editing._cal.id, editing.id, calId);
      toast("Event updated");
    } else {
      for (const t of [body.start, body.end]) for (const k of Object.keys(t)) if (t[k] === null) delete t[k];
      await api.createEvent(calId, body);
      toast("Event created");
    }
    dlg.close();
    load();
  } catch (err) {
    handleError(err);
  } finally {
    $("#saveBtn").disabled = false;
  }
});

$("#delBtn").addEventListener("click", async () => {
  if (!editing || !confirm(`Delete "${editing.summary || "(No title)"}"?`)) return;
  try {
    await api.deleteEvent(editing._cal.id, editing.id);
    dlg.close();
    toast("Event deleted");
    load();
  } catch (err) {
    handleError(err);
  }
});

// ---------------------------------------------------------------- task editor
const tdlg = $("#taskEditor");
const tform = $("#taskform");
let tEditing = null;

function openTaskEditor(t, defaults = {}) {
  if (!state.taskLists.length) {
    toast("No Google Tasks lists found. Enable the Tasks API in Google Cloud, then reconnect.", 7000);
    return;
  }
  tEditing = t || null;
  tform.list.replaceChildren(...state.taskLists.map((l) => h("option", { value: l.id }, l.title)));
  if (t) {
    tform.title.value = t.title || "";
    tform.due.value = ymd(t._start);
    tform.notes.value = t.notes || "";
    tform.done.checked = t._done;
    tform.blink.checked = isBlink(t);
    tform.list.value = t._list.id;
  } else {
    tform.title.value = tform.notes.value = "";
    tform.due.value = ymd(defaults.date || today());
    tform.done.checked = tform.blink.checked = false;
    tform.list.value = state.taskLists[0].id;
  }
  $("#tDelBtn").hidden = !t;
  tdlg.showModal();
  tform.title.focus();
}

$("#tCancelBtn").addEventListener("click", () => tdlg.close());
tdlg.addEventListener("click", (ev) => {
  const r = tdlg.getBoundingClientRect();
  if (ev.target === tdlg && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom)) tdlg.close();
});

tform.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const body = {
    title: tform.title.value.trim() || "(No title)",
    notes: tform.notes.value,
    due: `${tform.due.value}T00:00:00.000Z`,
    status: tform.done.checked ? "completed" : "needsAction",
  };
  const listId = tform.list.value;
  $("#tSaveBtn").disabled = true;
  try {
    let id;
    if (tEditing) {
      id = tEditing.id;
      if (!tform.done.checked) body.completed = null;
      await api.patchTask(tEditing._list.id, id, body);
      if (listId !== tEditing._list.id) await api.moveTask(tEditing._list.id, id, listId);
      toast("Task updated");
    } else {
      id = (await api.createTask(listId, body)).id;
      toast("Task added");
    }
    if (tform.blink.checked) state.taskBlink.add(id); else state.taskBlink.delete(id);
    saveTaskBlink();
    tdlg.close();
    load();
  } catch (err) {
    handleError(err);
  } finally {
    $("#tSaveBtn").disabled = false;
  }
});

$("#tDelBtn").addEventListener("click", async () => {
  if (!tEditing || !confirm(`Delete task "${tEditing.title || "(No title)"}"?`)) return;
  try {
    await api.deleteTask(tEditing._list.id, tEditing.id);
    state.taskBlink.delete(tEditing.id);
    saveTaskBlink();
    tdlg.close();
    toast("Task deleted");
    load();
  } catch (err) {
    handleError(err);
  }
});

$("#createTaskBtn").addEventListener("click", () => openTaskEditor(null, { date: today() }));

// ---------------------------------------------------------------- toolbar + keys
$("#views").addEventListener("click", (e) => { const v = e.target.dataset?.view; if (v) setView(v); });
$("#todayBtn").addEventListener("click", () => { state.cursor = today(); state.scrollTop = null; load(); });
$("#prevBtn").addEventListener("click", () => nav(-1));
$("#nextBtn").addEventListener("click", () => nav(1));
$("#refreshBtn").addEventListener("click", () => load());
$("#createBtn").addEventListener("click", () => {
  const s = new Date(); s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0);
  openEditor(null, { start: s });
});
$("#signOutBtn").addEventListener("click", async () => {
  await signOut();
  state.signedIn = false;
  state.events = [];
  state.calendars = [];
  state.taskLists = [];
  renderAll();
});

document.addEventListener("keydown", (e) => {
  if (dlg.open || tdlg.open || e.ctrlKey || e.metaKey || e.altKey || !state.signedIn) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
  const k = e.key;
  if (k === "t") { state.cursor = today(); state.scrollTop = null; load(); }
  else if (k === "d") setView("day");
  else if (k === "w") setView("week");
  else if (k === "m") setView("month");
  else if (k === "a") setView("agenda");
  else if (k === "ArrowLeft" || k === "j") nav(-1);
  else if (k === "ArrowRight" || k === "k") nav(1);
  else if (k === "c") { e.preventDefault(); $("#createBtn").click(); }
  else if (k === "n") { e.preventDefault(); $("#createTaskBtn").click(); }
});

// ---------------------------------------------------------------- auth + boot
async function connect() {
  try {
    const typed = $("#clientIdInput")?.value.trim() || "";
    if (!typed.endsWith(".apps.googleusercontent.com")) {
      throw new Error("That doesn't look like a client ID. It should end in .apps.googleusercontent.com");
    }
    if (typed !== (await getClientId())) await setClientId(typed);
    await getToken({ interactive: true });
    state.signedIn = true;
    await bootstrap();
  } catch (err) {
    console.error(err);
    const msg = err.message || String(err);
    toast("Sign-in failed: " + msg, 6000);
    const box = $("#authErr");
    if (box) box.textContent = "Last error: " + msg;
  }
}

(async () => {
  const { prefs, taskBlink } = await chrome.storage.local.get(["prefs", "taskBlink"]);
  state.taskBlink = new Set(taskBlink || []);
  if (prefs) {
    if (prefs.v === 2) state.view = prefs.view || state.view; // older saves -> start in month view
    state.hidden = new Set(prefs.hidden || []);
    state.hiddenInit = !!prefs.hiddenInit;
  }
  renderChrome();
  try {
    state.signedIn = !!(await getToken()); // silent
    if (state.signedIn) await bootstrap();
    else renderAll();
  } catch (err) {
    // Never leave the page blank: show the Connect button plus the error.
    console.error(err);
    state.signedIn = false;
    renderAll();
    if (!(err instanceof AuthError)) toast("Startup error: " + (err.message || err), 8000);
  }
})();

// Keep it fresh: refetch every 5 min and whenever the tab becomes visible again.
setInterval(() => { if (!dlg.open && !tdlg.open && !document.querySelector(".ev.dragging")) load(); }, 5 * 60e3);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.signedIn && !dlg.open) load();
});

// Re-fit month chips when the window size changes.
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.signedIn && state.view === "month") renderView(); }, 150);
});
