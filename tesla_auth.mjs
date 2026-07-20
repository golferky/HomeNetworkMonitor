/**
 * Tesla Token Generator
 * Run this once to get your Tesla refresh token.
 * Usage: node tesla_auth.mjs
 */

import { createServer } from 'http'
import { createInterface } from 'readline'
import { writeFileSync } from 'fs'
import crypto from 'crypto'

const CLIENT_ID     = 'ownerapi'
const REDIRECT_URI  = 'http://localhost:3000/callback'
const AUTH_BASE     = 'https://auth.tesla.com/oauth2/v3'
const TOKEN_FILE    = 'tesla_token.json'

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function main() {
  // Generate PKCE values
  const verifier  = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state     = base64url(crypto.randomBytes(16))

  const authUrl = `${AUTH_BASE}/authorize?` + new URLSearchParams({
    client_id:             CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    response_type:         'code',
    scope:                 'openid email offline_access vehicle_device_data vehicle_cmds',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  })

  console.log('\n=== Tesla Token Generator ===\n')
  console.log('1. A local server is starting on http://localhost:3000')
  console.log('2. Opening Tesla login in your browser...')
  console.log('3. Log in and approve access')
  console.log('4. Token will be saved automatically to tesla_token.json\n')
  console.log('If browser does not open, visit this URL manually:')
  console.log(authUrl + '\n')

  // Open browser
  const { exec } = await import('child_process')
  exec(`open "${authUrl}"`)

  // Start local server to catch callback
  await new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3000')
      if (url.pathname !== '/callback') {
        res.end('Waiting...')
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.end('No code received. Try again.')
        reject(new Error('No code in callback'))
        return
      }

      res.end('<h2>✅ Tesla token captured! You can close this tab.</h2>')
      server.close()

      // Exchange code for tokens
      console.log('Exchanging code for tokens...')
      try {
        const resp = await fetch(`${AUTH_BASE}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type:    'authorization_code',
            client_id:     CLIENT_ID,
            redirect_uri:  REDIRECT_URI,
            code,
            code_verifier: verifier,
          })
        })

        const tokens = await resp.json()
        if (!tokens.refresh_token) {
          console.error('Error getting token:', tokens)
          reject(new Error('No refresh token in response'))
          return
        }

        writeFileSync(TOKEN_FILE, JSON.stringify({
          refresh_token: tokens.refresh_token,
          access_token:  tokens.access_token,
        }))

        console.log(`\n✅ Tesla token saved to ${TOKEN_FILE}`)
        console.log('You can now run: node ring_battery_report.mjs\n')
        resolve()
      } catch (err) {
        reject(err)
      }
    })

    server.listen(3000, () => {
      console.log('Waiting for Tesla login callback...\n')
    })

    server.on('error', reject)
  })
}

main().catch(err => {
  console.error('Error:', err.message)
  process.exit(1)
})
