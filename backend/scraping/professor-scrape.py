# backend/scraping/rmp_scraper.py

 browser_use import Agent, Browser, BrowserConfig
from langchain_anthropic import ChatAnthropic
from pydantic import BaseModel
import json

const 
class ProfessorRating(BaseModel):
    """Structured output from the scraper."""
    name: str
    department: str | None = None
    overall_quality: float | None = None      # 1.0 - 5.0
    difficulty: float | None = None           # 1.0 - 5.0
    would_take_again: float | None = None     # 0 - 100 (percentage)
    num_ratings: int = 0
    top_tags: list[str] = []
    found: bool = True
    error: str | None = None


# UCSD's school ID on RMP, base64 of "School-1079"
UCSD_SID = "U2Nob29sLTEwNzk="


async def scrape_rmp(professor_name: str) -> ProfessorRating:
    """
    Use BrowserUse to search RateMyProfessor for a UCSD professor
    and extract their ratings.
    """

    search_url = (
        f"https://www.ratemyprofessors.com/search/professors"
        f"?q={professor_name}&sid={UCSD_SID}"
    )

    task = f"""
    1. Go to this URL: {search_url}
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
         "department": "Computer Science",
         "overall_quality": 4.2,
         "difficulty": 3.1,
         "would_take_again": 85.0,
         "num_ratings": 142,
         "top_tags": ["Caring", "Respected", "Tough grader"],
         "found": true
       }}
    """

    llm = ChatAnthropic(
        model_name="claude-sonnet-4-5",
        temperature=0.0,
    )

    browser = Browser(config=BrowserConfig(headless=True))

    agent = Agent(
        task=task,
        llm=llm,
        browser=browser,
    )

    try:
        result = await agent.run()

        # The agent returns its final message as a string.
        # Parse the JSON from the result.
        result_text = result.final_result()

        # Try to extract JSON from the response
        data = json.loads(result_text)
        return ProfessorRating(**data)

    except json.JSONDecodeError:
        return ProfessorRating(
            name=professor_name,
            found=False,
            error="Failed to parse agent response",
        )
    except Exception as e:
        return ProfessorRating(
            name=professor_name,
            found=False,
            error=str(e),
        )
    finally:
        await browser.close()