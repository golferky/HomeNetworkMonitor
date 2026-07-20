import { RingApi } from 'ring-client-api'
import nodemailer from 'nodemailer'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import dgram from 'dgram'
import http from 'http'
import { promisify } from 'util'

const execAsync = promisify(exec)
const WATCHER_VERSION = '2026.06.29.7'
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
const HUE_ACCESS_TOKEN  = process.env.HUE_ACCESS_TOKEN
const HUE_REFRESH_TOKEN = process.env.HUE_REFRESH_TOKEN
const HUE_CLIENT_ID     = process.env.HUE_CLIENT_ID
const HUE_CLIENT_SECRET = process.env.HUE_CLIENT_SECRET
const SMARTTHINGS_TOKEN = process.env.SMARTTHINGS_TOKEN
const ST_TIMEOUT_SECONDS = parseInt(process.env.HOME_ST_TIMEOUT_SECONDS ?? '20', 10)
const RANGE_ALERT_MINUTES = parseInt(process.env.HOME_RANGE_ALERT_MINUTES ?? '60', 10)
const LG_TIMEOUT_SECONDS  = parseInt(process.env.HOME_LG_TIMEOUT_SECONDS ?? '10', 10)
const LG_SSDP_WAIT_MS     = parseInt(process.env.HOME_LG_SSDP_WAIT_MS ?? '3000', 10)

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

let hueTokenCache = {
  accessToken:  process.env.HUE_ACCESS_TOKEN  ?? null,
  refreshToken: process.env.HUE_REFRESH_TOKEN ?? null,
}

async function refreshHueToken() {
  if (!HUE_CLIENT_ID || !HUE_CLIENT_SECRET || !hueTokenCache.refreshToken) return false
  try {
    const resp = await fetch('https://api.meethue.com/v2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${HUE_CLIENT_ID}:${HUE_CLIENT_SECRET}`).toString('base64'),
      },
      body: `grant_type=refresh_token&refresh_token=${hueTokenCache.refreshToken}`,
    })
    const data = await resp.json()
    if (data.access_token) {
      hueTokenCache.accessToken  = data.access_token
      hueTokenCache.refreshToken = data.refresh_token ?? hueTokenCache.refreshToken
      // Save new tokens to .env
      const envPath = new URL('.env', import.meta.url).pathname
      if (existsSync(envPath)) {
        let env = readFileSync(envPath, 'utf-8')
        env = env.replace(/HUE_ACCESS_TOKEN=.*/, `HUE_ACCESS_TOKEN=${data.access_token}`)
        if (data.refresh_token) env = env.replace(/HUE_REFRESH_TOKEN=.*/, `HUE_REFRESH_TOKEN=${data.refresh_token}`)
        writeFileSync(envPath, env)
      }
      console.log('Hue token refreshed.')
      return true
    }
  } catch (e) {
    console.warn(`Hue token refresh failed: ${e.message}`)
  }
  return false
}

async function collectHueEvents() {
  if (!hueTokenCache.accessToken || !HUE_USERNAME) return []

  try {
    const resp = await fetch(
      `https://api.meethue.com/route/api/${HUE_USERNAME}/lights`,
      { headers: { 'Authorization': `Bearer ${hueTokenCache.accessToken}` } }
    )

    // Token expired — try refresh
    if (resp.status === 401) {
      const refreshed = await refreshHueToken()
      if (!refreshed) return []
      return collectHueEvents()
    }

    const lights = await resp.json()
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
  } catch (e) {
    throw new Error(`Hue remote API failed: ${e.message}`)
  }
}

