# ratemyschedule
An extension to make scheduling classes easier for UCSD students. Auth not included!

## Client-Side

### Responsibilities

- Fetch and parse degree audit data from UCSD DARS
- Manage user course selection and preferences
- Scrape WebReg data directly from authenticated UCSD sessions
- Generate and rank schedule candidates client-side
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
- Resolve eligible courses from requirements + prerequisites
- Generate top schedule options in the popup

## Server-Side

### Responsibilities

- Aggregate professor ratings from RateMyProfessor and CAPE
- Cache Browser Use profile state per PID
- Provide Browser Use automation endpoints (profile setup + planned-class removal)
- Cache and return professor evaluation records

### Capabilities

For Developers:
- Express.js API server with CORS support
- SQLite-backed caching (`browser_use_profiles`, `rmp_evaluations`, `cape_evaluations`)
- Browser Use profile/session orchestration with PID association
- Manual refresh endpoint for professor evaluation cache entries

For Users:
- `/api/browser-use/has-profile?pid=...` - Check if PID has a verified Browser Use profile
- `/api/browser-use/set-profile` - Create/update PID profile and run first login flow
- `/api/browser-use/remove-planned` - Remove planned classes in active WebReg calendar
- `/api/evals/professor?name=...&courseCode=...` - Read cached professor evaluations
- `/api/evals/professor/refresh` - Manual refresh/update for cached evaluations
