import { createHash } from 'crypto'
import { RingApi } from 'ring-client-api'
import nodemailer from 'nodemailer'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { exec } from 'child_process'
import dgram from 'dgram'
import http from 'http'
import { readFileSync as readFileSyncRaw } from 'fs'
import { promisify } from 'util'

const execAsync = promisify(exec)
const WATCHER_VERSION = '2026.08.02.11'
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

  const stToken = process.env.SMARTTHINGS_TOKEN
  if (!stToken) return []
  const response = await fetch('https://api.smartthings.com/v1/devices', {
    headers: { 'Authorization': `Bearer ${SMARTTHINGS_TOKEN}` }
  })
  if (response.status === 401) throw new Error('SmartThings 401 Unauthorized - token expired')
  const data = await response.json()
  if (!data.items) throw new Error(data.error || 'SmartThings API error')
  global.stTokenAlertSent = false  // reset on success
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
      const coolSetpoint = main?.thermostatCoolingSetpoint?.coolingSetpoint?.value
      const heatSetpoint = main?.thermostatHeatingSetpoint?.heatingSetpoint?.value
      const setpoint = mode === 'cool' ? (coolSetpoint ?? heatSetpoint) :
                       mode === 'heat' ? (heatSetpoint ?? coolSetpoint) :
                       (coolSetpoint ?? heatSetpoint)
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

// ─── Network Sniffer ─────────────────────────────────────────────────────────

const knownAlertedMacs = new Set()  // Track MACs we've already alerted on this session

async function collectNetworkSnifferEvents() {
  try {
    const { stdout } = await execAsync('arp -a', { timeout: 10000 })
    const devices = loadDeviceRegistry()
    const normMac = m => m.toLowerCase().split(":").map(o => o.padStart(2,"0")).join(":")
    const knownMacs = new Set(devices.map(d => normMac(d.mac)))

    const items = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i)
      if (!m) continue
      const ip  = m[1]
      const mac = m[2].toLowerCase()

      // Skip broadcast, incomplete, loopback, non-home IPs
      if (mac === 'ff:ff:ff:ff:ff:ff') continue
      if (line.includes('incomplete')) continue
      if (!ip.startsWith('192.168.1.')) continue
      if (ip === '192.168.1.255') continue

      const nMac = normMac(mac)
      if (!knownMacs.has(nMac) && !knownAlertedMacs.has(nMac)) {
        knownAlertedMacs.add(nMac)

        console.log(`UNKNOWN DEVICE: ${ip} ${mac}`)
        items.push({
          key: `sniffer:${mac}`,
          source: 'Network',
          category: 'Sensor',
          name: `Unknown Device (${ip})`,
          state: 'active',
          kind: 'sensor_triggered',
          at: new Date().toISOString(),
          mac,
          ip,
        })
      }
    }
    return items
  } catch(e) {
    console.log(`Network sniffer skipped: ${e.message}`)
    return []
  }
}

// ─── Sonos Monitor ───────────────────────────────────────────────────────────

const SONOS_DEVICES = [
  { name: 'Living Room Sonos Beam', ip: '192.168.1.10' },
]

async function getSonosState(device) {
  try {
    const soapCall = async (service, action, body) => {
      const { stdout } = await execAsync(
        `curl -s -X POST http://${device.ip}:1400/MediaRenderer/${service}/Control ` +
        `-H 'Content-Type: text/xml' ` +
        `-H 'SOAPACTION: "urn:schemas-upnp-org:service:${service}:1#${action}"' ` +
        `-d '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${service}:1">${body}</u:${action}></s:Body></s:Envelope>'`,
        { timeout: 5000 }
      )
      return stdout
    }

    const [transportXml, volumeXml] = await Promise.all([
      soapCall('AVTransport', 'GetTransportInfo', '<InstanceID>0</InstanceID>'),
      soapCall('RenderingControl', 'GetVolume', '<InstanceID>0</InstanceID><Channel>Master</Channel>'),
    ])

    const stateMatch  = transportXml.match(/<CurrentTransportState>([^<]+)</)
    const volumeMatch = volumeXml.match(/<CurrentVolume>([^<]+)</)

    const state  = stateMatch?.[1]  ?? 'UNKNOWN'
    const volume = volumeMatch ? parseInt(volumeMatch[1]) : null

    return { state, volume, error: null }
  } catch(e) {
    return { state: 'OFFLINE', volume: null, error: e.message }
  }
}

async function collectSonosEvents() {
  const items = []
  for (const device of SONOS_DEVICES) {
    const { state, volume } = await getSonosState(device)
    items.push({
      key: `sonos:${device.ip}`,
      source: 'Sonos',
      category: 'Sensor',
      name: device.name,
      state: state === 'PLAYING' ? 'active' : 'clear',
      sonosState: state,
      volume,
    })
  }
  return items
}

// ─── Apple TV Monitor ────────────────────────────────────────────────────────

const APPLETV_DEVICES = [
  {
    name: 'Living Room',
    id: '65601471-268F-413C-888B-204B001F7018',
    ip: '192.168.1.48',
    companionCreds: '7f6ddac5bafeb542aad59dff492b7dfcb70d54bc456bc5fc630295cb80bbbede:5fe3e15a3b59cdb513cde24fa8a3f85ebdb69a4648ac693584518892390357b1:36353630313437312d323638462d343133432d383838422d323034423030314637303138:63383934613839382d616530332d343135352d386439652d663439326139666131386636',
    airplayCreds: '7f6ddac5bafeb542aad59dff492b7dfcb70d54bc456bc5fc630295cb80bbbede:c0328fe048657c47741bcfa6ba3824dfc92cf335660d23ff5bca84aeb972f437:36353630313437312d323638462d343133432d383838422d323034423030314637303138:66626532396366302d303666632d343863632d616234662d653336373066376438306434',
  },
  // Bedroom and Basement to be added after pairing
]

