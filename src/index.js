// BannerHub Token Refresher
// Automatically refreshes GameHub authentication token every 4 hours

import { md5 } from './md5.js'

export default {
  // Scheduled trigger - runs every 4 hours
  async scheduled(event, env, ctx) {
    console.log('🔄 Starting token refresh...')

    try {
      const newToken = await refreshToken(env)

      if (newToken) {
        // Store token with metadata
        const tokenData = {
          token: newToken,
          refreshed_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
        }

        await env.TOKEN_STORE.put('bannerhub_token', JSON.stringify(tokenData))
        console.log('✅ Token refreshed and stored:', newToken)
      }
    } catch (error) {
      console.error('❌ Token refresh failed:', error.message)
      throw error
    }
  },

  // HTTP endpoint for manual token refresh and retrieval
  async fetch(request, env) {
    const url = new URL(request.url)

    // GET /token - Retrieve current token (only from gamehub-api worker)
    if (url.pathname === '/token' && request.method === 'GET') {
      // Check if request has the secret auth header
      const authSecret = request.headers.get('X-Worker-Auth')

      // Only allow requests with correct secret (from gamehub-api worker)
      if (authSecret !== 'bannerhub-internal-token-fetch-2025') {
        return new Response('fuck you', {
          status: 403,
          headers: { 'Content-Type': 'text/plain' },
        })
      }

      const tokenDataStr = await env.TOKEN_STORE.get('bannerhub_token')

      if (!tokenDataStr) {
        return new Response(JSON.stringify({ error: 'No token available' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const tokenData = JSON.parse(tokenDataStr)
      return new Response(JSON.stringify(tokenData), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // POST /refresh - Manual token refresh
    if (url.pathname === '/refresh' && request.method === 'POST') {
      try {
        const newToken = await refreshToken(env)

        if (newToken) {
          const tokenData = {
            token: newToken,
            refreshed_at: new Date().toISOString(),
            expires_at: new Date(
              Date.now() + 24 * 60 * 60 * 1000,
            ).toISOString(),
          }

          await env.TOKEN_STORE.put('bannerhub_token', JSON.stringify(tokenData))

          return new Response(
            JSON.stringify({
              success: true,
              token: newToken,
              refreshed_at: tokenData.refreshed_at,
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        throw new Error('Failed to obtain new token')
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error.message,
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          },
        )
      }
    }

    return new Response(
      'BannerHub Token Refresher\n\nEndpoints:\nGET /token - Get current token\nPOST /refresh - Manually refresh token',
      {
        headers: { 'Content-Type': 'text/plain' },
      },
    )
  },
}

// Main token refresh logic
async function refreshToken(env) {
  console.log('📧 Step 1: Authenticating with Mail.tm...')
  const mailTmToken = await getMailTmToken(env)

  console.log('📨 Step 2: Requesting OTP from GameHub...')
  await requestOTP(env)

  console.log('⏳ Step 3: Waiting for OTP email...')
  await sleep(5000) // Wait 5 seconds for email to arrive

  console.log('📬 Step 4: Fetching OTP from inbox...')
  const otp = await getOTPFromEmail(env, mailTmToken)

  console.log('🔐 Step 5: Logging in with OTP...')
  const token = await loginWithOTP(env, otp)

  console.log('✨ Step 6: Token obtained!')
  return token
}

// Get Mail.tm authentication token
async function getMailTmToken(env) {
  const response = await fetch(`${env.MAILTM_API_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: env.MAILTM_EMAIL,
      password: env.MAILTM_PASSWORD,
    }),
  })

  if (!response.ok) {
    throw new Error(`Mail.tm auth failed: ${response.status}`)
  }

  const data = await response.json()
  return data.token
}

// Request OTP from GameHub
async function requestOTP(env) {
  const response = await fetch(`${env.GAMEHUB_API_BASE}/ems/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sign: 'any',
      time: String(Date.now()),
      event: 'register',
      clientparams: env.GAMEHUB_CLIENTPARAMS,
      email: env.GAMEHUB_EMAIL,
      token: '',
    }),
  })

  if (!response.ok) {
    throw new Error(`OTP request failed: ${response.status}`)
  }

  const data = await response.json()
  if (data.code !== 200) {
    throw new Error(`OTP request failed: ${data.msg}`)
  }
}

// Get OTP from Mail.tm inbox
async function getOTPFromEmail(env, mailTmToken) {
  const response = await fetch(`${env.MAILTM_API_BASE}/messages`, {
    headers: { Authorization: `Bearer ${mailTmToken}` },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch emails: ${response.status}`)
  }

  const data = await response.json()
  const messages = data['hydra:member'] || []

  if (messages.length === 0) {
    throw new Error('No OTP email received')
  }

  // Get the most recent message
  const latestMessage = messages[0]
  const intro = latestMessage.intro || ''

  // Extract 6-digit OTP code
  const otpMatch = intro.match(/\d{6}/)
  if (!otpMatch) {
    throw new Error('OTP code not found in email')
  }

  return otpMatch[0]
}

// Login to GameHub with OTP
async function loginWithOTP(env, otp) {
  const timestamp = String(Date.now())

  // Generate signature
  const params = {
    captcha: otp,
    clientparams: env.GAMEHUB_CLIENTPARAMS,
    email: env.GAMEHUB_EMAIL,
    time: timestamp,
  }

  const signature = await generateSignature(params, env.GAMEHUB_SECRET_KEY)

  // Login request
  const response = await fetch(`${env.GAMEHUB_API_BASE}/email/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      captcha: otp,
      sign: signature,
      time: timestamp,
      clientparams: env.GAMEHUB_CLIENTPARAMS,
      email: env.GAMEHUB_EMAIL,
    }),
  })

  if (!response.ok) {
    throw new Error(`Login failed: ${response.status}`)
  }

  const data = await response.json()

  if (data.code !== 200) {
    throw new Error(`Login failed: ${data.msg}`)
  }

  if (!data.data?.userinfo?.token) {
    throw new Error('No token in login response')
  }

  return data.data.userinfo.token
}

// Generate GameHub API signature
function generateSignature(params, secretKey) {
  // Sort parameters alphabetically
  const sortedKeys = Object.keys(params).sort()

  // Build parameter string: key1=value1&key2=value2
  const paramString = sortedKeys.map((key) => `${key}=${params[key]}`).join('&')

  // Append secret key
  const signString = `${paramString}&${secretKey}`

  // MD5 hash and return lowercase
  return md5(signString).toLowerCase()
}

// Sleep utility
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
