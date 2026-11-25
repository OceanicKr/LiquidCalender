// Issue Watcher panel: the newest open issues across a list of GitHub repos.
// One Search API request per refresh, no login or token needed. Pairs nicely
// with https://github.com/OceanicKr/issue-watcher, which pings you on Telegram
// for the same repos when you're away from the browser.

const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// Starter list (a bunch of robotics projects). Change it from the gear icon.
const DEFAULT_REPOS = [
  "ros2/rviz", "ros-navigation/navigation2", "gazebosim/gz-sim", "ros-controls/ros2_control",
  "ros-controls/ros2_controllers", "ArduPilot/ardupilot", "JdeRobot/RoboticsAcademy", "ros2/rclcpp",
  "google-deepmind/mujoco", "RobotLocomotion/drake", "huggingface/lerobot", "isaac-sim/IsaacLab",
  "moveit/moveit2", "PX4/PX4-Autopilot",
];
const REFRESH_MS = 2 * 60e3;

const st = {
  repos: DEFAULT_REPOS,
  labels: "",          // optional, like LABELS_ANY
  collapsed: false,
  prevSeen: 0,         // issues newer than this get a NEW badge on this page
  items: [],
};

const save = () => chrome.storage.local.set({
  issuePrefs: { repos: st.repos, labels: st.labels, collapsed: st.collapsed },
});

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function buildQuery() {
  const parts = ["is:issue", "is:open", ...st.repos.map((r) => `repo:${r}`)];
  const labels = st.labels.split(",").map((l) => l.trim()).filter(Boolean);
  if (labels.length) parts.push(`label:${labels.map((l) => `"${l}"`).join(",")}`); // comma = any of
  return parts.join(" ");
}

let inflight = false;
async function refresh() {
  if (inflight || st.collapsed || !st.repos.length) return;
  inflight = true;
  $("#isRefresh").classList.add("spin");
  try {
    const url = new URL("https://api.github.com/search/issues");
    url.search = new URLSearchParams({ q: buildQuery(), sort: "created", order: "desc", per_page: "40" });
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      status(`GitHub rate limit hit, retrying ${reset ? "after " + new Date(reset).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "soon"}.`);
      return;
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).errors?.[0]?.message || msg; } catch {}
      status(`GitHub error ${res.status}: ${msg}`);
      return;
    }
    const data = await res.json();
    st.items = (data.items || []).filter((i) => i.user?.type !== "Bot");
    status("");
    render();
  } catch (err) {
    status(`Couldn't reach GitHub (${err.message}).`);
  } finally {
    inflight = false;
    $("#isRefresh").classList.remove("spin");
  }
}

function status(msg) {
  $("#isStatus").textContent = msg;
}

const repoOf = (i) => i.repository_url.split("/repos/")[1];

function render() {
  const list = $("#isList");
  if (!st.items.length) {
    list.replaceChildren(h("div", { class: "is-empty" }, "No open issues found for these repos."));
    $("#isNew").hidden = true;
    return;
  }
  let fresh = 0;
  list.replaceChildren(...st.items.map((i) => {
    const isNew = new Date(i.created_at).getTime() > st.prevSeen;
    if (isNew) fresh++;
    return h("a", { class: "is-item" + (isNew ? " new" : ""), href: i.html_url, target: "_blank", title: i.title },
      h("div", { class: "is-top" },
        h("span", { class: "is-repo" }, repoOf(i)),
        isNew ? h("span", { class: "is-badge" }, "NEW") : null,
        h("span", { class: "is-time" }, ago(i.created_at))),
      h("div", { class: "is-name" }, h("span", { class: "is-num" }, `#${i.number} `), i.title),
      h("div", { class: "is-meta" },
        h("span", {}, `@${i.user?.login || "?"}`),
        i.comments ? h("span", {}, `\u{1F4AC} ${i.comments}`) : null,
        ...(i.labels || []).slice(0, 3).map((l) =>
          h("span", { class: "is-label", style: `--lc:#${l.color || "888"}` }, l.name))));
  }));
  $("#isNew").textContent = `${fresh} new`;
  $("#isNew").hidden = !fresh;
  $("#isTab").textContent = fresh ? `Issues · ${fresh}` : "Issues";
}

function applyCollapsed() {
  $("#issues").hidden = st.collapsed;
  $("#isTab").hidden = !st.collapsed;
  window.dispatchEvent(new Event("resize")); // let the month grid refit its chips
}

// ---- settings
function openSettings() {
  const f = $("#isSettings");
  f.hidden = !f.hidden;
  if (!f.hidden) {
    f.repos.value = st.repos.join("\n");
    f.labels.value = st.labels;
    f.repos.focus();
  }
}
$("#isSettings").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  st.repos = f.repos.value.split(/[\s,]+/).map((r) => r.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "")).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  st.labels = f.labels.value;
  save();
  f.hidden = true;
  refresh();
});
$("#isReset").addEventListener("click", () => { $("#isSettings").repos.value = DEFAULT_REPOS.join("\n"); });

$("#isGear").addEventListener("click", openSettings);
$("#isRefresh").addEventListener("click", refresh);
$("#isCollapse").addEventListener("click", () => { st.collapsed = true; save(); applyCollapsed(); });
$("#isTab").addEventListener("click", () => { st.collapsed = false; save(); applyCollapsed(); refresh(); });

// ---- boot
(async () => {
  const { issuePrefs, issuesSeen } = await chrome.storage.local.get(["issuePrefs", "issuesSeen"]);
  if (issuePrefs) Object.assign(st, issuePrefs);
  // NEW = opened since you last opened a new tab (first run: last 24h).
  st.prevSeen = issuesSeen || Date.now() - 864e5;
  chrome.storage.local.set({ issuesSeen: Date.now() });
  applyCollapsed();
  refresh();
  setInterval(() => { render(); refresh(); }, REFRESH_MS); // also updates the "5m ago" times
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
})();
