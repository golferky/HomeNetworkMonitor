#!/usr/bin/env python3
"""
Boone County Golf Schedule → Google Calendar  v1.0
Local web app — run with: python booneschedules_app.py, then open http://localhost:5000
"""
VERSION = "1.0"

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

# In-memory PDF cache: list of {filename, data, source} dicts
_pdf_cache = []

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

def _claude_call(api_key, pdf_b64, prompt, max_tokens=1024):
    """Send a PDF + prompt to Claude, return the text response."""
    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model='claude-haiku-4-5-20251001',
        max_tokens=max_tokens,
        timeout=60,
        messages=[{
            'role': 'user',
            'content': [
                {'type': 'document', 'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': pdf_b64}},
                {'type': 'text', 'text': prompt}
            ]
        }],
    )
    text_block = next((b for b in resp.content if hasattr(b, 'text')), None)
    if not text_block:
        return ''
    raw = text_block.text.strip()
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)
    return raw

def get_employee_names(pdf_bytes, api_key):
    """Return sorted list of employee names from the schedule PDF."""
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode('utf-8')
    prompt = """This is a golf course work schedule. List every employee's full name (first and last).
Return ONLY a JSON array of strings, e.g. ["Gary Scudder", "John Smith"].
No other text."""
    raw = _claude_call(api_key, pdf_b64, prompt, max_tokens=512)
    try:
        return json.loads(raw)
    except Exception:
        return []

# ── Deterministic schedule parser ────────────────────────────────────────────

MONTHS = {'January':1,'February':2,'March':3,'April':4,'May':5,'June':6,
          'July':7,'August':8,'September':9,'October':10,'November':11,'December':12}
STATUS_CODES = {'LP','GL','BL','LEAGUE','WOLFE','OFF'}

def _nearest_col(x, col_xs, tolerance=28):
    if not col_xs:
        return None
    cx = min(col_xs, key=lambda c: abs(c - x))
    return cx if abs(cx - x) <= tolerance else None

def _fmt_time(t, is_end=False):
    if not t:
        return None
    t = str(t).strip()
    if t == 'C':
        return '22:00'
    try:
        parts = t.split(':')
        h, m = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        if is_end and h < 12:
            h += 12   # "2:00" end → 14:00
        return f'{h:02d}:{m:02d}'
    except Exception:
        return None

