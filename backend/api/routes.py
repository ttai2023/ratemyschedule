# backend/api/routes.py

from fastapi import FastAPI, HTTPException, Query
from contextlib import asynccontextmanager
import json

from backend.models import (
    init_db, get_cached_professor, save_professor, normalize_name,
)
from backend.scraping.rmp_scraper import scrape_rmp


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/api/professor")
async def get_professor(name: str = Query(..., description="Professor name")):
    """
    Get professor ratings. Checks cache first, scrapes RMP if needed.

    Examples:
        /api/professor?name=Gary+Gillespie
        /api/professor?name=Gillespie,+Gary
    """

    # 1. Check cache
    cached = get_cached_professor(name)
    if cached is not None:
        # Parse the tags JSON string back to a list
        cached["rmp_tags"] = json.loads(cached["rmp_tags"] or "[]")
        cached["source"] = "cache"
        return cached

    # 2. Cache miss — scrape RMP
    rating = await scrape_rmp(name)

    # 3. Save to cache (even if not found, so we don't
    #    re-scrape a nonexistent professor every request)
    save_professor(rating)

    # 4. Return
    return {
        "name": rating.name,
        "name_normalized": normalize_name(rating.name),
        "department": rating.department,
        "rmp_quality": rating.overall_quality,
        "rmp_difficulty": rating.difficulty,
        "rmp_would_take_again": rating.would_take_again,
        "rmp_num_ratings": rating.num_ratings,
        "rmp_tags": rating.top_tags,
        "found": rating.found,
        "error": rating.error,
        "source": "scraped",
    }


@app.get("/api/professors/batch")
async def get_professors_batch(names: str = Query(...)):
    """
    Batch lookup. Comma-separated names.
    Example: /api/professors/batch?names=Gary+Gillespie,Mia+Minnes
    """
    name_list = [n.strip() for n in names.split(",") if n.strip()]

    if len(name_list) > 20:
        raise HTTPException(400, "Max 20 professors per batch request")

    results = []
    for prof_name in name_list:
        # Check cache first for each
        cached = get_cached_professor(prof_name)
        if cached is not None:
            cached["rmp_tags"] = json.loads(cached["rmp_tags"] or "[]")
            cached["source"] = "cache"
            results.append(cached)
        else:
            rating = await scrape_rmp(prof_name)
            save_professor(rating)
            results.append({
                "name": rating.name,
                "rmp_quality": rating.overall_quality,
                "rmp_difficulty": rating.difficulty,
                "rmp_would_take_again": rating.would_take_again,
                "rmp_num_ratings": rating.num_ratings,
                "rmp_tags": rating.top_tags,
                "found": rating.found,
                "source": "scraped",
            })

    return {"professors": results}