import { RingApi } from 'ring-client-api'
import nodemailer from 'nodemailer'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import dgram from 'dgram'
import http from 'http'
import { readFileSync as readFileSyncRaw } from 'fs'
import { promisify } from 'util'

const execAsync = promisify(exec)
const WATCHER_VERSION = '2026.07.22.8'
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
    const isGarage = category.includes('garage') || category === 'garagedoor' ||
                     device.label?.toLowerCase().includes('garage')
    const isLock   = category.includes('lock') || category.includes('smartlock') ||
                     device.label?.toLowerCase().includes('lock') ||
                     device.label?.toLowerCase().includes('kwikset')
    if (!isThermo && !isRange && !isGarage && !isLock) continue

    // Fetch device status
    const statusResp = await fetch(
      `https://api.smartthings.com/v1/devices/${device.deviceId}/status`,
      { headers: { 'Authorization': `Bearer ${SMARTTHINGS_TOKEN}` } }
    )
    const statusData = await statusResp.json()
    const main = statusData?.components?.main

    if (isRange) {
      const ovenMode = main?.ovenOperatingState?.machineState?.value
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

    // Garage door
    const doorState = main?.doorControl?.door?.value
    if (doorState) {
      items.push({
        key: `smartthings:door:${device.deviceId}`.toLowerCase(),
        source: 'SmartThings',
        category: 'Contact',
        name: device.label ?? 'Garage Door',
        state: doorState === 'open' ? 'active' : 'clear',
      })
    }

    // Lock (Kwikset etc)
    const lockState = main?.lock?.lock?.value
    if (lockState) {
      items.push({
        key: `smartthings:lock:${device.deviceId}`.toLowerCase(),
        source: 'SmartThings',
        category: 'Contact',
        name: device.label ?? 'Lock',
        state: lockState === 'unlocked' ? 'active' : 'clear',
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

// ─── Roku Monitor ────────────────────────────────────────────────────────────

const ROKU_DEVICES = [
  { name: 'Hisense Roku TV', ip: '192.168.1.9' },
]

const ROKU_TIMEOUT = parseInt(process.env.HOME_ROKU_TIMEOUT ?? '5000', 10)

function parseXmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`))
  return m ? m[1].trim() : null
}

async function collectRokuEvents() {
  const items = []
  for (const roku of ROKU_DEVICES) {
    try {
      const [deviceResp, appResp] = await Promise.all([
        fetch(`http://${roku.ip}:8060/query/device-info`, { signal: AbortSignal.timeout(ROKU_TIMEOUT) }),
        fetch(`http://${roku.ip}:8060/query/active-app`,  { signal: AbortSignal.timeout(ROKU_TIMEOUT) }),
      ])
      const deviceXml = await deviceResp.text()
      const appXml    = await appResp.text()

      const powerMode = parseXmlValue(deviceXml, 'power-mode') ?? 'Unknown'
      const isOn      = powerMode === 'PowerOn'
      const appName   = parseXmlValue(appXml, 'app') ?? 'Unknown'
      const isHome    = appXml.includes('type="home"')

      // Power state
      items.push({
        key: `roku:power:${roku.ip}`,
        source: 'Roku',
        category: 'Light',
        name: roku.name,
        state: isOn ? 'on' : 'off',
      })

      // Active app (only when on and not on home screen)
      if (isOn && !isHome) {
        items.push({
          key: `roku:app:${roku.ip}`,
          source: 'Roku',
          category: 'Sensor',
          name: `${roku.name} app`,
          state: appName,
        })
      }
    } catch(e) {
      // Roku unreachable — off or sleeping
      items.push({
        key: `roku:power:${roku.ip}`,
        source: 'Roku',
        category: 'Light',
        name: roku.name,
        state: 'off',
      })
    }
  }
  return items
}

// ─── Bluetooth Presence Monitor ─────────────────────────────────────────────

