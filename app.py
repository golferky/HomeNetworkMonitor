#!/usr/bin/env python3
"""
Yahoo Mail → PDF → Google Calendar
Local web app — run with: python app.py, then open http://localhost:5000
"""

import imaplib
import email
from email.header import decode_header
import io
import json
import os
import pickle
import re
import threading

import base64
import pdfplumber
import anthropic
from flask import Flask, jsonify, redirect, render_template_string, request, url_for
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

app = Flask(__name__)
app.secret_key = os.urandom(24)

CONFIG_FILE = os.path.join(os.path.dirname(__file__), 'config.json')
TOKEN_FILE  = os.path.join(os.path.dirname(__file__), 'token.pickle')
CREDS_FILE  = os.path.join(os.path.dirname(__file__), 'credentials.json')
SCOPES = ['https://www.googleapis.com/auth/calendar']

# ─── Config ──────────────────────────────────────────────────────────────────

def load_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            return json.load(f)
    return {
        'yahoo_email': '',
        'yahoo_app_password': '',
        'sender_email': '',
        'subject_keyword': 'Schedules',
        'your_name': 'Gary Scudder',
        'anthropic_key': '',
        'timezone': 'America/New_York',
    }

def save_config(cfg):
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)

# ─── Yahoo Mail ───────────────────────────────────────────────────────────────

def fetch_emails_with_pdfs(cfg):
    results = []
    mail = imaplib.IMAP4_SSL('imap.mail.yahoo.com', 993)
    mail.login(cfg['yahoo_email'], cfg['yahoo_app_password'])
    mail.select('INBOX')

    from datetime import datetime, timedelta
    since_date = (datetime.now() - timedelta(days=60)).strftime('%d-%b-%Y')
    subject_kw = cfg.get('subject_keyword', 'Schedules')
    search_criteria = f'FROM "{cfg["sender_email"]}" SUBJECT "{subject_kw}" SINCE {since_date}'
    _, ids = mail.search(None, search_criteria)
    msg_ids = ids[0].split()

    for msg_id in msg_ids[-20:]:   # limit to 20 most recent
        _, data = mail.fetch(msg_id, '(RFC822)')
        raw = data[0][1]
        msg = email.message_from_bytes(raw)

        subj_raw, enc = decode_header(msg['Subject'] or '')[0]
        subject = subj_raw.decode(enc or 'utf-8') if isinstance(subj_raw, bytes) else (subj_raw or '')

        pdfs = []
        for part in msg.walk():
            ct = part.get_content_type()
            cd = part.get('Content-Disposition', '')
            if ct == 'application/pdf' or (ct == 'application/octet-stream' and '.pdf' in (part.get_filename() or '').lower()):
                fname = part.get_filename() or 'attachment.pdf'
                pdfs.append({'filename': fname, 'data': part.get_payload(decode=True)})

        if pdfs:
            results.append({
                'id': msg_id.decode(),
                'subject': subject,
                'date': msg.get('Date', ''),
                'pdfs': pdfs,
            })

    mail.close()
    mail.logout()
    return results

# ─── PDF → Events ─────────────────────────────────────────────────────────────

def pdf_to_images(pdf_bytes):
    """Convert each PDF page to a PNG image, returned as base64 strings."""
    images = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            img = page.to_image(resolution=150).original
            buf = io.BytesIO()
            img.save(buf, format='PNG')
            images.append(base64.standard_b64encode(buf.getvalue()).decode('utf-8'))
    return images