async function collectSmartThingsEvents() {
  if (!SMARTTHINGS_TOKEN) return []

  const response = await fetch('https://api.smartthings.com/v1/devices', {
    headers: { 'Authorization': `Bearer ${SMARTTHINGS_TOKEN}` }
  })
  const data = await response.json()
  const devices = data.items || []
  const items = []

  for (const device of devices) {
    const category = (device.components?.[0]?.categories?.[0]?.name || '').toLowerCase()

    // Only track thermostat and range/oven
    const isThermo = category.includes('thermostat')
    const isRange  = category.includes('range') || category.includes('oven') ||
                     device.label?.toLowerCase().includes('range') ||
                     device.label?.toLowerCase().includes('oven')
    if (!isThermo && !isRange) continue

    // Fetch device status
    const statusResp = await fetch(
      `https://api.smartthings.com/v1/devices/${device.deviceId}/status`,
      { headers: { 'Authorization': `Bearer ${SMARTTHINGS_TOKEN}` } }
    )
    const statusData = await statusResp.json()
    const main = statusData?.components?.main

    if (isRange) {
      const ovenMode = main?.ovenOperatingState?.machineState?.value
      // Only treat as 'on' if we have a definitive active state
      const activeStates = ['running', 'heating', 'preheating', 'delayed start', 'oven on']
      const state = ovenMode && activeStates.some(s => ovenMode.toLowerCase().includes(s)) ? 'on' : 'off'
      items.push({
        key: `smartthings:range:${device.deviceId}`.toLowerCase(),
        source: 'SmartThings',
        category: 'Light',
        name: device.label ?? 'Range',
        state,
      })
    }

    if (isThermo) {
      const mode        = main?.thermostatMode?.thermostatMode?.value ?? 'unknown'
      const setpoint    = main?.thermostatHeatingSetpoint?.heatingSetpoint?.value ??
                          main?.thermostatCoolingSetpoint?.coolingSetpoint?.value
      const temp        = main?.temperatureMeasurement?.temperature?.value
      const state       = `${mode}${setpoint ? ' ' + Math.round(setpoint) + 'F' : ''}${temp ? ' (' + Math.round(temp) + 'F)' : ''}`
      items.push({
        key: `smartthings:thermostat:${device.deviceId}`.toLowerCase(),
        source: 'SmartThings',
        category: 'Sensor',
        name: device.label ?? 'Thermostat',
        state,
      })
    }

    await new Promise(r => setTimeout(r, 200))
  }

  return items
}

// ─── Network Presence Monitor ───────────────────────────────────────────────

import { readFileSync as _readFileSync } from 'fs'

function loadDeviceRegistry() {
  try {
    const p = new URL('devices.json', import.meta.url).pathname
    return JSON.parse(readFileSync(p, 'utf-8')).devices ?? []
  } catch { return [] }
}

async function pingDevice(ip) {
  // Try twice with longer timeout before declaring offline
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await execAsync(`ping -c 1 -W 3 ${ip}`, { timeout: 5000 })
      if (stdout.includes('1 packets received') || stdout.includes('1 received')) return true
    } catch {}
    if (attempt === 0) await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

// Track consecutive failures to avoid false offline alerts
const pingFailures = new Map()

async function pingDeviceWithHysteresis(ip, name) {
  const online = await pingDevice(ip)
  if (!online) {
    const failures = (pingFailures.get(ip) ?? 0) + 1
    pingFailures.set(ip, failures)
    // Only report offline after 3 consecutive failures (~3 minutes)
    return failures >= 3 ? false : null  // null = skip this poll
  } else {
    pingFailures.delete(ip)
    return true
  }
}

async function collectPresenceEvents() {
  const devices = loadDeviceRegistry().filter(d => d.notify)
  if (devices.length === 0) return []

  const items = []
  for (const device of devices) {
    const online = await pingDeviceWithHysteresis(device.ip, device.name)
    if (online === null) continue  // skip this poll - not enough failures yet
    items.push({
      key: `presence:${device.mac}`.toLowerCase(),
      source: 'Network',
      category: 'Sensor',
      name: device.name,
      state: online ? 'active' : 'clear',
    })
  }
  return items
}

// Cache discovered LG TV IPs across polls
const lgTvCache = new Map()  // ip -> { name, ip }

async function discoverLgTvs() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const found = new Map()

    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
      'HOST: 239.255.255.250:1900\r\n' +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      'ST: urn:lge-com:service:webos-second-screen:1\r\n\r\n'
    )

    socket.on('message', (buf, rinfo) => {
      const text = buf.toString()
      if (text.includes('lge') || text.includes('LG') || text.includes('webos')) {
        if (!found.has(rinfo.address)) {
          found.set(rinfo.address, { ip: rinfo.address, name: `LG TV (${rinfo.address})` })
        }
      }
    })

    socket.on('error', () => { try { socket.close() } catch {} resolve([]) })

    socket.bind(() => {
      try {
        socket.setBroadcast(true)
        socket.send(msg, 0, msg.length, 1900, '239.255.255.250')
      } catch (e) {
        socket.close()
        resolve([])
        return
      }
      setTimeout(() => {
        try { socket.close() } catch {}
        resolve([...found.values()])
      }, LG_SSDP_WAIT_MS)
    })
  })
}

