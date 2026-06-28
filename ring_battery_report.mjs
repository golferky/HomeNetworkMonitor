import { RingApi } from 'ring-client-api'
import nodemailer from 'nodemailer'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { writeFile } from 'fs/promises'

const REPORT_VERSION = '2026.06.12.1'
const TOKEN_FILE        = 'ring_token.json'
const REPORT_FILE = 'ring_battery_report.html'
const HISTORY_FILE = 'ring_battery_history.json'
const APPLE_DEVICES_FILE = 'apple_devices.json'
const ALERT_ENV_FILES = ['ring_battery_alert.env', '.env']
const BATTERY_OK  = 50
const BATTERY_LOW = 20
const FORECAST_THRESHOLD = BATTERY_LOW
const HISTORY_KEEP_DAYS = 730
const BATTERY_CHANGE_JUMP = 35
const BATTERY_CHANGED_JUMP = 10
const BATTERY_REQUERY_ATTEMPTS = 3
const BATTERY_REQUERY_DELAY_MS = 5000
const SEND_ALERTS = !process.argv.includes('--no-alert') && process.env.RING_BATTERY_NO_ALERT !== '1'
const MAILBOX_DEVICE_MATCH = (process.env.RING_MAILBOX_DEVICE ?? 'mailbox').toLowerCase()
const MAILBOX_OPEN_ALERT_MINUTES = parseInt(process.env.RING_MAILBOX_OPEN_ALERT_MINUTES ?? '10', 10)
const MAILBOX_OPEN_REPEAT_MINUTES = parseInt(process.env.RING_MAILBOX_OPEN_REPEAT_MINUTES ?? '60', 10)
const APPLE_DEVICE_STALE_MINUTES = parseInt(process.env.APPLE_DEVICE_STALE_MINUTES ?? '180', 10)
const LIGHT_STATE_ALERTS = process.env.LIGHT_STATE_ALERTS !== '0'
const LOCK_STATE_ALERTS = process.env.LOCK_STATE_ALERTS !== '0'

const DEVICE_TYPE_OVERRIDES = {
  'doorbell:front door': 'Solar Doorbell',
  'camera:front': 'Spotlight Cam',
  'camera:garage': 'Plugged-in Camera',
  'light:office': 'A19 Smart Bulb',
  'light:office a19 smart bulb': 'A19 Smart Bulb',
  'light:front': 'Spotlight Cam Light',
}

const HIDDEN_DEVICE_KEYS = new Set([
  'light:office',
  'light:front',
])

const IGNORED_LIGHT_STATE_KEYS = new Set([
  'ring:light:office',
])

// â”€â”€ Alert config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
const SMS_TO      = process.env.RING_BATTERY_SMS_TO ?? process.env.SMS_TO ?? '8599628088@tmomail.net'
const GOVEE_API_KEY = process.env.GOVEE_API_KEY
const GOVEE_API_BASE = process.env.GOVEE_API_BASE ?? 'https://developer-api.govee.com/v1'

async function loadToken() {
  if (!existsSync(TOKEN_FILE)) {
    const { createInterface } = await import('readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const token = await new Promise(resolve => {
      rl.question('Paste your Ring refresh token here: ', answer => {
        rl.close()
        resolve(answer.trim())
      })
    })
    writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: token }))
    return token
  }
  const data = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'))
  return data.refreshToken ?? data
}

function saveToken(token) {
  writeFileSync(TOKEN_FILE, JSON.stringify({ refreshToken: token }))
}

function batteryStatus(pct) {
  if (pct == null) return { label: 'N/A (hardwired?)', color: '#6b7280' }
  if (pct >= BATTERY_OK)  return { label: 'OK',       color: '#16a34a' }
  if (pct >= BATTERY_LOW) return { label: 'Low',      color: '#d97706' }
  return                         { label: 'Critical', color: '#dc2626' }
}

function sortOrder(label) {
  return { 'Critical': 0, 'Low': 1, 'OK': 2, 'N/A (hardwired?)': 3 }[label] ?? 9
}

function deviceKey(device) {
  return `${device.category}:${device.name}`.toLowerCase()
}

function displayType(device) {
  return DEVICE_TYPE_OVERRIDES[deviceKey(device)] ?? device.displayType ?? device.category
}

function isMailboxDevice(device) {
  return device.name?.toLowerCase().includes(MAILBOX_DEVICE_MATCH)
}

function isPluggedIn(device) {
  return displayType(device).toLowerCase().includes('plugged-in')
}

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return { readings: [] }

  try {
    const history = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'))
    return Array.isArray(history.readings) ? history : { readings: [] }
  } catch (err) {
    console.warn(`  Could not read ${HISTORY_FILE}: ${err.message}`)
    return { readings: [] }
  }
}

function saveHistory(history) {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
}

function hasBatteryHistory(device, readings) {
  return readings.some(r => r.key === deviceKey(device) && r.battery != null)
}

