# Commis — AI-Powered Restaurant Marketing from a Single Video

## Inspiration

I kept noticing the same thing — small restaurant owners who make incredible food but have terrible websites, or no website at all. They're busy running a kitchen, not learning Squarespace. Agencies charge thousands. Templates all look the same. I wondered what would happen if you could just film a quick walkthrough video of your restaurant and have AI handle the rest. That's basically what Commis tries to do.

## What It Does

You upload a video of your restaurant — just walk around, show the menu, the food, the space. Commis watches it and extracts everything: the restaurant name, full menu with prices, photos, cuisine type, vibe. From that, it generates a website, deploys it live, and then keeps improving it autonomously with A/B testing.

It also cuts cooking clips into YouTube Shorts with AI voiceovers and subtitles, generates social media graphics, recommends Google Ads campaigns, and aggregates customer reviews into actionable digests. There's a voice assistant you can talk to that controls the whole thing. The idea is that a restaurant owner shouldn't have to touch any of this — it just runs.

## How I Built It

The thing that made the biggest difference was using Gemini's native video understanding instead of extracting frames. My first approach pulled individual frames and fed them to the model, which only got maybe 5 menu items per video. Uploading the full video and doing a two-pass analysis with Gemini Pro gets dramatically more — the model understands spatial context, reads signs in the background, picks up on things no single frame contains.

For website generation, I couldn't get good results in one shot, so I built an iterative loop. Gemini Pro generates the HTML, Puppeteer screenshots it, a UI evaluator scores it, and if it's not good enough, specific feedback gets fed back in for another pass. It's not fancy, but it works — the websites actually look decent instead of just being valid HTML.

The A/B testing uses Thompson Sampling, which is a Bayesian approach that handles small traffic volumes better than traditional methods. Most restaurant websites don't get enough visitors for frequentist stats to converge in a reasonable time, so the Bayesian posterior updates help a lot. The system auto-graduates winners at 95% confidence and queues up new experiments on its own.

Everything is wired together through a Model Context Protocol server with 14 tools, so the same capabilities work whether you're using the voice assistant, the web UI, or an AI agent. The backend is Express with sql.js, video processing with FFmpeg and Sharp, and deployment to Cloudflare Pages.

## Challenges

Video extraction quality was the hardest part and the breakthrough moment was realizing frame-based extraction was fundamentally limited. Native video understanding was a different league entirely.

Getting the iterative website generation right required solving a feedback problem — the AI needed to know *why* a site scored poorly, not just that it did. I ended up building a remediation system that maps common failures (broken mobile nav, bad contrast, tiny touch targets) to specific prompts for the next iteration. It's a simple idea but it took a while to get there.

## What I Learned

Honestly, the biggest takeaway is that iterative AI workflows beat one-shot generation by a wide margin. Letting the model critique and retry its own work costs a bit more but produces dramatically better output. I also learned that native video understanding in multimodal models is way more powerful than I expected — it's not just OCR on frames, it actually understands the scene. And Thompson Sampling is kind of magical for small-scale optimization problems. I wish I'd known about it sooner.
