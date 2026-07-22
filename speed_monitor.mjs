import { execSync, exec } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { promisify } from 'util'
import http from 'http'

const execAsync = promisify(exec)
const LOG_FILE = '/Users/garyscudder/epg/speed_log.json'

const INTERFACES = {
  altafiber: { source: '192.168.1.190',  name: 'AltaFiber' },
  tmobile:   { source: '192.168.12.159', name: 'T-Mobile'  },
}

function loadLog() {
  if (!existsSync(LOG_FILE)) return { tests: [] }
  return JSON.parse(readFileSync(LOG_FILE, 'utf-8'))
}

function saveLog(data) {
  writeFileSync(LOG_FILE, JSON.stringify(data, null, 2))
}

async function runSpeedTest(iface) {
  console.log(`Testing ${iface.name} (${iface.source})...`)
  try {
    const { stdout } = await execAsync(
      `/opt/homebrew/bin/speedtest-cli --source ${iface.source} --simple`,
      { timeout: 120000 }
    )
    const ping     = parseFloat(stdout.match(/Ping:\s+([\d.]+)/)?.[1])
    const download = parseFloat(stdout.match(/Download:\s+([\d.]+)/)?.[1])
    const upload   = parseFloat(stdout.match(/Upload:\s+([\d.]+)/)?.[1])
    console.log(`  Ping: ${ping}ms | Down: ${download} Mbps | Up: ${upload} Mbps`)
    return { ping, download, upload, error: null }
  } catch(e) {
    console.log(`  Failed: ${e.message}`)
    return { ping: null, download: null, upload: null, error: e.message }
  }
}

async function scanNetwork(subnet) {
  try {
    const { stdout } = await execAsync(`arp -a | grep "${subnet}"`, { timeout: 10000 })
    const devices = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i)
      if (!m) continue
      const ip  = m[1]
      const mac = m[2]
      if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '(incomplete)') continue
      devices.push({ ip, mac })
    }
    return devices
  } catch(e) { return [] }
}

async function runTests() {
  const log = loadLog()
  const timestamp = new Date().toISOString()
  const altaDevices = await scanNetwork('192.168.1.')
  const tmobDevices = await scanNetwork('192.168.12.')
  console.log(`AltaFiber devices: ${altaDevices.length} | T-Mobile devices: ${tmobDevices.length}`)
  const entry = { timestamp, results: {}, devices: { altafiber: altaDevices, tmobile: tmobDevices } }

  for (const [key, iface] of Object.entries(INTERFACES)) {
    entry.results[key] = await runSpeedTest(iface)
    await new Promise(r => setTimeout(r, 5000)) // wait between tests
  }

  log.tests.push(entry)
  // Keep last 500 tests
  if (log.tests.length > 500) log.tests = log.tests.slice(-500)
  saveLog(log)
  console.log(`Saved. Total tests: ${log.tests.length}`)
}

