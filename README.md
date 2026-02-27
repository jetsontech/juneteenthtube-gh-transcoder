# JuneteenthTube GitHub Action Transcoder

This repository contains the video transcoding worker for JuneteenthTube. It runs entirely on **GitHub Actions**, providing unlimited free parallel compute for processing user video uploads.

## How It Works
1. A user uploads a video on your website, which is saved directly to your Cloudflare R2 bucket.
2. The website (Vercel) sends a `repository_dispatch` webhook to this GitHub repository containing the new `videoId`.
3. GitHub Actions instantly spins up a runner, downloads the raw video from R2, runs FFmpeg to compress/format it, and uploads the optimized video back to R2.
4. The script updates your Supabase database to mark the video as "completed", making it instantly playable on your site.

## Setup Instructions

### 1. Push to GitHub
Create a new **Public** repository on your GitHub account (a public repo allows unlimited free GitHub Actions minutes). Then push this code to it:

```bash
cd juneteenthtube-gh-transcoder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

### 2. Configure GitHub Secrets
For this transcoder to securely access your database and storage, you need to add your API keys to the repository's secrets.

Go to your repository on GitHub -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.

Add the following exactly as they appear in your Vercel/main project `.env.local`:
- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (Warning: ensure this is the SERVICE ROLE key so it can update records)
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` (e.g. `https://<account-id>.r2.cloudflarestorage.com`)
- `R2_BUCKET_NAME` 
- `R2_PUBLIC_DOMAIN` (Your custom domain or R2 dev dev domain, without a trailing slash)

### 3. Update Your Vercel Website
To trigger this action, your main website needs to send a request to GitHub after a user uploads a video. You'll need to generate a **GitHub Personal Access Token (Classic)** with the `repo` scope to allow your website to trigger the action.

Add this token to your main Vercel project's `.env.local` as `GITHUB_DISPATCH_TOKEN`.