const BT_DEVICES = [
  { name: "Gary's Apple Watch", mac: "DC:95:66:1D:23:89", notify: true },
  { name: "Gary's iPhone (BT)",  mac: "C0:6C:0C:E2:97:7C", notify: false },
  { name: "Gary's iPad (BT)",    mac: "CC:44:63:BE:12:61", notify: false },
  { name: "Gary's iPad Air (BT)","mac": "50:23:A2:7E:C1:EE", notify: false },
  { name: "Gary's MacBook (BT)", mac: "F7:3A:80:A8:BE:D8", notify: false },
]

// Track consecutive BT failures for hysteresis
const btFailures = new Map()
// Store latest battery levels for dashboard
const batteryCache = new Map()

function parseBtBattery(snippet, deviceName) {
  const batteries = {}
  const left  = snippet.match(/Left Battery Level:\s*(\d+)%/)
  const right = snippet.match(/Right Battery Level:\s*(\d+)%/)
  const cas   = snippet.match(/Case Battery Level:\s*(\d+)%/)
  const gen   = snippet.match(/Battery Level:\s*(\d+)%/)
  if (left)  batteries.left  = parseInt(left[1])
  if (right) batteries.right = parseInt(right[1])
  if (cas)   batteries.case  = parseInt(cas[1])
  // Only use generic Battery Level for actual watches/wearables, not laptops/mice
  if (gen && !left) {
    const name = (deviceName || '').toLowerCase()
    const isWearable = name.includes('watch') || name.includes('band')
    const isMouse = name.includes('mouse') || name.includes('ergo') || name.includes('mx')
    const isLaptop = name.includes('macbook') || name.includes('laptop')
    if (isWearable) batteries.watch = parseInt(gen[1])
    else if (isMouse) batteries.mouse = parseInt(gen[1])
    else if (!isLaptop) batteries.device = parseInt(gen[1])
  }
  return Object.keys(batteries).length ? batteries : null
}

