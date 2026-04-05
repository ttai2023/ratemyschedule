import { BrowserUse } from "browser-use-sdk/v3";
import { z } from "zod";

// --------------------- RATEMYPROFESSOR SCRAPER ---------------------

const RMP_Professor = z.object({
  name: z.string(),
  department: z.string().optional(),
  overall_quality: z.number(),
  difficulty: z.number(),
  would_take_again: z.number(),
  num_ratings: z.number().int(),
  average_grade: z.string().optional(),
  average_hours_per_week: z.number().optional(),
  tags: z.array(z.string()),
  found: z.boolean(),
  error: z.string().optional(),
});

const RMP_ProfessorData = z.object({
  professors: z.array(RMP_Professor),
});

const client = new BrowserUse();
const UCSD_SID = "U2Nob29sLTEwNzk=";

async function srapeProfessors(professorObjects) {
  const task = `
  We are scraping professors from RateMyProfessors.com for a list of professor names. 
  Here is your list of comma-separated professor names, and their departments if known: ${professorObjects.map(p => `${p.name} (${p.department ?? "unknown department"})`).join(", ")}.
  For each professor name, do the following:
  1. The URLs for every single professor query should be in this format: https://www.ratemyprofessors.com/search/professors?q=[Professor Name]&sid=${UCSD_SID}. This query is modified to only return professors from UCSD. For example, if the professor name is "Gary Gillespie", the URL would be https://www.ratemyprofessors.com/search/professors?q=Gary%20Gillespie&sid=${UCSD_SID}.
  2. For each professor name in the input list, go to the corresponding URL and look at the search results:
     - If NO professors are listed, return:
       { "found": false, "name": "[Professor Name]", "error": "not found" }
     - If there are results, click on the professor whose name best matches the query.
       - If there are multiple matches, prefer the one in a relevant department with the most ratings.
  3. On the professor's profile page, extract:
     - Their full name as displayed
      - Their department
      - Overall quality rating (the big number, 1-5 scale)
      - Difficulty rating (1-5 scale)
      - "Would take again" percentage
      - Number of ratings
      - The top tags shown (e.g. "Tough grader", "Get ready to read",
        "Gives good feedback", etc.) — up to 5 tags
  4. Return the data as a JSON object with these exact keys:
      name, department, overall_quality, difficulty,
      would_take_again, num_ratings, tags, found

      Example:
      {
        "name": "Gary Gillespie",
        "department": "Computer Science",
        "overall_quality": 4.2,
        "difficulty": 3.1,
        "would_take_again": 85.0,
        "num_ratings": 142,
        "tags": ["Caring", "Respected", "Tough grader"],
        "found": true,
        "error": null
      }
  `

  // init new browser-use session
  const result = await client.run(
    task,
    { schema: RMP_ProfessorData },
  );
  return result.output.professors;
};


// --------------------- END OF RATEMYPROFESSOR SCRAPER ---------------------



// --------------------- CAPE SCRAPER (NEEDS AUTH) ---------------------