function mergeDeviceBattery(target, fresh) {
  if (!fresh || fresh.battery == null) return false

  target.battery = fresh.battery
  target.label = fresh.label
  target.color = fresh.color
  target.firmware = fresh.firmware
  target.wifi = fresh.wifi
  delete target.batteryIsLastKnown
  delete target.batteryLastKnownDate
  return true
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
    if (value === true) return true
    if (value === false) continue
    if (typeof value !== 'string') continue

    const normalized = value.toLowerCase()
    if (['open', 'opened', 'active', 'motion', 'detected', 'faulted'].includes(normalized)) return true
    if (['closed', 'clear', 'inactive', 'idle', 'ok'].includes(normalized)) return false
  }

  return null
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000))
  if (totalMinutes < 60) return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours} hour${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} minute${minutes === 1 ? '' : 's'}` : ''}`
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function requeryMissingBatteryDevices(ringApi, devices) {
  const history = loadHistory()
  let missing = devices.filter(d => d.battery == null && hasBatteryHistory(d, history.readings))
  if (missing.length === 0) return

  console.log(`  Ring returned no battery for ${missing.length} known battery device(s); retrying...`)

  for (let attempt = 1; attempt <= BATTERY_REQUERY_ATTEMPTS && missing.length > 0; attempt++) {
    if (attempt > 1) await wait(BATTERY_REQUERY_DELAY_MS)

    const freshDevices = await collectDevices(ringApi)
    const freshByKey = new Map(freshDevices.map(d => [deviceKey(d), d]))
    const recovered = []

    for (const d of missing) {
      if (mergeDeviceBattery(d, freshByKey.get(deviceKey(d)))) {
        recovered.push(d.name)
      }
    }

    if (recovered.length > 0) {
      console.log(`  Battery retry ${attempt}: updated ${recovered.join(', ')}`)
    } else {
      console.log(`  Battery retry ${attempt}: still waiting on ${missing.map(d => d.name).join(', ')}`)
    }

    missing = missing.filter(d => d.battery == null)
  }
}

function updateBatteryHistory(devices) {
  const history = loadHistory()
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const cutoff = now.getTime() - HISTORY_KEEP_DAYS * 24 * 60 * 60 * 1000

  history.readings = history.readings
    .filter(r => r.date && new Date(r.date).getTime() >= cutoff)
    .filter(r => r.battery != null)

  for (const d of devices) {
    if (d.battery == null) continue

    const key = deviceKey(d)
    const alreadyRecordedToday = history.readings.some(r => r.key === key && r.date === today)

    if (!alreadyRecordedToday) {
      history.readings.push({
        date: today,
        key,
        name: d.name,
        category: d.category,
        battery: d.battery,
      })
    }
  }

  history.readings = history.readings
    .filter((reading, index, readings) => readings.findIndex(r => r.key === reading.key && r.date === reading.date) === index)
    .sort((a, b) => a.key.localeCompare(b.key) || a.date.localeCompare(b.date))

  applyLastKnownBatteryFallback(devices, history.readings)
  saveHistory(history)
  applyBatteryPredictions(devices, history.readings)
}

function updateMailboxOpenState(devices) {
  const history = loadHistory()
  const now = new Date()
  const mailbox = devices.find(isMailboxDevice)

  if (!mailbox || mailbox.openState == null) {
    const lastState = history.mailboxOpen?.lastState ?? 'unknown'
    const lastChangedAt = history.mailboxOpen?.lastChangedAt ?? history.mailboxOpen?.lastSeenAt ?? null
    const durationText = lastChangedAt ? ` for ${formatDuration(now.getTime() - new Date(lastChangedAt).getTime())}` : ''
    return {
      mailbox,
      shouldAlert: false,
      message: '',
      statusText: mailbox ? `${mailbox.name}: unknown now; last known ${lastState}${durationText}` : 'Mailbox device not found',
    }
  }

  const state = history.mailboxOpen ?? {}

  if (mailbox.openState) {
    if (!state.openSince || state.lastState !== 'open') {
      state.openSince = now.toISOString()
      state.lastChangedAt = now.toISOString()
      state.lastAlertAt = null
    }

    state.lastState = 'open'
    state.lastSeenAt = now.toISOString()

    const openSince = new Date(state.openSince)
    const openMs = now.getTime() - openSince.getTime()
    const alertMs = MAILBOX_OPEN_ALERT_MINUTES * 60 * 1000
    const repeatMs = MAILBOX_OPEN_REPEAT_MINUTES * 60 * 1000
    const lastAlertAt = state.lastAlertAt ? new Date(state.lastAlertAt) : null
    const repeatDue = !lastAlertAt || now.getTime() - lastAlertAt.getTime() >= repeatMs

    history.mailboxOpen = state
    saveHistory(history)

    if (openMs >= alertMs && repeatDue) {
      state.lastAlertAt = now.toISOString()
      saveHistory(history)
      const duration = formatDuration(openMs)
      return {
        mailbox,
        shouldAlert: true,
        message: `${mailbox.name} has been open/active for ${duration}.`,
        statusText: `${mailbox.name}: open/active for ${duration}`,
      }
    }

    return {
      mailbox,
      shouldAlert: false,
      message: '',
      statusText: `${mailbox.name}: open/active for ${formatDuration(openMs)}`,
    }
  }

  if (state.lastState !== 'closed') {
    state.lastChangedAt = now.toISOString()
  }

  state.lastState = 'closed'
  state.closedAt = now.toISOString()
  state.openSince = null
  state.lastAlertAt = null
  state.lastSeenAt = now.toISOString()
  history.mailboxOpen = state
  saveHistory(history)

  const closedSince = state.lastChangedAt ? new Date(state.lastChangedAt) : now
  return {
    mailbox,
    shouldAlert: false,
    message: '',
    statusText: `${mailbox.name}: closed for ${formatDuration(now.getTime() - closedSince.getTime())}`,
  }
}

