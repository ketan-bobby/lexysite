/**
 * Server-side image client for the OpenAI AI integration.
 * Resolves credentials via shared/openai-config (managed proxy pair, or
 * OPENAI_API_KEY fallback; fails fast at import time if neither is set), then wraps
 * gpt-image-1 for generating (generateImageBuffer) and editing/compositing (editImages).
 */
import fs from "node:fs";
import OpenAI, { toFile } from "openai";
import { Buffer } from "node:buffer";

import { getOpenAIConfig } from "../shared/openai-config";

const { apiKey, baseURL } = getOpenAIConfig();

export const openai = new OpenAI({ apiKey, baseURL });

export async function generateImageBuffer(
  prompt: string,
  size: "1024x1024" | "512x512" | "256x256" = "1024x1024"
): Promise<Buffer> {
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size,
  });
  const base64 = response.data?.[0]?.b64_json ?? "";
  return Buffer.from(base64, "base64");
}

export async function editImages(
  imageFiles: string[],
  prompt: string,
  outputPath?: string
): Promise<Buffer> {
  const images = await Promise.all(
    imageFiles.map((file) =>
      toFile(fs.createReadStream(file), file, {
        type: "image/png",
      })
    )
  );

  const response = await openai.images.edit({
    model: "gpt-image-1",
    image: images,
    prompt,
  });

  const imageBase64 = response.data?.[0]?.b64_json ?? "";
  const imageBytes = Buffer.from(imageBase64, "base64");

  if (outputPath) {
    fs.writeFileSync(outputPath, imageBytes);
  }

  return imageBytes;
}
