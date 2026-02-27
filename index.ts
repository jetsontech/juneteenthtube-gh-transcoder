import { createClient } from "@supabase/supabase-js";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { spawn } from "child_process";
import { mkdir, rm } from "fs/promises";
import { createWriteStream, readFileSync, existsSync, createReadStream } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { Readable } from "stream";
import * as dotenv from "dotenv";
import ffmpegStatic from "ffmpeg-static";

dotenv.config();

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
);

const sanitizeEnv = (val?: string) => val ? val.replace(/^['"]+|['"]+$/g, '').trim().replace(/[\n\r]/g, '') : undefined;
const isValidRegion = (r?: string) => r && /^[a-z0-9-]+$/.test(r);
const regionEnv = sanitizeEnv(process.env.S3_REGION);
const region = (isValidRegion(regionEnv) && regionEnv !== "auto") ? regionEnv : "us-east-1";

const rawEndpoint = process.env.S3_ENDPOINT || "";
const urlMatch = rawEndpoint.match(/https?:\/\/[a-zA-Z0-9.-]+\.cloudflarestorage\.com/);
const cleanEndpoint = urlMatch ? urlMatch[0] : undefined;

const S3 = new S3Client({
    region,
    endpoint: cleanEndpoint,
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID?.replace(/[^a-zA-Z0-9]/g, '') || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.replace(/[^a-zA-Z0-9]/g, '') || ""
    }
});

const getPublicUrl = (key: string) => {
    if (process.env.S3_PUBLIC_DOMAIN) {
        return `${process.env.S3_PUBLIC_DOMAIN}/${key}`;
    }
    const endpoint = cleanEndpoint || "";
    const cleanedRoute = endpoint.replace(/\/$/, "");
    return `${cleanedRoute}/${process.env.S3_BUCKET_NAME}/${key}`;
};

async function processVideo(videoId: string) {
    console.log(`\n--- [${videoId}] START TRANSCODE JOB ---`);

    const { data: video, error } = await supabase.from("videos").select("*").eq("id", videoId).single();
    if (error || !video) {
        throw new Error(`Could not find video ${videoId} in database`);
    }

    const sourceUrl = video.video_url;
    if (!sourceUrl) {
        throw new Error(`Video ${videoId} has no video_url`);
    }

    const sourceKey = sourceUrl.split("/").pop();
    if (!sourceKey) {
        throw new Error("Could not extract source key from URL");
    }

    const tempDir = join(tmpdir(), "transcode-" + randomUUID());
    const inputPath = join(tempDir, "input_video");
    const outputPath = join(tempDir, "output.mp4");
    const thumbPath = join(tempDir, "thumb.jpg");

    try {
        // 1. Mark as processing
        await supabase.from("videos").update({ transcode_status: "processing" }).eq("id", videoId);
        await mkdir(tempDir, { recursive: true });

        console.log(`-> Downloading ${sourceKey} from R2...`);
        const response = await S3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET_NAME!, Key: sourceKey }));
        if (!response.Body) throw new Error("S3 response body is empty");

        await new Promise<void>((res, rej) => {
            const ws = createWriteStream(inputPath);
            (response.Body as Readable).pipe(ws).on("finish", () => res()).on("error", rej);
        });

        // 2. Transcode
        console.log(`-> Transcoding to target format...`);
        const ffmpegPath = ffmpegStatic || 'ffmpeg';

        await new Promise<void>((resolve) => {
            const thumbProc = spawn(ffmpegPath, [
                "-i", inputPath, "-ss", "00:00:01", "-vframes", "1",
                "-vf", "scale=640:-1", "-q:v", "2", "-y", thumbPath
            ]);
            thumbProc.on('close', () => resolve());
            thumbProc.on('error', () => resolve());
        });

        await new Promise<void>((resolve, reject) => {
            const ffmpeg = spawn(ffmpegPath, [
                "-i", inputPath,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-preset", "veryfast", "-crf", "28",
                "-vf", "scale='min(1280,iw)':-2",
                "-c:a", "aac", "-ac", "2", "-b:a", "128k",
                "-y", outputPath
            ], { stdio: 'inherit' });

            ffmpeg.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`FFMPEG failed with exit code ${code}`));
            });
            ffmpeg.on("error", reject);
        });

        // 3. Upload Results
        console.log(`-> Uploading mp4 & thumbnail to R2...`);
        const baseKey = sourceKey.replace(/\.[^/.]+$/, "");
        const h264Key = `${baseKey}_h264.mp4`;
        const thumbKey = `${baseKey}_thumb.jpg`;

        const uploads = [];
        uploads.push(
            S3.send(new PutObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME, Key: h264Key,
                Body: createReadStream(outputPath), ContentType: "video/mp4"
            }))
        );

        let thumbPublicUrl: string | null = null;
        if (existsSync(thumbPath)) {
            uploads.push(
                S3.send(new PutObjectCommand({
                    Bucket: process.env.S3_BUCKET_NAME, Key: thumbKey,
                    Body: createReadStream(thumbPath), ContentType: "image/jpeg"
                })).then(() => { thumbPublicUrl = getPublicUrl(thumbKey); })
            );
        }

        await Promise.all(uploads);

        console.log(`-> Updating Supabase record...`);
        const h264PublicUrl = getPublicUrl(h264Key);
        const updatePayload: any = {
            video_url_h264: h264PublicUrl,
            transcode_status: "completed"
        };
        if (thumbPublicUrl) updatePayload.thumbnail_url = thumbPublicUrl;

        const { error: dbError } = await supabase.from("videos").update(updatePayload).eq("id", videoId);
        if (dbError) throw dbError;

        console.log(`--- [${videoId}] SUCCESS ---`);

    } catch (err) {
        console.error(`--- [${videoId}] FATAL ERROR:`, err);
        await supabase.from("videos").update({ transcode_status: "failed" }).eq("id", videoId);
        throw err;
    } finally {
        try { await rm(tempDir, { recursive: true, force: true }); } catch (cleanupError) { }
    }
}

const videoId = process.env.VIDEO_ID;
if (!videoId) {
    console.error("No VIDEO_ID environment variable provided.");
    process.exit(1);
}

processVideo(videoId).then(() => {
    process.exit(0);
}).catch((err) => {
    console.error("Transcoder failed:", err);
    process.exit(1);
});