async function getAppleTVState(device) {
  try {
    const { stdout } = await execAsync(
      `atvremote --id ${device.id} --protocol airplay ` +
      `--companion-credentials ${device.companionCreds} ` +
      `--airplay-credentials ${device.airplayCreds} ` +
      `app playing volume`,
      { timeout: 15000 }
    )
    const appMatch   = stdout.match(/App: (.+?) \(/)
    const stateMatch = stdout.match(/Device state: (\w+)/)
    const titleMatch = stdout.match(/Title: (.+)/)
    const artistMatch= stdout.match(/Artist: (.+)/)
    const volMatch   = stdout.match(/^([\d.]+)$/m)
    const app    = appMatch?.[1]   ?? 'Unknown'
    const state  = stateMatch?.[1] ?? 'Unknown'
    const title  = titleMatch?.[1]?.trim()  ?? ''
    const artist = artistMatch?.[1]?.trim() ?? ''
    const volume = volMatch ? Math.round(parseFloat(volMatch[1]) * 100) : null
    return { app, state, title, artist, volume, error: null }
  } catch(e) {
    return { app: null, state: 'Offline', title: '', artist: '', error: e.message }
  }
}

async function collectAppleTVEvents() {
  const items = []
  for (const device of APPLETV_DEVICES) {
    const { app, state, title, artist } = await getAppleTVState(device)
    const isPlaying = state === 'Playing'
    const displayState = isPlaying && title ? `${title}${artist ? ' - ' + artist : ''}` : state
    items.push({
      key: `appletv:${device.id}`.toLowerCase(),
      source: 'AppleTV',
      category: 'Sensor',
      name: `Apple TV ${device.name}`,
      state: displayState,
      volume: volume,
    })
    if (app) {
      items.push({
        key: `appletv:app:${device.id}`.toLowerCase(),
        source: 'AppleTV',
        category: 'Sensor',
        name: `Apple TV ${device.name} app`,
        state: app,
      })
    }
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
      minEventIntervalMinutes: device.minEventIntervalMinutes ?? null,
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
  const sonosItems = await collectSonosEvents().catch(e => { console.log('Sonos skipped:', e.message); return [] })
  const snifferItems = await collectNetworkSnifferEvents()
  const appleTVItems = await collectAppleTVEvents().catch(e => { console.log('AppleTV skipped:', e.message); return [] })
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
    // SmartThings disabled - token expires every 24hrs
    Promise.resolve([]).catch(async err => {
      console.log(`SmartThings skipped: ${err.message}`)
      if (err.message?.includes('401') || err.message?.includes('Unauthorized') || err.message?.includes('permission deny')) {
        if (!global.stTokenAlertSent) { global.stTokenAlertSent = true; await sendEventAlert([{
          source: 'SmartThings',
          category: 'Sensor',
          name: 'SmartThings Token Expired',
          state: 'active',
          at: new Date().toISOString(),
          kind: 'sensor_triggered',
        }]) }
      }
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

  return [...ringItems, ...goveeItems, ...hueItems, ...stItems, ...lgItems, ...hueWebhookItems, ...presenceItems, ...btItems, ...rokuItems, ...appleTVItems, ...sonosItems, ...snifferItems]
}

function findLikelyCause(history, now, lightKey) {
  const cutoff = now.getTime() - CAUSE_WINDOW_SECONDS * 1000
  return [...history.events]
    .reverse()
    .find(event => {
      if (!event.at) return false
      if (new Date(event.at).getTime() < cutoff) return false
      if (event.key === lightKey) return false
      // sensor triggered, contact/motion events, lock/door changes, presence changes
      return event.kind === 'sensor_triggered' ||
             event.category === 'Contact' ||
             event.category === 'Motion' ||
             event.key?.includes('smartthings:') ||
             event.key?.includes('presence:')
    })
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
      // Throttle noisy devices: skip event if last event for this key is too recent
      if (item.minEventIntervalMinutes) {
        const minMs = item.minEventIntervalMinutes * 60 * 1000
        const lastEvt = [...history.events].reverse().find(e => e.key === item.key)
        if (lastEvt && now.getTime() - new Date(lastEvt.at).getTime() < minMs) {
          history.states[item.key] = {
            source: item.source, category: item.category, name: item.name,
            state: item.state, lastSeenAt: now.toISOString(),
            lastChangedAt: previous.lastChangedAt,
          }
          continue
        }
      }

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

      if (item.category === 'Light') {
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

  let msg = `[${event.source}] ${event.name} ${action} at ${time}${event._trigger ?? ''}`

  if (event.likelyCause) {
    const causeTime = new Date(event.likelyCause.at)
    const seconds = Math.max(0, Math.round((new Date(event.at).getTime() - causeTime.getTime()) / 1000))
    msg += `\n  -> likely caused by [${event.likelyCause.source}] ${event.likelyCause.name} (${seconds}s earlier)`
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
  // Alert on everything — filter out only pure info-noise (iPhone/network presence flips)
  const important = events.filter(event => {
    // Skip presence events for phones — too noisy
    if (event.source === 'Network' && event.category === 'Sensor') return false
    return true
  })
  if (important.length === 0) return

  if (!SEND_ALERTS) {
    console.log(`Alerts skipped for ${important.length} event(s).`)
    return
  }

  const title = important.length === 1
    ? `Home Alert: [${important[0].source}] ${important[0].name}`
    : `Home Alert: ${important.length} events`

  // Check if all events are simultaneous (same minute) — suggests one automation triggered them
  let simultaneousNote = ''
  if (important.length > 1) {
    const minutes = new Set(important.map(e => e.at ? e.at.slice(0, 16) : ''))
    if (minutes.size === 1) simultaneousNote = ' (all simultaneous — likely one automation/schedule)'
  }

  const body = important.map(formatEvent).join('\n') + simultaneousNote
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
const GOVEE_MODELS = {
  '15:03:DD:99:83:46:67:49': 'H6076',
  '19:D2:D0:03:C1:46:2F:0D': 'H6076',
  'E2:D9:98:17:3C:DF:5D:80': 'H6008',
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
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`Port ${HUE_WEBHOOK_PORT} already in use - webhook listener skipped`)
    } else {
      console.error('Webhook listener error:', e.message)
    }
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
  if (key.includes('sniffer:')) return 'critical'
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
const CONTROL_PORT     = parseInt(process.env.CONTROL_PORT     ?? '8442', 10)

async function buildDashboard(history, devices) {
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

  // Ring batteries — cameras live from API, sensors from history file
  let ringBattRows = ''
  try {
    const battPct = (pct) => {
      const color = pct < 20 ? '#f87171' : pct < 50 ? '#fbbf24' : '#4ade80'
      const warn  = pct < 20 ? ' ⚠️' : pct < 50 ? ' 🔋' : ''
      return `<span style="color:${color}">${pct}%${warn}</span>`
    }
    const ringBattEntries = []

    // Live camera batteries from Ring API
    if (ringApiInstance) {
      const cams = await ringApiInstance.getCameras()
      for (const cam of cams) {
        const d = cam.data ?? {}
        const b1 = d.battery_life   != null ? parseInt(d.battery_life,   10) : null
        const b2 = d.battery_life_2 != null ? parseInt(d.battery_life_2, 10) : null
        if (b1 == null) continue  // wired/no battery
        const minPct = b2 != null ? Math.min(b1, b2) : b1
        const dispHtml = b2 != null ? `${battPct(b1)} / ${battPct(b2)}` : battPct(b1)
        const kind = d.kind ?? cam.deviceType ?? 'Camera'
        const label = kind.includes('doorbell') ? 'Doorbell' : 'Camera'
        ringBattEntries.push({ minPct, html: `<tr><td>Ring</td><td>${cam.name} (${label})</td><td>${dispHtml}</td></tr>` })
      }
    }

    // Non-camera Ring devices (sensors, mailbox, etc.) from history file
    try {
      const ringHistory = JSON.parse(readFileSync('ring_battery_history.json', 'utf-8'))
      const latest = {}
      for (const r of (ringHistory.readings || [])) {
        if (r.battery != null && !['Camera','Doorbell'].includes(r.category)) latest[r.name] = r
      }
      for (const r of Object.values(latest)) {
        ringBattEntries.push({ minPct: r.battery ?? 0, html: `<tr><td>Ring</td><td>${r.name} (${r.category})</td><td>${battPct(r.battery ?? 0)}</td></tr>` })
      }
    } catch(e) {}

    ringBattRows = ringBattEntries
      .sort((a, b) => a.minPct - b.minPct)
      .map(e => e.html).join('')
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

  // Camera cards
  let cameraCards = '<p style="color:#64748b">Camera snapshots will appear here once Ring API is connected</p>'
  if (ringApiInstance) {
    try {
      const cameras = [...(await ringApiInstance.getCameras())].sort((a, b) => {
        const aOn = a.data?.settings?.motion_detection_enabled !== false ? 0 : 1
        const bOn = b.data?.settings?.motion_detection_enabled !== false ? 0 : 1
        return aOn - bOn
      })
      cameraCards = cameras.map(cam => {
        const snapUrl = `/snapshot/${encodeURIComponent(cam.name)}`
        const d = cam.data ?? {}

        // Battery — parse as int (API returns strings or numbers)
        const batt1 = d.battery_life   != null ? parseInt(d.battery_life,   10) : null
        const batt2 = d.battery_life_2 != null ? parseInt(d.battery_life_2, 10) : null
        function battSpan(pct, label) {
          const color = pct < 20 ? '#f87171' : pct < 50 ? '#fbbf24' : '#4ade80'
          return `<span style="color:${color};font-size:11px;font-weight:600">🔋${label ? label+':' : ''}${pct}%</span>`
        }
        let battHtml
        if (batt1 != null && batt2 != null) {
          battHtml = battSpan(batt1, '1') + ' ' + battSpan(batt2, '2')
        } else if (batt1 != null) {
          battHtml = battSpan(batt1, '')
        } else {
          battHtml = `<span title="Wired power" style="color:#64748b;font-size:11px">⚡ Wired</span>`
        }

        // WiFi signal strength (dBm → bars)
        const rssi = d.latest_signal_strength ?? d.wifi_signal_strength ?? null
        let signalHtml = ''
        if (rssi != null) {
          const bars = rssi >= -50 ? '▂▄▆█' : rssi >= -65 ? '▂▄▆' : rssi >= -75 ? '▂▄' : '▂'
          const sigColor = rssi >= -65 ? '#4ade80' : rssi >= -75 ? '#fbbf24' : '#f87171'
          signalHtml = `<span title="WiFi ${rssi} dBm" style="color:${sigColor};letter-spacing:1px">${bars}</span>`
        }

        // Last motion
        const lastMotionTs = d.last_motion_at ?? d.last_ding_at ?? null
        const lastMotionHtml = lastMotionTs
          ? `<span title="Last motion" style="color:#94a3b8">🕐 ${new Date(lastMotionTs * 1000).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true})}</span>`
          : ''

        // Motion detection toggle — read from data.settings (not stale isMotionDetectionEnabled)
        const motionOn = d.settings?.motion_detection_enabled !== false
        const motionBg    = motionOn ? '#22c55e22' : '#f8717122'
        const motionBord  = motionOn ? '#22c55e'   : '#f87171'
        const motionColor = motionOn ? '#4ade80'   : '#f87171'
        const motionLabel = motionOn ? '🔴 Motion On' : '⚪ Motion Off'
        const motionTitle = motionOn ? 'Disable motion detection' : 'Enable motion detection'
        const motionHtml = `<button data-cam="${encodeURIComponent(cam.name)}" onclick="toggleMotion(this,'${encodeURIComponent(cam.name)}',${!motionOn})" title="${motionTitle}" style="background:${motionBg};border:1px solid ${motionBord};color:${motionColor};border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer">${motionLabel}</button>`

        // Safe ID for DOM references
        const safeId = cam.name.replace(/[^a-z0-9]/gi,'_')

        // Gear popup info
        const gearId = `gear-${safeId}`
        const fwLine   = d.firmware_version ? `<div>Firmware: ${d.firmware_version}</div>` : ''
        const locLine  = d.location_id      ? `<div>Location ID: ${d.location_id}</div>`   : ''
        const rssiLine = rssi != null        ? `<div>Signal: ${rssi} dBm</div>`             : ''
        const battLine = batt1 != null ? `<div>Battery: ${batt1}%${batt2 != null ? ' / ' + batt2 + '%' : ''}</div>` : ''
        const gearHtml = `<span title="Camera info" style="cursor:pointer;color:#64748b;font-size:13px" onclick="var el=document.getElementById('${gearId}');el.style.display=el.style.display==='none'?'block':'none'">⚙️</span><div id="${gearId}" style="display:none;position:absolute;right:8px;top:36px;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px 14px;font-size:11px;color:#94a3b8;z-index:10;min-width:200px;line-height:1.8"><div><strong style="color:#e2e8f0">${cam.name}</strong></div><div>Type: ${d.kind ?? cam.deviceType}</div>${fwLine}${locLine}${rssiLine}${battLine}</div>`

        return `<div style="background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155;position:relative">
          <div style="padding:8px 12px;font-size:12px;font-weight:700;color:#e2e8f0;display:flex;justify-content:space-between;align-items:center">
            <span>${cam.name}</span>
            <span style="display:flex;gap:8px;align-items:center">${battHtml}${gearHtml}</span>
          </div>
          <a href="${snapUrl}" target="_blank">
            <img src="${snapUrl}?t=${Date.now()}" data-snap-id="${safeId}" style="width:100%;display:block;max-height:220px;object-fit:cover"
              onload="var el=document.getElementById('snap-time-${safeId}');if(el)el.textContent='📸 '+new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true})"
              onerror="this.style.display='none';this.nextSibling.style.display='block'">
            <div style="display:none;padding:20px;text-align:center;color:#64748b;font-size:11px">Snapshot unavailable</div>
          </a>
          <div style="padding:8px 12px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:11px;border-top:1px solid #334155">
            ${signalHtml}
            ${lastMotionHtml}
            <span id="snap-time-${safeId}" style="color:#475569;font-size:10px"></span>
            <span style="margin-left:auto">${motionHtml}</span>
          </div>
        </div>`
      }).join('')
    } catch(e) {
      cameraCards = `<p style="color:#f87171">Error loading cameras: ${e.message}</p>`
    }
  }

  // Ring alarm/sensor devices
  let ringDeviceRows = ''
  if (ringApiInstance) {
    try {
      const skipTypes = ['base-station-v1', 'base-station', 'security-keypad', 'range-extender', 'hub']
      const locations = await ringApiInstance.getLocations()
      const allDevices = []
      for (const loc of locations) {
        let devs = []
        try { devs = await loc.getDevices() } catch { /* no alarm hub */ }
        for (const d of devs) {
          const data = d.data
          const name = data.name ?? data.deviceType ?? 'Unknown'
          if (skipTypes.some(t => (data.deviceType ?? '').includes(t))) continue
          const dt = data.deviceType ?? ''
          let icon = '📡'
          if (dt.includes('contact'))       icon = '🚪'
          else if (dt.includes('motion'))   icon = '👁'
          else if (dt.includes('lock'))     icon = '🔒'
          else if (dt.includes('light') || dt.includes('beam')) icon = '💡'
          else if (dt.includes('siren'))    icon = '🚨'
          else if (dt.includes('freeze'))   icon = '❄️'
          else if (dt.includes('smoke'))    icon = '🔥'
          // Open/closed state
          let state = null
          const checks = [data.faulted, data.open, data.opened, data.isOpen, data.motionDetected, data.motion, data.status, data.state]
          for (const v of checks) {
            if (v === true) { state = true; break }
            if (v === false) { state = false; break }
            if (typeof v === 'string') {
              const n = v.toLowerCase()
              if (['open','opened','active','motion','detected','faulted'].includes(n)) { state = true; break }
              if (['closed','clear','inactive','idle','ok'].includes(n)) { state = false; break }
            }
          }
          const stateLabel = state === true ? '<span style="color:#f87171">Open/Active</span>' : state === false ? '<span style="color:#4ade80">Closed/Clear</span>' : '<span style="color:#64748b">Unknown</span>'
          // Battery
          const batt = data.batteryLevel != null ? Math.round(data.batteryLevel) : null
          const battColor = batt == null ? '#64748b' : batt < 20 ? '#f87171' : batt < 50 ? '#fbbf24' : '#4ade80'
          const battHtml = batt != null ? `<span style="color:${battColor}">🔋${batt}%</span>` : `<span style="color:#64748b">–</span>`
          allDevices.push({ icon, name, dt, stateLabel, battHtml, state })
        }
      }
      // Sort: open/active first, then by name
      allDevices.sort((a, b) => {
        const aScore = a.state === true ? 0 : a.state === false ? 1 : 2
        const bScore = b.state === true ? 0 : b.state === false ? 1 : 2
        return aScore - bScore || a.name.localeCompare(b.name)
      })
      if (allDevices.length) {
        ringDeviceRows = allDevices.map(d =>
          `<tr><td>${d.icon} ${d.name}</td><td style="color:#64748b;font-size:11px">${d.dt}</td><td>${d.stateLabel}</td><td>${d.battHtml}</td></tr>`
        ).join('')
      } else {
        ringDeviceRows = '<tr><td colspan="4" style="color:#64748b">No alarm/sensor devices found</td></tr>'
      }
    } catch(e) {
      ringDeviceRows = `<tr><td colspan="4" style="color:#f87171">Error loading devices: ${e.message}</td></tr>`
    }
  }

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

  // Device alert stats — count events per device from full history
  const allHistory = loadHistory()
  const now24 = Date.now() - 86400000
  const now7d  = Date.now() - 7 * 86400000
  const statMap = {}
  for (const e of allHistory.events) {
    const k = `${e.source}:${e.name}`
    if (!statMap[k]) statMap[k] = { source: e.source, name: e.name, total: 0, last24h: 0, last7d: 0, lastAt: null }
    const s = statMap[k]
    s.total++
    const t = new Date(e.at).getTime()
    if (t >= now24) s.last24h++
    if (t >= now7d)  s.last7d++
    if (!s.lastAt || t > new Date(s.lastAt).getTime()) s.lastAt = e.at
  }
  const deviceRegistry = loadDeviceRegistry()
  const statRows = Object.values(statMap)
    .sort((a, b) => b.last7d - a.last7d)
    .map(s => {
      const lastStr = s.lastAt ? new Date(s.lastAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}) : '—'
      const heat24 = s.last24h >= 20 ? '#f87171' : s.last24h >= 5 ? '#fbbf24' : '#4ade80'
      const heat7d  = s.last7d  >= 100 ? '#f87171' : s.last7d  >= 30 ? '#fbbf24' : '#4ade80'
      const devEntry = deviceRegistry.find(d => d.name === s.name)
      const minInt = devEntry?.minEventIntervalMinutes ? `<span style="color:#64748b;font-size:10px"> (throttle: ${devEntry.minEventIntervalMinutes}m)</span>` : ''
      return `<tr><td>${s.source}</td><td>${s.name}${minInt}</td><td style="color:${heat24};text-align:right">${s.last24h}</td><td style="color:${heat7d};text-align:right">${s.last7d}</td><td style="text-align:right">${s.total}</td><td>${lastStr}</td></tr>`
    }).join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
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
<div class="sub" style="display:flex;align-items:center;gap:12px">
  <span>Last updated: ${now} · v${WATCHER_VERSION}</span>
  <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:#64748b">
    <input type="checkbox" id="autorefresh-cb" style="cursor:pointer" checked>
    Auto-refresh (60s)
  </label>
</div>
<div style="display:flex;gap:4px;margin-bottom:16px">
  <button onclick="showTab('events')" id="tab-events" style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;background:#7c6af7;color:#fff;font-weight:700;cursor:pointer;font-size:12px">Events</button>
  <button onclick="showTab('cameras')" id="tab-cameras" style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;background:#1e293b;color:#94a3b8;font-weight:700;cursor:pointer;font-size:12px">📷 Ring Cameras</button>
  <button onclick="showTab('services')" id="tab-services" style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;background:#1e293b;color:#94a3b8;font-weight:700;cursor:pointer;font-size:12px">🖥️ Mac Mini</button>
  <button onclick="showTab('qnap')" id="tab-qnap" style="padding:6px 14px;border:none;border-radius:6px 6px 0 0;background:#1e293b;color:#94a3b8;font-weight:700;cursor:pointer;font-size:12px">🗄️ QNAP</button>
</div>
<div id="pane-events">

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

<h2>Device Alert Stats</h2>
<p style="color:#64748b;font-size:11px;margin:0 0 8px">Red = noisy · Green = quiet · Shows throttle setting if set</p>
<table>
  <tr><th>Source</th><th>Device</th><th style="text-align:right">24h</th><th style="text-align:right">7d</th><th style="text-align:right">Total</th><th>Last Event</th></tr>
  ${statRows}
</table>
</div>

<div id="pane-cameras" style="display:none">
  <h2>Ring Cameras</h2>
  <div class="camera-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
    ${cameraCards}
  </div>
  <div style="color:#64748b;font-size:11px;margin-top:12px">Snapshots refresh every 60s · Click image for full size</div>

  <h2 style="margin-top:24px">Ring Devices</h2>
  <table>
    <tr><th>Device</th><th>Type</th><th>State</th><th>Battery</th></tr>
    ${ringDeviceRows}
  </table>
</div>

<div id="pane-services" style="display:none">
  <h2 style="margin-bottom:12px">Mac Mini — System Overview</h2>
  <div id="mac-gauges" style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px">
    <div style="flex:1;min-width:200px">
      <h3 style="margin:0 0 8px;color:#94a3b8">CPU &amp; Memory</h3>
      <div id="mac-cpu-mem" style="padding:8px 0"><span style="color:#64748b;font-size:12px">Loading…</span></div>
    </div>
    <div style="flex:1;min-width:200px">
      <h3 style="margin:0 0 8px;color:#94a3b8">Storage</h3>
      <div id="mac-disk" style="padding:8px 0"><span style="color:#64748b;font-size:12px">Loading…</span></div>
    </div>
    <div style="flex:1;min-width:200px">
      <h3 style="margin:0 0 8px;color:#94a3b8">System Info</h3>
      <div id="mac-sysinfo" style="padding:8px 0"><span style="color:#64748b;font-size:12px">Loading…</span></div>
    </div>
  </div>

  <h3 style="color:#94a3b8;margin-bottom:8px">Top Memory Hogs</h3>
  <table id="mac-procs-table" style="margin-bottom:24px">
    <tr><th>PID</th><th>Process</th><th>Mem %</th><th>RSS</th><th>CPU %</th></tr>
    <tr><td colspan="5" style="color:#64748b">Loading...</td></tr>
  </table>

  <h2>Running Services &amp; Ports</h2>
  <table id="services-table">
    <tr><th>Port</th><th>Process</th><th>PID</th><th>Description</th></tr>
    <tr><td colspan="4" style="color:#64748b">Loading...</td></tr>
  </table>
  <p style="color:#64748b;font-size:11px;margin-top:8px">Shows all TCP ports listening on this machine · Refreshes on tab switch</p>

  <h2 style="margin-top:24px">Launch Agents (Auto-start on Login)</h2>
  <table id="agents-table">
    <tr><th>Status</th><th>Label</th><th>Script</th></tr>
    <tr><td colspan="3" style="color:#64748b">Loading...</td></tr>
  </table>
</div>

<div id="pane-qnap" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
    <h2 style="margin:0">QNAP NAS — System Overview</h2>
    <button onclick="qnapForceRefresh()" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:12px">⟳ Refresh</button>
  </div>
  <div id="qnap-status" style="color:#64748b;font-size:12px;margin-bottom:8px">Loading…</div>

  <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px">
    <div style="flex:1;min-width:220px">
      <h3 style="margin:0 0 8px;color:#94a3b8">System Info</h3>
      <table id="qnap-sysinfo-table">
        <tr><th>Field</th><th>Value</th></tr>
        <tr><td colspan="2" style="color:#64748b">Loading...</td></tr>
      </table>
    </div>
    <div style="flex:1;min-width:220px">
      <h3 style="margin:0 0 8px;color:#94a3b8">CPU &amp; Memory</h3>
      <div id="qnap-gauges" style="padding:8px 0"></div>
    </div>
  </div>

  <h3 style="color:#94a3b8">Storage Map</h3>
  <div id="qnap-storage-map" style="margin-bottom:20px">
    <div style="color:#64748b;font-size:12px">Loading...</div>
  </div>

  <h3 style="color:#94a3b8">Drive Health</h3>
  <table id="qnap-disks-table">
    <tr><th>Drive</th><th>Model</th><th>Temp</th><th>Health</th><th>Capacity</th></tr>
    <tr><td colspan="5" style="color:#64748b">Loading...</td></tr>
  </table>

  <h3 style="margin-top:20px;color:#94a3b8">Installed Apps / Services</h3>
  <table id="qnap-apps-table">
    <tr><th>Status</th><th>Name</th><th>Version</th></tr>
    <tr><td colspan="3" style="color:#64748b">Loading...</td></tr>
  </table>

  <h3 style="margin-top:20px;color:#94a3b8">Shared Folders</h3>
  <div id="qnap-shares" style="margin-bottom:12px">
    <div style="color:#64748b;font-size:12px">Loading...</div>
  </div>

  <h3 style="margin-top:24px;color:#94a3b8">⏱ Time Machine Backups</h3>
  <div id="qnap-tm" style="margin-bottom:12px">
    <div style="color:#64748b;font-size:12px">Loading...</div>
  </div>

  <p style="color:#64748b;font-size:11px;margin-top:12px">Connects to QNAP at 192.168.1.176 via SNMP · Refreshes on tab switch · Click a share to open in Finder</p>
</div>

<script>
const SERVICE_LABELS = {
  '5555': 'Hue webhook listener',
  '5558': 'Home Monitor dashboard',
  '5559': 'Home Monitor control',
  '5560': 'Speed Monitor dashboard',
  '80':   'HTTP',
  '443':  'HTTPS',
  '22':   'SSH',
  '3000': 'Node dev server',
  '8080': 'HTTP alt',
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b/1073741824).toFixed(1) + ' GB'
  if (b >= 1048576)    return (b/1048576).toFixed(0) + ' MB'
  return b + ' B'
}
function macGauge(label, pct, val, color) {
  var c = Math.min(Math.max(pct||0,0),100)
  var gc = c > 85 ? '#f87171' : c > 65 ? '#fbbf24' : color
  return '<div style="margin-bottom:12px">' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:3px"><span>' + label + '</span><span style="color:#e2e8f0;font-weight:700">' + val + '</span></div>' +
    '<div style="background:#1e293b;border-radius:4px;height:10px;overflow:hidden"><div style="background:' + gc + ';width:' + c + '%;height:100%;border-radius:4px;transition:width 0.4s"></div></div>' +
    '</div>'
}
async function loadMacStats() {
  try {
    var d = await (await fetch('/api/mac-stats')).json()
    if (d.error) { document.getElementById('mac-cpu-mem').innerHTML = '<span style="color:#f87171">' + d.error + '</span>'; return }

    var cpuLabel = d.cpu_pct + '% (load ' + (d.load_avg?.[0] ?? '?') + ' / ' + d.cpu_count + ' cores)'
    var memUsedGB  = (d.mem_used  / 1073741824).toFixed(1)
    var memTotalGB = (d.mem_total / 1073741824).toFixed(1)
    var memLabel = memUsedGB + ' GB / ' + memTotalGB + ' GB (wired+active)'
    var memGaugeHtml = macGauge('Memory', d.mem_pct, memLabel, '#38bdf8')
    if (d.mem_wired != null) {
      var gb = function(b) { return (b/1073741824).toFixed(1) }
      memGaugeHtml += '<div style="font-size:10px;margin-top:4px;line-height:1.8">' +
        '<span style="color:#f87171">⬤ Wired: '      + gb(d.mem_wired)      + ' GB</span>  ' +
        '<span style="color:#fbbf24">⬤ Active: '     + gb(d.mem_active)     + ' GB</span>  ' +
        '<span style="color:#7c6af7">⬤ Compressed: ' + gb(d.mem_compressed) + ' GB</span><br>' +
        '<span style="color:#64748b">⬤ Inactive: '   + gb(d.mem_inactive)   + ' GB</span>  ' +
        '<span style="color:#475569">⬤ Free: '       + gb(d.mem_free)       + ' GB</span>' +
        '</div>'
    }
    document.getElementById('mac-cpu-mem').innerHTML =
      macGauge('CPU', d.cpu_pct, cpuLabel, '#7c6af7') +
      memGaugeHtml

    var diskHtml = ''
    if (d.disks && d.disks.length) {
      d.disks.forEach(function(dk) {
        var dkUsedGB  = (dk.used  / 1073741824).toFixed(1)
        var dkTotalGB = (dk.total / 1073741824).toFixed(1)
        diskHtml += macGauge('Startup Disk', dk.pct, dkUsedGB + ' GB / ' + dkTotalGB + ' GB', '#4ade80')
      })
    } else { diskHtml = '<span style="color:#64748b;font-size:12px">Unavailable</span>' }
    document.getElementById('mac-disk').innerHTML = diskHtml

    var info = '<div style="font-size:12px;line-height:2">' +
      '<div><span style="color:#64748b">Host: </span><span style="color:#e2e8f0">' + (d.hostname||'—') + '</span></div>' +
      '<div><span style="color:#64748b">Uptime: </span><span style="color:#e2e8f0">' + (d.uptime||'—') + '</span></div>' +
      '<div><span style="color:#64748b">CPU: </span><span style="color:#e2e8f0;font-size:11px">' + (d.cpu_model||'—') + '</span></div>' +
      '</div>'
    document.getElementById('mac-sysinfo').innerHTML = info

    var procs = d.top_procs ?? []
    var procRows = procs.map(function(p) {
      var memPct = parseFloat(p.mem_pct)
      var memColor = memPct > 10 ? '#f87171' : memPct > 5 ? '#fbbf24' : '#e2e8f0'
      var rssGB = p.rss_kb > 1048576 ? (p.rss_kb/1048576).toFixed(1)+' GB' : Math.round(p.rss_kb/1024)+' MB'
      return '<tr>' +
        '<td style="color:#64748b;font-size:11px">' + p.pid + '</td>' +
        '<td style="color:#e2e8f0">' + p.name + '</td>' +
        '<td style="color:' + memColor + ';font-weight:700">' + p.mem_pct + '%</td>' +
        '<td style="color:#94a3b8">' + rssGB + '</td>' +
        '<td style="color:#64748b">' + p.cpu_pct + '%</td>' +
        '<td>' + (/procs$/.test(String(p.pid)) ? '' : '<button class="kill-btn" onclick="killProc(' + p.pid + ',this)" style="background:#7f1d1d;border:1px solid #f87171;color:#f87171;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:10px">Kill</button>') + '</td>' +
      '</tr>'
    }).join('')
    document.getElementById('mac-procs-table').innerHTML =
      '<tr><th>PID</th><th>Process</th><th>Mem %</th><th>RSS</th><th>CPU %</th><th></th></tr>' +
      (procRows || '<tr><td colspan="6" style="color:#64748b">No data</td></tr>')
  } catch(e) {
    document.getElementById('mac-cpu-mem').innerHTML = '<span style="color:#f87171">Error: ' + e.message + '</span>'
  }
}
async function killProc(pid, btn) {
  if (!confirm('Kill PID ' + pid + '?')) return
  btn.disabled = true; btn.textContent = '...'
  try {
    var r = await fetch('/api/mac-kill?pid=' + pid, { method: 'POST' })
    var j = await r.json()
    if (j.ok) { btn.textContent = 'Killed'; btn.style.color = '#4ade80'; setTimeout(loadMacStats, 1500) }
    else { btn.textContent = 'Error'; btn.disabled = false }
  } catch(e) { btn.textContent = 'Error'; btn.disabled = false }
}
async function loadServices() {
  loadMacStats()
  try {
    const data = await (await fetch('/api/services')).json()
    const rows = data.ports.map(p => {
      return '<tr><td><strong>' + p.port + '</strong></td><td style="color:#94a3b8">' + p.process + '</td><td style="color:#64748b">' + p.pid + '</td><td style="color:#7c6af7">' + (p.description ?? '') + '</td></tr>'
    }).join('')
    document.getElementById('services-table').innerHTML = '<tr><th>Port</th><th>Process</th><th>PID</th><th>Description</th></tr>' + (rows || '<tr><td colspan="4" style="color:#64748b">No listening ports found</td></tr>')

    const agentRows = (data.launchAgents ?? []).map(a => {
      const dot = a.running ? '<span style="color:#4ade80">● Running</span>' : '<span style="color:#f87171">● Stopped</span>'
      return '<tr><td>' + dot + '</td><td style="color:#e2e8f0;font-size:11px">' + a.label + '</td><td style="color:#64748b;font-size:11px;word-break:break-all">' + a.script + '</td></tr>'
    }).join('')
    document.getElementById('agents-table').innerHTML = '<tr><th>Status</th><th>Label</th><th>Script</th></tr>' + (agentRows || '<tr><td colspan="3" style="color:#64748b">None found</td></tr>')
  } catch(e) {
    document.getElementById('services-table').innerHTML = '<tr><td colspan="4" style="color:#f87171">Error: ' + e.message + '</td></tr>'
  }
}

async function qnapForceRefresh() {
  await fetch('/api/qnap/refresh', { method: 'POST' })
  loadQnap()
}
async function loadQnap() {
  document.getElementById('qnap-status').textContent = 'Connecting to QNAP…'
  try {
    const data = await (await fetch('/api/qnap')).json()
    window._qnapHost = data.host || '192.168.1.176'
    if (data.error) {
      document.getElementById('qnap-status').innerHTML = '<span style="color:#f87171">⚠ ' + data.error + '</span>'
      return
    }
    document.getElementById('qnap-status').innerHTML = '<span style="color:#4ade80">● Connected</span> · ' + data.host + (data.sysinfo?.firmware ? ' · QTS ' + data.sysinfo.firmware : '')

    // System info table
    const info = data.sysinfo ?? {}
    const infoFields = [
      ['Model', info.model],
      ['Hostname', info.hostname],
      ['Firmware', info.firmware],
      ['Uptime', info.uptime],
    ].filter(([,v]) => v != null)
    const infoRows = infoFields.map(([k,v]) => '<tr><td style="color:#94a3b8">' + k + '</td><td style="color:#e2e8f0">' + v + '</td></tr>').join('')
    document.getElementById('qnap-sysinfo-table').innerHTML = '<tr><th>Field</th><th>Value</th></tr>' + (infoRows || '<tr><td colspan="2" style="color:#64748b">No data</td></tr>')

    // CPU & Memory gauges
    function makeGauge(label, pct, color) {
      const c = pct != null ? Math.min(Math.max(parseInt(pct),0),100) : 0
      const gc = c > 85 ? '#f87171' : c > 65 ? '#fbbf24' : color
      return '<div style="margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:3px"><span>' + label + '</span><span style="color:#e2e8f0;font-weight:700">' + (pct != null ? pct + '%' : '—') + '</span></div>' +
        '<div style="background:#1e293b;border-radius:4px;height:10px;overflow:hidden"><div style="background:' + gc + ';width:' + c + '%;height:100%;border-radius:4px;transition:width 0.4s"></div></div>' +
        '</div>'
    }
    const cpuPct  = info.cpu_usage  != null ? parseInt(info.cpu_usage)  : null
    const memPct  = (info.mem_used && info.mem_total) ? Math.round(parseInt(info.mem_used)/parseInt(info.mem_total)*100) : null
    document.getElementById('qnap-gauges').innerHTML =
      makeGauge('CPU', cpuPct, '#7c6af7') +
      makeGauge('Memory', memPct, '#38bdf8') +
      (info.mem_used ? '<div style="font-size:10px;color:#64748b">' + info.mem_used + ' / ' + info.mem_total + ' MB</div>' : '')

    // Storage Map — visual bars per volume
    const vols = data.volumes ?? []
    const storageHtml = vols.length ? vols.map(v => {
      const pct = v.used_pct ?? 0
      const barColor = pct > 90 ? '#f87171' : pct > 75 ? '#fbbf24' : '#4ade80'
      const statusDot = v.status?.toLowerCase().includes('ready') || v.status?.toLowerCase().includes('normal')
        ? '<span style="color:#4ade80">●</span>' : '<span style="color:#f87171">●</span>'
      return '<div style="margin-bottom:16px;background:#1e293b;border-radius:8px;padding:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<span style="color:#e2e8f0;font-weight:700">' + (v.label ?? '?') + '</span>' +
          '<span style="font-size:11px">' + statusDot + ' ' + (v.status ?? '?') + '</span>' +
        '</div>' +
        '<div style="background:#0f172a;border-radius:4px;height:16px;overflow:hidden;margin-bottom:6px">' +
          '<div style="background:' + barColor + ';width:' + pct + '%;height:100%;border-radius:4px;transition:width 0.4s"></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b">' +
          '<span>Used: <strong style="color:#e2e8f0">' + (v.used ?? '?') + '</strong> (' + pct + '%)</span>' +
          '<span>Free: <strong style="color:#94a3b8">' + (v.free ?? '?') + '</strong> / ' + (v.total ?? '?') + '</span>' +
        '</div>' +
      '</div>'
    }).join('') : '<div style="color:#64748b;font-size:12px">No volumes found</div>'
    document.getElementById('qnap-storage-map').innerHTML = storageHtml

    // Drive Health table
    const disks = data.disks ?? []
    const diskRows = disks.map(d => {
      const t = d.temp != null ? parseInt(d.temp) : null
      const isF = d.tempUnit === 'F'
      const tempColor = t != null ? (t > (isF?122:50) ? '#f87171' : t > (isF?104:40) ? '#fbbf24' : '#4ade80') : '#64748b'
      const h = (d.health ?? '').toLowerCase()
      const healthColor = h === 'empty' ? '#475569' : (h.includes('good') || h.includes('normal') ? '#4ade80' : '#f87171')
      const m = d.model ?? ''
      const brand = m.startsWith('WUH') || m.startsWith('WD') ? 'WD' :
                    m.startsWith('ST') ? 'Seagate' :
                    m.startsWith('HGST') ? 'HGST' :
                    m.startsWith('MK') || m.startsWith('MQ') || m.startsWith('HDWD') ? 'Toshiba' :
                    m.startsWith('MZ') || m.startsWith('MZNL') ? 'Samsung' : ''
      return '<tr>' +
        '<td style="color:#e2e8f0">' + (d.slot ?? d.id ?? '?') + '</td>' +
        '<td style="color:#94a3b8;font-size:11px">' + (brand ? '<span style="color:#7c6af7;font-size:10px;margin-right:4px">' + brand + '</span>' : '') + (m || '—') + '</td>' +
        '<td style="color:' + tempColor + '">' + (t != null ? t + '°F' : '—') + '</td>' +
        '<td style="color:' + healthColor + '">' + (d.health ?? '—') + '</td>' +
        '<td style="color:#64748b">' + (d.capacity ?? '—') + '</td>' +
      '</tr>'
    }).join('')
    document.getElementById('qnap-disks-table').innerHTML = '<tr><th>Drive</th><th>Brand / Model</th><th>Temp</th><th>Health</th><th>Capacity</th></tr>' + (diskRows || '<tr><td colspan="5" style="color:#64748b">No disk info available</td></tr>')

    // Apps
    const apps = data.apps ?? []
    const appRows = apps.map(a => {
      const dot = a.status === 'enabled' || a.status === 'running' ? '<span style="color:#4ade80">● Enabled</span>' : '<span style="color:#64748b">● ' + (a.status ?? 'disabled') + '</span>'
      return '<tr><td>' + dot + '</td><td style="color:#e2e8f0">' + a.name + '</td><td style="color:#64748b;font-size:11px">' + (a.version ?? '') + '</td></tr>'
    }).join('')
    document.getElementById('qnap-apps-table').innerHTML = appRows
      ? '<tr><th>Status</th><th>Name</th><th>Version</th></tr>' + appRows
      : '<tr><td colspan="3" style="color:#475569;font-size:12px">App list unavailable — QNAP QTS 5 uses passkey-only authentication</td></tr>'

    // Shared Folders — clickable chips to open in Finder via SMB
    const shareList = data.shares ?? []
    if (shareList.length) {
      const chips = shareList.map(s => {
        const safe = s.replace(/"/g, '&quot;')
        return '<button class="share-chip" onclick="openQnapShare(this.dataset.n)" data-n="' + safe + '">📁 ' + s + '</button>'
      }).join('')
      document.getElementById('qnap-shares').innerHTML =
        '<style>.share-chip{background:#1e293b;border:1px solid #334155;color:#93c5fd;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;margin:3px;transition:background 0.15s}.share-chip:hover{background:#2d3f55}</style>' +
        '<div style="font-size:11px;color:#64748b;margin-bottom:6px">Click to open in Finder:</div>' + chips
    } else {
      document.getElementById('qnap-shares').innerHTML =
        '<div style="color:#64748b;font-size:12px">No shares found (requires SSH)</div>'
    }

    // Time Machine — merge QNAP-side sparsebundles with Mac Mini tmutil snapshot list
    loadTMBackups(data.tmBundles ?? [])

  } catch(e) {
    document.getElementById('qnap-status').innerHTML = '<span style="color:#f87171">Error: ' + e.message + '</span>'
  }
}

async function loadTMBackups(qnapBundles) {
  var el = document.getElementById('qnap-tm')
  try {
    var tmData = { backups: [] }
    try { tmData = await (await fetch('/api/tm-backups')).json() } catch(e) {}
    var snapshots = tmData.backups ?? []

    var fmtDate = function(iso) {
      if (!iso) return '—'
      var d = new Date(iso)
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })
    }

    // Add any QNAP-bundle machines not already in tmutil output (e.g. MBP)
    var knownMachines = {}
    snapshots.forEach(function(s) { knownMachines[s.machine.toLowerCase()] = true })
    var extraRows = []
    qnapBundles.forEach(function(b) {
      var key = b.machine.toLowerCase()
      var matched = Object.keys(knownMachines).some(function(k) { return k.indexOf(key) > -1 || key.indexOf(k) > -1 })
      if (!matched) extraRows.push({ machine: b.machine, date: b.lastBackup, type: '—', note: 'QNAP bundle only' })
    })

    if (!snapshots.length && !extraRows.length) {
      el.innerHTML = '<div style="color:#64748b;font-size:12px">No Time Machine backups found</div>'; return
    }

    // Count per machine for header summary
    var counts = {}
    snapshots.forEach(function(s) { counts[s.machine] = (counts[s.machine] || 0) + 1 })
    var summary = Object.entries(counts).map(function(e) {
      return '<span style="color:#94a3b8">💻 ' + e[0] + '</span> <span style="color:#64748b">(' + e[1] + ' snapshots)</span>'
    }).join('  ·  ')
    if (extraRows.length) {
      extraRows.forEach(function(r) { summary += '  ·  <span style="color:#94a3b8">💻 ' + r.machine + '</span> <span style="color:#64748b">(QNAP bundle)</span>' })
    }

    var html = '<div style="font-size:11px;margin-bottom:8px">' + summary + '</div>' +
      '<div style="max-height:320px;overflow-y:auto">' +
      '<table style="width:100%;border-collapse:collapse;font-size:11px">' +
      '<tr><th style="text-align:left;color:#475569;padding:3px 8px 3px 0;border-bottom:1px solid #334155">Machine</th>' +
           '<th style="text-align:left;color:#475569;padding:3px 8px;border-bottom:1px solid #334155">Date</th>' +
           '<th style="text-align:left;color:#475569;padding:3px 0;border-bottom:1px solid #334155">Type</th></tr>'

    snapshots.forEach(function(s) {
      var typeColor = s.type === 'Full' ? '#fbbf24' : '#94a3b8'
      html += '<tr>' +
        '<td style="color:#e2e8f0;padding:3px 8px 3px 0;border-bottom:1px solid #1e293b">' + s.machine + '</td>' +
        '<td style="color:#94a3b8;padding:3px 8px;border-bottom:1px solid #1e293b">' + fmtDate(s.date) + '</td>' +
        '<td style="color:' + typeColor + ';padding:3px 0;border-bottom:1px solid #1e293b">' + s.type + '</td>' +
      '</tr>'
    })
    extraRows.forEach(function(r) {
      html += '<tr>' +
        '<td style="color:#e2e8f0;padding:3px 8px 3px 0">' + r.machine + '</td>' +
        '<td style="color:#94a3b8;padding:3px 8px">' + fmtDate(r.date) + '</td>' +
        '<td style="color:#64748b;padding:3px 0">' + r.note + '</td>' +
      '</tr>'
    })
    html += '</table></div>'
    el.innerHTML = html
  } catch(e) {
    el.innerHTML = '<span style="color:#f87171;font-size:12px">TM error: ' + e.message + '</span>'
  }
}

async function openQnapShare(name) {
  var ua = navigator.userAgent || ''
  var plat = navigator.platform || ''
  var isMac = plat.indexOf('Mac') === 0 && navigator.maxTouchPoints <= 1
  var isIOS = /iPhone|iPad/.test(ua) || (plat.indexOf('Mac') === 0 && navigator.maxTouchPoints > 1)
  var isAndroid = /Android/.test(ua)
  var host = window._qnapHost || '192.168.1.176'
  var smbUrl = 'smb://' + host + '/' + encodeURIComponent(name)
  var bs = String.fromCharCode(92)
  var uncPath = bs + bs + host + bs + name

  if (isMac) {
    // Mac desktop: open Finder via server-side exec
    try {
      var r = await fetch('/api/qnap/open-share?name=' + encodeURIComponent(name))
      if (!r.ok) throw new Error('Server error ' + r.status)
      var btn = document.querySelector('#qnap-shares button[data-n="' + name + '"]')
      if (btn) { var orig = btn.textContent; btn.textContent = '✓ Opening…'; setTimeout(function(){ btn.textContent = orig }, 1500) }
    } catch(e) { alert('Could not open share: ' + e.message) }
    return
  }

  // All other platforms: show modal
  var modal = document.createElement('div')
  modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.75);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px'
  var h = '<div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;max-width:380px;width:100%;box-sizing:border-box">'
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">'
  h += '<span style="color:#e2e8f0;font-weight:700;font-size:14px">📁 ' + name + '</span>'
  h += '<button id="_qsc" style="background:none;border:none;color:#64748b;font-size:22px;cursor:pointer;line-height:1;padding:0">×</button>'
  h += '</div>'
  if (isIOS) {
    h += '<a href="' + smbUrl + '" style="display:block;background:#7c6af7;color:#fff;text-align:center;padding:10px 0;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;margin-bottom:14px">📂 Open in Files app</a>'
  }
  h += '<div style="margin-bottom:' + (isIOS ? '0' : '10px') + '">'
  h += '<div style="color:#64748b;font-size:11px;margin-bottom:4px">SMB URL</div>'
  h += '<div style="display:flex;gap:6px"><input id="_qsmb" readonly value="' + smbUrl + '" onclick="this.select()" style="flex:1;min-width:0;background:#0f172a;border:1px solid #334155;color:#93c5fd;padding:6px 8px;border-radius:6px;font-size:11px;font-family:monospace">'
  h += '<button id="_qcs" style="background:#334155;border:none;color:#94a3b8;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:11px;white-space:nowrap">Copy</button></div></div>'
  if (!isIOS && !isAndroid) {
    h += '<div><div style="color:#64748b;font-size:11px;margin-bottom:4px">Windows path</div>'
    h += '<div style="display:flex;gap:6px"><input id="_qunc" readonly value="' + uncPath + '" onclick="this.select()" style="flex:1;min-width:0;background:#0f172a;border:1px solid #334155;color:#93c5fd;padding:6px 8px;border-radius:6px;font-size:11px;font-family:monospace">'
    h += '<button id="_qcu" style="background:#334155;border:none;color:#94a3b8;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:11px;white-space:nowrap">Copy</button></div></div>'
  }
  h += '</div>'
  modal.innerHTML = h
  document.body.appendChild(modal)
  modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove() })
  document.getElementById('_qsc').addEventListener('click', function(){ modal.remove() })
  document.getElementById('_qcs').addEventListener('click', function(){
    navigator.clipboard.writeText(smbUrl).then(function(){
      var b = document.getElementById('_qcs'); if (b){ b.textContent = 'Copied!'; setTimeout(function(){ b.textContent = 'Copy' }, 1500) }
    }).catch(function(){ document.getElementById('_qsmb').select(); document.execCommand('copy') })
  })
  if (!isIOS && !isAndroid) {
    document.getElementById('_qcu').addEventListener('click', function(){
      navigator.clipboard.writeText(uncPath).then(function(){
        var b = document.getElementById('_qcu'); if (b){ b.textContent = 'Copied!'; setTimeout(function(){ b.textContent = 'Copy' }, 1500) }
      }).catch(function(){ document.getElementById('_qunc').select(); document.execCommand('copy') })
    })
  }
}

function showTab(name) {
  const tabs = ['events','cameras','services','qnap']
  tabs.forEach(t => {
    document.getElementById('pane-' + t).style.display = name===t ? 'block' : 'none'
    document.getElementById('tab-' + t).style.background = name===t ? '#7c6af7' : '#1e293b'
    document.getElementById('tab-' + t).style.color = name===t ? '#fff' : '#94a3b8'
  })
  location.hash = name
  if (name === 'cameras') { reloadSnapshots(); refreshMotionStates() }
  if (name === 'services') { stopRefresh(); loadServices() }
  else if (name === 'qnap') { stopRefresh(); loadQnap() }
  else if (document.getElementById('autorefresh-cb').checked) startRefresh()
}
// Auto-refresh
let refreshTimer = null
function startRefresh() {
  if (refreshTimer) return
  refreshTimer = setTimeout(() => location.reload(), 60000)
}
function stopRefresh() {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
}
document.addEventListener('DOMContentLoaded', () => {
  const tab = location.hash.replace('#','') || 'events'
  if (['cameras','services','qnap'].includes(tab)) showTab(tab)
  const cb = document.getElementById('autorefresh-cb')
  const saved = sessionStorage.getItem('autorefresh')
  if (saved === '0') { cb.checked = false } else { startRefresh() }
  cb.addEventListener('change', () => {
    sessionStorage.setItem('autorefresh', cb.checked ? '1' : '0')
    cb.checked ? startRefresh() : stopRefresh()
  })
})
function reloadSnapshots() {
  // Load snapshots one at a time with delay to avoid rate limiting
  const imgs = [...document.querySelectorAll('#pane-cameras img')]
  imgs.forEach((img, i) => {
    setTimeout(() => {
      const base = img.src.split('?')[0]
      img.style.display = 'block'
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'none'
      const newImg = new Image()
      newImg.onload = () => {
        img.src = newImg.src
        const snapId = img.getAttribute('data-snap-id')
        if (snapId) {
          const el = document.getElementById('snap-time-' + snapId)
          if (el) el.textContent = '📸 ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true})
        }
      }
      newImg.onerror = () => { img.style.display = 'none'; if (img.nextElementSibling) img.nextElementSibling.style.display = 'block' }
      newImg.src = base + '?t=' + Date.now()
    }, i * 1500)  // 1.5 second delay between each camera
  })
}
const recentToggles = {}
async function refreshMotionStates() {
  try {
    const states = await (await fetch('/api/camera-states')).json()
    for (const [name, s] of Object.entries(states)) {
      // Skip cameras toggled in the last 90s — Ring needs time to propagate
      if (recentToggles[name] && Date.now() - recentToggles[name].at < 90000) continue
      const btn = document.querySelector('button[data-cam="' + encodeURIComponent(name) + '"]')
      if (!btn) continue
      const on = s.motionEnabled
      btn.textContent = on ? '🔴 Motion On' : '⚪ Motion Off'
      btn.style.background    = on ? '#22c55e22' : '#f8717122'
      btn.style.borderColor   = on ? '#22c55e'   : '#f87171'
      btn.style.color         = on ? '#4ade80'   : '#f87171'
      btn.title = (on ? 'Disable' : 'Enable') + ' motion detection'
      btn.onclick = () => toggleMotion(btn, encodeURIComponent(name), !on)
    }
    // Re-sort grid: motion-on cards first
    const grid = document.querySelector('#pane-cameras .camera-grid')
    if (grid) {
      const cards = [...grid.children]
      cards.sort((a, b) => {
        const aOff = a.querySelector('button') && a.querySelector('button').textContent.includes('Off') ? 1 : 0
        const bOff = b.querySelector('button') && b.querySelector('button').textContent.includes('Off') ? 1 : 0
        return aOff - bOff
      })
      cards.forEach(c => grid.appendChild(c))
    }
  } catch(e) { console.warn('Could not refresh motion states', e) }
}
async function toggleMotion(btn, camName, enable) {
  btn.disabled = true
  btn.textContent = '...'
  try {
    const r = await fetch('/camera-motion', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name: decodeURIComponent(camName), enable })
    })
    const j = await r.json()
    if (j.ok) {
      recentToggles[decodeURIComponent(camName)] = { at: Date.now(), motionEnabled: enable }
      btn.textContent = enable ? '🔴 Motion On' : '⚪ Motion Off'
      btn.style.background = enable ? '#22c55e22' : '#f8717122'
      btn.style.borderColor = enable ? '#22c55e' : '#f87171'
      btn.style.color = enable ? '#4ade80' : '#f87171'
      btn.title = (enable ? 'Disable' : 'Enable') + ' motion detection'
      btn.onclick = () => toggleMotion(btn, camName, !enable)
    } else {
      btn.textContent = '⚠️ Error'
    }
  } catch(e) {
    btn.textContent = '⚠️ Error'
  }
  btn.disabled = false
}
</script>

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
  // This function builds the full tabbed control page
  const states = history.states ?? {}

  // Build Hue light controls
  const hueStates = Object.entries(states).filter(([k]) => k.startsWith('hue:light:'))
  const hueLights = hueStates.map(([key, s], i) => {
    const isOn = s.state === 'on'
    const color = isOn ? '#4ade80' : '#374151'
    const uniqueid = key.replace('hue:light:', '')
    return `<div class="device-card" data-hue-id="${uniqueid}">
      <div class="device-name">${s.name}</div>
      <div class="device-status" style="color:${color}">${s.state}</div>
      <div class="btn-group">
        <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="hueCmd('${uniqueid}', true)">On</button>
        <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="hueCmd('${uniqueid}', false)">Off</button>
      </div>
    </div>`
  }).join('')

  // Govee lights from states
  const goveeStates = Object.entries(states).filter(([k,v]) => k.startsWith('govee:') && v.category === 'Light')
  const goveeLights = goveeStates.map(([key, s]) => {
    const isOn = s.state === 'on'
    const color = isOn ? '#4ade80' : '#374151'
    const deviceId = key.replace('govee:', '').split(':').map((p,i) => i===0?p:p).join(':')
    // Govee device MAC from key e.g. govee:15:03:dd:99:83:46:67:49
    const mac = key.replace("govee:", "")
    return `<div class="device-card" data-govee-id="${mac}">
      <div class="device-name">💡 ${s.name}</div>
      <div class="device-status" style="color:${color}">${s.state}</div>
      <div class="btn-group">
        <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="goveeCmd('${mac}', true)">On</button>
        <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="goveeCmd('${mac}', false)">Off</button>
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
    return `<div class="device-card" data-ring-key="${deviceKey}">
      <div class="device-name">💡 ${s.name}</div>
      <div class="device-status" style="color:${color}">${s.state}</div>
      <div class="btn-group">
        <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="ringCmd('${deviceKey}', true)">On</button>
        <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="ringCmd('${deviceKey}', false)">Off</button>
      </div>
    </div>`
  }).join('')

  // SmartThings controls
  const garageState = states['smartthings:door:da595efc-94d0-4423-8c91-c7162a3d0310']
  const lockState   = states['smartthings:lock:5d9af01e-3ab3-40dc-91ec-e060ec7f801b']
  const rangeState  = states['smartthings:range:8184ceae-f175-b509-ab9d-bb2be1d79294']

  // Thermostat state
  const thermoState = states['smartthings:thermostat:904f48c1-b6ef-4b03-b311-65a7733a967d']
  const thermoCard = thermoState ? (() => {
    const parts = (thermoState.state || '').split(' ')
    const mode = parts[0] || 'unknown'
    const setpoint = parts[1] ? parseInt(parts[1]) : null
    const current = parts[2] ? parseInt(parts[2].replace(/[()F]/g,'')) : null
    const isCool = mode === 'cool'
    const isHeat = mode === 'heat'
    const isOff  = mode === 'off'
    // Use cooling setpoint when in cool mode, heating setpoint when in heat mode
    const displaySetpoint = setpoint || 70
    return `<div class="device-card" style="grid-column:1/-1">
      <div class="device-name">🌡️ Thermostat</div>
      <div class="device-status" style="color:#4ade80">${mode.toUpperCase()} · ${current ? current + '°F current' : ''} · ${displaySetpoint ? 'Set: ' + displaySetpoint + '°F' : ''}</div>
      <div class="btn-group" style="margin-bottom:8px">
        <button class="btn ${isCool?'btn-inactive':'btn-on'}" onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','cool')">❄️ Cool</button>
        <button class="btn ${isHeat?'btn-inactive':'btn-on'}" onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','heat')">🔥 Heat</button>
        <button class="btn ${isOff?'btn-inactive':'btn-on'}" onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','off')">Off</button>
      </div>
      ${setpoint ? `<div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
          <span>60°F</span><span style="color:#e2e8f0;font-weight:700">${setpoint}°F</span><span>85°F</span>
        </div>
        <input type="range" min="60" max="85" value="${setpoint}" 
          style="width:100%;accent-color:#7c6af7"
          oninput="this.previousElementSibling.children[1].textContent=this.value+'°F'"
          onchange="setpointCmd(parseInt(this.value))">
      </div>` : ''}
    </div>`
  })() : ''

  // Apple TV cards
  const appleTVStates = Object.entries(states).filter(([k]) => k.startsWith('appletv:') && !k.includes(':app:'))
  const appleTVCards = appleTVStates.map(([key, s]) => {
    const id = key.replace('appletv:', '')
    const appKey = `appletv:app:${id}`
    const app = states[appKey]?.state || ''
    const isPlaying = s.state !== 'Idle' && s.state !== 'Offline' && s.state !== 'closed'
    return `<div class="atv-card">
      <div class="device-name">📺 ${s.name}</div>
      <div class="atv-now-playing">${app ? '▶ ' + app : 'Idle'}</div>
      ${s.state !== 'Idle' && s.state !== 'closed' ? `<div class="device-status" style="color:#94a3b8;font-size:11px;margin-bottom:8px">${s.state}</div>` : ''}
      <div class="btn-group">
        <button class="btn btn-on" onclick="atvCmd('${id}', 'play_pause')">⏯</button>
        <button class="btn btn-on" onclick="atvCmd('${id}', 'volume_up')">🔊+</button>
        <button class="btn btn-on" onclick="atvCmd('${id}', 'volume_down')">🔊-</button>
        <button class="btn btn-danger" onclick="atvCmd('${id}', 'turn_off')">Off</button>
      </div>
    </div>`
  }).join('')

  const garageOpen = garageState?.state === 'active'
  const garageCard = garageState ? `<div class="device-card">
    <div class="device-name">🚗 Garage Door</div>
    <div class="device-status" style="color:${garageOpen?'#f87171':'#4ade80'}">${garageOpen?'Open':'Closed'}</div>
    <div class="btn-group">
      <button class="btn ${garageOpen?'btn-inactive':'btn-on'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','open')">Open</button>
      <button class="btn ${garageOpen?'btn-on':'btn-inactive'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','close')">Close</button>
    </div>
  </div>` : ''

  const lockUnlocked = lockState?.state === 'active'
  const lockCard = lockState ? `<div class="device-card">
    <div class="device-name">🔐 Front Door Lock</div>
    <div class="device-status" style="color:${lockUnlocked?'#f87171':'#4ade80'}">${lockUnlocked?'Unlocked':'Locked'}</div>
    <div class="btn-group">
      <button class="btn ${lockUnlocked?'btn-inactive':'btn-on'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','unlock')">Unlock</button>
      <button class="btn ${lockUnlocked?'btn-on':'btn-inactive'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','lock')">Lock</button>
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
  .btn-all-off{width:100%;padding:12px;background:#f87171;color:#0f172a;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;margin-bottom:16px}
  .btn-all-off:active{opacity:.7}
  .btn-all-off{width:100%;padding:12px;background:#f87171;color:#0f172a;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;margin-bottom:16px}
  .btn-all-off:active{opacity:.7}
  .status{padding:8px 12px;border-radius:8px;font-size:12px;margin-top:8px;display:none}
  .status.show{display:block;background:#1e293b;border:1px solid #334155}
</style>
</head>
<body>
<h1>🏠 Home Control</h1>
<div class="sub">Updated: ${now} · v${WATCHER_VERSION}</div>
<div id="status" class="status"></div>

<button class="btn-all-off" onclick="allLightsOff()">💡 All Lights Off</button>

<h2>Security</h2>
<div class="grid">${garageCard}${lockCard}</div>

<h2>Climate</h2>
<div class="grid">${thermoCard}</div>

<h2>Lights</h2>
<div class="grid">${hueLights}${ringLights}${goveeLights}</div>

<h2>TVs</h2>
<div class="grid">${rokuCard}</div>

<h2>Appliances</h2>
<div class="grid">${rangeCard}</div>

<script>
async function setpointCmd(temp) {
  showStatus('Setting to ' + temp + '°F...')
  const r = await fetch('/control/smartthings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ deviceId: '904f48c1-b6ef-4b03-b311-65a7733a967d', capability: 'thermostatCoolingSetpoint', command: 'setCoolingSetpoint', args: [temp] })
  })
  const d = await r.json()
  if (d.ok) {
    showStatus('\u2713 Set to ' + temp + '°F')
    // Update display without reloading
    document.querySelectorAll('input[type=range]').forEach(s => { s.value = temp })
    document.querySelectorAll('input[type=range]').forEach(s => {
      s.previousElementSibling.children[1].textContent = temp + '°F'
    })
  } else {
    showStatus('\u2717 ' + d.error)
  }
}

async function goveeCmd(mac, on) {
  showStatus('Sending...')
  const r = await fetch('/control/govee', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ device: mac, model: '', on })
  })
  const d = await r.json()
  showStatus(d.ok ? '\u2713 Done' : '\u2717 ' + d.error)
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.content').forEach(c => c.classList.remove('active'))
  document.getElementById('tab-' + name).classList.add('active')
  event.target.classList.add('active')
}

async function atvCmd(id, cmd) {
  showStatus('Sending ' + cmd + '...')
  const r = await fetch('/control/appletv', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id, cmd })
  })
  const d = await r.json()
  showStatus(d.ok ? '\u2713 Done' : '\u2717 ' + d.error)
}

