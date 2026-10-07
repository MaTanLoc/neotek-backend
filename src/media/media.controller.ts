import { Controller, Header, Post, UseGuards } from '@nestjs/common';
import { SessionAuthGuard } from '../auth/session-auth.guard';
import { CsrfGuard } from '../auth/csrf.guard';
import { OriginGuard } from '../auth/origin.guard';
import { MediaService } from './media.service';

@Controller('admin/media')
@UseGuards(SessionAuthGuard, CsrfGuard, OriginGuard)
export class MediaController {
  private readonly media: MediaService;
  constructor(media: MediaService) {
    this.media = media;
  }

  @Post('upload-signature')
  @Header('Cache-Control', 'no-store')
  signUpload() {
    return this.media.createUploadSignature();
  }
}
