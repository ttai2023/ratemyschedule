/**
 * @file schedule-scrape.js
 * @description Scrapes the schedule for a certain class from the webreg
 * website, using the local authorization to do so (no server resources needed)
 * 
 * NOTE: This is only used as a fallback if the schedule isn't in the server database,
 * since scraping webreg is slow and resource-intensive. The schedule should be
 * stored in the server database after the first time it's scraped, so subsequent
 * requests can be served from the database.
 * @version 1.0.0
 */


async function scrapeSchedule(courseName, courseCode, termCode) {
  const url = `https://act.ucsd.edu/webreg2/svc/wradapter/secure/search-load-group-data?
    subjcode=${courseCode}&crsecode=${courseCode}&termcode=${termCode}`;
    const response = await fetch(url)
    const j = await response.json();
}



export { scrapeSchedule };