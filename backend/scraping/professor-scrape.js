import { BrowserUse } from "browser-use-sdk/v3";
import { z } from "zod";

const Professor = z.object({
  name: z.string(),
  rmp_score: z.number(),
  rmp_difficulty: z.number(),
  rmp_would_take_again: z.number(),
});

const HNPosts = z.object({
  posts: z.array(Post),
});

const client = new BrowserUse();
const result = await client.run(
  "List the top 20 posts on Hacker News today with their points",
  { schema: HNPosts },
);
for (const post of result.output.posts) {
  console.log(`${post.name} (${post.points} pts, ${post.comments} comments)`);
}