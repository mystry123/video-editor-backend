# Video Editor Backend

Express.js + MongoDB + TypeScript backend with secure cookie-based authentication.

## Features

- 🔐 **Secure Cookie-Based Auth** - HTTP-only cookies (XSS protected)
- 🌐 **OAuth Support** - Google, Apple, Facebook
- 📝 **Template CRUD** - With versioning
- 📁 **File Upload** - S3 + CloudFront CDN
- 🎤 **Transcription** - ElevenLabs integration
- 🎬 **Video Rendering** - Remotion Lambda
- 🔗 **Webhooks** - For automation (n8n/Zapier)
- 📊 **Job Queues** - BullMQ + Redis

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your credentials

# Start databases (Docker)
docker-compose up -d mongo redis

# Run development server
npm run dev
```

## Authentication

This API uses **HTTP-only cookies** for secure browser authentication.

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    COOKIE-BASED AUTH                         │
├─────────────────────────────────────────────────────────────┤
│  Access Token Cookie                                         │
│  • Name: access_token                                        │
│  • HttpOnly: true (JS can't access - XSS protected)         │
│  • Secure: true (HTTPS only in production)                  │
│  • SameSite: lax (CSRF protected, allows OAuth redirects)   │
│  • MaxAge: 15 minutes                                        │
│  • Path: /api                                                │
├─────────────────────────────────────────────────────────────┤
│  Refresh Token Cookie                                        │
│  • Name: refresh_token                                       │
│  • HttpOnly: true                                            │
│  • Secure: true                                              │
│  • SameSite: lax                                             │
│  • MaxAge: 7 days                                            │
│  • Path: /api/v1/auth (restricted)                          │
└─────────────────────────────────────────────────────────────┘
```

### Frontend Integration

```typescript
// All requests must include credentials for cookies to work
const response = await fetch('http://localhost:3000/api/v1/auth/me', {
  credentials: 'include', // Required!
});

// Login example
const login = await fetch('http://localhost:3000/api/v1/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com', password: 'Password123' }),
});

// Response contains user data (tokens are in cookies automatically)
const { user } = await login.json();
```

### Axios Configuration

```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api/v1',
  withCredentials: true, // Required for cookies
});

// Login
const { data } = await api.post('/auth/login', {
  email: 'user@example.com',
  password: 'Password123',
});
console.log(data.user);

// Authenticated request (cookies sent automatically)
const { data: profile } = await api.get('/auth/me');
```

## API Endpoints

### Authentication

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| POST | `/auth/signup` | Create account | No |
| POST | `/auth/login` | Login | No |
| POST | `/auth/logout` | Logout (current device) | Yes |
| POST | `/auth/logout-all` | Logout (all devices) | Yes |
| POST | `/auth/refresh` | Refresh tokens | Cookie |
| GET | `/auth/status` | Check auth status | Optional |
| POST | `/auth/forgot-password` | Send reset email | No |
| POST | `/auth/reset-password` | Reset password | No |
| POST | `/auth/change-password` | Change password | Yes |

### OAuth

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/auth/google` | Get Google OAuth URL |
| GET | `/auth/google/callback` | Google callback (redirect) |
| POST | `/auth/google/token` | Verify Google ID token |
| GET | `/auth/apple` | Get Apple OAuth URL |
| POST | `/auth/apple/callback` | Apple callback |
| POST | `/auth/apple/token` | Verify Apple ID token |
| GET | `/auth/facebook` | Get Facebook OAuth URL |
| GET | `/auth/facebook/callback` | Facebook callback |
| POST | `/auth/facebook/token` | Verify Facebook token |

### Profile

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| GET | `/auth/me` | Get profile | Yes |
| PUT | `/auth/me` | Update profile | Yes |
| DELETE | `/auth/me` | Delete account | Yes |
| POST | `/auth/set-password` | Set password (OAuth users) | Yes |
| POST | `/auth/link/:provider` | Link OAuth account | Cookie |
| DELETE | `/auth/unlink/:provider` | Unlink OAuth account | Cookie |

### API Keys (Programmatic Access)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/api-keys` | Create API key |
| GET | `/auth/api-keys` | List API keys |
| DELETE | `/auth/api-keys/:id` | Delete API key |

### Templates

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/templates` | Create template |
| GET | `/templates` | List templates |
| GET | `/templates/:id` | Get template |
| PUT | `/templates/:id` | Update template |
| DELETE | `/templates/:id` | Delete template |
| GET | `/templates/:id/versions` | Get versions |
| POST | `/templates/:id/restore/:version` | Restore version |

### Files

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/files/upload-url` | Get presigned upload URL |
| POST | `/files/:id/complete` | Confirm upload complete |
| GET | `/files` | List files |
| DELETE | `/files/:id` | Delete file |

### Transcription

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/transcriptions` | Create transcription |
| GET | `/transcriptions/:id` | Get transcription |

### Rendering

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/render` | Start render job |
| GET | `/render/:id` | Get render status |
| GET | `/render/:id/progress` | Stream progress (SSE) |
| POST | `/render/:id/cancel` | Cancel render |

## OAuth Setup

### Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project
3. Configure OAuth consent screen
4. Create OAuth 2.0 Client ID (Web application)
5. Add authorized redirect URI: `http://localhost:3000/api/v1/auth/google/callback`

### Apple

1. Go to [Apple Developer](https://developer.apple.com/account/resources/identifiers)
2. Create App ID with "Sign In with Apple" capability
3. Create Service ID (this becomes your client ID)
4. Create Key with "Sign In with Apple" capability
5. Download the .p8 key file

### Facebook

1. Go to [Facebook Developers](https://developers.facebook.com/apps)
2. Create App (Consumer type)
3. Add "Facebook Login" product
4. Set Valid OAuth Redirect URIs

## Programmatic Access (API Keys)

For automation tools like n8n or Zapier, use API keys instead of cookies:

```bash
# Create an API key via the API (when logged in)
curl -X POST http://localhost:3000/api/v1/auth/api-keys \
  -H "Content-Type: application/json" \
  --cookie "access_token=..." \
  -d '{"name": "My Automation Key"}'

# Use the API key
curl http://localhost:3000/api/v1/templates \
  -H "X-API-Key: vek_abc123..."
```

## Environment Variables

See `.env.example` for all configuration options.

## Docker

```bash
# Development (with hot reload)
docker-compose up

# Production build
docker build -t video-editor-backend .
docker run -p 3000:3000 video-editor-backend
```

## License

MIT
