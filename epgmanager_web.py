from flask import Response


def register_epgmanager_web(app):
    @app.get("/")
    @app.get("/epgmanager_web")
    def epgmanager_web_home():
        return Response(_HTML, mimetype="text/html")


_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EPGManager Web</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --line: #cfd6de;
      --text: #18212b;
      --muted: #637083;
      --accent: #0b72d9;
      --ok: #0f8a43;
      --warn: #a15c00;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.4 "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 650;
      letter-spacing: 0;
    }
    main {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 12px;
      padding: 12px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      min-width: 0;
    }
    section h2 {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 0;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      font-size: 14px;
      font-weight: 650;
      cursor: pointer;
      user-select: none;
    }
    section h2::after {
      content: "▾";
      color: var(--muted);
      font-size: 12px;
    }
    section.collapsed h2 {
      border-bottom: 0;
    }
    section.collapsed h2::after {
      content: "▸";
    }
    section.collapsed .body {
      display: none;
    }
    .wide { grid-column: span 12; }
    .half { grid-column: span 6; }
    .third { grid-column: span 4; }
    .body { padding: 12px; }
    .toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    button {
      min-height: 30px;
      padding: 5px 11px;
      border: 1px solid #9da9b6;
      border-radius: 4px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
    }
    button.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    button:disabled {
      opacity: .55;
      cursor: default;
    }
    .kv {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: 6px 10px;
    }
    .label { color: var(--muted); }
    .value { overflow-wrap: anywhere; }
    .pill {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #f7f9fb;
      font-size: 12px;
    }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .wanted-owned td {
      background: #b8cbe2;
      color: #061d3b;
    }
    .wanted-missing td {
      background: #ffffff;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      padding: 7px 8px;
      text-align: left;
      vertical-align: top;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      background: #f8fafc;
    }
    pre {
      margin: 0;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.35 Consolas, ui-monospace, monospace;
      color: #27313d;
    }
    #toast {
      min-height: 20px;
      color: var(--muted);
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .wide, .half, .third { grid-column: span 1; }
      header { align-items: flex-start; flex-direction: column; }
      .kv { grid-template-columns: 120px minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <header>
    <h1>EPGManager Web</h1>
    <div class="toolbar">
      <span id="toast">Loading...</span>
      <button id="refreshBtn" class="primary" type="button">Refresh</button>
      <button id="importBtn" type="button">Import Guide</button>
    </div>
  </header>

  <main>
    <section class="third">
      <h2>Server</h2>
      <div class="body kv" id="serverBox"></div>
    </section>

    <section class="third">
      <h2>Recording</h2>
      <div class="body kv" id="recordingBox"></div>
    </section>

    <section class="third">
      <h2>Guide Import</h2>
      <div class="body kv" id="guideBox"></div>
    </section>

    <section class="half">
      <h2>Conversion Queue</h2>
      <div class="body" id="queueBox"></div>
    </section>

    <section class="half">
      <h2>Upcoming</h2>
      <div class="body" id="upcomingBox"></div>
    </section>

    <section class="wide">
      <h2>Guide</h2>
      <div class="body" id="guideRowsBox"></div>
    </section>

    <section class="wide">
      <h2>Wanted Queue</h2>
      <div class="body" id="wantedBox"></div>
    </section>

    <section class="wide">
      <h2>Guide Import Output</h2>
      <div class="body"><pre id="guideOutput"></pre></div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);

    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\\\"": "&quot;",
        "'": "&#39;"
      }[ch]));
    }

    function kv(rows) {
      return rows.map(([label, value]) =>
        `<div class="label">${esc(label)}</div><div class="value">${value}</div>`
      ).join("");
    }

    function statusClass(value) {
      const text = String(value || "").toLowerCase();
      if (["ok", "done", "idle", "completed"].includes(text)) return "ok";
      if (["running", "queued", "recording", "waiting", "deferred"].includes(text)) return "warn";
      if (["failed", "error"].includes(text)) return "bad";
      return "";
    }

    function pill(value) {
      return `<span class="pill ${statusClass(value)}">${esc(value || "unknown")}</span>`;
    }

    async function getJson(url, timeoutMs = 10000) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(url, { cache: "no-store", signal: controller.signal });
      } catch (err) {
        if (err.name === "AbortError") throw new Error(`${url} timed out`);
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`${url} returned ${response.status}`);
      return response.json();
    }

    async function postJson(url, body) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      const text = await response.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!response.ok) throw new Error(data.error || data.raw || `${url} returned ${response.status}`);
      return data;
    }

    function renderServer(ping) {
      $("serverBox").innerHTML = kv([
        ["Status", pill(ping.status)],
        ["Version", esc(ping.version)],
        ["Active Jobs", esc(ping.active_jobs)],
        ["DB", ping.db_exists ? `<span class="ok">ready</span>` : `<span class="bad">missing</span>`],
        ["Pending Events", esc(ping.pending_system_events)],
        ["Time", esc((ping.time || "").replace("T", " ").slice(0, 19))]
      ]);
    }

    function renderRecording(active) {
      const rows = Object.entries(active || {});
      if (!rows.length) {
        $("recordingBox").innerHTML = kv([["Now", pill("none")]]);
        return;
      }
      const first = rows[0][1];
      $("recordingBox").innerHTML = kv([
        ["Now", pill(first.status)],
        ["Title", esc(first.title)],
        ["File", esc(first.file || "")],
        ["Job", esc(rows[0][0])]
      ]);
    }

    function renderGuide(guide) {
      $("guideBox").innerHTML = kv([
        ["Status", pill(guide.status)],
        ["Source", esc(guide.source || "")],
        ["Started", esc((guide.started_at || "").replace("T", " ").slice(0, 19))],
        ["Finished", esc((guide.finished_at || "").replace("T", " ").slice(0, 19))],
        ["PID", esc(guide.pid || "")],
        ["Error", guide.last_error ? `<span class="bad">${esc(guide.last_error)}</span>` : ""]
      ]);
      $("guideOutput").textContent = guide.last_output || "";
    }

    function renderQueue(queue) {
      const active = queue.active ? `<p>Active: <strong>${esc(queue.active)}</strong></p>` : "<p>Active: none</p>";
      const queued = queue.queued || [];
      const rows = queued.slice(0, 10).map((item) =>
        `<tr><td>${esc(item.title)}</td><td>${pill(item.status)}</td><td>${esc(item.message || "")}</td></tr>`
      ).join("");
      const more = queued.length > 10 ? `<p>${queued.length - 10} more queued</p>` : "";
      $("queueBox").innerHTML = `${active}<p>Waiting: ${esc(queue.queued_count || 0)}</p>` +
        `<table><thead><tr><th>Title</th><th>Status</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
    }

    function renderUpcoming(upcoming) {
      const rows = (upcoming || []).slice(0, 8).map((item) =>
        `<tr><td>${esc(item.title)}</td><td>${esc(item.channel)}</td><td>${esc(item.start_time)}</td><td>${pill(item.status)}</td></tr>`
      ).join("");
      $("upcomingBox").innerHTML =
        `<table><thead><tr><th>Title</th><th>Channel</th><th>Start</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function renderGuideRows(guideRows) {
      const items = guideRows.items || [];
      const rows = items.map((item) =>
        `<tr><td>${esc(item.my_channel || "")}</td><td>${esc(item.nickname || item.channel || "")}</td><td>${esc(item.title || "")}</td><td>${esc(item.start_time || "")}</td><td>${esc(item.until_start || "")}</td><td>${esc(item.end_time || "")}</td><td>${esc(item.progress ?? "")}</td></tr>`
      ).join("");
      $("guideRowsBox").innerHTML =
        `<p>${esc(guideRows.count || items.length)} guide row(s), favorites first</p>` +
        `<table><thead><tr><th>Ch</th><th>Channel</th><th>Title</th><th>Start</th><th>When</th><th>End</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    function renderWanted(wanted) {
      const items = wanted.items || [];
      const rows = items.map((item) => {
        const owned = !!item.plex;
        const cls = owned ? "wanted-owned" : "wanted-missing";
        const plexText = owned ? "In Plex" : "Wanted";
        const year = item.year ? ` (${esc(item.year)})` : "";
        return `<tr class="${cls}"><td>${esc(item.title)}${year}</td><td>${esc(item.type || "")}</td><td>${esc(plexText)}</td><td>${esc(item.source_person || item.source || "")}</td><td>${esc((item.created_at || "").slice(0, 10))}</td></tr>`;
      }).join("");
      $("wantedBox").innerHTML =
        `<p>${esc(wanted.count || items.length)} wanted title(s)</p>` +
        `<table><thead><tr><th>Title</th><th>Type</th><th>Plex</th><th>Source</th><th>Added</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    async function refresh() {
      $("toast").textContent = "Refreshing...";
      const calls = [
        ["server", getJson("/ping")],
        ["recording", getJson("/jobs/active")],
        ["guide", getJson("/guide_import/status")],
        ["queue", getJson("/convert_queue")],
        ["upcoming", getJson("/upcoming")],
        ["guideRows", getJson("/guide?filter=favorites&limit=150")],
        ["wanted", getJson("/wanted")]
      ];

      const results = await Promise.allSettled(calls.map(([, promise]) => promise));
      const failed = [];

      results.forEach((result, index) => {
        const name = calls[index][0];
        if (result.status !== "fulfilled") {
          failed.push(`${name}: ${result.reason.message || result.reason}`);
          return;
        }
        if (name === "server") renderServer(result.value);
        if (name === "recording") renderRecording(result.value);
        if (name === "guide") renderGuide(result.value);
        if (name === "queue") renderQueue(result.value);
        if (name === "upcoming") renderUpcoming(result.value);
        if (name === "guideRows") renderGuideRows(result.value);
        if (name === "wanted") renderWanted(result.value);
      });

      if (failed.length) {
        $("toast").innerHTML = `<span class="bad">${esc(failed.join("; "))}</span>`;
      } else {
        $("toast").textContent = `Updated ${new Date().toLocaleTimeString()}`;
      }
    }

    function setupCollapsibleSections() {
      document.querySelectorAll("section").forEach((section, index) => {
        const header = section.querySelector("h2");
        if (!header) return;
        const key = `epgmanager_web_collapsed_${header.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_") || index}`;
        if (localStorage.getItem(key) === "1") section.classList.add("collapsed");
        header.addEventListener("click", () => {
          section.classList.toggle("collapsed");
          localStorage.setItem(key, section.classList.contains("collapsed") ? "1" : "0");
        });
      });
    }

    async function requestImport() {
      $("importBtn").disabled = true;
      $("toast").textContent = "Requesting guide import...";
      try {
        await postJson("/guide_import", { force: false });
        await refresh();
      } catch (err) {
        $("toast").innerHTML = `<span class="bad">${esc(err.message)}</span>`;
      } finally {
        $("importBtn").disabled = false;
      }
    }

    $("refreshBtn").addEventListener("click", refresh);
    $("importBtn").addEventListener("click", requestImport);
    setupCollapsibleSections();
    refresh();
    setInterval(refresh, 30000);
  </script>
</body>
</html>
"""
