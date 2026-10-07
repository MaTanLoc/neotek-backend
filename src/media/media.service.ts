import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

@Injectable()
export class MediaService {
  createUploadSignature() {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const secret = process.env.CLOUDINARY_API_SECRET;
    const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
    if (!cloudName || !apiKey || !secret || !preset) {
      throw new ServiceUnavailableException('Image upload is not configured');
    }
    const params = {
      allowed_formats: 'jpg,jpeg,png,webp,gif,avif',
      overwrite: 'false',
      public_id: `neotek/cms/${randomUUID()}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      upload_preset: preset,
    };
    const serialized = Object.entries(params)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
      apiKey,
      params,
      signature: createHash('sha256')
        .update(serialized + secret)
        .digest('hex'),
    };
  }
}
