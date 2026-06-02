import { cloudinary, configureCloudinary, isCloudinaryReady } from "../config/cloudinary.js";

const TRADE_IN_FOLDER = "revivetech/trade-in";
const PROFILE_FOLDER = "revivetech/profile";
const INVENTORY_FOLDER = "revivetech/inventory";

export function isCloudinaryConfigured(): boolean {
  return isCloudinaryReady();
}

export async function uploadImageBuffer(
  buffer: Buffer,
  filename: string,
  folder = TRADE_IN_FOLDER
): Promise<string> {
  configureCloudinary();
  if (!isCloudinaryConfigured()) {
    throw new Error("Image upload is not configured. Set CLOUDINARY_* environment variables.");
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: "image",
        public_id: filename.replace(/\.[^.]+$/, ""),
      },
      (error, result) => {
        if (error || !result?.secure_url) {
          reject(error ?? new Error("Cloudinary upload failed"));
          return;
        }
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

export async function uploadTradeInImages(
  files: { buffer: Buffer; originalname: string }[]
): Promise<string[]> {
  if (!files.length) return [];
  if (!isCloudinaryConfigured()) {
    throw new Error("Image upload is not configured. Set CLOUDINARY_* environment variables.");
  }

  const urls: string[] = [];
  for (const file of files) {
    const url = await uploadImageBuffer(file.buffer, `${Date.now()}-${file.originalname}`, TRADE_IN_FOLDER);
    urls.push(url);
  }
  return urls;
}

export async function uploadInventoryImages(
  files: { buffer: Buffer; originalname: string }[]
): Promise<string[]> {
  if (!files.length) return [];
  if (!isCloudinaryConfigured()) {
    throw new Error("Image upload is not configured. Set CLOUDINARY_* environment variables.");
  }
  const urls: string[] = [];
  for (const file of files) {
    urls.push(await uploadImageBuffer(file.buffer, `${Date.now()}-${file.originalname}`, INVENTORY_FOLDER));
  }
  return urls;
}

export async function uploadProfileAvatar(file: { buffer: Buffer; originalname: string }): Promise<string> {
  if (!isCloudinaryConfigured()) {
    throw new Error("Image upload is not configured. Set CLOUDINARY_* environment variables.");
  }
  return uploadImageBuffer(file.buffer, `${Date.now()}-${file.originalname}`, PROFILE_FOLDER);
}
