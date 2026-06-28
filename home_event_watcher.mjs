import { RingApi } from 'ring-client-api'
import nodemailer from 'nodemailer'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const WATCHER_VERSION = '2026.06.28.1'
const TOKEN_FILE = 'ring_token.json'
const HISTORY_FILE = 'home_event_history.json'
const ALERT_ENV_FILES = ['ring_battery_alert.env', '.env']
const GOVEE_API_BASE = process.env.GOVEE_API_BASE ?? 'https://developer-api.govee.com/v1'
const INTERVAL_SECONDS = parseInt(process.env.HOME_WATCH_INTERVAL_SECONDS ?? '60', 10)
const CAUSE_WINDOW_SECONDS = parseInt(process.env.HOME_CAUSE_WINDOW_SECONDS ?? '120', 10)
const HISTORY_KEEP_DAYS = parseInt(process.env.HOME_EVENT_KEEP_DAYS ?? '30', 10)
const RING_TIMEOUT_SECONDS = parseInt(process.env.HOME_RING_TIMEOUT_SECONDS ?? '35', 10)
const GOVEE_TIMEOUT_SECONDS = parseInt(process.env.HOME_GOVEE_TIMEOUT_SECONDS ?? '25', 10)
const HUE_TIMEOUT_SECONDS = parseInt(process.env.HOME_HUE_TIMEOUT_SECONDS ?? '15', 10)
const SEND_ALERTS = !process.argv.includes('--no-alert') && process.env.HOME_EVENT_ALERTS !== '0'
const RUN_ONCE = process.argv.includes('--once')
const IGNORED_LIGHT_STATE_KEYS = new Set()

function loadAlertEnv() {
  for (const file of ALERT_ENV_FILES) {
    if (!existsSync(file)) continue

    for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!match) continue

      const key = match[1]
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = value
    }
  }
}

loadAlertEnv()

const GMAIL_USER = process.env.GMAIL_USER
const GMAIL_PASS = process.env.GMAIL_PASS
const SMS_TO = process.env.HOME_EVENT_SMS_TO ?? process.env.RING_BATTERY_SMS_TO ?? process.env.SMS_TO ?? '8599628088@tmomail.net'
const GOVEE_API_KEY = process.env.GOVEE_API_KEY
const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP
const HUE_USERNAME = process.env.HUE_USERNAME ?? process.env.HUE_API_KEY

async function loadToken() {
  const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'))
  return data.refreshToken ?? data
}

function saveToken(token) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: token }))
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return { states: {}, events: [] }

  try {
    const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
    return {
      states: history.states ?? {},
      events: Array.isArray(history.events) ? history.events : [],
    }
  } catch (err) {
    console.warn(`Could not read ${HISTORY_FILE}: ${err.message}`)
    return { states: {}, events: [] }
  }
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

function deviceKey(device) {
  return `${device.category}:${device.name}`.toLowerCase()
}

function detectOpenState(data) {
  const checks = [
    data?.faulted,
    data?.open,
    data?.opened,
    data?.isOpen,
    data?.motionDetected,
    data?.motion,
    data?.motionStatus,
    data?.status,
    data?.state,
  ]

  for (const value of checks) {
    if (value === true) return 'active'
    if (value === false) return 'clear'
    if (typeof value !== 'string') continue

    const normalized = value.toLowerCase()
    if (['open', 'opened', 'active', 'motion', 'detected', 'faulted'].includes(normalized)) return 'active'
    if (['closed', 'clear', 'inactive', 'idle', 'ok'].includes(normalized)) return 'clear'
  }

  return null
}

function detectPowerState(data) {
  const checks = [
    data?.on,
    data?.isOn,
    data?.power,
    data?.powerState,
    data?.switch,
    data?.state,
    data?.status,
    data?.led_status,
    data?.lightMode,
  ]

  for (const value of checks) {
    if (value === true) return 'on'
    if (value === false) return 'off'
    if (typeof value !== 'string') continue

    const normalized = value.toLowerCase()
    if (['on', 'enabled', 'active', 'true', '1'].includes(normalized)) return 'on'
    if (['off', 'disabled', 'inactive', 'false', '0'].includes(normalized)) return 'off'
  }

  return null
}

async function collectRingEvents(ringApi) {
  const items = []
  const locations = await ringApi.getLocations()

  for (const location of locations) {
    let devices = []
    try {
      devices = await location.getDevices()
    } catch {
      continue
    }

    for (const device of devices) {
      const data = device.data
      const name = data.name ?? data.deviceType ?? 'Unknown'
      const type = data.deviceType ?? ''

      let category = 'Sensor'
      if (type.includes('light') || type.includes('beam')) category = 'Light'
      if (type.includes('contact')) category = 'Contact'
      if (type.includes('motion')) category = 'Motion'

      if (category === 'Light') {
        const state = detectPowerState(data)
        const key = `ring:${deviceKey({ category, name })}`
        if (state && !IGNORED_LIGHT_STATE_KEYS.has(key)) {
          items.push({ key, source: 'Ring', category, name, state })
        }
      }

      if (category === 'Contact' || category === 'Motion') {
        const state = detectOpenState(data)
        if (state) {
          items.push({
            key: `ring:${deviceKey({ category, name })}`,
            source: 'Ring',
            category,
            name,
            state,
          })
        }
      }
    }
  }

  return items
}

