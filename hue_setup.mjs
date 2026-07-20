import { existsSync, readFileSync, appendFileSync } from 'fs'

const ALERT_ENV_FILES = ['ring_battery_alert.env', '.env']
const bridgeIp = process.argv[2] ?? process.env.HUE_BRIDGE_IP

function loadEnv() {
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

function envHasKey(key) {
  return ALERT_ENV_FILES.some(file =>
    existsSync(file) &&
    readFileSync(file, 'utf-8').split(/\r?\n/).some(line => line.trim().startsWith(`${key}=`))
  )
}

async function main() {
  loadEnv()

  const ip = bridgeIp ?? process.env.HUE_BRIDGE_IP
  if (!ip) {
    console.log('Usage: node hue_setup.mjs <Hue bridge IP>')
    console.log('Example: node hue_setup.mjs 192.168.1.25')
    process.exit(1)
  }

  console.log(`Connecting to Hue bridge at ${ip}...`)
  console.log('Press the round button on the Hue bridge, then run this again if it says link button not pressed.')

  const response = await fetch(`http://${ip}/api`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: 'gary_home_event_watcher#mac' }),
  })

  const json = await response.json()
  const error = json.find?.(entry => entry.error)?.error
  if (error) {
    console.log(`Hue setup failed: ${error.description}`)
    process.exit(1)
  }

  const username = json.find?.(entry => entry.success)?.success?.username
  if (!username) {
    console.log(`Hue setup returned an unexpected response: ${JSON.stringify(json)}`)
    process.exit(1)
  }

  const lines = []
  if (!envHasKey('HUE_BRIDGE_IP')) lines.push(`HUE_BRIDGE_IP=${ip}`)
  if (!envHasKey('HUE_USERNAME') && !envHasKey('HUE_API_KEY')) lines.push(`HUE_USERNAME=${username}`)

  if (lines.length > 0) {
    appendFileSync('.env', `\n${lines.join('\n')}\n`)
    console.log('Saved Hue settings to .env.')
  } else {
    console.log('Hue settings already exist in .env or ring_battery_alert.env.')
  }

  console.log('Hue setup complete.')
}

main().catch(err => {
  console.error(err.message)
  process.exit(1)
})
