# GameHub Token Refresher Worker

Automated token refresh worker that logs into GameHub every 4 hours using OTP authentication and stores fresh tokens in Cloudflare KV storage.

## Features

- 🔄 **Automatic Refresh**: Runs every 4 hours via Cloudflare Cron Triggers
- 📧 **Email-based OTP**: Uses Mail.tm temporary email to receive verification codes
- 🔐 **Signature Generation**: Implements GameHub's MD5-based signature algorithm
- 💾 **KV Storage**: Stores tokens with metadata for easy retrieval
- 🔒 **Secure Access**: Protected endpoint with secret header authentication
- 🔍 **Manual Refresh**: HTTP endpoint for on-demand token refresh

## How It Works

### Token Refresh Flow

```
⏰ Cron Trigger (every 4 hours)
    ↓
📧 Authenticate with Mail.tm API
    ↓
📨 Request OTP from GameHub (/ems/send)
    ↓
⏳ Wait 5 seconds for email
    ↓
📬 Fetch OTP from Mail.tm inbox
    ↓
🔐 Generate signature: MD5(sorted_params + secret_key)
    ↓
🔓 Login to GameHub (/email/login)
    ↓
💾 Store token in KV storage
    ↓
✅ Token ready for use
```

### Signature Algorithm

**Secret Key**: See `SignUtils.smali` in decompiled APK (search for the secret key constant)

**Process**:

1. Collect parameters: `{captcha, clientparams, email, time}`
2. Sort alphabetically by key
3. Join as: `key1=value1&key2=value2&key3=value3`
4. Append secret: `&[SECRET_KEY_FROM_SMALI]`
5. MD5 hash and convert to lowercase

**Example**:

```javascript
// Input parameters
{
  captcha: "123456",
  clientparams: "5.1.0|16|en|...",
  email: "your-email@mail.tm",
  time: "1760030250000"
}

// After sorting and joining
"captcha=123456&clientparams=5.1.0|16|en|...&email=your-email@mail.tm&time=1760030250000&[SECRET_KEY]"

// MD5 hash (lowercase)
"[generated_signature_hash]"
```

## Setup

### 1. Install Dependencies

```bash
cd gamehub-token-refresher
npm install
```

### 2. Create KV Namespace

```bash
npx wrangler kv:namespace create TOKEN_STORE
```

Copy the namespace ID and update `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TOKEN_STORE"
id = "your_namespace_id_here"
```

### 3. Configure Environment Variables

Edit `wrangler.toml` and update these values:

```toml
[vars]
GAMEHUB_EMAIL = "your-gamehub-email@mail.tm"
GAMEHUB_API_BASE = "https://landscape-api.vgabc.com"
MAILTM_EMAIL = "your-mailtm-email@mail.tm"
MAILTM_PASSWORD = "your-mailtm-password"
MAILTM_API_BASE = "https://api.mail.tm"
GAMEHUB_CLIENTPARAMS = "5.1.0|16|en|DEVICE_MODEL|WIDTH * HEIGHT|gamehub_android|gamehub_android_Official|MANUFACTURER|||||||||BENCHMARK_APP||CHIPSET"
GAMEHUB_SECRET_KEY = "[EXTRACT_FROM_SignUtils.smali]"
```

**Setting up Mail.tm**:

1. Visit https://mail.tm
2. Create a temporary email account
3. Note the email and password
4. Use these in `MAILTM_EMAIL` and `MAILTM_PASSWORD`
5. Register the same email with GameHub

### 4. Deploy

```bash
npm run deploy
```

### 5. Trigger Manual Refresh (Optional)

```bash
curl -X POST https://gamehub-token-refresher.YOUR_SUBDOMAIN.workers.dev/refresh
```

## API Endpoints

### GET /token

Retrieve the current stored token (protected endpoint)

**Authentication**: Requires `X-Worker-Auth: gamehub-internal-token-fetch-2025` header

**Example** (from another Cloudflare Worker):

```javascript
const tokenResponse = await fetch(
  'https://gamehub-token-refresher.emuready.workers.dev/token',
  {
    headers: {
      'X-Worker-Auth': 'gamehub-internal-token-fetch-2025',
    },
  },
)

const tokenData = await tokenResponse.json()
console.log(tokenData.token) // "f589a94e-fec5-4aea-a96b-115ecdfd50d8"
```

**Response**:

```json
{
  "token": "f589a94e-fec5-4aea-a96b-115ecdfd50d8",
  "refreshed_at": "2025-10-09T17:42:35.509Z",
  "expires_at": "2025-10-10T17:42:35.509Z"
}
```

**Security**:

- ✅ Requests with correct header → Token returned
- ❌ Requests without header → `fuck you` (403 Forbidden)
- ❌ Requests from browsers → `fuck you` (403 Forbidden)

### POST /refresh

Manually trigger a token refresh (bypasses cron)

**Example**:

```bash
curl -X POST https://gamehub-token-refresher.emuready.workers.dev/refresh
```

**Response**:

```json
{
  "success": true,
  "token": "f589a94e-fec5-4aea-a96b-115ecdfd50d8",
  "refreshed_at": "2025-10-09T18:00:00.000Z"
}
```

**Use Cases**:

- Testing the token refresh flow
- Debugging authentication issues
- Immediate token refresh needed

### GET /

Service info and status

**Response**:

```
GameHub Token Refresher

Endpoints:
GET /token - Get current token (protected)
POST /refresh - Manually refresh token
```