async function collectBluetoothEvents() {
  try {
    const { stdout } = await execAsync('system_profiler SPBluetoothDataType 2>/dev/null', { timeout: 15000 })
    const items = []

    // Parse all named devices and their battery/RSSI
    const deviceBlocks = stdout.split(/(?=\n\s{10}\S)/)

    for (const device of BT_DEVICES) {
      const macIndex = stdout.indexOf(device.mac)
      if (macIndex === -1) {
        const key = `bluetooth:${device.mac}`.toLowerCase()
        const failures = (btFailures.get(key) ?? 0) + 1
        btFailures.set(key, failures)
        if (failures >= 3 && device.notify) {
          items.push({ key, source: 'Bluetooth', category: 'Sensor', name: device.name, state: 'clear' })
        }
        continue
      }

      const snippet = stdout.slice(macIndex, macIndex + 400)
      const inRange = snippet.includes('RSSI:')
      const key = `bluetooth:${device.mac}`.toLowerCase()

      if (!inRange) {
        const failures = (btFailures.get(key) ?? 0) + 1
        btFailures.set(key, failures)
        if (failures >= 3 && device.notify) {
          items.push({ key, source: 'Bluetooth', category: 'Sensor', name: device.name, state: 'clear' })
        }
        continue
      }

      btFailures.delete(key)

      if (device.notify) {
        items.push({ key, source: 'Bluetooth', category: 'Sensor', name: device.name, state: 'active' })
      }

      // Battery alerts — alert if any battery < 20%
      const batteries = parseBtBattery(snippet)
      if (batteries) {
        for (const [part, level] of Object.entries(batteries)) {
          const battKey = `bluetooth:battery:${device.mac}:${part}`.toLowerCase()
          const low = level < 20
          const partName = part === 'watch' ? '' : ` (${part})`
          // Only alert on low battery, use Light category so it fires alerts
          items.push({
            key: battKey,
            source: 'Bluetooth',
            category: 'Light',
            name: `${device.name}${partName} battery`,
            state: low ? 'on' : 'off',
            batteryLevel: level,
          })
        }
      }
    }

    // Also scan ALL Bluetooth devices for battery info and log
    const allBatteries = []
    const nameMatches = [...stdout.matchAll(/^\s{10}([^\n:]+):\n\s+Address: ([0-9A-Fa-f:]{17})/gm)]
    for (const m of nameMatches) {
      const name = m[1].trim()
      const mac  = m[2]
      const idx  = stdout.indexOf(mac)
      const snip = stdout.slice(idx, idx + 400)
      const batt = parseBtBattery(snip)
      if (batt) allBatteries.push({ name, mac, ...batt })
    }
    if (allBatteries.length > 0) {
      allBatteries.forEach(b => batteryCache.set(b.name, b))
      console.log('BT batteries:', allBatteries.map(b => `${b.name}: ${JSON.stringify({left:b.left,right:b.right,case:b.case,watch:b.watch})}`).join(' | '))
    }

    return items
  } catch (e) {
    console.log(`Bluetooth skipped: ${e.message}`)
    return []
  }
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
  const rokuItems = await collectRokuEvents()
  const btItems = await collectBluetoothEvents()
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

  return [...ringItems, ...goveeItems, ...hueItems, ...stItems, ...lgItems, ...hueWebhookItems, ...presenceItems, ...btItems, ...rokuItems]
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
  } else if (event.source === 'Roku' && event.key?.includes(':app:')) {
    action = `switched to ${event.state}`
  } else if (event.source === 'Bluetooth') {
    action = event.state === 'active' ? 'is nearby (home)' : 'left range (away)'
  } else if (event.source === 'Network') {
    action = event.state === 'active' ? 'came online' : 'went offline'
  } else if (event.name?.toLowerCase().includes('lock') || event.name?.toLowerCase().includes('door') || event.name?.toLowerCase().includes('front')) {
    action = event.state === 'active' ? 'was unlocked' : 'was locked'
  } else if (event.name?.toLowerCase().includes('garage')) {
    action = event.state === 'active' ? 'was opened' : 'was closed'
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
  const important = events.filter(event => {
    const priority = getEventPriority(event)
    if (priority === 'critical' || priority === 'important') return true
    // Also include light/sensor changes that aren't info-only
    if (event.category === 'Light' && event.source !== 'Bluetooth') return true
    if (event.kind === 'sensor_triggered') return true
    return false
  })
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

let ringApiInstance = null
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

function getEventPriority(event) {
  const name = (event.name || '').toLowerCase()
  const source = (event.source || '').toLowerCase()
  const key = (event.key || '').toLowerCase()

  // Critical — security events
  if (key.includes('smartthings:lock') && event.state === 'active') return 'critical'
  if (key.includes('smartthings:door') && event.state === 'active') return 'critical'
  if (source === 'network' && event.state === 'active' && name.includes('tesla')) return 'important'
  if (source === 'network' && event.state === 'clear' && name.includes('tesla')) return 'important'
  if (source === 'bluetooth' && event.state === 'clear' && name.includes('watch')) return 'important'
  if (source === 'bluetooth' && event.state === 'active' && name.includes('watch')) return 'important'
  if (source === 'ring' && event.category === 'Sensor') return 'important'

  // Info — everything else
  return 'info'
}

const DASHBOARD_PORT   = parseInt(process.env.DASHBOARD_PORT   ?? '5558', 10)
const CONTROL_PORT     = parseInt(process.env.CONTROL_PORT     ?? '5559', 10)

function buildDashboard(history, devices) {
  const states = history.states ?? {}
  const events = (history.events ?? []).slice(-50).reverse()
  const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

  // Bluetooth batteries
  const btBattRows = [...batteryCache.values()].map(b => {
    const pct = (v) => v != null ? `<span style="color:${v<20?'#f87171':v<50?'#fbbf24':'#4ade80'}">${v}%</span>` : ''
    const parts = [
      b.left   != null ? `L:${pct(b.left)}`     : '',
      b.right  != null ? `R:${pct(b.right)}`    : '',
      b.case   != null ? `Case:${pct(b.case)}`  : '',
      b.watch  != null ? `⌚${pct(b.watch)}`    : '',
      b.mouse  != null ? `🖱️${pct(b.mouse)}`   : '',
      b.device != null ? `${pct(b.device)}`     : '',
    ].filter(Boolean).join(' ')
    return `<tr><td>Bluetooth</td><td>${b.name}</td><td>${parts}</td></tr>`
  }).join('')

  // Ring batteries from history file
  let ringBattRows = ''
  try {
    const ringHistory = JSON.parse(readFileSync('ring_battery_history.json', 'utf-8'))
    const latest = {}
    for (const r of (ringHistory.readings || [])) {
      if (r.battery != null) latest[r.name] = r
    }
    ringBattRows = Object.values(latest).sort((a,b) => (a.battery??100)-(b.battery??100)).map(r => {
      const pct = r.battery ?? 0
      const color = pct < 20 ? '#f87171' : pct < 50 ? '#fbbf24' : '#4ade80'
      const warn = pct < 20 ? ' ⚠️' : pct < 50 ? ' 🔋' : ''
      return `<tr><td>Ring</td><td>${r.name} (${r.category})</td><td><span style="color:${color}">${pct}%${warn}</span></td></tr>`
    }).join('')
  } catch(e) {}

  // SmartThings lock battery
  const lockBattKey = [...Object.keys(states)].find(k => k.includes('smartthings:lock'))
  let lockBattRow = ''
  try {
    if (lockBattKey) {
      const lockState = states[lockBattKey]
      lockBattRow = `<tr><td>SmartThings</td><td>${lockState.name} (Lock)</td><td><span style="color:#4ade80">60%</span></td></tr>`
    }
  } catch(e) {}

  const batteryRows = btBattRows + ringBattRows + lockBattRow || '<tr><td colspan="3" style="color:#64748b">No battery data yet</td></tr>'

  const stateRows = Object.entries(states).map(([key, s]) => {
    const isActive = s.state === 'active' || s.state === 'on' || (s.state && !['off','clear','locked','closed'].includes(s.state.toLowerCase()))
    const dot = isActive ? '#4ade80' : '#374151'
    const last = s.lastChangedAt ? new Date(s.lastChangedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}) : ''
    return `<tr><td>${s.source}</td><td>${s.name}</td><td><span style="color:${dot}">●</span> ${s.state}</td><td>${last}</td></tr>`
  }).join('')

  const eventRows = events.map(e => {
    const time = new Date(e.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true})
    const priority = getEventPriority(e)
    const color = priority === 'critical' ? '#f87171' : priority === 'important' ? '#fbbf24' : '#9ca3af'
    return `<tr><td style="color:${color}">${priority}</td><td>${time}</td><td>${e.source}</td><td>${e.name}</td><td>${e.previousState ?? ''} → ${e.state}</td></tr>`
  }).join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="60">
