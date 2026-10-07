import { createHash } from 'node:crypto';
import { MediaService } from './media.service';

describe('MediaService', () => {
  it('signs fixed upload parameters without disclosing the API secret', () => {
    const names = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
      'CLOUDINARY_UPLOAD_PRESET',
    ];
    const previous = names.map((name) => process.env[name]);
    try {
      names.forEach((name, index) => {
        process.env[name] = [
          'test-cloud',
          'test-key',
          'test-secret',
          'signed-cms',
        ][index];
      });
      const result = new MediaService().createUploadSignature();
      expect(result.uploadUrl).toBe(
        'https://api.cloudinary.com/v1_1/test-cloud/image/upload',
      );
      expect(result.params.overwrite).toBe('false');
      expect(result.params.public_id).toMatch(/^neotek\/cms\/[a-f0-9-]+$/);
      expect(result.params.allowed_formats).not.toContain('svg');
      const input = Object.entries(result.params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
      expect(result.signature).toBe(
        createHash('sha256')
          .update(input + 'test-secret')
          .digest('hex'),
      );
      expect(JSON.stringify(result)).not.toContain('test-secret');
      delete process.env.CLOUDINARY_API_SECRET;
      expect(() => new MediaService().createUploadSignature()).toThrow(
        'Image upload is not configured',
      );
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });
});
