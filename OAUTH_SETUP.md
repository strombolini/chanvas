# Google OAuth Setup for Cornell Email Login

This guide will help you set up Google OAuth so users can log in with their Cornell Gmail (@cornell.edu).

## Step 1: Create Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services** > **Credentials**
4. Click **Create Credentials** > **OAuth client ID**
5. Configure the OAuth consent screen:
   - User Type: **External** (or Internal if you have a Google Workspace)
   - App name: `Chanvas`
   - User support email: Your Cornell email
   - Developer contact: Your Cornell email
   - Add scopes: `email`, `profile`, `openid`
6. Create OAuth 2.0 Client ID:
   - Application type: **Web application**
   - Name: `Chanvas Web Client`
   - Authorized JavaScript Origins:
     - `http://localhost:8000`
     - `http://127.0.0.1:8000`
     - `https://eljpmfhpaenmdhdecidmppfjpplgoofk.chromiumapp.org` (for Chrome extension)
   - Authorized redirect URIs:
     - `http://localhost:8000/login/callback`
     - `http://127.0.0.1:8000/login/callback`
     - `http://localhost:8000/signup/callback`
     - `http://127.0.0.1:8000/signup/callback`
     - `https://eljpmfhpaenmdhdecidmppfjpplgoofk.chromiumapp.org` (for Chrome extension)
     - (Add your production URLs when deploying)

7. Copy the **Client ID** and **Client Secret**

## Step 2: Update .env File

Add these to your `.env.local` file:

```bash
# Google OAuth
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Flask Secret (generate with: python -c "import secrets; print(secrets.token_hex(32))")
SECRET_KEY=your-generated-secret-key
```

## Step 3: Restrict to Cornell Emails (Optional but Recommended)

The OAuth implementation will automatically restrict logins to `@cornell.edu` emails only. This is configured in the app code.

## Step 4: Update Database Schema

Run this to add the new OAuth fields to the User table:

```bash
python3 -c "from app import Base, engine; Base.metadata.create_all(engine)"
```

## Step 5: Test

1. Start the Flask app: `python3 app.py`
2. Go to `http://localhost:8000/login`
3. Click "Sign in with Google"
4. Use your Cornell Gmail account
5. You should be logged in!

## Production Deployment

When deploying to production:
1. Add your production domain to Authorized redirect URIs in Google Cloud Console
2. Update the redirect URI in your `.env` file
3. Consider setting User Type to **Internal** if using Google Workspace for Cornell

## Troubleshooting

- **Error: redirect_uri_mismatch**: Make sure the redirect URI in Google Cloud Console matches exactly
- **Error: invalid_client**: Check that your Client ID and Secret are correct in `.env`
- **Non-Cornell emails rejected**: This is intentional. Only `@cornell.edu` emails are allowed.
