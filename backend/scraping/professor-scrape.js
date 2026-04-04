import { BrowserUse } from "browser-use-sdk/v3";
import { z } from "zod";

const Professor = z.object({
  name: z.string(),
  rmp_course_code: z.string().optional(),
  rmp_score: z.number(),
  rmp_difficulty: z.number(),
  rmp_would_take_again: z.number(),
  rmp_average_grade: z.string().optional(),
  rmp_average_hours_per_week: z.number().optional(),
  rmp_tags: z.array(z.string()),
  found: z.boolean(),
  error: z.string().optional(),
});

const ProfessorData = z.object({
  professors: z.array(Professor),
});

const client = new BrowserUse();
const UCSD_SID = "U2Nob29sLTEwNzk=" 

const search_url = (
        "https://www.ratemyprofessors.com/search/professors"
        `?q=${professor_name}&sid=${UCSD_SID}`)

    task = `
    1. Go to this URL: ${search_url}
    2. This is a RateMyProfessor search filtered to UC San Diego.

    3. Look at the search results:
       - If NO professors are listed, return:
         {{"found": false, "name": "{professor_name}", "error": "not found"}}
       - If there are results, click on the professor whose name
         best matches "{professor_name}".
       - If there are multiple matches, prefer the one in a relevant
         department with the most ratings.

    4. On the professor's profile page, extract:
       - Their full name as displayed
       - Their department
       - Overall quality rating (the big number, 1-5 scale)
       - Difficulty rating (1-5 scale)
       - "Would take again" percentage
       - Number of ratings
       - The top tags shown (e.g. "Tough grader", "Get ready to read",
         "Gives good feedback", etc.) — up to 5 tags

    5. Return the data as a JSON object with these exact keys:
       name, department, overall_quality, difficulty,
       would_take_again, num_ratings, top_tags, found

       Example:
       {{
         "name": "Gary Gillespie",
         "course_code": "CSE 100",
         "overall_quality": 4.2,
         "difficulty": 3.1,
         "would_take_again": 85.0,
         "average_grade": "B+",
         "average_hours_per_week": 5.0,
         "tags": ["Caring", "Respected", "Tough grader"],
         "found": true
         "error": null
       }}
    `

const result = await client.run(
  task,
  { schema: ProfessorData },
);
for (const professor of result.output.professors) {
  console.log(`${professor.name} (${professor.overall_quality} pts, ${professor.num_ratings} ratings)`);
}