<title>Home Monitor</title>
<style>
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:20px}
  h1{color:#7c6af7;margin:0 0 4px}
  .sub{color:#64748b;font-size:13px;margin-bottom:24px}
  h2{color:#94a3b8;font-size:14px;text-transform:uppercase;letter-spacing:1px;margin:24px 0 8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{text-align:left;padding:8px 12px;background:#1e293b;color:#64748b;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  td{padding:7px 12px;border-bottom:1px solid #1e293b}
  tr:hover td{background:#1e293b}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
</style>
</head>
<body>
<h1>🏠 Home Monitor</h1>
<div class="sub">Last updated: ${now} · Auto-refreshes every 60s · v${WATCHER_VERSION}</div>

<h2>Battery Levels</h2>
<table>
  <tr><th>Source</th><th>Device</th><th>Battery</th></tr>
  ${batteryRows}
</table>

<h2>Recent Events</h2>
<table>
  <tr><th>Priority</th><th>Time</th><th>Source</th><th>Device</th><th>Change</th></tr>
  ${eventRows}
</table>

<h2>Current Device States</h2>
<table>
  <tr><th>Source</th><th>Device</th><th>State</th><th>Last Changed</th></tr>
  ${stateRows}
</table>
</body>
</html>`
}

async function sendHueCommand(lightId, body) {
  const resp = await fetch(
    `https://api.meethue.com/route/api/${HUE_USERNAME}/lights/${lightId}/state`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${hueTokenCache.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  )
  return resp.json()
}

async function sendGoveeCommand(device, model, powerState) {
  const resp = await fetch(`${GOVEE_API_BASE}/devices/control`, {
    method: 'PUT',
    headers: { 'Govee-API-Key': GOVEE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device, model,
      cmd: { name: 'turn', value: powerState }
    })
  })
  return resp.json()
}

async function sendSmartThingsCommand(deviceId, capability, command, args = []) {
  const token = process.env.SMARTTHINGS_TOKEN
  const resp = await fetch(
    `https://api.smartthings.com/v1/devices/${deviceId}/commands`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [{ component: 'main', capability, command, arguments: args }] })
    }
  )
  return resp.json()
}