function applyLastKnownBatteryFallback(devices, readings) {
  for (const d of devices) {
    if (d.battery != null) continue

    const latest = readings
      .filter(r => r.key === deviceKey(d) && r.battery != null)
      .sort((a, b) => b.date.localeCompare(a.date))[0]

    if (!latest) continue

    const { label, color } = batteryStatus(latest.battery)
    d.battery = latest.battery
    d.label = label
    d.color = color
    d.batteryIsLastKnown = true
    d.batteryLastKnownDate = latest.date
  }
}

function applyBatteryPredictions(devices, readings) {
  for (const d of devices) {
    if (d.battery == null) {
      d.drainPerDay = null
      d.nextLowDate = null
      d.daysToLow = null
      d.typicalCycleDays = null
      d.predictionConfidence = 'n/a'
      continue
    }

    const deviceReadings = readings
      .filter(r => r.key === deviceKey(d))
      .map(r => ({ ...r, time: new Date(r.date).getTime() }))
      .filter(r => Number.isFinite(r.time))
      .sort((a, b) => a.time - b.time)

    Object.assign(d, analyzeBatteryReadings(deviceReadings, d.battery))
  }
}

function analyzeBatteryReadings(readings, currentBattery) {
  const changes = findLastBatteryChanges(readings)

  if (readings.length < 2) {
    return {
      drainPerDay: null,
      nextLowDate: null,
      daysToLow: null,
      typicalCycleDays: null,
      batteryLastChanged: changes.batteryLastChanged,
      statusLastChanged: changes.statusLastChanged,
      predictionConfidence: 'needs history',
    }
  }

  const batteryChanges = []
  const drainRates = []
  let lastChangeDate = null

  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]
    const cur = readings[i]
    const days = (cur.time - prev.time) / 86400000
    if (days <= 0) continue

    const delta = cur.battery - prev.battery
    if (delta >= BATTERY_CHANGE_JUMP) {
      batteryChanges.push(cur.time)
      lastChangeDate = cur.time
      continue
    }

    if (delta < 0) {
      drainRates.push(Math.abs(delta) / days)
    }
  }

  const drainPerDay = median(drainRates)
  const batteryStable = drainRates.length === 0 && readings.length >= 2
  const daysToLow = drainPerDay && currentBattery > FORECAST_THRESHOLD
    ? (currentBattery - FORECAST_THRESHOLD) / drainPerDay
    : currentBattery <= FORECAST_THRESHOLD ? 0 : null
  const nextLowDate = daysToLow != null ? new Date(Date.now() + daysToLow * 86400000) : null
  const typicalCycleDays = median(intervals(batteryChanges))
    ?? (lastChangeDate && drainPerDay ? (100 - FORECAST_THRESHOLD) / drainPerDay : null)

  return {
    drainPerDay,
    batteryStable,
    nextLowDate,
    daysToLow,
    typicalCycleDays,
    batteryLastChanged: changes.batteryLastChanged,
    statusLastChanged: changes.statusLastChanged,
    predictionConfidence: confidenceFor(readings.length, drainRates.length, batteryChanges.length),
  }
}

function findLastBatteryChanges(readings) {
  if (!readings || readings.length === 0) {
    return { batteryLastChanged: null, statusLastChanged: null }
  }

  let batteryLastChanged = null
  let statusLastChanged = null

  for (let i = 1; i < readings.length; i++) {
    const prev = readings[i - 1]
    const cur = readings[i]

    if (cur.battery - prev.battery >= BATTERY_CHANGED_JUMP) {
      batteryLastChanged = cur.time
    }

    if (batteryStatus(cur.battery).label !== batteryStatus(prev.battery).label) {
      statusLastChanged = cur.time
    }
  }

  return {
    batteryLastChanged: batteryLastChanged ? new Date(batteryLastChanged) : null,
    statusLastChanged: statusLastChanged ? new Date(statusLastChanged) : null,
  }
}