async function allLightsOff() {
  showStatus('Turning all lights off...')
  const promises = []
  document.querySelectorAll('[data-hue-id]').forEach(el => {
    promises.push(fetch('/control/hue', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ uniqueid: el.dataset.hueId, on: false })
    }))
  })
  document.querySelectorAll('[data-ring-key]').forEach(el => {
    promises.push(fetch('/control/ring', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ deviceKey: el.dataset.ringKey, on: false })
    }))
  })
  document.querySelectorAll('[data-govee-id]').forEach(el => {
    promises.push(fetch('/control/govee', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ device: el.dataset.goveeId, model: '', on: false })
    }))
  })
  await Promise.all(promises)
  showStatus('\u2713 All lights off')
}

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
  el.className = 'status-bar show'
  setTimeout(() => el.classList.remove('show'), 3000)
}

// Auto-refresh when state changes
let lastHash = null
async function checkStateHash() {
  try {
    const r = await fetch('/control/state-hash')
    const d = await r.json()
    if (lastHash && lastHash !== d.hash) {
      location.reload()
    }
    lastHash = d.hash
  } catch(e) {}
}
checkStateHash()
setInterval(checkStateHash, 5000)
</script>
</body>
</html>`
}

function startDashboard() {
  const server = http.createServer(async (req, res) => {
    // Camera snapshot endpoint
    if (req.url?.startsWith('/snapshot/')) {
      const camName = decodeURIComponent(req.url.replace('/snapshot/', '').split('?')[0])
      try {
        if (!ringApiInstance) {
          console.log('Snapshot request: ringApiInstance not ready')
          res.writeHead(503); res.end('Ring API not ready'); return
        }
        const cameras = await ringApiInstance.getCameras()
        const cam = cameras.find(c => c.name === camName)
        if (!cam) {
          console.log(`Snapshot: camera "${camName}" not found. Available: ${cameras.map(c=>c.name).join(', ')}`)
          res.writeHead(404); res.end('Camera not found'); return
        }
        // Check if motion detection is enabled
        const motionEnabled = cam.data?.led_status !== 'off' && cam.isMotionDetectionEnabled !== false
        try {
          const snapshot = await cam.getSnapshot()
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-cache' })
          res.end(snapshot)
        } catch(snapErr) {
          if (snapErr.message?.includes('Motion detection is disabled')) {
            // Return a placeholder SVG image
            const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1e293b"/><text x="320" y="165" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="16">Motion Detection Disabled</text><text x="320" y="195" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="12">${camName}</text><text x="320" y="220" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="11">Enable in Ring app to see snapshots</text></svg>`)
            res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' })
            res.end(svg)
          } else {
            throw snapErr
          }
        }
      } catch(e) {
        console.log(`Snapshot error for ${camName}:`, e.message)
        res.writeHead(500); res.end(e.message)
      }
      return
    }
    if (req.method === 'POST' && req.url === '/camera-motion') {
      let body = ''
      req.on('data', d => body += d)
      req.on('end', async () => {
        try {
          const { name, enable } = JSON.parse(body)
          const cameras = await ringApiInstance.getCameras()
          const cam = cameras.find(c => c.name === name)
          if (!cam) { res.writeHead(404); res.end(JSON.stringify({ok:false,error:'Camera not found'})); return }
          try {
            await cam.setSettings({ motion_detection_enabled: enable })
          } catch(e1) {
            console.log(`[camera-motion] setSettings failed (${e1.response?.status}), trying setDeviceSettings with nested motion_settings...`)
            await cam.setDeviceSettings({ motion_settings: { motion_detection_enabled: enable } })
          }
          res.writeHead(200, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ok:true}))
        } catch(e) {
          console.error(`[camera-motion] error for ${JSON.parse(body).name}:`, e.message, JSON.stringify(e.response ?? {}))
          res.writeHead(500, {'Content-Type':'application/json'})
          res.end(JSON.stringify({ok:false,error:e.message}))
        }
      })
      return
    }
    if (req.method === 'GET' && req.url === '/api/camera-states') {
      try {
        const cameras = await ringApiInstance.getCameras()
        const states = {}
        await Promise.all(cameras.map(async cam => {
          let motionEnabled = true
          try {
            await cam.getSnapshot()
          } catch(e) {
            if (e.message?.toLowerCase().includes('motion detection')) motionEnabled = false
          }
          states[cam.name] = { motionEnabled }
        }))
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify(states))
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({}))
      }
      return
    }
    if (req.method === 'POST' && req.url === '/api/qnap/refresh') {
      if (global._qnapCache) global._qnapCache.ts = 0
      res.writeHead(200); res.end('ok')
      return
    }
    if (req.method === 'GET' && req.url.startsWith('/api/qnap/open-share')) {
      try {
        const reqUrl2 = new URL(req.url, 'http://localhost')
        const shareName = reqUrl2.searchParams.get('name') ?? ''
        // Validate: only alphanumeric, spaces, hyphens, underscores, dots
        if (!shareName || !/^[\w\s\-\.]+$/.test(shareName)) {
          res.writeHead(400); res.end('invalid share name'); return
        }
        let qnapHost = '192.168.1.176'
        try { qnapHost = JSON.parse(readFileSync('qnap_config.json', 'utf-8')).host ?? qnapHost } catch {}
        // Open SMB share in Finder (runs on the Mac Mini)
        exec(`open "smb://${qnapHost}/${encodeURIComponent(shareName)}"`)
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ ok: true, share: shareName }))
      } catch(e) {
        res.writeHead(500); res.end(e.message)
      }
      return
    }
    if (req.method === 'GET' && req.url === '/api/qnap') {
      // Cache result for 5 minutes
      const QNAP_CACHE_MS = 5 * 60 * 1000
      if (!global._qnapCache) global._qnapCache = { ts: 0, data: null }
      if (global._qnapCache.data && Date.now() - global._qnapCache.ts < QNAP_CACHE_MS) {
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify(global._qnapCache.data))
        return
      }
      try {
        let qnapCfg = { host: '192.168.1.176', snmp_community: 'public', snmp_port: 161 }
        try { qnapCfg = { ...qnapCfg, ...JSON.parse(readFileSync('qnap_config.json', 'utf-8')) } } catch {}

        const snmp = await import('net-snmp')
        const session = snmp.createSession(qnapCfg.host, qnapCfg.snmp_community ?? 'public', {
          port: qnapCfg.snmp_port ?? 161, timeout: 5000, retries: 1, version: snmp.Version2c
        })

        function snmpGet(oids) {
          return new Promise((resolve, reject) => {
            session.get(oids, (err, varbinds) => {
              if (err) return reject(err)
              const result = {}
              varbinds.forEach((v, i) => {
                result[oids[i]] = snmp.isVarbindError(v) ? null : v.value?.toString() ?? null
              })
              resolve(result)
            })
          })
        }

        function snmpTable(oid) {
          return new Promise((resolve, reject) => {
            const rows = {}
            session.subtree(oid, 20, (varbinds) => {
              varbinds.forEach(v => {
                if (snmp.isVarbindError(v)) return
                const parts = v.oid.split('.')
                const col = parts[parts.length - 2]
                const row = parts[parts.length - 1]
                if (!rows[row]) rows[row] = {}
                rows[row][col] = v.value?.toString() ?? null
              })
            }, (err) => {
              if (err && Object.keys(rows).length === 0) return reject(err)
              resolve(Object.values(rows))
            })
          })
        }

        // QNAP NAS-MIB OIDs (enterprise 24681)
        const SYS_OIDs = {
          cpu:      '1.3.6.1.4.1.24681.1.2.1.0',
          memUsed:  '1.3.6.1.4.1.24681.1.2.2.0',
          memTotal: '1.3.6.1.4.1.24681.1.2.3.0',
          hostname: '1.3.6.1.2.1.1.5.0',
          uptime:   '1.3.6.1.2.1.1.3.0',
          sysDesc:  '1.3.6.1.2.1.1.1.0',
        }

        let sysinfo = {}, volumes = [], disks = []

        // System info
        try {
          const vals = await snmpGet(Object.values(SYS_OIDs))
          const cpuRaw = vals[SYS_OIDs.cpu] ?? ''
          const cpuPct = parseInt(cpuRaw.replace('%','')) || null
          // QNAP: .2.0 = total, .3.0 = free (not used); derive used from total-free
          const memA = parseInt(vals[SYS_OIDs.memUsed])  || null
          const memB = parseInt(vals[SYS_OIDs.memTotal]) || null
          // Whichever is larger is total
          const memTotal = (memA && memB) ? Math.max(memA, memB) : (memA ?? memB)
          const memOther = (memA && memB) ? Math.min(memA, memB) : null
          // If memOther looks like free space (smaller), used = total - free
          const memUsed  = (memTotal && memOther) ? memTotal - memOther : memTotal
          const uptimeTicks = parseInt(vals[SYS_OIDs.uptime]) || 0
          const uptimeSecs  = Math.floor(uptimeTicks / 100)
          const uptimeStr   = uptimeSecs > 86400
            ? `${Math.floor(uptimeSecs/86400)}d ${Math.floor((uptimeSecs%86400)/3600)}h`
            : `${Math.floor(uptimeSecs/3600)}h ${Math.floor((uptimeSecs%3600)/60)}m`
          const sysDesc = vals[SYS_OIDs.sysDesc] ?? ''
          // sysDesc format: "Linux TS-X53E 5.2.9.3499" → model=TS-X53E, firmware=5.2.9.3499
          const descParts = sysDesc.split(' ')
          const fwMatch = sysDesc.match(/(\d+\.\d+\.\d+[\.\d]*)/)
          sysinfo = {
            hostname:  vals[SYS_OIDs.hostname],
            model:     descParts.slice(0,3).join(' ') || null,
            firmware:  fwMatch?.[1] ?? null,
            uptime:    uptimeStr,
            cpu_usage: cpuPct,
            mem_used:  memUsed,
            mem_total: memTotal,
          }
        } catch(e) { sysinfo = { error: 'SNMP system info failed: ' + e.message } }

        // Volumes (QNAP-MIB volumeTable: 1.3.6.1.4.1.24681.1.2.17)
        // Confirmed cols: 1=index, 2=label, 3=fsType, 4=totalSize, 5=freeSize, 6=status
        try {
          const rawVolumes = await snmpTable('1.3.6.1.4.1.24681.1.2.17')
          function parseSize(str) {
            // Parse "11.41 TB", "8.62 TB", "500 GB" etc → GB number
            if (!str) return null
            const m = str.match(/^([\d.]+)\s*(TB|GB|MB)/i)
            if (!m) return null
            const n = parseFloat(m[1])
            const u = m[2].toUpperCase()
            return u === 'TB' ? n * 1024 : u === 'MB' ? n / 1024 : n
          }
          function fmtSize(str) {
            // Return size string as-is if it has a unit, else format from GB
            if (!str) return null
            if (/TB|GB|MB/i.test(str)) return str.trim()
            const n = parseFloat(str)
            return isNaN(n) ? null : n >= 1024 ? (n/1024).toFixed(2)+' TB' : n.toFixed(2)+' GB'
          }
          volumes = rawVolumes.map(r => {
            const totalGB = parseSize(r['4'])
            const freeGB  = parseSize(r['5'])
            const usedGB  = (totalGB != null && freeGB != null) ? totalGB - freeGB : null
            const pct     = (totalGB && usedGB != null) ? Math.round((usedGB / totalGB) * 100) : null
            const rawLabel = r['2'] ?? '?'
            const cleanLabel = rawLabel
              .replace(/\[Volume ([^,]+),.+\]/, '$1')
              .replace(/\[Single Disk Volume:\s*[^']*'([^']+)'\]/, 'USB Drive ($1)')
              .trim()
            return {
              label:    cleanLabel,
              status:   r['6'] ?? '?',
              fsType:   r['3'] ?? null,
              total:    fmtSize(r['4']),
              free:     fmtSize(r['5']),
              used:     usedGB != null ? (usedGB >= 1024 ? (usedGB/1024).toFixed(2)+' TB' : usedGB.toFixed(2)+' GB') : null,
              used_pct: pct
            }
          })
        } catch(e) { volumes = [{ label: 'Error', status: e.message }] }

        // Disks (QNAP-MIB diskTable: 1.3.6.1.4.1.24681.1.2.11)
        try {
          const rows = await snmpTable('1.3.6.1.4.1.24681.1.2.11')
          disks = rows.map(r => {
            // Actual QNAP cols: 1=index, 2=slot(HDD1..), 3=temp("45 C/113 F"), 4=?, 5=model, 6=capacity, 7=health/smart
            const tempStr = r['3'] ?? ''
            const tempMatchC = tempStr.match(/^(\d+)\s*C/)
            const tempMatchF = tempStr.match(/(\d+)\s*F/)
            const temp = tempMatchF ? parseInt(tempMatchF[1]) : (tempMatchC ? Math.round(parseInt(tempMatchC[1]) * 9/5 + 32) : null)
            const tempUnit = 'F'
            const capacity = r['6'] ?? null
            const health = r['7'] ?? null
            const model = r['5'] ?? null
            const isEmpty = !model || model === '--' || (capacity && parseFloat(capacity) < 0)
            return {
              slot: r['2'] ?? ('Drive ' + (r['1'] ?? '?')),
              model: isEmpty ? null : model,
              capacity: isEmpty ? null : capacity,
              temp: isEmpty ? null : temp,
              tempUnit: 'F',
              health: isEmpty ? 'Empty' : (health && health !== '--' ? health : 'Good'),
              empty: isEmpty
            }
          }).filter(d => d.slot)
        } catch(e) { disks = [] }

        session.close()

        // Apps via SSH (QNAP CGI auth disabled in QTS 5 passwordless mode)
        let apps = []
        let shares = []
        let tmBundles = []
        try {
          function xmlVal(xml, tag) {
            const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([^\\]<]+?)(?:\\]\\]>)?<\\/${tag}>`))
            return m?.[1]?.trim() ?? null
          }

          // Get installed apps + share list via SSH
          if (qnapCfg.ssh_user && qnapCfg.ssh_pass && qnapCfg.ssh_pass !== 'YOUR_PASSWORD_HERE') {
            try {
              const { Client } = await import('ssh2')
              const sshResult = await new Promise((resolve) => {
                const conn = new Client()
                let output = ''
                conn.on('ready', () => {
                  // Combined command: qpkg list + share symlinks separated by marker
                  const cmd = "ls /share/CACHEDEV1_DATA/.qpkg/ 2>/dev/null && echo '===SHARES===' && find /share -maxdepth 1 -type l -exec basename {} \\; 2>/dev/null | sort && echo '===TM_BUNDLES===' && find /share -maxdepth 4 -name '*.sparsebundle' 2>/dev/null | while IFS= read -r f; do mod=$(stat -c '%Y' \"$f\" 2>/dev/null); echo \"${f}|${mod}\"; done && echo '===USB_VOLS===' && df -k /share/USB* /share/external* 2>/dev/null || true"
                  conn.exec(cmd, (err, stream) => {
                    if (err) { conn.end(); resolve({ apps: [], shares: [], tmBundles: [] }); return }
                    stream.on('data', d => output += d)
                    stream.on('close', () => {
                      conn.end()
                      const parts = output.split(/===SHARES===|===TM_BUNDLES===|===USB_VOLS===/)
                      const appsPart   = parts[0] ?? ''
                      const sharesPart = parts[1] ?? ''
                      const tmPart     = parts[2] ?? ''
                      const pkgs = appsPart.trim().split('\n')
                        .map(n => n.trim().replace(/\/$/, ''))
                        .filter(n => n && !n.startsWith('.'))
                        .map(name => ({ name, status: 'enabled', version: '' }))
                      const shareList = sharesPart.trim().split('\n')
                        .map(n => n.trim())
                        .filter(n => n && !n.startsWith('.'))
                      const tmBundles = tmPart.trim().split('\n').filter(Boolean).map(line => {
                        const pipeIdx = line.lastIndexOf('|')
                        const path    = pipeIdx > -1 ? line.slice(0, pipeIdx) : line
                        const epoch   = pipeIdx > -1 ? parseInt(line.slice(pipeIdx + 1)) || 0 : 0
                        const machine = path.split('/').pop().replace(/\.sparsebundle$/, '')
                        return { machine, lastBackup: epoch ? new Date(epoch * 1000).toISOString() : null, path }
                      }).filter(b => b.machine)
                      const usbPart = parts[3] ?? ''
                      const usbVols = usbPart.trim().split('\n').slice(1).filter(Boolean).map(line => {
                        const p = line.trim().split(/\s+/)
                        if (p.length < 6) return null
                        const totalKB = parseInt(p[1]); const usedKB = parseInt(p[2]); const mount = p[5]
                        if (!totalKB || isNaN(totalKB)) return null
                        const totalGB = totalKB / 1048576; const freeGB = (totalKB - usedKB) / 1048576
                        const pct = Math.round(usedKB / totalKB * 100)
                        const label = mount.replace('/share/', '').replace(/_DATA$/, '')
                        return { label, status: 'Ready', fsType: 'USB', total: totalGB >= 1024 ? (totalGB/1024).toFixed(2)+' TB' : totalGB.toFixed(2)+' GB', free: freeGB >= 1024 ? (freeGB/1024).toFixed(2)+' TB' : freeGB.toFixed(2)+' GB', used: ((totalKB-usedKB)/1048576 >= 1024 ? ((totalKB-usedKB)/1073741824).toFixed(2)+' TB' : ((totalKB-usedKB)/1048576).toFixed(2)+' GB'), used_pct: pct }
                      }).filter(v => v && v.total && parseFloat(v.total) > 1)
                      resolve({ apps: pkgs, shares: shareList, tmBundles, usbVols })
                    })
                  })
                })
                conn.on('error', () => resolve({ apps: [], shares: [], tmBundles: [] }))
                conn.connect({ host: qnapCfg.host, port: qnapCfg.ssh_port ?? 22, username: qnapCfg.ssh_user, password: qnapCfg.ssh_pass, readyTimeout: 5000 })
              })
              apps = sshResult.apps
              shares    = sshResult.shares
              tmBundles = sshResult.tmBundles ?? []
              if (sshResult.usbVols?.length) volumes = [...volumes, ...sshResult.usbVols]
            } catch(e) { console.log('[QNAP] SSH error:', e.message) }
          }
        } catch(e) { console.log('[QNAP] apps fetch error:', e.message) }

        const qnapResult = { host: qnapCfg.host, source: 'snmp', sysinfo, volumes, disks, apps, shares, tmBundles }
        global._qnapCache = { ts: Date.now(), data: qnapResult }
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify(qnapResult))
      } catch(e) {
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    if (req.method === 'POST' && req.url.startsWith('/api/mac-kill')) {
      try {
        const pid = parseInt(new URL(req.url, 'http://localhost').searchParams.get('pid') ?? '')
        if (!pid || pid < 2) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'invalid pid' })); return }
        await execAsync('kill -15 ' + pid).catch(() => execAsync('kill -9 ' + pid))
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true }))
      } catch(e) {
        res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: false, error: e.message }))
      }
      return
    }
    if (req.method === 'GET' && req.url === '/api/tm-backups') {
      try {
        let backups = []
        let debug = {}
        try {
          const { stdout: nameOut } = await execAsync('scutil --get ComputerName 2>/dev/null').catch(() => ({ stdout: '' }))
          const machine = nameOut.trim() || 'This Mac'

          // Requires Full Disk Access granted to the node binary in
          // System Settings → Privacy & Security → Full Disk Access
          let lines = []
          try {
            const { stdout: listOut } = await execAsync('tmutil listbackups 2>/dev/null')
            lines = listOut.trim().split('\n').filter(Boolean)
          } catch(e) { debug.error = 'tmutil failed — grant Full Disk Access to node in System Settings' }

          // APFS TM format: /Volumes/.timemachine/<UUID>/<YYYY-MM-DD-HHMMSS>.backup[/...]
          // Legacy format:  .../Backups.backupdb/<Machine>/<YYYY-MM-DD-HHMMSS>
          const parsed = lines.map((path, idx) => {
            let raw = null
            let machineName = machine
            const apfs = path.match(/(\d{4}-\d{2}-\d{2}-\d{6})\.backup/)
            if (apfs) {
              raw = apfs[1]
            } else {
              const legacy = path.match(/Backups\.backupdb\/([^/]+)\/(\d{4}-\d{2}-\d{2}-\d{6})/)
              if (legacy) { machineName = legacy[1]; raw = legacy[2] }
            }
            if (!raw) return null
            // YYYY-MM-DD-HHMMSS → YYYY-MM-DDTHH:MM:SS
            const iso = raw.replace(/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/, '$1T$2:$3:$4')
            return { machine: machineName, date: iso, type: idx === 0 ? 'Full' : 'Incremental', path }
          }).filter(Boolean)
          // Most recent first
          backups = parsed.reverse()
        } catch(e) { backups = [] }
        const tmJson = JSON.stringify({ backups, debug })
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(tmJson)
      } catch(e) {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
      }
      return
    }

    if (req.method === 'GET' && req.url === '/api/mac-stats') {
      try {
        const os = await import('os')
        const totalMem = os.totalmem()
        const cpus     = os.cpus()

        // Use vm_stat for accurate macOS memory breakdown (os.freemem only counts truly free pages)
        let vmStatMem = null
        try {
          const { stdout: vmStatOut } = await execAsync('vm_stat')
          const pageSizeMatch = vmStatOut.match(/page size of (\d+) bytes/)
          const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : 4096
          const getPages = (key) => {
            const m = vmStatOut.match(new RegExp(key + ':\\s+([\\d]+)'))
            return m ? parseInt(m[1]) * pageSize : 0
          }
          vmStatMem = {
            free:       getPages('Pages free'),
            active:     getPages('Pages active'),
            inactive:   getPages('Pages inactive'),
            wired:      getPages('Pages wired down'),
            compressed: getPages('Pages occupied by compressor'),
            speculative:getPages('Pages speculative')
          }
        } catch(e) {}
        // Truly in-use = wired + active + compressed (inactive is reclaimable cache)
        const usedMem = vmStatMem
          ? (vmStatMem.wired + vmStatMem.active + vmStatMem.compressed)
          : (totalMem - os.freemem())
        const loadAvg  = os.loadavg()
        const uptime   = os.uptime()
        const cpuPct   = Math.min(100, Math.round((loadAvg[0] / cpus.length) * 100))
        const uptimeStr = uptime > 86400
          ? Math.floor(uptime/86400) + 'd ' + Math.floor((uptime%86400)/3600) + 'h'
          : Math.floor(uptime/3600) + 'h ' + Math.floor((uptime%3600)/60) + 'm'

        // Top memory hogs via ps — group by process name
        let topProcs = []
        try {
          const { stdout: psOut } = await execAsync('ps aux -m')
          const psLines = psOut.trim().split('\n').slice(1)
          const grouped = {}
          psLines.forEach(line => {
            const parts = line.trim().split(/\s+/)
            const rss = parseInt(parts[5]) || 0
            const cpu = parseFloat(parts[2]) || 0
            const mem = parseFloat(parts[3]) || 0
            const pid = parts[1]
            let name = parts.slice(10).join(' ').replace(/.*\//, '').split(' ')[0] || '?'
            // Normalize Chrome/Electron helper variants
            if (/chrome helper|google chrome helper/i.test(name) || /chrome.*helper/i.test(parts.slice(10).join(' '))) name = 'Chrome Helper'
            if (/google chrome$/i.test(parts.slice(10).join(' '))) name = 'Google Chrome'
            if (!grouped[name]) grouped[name] = { name, rss_kb: 0, cpu_pct: 0, mem_pct: 0, count: 0, pid }
            grouped[name].rss_kb  += rss
            grouped[name].cpu_pct += cpu
            grouped[name].mem_pct += mem
            grouped[name].count++
          })
          topProcs = Object.values(grouped)
            .sort((a, b) => b.rss_kb - a.rss_kb)
            .slice(0, 15)
            .map(p => ({
              pid:     p.count > 1 ? p.count + ' procs' : p.pid,
              cpu_pct: p.cpu_pct.toFixed(1),
              mem_pct: p.mem_pct.toFixed(1),
              rss_kb:  p.rss_kb,
              name:    p.name
            }))
        } catch(e) {}

        // Disk usage via df — include internal + external USB volumes
        let disks = []
        try {
          const { stdout } = await execAsync('df -k 2>/dev/null')
          const lines = stdout.trim().split('\n').slice(1)
          const all = lines.map(line => {
            const parts = line.trim().split(/\s+/)
            const total = parseInt(parts[1]) * 1024
            const used  = parseInt(parts[2]) * 1024
            const pct   = parseInt(parts[4])
            const mount = parts[8] ?? parts[5] ?? '/'
            return { mount, total, used, pct }
          }).filter(d =>
            d.mount === '/' ||
            d.mount === '/System/Volumes/Data' ||
            (d.mount.startsWith('/Volumes/') && !d.mount.startsWith('/Volumes/.timemachine') && d.total > 0 && !isNaN(d.total))
          )
          // Internal: prefer /System/Volumes/Data over /
          const internal = all.filter(d => d.mount === '/' || d.mount === '/System/Volumes/Data')
          const external = all.filter(d => d.mount.startsWith('/Volumes/'))
          const primary = internal.length > 1 ? internal.filter(d => d.mount === '/System/Volumes/Data') : internal
          disks = [...primary, ...external]
        } catch(e) {}

        // Stringify BEFORE writeHead so any serialization error is caught cleanly
        const macJson = JSON.stringify({
          cpu_pct: cpuPct,
          load_avg: loadAvg.map(l => Math.round(l * 100) / 100),
          cpu_count: cpus.length,
          cpu_model: cpus[0]?.model ?? null,
          mem_total:      totalMem,
          mem_used:       usedMem,
          mem_pct:        Math.round((usedMem / totalMem) * 100),
          mem_wired:      vmStatMem?.wired      ?? null,
          mem_active:     vmStatMem?.active     ?? null,
          mem_inactive:   vmStatMem?.inactive   ?? null,
          mem_compressed: vmStatMem?.compressed ?? null,
          mem_free:       vmStatMem?.free       ?? null,
          uptime: uptimeStr,
          hostname: os.hostname(),
          disks,
          top_procs: topProcs
        })
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(macJson)
      } catch(e) {
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })) }
      }
      return
    }
    if (req.method === 'GET' && req.url === '/api/services') {
      try {
        // Known labels (port → description)
        const knownLabels = {
          '21': 'FTP', '22': 'SSH', '23': 'Telnet', '25': 'SMTP', '53': 'DNS',
          '80': 'HTTP', '110': 'POP3', '143': 'IMAP', '443': 'HTTPS', '445': 'SMB',
          '548': 'AFP (Apple File Sharing)', '631': 'CUPS (Printing)',
          '3000': 'Node dev server', '3306': 'MySQL', '5432': 'PostgreSQL',
          '5555': 'Hue webhook listener', '5558': 'Home Monitor dashboard',
          '5559': 'Home Monitor control', '5560': 'Speed Monitor dashboard',
          '7000': 'AirPlay', '7100': 'Font Service', '8080': 'HTTP alt',
          '8888': 'Jupyter Notebook',
          // macOS system services
          '49152': 'macOS dynamic port', '5060': 'CommCenter (iPhone Mirroring/Continuity)',
          '49162': 'rapportd (Handoff/Universal Clipboard)',
          '57621': 'Spotify local discovery', '7768': 'Spotify local web helper',
          '62718': 'Spotify',
          // App ports
          '57889': 'Parallels Desktop',
        }
        // Process name → description fallback
        const procLabels = {
          'rapportd': 'Apple Rapport (Handoff/Universal Clipboard)',
          'CommCente': 'CommCenter (iPhone Mirroring/Continuity)',
          'Parallels': 'Parallels Desktop',
          'Spotify': 'Spotify',
        }
        // Load custom labels from service_labels.json if present
        let customLabels = {}
        try { customLabels = JSON.parse(readFileSync('service_labels.json', 'utf-8')) } catch {}
        const labels = { ...knownLabels, ...customLabels }

        const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n', { timeout: 5000 })
        const ports = []
        const seen = new Set()
        for (const line of stdout.split('\n').slice(1)) {
          const parts = line.trim().split(/\s+/)
          if (parts.length < 9) continue
          const proc = parts[0], pid = parts[1], addr = parts[8] ?? ''
          const portMatch = addr.match(/:(\d+)$/)
          if (!portMatch) continue
          const port = parseInt(portMatch[1])
          const key = `${port}:${pid}`
          if (seen.has(key)) continue
          seen.add(key)
          const description = labels[String(port)] ?? procLabels[proc] ?? ''
          ports.push({ port, process: proc, pid, description })
        }
        ports.sort((a, b) => a.port - b.port)

        // Launch Agents
        const launchAgents = []
        try {
          const laDir = `/Users/${process.env.USER}/Library/LaunchAgents`
          const { stdout: lsOut } = await execAsync(`ls "${laDir}"`, { timeout: 3000 })
          const { stdout: lcList } = await execAsync('launchctl list', { timeout: 3000 })
          const runningLabels = new Set(lcList.split('\n').map(l => l.split('\t')[2]).filter(Boolean))

          for (const file of lsOut.split('\n').filter(f => f.endsWith('.plist'))) {
            try {
              const { stdout: plistOut } = await execAsync(`plutil -convert json -o - "${laDir}/${file}"`, { timeout: 3000 })
              const plist = JSON.parse(plistOut)
              const label = plist.Label ?? file.replace('.plist','')
              const prog = plist.ProgramArguments?.[0] ?? plist.Program ?? ''
              const args = (plist.ProgramArguments ?? []).slice(1).join(' ')
              const script = args ? `${prog} ${args}` : prog
              const running = runningLabels.has(label)
              launchAgents.push({ label, script: script.replace(/\/Users\/[^/]+/g, '~'), running })
            } catch { /* skip unparseable */ }
          }
        } catch(e) {
          launchAgents.push({ label: 'Error reading launch agents', script: e.message, running: false })
        }

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ports, launchAgents }))
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({ ports: [], error: e.message }))
      }
      return
    }

    if (req.url !== '/' && req.url !== '/dashboard') { res.writeHead(404); res.end(); return }
    try {
      const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
      const devices = existsSync('devices.json') ? JSON.parse(readFileSync('devices.json', 'utf-8')) : { devices: [] }
      const html = await buildDashboard(history, devices)
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

    // Basic auth check
    const AUTH_USER = process.env.HOME_CONTROL_USER || 'gary'
    const AUTH_PASS = process.env.HOME_CONTROL_PASS || 'home2026'
    const authHeader = req.headers['authorization']
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Home Control"', 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Authentication required</h2></body></html>')
      return
    }
    const [user, pass] = Buffer.from(authHeader.slice(6), 'base64').toString().split(':')
    if (user !== AUTH_USER || pass !== AUTH_PASS) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Home Control"', 'Content-Type': 'text/html' })
      res.end('<html><body><h2>Invalid credentials</h2></body></html>')
      return
    }

    // Mac Mini API proxy — merge mac-stats + services into one response
    if (req.url?.startsWith('/api/macmini')) {
      try {
        const base = `http://localhost:${DASHBOARD_PORT}`
        const [statsResp, svcResp] = await Promise.all([
          fetch(`${base}/api/mac-stats`),
          fetch(`${base}/api/services`)
        ])
        const s = await statsResp.json()
        const svc = await svcResp.json()
        const GB = (b) => (b / 1073741824).toFixed(1)
        const allDisks = (s.disks ?? []).map(d => ({
          label: (d.mount === '/System/Volumes/Data' || d.mount === '/') ? 'Internal SSD' : d.mount.replace('/Volumes/', ''),
          mount: d.mount,
          pct:   d.pct ?? 0,
          free:  (d.total && d.used) ? GB(d.total - d.used) + ' GB' : '-',
          total: d.total ? GB(d.total) + ' GB' : '-'
        }))
        const disk = allDisks[0] ?? {}
        const merged = {
          cpu:       s.cpu_pct ?? 0,
          mem_pct:   s.mem_pct ?? 0,
          mem_used:  GB(s.mem_used  ?? 0),
          mem_total: GB(s.mem_total ?? 0),
          disk_pct:  disk.pct ?? 0,
          disk_free:  disk.free ?? '-',
          disk_total: disk.total ?? '-',
          disks: allDisks,
          model:  s.cpu_model ?? '',
          uptime: s.uptime    ?? '',
          processes: (s.top_procs ?? []).map(p => ({
            pid:  p.pid,
            name: p.name,
            mem:  p.mem_pct,
            rss:  p.rss_kb > 1048576 ? (p.rss_kb/1048576).toFixed(1)+' GB' : Math.round(p.rss_kb/1024)+' MB',
            cpu:  p.cpu_pct
          })),
          services: svc.ports       ?? [],
          agents:   svc.launchAgents ?? []
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(merged))
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // QNAP API proxy - forward to monitor server
    if (req.url?.startsWith('/api/qnap')) {
      try {
        const proxyResp = await fetch(`http://localhost:${DASHBOARD_PORT}${req.url}`, {
          method: req.method,
        })
        const body = await proxyResp.text()
        res.writeHead(proxyResp.status, {'Content-Type': proxyResp.headers.get('Content-Type') || 'application/json'})
        res.end(body)
      } catch(e) {
        res.writeHead(500); res.end(JSON.stringify({error: e.message}))
      }
      return
    }

    // Camera snapshot proxy
    if (req.url?.startsWith('/snapshot/')) {
      const camName = decodeURIComponent(req.url.replace('/snapshot/', '').split('?')[0])
      try {
        if (!ringApiInstance) { res.writeHead(503); res.end('Ring not ready'); return }
        const cams = await ringApiInstance.getCameras()
        const cam = cams.find(c => c.name === camName)
        if (!cam) { res.writeHead(404); res.end(); return }
        try {
          const snapshot = await cam.getSnapshot()
          res.writeHead(200, {'Content-Type':'image/jpeg','Cache-Control':'no-cache'})
          res.end(snapshot)
        } catch(snapErr) {
          if (snapErr.message?.includes('Motion detection is disabled')) {
            const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="640" height="200" fill="#1e293b"/><text x="320" y="90" text-anchor="middle" fill="#64748b" font-family="sans-serif" font-size="14">Motion Detection Disabled</text><text x="320" y="115" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="11">${camName}</text></svg>`)
            res.writeHead(200, {'Content-Type':'image/svg+xml'})
            res.end(svg)
          } else { res.writeHead(500); res.end() }
        }
      } catch(e) { res.writeHead(500); res.end(e.message) }
      return
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/control')) {
      try {
        const html = readFileSync('/Users/garyscudder/epg/control_page.html', 'utf-8')
        res.writeHead(200, {'Content-Type':'text/html'})
        res.end(html)
      } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
      return
    }

    if (req.method === 'GET' && req.url === '/control/data') {
      try {
        const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        const states = history.states ?? {}
        const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

        // Build security tab
        const garageState = states['smartthings:door:da595efc-94d0-4423-8c91-c7162a3d0310']
        const lockState   = states['smartthings:lock:5d9af01e-3ab3-40dc-91ec-e060ec7f801b']
        const garageOpen  = garageState?.state === 'active'
        const lockUnlocked = lockState?.state === 'active'

        const security = `<div class="grid">
          ${garageState ? `<div class="device-card">
            <div class="device-name">🚗 Garage Door</div>
            <div class="device-status" style="color:${garageOpen?'#f87171':'#4ade80'}">${garageOpen?'OPEN':'CLOSED'}</div>
            <div class="btn-group">
              <button class="btn ${garageOpen?'btn-inactive':'btn-on'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','open')">Open</button>
              <button class="btn ${garageOpen?'btn-on':'btn-inactive'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','close')">Close</button>
            </div></div>` : ''}
          ${lockState ? `<div class="device-card">
            <div class="device-name">🔐 Front Door Lock</div>
            <div class="device-status" style="color:${lockUnlocked?'#f87171':'#4ade80'}">${lockUnlocked?'UNLOCKED':'LOCKED'}</div>
            <div class="btn-group">
              <button class="btn ${lockUnlocked?'btn-inactive':'btn-on'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','unlock')">Unlock</button>
              <button class="btn ${lockUnlocked?'btn-on':'btn-inactive'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','lock')">Lock</button>
            </div></div>` : ''}
        </div>`

        // Build lights tab
        const hueStates = Object.entries(states).filter(([k]) => k.startsWith('hue:light:'))
        const hueLights = hueStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const uniqueid = key.replace('hue:light:','')
          return `<div class="device-card" data-hue-id="${uniqueid}">
            <div class="device-name">${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="hueCmd('${uniqueid}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="hueCmd('${uniqueid}',false)">Off</button>
            </div></div>`
        }).join('')

        const allRingStates = Object.entries(states).filter(([k,v]) => k.startsWith('ring:light:') && v.category === 'Light')
        const ringNames = new Set()
        const ringStates = allRingStates.filter(([k,v]) => {
          const name = (v.name||'').toLowerCase()
          if (ringNames.has(name)) return false
          const isDup = allRingStates.some(([k2,v2]) => k2!==k && (v2.name||'').toLowerCase().includes(name) && (v2.name||'').length>(v.name||'').length)
          if (isDup) return false
          ringNames.add(name); return true
        })
        const ringLights = ringStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const deviceKey = key.replace('ring:light:','')
          return `<div class="device-card" data-ring-key="${deviceKey}">
            <div class="device-name">💡 ${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="ringCmd('${deviceKey}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="ringCmd('${deviceKey}',false)">Off</button>
            </div></div>`
        }).join('')

        const goveeStates = Object.entries(states).filter(([k,v]) => k.startsWith('govee:') && v.category === 'Light')
        const goveeLights = goveeStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const mac = key.replace('govee:','')
          return `<div class="device-card" data-govee-id="${mac}">
            <div class="device-name">💡 ${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="goveeCmd('${mac}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="goveeCmd('${mac}',false)">Off</button>
            </div></div>`
        }).join('')

        const lights = `<button class="btn-all-off" onclick="allLightsOff()">💡 All Lights Off</button><div class="grid">${hueLights}${ringLights}${goveeLights}</div>`

        // Build climate tab
        const thermoState = states['smartthings:thermostat:904f48c1-b6ef-4b03-b311-65a7733a967d']
        let climate = '<p style="color:#64748b">No thermostat data</p>'
        if (thermoState) {
          const parts = (thermoState.state||'').split(' ')
          const mode = parts[0]||'unknown'
          const setpoint = parts[1] ? parseInt(parts[1]) : 70
          const current = parts[2] ? parseInt(parts[2].replace(/[()F]/g,'')) : null
          const isCool = mode==='cool', isHeat = mode==='heat', isOff = mode==='off'
          climate = `<div class="device-card" style="grid-column:1/-1">
            <div class="device-name">🌡️ Thermostat</div>
            <div class="device-status" style="color:#4ade80">${mode.toUpperCase()} · ${current?current+'°F current':''} · Set: ${setpoint}°F</div>
            <div class="btn-group" style="margin-bottom:8px">
              <button class="btn ${isCool?'btn-inactive':'btn-on'}" ${isCool?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','cool')">❄️ Cool</button>
              <button class="btn ${isHeat?'btn-inactive':'btn-on'}" ${isHeat?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','heat')">🔥 Heat</button>
              <button class="btn ${isOff?'btn-inactive':'btn-on'}" ${isOff?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','off')">Off</button>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
                <span>60°F</span><span style="color:#e2e8f0;font-weight:700" id="spLabel">${setpoint}°F</span><span>85°F</span>
              </div>
              <input type="range" min="60" max="85" value="${setpoint}"
                oninput="document.getElementById('spLabel').textContent=this.value+'°F'"
                onchange="setpointCmd(parseInt(this.value))">
            </div>
          </div>`
        }

        // Build TVs tab
        const appleTVStates = Object.entries(states).filter(([k]) => k.startsWith('appletv:') && !k.includes(':app:'))
        const appleTVCards = appleTVStates.map(([key, s]) => {
          const id = key.replace('appletv:','')
          const app = states['appletv:app:'+id]?.state || ''
          return `<div class="atv-card">
            <div class="device-name">📺 ${s.name}</div>
            <div class="now-playing">${app ? '▶ ' + app : 'Idle'}</div>
            <div style="font-size:11px;color:${s.state==='Offline'||s.state==='closed'?'#64748b':'#94a3b8'};margin-bottom:8px">${s.state==='closed'?'Standby':s.state}</div>
            <div class="btn-group" style="margin-bottom:8px">
              <button class="btn btn-on" onclick="atvCmd('${id}','turn_on')">On</button>
              <button class="btn btn-on" onclick="atvCmd('${id}','play_pause')">⏯</button>
              <button class="btn btn-danger" onclick="atvCmd('${id}','turn_off')">Off</button>
            </div>
            ${s.volume != null ? `<div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:2px">
                <span>🔇</span><span id="vol-${id}" style="color:#e2e8f0">${s.volume}%</span><span>🔊</span>
              </div>
              <input type="range" min="0" max="100" value="${s.volume}"
                oninput="document.getElementById('vol-${id}').textContent=this.value+'%'"
                onchange="atvVolumeCmd('${id}', parseInt(this.value))">
            </div>` : ''}
          </div>`
        }).join('')

        const rokuState = states['roku:power:192.168.1.9']
        const rokuCard = `<div class="atv-card">
          <div class="device-name">📺 Hisense Roku TV</div>
          <div class="now-playing">${rokuState?.state==='on' ? '▶ On' : 'Off'}</div>
          <div class="btn-group">
            <button class="btn btn-on" onclick="fetch('/control/roku',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'keypress/PowerOn'})})">On</button>
            <button class="btn btn-danger" onclick="fetch('/control/roku',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'keypress/PowerOff'})})">Off</button>
          </div>
        </div>`

        // Sonos cards
        const sonosStates = Object.entries(states).filter(([k]) => k.startsWith('sonos:'))
        const sonosCards = sonosStates.map(([key, s]) => {
          const isPlaying = s.sonosState === 'PLAYING' || s.state === 'active'
          const vol = s.volume ?? 0
          const ip = key.replace('sonos:','')
          return `<div class="atv-card">
            <div class="device-name">🔊 ${s.name}</div>
            <div class="now-playing">${isPlaying ? '▶ Playing' : 'Stopped'}</div>
            <div class="btn-group" style="margin-bottom:8px">
              <button class="btn btn-on" onclick="sonosCmd('${ip}','play')">▶</button>
              <button class="btn btn-on" onclick="sonosCmd('${ip}','pause')">⏸</button>
              <button class="btn btn-danger" onclick="sonosCmd('${ip}','stop')">⏹</button>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:2px">
                <span>🔇</span><span id="svol-${ip}" style="color:#e2e8f0">${vol}%</span><span>🔊</span>
              </div>
              <input type="range" min="0" max="100" value="${vol}"
                oninput="document.getElementById('svol-${ip}').textContent=this.value+'%'"
                onchange="sonosVolCmd('${ip}', parseInt(this.value))">
            </div>
          </div>`
        }).join('')

        const tvs = appleTVCards + sonosCards + rokuCard

        // Build appliances tab
        const rangeState = states['smartthings:range:8184ceae-f175-b509-ab9d-bb2be1d79294']
        const appliances = rangeState ? `<div class="device-card">
          <div class="device-name">🍳 Range</div>
          <div class="device-status" style="color:${rangeState.state==='on'?'#f87171':'#4ade80'}">${rangeState.state.toUpperCase()}</div>
          ${rangeState.state==='on' ? `<div class="btn-group"><button class="btn btn-danger" onclick="stCmd('8184ceae-f175-b509-ab9d-bb2be1d79294','ovenOperatingState','stop')">Turn Off</button></div>` : '<div style="color:#64748b;font-size:11px">No action needed</div>'}
        </div>` : '<p style="color:#64748b">No appliance data</p>'

        // Camera cards
        let cameras = '<p style="color:#64748b">Ring API initializing...</p>'
        if (ringApiInstance) {
          try {
            const cams = await ringApiInstance.getCameras()
            cameras = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
              ${cams.map(cam => {
                const snapUrl = `/snapshot/${encodeURIComponent(cam.name)}`
                return `<div style="background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155">
                  <div style="padding:8px 12px;font-size:12px;font-weight:700">${cam.name}</div>
                  <a href="${snapUrl}" target="_blank">
                    <img src="${snapUrl}?t=${Date.now()}" style="width:100%;display:block;max-height:200px;object-fit:cover"
                      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div style="display:none;height:120px;align-items:center;justify-content:center;color:#64748b;font-size:11px">Motion Detection Disabled</div>
                  </a>
                  <div style="padding:4px 12px 8px;font-size:10px;color:#64748b">${cam.deviceType}</div>
                </div>`
              }).join('')}
            </div>`
          } catch(e) {
            cameras = `<p style="color:#f87171">Error: ${e.message}</p>`
          }
        }

        // Events tab - recent events + battery
        const recentEvents = (history.events || []).slice(-30).reverse()
        const battRows = [...batteryCache.values()].map(b => {
          const pct = (v, icon='') => v != null ? `<span style="color:${v<20?'#f87171':v<50?'#fbbf24':'#4ade80'}">${icon}${v}%</span>` : ''
          const parts = [b.left!=null?`L:${pct(b.left)}`:'', b.right!=null?`R:${pct(b.right)}`:'', b.case!=null?`Case:${pct(b.case)}`:'', b.watch!=null?pct(b.watch,'⌚'):'', b.mouse!=null?pct(b.mouse,'🖱️'):''].filter(Boolean).join(' ')
          return `<tr><td>Bluetooth</td><td>${b.name}</td><td>${parts}</td></tr>`
        }).join('')

        let ringBattRows = ''
        try {
          const rh = JSON.parse(readFileSync('ring_battery_history.json', 'utf-8'))
          const latest = {}
          for (const r of (rh.readings || [])) { if (r.battery != null) latest[r.name] = r }
          ringBattRows = Object.values(latest).sort((a,b)=>(a.battery??100)-(b.battery??100)).map(r => {
            const c = r.battery<20?'#f87171':r.battery<50?'#fbbf24':'#4ade80'
            return `<tr><td>Ring</td><td>${r.name}</td><td><span style="color:${c}">${r.battery}%${r.battery<20?' ⚠️':''}</span></td></tr>`
          }).join('')
        } catch(e) {}

        const eventRows = recentEvents.map(e => {
          const t = new Date(e.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true})
          const priority = getEventPriority(e)
          const color = priority==='critical'?'#f87171':priority==='important'?'#fbbf24':'#9ca3af'
          return `<tr><td style="color:${color}">${priority}</td><td style="color:#64748b">${t}</td><td>${e.source}</td><td>${e.name}</td><td>${e.previousState??''} → ${e.state}</td></tr>`
        }).join('')

        const events = `
          <h2 style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">Battery Levels</h2>
          <table style="width:100%;font-size:12px;border-collapse:collapse;margin-bottom:20px">
            <tr><th style="text-align:left;color:#64748b;padding:4px">Source</th><th style="text-align:left;color:#64748b;padding:4px">Device</th><th style="text-align:left;color:#64748b;padding:4px">Battery</th></tr>
            ${battRows}${ringBattRows}
          </table>
          <h2 style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px">Recent Events</h2>
          <table style="width:100%;font-size:12px;border-collapse:collapse">
            <tr><th style="text-align:left;color:#64748b;padding:4px">Priority</th><th style="text-align:left;color:#64748b;padding:4px">Time</th><th style="text-align:left;color:#64748b;padding:4px">Source</th><th style="text-align:left;color:#64748b;padding:4px">Device</th><th style="text-align:left;color:#64748b;padding:4px">Change</th></tr>
            ${eventRows}
          </table>`

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ now, version: WATCHER_VERSION, security, lights, climate, tvs, appliances, cameras, events }))
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})) }
      return
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/control')) {
      try {
        const html = readFileSync('/Users/garyscudder/epg/control_page.html', 'utf-8')
        res.writeHead(200, {'Content-Type':'text/html'})
        res.end(html)
      } catch(e) { res.writeHead(500); res.end('Error: ' + e.message) }
      return
    }

    if (req.method === 'GET' && req.url === '/control/data') {
      try {
        const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        const states = history.states ?? {}
        const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', hour12:true })

        // Build security tab
        const garageState = states['smartthings:door:da595efc-94d0-4423-8c91-c7162a3d0310']
        const lockState   = states['smartthings:lock:5d9af01e-3ab3-40dc-91ec-e060ec7f801b']
        const garageOpen  = garageState?.state === 'active'
        const lockUnlocked = lockState?.state === 'active'

        const security = `<div class="grid">
          ${garageState ? `<div class="device-card">
            <div class="device-name">🚗 Garage Door</div>
            <div class="device-status" style="color:${garageOpen?'#f87171':'#4ade80'}">${garageOpen?'OPEN':'CLOSED'}</div>
            <div class="btn-group">
              <button class="btn ${garageOpen?'btn-inactive':'btn-on'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','open')">Open</button>
              <button class="btn ${garageOpen?'btn-on':'btn-inactive'}" onclick="stCmd('da595efc-94d0-4423-8c91-c7162a3d0310','doorControl','close')">Close</button>
            </div></div>` : ''}
          ${lockState ? `<div class="device-card">
            <div class="device-name">🔐 Front Door Lock</div>
            <div class="device-status" style="color:${lockUnlocked?'#f87171':'#4ade80'}">${lockUnlocked?'UNLOCKED':'LOCKED'}</div>
            <div class="btn-group">
              <button class="btn ${lockUnlocked?'btn-inactive':'btn-on'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','unlock')">Unlock</button>
              <button class="btn ${lockUnlocked?'btn-on':'btn-inactive'}" onclick="stCmd('5d9af01e-3ab3-40dc-91ec-e060ec7f801b','lock','lock')">Lock</button>
            </div></div>` : ''}
        </div>`

        // Build lights tab
        const hueStates = Object.entries(states).filter(([k]) => k.startsWith('hue:light:'))
        const hueLights = hueStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const uniqueid = key.replace('hue:light:','')
          return `<div class="device-card" data-hue-id="${uniqueid}">
            <div class="device-name">${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="hueCmd('${uniqueid}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="hueCmd('${uniqueid}',false)">Off</button>
            </div></div>`
        }).join('')

        const allRingStates = Object.entries(states).filter(([k,v]) => k.startsWith('ring:light:') && v.category === 'Light')
        const ringNames = new Set()
        const ringStates = allRingStates.filter(([k,v]) => {
          const name = (v.name||'').toLowerCase()
          if (ringNames.has(name)) return false
          const isDup = allRingStates.some(([k2,v2]) => k2!==k && (v2.name||'').toLowerCase().includes(name) && (v2.name||'').length>(v.name||'').length)
          if (isDup) return false
          ringNames.add(name); return true
        })
        const ringLights = ringStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const deviceKey = key.replace('ring:light:','')
          return `<div class="device-card" data-ring-key="${deviceKey}">
            <div class="device-name">💡 ${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="ringCmd('${deviceKey}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="ringCmd('${deviceKey}',false)">Off</button>
            </div></div>`
        }).join('')

        const goveeStates = Object.entries(states).filter(([k,v]) => k.startsWith('govee:') && v.category === 'Light')
        const goveeLights = goveeStates.map(([key, s]) => {
          const isOn = s.state === 'on'
          const mac = key.replace('govee:','')
          return `<div class="device-card" data-govee-id="${mac}">
            <div class="device-name">💡 ${s.name}</div>
            <div class="device-status" style="color:${isOn?'#4ade80':'#64748b'}">${s.state.toUpperCase()}</div>
            <div class="btn-group">
              <button class="btn ${isOn?'btn-inactive':'btn-on'}" onclick="goveeCmd('${mac}',true)">On</button>
              <button class="btn ${isOn?'btn-on':'btn-inactive'}" onclick="goveeCmd('${mac}',false)">Off</button>
            </div></div>`
        }).join('')

        const lights = `<button class="btn-all-off" onclick="allLightsOff()">💡 All Lights Off</button><div class="grid">${hueLights}${ringLights}${goveeLights}</div>`

        // Build climate tab
        const thermoState = states['smartthings:thermostat:904f48c1-b6ef-4b03-b311-65a7733a967d']
        let climate = '<p style="color:#64748b">No thermostat data</p>'
        if (thermoState) {
          const parts = (thermoState.state||'').split(' ')
          const mode = parts[0]||'unknown'
          const setpoint = parts[1] ? parseInt(parts[1]) : 70
          const current = parts[2] ? parseInt(parts[2].replace(/[()F]/g,'')) : null
          const isCool = mode==='cool', isHeat = mode==='heat', isOff = mode==='off'
          climate = `<div class="device-card" style="grid-column:1/-1">
            <div class="device-name">🌡️ Thermostat</div>
            <div class="device-status" style="color:#4ade80">${mode.toUpperCase()} · ${current?current+'°F current':''} · Set: ${setpoint}°F</div>
            <div class="btn-group" style="margin-bottom:8px">
              <button class="btn ${isCool?'btn-inactive':'btn-on'}" ${isCool?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','cool')">❄️ Cool</button>
              <button class="btn ${isHeat?'btn-inactive':'btn-on'}" ${isHeat?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','heat')">🔥 Heat</button>
              <button class="btn ${isOff?'btn-inactive':'btn-on'}" ${isOff?'disabled':''} onclick="stCmd('904f48c1-b6ef-4b03-b311-65a7733a967d','thermostatMode','off')">Off</button>
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
                <span>60°F</span><span style="color:#e2e8f0;font-weight:700" id="spLabel">${setpoint}°F</span><span>85°F</span>
              </div>
              <input type="range" min="60" max="85" value="${setpoint}"
                oninput="document.getElementById('spLabel').textContent=this.value+'°F'"
                onchange="setpointCmd(parseInt(this.value))">
            </div>
          </div>`
        }

        // Build TVs tab
        const appleTVStates = Object.entries(states).filter(([k]) => k.startsWith('appletv:') && !k.includes(':app:'))
        const appleTVCards = appleTVStates.map(([key, s]) => {
          const id = key.replace('appletv:','')
          const app = states['appletv:app:'+id]?.state || ''
          return `<div class="atv-card">
            <div class="device-name">📺 ${s.name}</div>
            <div class="now-playing">${app ? '▶ ' + app : 'Idle'}</div>
            ${s.state && s.state !== 'Idle' && s.state !== 'closed' ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:8px">${s.state}</div>` : ''}
            <div class="btn-group">
              <button class="btn btn-on" onclick="atvCmd('${id}','play_pause')">⏯</button>
              <button class="btn btn-on" onclick="atvCmd('${id}','volume_up')">🔊+</button>
              <button class="btn btn-on" onclick="atvCmd('${id}','volume_down')">🔊-</button>
              <button class="btn btn-danger" onclick="atvCmd('${id}','turn_off')">Off</button>
            </div>
          </div>`
        }).join('')

        const rokuState = states['roku:power:192.168.1.9']
        const rokuCard = `<div class="atv-card">
          <div class="device-name">📺 Hisense Roku TV</div>
          <div class="device-status" style="color:${rokuState?.state==='on'?'#4ade80':'#64748b'}">${rokuState?.state||'unknown'}</div>
          ${rokuState?.state==='on' ? `<div class="btn-group"><button class="btn btn-danger" onclick="fetch('/control/roku',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:'keypress/PowerOff'})})">Power Off</button></div>` : '<div style="color:#64748b;font-size:11px">TV is off</div>'}
        </div>`

        const tvs = appleTVCards + rokuCard

        // Build appliances tab
        const rangeState = states['smartthings:range:8184ceae-f175-b509-ab9d-bb2be1d79294']
        const appliances = rangeState ? `<div class="device-card">
          <div class="device-name">🍳 Range</div>
          <div class="device-status" style="color:${rangeState.state==='on'?'#f87171':'#4ade80'}">${rangeState.state.toUpperCase()}</div>
          ${rangeState.state==='on' ? `<div class="btn-group"><button class="btn btn-danger" onclick="stCmd('8184ceae-f175-b509-ab9d-bb2be1d79294','ovenOperatingState','stop')">Turn Off</button></div>` : '<div style="color:#64748b;font-size:11px">No action needed</div>'}
        </div>` : '<p style="color:#64748b">No appliance data</p>'

        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ now, version: WATCHER_VERSION, security, lights, climate, tvs, appliances }))
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})) }
      return
    }

    // SmartThings OAuth callback
    if (req.method === 'GET' && req.url?.startsWith('/smartthings/callback')) {
      const url = new URL(req.url, 'http://localhost')
      const code = url.searchParams.get('code')
      if (!code) { res.writeHead(400); res.end('No code'); return }
      try {
        const ST_CLIENT_ID = process.env.ST_CLIENT_ID
        const ST_CLIENT_SECRET = process.env.ST_CLIENT_SECRET
        const tokenResp = await fetch('https://api.smartthings.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: ST_CLIENT_ID,
            client_secret: ST_CLIENT_SECRET,
            redirect_uri: 'http://localhost:8446/smartthings/callback',
          })
        })
        const tokens = await tokenResp.json()
        console.log('ST OAuth tokens:', JSON.stringify(tokens))
        if (tokens.access_token) {
          // Save to .env
          const { appendFileSync } = await import('fs')
          appendFileSync('/Users/garyscudder/epg/st_token.json', JSON.stringify(tokens))
          res.writeHead(200, {'Content-Type':'text/html'})
          res.end('<h2>✅ SmartThings authorized! Access token saved. You can close this window.</h2>')
          console.log('ST access_token:', tokens.access_token)
          console.log('ST refresh_token:', tokens.refresh_token)
        } else {
          res.writeHead(500); res.end(JSON.stringify(tokens))
        }
      } catch(e) { res.writeHead(500); res.end(e.message) }
      return
    }

    if (req.method === 'GET' && req.url === '/control/state-hash') {
      try {
        const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
        const states = history.states ?? {}
        const hash = Object.entries(states)
          .filter(([k]) => k.startsWith('ring:light:') || k.startsWith('hue:light:') || k.startsWith('govee:'))
          .map(([k,v]) => k + v.state + v.lastChangedAt)
          .join('|')
        res.writeHead(200, {'Content-Type':'application/json'})
        res.end(JSON.stringify({ hash }))
      } catch(e) { res.writeHead(500); res.end('{}') }
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
            await sendSmartThingsCommand(data.deviceId, data.capability, data.command, data.args || [])
            // Optimistically update thermostat state in history
            if (data.capability === 'thermostatCoolingSetpoint' || data.capability === 'thermostatHeatingSetpoint') {
              try {
                const hist = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
                const stateKey = Object.keys(hist.states || {}).find(k => k.includes('thermostat') && k.includes(data.deviceId.slice(0,8)))
                if (stateKey && data.args?.[0]) {
                  const s = hist.states[stateKey]
                  const parts = (s.state || '').split(' ')
                  parts[1] = data.args[0] + 'F'
                  s.state = parts.join(' ')
                  s.lastChangedAt = new Date().toISOString()
                  writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2))
                }
              } catch(e) {}
            }
            send({ ok: true })
          }

          else if (req.url === '/control/roku') {
            await fetch(`http://192.168.1.9:8060/${data.path}`, { method: 'POST' })
            send({ ok: true })
          }

          else if (req.url === '/control/govee') {
            try {
              const { device, model, on } = data
              const goveeModel = GOVEE_MODELS[device] || data.model || ""
              const resp = await fetch(`${GOVEE_API_BASE}/devices/control`, {
                method: 'PUT',
                headers: { 'Govee-API-Key': GOVEE_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ device, model: goveeModel, cmd: { name: 'turn', value: on ? 'on' : 'off' } })
              })
              const result = await resp.json()
              console.log('Govee control result:', JSON.stringify(result))
              // Optimistically update history
              try {
                const hist = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
                const stateKey = Object.keys(hist.states || {}).find(k => k.startsWith('govee:') && k.replace('govee:','').toLowerCase() === device.toLowerCase())
                if (stateKey) {
                  hist.states[stateKey].state = on ? 'on' : 'off'
                  hist.states[stateKey].lastChangedAt = new Date().toISOString()
                  writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2))
                }
              } catch(e) {}
              send({ ok: result.code === 200 })
            } catch(e) { send({ ok: false, error: e.message }) }
          }

          else if (req.url === '/control/sonos') {
            try {
              const { ip, cmd, volume } = data
              if (cmd === 'volume') {
                const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${volume}</DesiredVolume></u:SetVolume></s:Body></s:Envelope>`
                const resp = await fetch(`http://${ip}:1400/MediaRenderer/RenderingControl/Control`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/xml', 'SOAPACTION': '"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"' },
                  body: soap
                })
                send({ ok: resp.ok })
              } else {
                const actions = { play: 'Play', pause: 'Pause', stop: 'Stop' }
                const action = actions[cmd] || 'Pause'
                const soap = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:${action}></s:Body></s:Envelope>`
                const resp = await fetch(`http://${ip}:1400/MediaRenderer/AVTransport/Control`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/xml', 'SOAPACTION': `"urn:schemas-upnp-org:service:AVTransport:1#${action}"` },
                  body: soap
                })
                send({ ok: resp.ok })
              }
            } catch(e) { send({ ok: false, error: e.message }) }
          }

          else if (req.url === '/control/appletv') {
            try {
              const device = APPLETV_DEVICES.find(d => d.id === data.id)
              if (!device) return send({ ok: false, error: 'Device not found' })
              let cmd
              if (data.cmd.startsWith('set_volume:')) {
                const vol = parseFloat(data.cmd.split(':')[1]) / 100
                cmd = `atvremote --id ${device.id} --protocol airplay ` +
                  `--companion-credentials ${device.companionCreds} ` +
                  `--airplay-credentials ${device.airplayCreds} ` +
                  `set_volume=${vol}`
              } else {
                cmd = `atvremote --id ${device.id} --protocol airplay ` +
                  `--companion-credentials ${device.companionCreds} ` +
                  `--airplay-credentials ${device.airplayCreds} ` +
                  `${data.cmd}`
              }
              await execAsync(cmd, { timeout: 15000 })
              send({ ok: true })
            } catch(e) { send({ ok: false, error: e.message }) }
          }

          else if (req.url === '/control/ring') {
            try {
              if (!ringApiInstance) return send({ ok: false, error: 'Ring API not ready' })
              const locations = await ringApiInstance.getLocations()
              let found = false
              for (const location of locations) {
                const devices = await location.getDevices()
                for (const device of devices) {
                  const nameLower = (device.data.name || '').toLowerCase().trim()
                  const keyLower = (data.deviceKey || '').toLowerCase().trim()
                  // Match by exact name or key contains name
                  if (nameLower === keyLower || keyLower === nameLower ||
                      keyLower.startsWith(nameLower) || nameLower.startsWith(keyLower)) {
                    const lightMode = data.on ? 'on' : 'default'
                    console.log(`Ring control: ${device.data.name} -> lightMode: ${lightMode}`)
                    await device.sendCommand('light-mode.set', { lightMode, duration: 0 })
                    // Optimistically update history so page refreshes fast
                    try {
                      const hist = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
                      const stateKey = Object.keys(hist.states || {}).find(k =>
                        k.startsWith('ring:light:') && (hist.states[k].name || '').toLowerCase().includes(data.deviceKey.toLowerCase())
                      )
                      if (stateKey) {
                        hist.states[stateKey].state = data.on ? 'on' : 'off'
                        hist.states[stateKey].lastChangedAt = new Date().toISOString()
                        writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2))
                      }
                    } catch(e) { console.log('Optimistic update failed:', e.message) }
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

async function subscribeToRingDeviceChanges(ringApi) {
  // Batch Ring WS events that fire within 2s of each other into one alert
  let wsBatch = []
  let wsBatchTimer = null
  function flushWsBatch() {
    wsBatchTimer = null
    if (wsBatch.length === 0) return
    const batch = wsBatch.splice(0)

    // Deduplicate: if a light group and its member bulb both changed, keep only the group
    const groupNames = batch.filter(i => i._isGroup).map(i => i.name.toLowerCase())
    const deduped = batch.filter(i => {
      if (i._isGroup) return true
      // suppress member bulb if its name contains or starts with any group name
      return !groupNames.some(g => i.name.toLowerCase().includes(g) || i.name.toLowerCase().startsWith(g))
    })

    // Infer trigger: group device OR multiple simultaneous devices = Alexa/app/routine
    const hasGroup = batch.some(i => i._isGroup)
    const trigger = (hasGroup || batch.length > 1) ? ' (via Alexa/app/routine)' : ''

    const allEvents = []
    for (const item of deduped) {
      const events = updateTimeline([item])
      allEvents.push(...events)
    }
    if (allEvents.length > 0) {
      // Tag events with trigger note
      for (const e of allEvents) { if (trigger) e._trigger = trigger }
      sendEventAlert(allEvents).catch(e => console.error(`[Ring WS] alert error: ${e.message}`))
    }
  }

  try {
    const locations = await ringApi.getLocations()
    for (const location of locations) {
      let devices = []
      try { devices = await location.getDevices() } catch { continue }

      for (const device of devices) {
        const baseData = device.data
        const type = baseData.deviceType ?? ''
        const isGroup = type.includes('group')
        let category = null
        if (type.includes('light') || type.includes('beam')) category = 'Light'
        else if (type.includes('contact')) category = 'Contact'
        else if (type.includes('motion')) category = 'Motion'
        if (!category) continue
        if (!device.onData?.subscribe) continue

        let lastState = null
        device.onData.subscribe(newData => {
          try {
            const name = newData.name ?? baseData.name ?? type
            let state = null
            if (category === 'Light') {
              state = detectPowerState(newData)
            } else {
              const open = (() => {
                const checks = [newData.faulted, newData.open, newData.opened, newData.isOpen, newData.motionDetected, newData.motion, newData.status, newData.state]
                for (const v of checks) {
                  if (v === true) return true
                  if (v === false) return false
                  if (typeof v === 'string') {
                    const n = v.toLowerCase()
                    if (['open','opened','active','motion','detected','faulted'].includes(n)) return true
                    if (['closed','clear','inactive','idle','ok'].includes(n)) return false
                  }
                }
                return null
              })()
              if (open === null) return
              state = open ? 'active' : 'clear'
            }
            if (!state || state === lastState) return
            lastState = state
            const key = `ring:${category.toLowerCase()}:${name.toLowerCase()}`
            console.log(`[Ring WS] ${name} → ${state}`)
            wsBatch.push({ key, source: 'Ring', category, name, state, _isGroup: isGroup })
            if (wsBatchTimer) clearTimeout(wsBatchTimer)
            wsBatchTimer = setTimeout(flushWsBatch, 2000)
          } catch(e) {
            console.error(`[Ring WS] error processing ${baseData.name}: ${e.message}`)
          }
        })
      }
    }
    console.log('[Ring WS] subscribed to device state changes')
  } catch(e) {
    console.error(`[Ring WS] subscription setup failed: ${e.message}`)
  }
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
  if (!RUN_ONCE) subscribeToRingDeviceChanges(ringApi)

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