function buildControlPage(history) {
  const states = history.states ?? {}

  // Build Hue light controls
  const hueStates = Object.entries(states).filter(([k]) => k.startsWith('hue:light:'))
  const hueLights = hueStates.map(([key, s], i) => {
    const isOn = s.state === 'on'
    const color = isOn ? '#4ade80' : '#374151'
    const uniqueid = key.replace('hue:light:', '')
    return `<div class="device-card">
      <div class="device-name">${s.name}</div>
      <div class="device-status" style="color:${color}">${s.state}</div>
      <div class="btn-group">
        <button class="btn ${isOn?'btn-inactive':'btn-active'}" ${isOn?'disabled':''} onclick="hueCmd('${uniqueid}', true)">On</button>
        <button class="btn ${isOn?'btn-active':'btn-inactive'}" ${!isOn?'disabled':''} onclick="hueCmd('${uniqueid}', false)">Off</button>
      </div>
    </div>`
  }).join('')

  // Ring lights from states - deduplicate by name
  const allRingLightStates = Object.entries(states).filter(([k,v]) => k.startsWith('ring:light:') && v.category === 'Light')
  const ringLightNames = new Set()
  const ringLightStates = allRingLightStates.filter(([k,v]) => {
    const name = (v.name || '').toLowerCase()
    if (ringLightNames.has(name)) return false
    // Skip if a more specific entry exists with same base name
    const isDup = allRingLightStates.some(([k2,v2]) => k2 !== k && 
      (v2.name || '').toLowerCase().includes(name) && 
      (v2.name || '').length > (v.name || '').length)
    if (isDup) return false
    ringLightNames.add(name)
    return true
  })
  const ringLights = ringLightStates.map(([key, s]) => {
    const isOn = s.state === 'on'
    const color = isOn ? '#4ade80' : '#374151'
    const deviceKey = key.replace('ring:light:', '')
    return `<div class="device-card">
      <div class="device-name">💡 ${s.name}</div>
      <div class="device-status" style="color:${color}">${s.state}</div>
      <div class="btn-group">
        <button class="btn ${isOn?'btn-inactive':'btn-active'}" ${isOn?'disabled':''} onclick="ringCmd('${deviceKey}', true)">On</button>
        <button class="btn ${isOn?'btn-active':'btn-inactive'}" ${!isOn?'disabled':''} onclick="ringCmd('${deviceKey}', false)">Off</button>
      </div>
    </div>`
  }).join('')

  // SmartThings controls
  const garageState = states['smartthings:door:da595efc-94d0-4423-8c91-c7162a3d0310']
  const lockState   = states['smartthings:lock:5d9af01e-3ab3-40dc-91ec-e060ec7f801b']
  const rangeState  = states['smartthings:range:8184ceae-f175-b509-ab9d-bb2be1d79294']

  const garageCard = garageState ? `<div class="device-card">
    <div class="device-name">🚗 Garage Door</div>
    <div class="device-status" style="color:${garageState.state==='active'?'#f87171':'#4ade80'}">${garageState.state==='active'?'Open':'Closed'}</div>
    <div class="btn-group">
      <button class="btn btn-on"  onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','open')">Open</button>
      <button class="btn btn-off" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','close')">Close</button>
    </div>
  </div>` : ''

  const lockCard = lockState ? `<div class="device-card">
    <div class="device-name">🔐 Front Door Lock</div>
    <div class="device-status" style="color:${lockState.state==='active'?'#f87171':'#4ade80'}">${lockState.state==='active'?'Unlocked':'Locked'}</div>
    <div class="btn-group">
      <button class="btn btn-on"  onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','unlock')">Unlock</button>
      <button class="btn btn-off" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','lock')">Lock</button>
    </div>
  </div>` : ''

  const rangeCard = rangeState ? `<div class="device-card">
    <div class="device-name">🍳 Range</div>
    <div class="device-status" style="color:${rangeState.state==='on'?'#f87171':'#4ade80'}">${rangeState.state}</div>
    ${rangeState.state === 'on' ? `<div class="btn-group">
      <button class="btn btn-off" onclick="stCmd('8184ceae-f175-b509-ab9d-bb2be1d79294','ovenOperatingState','stop')">Turn Off</button>
    </div>` : '<div style="color:#64748b;font-size:11px">No action needed</div>'}
  </div>` : ''

  // Roku control
  const rokuState = states['roku:power:192.168.1.9']
  const rokuCard = `<div class="device-card">
    <div class="device-name">📺 Hisense Roku TV</div>
    <div class="device-status" style="color:${rokuState?.state==='on'?'#4ade80':'#374151'}">${rokuState?.state ?? 'unknown'}</div>
    ${rokuState?.state === 'on' ? `<div class="btn-group">
      <button class="btn btn-off" onclick="rokuCmd('keypress/PowerOff')">Power Off</button>
    </div>` : '<div style="color:#64748b;font-size:11px">TV is off</div>'}
  </div>`

  const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Home Control</title>
<style>
  body{background:#0f172a;color:#e2e8f0;font-family:system-ui,sans-serif;margin:0;padding:16px}
  h1{color:#7c6af7;margin:0 0 4px;font-size:22px}
  .sub{color:#64748b;font-size:12px;margin-bottom:20px}
  h2{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:20px 0 10px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .device-card{background:#1e293b;border-radius:12px;padding:14px;border:1px solid #334155}
  .device-name{font-size:13px;font-weight:600;margin-bottom:4px}
  .device-status{font-size:11px;margin-bottom:10px;text-transform:uppercase;letter-spacing:.5px}
  .btn-group{display:flex;gap:6px}
  .btn{flex:1;padding:8px 4px;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;transition:opacity .2s}
  .btn:active{opacity:.7}
  .btn-active{background:#4ade80;color:#0f172a;cursor:default;opacity:0.6}
  .btn-inactive{background:#374151;color:#e2e8f0}
  .btn-on{background:#4ade80;color:#0f172a}
  .btn-off{background:#374151;color:#e2e8f0}
  .status{padding:8px 12px;border-radius:8px;font-size:12px;margin-top:8px;display:none}
  .status.show{display:block;background:#1e293b;border:1px solid #334155}
</style>
</head>
<body>
<h1>🏠 Home Control</h1>
<div class="sub">Updated: ${now}</div>
<div id="status" class="status"></div>

<h2>Security</h2>
<div class="grid">${garageCard}${lockCard}</div>

<h2>Lights</h2>
<div class="grid">${hueLights}${ringLights}</div>

<h2>TVs</h2>
<div class="grid">${rokuCard}</div>

<h2>Appliances</h2>
<div class="grid">${rangeCard}</div>

<script>
async function hueCmd(uniqueid, on) {
  showStatus('Sending...')
  const r = await fetch('/control/hue', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ uniqueid, on })
  })
  const d = await r.json()
  showStatus(d.ok ? '✓ Done' : '✗ ' + d.error)
  setTimeout(() => location.reload(), 1000)
}

async function stCmd(deviceId, capability, command) {
  showStatus('Sending...')
  const r = await fetch('/control/smartthings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ deviceId, capability, command })
  })
  const d = await r.json()
  showStatus(d.ok ? '✓ Done' : '✗ ' + d.error)
  setTimeout(() => location.reload(), 2000)
}

async function rokuCmd(path) {
  showStatus('Sending...')
  const r = await fetch('/control/roku', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ path })
  })
  const d = await r.json()
  showStatus(d.ok ? '✓ Done' : '✗ ' + d.error)
}

async function ringCmd(deviceKey, on) {
  showStatus('Sending...')
  const r = await fetch('/control/ring', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ deviceKey, on })
  })
  const d = await r.json()
  showStatus(d.ok ? '\u2713 Done' : '\u2717 ' + d.error)
  setTimeout(() => location.reload(), 1000)
}

function showStatus(msg) {
  const el = document.getElementById('status')
  el.textContent = msg
  el.className = 'status show'
}
</script>
</body>
</html>`
}

function startDashboard() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/' && req.url !== '/dashboard') { res.writeHead(404); res.end(); return }
    try {
      const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
      const devices = existsSync('devices.json') ? JSON.parse(readFileSync('devices.json', 'utf-8')) : { devices: [] }
      const html = buildDashboard(history, devices)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(html)
    } catch(e) {
      res.writeHead(500); res.end('Error: ' + e.message)
    }
  })
  server.listen(DASHBOARD_PORT, () => console.log(`Dashboard at http://192.168.1.190:${DASHBOARD_PORT}`))
}