def parse_events(pdf_bytes, api_key, your_name):
    client = anthropic.Anthropic(api_key=api_key)

    images = pdf_to_images(pdf_bytes)
    if not images:
        return []

    # Build content blocks — one image per page
    content = []
    for img_b64 in images:
        content.append({
            'type': 'image',
            'source': {'type': 'base64', 'media_type': 'image/png', 'data': img_b64}
        })

    prompt = f"""This is a golf course employee work schedule image. It's a grid where:
- Columns are dates (the header row shows Mon/Tue/Wed... and date numbers)
- Rows are employee names (with phone numbers below the name)
- Cells contain: location codes (LP, GL, BL) and shift times like "6:30" (start) and "2:00" (end)
- LEAGUE or WOLFE = employee is unavailable that day (include as a calendar block)
- OFF = day off (skip entirely)
- Blank cell = not scheduled (skip)
- "C" = closing shift, treat end time as 22:00

Find the row for "{your_name}" and extract ONLY their entries.

For each day with a shift, LEAGUE, or WOLFE (skip OFF and blank):
- title: "Work Shift" for shifts, "Unavailable - LEAGUE" or "Unavailable - WOLFE" for those
- date: YYYY-MM-DD — read the month and day number from the column header. If no year shown use 2026.
- start_time: HH:MM 24-hour (6:30 AM = "06:30", 2:00 PM start = "14:00"), or null for LEAGUE/WOLFE
- end_time: HH:MM 24-hour ("2:00" below a start time means 14:00; "C" means 22:00), or null
- location: LP, GL, or BL if shown, else null
- description: null

Return ONLY a valid JSON array, no other text."""

    content.append({'type': 'text', 'text': prompt})

    resp = client.messages.create(
        model='claude-sonnet-5',
        max_tokens=2048,
        messages=[{'role': 'user', 'content': content}],
    )
    raw = resp.content[0].text.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)
    try:
        return json.loads(raw)
    except Exception:
        return []

# ─── Google Calendar ──────────────────────────────────────────────────────────

def google_service():
    creds = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'rb') as f:
            creds = pickle.load(f)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDS_FILE):
                raise FileNotFoundError('credentials.json not found — see setup instructions.')
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=8080)
        with open(TOKEN_FILE, 'wb') as f:
            pickle.dump(creds, f)
    return build('calendar', 'v3', credentials=creds)

def event_exists(service, ev, tz):
    """Check if an event with the same title already exists on the same date."""
    date = ev.get('date', '')
    if not date:
        return False
    try:
        time_min = f"{date}T00:00:00Z"
        time_max = f"{date}T23:59:59Z"
        result = service.events().list(
            calendarId='primary',
            timeMin=time_min,
            timeMax=time_max,
            q=ev.get('title', ''),
            singleEvents=True,
        ).execute()
        existing = result.get('items', [])
        return len(existing) > 0
    except Exception:
        return False

def create_event(service, ev, tz):
    if ev.get('start_time'):
        start = {'dateTime': f"{ev['date']}T{ev['start_time']}:00", 'timeZone': tz}
        et = ev.get('end_time') or ev['start_time']
        end   = {'dateTime': f"{ev['date']}T{et}:00", 'timeZone': tz}
    else:
        start = {'date': ev['date']}
        end   = {'date': ev['date']}

    body = {'summary': ev['title'], 'start': start, 'end': end}
    if ev.get('location'):    body['location']    = ev['location']
    if ev.get('description'): body['description'] = ev['description']

    result = service.events().insert(calendarId='primary', body=body).execute()
    return result.get('htmlLink', '')

# ─── HTML ─────────────────────────────────────────────────────────────────────

HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail → Calendar</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: #0f1117; color: #e2e8f0; min-height: 100vh; }

  /* Top bar */
  header { background: #1a1d2e; border-bottom: 1px solid #2d3148;
           padding: 14px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; font-weight: 600; flex: 1; }
  .btn-icon { background: none; border: none; cursor: pointer; color: #94a3b8;
              font-size: 20px; padding: 4px 8px; border-radius: 6px; }
  .btn-icon:hover { background: #2d3148; color: #e2e8f0; }

  /* Layout */
  main { max-width: 860px; margin: 32px auto; padding: 0 20px; }

  /* Cards */
  .card { background: #1a1d2e; border: 1px solid #2d3148; border-radius: 12px;
          padding: 24px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; font-weight: 600; color: #94a3b8;
             text-transform: uppercase; letter-spacing: .05em; margin-bottom: 16px; }

  /* Form rows */
  .row { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .field { flex: 1; min-width: 200px; }
  label { display: block; font-size: 12px; color: #64748b; margin-bottom: 4px; }
  input { width: 100%; background: #0f1117; border: 1px solid #2d3148; border-radius: 8px;
          color: #e2e8f0; padding: 9px 12px; font-size: 14px; }
  input:focus { outline: none; border-color: #6366f1; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 9px 18px;
         border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer;
         border: none; transition: opacity .15s; }
  .btn:disabled { opacity: .4; cursor: default; }
  .btn-primary { background: #6366f1; color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #4f46e5; }
  .btn-success { background: #10b981; color: #fff; }
  .btn-success:hover:not(:disabled) { background: #059669; }
  .btn-ghost  { background: #2d3148; color: #94a3b8; }
  .btn-ghost:hover:not(:disabled) { background: #3d4168; color: #e2e8f0; }

  /* Status */
  #status { font-size: 13px; color: #64748b; margin-top: 8px; min-height: 18px; }
  #status.err { color: #f87171; }
  #status.ok  { color: #34d399; }

  /* Events list */
  #events-wrap { display: none; }
  .event-card { background: #0f1117; border: 1px solid #2d3148; border-radius: 10px;
                padding: 14px 16px; margin-bottom: 10px; display: flex; gap: 12px;
                align-items: flex-start; }
  .event-card input[type=checkbox] { margin-top: 3px; accent-color: #6366f1;
                                      width: 16px; height: 16px; flex-shrink: 0; }
  .event-meta { flex: 1; }
  .event-title { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  .event-detail { font-size: 13px; color: #64748b; }
  .event-detail span { margin-right: 12px; }
  .source-tag { font-size: 11px; color: #4f46e5; background: #1a1d2e;
                border: 1px solid #2d3148; border-radius: 4px; padding: 1px 6px;
                display: inline-block; margin-top: 4px; }
  .select-row { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
  .select-row a { font-size: 13px; color: #6366f1; cursor: pointer; }

  /* Overlay */
  #overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.6);
             z-index: 100; align-items: center; justify-content: center; }
  #overlay.show { display: flex; }
  .modal { background: #1a1d2e; border: 1px solid #2d3148; border-radius: 14px;
           padding: 28px; width: 480px; max-width: 95vw; }
  .modal h2 { font-size: 17px; font-weight: 600; margin-bottom: 20px; }
  .modal-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

  /* Spinner */
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.3);
          border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Google badge */
  .gcal-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px;
                color: #34d399; }
  .gcal-badge.disconnected { color: #f87171; }
</style>
</head>
<body>

<header>
  <span style="font-size:22px;">📬</span>
  <h1>Mail → Calendar</h1>
  <span id="gcal-status" class="gcal-badge disconnected">● Google Calendar</span>
  <button class="btn-icon" onclick="openSettings()" title="Settings">⚙️</button>
</header>

<main>
  <!-- Scan card -->
  <div class="card">
    <h2>Scan Emails</h2>
    <div class="row">
      <div class="field">
        <label>Sender email to search for</label>
        <input id="scan-sender" type="email" placeholder="someone@example.com">
      </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" id="btn-scan" onclick="scan()">
        <span id="scan-label">Scan Inbox</span>
      </button>
      <button class="btn btn-ghost" onclick="connectGoogle()">Connect Google Calendar</button>
    </div>
    <div id="status"></div>
  </div>

  <!-- Results -->
  <div id="events-wrap">
    <div class="card">
      <h2>Extracted Events <span id="event-count" style="color:#6366f1;"></span></h2>
      <div class="select-row">
        <a onclick="selectAll(true)">Select all</a>
        <a onclick="selectAll(false)">Deselect all</a>
      </div>
      <div id="events-list"></div>
      <button class="btn btn-success" id="btn-add" onclick="addToCalendar()" style="margin-top:8px;">
        <span id="add-label">Add Selected to Google Calendar</span>
      </button>
      <div id="add-status" style="font-size:13px;margin-top:8px;color:#64748b;"></div>
    </div>
  </div>
</main>

<!-- Settings modal -->
<div id="overlay" onclick="if(event.target===this)closeSettings()">
  <div class="modal">
    <h2>⚙️ Settings</h2>
    <div class="row">
      <div class="field">
        <label>Your Yahoo email</label>
        <input id="s-yahoo-email" type="email" placeholder="you@yahoo.com">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Yahoo app password</label>
        <input id="s-yahoo-pw" type="password" placeholder="xxxx-xxxx-xxxx-xxxx">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Default sender email to search</label>
        <input id="s-sender" type="email" placeholder="sender@example.com">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Email subject keyword</label>
        <input id="s-subject" type="text" placeholder="Schedules">
      </div>
      <div class="field">
        <label>Your name on the schedule</label>
        <input id="s-name" type="text" placeholder="Gary Scudder">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Anthropic API key</label>
        <input id="s-anthropic" type="password" placeholder="sk-ant-...">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label>Timezone</label>
        <input id="s-tz" type="text" placeholder="America/New_York">
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeSettings()">Cancel</button>
      <button class="btn btn-primary" onclick="saveSettings()">Save</button>
    </div>
  </div>
</div>

<script>
let extractedEvents = [];

// ── Settings ─────────────────────────────────────────────────────────────────
async function openSettings() {
  const r = await fetch('/config');
  const cfg = await r.json();
  document.getElementById('s-yahoo-email').value = cfg.yahoo_email || '';
  document.getElementById('s-yahoo-pw').value    = cfg.yahoo_app_password || '';
  document.getElementById('s-sender').value      = cfg.sender_email || '';
  document.getElementById('s-subject').value     = cfg.subject_keyword || 'Schedules';
  document.getElementById('s-name').value        = cfg.your_name || 'Gary Scudder';
  document.getElementById('s-anthropic').value   = cfg.anthropic_key || '';
  document.getElementById('s-tz').value          = cfg.timezone || 'America/New_York';
  // Pre-fill scan sender if set
  if (cfg.sender_email && !document.getElementById('scan-sender').value)
    document.getElementById('scan-sender').value = cfg.sender_email;
  document.getElementById('overlay').classList.add('show');
}
function closeSettings() {
  document.getElementById('overlay').classList.remove('show');
}
async function saveSettings() {
  const cfg = {
    yahoo_email:        document.getElementById('s-yahoo-email').value.trim(),
    yahoo_app_password: document.getElementById('s-yahoo-pw').value.trim(),
    sender_email:       document.getElementById('s-sender').value.trim(),
    subject_keyword:    document.getElementById('s-subject').value.trim() || 'Schedules',
    your_name:          document.getElementById('s-name').value.trim() || 'Gary Scudder',
    anthropic_key:      document.getElementById('s-anthropic').value.trim(),
    timezone:           document.getElementById('s-tz').value.trim() || 'America/New_York',
  };
  await fetch('/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(cfg) });
  closeSettings();
  setStatus('Settings saved.', 'ok');
  if (cfg.sender_email && !document.getElementById('scan-sender').value)
    document.getElementById('scan-sender').value = cfg.sender_email;
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(msg, type='') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = type;
}

// ── Google connect ────────────────────────────────────────────────────────────
async function connectGoogle() {
  setStatus('Opening Google authorization in browser…');
  window.open('/connect-google', '_blank');
  setTimeout(checkGoogleStatus, 3000);
}
async function checkGoogleStatus() {
  const r = await fetch('/google-status');
  const d = await r.json();
  const badge = document.getElementById('gcal-status');
  if (d.connected) {
    badge.textContent = '● Google Calendar';
    badge.className = 'gcal-badge';
    setStatus('Google Calendar connected ✓', 'ok');
  } else {
    badge.textContent = '● Google Calendar';
    badge.className = 'gcal-badge disconnected';
  }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scan() {
  const sender = document.getElementById('scan-sender').value.trim();
  if (!sender) { setStatus('Enter a sender email first.', 'err'); return; }

  const btn = document.getElementById('btn-scan');
  const lbl = document.getElementById('scan-label');
  btn.disabled = true;
  lbl.innerHTML = '<span class="spin"></span> Scanning…';
  setStatus('Connecting to Yahoo Mail…');
  document.getElementById('events-wrap').style.display = 'none';
  extractedEvents = [];

  try {
    const r = await fetch('/scan', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ sender_email: sender }),
    });
    const d = await r.json();
    if (d.error) { setStatus('Error: ' + d.error, 'err'); return; }

    extractedEvents = d.events;
    renderEvents(d.events);
    if (d.email_count === 0) {
      setStatus('No emails found matching that sender and subject keyword.', 'err');
    } else if (d.events.length === 0) {
      const errs = d.parse_errors && d.parse_errors.length ? ' Errors: ' + d.parse_errors.join('; ') : '';
      setStatus(`Found ${d.email_count} email(s) but could not extract events.${errs}`, 'err');
    } else {
      setStatus(`Found ${d.events.length} event(s) across ${d.email_count} email(s).`, 'ok');
    }
  } catch(e) {
    setStatus('Request failed: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
    lbl.textContent = 'Scan Inbox';
  }
}

// ── Render events ─────────────────────────────────────────────────────────────
function renderEvents(events) {
  const list = document.getElementById('events-list');
  document.getElementById('event-count').textContent = `(${events.length})`;
  list.innerHTML = '';
  events.forEach((ev, i) => {
    const time = ev.start_time ? `${ev.start_time}${ev.end_time ? ' – ' + ev.end_time : ''}` : 'All day';
    list.innerHTML += `
      <div class="event-card">
        <input type="checkbox" id="ev-${i}" checked>
        <div class="event-meta">
          <div class="event-title">${esc(ev.title)}</div>
          <div class="event-detail">
            <span>📅 ${esc(ev.date)}</span>
            <span>🕐 ${esc(time)}</span>
            ${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}
          </div>
          ${ev.description ? `<div class="event-detail" style="margin-top:4px;">${esc(ev.description)}</div>` : ''}
          <div class="source-tag">${esc(ev.source || '')}</div>
        </div>
      </div>`;
  });
  document.getElementById('events-wrap').style.display = 'block';
}

function selectAll(val) {
  extractedEvents.forEach((_, i) => {
    const cb = document.getElementById('ev-' + i);
    if (cb) cb.checked = val;
  });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Add to calendar ───────────────────────────────────────────────────────────
async function addToCalendar() {
  const selected = extractedEvents.filter((_, i) => {
    const cb = document.getElementById('ev-' + i);
    return cb && cb.checked;
  });
  if (!selected.length) { document.getElementById('add-status').textContent = 'No events selected.'; return; }

  const btn = document.getElementById('btn-add');
  const lbl = document.getElementById('add-label');
  btn.disabled = true;
  lbl.innerHTML = '<span class="spin"></span> Adding…';
  document.getElementById('add-status').textContent = '';

  try {
    const r = await fetch('/create-events', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ events: selected }),
    });
    const d = await r.json();
    if (d.error) {
      document.getElementById('add-status').textContent = 'Error: ' + d.error;
    } else {
      const skippedMsg = d.skipped && d.skipped.length ? ` (${d.skipped.length} already existed, skipped)` : '';
      document.getElementById('add-status').innerHTML =
        `✅ Added ${d.created.length} event(s) to Google Calendar${skippedMsg}. ` +
        (d.created[0] ? `<a href="${d.created[0]}" target="_blank">View first event ↗</a>` : '');
    }
  } catch(e) {
    document.getElementById('add-status').textContent = 'Failed: ' + e.message;
  } finally {
    btn.disabled = false;
    lbl.textContent = 'Add Selected to Google Calendar';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.onload = async () => {
  checkGoogleStatus();
  // Pre-fill sender from saved config
  const r = await fetch('/config');
  const cfg = await r.json();
  if (cfg.sender_email) document.getElementById('scan-sender').value = cfg.sender_email;
};
</script>
</body>
</html>"""

# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template_string(HTML)

@app.route('/config', methods=['GET'])
def get_config():
    return jsonify(load_config())

@app.route('/config', methods=['POST'])
def post_config():
    cfg = request.json
    save_config(cfg)
    return jsonify({'ok': True})

@app.route('/google-status')
def google_status():
    connected = os.path.exists(TOKEN_FILE)
    if connected:
        try:
            with open(TOKEN_FILE, 'rb') as f:
                creds = pickle.load(f)
            connected = creds and (creds.valid or (creds.expired and creds.refresh_token))
        except Exception:
            connected = False
    return jsonify({'connected': connected})

@app.route('/connect-google')
def connect_google():
    try:
        google_service()
        return "<script>window.close();</script><p>Connected! You can close this tab.</p>"
    except FileNotFoundError as e:
        return f"<p style='color:red'>{e}</p>", 400
    except Exception as e:
        return f"<p style='color:red'>Error: {e}</p>", 500

@app.route('/scan', methods=['POST'])
def scan():
    cfg = load_config()
    data = request.json or {}
    sender = data.get('sender_email', cfg.get('sender_email', ''))
    if not sender:
        return jsonify({'error': 'No sender email specified.'}), 400
    if not cfg.get('yahoo_email') or not cfg.get('yahoo_app_password'):
        return jsonify({'error': 'Yahoo credentials not set. Open Settings first.'}), 400
    if not cfg.get('anthropic_key'):
        return jsonify({'error': 'Anthropic API key not set. Open Settings first.'}), 400

    cfg['sender_email'] = sender  # use what was passed

    try:
        emails = fetch_emails_with_pdfs(cfg)
    except Exception as e:
        return jsonify({'error': f'Yahoo Mail error: {e}'}), 500

    all_events = []
    parse_errors = []
    for em in emails:
        for pdf in em['pdfs']:
            try:
                events = parse_events(pdf['data'], cfg['anthropic_key'], cfg.get('your_name', 'Gary Scudder'))
                for ev in events:
                    ev['source'] = f"{em['subject']} › {pdf['filename']}"
                all_events.extend(events)
            except Exception as e:
                parse_errors.append(f"{pdf['filename']}: {e}")

    return jsonify({'events': all_events, 'email_count': len(emails), 'parse_errors': parse_errors})

@app.route('/create-events', methods=['POST'])
def create_events():
    cfg = load_config()
    tz = cfg.get('timezone', 'America/New_York')
    events = (request.json or {}).get('events', [])
    if not events:
        return jsonify({'error': 'No events provided.'}), 400

    try:
        service = google_service()
    except Exception as e:
        return jsonify({'error': f'Google Calendar: {e}'}), 500

    created  = []
    skipped  = []
    errors   = []
    for ev in events:
        try:
            if event_exists(service, ev, tz):
                skipped.append(ev.get('title', '') + ' on ' + ev.get('date', ''))
            else:
                link = create_event(service, ev, tz)
                created.append(link)
        except Exception as e:
            errors.append(str(e))

    return jsonify({'created': created, 'skipped': skipped, 'errors': errors})

# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    import webbrowser
    print('\n  Mail → Calendar')
    print('  ───────────────')
    print('  Open: http://localhost:5000\n')
    threading.Timer(1.2, lambda: webbrowser.open('http://localhost:5000')).start()
    app.run(host='127.0.0.1', port=5000, debug=False)
