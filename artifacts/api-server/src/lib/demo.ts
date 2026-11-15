import { db, projectsTable, generatedClipsTable, campaignsTable, analyticsLogsTable, platformAccountsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

export const sampleClips = [
  { title: "The clutch nobody saw coming", creator: "NOVA", duration: 34, score: 94, hookScore: 96, visualScore: 91, commentaryScore: 94, hook: "One decision. Four opponents. No second chances.", thumbnail: "/images/clip-1.jpg", mode: "commentary" },
  { title: "This changes how you play the game", creator: "SHROUD", duration: 42, score: 91, hookScore: 94, visualScore: 89, commentaryScore: 90, hook: "Watch what happens when he stops following the meta.", thumbnail: "/images/clip-2.jpg", mode: "story" },
  { title: "A perfect run, until this happened", creator: "LUMEN", duration: 28, score: 88, hookScore: 91, visualScore: 86, commentaryScore: 87, hook: "Everything was going perfectly. Then the final frame changed it.", thumbnail: "/images/clip-3.jpg", mode: "bounty" },
];

export async function seedWorkspace(ownerId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ownerId}))`);
    const existing = await tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.ownerId, ownerId)).limit(1);
    // An account remains initialized even after all projects are removed.
    const account = await tx.select({ id: platformAccountsTable.id }).from(platformAccountsTable).where(eq(platformAccountsTable.ownerId, ownerId)).limit(1);
    // Real accounts get connection slots, never example clips, campaigns or activity.
    if (ownerId.startsWith("user:")) {
      if (!account.length) await tx.insert(platformAccountsTable).values(["YouTube Shorts", "TikTok", "Instagram Reels", "X"].map((platform) => ({ ownerId, platform })));
      return;
    }
    if (existing.length || account.length) return;
    const campaigns = await tx.insert(campaignsTable).values([
      { ownerId, name: "Next Level Energy", brand: "PULSE", cpm: 3.5, budget: 5000, views: 148200, affiliateUrl: "https://example.com/pulse", cta: "Explore the sponsor link in our bio. #ad", status: "active", demo: true },
      { ownerId, name: "Built for the win", brand: "HYPERX", cpm: 5, budget: 10000, views: 86400, affiliateUrl: "https://example.com/hyperx", cta: "See the gear in the link in our bio. #ad", status: "active", demo: true },
      { ownerId, name: "Night Drive Sessions", brand: "SOUNDWAVE", cpm: 2.25, budget: 2500, views: 32600, affiliateUrl: "", cta: "Discover the full track. #ad", status: "paused", demo: true },
    ]).returning();
    const [project] = await tx.insert(projectsTable).values({
      ownerId, title: "Weekend highlights • sample batch", sourceUrl: "https://www.youtube.com/watch?v=demo",
      mode: "commentary", clipCount: 3, status: "completed", stage: 5, progress: 100, demo: true,
    }).returning();
    await tx.insert(generatedClipsTable).values(sampleClips.map((clip, index) => ({
      ...clip, ownerId, projectId: project!.id, campaignId: campaigns[index]?.id, demo: true, status: "ready",
      script: "Sample analysis: the key is the timing, not the reaction speed. Notice how the player creates an advantage before committing. Replace this sample with commentary grounded in your authorized footage.",
      hashtags: "#Gaming #Breakdown #Shorts",
      pinnedComment: "What would you have done differently? Share your take below.",
    })));
    await tx.insert(platformAccountsTable).values(["YouTube Shorts", "TikTok", "Instagram Reels", "X"].map((platform) => ({ ownerId, platform })));
    await tx.insert(analyticsLogsTable).values({ ownerId, message: "Example workspace prepared. Demo scores and campaign views are illustrative." });
  });
}

export const trendingSources = [
  { id: 1, title: "Ranked grind. Unranked decisions.", creator: "NOVA", platform: "Twitch", category: "VALORANT", viewers: "42.8K", thumbnail: "/images/clip-1.jpg", url: "https://www.twitch.tv/videos/demo-nova", demo: true },
  { id: 2, title: "The next level of competitive play", creator: "SHROUD", platform: "YouTube", category: "Counter-Strike 2", viewers: "28.4K", thumbnail: "/images/clip-2.jpg", url: "https://www.youtube.com/watch?v=demo-shroud", demo: true },
  { id: 3, title: "One more run. Famous last words.", creator: "LUMEN", platform: "Kick", category: "Just Chatting", viewers: "18.2K", thumbnail: "/images/clip-3.jpg", url: "https://kick.com/lumen-demo", demo: true },
];

export const lessons = [
  { id: 1, title: "Find the moment worth sharing", category: "Sourcing", minutes: 4, content: "Start with footage you own or have written permission to reuse. Look for a clear setup, turning point and payoff. Chat and audio peaks can help find candidates, but always review context. Trending Radar examples are illustrative, not a live discovery feed." },
  { id: 2, title: "Transform, don't just repost", category: "Originality", minutes: 6, content: "Add a specific, evidence-based argument or explanation. Describe what viewers would otherwise miss. Captions, cropping, zoom and AI narration alone do not establish originality, fair use, or monetization eligibility. Check the source license and each platform's current policies. Review every generated script before publishing." },
  { id: 3, title: "Build a strong opening", category: "Production", minutes: 3, content: "Give viewers an accurate reason to watch in the first 2.5 seconds. Keep hook text readable and within safe margins. Verify the narration matches the actual footage. Preview with sound on and off. Never invent events, quotes, reactions, or outcomes." },
  { id: 4, title: "Attach a bounty responsibly", category: "Monetization", minutes: 5, content: "Verify the campaign terms, licensed music territory and permitted platforms. Upload the approved sponsor audio or watermark and choose Bounty mode. Sponsor audio is mixed at 15% volume. Add clear paid-promotion disclosures such as #ad and use platform branded-content tools. Payout estimates equal views / 1,000 × CPM, capped by the entered budget; they are not earnings or guaranteed payments." },
  { id: 5, title: "Review your export package", category: "Quality control", minutes: 4, content: "Review the full rendered MP4, commentary, crop, captions, music rights, disclosures and metadata. The heuristic score is an editing aid, not a platform compliance audit. Demo exports contain metadata only. Production renders target 1080 × 1920 at 60fps. A metadata edit does not automatically re-render an existing video." },
  { id: 6, title: "Plan a sustainable distribution cadence", category: "Distribution", minutes: 5, content: "Choose a channel-specific title and CTA. Save a publishing draft in your local timezone and verify the displayed time. Direct publishing requires approved platform OAuth applications; saved drafts do not post automatically. Export and upload manually until integrations are connected. Confirm current YouTube Partner and TikTok Creator Rewards eligibility in the official platform dashboard; thresholds vary by region and program." },
];