async function fetchGoveeJson(path, query = {}) {
  const url = new URL(`${GOVEE_API_BASE}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    headers: { 'Govee-API-Key': GOVEE_API_KEY },
  })

  const body = await response.text()
  let json = {}
  try {
    json = body ? JSON.parse(body) : {}
  } catch {
    json = { message: body }
  }

  if (!response.ok || json.code !== 200) {
    throw new Error(`Govee ${path} failed: ${response.status} ${json.message ?? body}`)
  }

  return json.data
}

function parseGoveeProperties(properties = []) {
  const state = { powerState: '' }

  for (const property of properties) {
    const [name, value] = Object.entries(property)[0] ?? []
    if (name === 'powerState') state.powerState = String(value).toLowerCase()
  }

  return state
}

async function collectGoveeEvents() {
  if (!GOVEE_API_KEY) return []

  const data = await fetchGoveeJson('/devices')
  const devices = Array.isArray(data.devices) ? data.devices : []
  const items = []

  for (const device of devices) {
    const stateData = await fetchGoveeJson('/devices/state', {
      device: device.device,
      model: device.model,
    })
    const state = parseGoveeProperties(stateData.properties)
    if (state.powerState) {
      items.push({
        key: `govee:${device.device || device.deviceName}`.toLowerCase(),
        source: 'Govee',
        category: 'Light',
        name: device.deviceName ?? device.device ?? 'Govee Light',
        state: state.powerState,
      })
    }
    await wait(250)
  }

  return items
}

async function fetchHueJson(path) {
  if (!HUE_BRIDGE_IP || !HUE_USERNAME) return null

  const response = await fetch(`http://${HUE_BRIDGE_IP}/api/${HUE_USERNAME}${path}`)
  const body = await response.text()
  let json

  try {
    json = body ? JSON.parse(body) : {}
  } catch {
    throw new Error(`Hue returned non-JSON response: ${body}`)
  }

  if (!response.ok) {
    throw new Error(`Hue ${path} failed: ${response.status} ${body}`)
  }

  if (Array.isArray(json) && json[0]?.error) {
    throw new Error(`Hue ${path} failed: ${json[0].error.description}`)
  }

  return json
}

async function collectHueEvents() {
  if (!HUE_BRIDGE_IP || !HUE_USERNAME) return []

  const lights = await fetchHueJson('/lights')
  const items = []

  for (const [id, light] of Object.entries(lights ?? {})) {
    if (!light?.state || light.state.on == null) continue

    items.push({
      key: `hue:light:${light.uniqueid ?? id}`.toLowerCase(),
      source: 'Hue',
      category: 'Light',
      name: light.name ?? `Hue Light ${id}`,
      state: light.state.on ? 'on' : 'off',
    })
  }

  return items
}

async function collectAllItems(ringApi) {
  const [ringItems, goveeItems, hueItems] = await Promise.all([
    withTimeout(collectRingEvents(ringApi), RING_TIMEOUT_SECONDS * 1000, 'Ring collection').catch(err => {
      console.log(`Ring skipped: ${err.message}`)
      return []
    }),
    withTimeout(collectGoveeEvents(), GOVEE_TIMEOUT_SECONDS * 1000, 'Govee collection').catch(err => {
      console.log(`Govee skipped: ${err.message}`)
      return []
    }),
    withTimeout(collectHueEvents(), HUE_TIMEOUT_SECONDS * 1000, 'Hue collection').catch(err => {
      console.log(`Hue skipped: ${err.message}`)
      return []
    }),
  ])

  return [...ringItems, ...goveeItems, ...hueItems]
}

function findLikelyCause(history, now, lightKey) {
  const cutoff = now.getTime() - CAUSE_WINDOW_SECONDS * 1000
  return [...history.events]
    .reverse()
    .find(event =>
      event.at &&
      new Date(event.at).getTime() >= cutoff &&
      event.key !== lightKey &&
      event.kind === 'sensor_triggered'
    )
}

function updateTimeline(items) {
  const history = loadHistory()
  const now = new Date()
  const events = []

  for (const item of items) {
    const previous = history.states[item.key]
    if (!previous) {
      history.states[item.key] = {
        source: item.source,
        category: item.category,
        name: item.name,
        state: item.state,
        lastSeenAt: now.toISOString(),
        lastChangedAt: now.toISOString(),
      }
      continue
    }

    if (previous.state !== item.state) {
      const event = {
        at: now.toISOString(),
        key: item.key,
        source: item.source,
        category: item.category,
        name: item.name,
        previousState: previous.state,
        state: item.state,
        kind: item.category === 'Light' ? 'light_changed' : 'sensor_changed',
      }

      if (item.category !== 'Light' && item.state === 'active') {
        event.kind = 'sensor_triggered'
      }

      if (item.category === 'Light' && item.state === 'on') {
        const cause = findLikelyCause(history, now, item.key)
        if (cause) {
          event.likelyCause = {
            at: cause.at,
            source: cause.source,
            category: cause.category,
            name: cause.name,
            state: cause.state,
          }
        }
      }

      history.events.push(event)
      events.push(event)
    }

    history.states[item.key] = {
      source: item.source,
      category: item.category,
      name: item.name,
      state: item.state,
      lastSeenAt: now.toISOString(),
      lastChangedAt: previous.state === item.state ? previous.lastChangedAt : now.toISOString(),
    }
  }

  const cutoff = now.getTime() - HISTORY_KEEP_DAYS * 86400000
  history.events = history.events.filter(event => event.at && new Date(event.at).getTime() >= cutoff)
  saveHistory(history)

  return events
}

function friendlyName(source, name) {
  // Avoid "Govee Govee Smart LED desk" when name already starts with source name
  const sourceLower = source.toLowerCase()
  const nameLower = name.toLowerCase()
  return nameLower.startsWith(sourceLower) ? name : `${source} ${name}`
}

function formatEvent(event) {
  const time = new Date(event.at).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    hour12: true,
  })

  const displayName = friendlyName(event.source, event.name)

  let action
  if (event.category === 'Light') {
    action = event.state === 'on' ? 'turned on' : 'turned off'
  } else {
    if (event.state === 'active') {
      action = event.name.toLowerCase().includes('motion') ? 'detected motion' : 'was opened'
    } else {
      action = event.name.toLowerCase().includes('motion') ? 'motion cleared' : 'was closed'
    }
  }

  let msg = `${displayName} ${action} at ${time}`

  if (event.likelyCause) {
    const causeTime = new Date(event.likelyCause.at)
    const seconds = Math.max(0, Math.round((new Date(event.at).getTime() - causeTime.getTime()) / 1000))
    const causeName = friendlyName(event.likelyCause.source, event.likelyCause.name)
    msg += `\n  -> likely triggered by ${causeName} ${seconds}s earlier`
  }

  return msg
}