async function fetchLgTvState(tv) {
  // LG WebOS uses port 3000 for REST-like status
  const response = await fetch(`http://${tv.ip}:3000/`, {
    signal: AbortSignal.timeout(LG_TIMEOUT_SECONDS * 1000)
  })
  // If it responds, TV is on
  return response.ok ? 'on' : 'off'
}

async function collectLgTvEvents() {
  // Re-discover periodically — every 10 polls (~10 min)
  if (lgTvCache.size === 0) {
    const tvs = await discoverLgTvs()
    tvs.forEach(tv => lgTvCache.set(tv.ip, tv))
    if (tvs.length > 0) {
      console.log(`LG TVs discovered: ${tvs.map(t => t.ip).join(', ')}`)
    }
  }

  if (lgTvCache.size === 0) return []

  const items = []
  for (const tv of lgTvCache.values()) {
    try {
      const state = await fetchLgTvState(tv)
      items.push({
        key: `lg:tv:${tv.ip}`.toLowerCase(),
        source: 'LG',
        category: 'Light',
        name: tv.name,
        state,
      })
    } catch {
      // TV unreachable — assume off
      items.push({
        key: `lg:tv:${tv.ip}`.toLowerCase(),
        source: 'LG',
        category: 'Light',
        name: tv.name,
        state: 'off',
      })
    }
  }
  return items
}

async function collectAllItems(ringApi) {
  const hueWebhookItems = await collectHueWebhookEvents()
  const [ringItems, goveeItems, hueItems, stItems, lgItems, presenceItems] = await Promise.all([
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
    withTimeout(collectSmartThingsEvents(), ST_TIMEOUT_SECONDS * 1000, 'SmartThings collection').catch(err => {
      console.log(`SmartThings skipped: ${err.message}`)
      return []
    }),
    withTimeout(collectLgTvEvents(), (LG_TIMEOUT_SECONDS + LG_SSDP_WAIT_MS / 1000 + 2) * 1000, 'LG TV collection').catch(err => {
      console.log(`LG TV skipped: ${err.message}`)
      return []
    }),
    withTimeout(collectPresenceEvents(), 60000, 'Presence collection').catch(err => {
      console.log(`Presence skipped: ${err.message}`)
      return []
    }),
  ])

  return [...ringItems, ...goveeItems, ...hueItems, ...stItems, ...lgItems, ...hueWebhookItems, ...presenceItems]
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
  } else if (event.source === 'Network') {
    action = event.state === 'active' ? 'came online' : 'went offline'
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

const HUE_WEBHOOK_PORT = parseInt(process.env.HUE_WEBHOOK_PORT ?? '5555', 10)
const pendingHueEvents = []

function startHueWebhookListener() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hue-event') {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        const event = JSON.parse(body)
        // event: { name, state } e.g. { name: "Living Room", state: "on" }
        pendingHueEvents.push({
          key: `hue:webhook:${event.name}`.toLowerCase().replace(/\s+/g, ':'),
          source: 'Hue',
          category: 'Light',
          name: event.name,
          state: event.state,
        })
        console.log(`Hue webhook received: ${event.name} -> ${event.state}`)
        res.writeHead(200)
        res.end('ok')
      } catch (e) {
        res.writeHead(400)
        res.end('bad request')
      }
    })
  })
  server.listen(HUE_WEBHOOK_PORT, () => {
    console.log(`Hue webhook listener on port ${HUE_WEBHOOK_PORT}`)
  })
}

async function collectHueWebhookEvents() {
  if (pendingHueEvents.length === 0) return []
  const events = [...pendingHueEvents]
  pendingHueEvents.length = 0
  return events
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
  if (!RUN_ONCE) startHueWebhookListener()

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
