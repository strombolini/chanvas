# Extension OAuth Setup - Standalone (No Backend Required)

The extension now uses `chrome.identity` API for OAuth, making it completely standalone without any backend dependency.

## Prerequisites

You need a Google Cloud OAuth client ID to enable Cornell Gmail login.

## Step 1: Get Your Extension ID

1. Go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Load your extension if not already loaded
4. Copy the **Extension ID** (looks like: `abcdefghijklmnopqrstuvwxyz123456`)
5. **Important**: Keep this ID - you'll need it for OAuth configuration

## Step 2: Create Google Cloud OAuth Client

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing one
3. Navigate to **APIs & Services** > **Credentials**
4. Click **+ CREATE CREDENTIALS** > **OAuth client ID**
5. If prompted, configure the OAuth consent screen:
   - User Type: **Internal** (if you have Google Workspace) or **External**
   - App name: `Chanvas Extension`
   - User support email: Your email
   - Developer contact: Your email
   - Scopes: Add `userinfo.email` and `userinfo.profile`
   - Test users: Add your Cornell email if using External

6. Create OAuth Client ID:
   - Application type: **Chrome Extension**
   - Name: `Chanvas Extension`
   - **Application ID**: Paste your extension ID from Step 1

7. Click **Create**
8. Copy the **Client ID** (looks like: `123456789.apps.googleusercontent.com`)

## Step 3: Configure Extension

1. Open `/Users/Ganes/chanvas/extension/manifest.json`

2. Replace the `oauth2.client_id` with your actual Client ID:
```json
"oauth2": {
  "client_id": "YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com",
  "scopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile"
  ]
}
```

3. Get your extension's public key:
   - Go to `chrome://extensions/`
   - Click "Pack extension"
   - Select extension root folder
   - It will generate a `.pem` file and show you the public key
   - Copy the public key

4. Replace the `key` field in manifest.json:
```json
"key": "YOUR_ACTUAL_EXTENSION_PUBLIC_KEY"
```

**Note**: The `key` field ensures your extension ID remains constant across reloads, which is required for OAuth.

## Step 4: Reload Extension

1. Go to `chrome://extensions/`
2. Click the reload button for Chanvas Extension
3. Verify the Extension ID hasn't changed (should match what you configured in Google Cloud)

## Step 5: Test OAuth

1. Click the extension icon
2. You should see "Not Signed In" status
3. Click "🎓 Sign in with Cornell Gmail"
4. Google OAuth screen should appear
5. Sign in with your Cornell (@cornell.edu) email
6. Grant permissions
7. You should see "✓ Signed In" with your name/email

## Troubleshooting

### Error: "OAuth2 not granted or revoked"
- Make sure the `client_id` in manifest.json matches exactly what's in Google Cloud Console
- Verify your extension ID matches the Application ID in Google Cloud
- Check that the `key` field in manifest.json is correct

### Error: "Only Cornell emails allowed"
- The extension only accepts emails ending with `@cornell.edu`
- Make sure you're signing in with your Cornell Gmail account

### OAuth popup doesn't appear
- Check the browser console for errors
- Verify `identity` and `identity.email` permissions are in manifest
- Make sure Google OAuth consent screen is properly configured

### Extension ID keeps changing
- You need to add the `key` field to manifest.json
- Generate a `.pem` file by packing the extension
- Extract the public key and add it to manifest

## For Development

If you're actively developing and the extension ID keeps changing:

1. Pack the extension once to generate a `.pem` file
2. Keep the `.pem` file safe
3. Add the public key to manifest.json
4. This locks the extension ID permanently

## Security Notes

- The OAuth token is stored locally in `chrome.storage.local`
- No backend server has access to the token
- Token is validated on each popup open
- Logout clears all local auth data and revokes the cached token