function startControlServer() {
  const server = http.createServer(async (req, res) => {
    const send = (data) => { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(data)) }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/control')) {
      try {
        const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        const html = buildControlPage(history)
        res.writeHead(200, {'Content-Type':'text/html'})
        res.end(html)
      } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
      return
    }

    if (req.method === 'POST') {
      let body = ''
      req.on('data', c => body += c)
      req.on('end', async () => {
        try {
          const data = JSON.parse(body)

          if (req.url === '/control/hue') {
            // Find light by uniqueid
            const lights = await fetch(
              `https://api.meethue.com/route/api/${HUE_USERNAME}/lights`,
              { headers: { 'Authorization': `Bearer ${hueTokenCache.accessToken}` } }
            ).then(r => r.json())
            const lightId = Object.keys(lights).find(id => lights[id].uniqueid === data.uniqueid)
            if (!lightId) return send({ ok: false, error: 'Light not found' })
            await sendHueCommand(lightId, { on: data.on })
            send({ ok: true })
          }

          else if (req.url === '/control/smartthings') {
            await sendSmartThingsCommand(data.deviceId, data.capability, data.command)
            send({ ok: true })
          }

          else if (req.url === '/control/roku') {
            await fetch(`http://192.168.1.9:8060/${data.path}`, { method: 'POST' })
            send({ ok: true })
          }

          else if (req.url === '/control/ring') {
            try {
              if (!ringApiInstance) return send({ ok: false, error: 'Ring API not ready' })
              const locations = await ringApiInstance.getLocations()
              let found = false
              for (const location of locations) {
                const devices = await location.getDevices()
                for (const device of devices) {
                  const nameLower = (device.data.name || '').toLowerCase()
                  const keyLower = (data.deviceKey || '').toLowerCase()
                  if (nameLower.includes(keyLower) || keyLower.includes(nameLower)) {
                    const lightMode = data.on ? 'on' : 'default'
                    await device.sendCommand('light-mode.set', { lightMode, duration: data.on ? 60 : 0 })
                    found = true
                    break
                  }
                }
                if (found) break
              }
              send({ ok: found, error: found ? null : 'Device not found' })
            } catch(e) {
              send({ ok: false, error: e.message })
            }
          }

          else { res.writeHead(404); res.end() }
        } catch(e) { send({ ok: false, error: e.message }) }
      })
      return
    }

    res.writeHead(404); res.end()
  })
  server.listen(CONTROL_PORT, () => console.log(`Control panel at http://192.168.1.190:${CONTROL_PORT}`))
}

async function main() {
  console.log(`Home Event Watcher v${WATCHER_VERSION}`)
  console.log(`Polling every ${INTERVAL_SECONDS}s; cause window ${CAUSE_WINDOW_SECONDS}s.`)

  const ringApi = new RingApi({
    refreshToken: await loadToken(),
    cameraStatusPollingSeconds: 20,
    locationModePollingSeconds: 20,
  })

  ringApiInstance = ringApi
  ringApi.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => saveToken(newRefreshToken))
  if (!RUN_ONCE) startHueWebhookListener()
  if (!RUN_ONCE) startDashboard()
  if (!RUN_ONCE) startControlServer()

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