def parse_employee_events(pdf_bytes, _api_key, employee_name):
    """Deterministically parse one employee's shifts from the schedule PDF
    using pdfplumber word positions — no LLM needed for event extraction."""
    from collections import defaultdict

    name_parts  = employee_name.split()
    first_name  = name_parts[0] if name_parts else ''
    last_name   = name_parts[-1] if len(name_parts) > 1 else ''

    all_events = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=False, x_tolerance=3, y_tolerance=3)
            if not words:
                continue

            # ── Group words into rows by y-bucket ────────────────────────
            row_map = defaultdict(list)
            for w in words:
                y_key = round(w['top'] / 5) * 5
                row_map[y_key].append(w)

            rows = [(y, sorted(ws, key=lambda w: w['x0']))
                    for y, ws in sorted(row_map.items())]

            # ── Find date-header row(s) — may span two months ────────────
            # col_x_to_date maps rounded x0 → full date object
            from datetime import date as date_cls2
            col_x_to_date_obj = {}

            # Collect all month-name words and their x positions
            month_words = [(round(w['x0']), MONTHS[w['text']], w)
                           for _y, row_ws in rows for w in row_ws
                           if w['text'] in MONTHS]

            # Find the date-number row (row with the most integers 1-31)
            date_row_ws = None
            best_count = 0
            for _y, row_ws in rows:
                cnt = sum(1 for w in row_ws if w['text'].isdigit() and 1 <= int(w['text']) <= 31)
                if cnt > best_count:
                    best_count = cnt
                    date_row_ws = row_ws

            if not date_row_ws or not month_words:
                print(f"[DEBUG] No date header found. month_words={month_words[:3]}, best_count={best_count}")
                continue

            # Assign each date-number word to the nearest month to its left
            month_words_sorted = sorted(month_words, key=lambda t: t[0])  # sort by x
            year = 2026

            prev_month_num = month_words_sorted[0][1]
            prev_day = 0
            for w in sorted(date_row_ws, key=lambda w: w['x0']):
                if not (w['text'].isdigit() and 1 <= int(w['text']) <= 31):
                    continue
                day = int(w['text'])
                # Determine which month this day belongs to
                # Find rightmost month word to the left of this date
                cx = round(w['x0'])
                left_months = [(mx, mn) for mx, mn, _w in month_words_sorted if mx <= cx]
                if left_months:
                    m_num = left_months[-1][1]
                else:
                    m_num = prev_month_num
                # If day resets (e.g. from 31 → 1), month has rolled over
                if day < prev_day and not left_months:
                    m_num = (m_num % 12) + 1
                prev_day = day
                prev_month_num = m_num
                try:
                    col_x_to_date_obj[cx] = date_cls2(year, m_num, day)
                except Exception:
                    pass

            print(f"[DEBUG] col_x_to_date_obj: {dict(list(col_x_to_date_obj.items())[:5])} ...")

            if not col_x_to_date_obj:
                continue

            col_xs = sorted(col_x_to_date_obj.keys())

            col_xs  = sorted(col_x_to_date_obj.keys())
            year    = 2026

            # ── Locate the three employee rows ────────────────────────────
            emp_status_ws = emp_first_ws = emp_last_ws = None

            for i, (_y, row_ws) in enumerate(rows):
                texts = [w['text'] for w in row_ws]
                if first_name in texts and i + 1 < len(rows):
                    next_texts = [w['text'] for w in rows[i + 1][1]]
                    if last_name in next_texts:
                        emp_first_ws  = row_ws
                        emp_last_ws   = rows[i + 1][1]
                        emp_status_ws = rows[i - 1][1] if i > 0 else []
                        break

            if emp_first_ws is None:
                # Print all rows containing either name part to debug
                print(f"[DEBUG] '{employee_name}' not found on page. Rows with '{first_name}' or '{last_name}':")
                for _y2, row_ws2 in rows:
                    texts2 = [w['text'] for w in row_ws2]
                    if first_name in texts2 or last_name in texts2:
                        print(f"  y={_y2}: {texts2[:10]}")
                continue

            # ── Build per-column data dicts ───────────────────────────────
            col_status = {}   # col_x → code
            col_start  = {}   # col_x → time string
            col_end    = {}   # col_x → time string

            for w in (emp_status_ws or []):
                if w['text'] in STATUS_CODES:
                    cx = _nearest_col(w['x0'], col_xs)
                    if cx is not None:
                        col_status[cx] = w['text']

            for w in emp_first_ws:
                if w['text'] == first_name:
                    continue
                if ':' in w['text'] or w['text'].replace('.','').isdigit():
                    cx = _nearest_col(w['x0'], col_xs)
                    if cx is not None:
                        col_start[cx] = w['text']

            for w in (emp_last_ws or []):
                if w['text'] == last_name:
                    continue
                if w['text'] in ('C',) or ':' in w['text'] or w['text'].replace('.','').isdigit():
                    cx = _nearest_col(w['x0'], col_xs)
                    if cx is not None:
                        col_end[cx] = w['text']

            # ── Emit events ───────────────────────────────────────────────
            for cx in col_xs:
                status = col_status.get(cx)
                start  = col_start.get(cx)
                end    = col_end.get(cx)

                if not status and not start:
                    continue
                if status == 'OFF':
                    continue

                dt = col_x_to_date_obj.get(cx)
                if not dt:
                    continue

                if status in ('LEAGUE', 'WOLFE'):
                    all_events.append({
                        'title':       f'Unavailable - {status}',
                        'date':        dt.isoformat(),
                        'start_time':  None,
                        'end_time':    None,
                        'location':    None,
                        'description': None,
                    })
                else:
                    LOCATION_TITLES = {'BL': 'Boone Work', 'LP': 'Lassing Work'}
                    title = LOCATION_TITLES.get(status, 'Work Shift')
                    all_events.append({
                        'title':       title,
                        'date':        dt.isoformat(),
                        'start_time':  _fmt_time(start),
                        'end_time':    _fmt_time(end, is_end=True),
                        'location':    status if status in ('LP','GL','BL') else None,
                        'description': None,
                    })

    print(f"[DEBUG] Parsed {len(all_events)} events for '{employee_name}'")
    return all_events

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
  .version { font-size: 11px; color: #4f5880; }
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
  <span style="font-size:22px;">⛳</span>
  <h1>Boone Schedules → Calendar <span class="version">v1.0</span></h1>
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
      <div class="field" id="employee-field" style="display:none;">
        <label>Show schedule for</label>
        <select id="employee-select" onchange="filterByEmployee()" style="width:100%;background:#0f1117;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;padding:9px 12px;font-size:14px;">
        </select>
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
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:13px;color:#94a3b8;cursor:pointer;">
          <input type="checkbox" id="show-unavailable" onchange="renderEvents(window._lastEvents)" style="width:14px;height:14px;accent-color:#6366f1;">
          Show unavailable blocks
        </label>
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
let allByEmployee = {};

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
  const t0 = Date.now();
  const timer = setInterval(() => {
    const s = ((Date.now() - t0) / 1000).toFixed(0);
    lbl.innerHTML = `<span class="spin"></span> Scanning… ${s}s`;
  }, 1000);
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

    if (d.email_count === 0) {
      setStatus('No emails found matching that sender and subject keyword.', 'err');
      return;
    }

    const employees = d.employees || [];

    if (employees.length === 0) {
      const errs = d.parse_errors && d.parse_errors.length ? ' Errors: ' + d.parse_errors.join('; ') : '';
      setStatus(`Found ${d.email_count} email(s) but could not extract employee names.${errs}`, 'err');
      return;
    }

    // Build employee dropdown — default name first
    const defaultName = (await (await fetch('/config')).json()).your_name || 'Gary Scudder';
    const sel = document.getElementById('employee-select');
    sel.innerHTML = '';
    const sorted = [defaultName, ...employees.filter(n => n !== defaultName)];
    sorted.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = name;
      sel.appendChild(opt);
    });
    document.getElementById('employee-field').style.display = '';
    setStatus(`Found ${employees.length} employee(s) across ${d.email_count} email(s). Loading your schedule…`, 'ok');
    await filterByEmployee();
  } catch(e) {
    setStatus('Request failed: ' + e.message, 'err');
  } finally {
    clearInterval(timer);
    btn.disabled = false;
    lbl.textContent = 'Scan Inbox';
  }
}

