# Chanvas Auto-Scraping v2.0

## Overview
The extension now automatically scrapes Canvas content **directly in your browser** without needing server-side Selenium.

## How It Works

### 1. Login Detection
- When you log into Canvas, `content.js` detects the login success page
- Triggers automated scraping process

### 2. Automated Scraping (`canvas-auto-scraper.js`)
- Opens Canvas pages in background tabs
- Extracts content from:
  - Course list
  - Assignments
  - Modules
  - Syllabus
  - Announcements
  - Grades
- All scraping happens using **your existing Canvas session**
- No credentials needed!

### 3. Data Storage
- All scraped data stored in `chrome.storage.local`
- Data structure:
```javascript
{
  courses: {
    "80462": {
      id: "80462",
      name: "CS 4750 Foundations of Robotics",
      pages: {
        home: { url: "...", content: "...", textLength: 1234 },
        assignments: { url: "...", content: "...", textLength: 5678 },
        // ... more pages
      },
      scrapedAt: 1234567890
    },
    // ... more courses
  },
  lastScraped: 1234567890,
  version: "1.0"
}
```

### 4. Storage Limits
- `chrome.storage.local`: ~10MB per user
- Should handle 5-10 courses comfortably
- If you need more, we can migrate to IndexedDB

## Usage

1. **Install Extension**:
   - Load unpacked from `extension/` directory
   - Grant required permissions

2. **Log into Canvas**:
   - Go to canvas.cornell.edu
   - Log in normally
   - Extension automatically detects and starts scraping

3. **Wait for Completion**:
   - You'll see notifications as scraping progresses
   - Takes ~2-5 minutes depending on number of courses
   - Tabs will open/close in background

4. **View Scraped Data**:
   - Open extension popup
   - Check console for scraped data structure
   - (Chat UI coming next!)

## Key Features

✅ **No Server Required** - Everything runs in your browser
✅ **Uses Your Session** - No username/password needed
✅ **Automatic** - Triggers on login
✅ **Complete** - Scrapes all major Canvas pages
✅ **Local Storage** - Your data stays in your browser
✅ **Scalable** - Each user scrapes their own data

## Next Steps

- [ ] Upload scraped data to OpenAI Files API
- [ ] Create per-user OpenAI Assistant
- [ ] Build chat interface in popup
- [ ] Add manual re-scrape button
- [ ] Add progress indicators during scraping
- [ ] Implement incremental updates (only scrape changed content)

## Architecture Benefits

### vs. Server-Side Selenium:
- ✅ No Chrome crashes
- ✅ No session management issues
- ✅ Scales to unlimited users (each browser scrapes independently)
- ✅ Uses user's actual Canvas session (more reliable)
- ✅ No server resources needed

### Storage Strategy:
- Each user's browser stores their own scraped data
- No centralized database needed
- Perfectly scalable to 1000s of users
- Privacy-friendly (data never leaves user's browser until OpenAI upload)
