import { RingApi } from 'ring-client-api'
import { readFileSync } from 'fs'

const tokenData = JSON.parse(readFileSync('ring_token.json', 'utf-8'))
const ringApi = new RingApi({ refreshToken: tokenData.refreshToken ?? tokenData })
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Ring inspection timed out')), 30000))
const locations = await Promise.race([ringApi.getLocations(), timeout])

for (const location of locations) {
  let devices = []
  try {
    devices = await Promise.race([location.getDevices(), timeout])
  } catch (err) {
    console.error(`Could not read location devices: ${err.message}`)
  }

  for (const d of devices) {
    const data = d.data ?? {}
    const name = data.name ?? data.description ?? data.deviceType ?? 'Unknown'
    const type = data.deviceType ?? ''
    const text = `${name} ${type}`.toLowerCase()
    if (!text.includes('kwikset') && !text.includes('lock')) continue

    const safe = {}
    for (const key of [
      'name',
      'deviceType',
      'batteryLevel',
      'faulted',
      'open',
      'locked',
      'lockState',
      'state',
      'status',
      'tampered',
      'offline',
      'commStatus',
    ]) {
      if (data[key] !== undefined) safe[key] = data[key]
    }

    console.log(JSON.stringify(safe, null, 2))
  }
}
