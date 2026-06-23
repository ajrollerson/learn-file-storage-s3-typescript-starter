import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { BadRequestError, UserForbiddenError } from "./errors";
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { getVideo } from "../db/videos";
import { unlinkSync } from "fs"
import { updateVideo } from "../db/videos";
import path from "path";
import { rm } from "fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30;

  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
      throw new BadRequestError("Invalid video ID");
    }
  
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);

  if (video?.userID !== userID) {
      throw new UserForbiddenError("Unauthorised!")
    }

  const parseData = await req.formData()
  const videoFile = parseData.get("video")

  if (!(videoFile instanceof File)) {
      throw new BadRequestError("Data invalid!");
    }

  const fileSize = videoFile.size
  if (fileSize > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video size too big!")
  }

  if (videoFile.type !== "video/mp4") {
    throw new BadRequestError("Video in invalid format!")
  }

  const fileKey = `${videoId}.mp4`
  const filePath = path.join("/tmp", fileKey)
  await Bun.write(filePath, videoFile)
  

  const aspectRatio = await getVideoAspectRatio(filePath)
  const newFilePath = await processVideoForFastStart(filePath)

  const s3fileKey = `${aspectRatio}/${fileKey}`

  await cfg.s3Client.file(s3fileKey, { type: videoFile.type }).write(Bun.file(newFilePath))

  await Promise.all([
  rm(filePath, { force: true }),
  rm(newFilePath, { force: true }),
]);

  video.videoURL = `https://${cfg.s3CfDistribution}/${s3fileKey}`
  updateVideo(cfg.db, video)

  return respondWithJSON(200, null);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath], {
  stdout: "pipe",
  stderr: "pipe",
});

const stdoutText = await new Response(proc.stdout).text();
const stderrText = await new Response(proc.stderr).text();

const exitCode = await proc.exited;

if (exitCode !== 0) {
  throw new Error(`Command failed: ${stderrText}`);
}

const result = JSON.parse(stdoutText);
const { width, height } = result.streams[0];

if (width === Math.floor(16 * (height / 9))) {
  return "landscape";
} else if (height === Math.floor(16 * (width / 9))) {
  return "portrait";
} else {
  return "other";
}
}

export async function processVideoForFastStart(filePath: string) {
const newFilePath = `${filePath}.processed`
  const proc = Bun.spawn(["ffmpeg", "-i", filePath, "-movflags", "faststart", "-map_metadata", "0", "-codec", "copy", "-f", "mp4", newFilePath], {
  stdout: "pipe",
  stderr: "pipe",
});

const stderrText = await new Response(proc.stderr).text();

const exitCode = await proc.exited;

if (exitCode !== 0) {
  throw new Error(`Command failed: ${stderrText}`);
}

return newFilePath

}