function median(values) {
  const sorted = values.filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function intervals(times) {
  const results = []
  for (let i = 1; i < times.length; i++) {
    results.push((times[i] - times[i - 1]) / 86400000)
  }
  return results
}

function confidenceFor(readingCount, drainRateCount, changeCount) {
  if (readingCount >= 8 && drainRateCount >= 4 && changeCount >= 1) return 'high'
  if (readingCount >= 4 && drainRateCount >= 2) return 'medium'
  if (readingCount >= 2 && drainRateCount >= 1) return 'low'
  return 'needs history'
}

function formatForecastDate(date) {
  return date ? date.toLocaleDateString() : 'need more data'
}

function formatChangeDate(date) {
  return date ? date.toLocaleDateString() : ''
}

function formatDays(days) {
  if (days == null || !Number.isFinite(days)) return 'need more data'
  if (days <= 0) return 'now'
  if (days < 14) return `${Math.round(days)} days`
  return `${Math.round(days / 7)} weeks`
}

function formatDrain(rate) {
  return rate ? `${rate.toFixed(2)}%/day` : 'need more data'
}

function hasBattery(device) {
  return device.battery != null
}

function displayBattery(device) {
  return hasBattery(device) ? `${device.battery}%${device.batteryIsLastKnown ? '*' : ''}` : ''
}

function displayStatus(device) {
  return hasBattery(device) ? device.label : ''
}

function displayDrain(device) {
  if (hasBattery(device) && !isPluggedIn(device) && device.batteryStable) return 'stable'
  return hasBattery(device) && !isPluggedIn(device) ? formatDrain(device.drainPerDay) : ''
}

function displayForecastDate(device) {
  if (hasBattery(device) && !isPluggedIn(device) && device.batteryStable) return 'not dropping'
  return hasBattery(device) && !isPluggedIn(device) ? formatForecastDate(device.nextLowDate) : ''
}

function displayDays(days, device) {
  if (hasBattery(device) && !isPluggedIn(device) && device.batteryStable) return ''
  return hasBattery(device) && !isPluggedIn(device) ? formatDays(days) : ''
}

function displayChangeDate(date, device) {
  return hasBattery(device) ? formatChangeDate(date) : ''
}

function normalizeAppleDevice(device) {
  const lastSeenAt = device.lastSeenAt ?? device.updatedAt ?? device.timestamp ?? null
  const lastSeen = lastSeenAt ? new Date(lastSeenAt) : null
  const ageMs = lastSeen ? Date.now() - lastSeen.getTime() : null
  const stale = ageMs == null || ageMs > APPLE_DEVICE_STALE_MINUTES * 60 * 1000
  const battery = device.battery != null ? Math.round(Number(device.battery)) : null
  const charging = device.charging === true || `${device.charging}`.toLowerCase() === 'true'

  return {
    name: device.name ?? device.deviceName ?? 'Apple Device',
    model: device.model ?? device.deviceType ?? '',
    battery,
    charging,
    lowPowerMode: device.lowPowerMode === true || `${device.lowPowerMode}`.toLowerCase() === 'true',
    lastSeen,
    stale,
  }
}

function loadAppleDevices() {
  if (!existsSync(APPLE_DEVICES_FILE)) return []

  try {
    const data = JSON.parse(readFileSync(APPLE_DEVICES_FILE, 'utf-8'))
    const devices = Array.isArray(data) ? data : Array.isArray(data.devices) ? data.devices : Object.values(data.devices ?? {})
    return devices
      .map(normalizeAppleDevice)
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    console.log(`  Apple devices skipped: could not read ${APPLE_DEVICES_FILE}: ${err.message}`)
    return []
  }
}

function formatAppleDeviceStatus(device) {
  const parts = []
  if (device.battery != null) parts.push(`${device.battery}%`)
  parts.push(device.charging ? 'charging' : 'not charging')
  if (device.lowPowerMode) parts.push('low power')
  if (device.lastSeen) {
    const age = formatDuration(Date.now() - device.lastSeen.getTime())
    parts.push(device.stale ? `stale, seen ${age} ago` : `seen ${age} ago`)
  }
  else parts.push('never seen')
  return parts.join(', ')
}

async function fetchGoveeJson(path, query = {}) {
  const url = new URL(`${GOVEE_API_BASE}${path}`)
  for (const [key, value] of Object.entries(query)) {
    if (value != null) url.searchParams.set(key, value)
  }

  const response = await fetch(url, {
    headers: {
      'Govee-API-Key': GOVEE_API_KEY,
    },
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
  const state = {
    online: null,
    powerState: '',
    brightness: null,
    colorTem: null,
    color: null,
  }

  for (const property of properties) {
    const [name, value] = Object.entries(property)[0] ?? []
    if (!name) continue

    if (name === 'online') state.online = value
    if (name === 'powerState') state.powerState = value
    if (name === 'brightness') state.brightness = value
    if (name === 'colorTem') state.colorTem = value
    if (name === 'color') state.color = value
  }

  return state
}

function formatGoveeState(light) {
  const parts = []

  if (light.online === false) parts.push('offline')
  if (light.online === true) parts.push('online')
  if (light.powerState) parts.push(light.powerState)
  if (light.brightness != null) parts.push(`${light.brightness}%`)
  if (light.colorTem != null) parts.push(`${light.colorTem}K`)

  return parts.length ? parts.join(', ') : 'state unavailable'
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

function detectLockState(data) {
  const checks = [
    data?.locked,
    data?.lockState,
    data?.lock_state,
    data?.state,
    data?.status,
  ]

  for (const value of checks) {
    if (value === true) return 'locked'
    if (value === false) return 'unlocked'
    if (typeof value !== 'string') continue

    const normalized = value.toLowerCase()
    if (['locked', 'lock', 'secured', 'secure'].includes(normalized)) return 'locked'
    if (['unlocked', 'unlock', 'unsecured', 'open'].includes(normalized)) return 'unlocked'
  }

  return null
}

function visibleRingDevices(devices) {
  return devices
    .filter(d => !HIDDEN_DEVICE_KEYS.has(deviceKey(d)))
    .sort((a, b) => sortOrder(a.label) - sortOrder(b.label))
}

function collectRingLightStates(devices) {
  return devices
    .filter(d => d.category === 'Light' && d.powerState)
    .map(d => ({
      key: `ring:${deviceKey(d)}`,
      source: 'Ring',
      name: d.name,
      state: d.powerState,
    }))
    .filter(light => !IGNORED_LIGHT_STATE_KEYS.has(light.key))
}

function collectGoveeLightStates(goveeLights) {
  return goveeLights
    .filter(light => light.powerState)
    .map(light => ({
      key: `govee:${light.device || light.name}`.toLowerCase(),
      source: 'Govee',
      name: light.name,
      state: String(light.powerState).toLowerCase(),
    }))
}

function updateLightStateHistory(lightStates) {
  const history = loadHistory()
  const now = new Date()
  const stored = history.lightStates ?? {}
  const changes = []

  for (const light of lightStates) {
    const previous = stored[light.key]
    if (previous?.state && previous.state !== light.state) {
      changes.push({
        ...light,
        previousState: previous.state,
        changedAt: now,
      })
    }

    stored[light.key] = {
      source: light.source,
      name: light.name,
      state: light.state,
      lastSeenAt: now.toISOString(),
      lastChangedAt: previous?.state === light.state
        ? previous.lastChangedAt ?? now.toISOString()
        : now.toISOString(),
    }
  }

  history.lightStates = stored
  saveHistory(history)
  return changes
}

function collectLockStates(devices) {
  return devices
    .filter(d => d.category === 'Lock')
    .map(d => ({
      key: `ring:${deviceKey(d)}`,
      source: 'Ring',
      name: d.name,
      state: d.lockState ?? 'unknown',
      battery: d.battery,
    }))
}

function updateLockStateHistory(lockStates) {
  const history = loadHistory()
  const now = new Date()
  const stored = history.lockStates ?? {}
  const changes = []

  for (const lock of lockStates) {
    if (!lock.state || lock.state === 'unknown') continue

    const previous = stored[lock.key]
    if (previous?.state && previous.state !== lock.state) {
      changes.push({
        ...lock,
        previousState: previous.state,
        changedAt: now,
      })
    }

    stored[lock.key] = {
      source: lock.source,
      name: lock.name,
      state: lock.state,
      battery: lock.battery,
      lastSeenAt: now.toISOString(),
      lastChangedAt: previous?.state === lock.state
        ? previous.lastChangedAt ?? now.toISOString()
        : now.toISOString(),
    }
  }

  history.lockStates = stored
  saveHistory(history)
  return changes
}

function formatLockStatus(lock) {
  const parts = [lock.state || 'unknown']
  if (lock.battery != null) parts.push(`${lock.battery}%`)
  return parts.join(', ')
}

async function collectGoveeLights() {
  if (!GOVEE_API_KEY) {
    console.log('  Govee lights skipped: set GOVEE_API_KEY to enable Govee status.')
    return []
  }

  try {
    const data = await fetchGoveeJson('/devices')
    const devices = Array.isArray(data.devices) ? data.devices : []
    const lights = []

    for (const device of devices) {
      const stateData = await fetchGoveeJson('/devices/state', {
        device: device.device,
        model: device.model,
      })
      const state = parseGoveeProperties(stateData.properties)

      lights.push({
        name: device.deviceName ?? device.device ?? 'Govee Light',
        model: device.model ?? '',
        device: device.device ?? '',
        controllable: device.controllable,
        retrievable: device.retrievable,
        ...state,
      })

      await wait(250)
    }

    return lights
  } catch (err) {
    console.log(`  Govee lights skipped: ${err.message}`)
    return []
  }
}

async function collectDevices(ringApi) {
  const devices = []

  const cameras = await ringApi.getCameras()
  for (const cam of cameras) {
    const raw = cam.data.battery_life ?? cam.data.battery_life_2 ?? cam.data.batteryLevel ?? null
    const pct = raw != null ? parseInt(raw) : null
    const { label, color } = batteryStatus(pct)
    const kind = cam.data.kind ?? ''
    const category = kind.includes('doorbell') ? 'Doorbell' : 'Camera'
    devices.push({
      name:     (typeof cam.data.description === 'string' ? cam.data.description : cam.data.description?.name) ?? cam.data.kind ?? 'Unknown',
      category,
      battery:  pct,
      label,
      color,
      firmware: cam.data.firmware_version ?? 'â€”',
      wifi:     cam.data.health?.wifi_signal_strength ?? 'â€”',
    })
  }

  const locations = await ringApi.getLocations()
  for (const location of locations) {
    let locationDevices = []
    try {
      locationDevices = await location.getDevices()
    } catch {
      // no alarm hub at this location
    }

    for (const d of locationDevices) {
      const data = d.data
      const name = data.name ?? data.deviceType ?? 'Unknown'
      const skipTypes = ['base-station-v1', 'base-station', 'security-keypad', 'range-extender']
      if (skipTypes.some(t => data.deviceType?.includes(t))) continue

      const pct = data.batteryLevel != null ? Math.round(data.batteryLevel) : null
      const { label, color } = batteryStatus(pct)

      const dt = data.deviceType ?? ''
      let category = 'Sensor'
      if (dt.includes('light') || dt.includes('beam'))  category = 'Light'
      if (dt.includes('contact'))                        category = 'Contact'
      if (dt.includes('motion'))                         category = 'Motion'
      if (dt.includes('lock'))                           category = 'Lock'
      if (dt.includes('siren'))                          category = 'Siren'

      devices.push({
        name,
        category,
        battery: pct,
        label,
        color,
        firmware: '-',
        wifi: '-',
        openState: detectOpenState(data),
        powerState: detectPowerState(data),
        lockState: detectLockState(data),
      })
    }
  }

  return devices
}

function printReport(devices, mailboxStatus, goveeLights = [], appleDevices = [], lockStates = []) {
  const ts = new Date().toLocaleString()
  console.log(`\n${'='.repeat(136)}`)
  console.log(`  Ring Battery Report v${REPORT_VERSION}  .  ${ts}`)
  console.log('='.repeat(136))
  console.log(`  ${'Device'.padEnd(22)} ${'Type'.padEnd(18)} ${'Battery'.padStart(8)}  ${'Status'.padEnd(10)} ${'Drain'.padEnd(12)} ${'Low around'.padEnd(14)} ${'Batt changed'.padEnd(14)} ${'Status changed'.padEnd(14)} Cycle`)
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(18)} ${'-'.repeat(8)}  ${'-'.repeat(10)} ${'-'.repeat(12)} ${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(12)}`)
  for (const d of devices) {
    console.log(`  ${d.name.padEnd(22)} ${displayType(d).padEnd(18)} ${displayBattery(d).padStart(8)}  ${displayStatus(d).padEnd(10)} ${displayDrain(d).padEnd(12)} ${displayForecastDate(d).padEnd(14)} ${displayChangeDate(d.batteryLastChanged, d).padEnd(14)} ${displayChangeDate(d.statusLastChanged, d).padEnd(14)} ${displayDays(d.typicalCycleDays, d)}`)
  }
  if (devices.some(d => d.batteryIsLastKnown)) {
    console.log('  * Battery value was last known from history because Ring returned no battery value this run.')
  }
  if (mailboxStatus?.statusText) {
    console.log(`  Mailbox status -> ${mailboxStatus.statusText}`)
  }
  if (goveeLights.length > 0) {
    console.log('  Govee lights:')
    for (const light of goveeLights) {
      console.log(`    ${light.name}: ${formatGoveeState(light)}`)
    }
  }
  if (lockStates.length > 0) {
    console.log('  Locks:')
    for (const lock of lockStates) {
      console.log(`    ${lock.name}: ${formatLockStatus(lock)}`)
    }
  }
  if (appleDevices.length > 0) {
    console.log('  Apple devices:')
    for (const device of appleDevices) {
      console.log(`    ${device.name}: ${formatAppleDeviceStatus(device)}`)
    }
  }
  console.log('='.repeat(136) + '\n')
}

function barHtml(pct, color) {
  if (pct == null) return `<span style='color:#9ca3af;font-size:.8rem;'>hardwired / N/A</span>`
  return `
    <div style="display:flex;align-items:center;gap:.6rem">
      <div style="flex:1;background:#1e293b;border-radius:99px;height:10px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:${color};border-radius:99px"></div>
      </div>
      <span style="min-width:3rem;text-align:right;font-weight:600;color:${color}">${pct}%</span>
    </div>`
}

async function writeHtml(devices, mailboxStatus, goveeLights = [], appleDevices = [], lockStates = []) {
  const ts       = new Date().toLocaleString()
  const total    = devices.length
  const ok       = devices.filter(d => d.label === 'OK').length
  const low      = devices.filter(d => d.label === 'Low').length
  const critical = devices.filter(d => d.label === 'Critical').length
  const predictedSoon = devices.filter(d => d.daysToLow != null && d.daysToLow <= 30).length
  const mailboxText = mailboxStatus?.statusText ?? 'Mailbox status unavailable'
  const goveeOn = goveeLights.filter(l => l.powerState === 'on').length
  const goveeOffline = goveeLights.filter(l => l.online === false).length
  const appleStale = appleDevices.filter(d => d.stale).length
  const appleCharging = appleDevices.filter(d => d.charging).length
  const unlockedLocks = lockStates.filter(lock => lock.state === 'unlocked').length

  const rows = devices.map(d => `
    <tr>
      <td>${d.name}</td>
      <td><span class="badge">${displayType(d)}</span></td>
      <td>${hasBattery(d) ? `${barHtml(d.battery, d.color)}${d.batteryIsLastKnown ? `<div class="muted">last known ${d.batteryLastKnownDate}</div>` : ''}` : ''}</td>
      <td style="color:${d.color};font-weight:600">${displayStatus(d)}</td>
      <td>${displayDrain(d)}</td>
      <td>${displayForecastDate(d)}${hasBattery(d) && !isPluggedIn(d) && !d.batteryStable ? `<div class="muted">${formatDays(d.daysToLow)}</div>` : ''}</td>
      <td>${displayChangeDate(d.batteryLastChanged, d)}</td>
      <td>${displayChangeDate(d.statusLastChanged, d)}</td>
      <td>${displayDays(d.typicalCycleDays, d)}${hasBattery(d) && !isPluggedIn(d) && !d.batteryStable ? `<div class="muted">${d.predictionConfidence}</div>` : ''}</td>
      <td style="color:#94a3b8">${hasBattery(d) ? d.firmware : ''}</td>
      <td style="color:#94a3b8">${hasBattery(d) ? d.wifi : ''}</td>
    </tr>`).join('')

  const goveeRows = goveeLights.map(light => `
    <tr>
      <td>${light.name}</td>
      <td><span class="badge">${light.model}</span></td>
      <td>${light.online === false ? 'Offline' : 'Online'}</td>
      <td>${light.powerState || ''}</td>
      <td>${light.brightness != null ? `${light.brightness}%` : ''}</td>
      <td>${light.colorTem != null ? `${light.colorTem}K` : ''}</td>
    </tr>`).join('')

  const appleRows = appleDevices.map(device => `
    <tr>
      <td>${device.name}</td>
      <td><span class="badge">${device.model || 'Apple'}</span></td>
      <td>${device.battery != null ? `${device.battery}%` : ''}</td>
      <td>${device.charging ? 'Charging' : 'Not charging'}</td>
      <td>${device.lowPowerMode ? 'Yes' : ''}</td>
      <td>${device.lastSeen ? `${formatDuration(Date.now() - device.lastSeen.getTime())} ago` : 'Never'}</td>
      <td>${device.stale ? 'Stale' : 'OK'}</td>
    </tr>`).join('')

  const lockRows = lockStates.map(lock => `
    <tr>
      <td>${lock.name}</td>
      <td><span class="badge">${lock.source}</span></td>
      <td>${lock.state || 'unknown'}</td>
      <td>${lock.battery != null ? `${lock.battery}%` : ''}</td>
    </tr>`).join('')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ring Battery Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;600&display=swap');
  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0 }
  body { font-family:'DM Sans',sans-serif; background:#0a0f1a; color:#e2e8f0; min-height:100vh; padding:2rem 1.5rem }
  header { display:flex; align-items:flex-end; gap:1rem; margin-bottom:2.5rem; border-bottom:1px solid #1e293b; padding-bottom:1.5rem }
  .ring-icon { width:48px; height:48px; background:#1251d3; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:1.5rem }
  h1 { font-family:'Space Mono',monospace; font-size:1.6rem; font-weight:700 }
  .timestamp { margin-left:auto; font-size:.8rem; color:#64748b; font-family:'Space Mono',monospace }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:1rem; margin-bottom:2.5rem }
  .stat-card { background:#111827; border:1px solid #1e293b; border-radius:12px; padding:1.2rem }
  .stat-card .number { font-family:'Space Mono',monospace; font-size:2rem; font-weight:700; line-height:1 }
  .stat-card .label { font-size:.75rem; color:#64748b; margin-top:.3rem; text-transform:uppercase; letter-spacing:.06em }
  table { width:100%; border-collapse:collapse; background:#111827; border:1px solid #1e293b; border-radius:12px; overflow:hidden }
  thead tr { background:#0f172a }
  th { text-align:left; padding:.9rem 1.2rem; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; color:#475569; border-bottom:1px solid #1e293b }
  td { padding:.85rem 1.2rem; font-size:.9rem; border-bottom:1px solid #1e293b; vertical-align:middle }
  tr:last-child td { border-bottom:none }
  tr:hover td { background:rgba(255,255,255,.02) }
  .badge { display:inline-block; padding:.2rem .65rem; border-radius:99px; background:#1e293b; font-size:.75rem; color:#94a3b8; font-family:'Space Mono',monospace }
  .muted { color:#64748b; font-size:.72rem; margin-top:.2rem }
  footer { margin-top:2rem; font-size:.75rem; color:#374151; text-align:center }
</style>
</head>
<body>
<header>
  <div class="ring-icon">ðŸ“¡</div>
  <div>
    <h1>Ring Battery Report</h1>
    <div style="color:#64748b;font-size:.85rem;margin-top:.2rem">Device health overview</div>
  </div>
  <div class="timestamp">Generated<br>${ts}</div>
</header>
<div class="stats">
  <div class="stat-card"><div class="number" style="color:#e2e8f0">${total}</div><div class="label">Total Devices</div></div>
  <div class="stat-card"><div class="number" style="color:#16a34a">${ok}</div><div class="label">OK</div></div>
  <div class="stat-card"><div class="number" style="color:#d97706">${low}</div><div class="label">Low</div></div>
  <div class="stat-card"><div class="number" style="color:#dc2626">${critical}</div><div class="label">Critical</div></div>
  <div class="stat-card"><div class="number" style="color:#38bdf8">${predictedSoon}</div><div class="label">Due Within 30 Days</div></div>
  <div class="stat-card"><div class="number" style="color:#e2e8f0;font-size:1rem;line-height:1.25">${mailboxText}</div><div class="label">Mailbox</div></div>
  <div class="stat-card"><div class="number" style="color:#facc15">${goveeOn}/${goveeLights.length}</div><div class="label">Govee On</div></div>
  <div class="stat-card"><div class="number" style="color:#dc2626">${goveeOffline}</div><div class="label">Govee Offline</div></div>
  <div class="stat-card"><div class="number" style="color:#e2e8f0">${appleDevices.length}</div><div class="label">Apple Devices</div></div>
  <div class="stat-card"><div class="number" style="color:#38bdf8">${appleCharging}</div><div class="label">Apple Charging</div></div>
  <div class="stat-card"><div class="number" style="color:${appleStale ? '#dc2626' : '#16a34a'}">${appleStale}</div><div class="label">Apple Stale</div></div>
  <div class="stat-card"><div class="number" style="color:${unlockedLocks ? '#dc2626' : '#16a34a'}">${unlockedLocks}/${lockStates.length}</div><div class="label">Locks Unlocked</div></div>
</div>
<table>
  <thead><tr>
    <th>Device Name</th><th>Type</th><th style="min-width:200px">Battery</th>
    <th>Status</th><th>Drain</th><th>Predicted Low</th><th>Battery Changed</th><th>Status Changed</th><th>Typical Cycle</th><th>Firmware</th><th>Wi-Fi Signal</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
${goveeLights.length > 0 ? `
<h2 style="font-family:'Space Mono',monospace;font-size:1.1rem;margin:2rem 0 1rem">Govee Lights</h2>
<table>
  <thead><tr>
    <th>Light</th><th>Model</th><th>Connection</th><th>Power</th><th>Brightness</th><th>Color Temp</th>
  </tr></thead>
  <tbody>${goveeRows}</tbody>
</table>` : ''}
${lockStates.length > 0 ? `
<h2 style="font-family:'Space Mono',monospace;font-size:1.1rem;margin:2rem 0 1rem">Locks</h2>
<table>
  <thead><tr>
    <th>Lock</th><th>Source</th><th>Status</th><th>Battery</th>
  </tr></thead>
  <tbody>${lockRows}</tbody>
</table>` : ''}
${appleDevices.length > 0 ? `
<h2 style="font-family:'Space Mono',monospace;font-size:1.1rem;margin:2rem 0 1rem">Apple Devices</h2>
<table>
  <thead><tr>
    <th>Device</th><th>Type</th><th>Battery</th><th>Charging</th><th>Low Power</th><th>Last Seen</th><th>Status</th>
  </tr></thead>
  <tbody>${appleRows}</tbody>
</table>` : ''}
<footer>Ring Battery Report v${REPORT_VERSION} Â· Generated by ring-client-api Â· Not affiliated with Ring / Amazon</footer>
</body>
</html>`

  await writeFile(REPORT_FILE, html, 'utf-8')
  console.log(`  HTML report saved -> ${process.cwd()}/${REPORT_FILE}`)
  console.log(`  Ring Battery Report version -> ${REPORT_VERSION}\n`)
}

async function sendTextAlert(lowDevices) {
  const lines = lowDevices.map(d => `${d.name}: ${d.battery}% (${d.label}${d.batteryIsLastKnown ? ', last known' : ''})`).join('\n')
  const message = `Ring Battery Alert!\n\n${lines}\n\nCharge or replace soon.`
  await sendTextMessage(message)
}

async function sendMailboxOpenAlert(message) {
  await sendTextMessage(`Ring Mailbox Alert!\n\n${message}`)
}

async function sendLightStateAlert(changes) {
  const lines = changes
    .map(change => `${change.source} ${change.name}: ${change.previousState} -> ${change.state}`)
    .join('\n')
  await sendTextMessage(`Light State Alert!\n\n${lines}`)
}

async function sendLockStateAlert(changes) {
  const lines = changes
    .map(change => `${change.source} ${change.name}: ${change.previousState} -> ${change.state}`)
    .join('\n')
  await sendTextMessage(`Lock State Alert!\n\n${lines}`)
}

async function sendTextMessage(message) {
  if (!GMAIL_USER || !GMAIL_PASS) {
    console.log('  Text alert skipped: set GMAIL_USER and GMAIL_PASS to enable SMTP alerts.')
    return
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS }
  })

  await transporter.sendMail({
    from: GMAIL_USER,
    to: SMS_TO,
    subject: '',
    text: message
  })

  console.log(`  Text alert sent to ${SMS_TO}`)
}

async function main() {
  const refreshToken = await loadToken()

  const ringApi = new RingApi({
    refreshToken,
    onRefreshTokenUpdated: (newToken) => saveToken(newToken),
  })

  console.log('Fetching device data...')
  const allDevices = await collectDevices(ringApi)
  const devices = visibleRingDevices(allDevices)

  if (devices.length === 0) {
    console.log('No devices found.')
    process.exit(0)
  }

  await requeryMissingBatteryDevices(ringApi, devices)
  const goveeLights = await collectGoveeLights()
  const appleDevices = loadAppleDevices()
  const lightStateChanges = updateLightStateHistory([
    ...collectRingLightStates(allDevices),
    ...collectGoveeLightStates(goveeLights),
  ])
  const lockStates = collectLockStates(allDevices)
  const lockStateChanges = updateLockStateHistory(lockStates)
  updateBatteryHistory(devices)
  const mailboxOpenAlert = updateMailboxOpenState(devices)
  printReport(devices, mailboxOpenAlert, goveeLights, appleDevices, lockStates)

  const alertDevices = devices.filter(d => d.battery != null && d.battery < BATTERY_LOW)
  if (alertDevices.length > 0 && SEND_ALERTS) {
    console.log(`  âš ï¸  Sending text alert for ${alertDevices.length} low battery device(s)...`)
    try {
      await sendTextAlert(alertDevices)
    } catch (err) {
      console.log(`  Text alert failed: ${err.message}`)
      console.log('  Report completed anyway. Run with --no-alert to skip alerts.')
    }
  } else if (alertDevices.length > 0) {
    console.log(`  Text alert skipped for ${alertDevices.length} low battery device(s).`)
  }

  if (mailboxOpenAlert.shouldAlert && SEND_ALERTS) {
    console.log(`  Sending mailbox open alert: ${mailboxOpenAlert.message}`)
    try {
      await sendMailboxOpenAlert(mailboxOpenAlert.message)
    } catch (err) {
      console.log(`  Mailbox alert failed: ${err.message}`)
      console.log('  Report completed anyway. Run with --no-alert to skip alerts.')
    }
  } else if (mailboxOpenAlert.mailbox?.openState) {
    console.log(`  Mailbox is open/active; alert threshold is ${MAILBOX_OPEN_ALERT_MINUTES} minute(s).`)
  }

  if (lightStateChanges.length > 0 && SEND_ALERTS && LIGHT_STATE_ALERTS) {
    console.log(`  Sending light state alert for ${lightStateChanges.length} change(s)...`)
    try {
      await sendLightStateAlert(lightStateChanges)
    } catch (err) {
      console.log(`  Light state alert failed: ${err.message}`)
      console.log('  Report completed anyway. Run with --no-alert to skip alerts.')
    }
  } else if (lightStateChanges.length > 0) {
    console.log(`  Light state alert skipped for ${lightStateChanges.length} change(s).`)
  }

  if (lockStateChanges.length > 0 && SEND_ALERTS && LOCK_STATE_ALERTS) {
    console.log(`  Sending lock state alert for ${lockStateChanges.length} change(s)...`)
    try {
      await sendLockStateAlert(lockStateChanges)
    } catch (err) {
      console.log(`  Lock state alert failed: ${err.message}`)
      console.log('  Report completed anyway. Run with --no-alert to skip alerts.')
    }
  } else if (lockStateChanges.length > 0) {
    console.log(`  Lock state alert skipped for ${lockStateChanges.length} change(s).`)
  }

  await writeHtml(devices, mailboxOpenAlert, goveeLights, appleDevices, lockStates)
  console.log(`  Open ${REPORT_FILE} in your browser for the full visual report.`)
  process.exit(0)
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