## KV Storage Schema

**Key**: `gamehub_token`

**Value**:

```json
{
  "token": "f589a94e-fec5-4aea-a96b-115ecdfd50d8",
  "refreshed_at": "2025-10-09T17:42:35.509Z",
  "expires_at": "2025-10-10T17:42:35.509Z"
}
```

**Storage Type**: Persistent (no expiration)

**Access**: Remote production KV namespace

## Cron Schedule

```toml
[triggers]
crons = ["0 */4 * * *"]  # Every 4 hours at the top of the hour
```

**Schedule**:

- 00:00 UTC
- 04:00 UTC
- 08:00 UTC
- 12:00 UTC
- 16:00 UTC
- 20:00 UTC

**Token Lifetime**: ~24 hours (estimated)
**Safety Margin**: Refreshes 6 times within token lifetime

## Integration with GameHub API Worker

The main GameHub API worker fetches tokens from this service:

```javascript
// Fetch real token from token-refresher worker
const tokenResponse = await fetch(`${env.TOKEN_REFRESHER_URL}/token`, {
  headers: {
    'X-Worker-Auth': 'gamehub-internal-token-fetch-2025',
  },
})

if (tokenResponse.ok) {
  const tokenData = await tokenResponse.json()
  const realToken = tokenData.token

  // Replace fake-token with real token
  bodyJson.token = realToken

  // Regenerate signature
  bodyJson.sign = generateSignature(bodyJson)
}
```

## Monitoring

### View Worker Logs in Real-Time

```bash
npm run tail
```

### Check Cron Execution History

Visit Cloudflare Dashboard:

1. Go to Workers & Pages
2. Select `gamehub-token-refresher`
3. Click **Triggers** tab
4. View cron execution history

### Inspect KV Storage

```bash
# List all keys
npx wrangler kv:key list --binding=TOKEN_STORE --remote

# Get token value
npx wrangler kv:key get gamehub_token --binding=TOKEN_STORE --remote
```

### Test Token Endpoint Protection

```bash
# Without auth header (should get "fuck you")
curl https://gamehub-token-refresher.emuready.workers.dev/token

# With auth header (should get token)
curl -H "X-Worker-Auth: gamehub-internal-token-fetch-2025" \
  https://gamehub-token-refresher.emuready.workers.dev/token
```

## Error Handling

| Error              | Action          | Recovery                     |
| ------------------ | --------------- | ---------------------------- |
| Mail.tm auth fails | Throw error     | Retry on next cron (4 hours) |
| OTP not received   | Throw error     | Retry on next cron           |
| Invalid OTP        | Throw error     | Retry on next cron           |
| Login fails        | Throw error     | Retry on next cron           |
| Network timeout    | Automatic retry | Cloudflare handles retry     |

**All errors are logged to Cloudflare dashboard for debugging**

## Performance

- **Cold Start**: ~200ms
- **Execution Time**: ~6-8 seconds (including 5s sleep for OTP)
- **Memory**: <10MB
- **Cost**: Free tier (< 100k requests/day)

## Troubleshooting

### OTP not received

1. Check Mail.tm inbox manually at https://mail.tm
2. Increase sleep time in `src/index.js`:
   ```javascript
   await sleep(10000) // 10 seconds instead of 5
   ```
3. Check GameHub email is registered with Mail.tm account

### Signature validation failed

1. Verify secret key matches the one in `SignUtils.smali` from the decompiled APK
2. Check parameters are sorted alphabetically
3. Ensure timestamp is in milliseconds (not seconds)
4. Test with known working example

### Cron not running

1. Check Cloudflare dashboard > Workers > Triggers
2. Verify cron syntax in `wrangler.toml`
3. Manually trigger via `POST /refresh`
4. Review worker logs for errors

### KV storage empty

1. Check namespace ID matches `wrangler.toml`
2. Use `--remote` flag when checking KV:
   ```bash
   npx wrangler kv:key get gamehub_token --binding=TOKEN_STORE --remote
   ```
3. Manually trigger refresh to populate KV

### "fuck you" Response

This is normal! It means the security is working. Only the gamehub-api worker with the correct auth header can access tokens.

## Security Considerations

1. **Secret Key**: Extract from `SignUtils.smali` in decompiled APK (reverse engineering required)
2. **Email Credentials**: Stored as environment variables in `wrangler.toml`
3. **Token Storage**: KV is private to worker, not publicly accessible
4. **API Access**: `/token` endpoint protected by secret header
5. **Auth Header**: Custom auth header required (configure in worker code)

## Development

Run locally (with remote KV):

```bash
npm run dev
```

Test refresh locally:

```bash
curl -X POST http://localhost:8787/refresh
```

## Future Improvements

1. **Retry Logic**: Exponential backoff for OTP fetch failures
2. **Multiple Accounts**: Support token rotation across multiple Mail.tm accounts
3. **Token Validation**: Verify token works before storing
4. **Notification**: Alert on consecutive failures (email/webhook)
5. **Rate Limiting**: Prevent abuse of manual refresh endpoint
6. **Metrics**: Track success rate and latency

## Notes

- Tokens expire after ~24 hours
- Refresh runs 6 times within token lifetime (4-hour intervals)
- Mail.tm is a free temporary email service (no registration needed)
- GameHub API uses MD5 signatures for authentication
- Secret key was reverse-engineered from `SignUtils.smali` in APK
- Worker uses service-to-service authentication (not user-facing)
