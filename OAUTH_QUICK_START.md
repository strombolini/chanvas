# Quick Start: Google OAuth with Cornell Gmail

## What Changed

Users can now log in with their Cornell Gmail (@cornell.edu) instead of username/password!

## Setup (5 minutes)

### 1. Get Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/select a project
3. Go to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth client ID**
5. Configure consent screen (first time only):
   - App name: Chanvas
   - Add scopes: email, profile, openid
6. Create OAuth client:
   - Type: Web application
   - Authorized redirect URIs:
     - `http://localhost:8000/login/callback`
     - `http://127.0.0.1:8000/login/callback`
7. Copy Client ID and Client Secret

### 2. Update .env.local

Add these lines to `.env.local`:

```bash
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret-here
```

### 3. Restart Flask

```bash
python3 app.py
```

## How It Works

- Login page now shows "🎓 Sign in with Cornell Gmail" button
- Only @cornell.edu emails are allowed
- User account is auto-created on first login using their NetID
- Extension scraping data is auto-linked to their OAuth account

## For Users

1. Go to `/login`
2. Click "🎓 Sign in with Cornell Gmail"
3. Sign in with Cornell Google account
4. Done! You're logged in.

## Security

- OAuth is more secure than storing passwords
- Users managed by Cornell's Google Workspace
- No password storage in your database
- Automatic email verification through Google

See `OAUTH_SETUP.md` for detailed setup instructions.
