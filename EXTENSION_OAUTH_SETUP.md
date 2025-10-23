# Chrome Extension OAuth Setup

## Overview

Users can now sign in directly in the Chrome extension with their Cornell Gmail, and all their scraped data is automatically linked to their account!

## Setup Steps

### 1. Update manifest.json with your Client ID

In `extension/manifest.json`, replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "openid",
    "email",
    "profile"
  ]
}
```

**Important**: Use the SAME Client ID as your web app!

### 2. Add Extension ID to Google Cloud Console

1. Load your extension in Chrome (chrome://extensions → Developer mode → Load unpacked)
2. Copy the **Extension ID** (looks like: `abcdefghijklmnopqrstuvwxyz123456`)
3. Go to [Google Cloud Console](https://console.cloud.google.com/)
4. Navigate to **APIs & Services** → **Credentials**
5. Click on your OAuth 2.0 Client ID
6. Under **Authorized redirect URIs**, add:
   ```
   https://YOUR_EXTENSION_ID.chromiumapp.org/
   ```
   Replace `YOUR_EXTENSION_ID` with your actual extension ID

### 3. Get the Extension Key (for consistent ID)

To keep the same extension ID across installs:

1. In `chrome://extensions`, find your extension
2. Click "Pack extension"
3. Select your extension directory
4. This creates a `.pem` file - **save this securely!**
5. Extract the `key` from the generated `.crx` file and add to manifest.json

**OR** for development, just use the extension ID you already have.

## How It Works

### For Users:

1. **Install Extension** → User installs from Chrome Web Store (or loads unpacked)
2. **Open Popup** → Click extension icon
3. **Sign In** → Click "🎓 Sign in with Cornell Gmail"
4. **Google OAuth** → Signs in with Cornell account
5. **Auto-scrape** → Extension automatically scrapes when user logs into Canvas
6. **Data linked** → All scraped data is linked to their email/account automatically!

### Behind the Scenes:

1. Extension uses `chrome.identity.getAuthToken()` to get Google OAuth token
2. Fetches user info from Google (email, name)
3. Checks that email ends with `@cornell.edu`
4. Stores user email in `chrome.storage.sync`
5. When scraping, sends `user_email` to backend
6. Backend finds/creates user by email and stores data under their account
7. No more temp user IDs! Everything is linked properly.

## Benefits

- ✅ **No manual linking** - Data automatically goes to the right account
- ✅ **Secure** - Uses Google OAuth, no passwords stored
- ✅ **Cornell-only** - Automatically restricts to @cornell.edu
- ✅ **Multi-device** - User signs in once per device
- ✅ **No `make fix-user` needed** - Everything works automatically!

## Testing

1. Clear your extension data: `chrome.storage.sync.clear()` in console
2. Open extension popup
3. Click "Sign in with Cornell Gmail"
4. Sign in with test Cornell account
5. Go to Canvas and log in
6. Extension should scrape automatically
7. Check backend: `make courses` - should show courses under your real user ID

## Deployment

### For Other Users:

1. **Publish to Chrome Web Store** (recommended)
   - Users install from store
   - Extension auto-updates
   - Consistent extension ID

2. **Or Share .crx file**
   - Pack extension with your .pem key
   - Users install .crx file
   - Need to manually update

3. **Or Load Unpacked** (dev only)
   - Share source code
   - Users load unpacked in developer mode
   - Extension ID changes per install

### OAuth Consent Screen:

- For testing: Add users manually (limit 100)
- For production: Publish OAuth consent screen (Google review required)
- For Cornell-wide: Use Internal mode if in Google Workspace

## Troubleshooting

**Error: "OAuth2 not granted or revoked"**
- Make sure redirect URI is added in Google Cloud Console
- Use exact extension ID in redirect URI

**Error: "Please use a Cornell email"**
- User tried non-Cornell email
- Only @cornell.edu emails are allowed

**Data not linking to account:**
- Check that extension is sending `user_email` in upload request
- Check backend logs: should show "Found OAuth user for email..."
- Verify user exists: `make docs` to see user IDs

**Extension ID keeps changing:**
- Create a .pem key file when packing extension
- Use same .pem file every time
- Or publish to Chrome Web Store for stable ID
