import { v2 as cloudinary } from "cloudinary";

let configured = false;

export function configureCloudinary(): void {
  const cloudName = process.env["CLOUDINARY_CLOUD_NAME"];
  const apiKey = process.env["CLOUDINARY_API_KEY"];
  const apiSecret = process.env["CLOUDINARY_API_SECRET"];

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  configured = Boolean(cloudName && apiKey && apiSecret);
}

export function isCloudinaryReady(): boolean {
  if (!configured) configureCloudinary();
  return configured;
}

export { cloudinary };
