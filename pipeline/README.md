# pipeline/

Video render stage of the WhopClip automation.

## v1 (this skeleton)
`render.py` is a dry-run stub: it prints the ffmpeg/yt-dlp commands it *would*
run. Function signatures (`download`, `cut_916`, `burn_captions`) are the
contract the orchestrator will call.

## v2 (to build)
- Real downloads via yt-dlp (with the egress-proxy TLS flags used on this VM).
- 1080x1920 crop/scale, loudness normalization, faststart MP4.
- Karaoke captions burned with libass, honoring safe zones:
  - hook/title starts ≥10% below the top edge
  - captions at/above ~78% height (IG UI covers bottom ~20% + right ~15%)
- Caption text/styles driven by per-campaign requirements.

## Full automation loop (target)
1. Server picks a Content Rewards campaign (joined or join it).
2. Server reads campaign requirements (video source, caption template, hashtags).
3. Pipeline downloads the influencer asset, edits to 9:16 per requirements.
4. Server enqueues an `ig_post` job → phone posts via WebView → returns post URL.
5. Server enqueues a `whop_submit` job → phone submits the IG link to the campaign.