function startDashboard() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/speed') { res.writeHead(404); res.end(); return }
    const log = loadLog()
    const tests = log.tests || []
    const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

    // Calculate stats
    function stats(key) {
      const valid = tests.filter(t => t.results[key]?.download != null)
      if (!valid.length) return { avg_down: 0, avg_up: 0, avg_ping: 0, min_down: 0, max_down: 0, count: 0 }
      const downs  = valid.map(t => t.results[key].download)
      const ups    = valid.map(t => t.results[key].upload)
      const pings  = valid.map(t => t.results[key].ping)
      return {
        avg_down: (downs.reduce((a,b)=>a+b,0)/downs.length).toFixed(1),
        avg_up:   (ups.reduce((a,b)=>a+b,0)/ups.length).toFixed(1),
        avg_ping: (pings.reduce((a,b)=>a+b,0)/pings.length).toFixed(1),
        min_down: Math.min(...downs).toFixed(1),
        max_down: Math.max(...downs).toFixed(1),
        count: valid.length
      }
    }

    const alta = stats('altafiber')
    const tmob = stats('tmobile')
    const last = tests[tests.length - 1]
    const lastAlta = last?.results?.altafiber
    const lastTmob = last?.results?.tmobile
    const lastTime = last ? new Date(last.timestamp).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }) : 'Never'

    // Chart data - last 20 tests
    // Device history - unique devices seen on each network
    const altaDeviceSeen = {}
    const tmobDeviceSeen = {}
    for (const t of tests) {
      for (const d of (t.devices?.altafiber || [])) {
        if (!altaDeviceSeen[d.mac]) altaDeviceSeen[d.mac] = { ...d, firstSeen: t.timestamp, lastSeen: t.timestamp, count: 0 }
        altaDeviceSeen[d.mac].lastSeen = t.timestamp
        altaDeviceSeen[d.mac].count++
      }
      for (const d of (t.devices?.tmobile || [])) {
        if (!tmobDeviceSeen[d.mac]) tmobDeviceSeen[d.mac] = { ...d, firstSeen: t.timestamp, lastSeen: t.timestamp, count: 0 }
        tmobDeviceSeen[d.mac].lastSeen = t.timestamp
        tmobDeviceSeen[d.mac].count++
      }
    }

    // Look up device names from devices.json
    let deviceNames = {}
    try {
      const devReg = JSON.parse(readFileSync('/Users/garyscudder/epg/devices.json', 'utf-8')).devices
      devReg.forEach(d => { deviceNames[d.mac.toLowerCase()] = d.name })
    } catch(e) {}

    function deviceName(mac) {
      return deviceNames[mac.toLowerCase()] || deviceNames[mac] || 'Unknown'
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })
    }

    const altaDeviceRows = Object.values(altaDeviceSeen).map(d =>
      `<tr><td>${deviceName(d.mac)}</td><td style="font-size:10px;color:#64748b">${d.mac}</td><td>${d.ip}</td><td>${formatTime(d.lastSeen)}</td><td>${d.count}</td></tr>`
    ).join('')

    const tmobDeviceRows = Object.values(tmobDeviceSeen).map(d =>
      `<tr><td>${deviceName(d.mac)}</td><td style="font-size:10px;color:#64748b">${d.mac}</td><td>${d.ip}</td><td>${formatTime(d.lastSeen)}</td><td>${d.count}</td></tr>`
    ).join('')

    const recent = tests.slice(-20)
    const labels = recent.map(t => new Date(t.timestamp).toLocaleString('en-US', { month:'numeric', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true }))
    const altaDowns = recent.map(t => t.results.altafiber?.download ?? null)
    const tmobDowns = recent.map(t => t.results.tmobile?.download ?? null)

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="300">
<title>Speed Monitor</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"></script>
<style>
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:16px}
  h1{color:#7c6af7;margin:0 0 4px;font-size:22px}
  .sub{color:#64748b;font-size:12px;margin-bottom:20px}
  h2{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px}
  .card{background:#1e293b;border-radius:12px;padding:14px;border:1px solid #334155}
  .card-title{font-size:13px;font-weight:700;margin-bottom:10px}
  .alta{color:#7c6af7} .tmob{color:#f7c26a}
  .stat{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}
  .stat-label{color:#64748b}
  .stat-value{font-weight:600}
  .big{font-size:22px;font-weight:800;margin-bottom:4px}
  .chart-wrap{background:#1e293b;border-radius:12px;padding:14px;border:1px solid #334155;margin-bottom:20px}
  .winner{background:#4ade8022;border:1px solid #4ade8044;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:20px}
</style>
</head>
<body>
<h1>📡 Speed Monitor</h1>
<div class="sub">Updated: ${now} · ${tests.length} tests total · Last test: ${lastTime}</div>

<div class="winner">
  🏆 <strong>AltaFiber leads</strong> — ${alta.avg_down} vs ${tmob.avg_down} Mbps avg download
</div>

<h2>Latest Test</h2>
<div class="grid">
  <div class="card">
    <div class="card-title alta">AltaFiber</div>
    <div class="big alta">${lastAlta?.download?.toFixed(1) ?? '--'} <small>Mbps ↓</small></div>
    <div class="stat"><span class="stat-label">Upload</span><span class="stat-value">${lastAlta?.upload?.toFixed(1) ?? '--'} Mbps</span></div>
    <div class="stat"><span class="stat-label">Ping</span><span class="stat-value">${lastAlta?.ping?.toFixed(1) ?? '--'} ms</span></div>
  </div>
  <div class="card">
    <div class="card-title tmob">T-Mobile</div>
    <div class="big tmob">${lastTmob?.download?.toFixed(1) ?? '--'} <small>Mbps ↓</small></div>
    <div class="stat"><span class="stat-label">Upload</span><span class="stat-value">${lastTmob?.upload?.toFixed(1) ?? '--'} Mbps</span></div>
    <div class="stat"><span class="stat-label">Ping</span><span class="stat-value">${lastTmob?.ping?.toFixed(1) ?? '--'} ms</span></div>
  </div>
</div>

<h2>Averages (${alta.count} tests)</h2>
<div class="grid">
  <div class="card">
    <div class="card-title alta">AltaFiber</div>
    <div class="stat"><span class="stat-label">Avg Download</span><span class="stat-value alta">${alta.avg_down} Mbps</span></div>
    <div class="stat"><span class="stat-label">Avg Upload</span><span class="stat-value">${alta.avg_up} Mbps</span></div>
    <div class="stat"><span class="stat-label">Avg Ping</span><span class="stat-value">${alta.avg_ping} ms</span></div>
    <div class="stat"><span class="stat-label">Peak Download</span><span class="stat-value">${alta.max_down} Mbps</span></div>
    <div class="stat"><span class="stat-label">Min Download</span><span class="stat-value">${alta.min_down} Mbps</span></div>
  </div>
  <div class="card">
    <div class="card-title tmob">T-Mobile</div>
    <div class="stat"><span class="stat-label">Avg Download</span><span class="stat-value tmob">${tmob.avg_down} Mbps</span></div>
    <div class="stat"><span class="stat-label">Avg Upload</span><span class="stat-value">${tmob.avg_up} Mbps</span></div>
    <div class="stat"><span class="stat-label">Avg Ping</span><span class="stat-value">${tmob.avg_ping} ms</span></div>
    <div class="stat"><span class="stat-label">Peak Download</span><span class="stat-value">${tmob.max_down} Mbps</span></div>
    <div class="stat"><span class="stat-label">Min Download</span><span class="stat-value">${tmob.min_down} Mbps</span></div>
  </div>
</div>

<h2>Download Speed History</h2>
<div class="chart-wrap">
  <canvas id="chart" height="200"></canvas>
</div>

<script>
new Chart(document.getElementById('chart'), {
  type: 'line',
  data: {
    labels: ${JSON.stringify(labels)},
    datasets: [
      { label: 'AltaFiber', data: ${JSON.stringify(altaDowns)}, borderColor: '#7c6af7', backgroundColor: '#7c6af722', tension: 0.3, fill: true },
      { label: 'T-Mobile',  data: ${JSON.stringify(tmobDowns)}, borderColor: '#f7c26a', backgroundColor: '#f7c26a22', tension: 0.3, fill: true },
    ]
  },
  options: {
    responsive: true,
    scales: {
      x: { ticks: { color: '#64748b', maxRotation: 45, font: { size: 9 } }, grid: { color: '#1e293b' } },
      y: { ticks: { color: '#64748b' }, grid: { color: '#334155' }, title: { display: true, text: 'Mbps', color: '#64748b' } }
    },
    plugins: { legend: { labels: { color: '#e2e8f0' } } }
  }
})
</script>
<h2>AltaFiber Connected Devices</h2>
<div class="chart-wrap">
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    <tr><th style="text-align:left;color:#64748b;padding:4px">Name</th><th style="text-align:left;color:#64748b;padding:4px">MAC</th><th style="text-align:left;color:#64748b;padding:4px">IP</th><th style="text-align:left;color:#64748b;padding:4px">Last Seen</th><th style="text-align:left;color:#64748b;padding:4px">Seen</th></tr>
    \${altaDeviceRows}
  </table>
</div>

<h2>T-Mobile Connected Devices</h2>
<div class="chart-wrap">
  <table style="width:100%;font-size:12px;border-collapse:collapse">
    <tr><th style="text-align:left;color:#64748b;padding:4px">Name</th><th style="text-align:left;color:#64748b;padding:4px">MAC</th><th style="text-align:left;color:#64748b;padding:4px">IP</th><th style="text-align:left;color:#64748b;padding:4px">Last Seen</th><th style="text-align:left;color:#64748b;padding:4px">Seen</th></tr>
    \${tmobDeviceRows}
  </table>
</div>

</body>
</html>`

    res.writeHead(200, {'Content-Type':'text/html'})
    res.end(html)
  })
  server.listen(5560, () => console.log('Speed dashboard at http://192.168.1.190:5560'))
}

// Run immediately then at random intervals (15-45 min)
async function main() {
  console.log('Speed Monitor starting...')
  startDashboard()
  await runTests()

  function scheduleNext() {
    const minutes = 15 + Math.floor(Math.random() * 30)
    console.log(`Next test in ${minutes} minutes`)
    setTimeout(async () => {
      await runTests()
      scheduleNext()
    }, minutes * 60 * 1000)
  }
  scheduleNext()
}

main()
