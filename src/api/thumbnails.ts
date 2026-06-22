import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import { pathToFileURL, type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getInMemoryURL } from "./assets";
import path from "path";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const parseData = await req.formData()
  const file = parseData.get("thumbnail")
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const fileSize = file.size
  const MAX_UPLOAD_SIZE = 10 << 20
  if (fileSize > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail size too big!")
  }

  const fileType = file.type
  const bufferedArray = await file.arrayBuffer()
  const buffer = Buffer.from(bufferedArray)
  const base64String = buffer.toString("base64") 
  const base64URL = randomBytes(32).toString("base64url")
  const dataURL = `data:${fileType};base64,${base64String}`

  const uniquePath = `${base64URL}.${fileType}`
  const filePath = path.join(cfg.assetsRoot, uniquePath)
  Bun.write(filePath, file)

  const video = getVideo(cfg.db, videoId)

  if (video?.userID !== userID) {
    throw new UserForbiddenError("Unauthorised!")
  }

  video.thumbnailURL = getInMemoryURL(cfg, uniquePath)
  updateVideo(cfg.db, video)

  return respondWithJSON(200, video);
}