async function sendIMessage(target, message) {
  const escaped = message
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
  const script = `tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy "${target}" of targetService
    send "${escaped}" to targetBuddy
  end tell`
  await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`)
}

async function sendEventAlert(events) {
  const important = events.filter(event => event.category === 'Light' || event.kind === 'sensor_triggered')
  if (important.length === 0) return

  if (!SEND_ALERTS) {
    console.log(`Alerts skipped for ${important.length} event(s).`)
    return
  }

  const title = important.length === 1
    ? `Home Alert: ${friendlyName(important[0].source, important[0].name)}`
    : `Home Alert: ${important.length} events`

  const body = important.map(formatEvent).join('\n')
  const message = `${title}\n${body}`

  // Try iMessage first
  const IMESSAGE_TARGET = process.env.IMESSAGE_TARGET
  if (IMESSAGE_TARGET) {
    try {
      await sendIMessage(IMESSAGE_TARGET, message)
      console.log(`iMessage sent to ${IMESSAGE_TARGET}`)
      return
    } catch (err) {
      console.warn(`iMessage failed: ${err.message} — falling back to SMS`)
    }
  }

  // Fallback: Gmail SMTP to T-Mobile SMS gateway
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.log('Alert skipped: set IMESSAGE_TARGET in .env, or GMAIL_USER+GMAIL_PASS for SMS fallback.')
    return
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  })

  await transporter.sendMail({
    from: GMAIL_USER,
    to: SMS_TO,
    subject: title,
    text: message,
  })

  console.log(`SMS fallback sent to ${SMS_TO}`)
}

async function poll(ringApi) {
  const items = await collectAllItems(ringApi)
  const events = updateTimeline(items)
  const ts = new Date().toLocaleString()
  console.log(`[${ts}] watched ${items.length} item(s), ${events.length} change(s).`)

  for (const event of events) {
    console.log(`  ${formatEvent(event)}`)
  }

  await sendEventAlert(events)
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout(promise, ms, label) {
  let timeout
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout))
}

async function main() {
  console.log(`Home Event Watcher v${WATCHER_VERSION}`)
  console.log(`Polling every ${INTERVAL_SECONDS}s; cause window ${CAUSE_WINDOW_SECONDS}s.`)

  const ringApi = new RingApi({
    refreshToken: await loadToken(),
    cameraStatusPollingSeconds: 20,
    locationModePollingSeconds: 20,
  })

  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken))

  do {
    try {
      await poll(ringApi)
    } catch (err) {
      console.error(`Poll failed: ${err.message}`)
    }

      if (!RUN_ONCE) await wait(INTERVAL_SECONDS * 1000)
    } while (!RUN_ONCE)

  if (RUN_ONCE) process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
