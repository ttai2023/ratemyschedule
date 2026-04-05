# ratemyschedule
An extension to make scheduling classes easier for UCSD students. Auth not included!

## Client-Side

### Responsibilities

- Fetch and parse degree audit data from UCSD DARS
- Manage user course selection and preferences
- Communicate with the backend server for schedule generation
- Handle UCSD authentication session management
- Cache degree audit data locally for offline access

### Capabilities

For Developers:
- Fetches degree audit via content script injection into act.ucsd.edu tabs
- Parses DARS HTML into structured JSON (requirements, subrequirements, completed courses)
- Caches parsed audit in chrome.storage.local with localStorage fallback
- Handles auth recovery by opening DARS pages to refresh stale sessions
- Exposes `getDegreeAuditJson()` and `sendToRemote()` APIs for extension integration
- Uses main-world script injection and content bridge fallbacks for credential propagation

For Users:
- View degree audit summary (completed courses, requirements status, GPA, units)
- Automatically load the most recent completed audit
- Request new degree audits on demand
- See which courses fulfill requirements
- Send audit data to remote server for schedule recommendations

## Server-Side

### Responsibilities

- Aggregate professor ratings from RateMyProfessor and CAPE
- Generate non-conflicting schedule combinations from course sections
- Score and rank schedules based on user-defined preferences
- Provide course and section data via API endpoints
- Recommend enrollment pass strategies (First Pass vs Second Pass)

### Capabilities

For Developers:
- Express.js API server with CORS support
- Loads schedule data into memory for O(1) course lookups
- WebReg scraper module for fetching schedule data from UCSD
- BrowserUse SDK integration for RateMyProfessor scraping
- Linked section handling (lecture + discussion/lab bundles)
- Conflict detection across meeting times and days

For Users:
- `/api/course` - Get all sections for a course
- `/api/department` - Get all courses in a department
- `/api/search` - Search courses by partial match
- `/api/sections` - Batch lookup sections for multiple courses
- `/api/generate` - Generate schedule candidates with custom weights
- `/api/recommend` - Get top-N ranked schedules with pass recommendations
- `/api/rank` - Re-rank existing schedule candidates with updated weights

Schedule scoring criteria (each normalized 0-100):
- Professor quality (RMP + CAPE blend)
- Time-of-day preference (preferred window, hard limits)
- Final exam spread (min gap, crunch penalty)
- Day pattern preference (MWF, TuTh, minimize days)
- Difficulty/workload balance (CAPE hours per week)