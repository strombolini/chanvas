# Chanvas Auto-Scraper Browser Extension

This browser extension automatically detects when you successfully log into Canvas and triggers course scraping in the Chanvas system.

## Features

- **Automatic Detection**: Detects Canvas login success URL (`https://canvas.cornell.edu/?login_success=1`)
- **Session Capture**: Extracts Canvas session cookies for authentication
- **Seamless Integration**: Automatically sends session data to Chanvas backend
- **User Notifications**: Shows in-page notifications about scraping status

## Installation

1. **Build the Extension**:
   - Navigate to the `extension/` directory
   - No build process needed - it's ready to load

2. **Load in Chrome**:
   - Open Chrome and go to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked" and select the `extension/` directory

3. **Configure**:
   - Click the extension icon in the toolbar
   - Set your Chanvas server URL (default: `http://localhost:5000`)
   - Click "Save Settings"

## Usage

1. **Install and configure** the extension (see above)
2. **Log into Canvas normally** at `canvas.cornell.edu`
3. **Extension automatically detects** successful login
4. **Session data is sent** to Chanvas backend
5. **Scraping begins automatically** - check Chanvas dashboard for progress

## Configuration

- **Chanvas Server URL**: Set this to your Chanvas instance URL
- **Test Connection**: Verify the extension can reach your Chanvas server

## How It Works

1. **Content Script**: Monitors Canvas pages for login success
2. **Cookie Extraction**: Captures Canvas session cookies via background script
3. **API Communication**: Sends session data to Chanvas `/api/session-login` endpoint
4. **Automatic Scraping**: Chanvas uses session cookies to scrape course content

## Development

### Files Structure
- `manifest.json`: Extension configuration
- `content.js`: Detects login and handles notifications
- `background.js`: Handles cookie extraction
- `popup.html/js`: Configuration interface

### API Endpoints
- `GET /api/health`: Health check
- `POST /api/session-login`: Receive session cookies and start scraping

## Current Status

⚠️ **Beta Feature**: Cookie-based scraping is implemented in the backend but requires modifications to `canvas_scraper.py` to fully work with session cookies instead of username/password authentication.

## Next Steps

1. Modify `canvas_scraper.py` to accept and use session cookies
2. Add proper user identification (currently uses session hash)
3. Implement cookie refresh/rotation for long-term sessions
4. Add better error handling and retry logic