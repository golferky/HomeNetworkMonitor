import { RingApi } from 'ring-client-api'
import { readFileSync } from 'fs'

const tokenData = JSON.parse(readFileSync('ring_token.json', 'utf-8'))
const ringApi = new RingApi({ refreshToken: tokenData.refreshToken ?? tokenData })
const locations = await ringApi.getLocations()

for (const location of locations) {
  let devices = []
  try {
    devices = await location.getDevices()
  } catch (err) {
    console.error(`Could not read location devices: ${err.message}`)
    continue
  }

  for (const d of devices) {
    const data = d.data ?? {}
    const name = data.name ?? data.description ?? data.deviceType ?? 'Unknown'
    const type = data.deviceType ?? ''
    const battery = data.batteryLevel ?? ''
    const state = data.locked ?? data.lockState ?? data.state ?? data.status ?? ''
    console.log(`${name}\t${type}\tbattery=${battery}\tstate=${state}`)
  }
}

process.exit(0)