// ── Employee filter ───────────────────────────────────────────────────────────
async function filterByEmployee() {
  const name = document.getElementById('employee-select').value;
  if (!name) return;
  setStatus(`Loading schedule for ${name}…`, '');
  document.getElementById('events-wrap').style.display = 'none';
  try {
    const r = await fetch('/load-events', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name}),
    });
    const d = await r.json();
    if (d.error) { setStatus('Error: ' + d.error, 'err'); return; }
    renderEvents(d.events);
    setStatus(`Showing ${d.events.length} event(s) for ${name}.`, 'ok');
  } catch(e) {
    setStatus('Failed to load events: ' + e.message, 'err');
  }
}

// ── Render events ─────────────────────────────────────────────────────────────
function renderEvents(events) {
  window._lastEvents = events;
  const showUnavailable = document.getElementById('show-unavailable').checked;
  const filtered = events.filter(ev =>
    showUnavailable || !ev.title.toLowerCase().includes('unavailable')
  );
  extractedEvents = filtered;
  const list = document.getElementById('events-list');
  document.getElementById('event-count').textContent = `(${filtered.length})`;
  list.innerHTML = '';
  filtered.forEach((ev, i) => {
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

    # Cache PDFs and collect employee names
    global _pdf_cache
    _pdf_cache = []
    all_names = set()
    parse_errors = []

    for em in emails:
        for pdf in em['pdfs']:
            source = f"{em['subject']} › {pdf['filename']}"
            _pdf_cache.append({'filename': pdf['filename'], 'data': pdf['data'], 'source': source})
            try:
                print(f"[DEBUG] Getting names from {pdf['filename']}...")
                names = get_employee_names(pdf['data'], cfg['anthropic_key'])
                print(f"[DEBUG] Names: {names}")
                all_names.update(names)
            except Exception as e:
                import traceback
                print(f"[ERROR] {pdf['filename']}: {traceback.format_exc()}")
                parse_errors.append(f"{pdf['filename']}: {e}")

    employees = sorted(all_names)
    return jsonify({
        'employees': employees,
        'email_count': len(emails),
        'parse_errors': parse_errors,
    })

@app.route('/load-events', methods=['POST'])
def load_events():
    cfg = load_config()
    name = (request.json or {}).get('name', '')
    if not name:
        return jsonify({'error': 'No name provided'}), 400
    if not _pdf_cache:
        return jsonify({'error': 'No PDFs cached — scan first'}), 400

    all_events = []
    for pdf in _pdf_cache:
        try:
            print(f"[DEBUG] Loading events for {name} from {pdf['filename']}...")
            events = parse_employee_events(pdf['data'], cfg['anthropic_key'], name)
            for ev in events:
                ev['source'] = pdf['source']
            all_events.extend(events)
        except Exception as e:
            print(f"[ERROR] {e}")

    return jsonify({'events': all_events})

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
