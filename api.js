// Thin wrapper over Google Calendar API v3.
import { getToken, clearToken, AuthError } from "./auth.js";

const BASE = "https://www.googleapis.com/calendar/v3";

async function call(path, { method = "GET", body, query } = {}) {
  const url = new URL(path.startsWith("https://") ? path : BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    if (!token) throw new AuthError("Not signed in");
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) { await clearToken(); continue; }
    if (res.status === 401) throw new AuthError("Session expired");
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error?.message || msg; } catch {}
      throw new Error(`${res.status}: ${msg}`);
    }
    return res.status === 204 ? null : res.json();
  }
}

const cal = (id) => `/calendars/${encodeURIComponent(id)}`;

export async function listCalendars() {
  const r = await call("/users/me/calendarList", { query: { minAccessRole: "reader" } });
  return r.items || [];
}

export function getColors() {
  return call("/colors");
}

export async function listEvents(calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken;
  do {
    const r = await call(`${cal(calendarId)}/events`, {
      query: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "2500",
        pageToken,
      },
    });
    items.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return items;
}

export const createEvent = (calendarId, body) =>
  call(`${cal(calendarId)}/events`, { method: "POST", body });

export const patchEvent = (calendarId, eventId, body) =>
  call(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body });

export const deleteEvent = (calendarId, eventId) =>
  call(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });

export const moveEvent = (calendarId, eventId, destination) =>
  call(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}/move`, {
    method: "POST",
    query: { destination },
  });

// ---------------------------------------------------------------- Google Tasks
const TASKS = "https://tasks.googleapis.com/tasks/v1";
const tl = (id) => `${TASKS}/lists/${encodeURIComponent(id)}/tasks`;

export async function listTaskLists() {
  const r = await call(`${TASKS}/users/@me/lists`, { query: { maxResults: "100" } });
  return r.items || [];
}

// Tasks only have a due *date*; Google stores it as midnight UTC.
export async function listTasks(listId, dueMin, dueMax) {
  const items = [];
  let pageToken;
  do {
    const r = await call(tl(listId), {
      query: {
        dueMin: dueMin.toISOString(),
        dueMax: dueMax.toISOString(),
        showCompleted: "true",
        showHidden: "true",
        maxResults: "100",
        pageToken,
      },
    });
    items.push(...(r.items || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return items;
}

export const createTask = (listId, body) => call(tl(listId), { method: "POST", body });
export const patchTask = (listId, id, body) => call(`${tl(listId)}/${encodeURIComponent(id)}`, { method: "PATCH", body });
export const deleteTask = (listId, id) => call(`${tl(listId)}/${encodeURIComponent(id)}`, { method: "DELETE" });
export const moveTask = (listId, id, destinationTasklist) =>
  call(`${tl(listId)}/${encodeURIComponent(id)}/move`, { method: "POST", query: { destinationTasklist } });
