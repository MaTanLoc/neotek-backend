import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import { GetPageQueryDto } from './dto/get-page-query.dto';
import { PagesService, PublicPageResponse } from './pages.service';

@Controller('pages')
export class PagesController {
  private readonly pagesService: PagesService;

  constructor(pagesService: PagesService) {
    this.pagesService = pagesService;
  }

  @Get('solution-details')
  listSolutionDetails() {
    return this.pagesService.listSolutionDetails();
  }

  @Get(':slug')
  findPublicPage(
    @Param('slug') slug: string,
    @Query() query: GetPageQueryDto,
  ): Promise<PublicPageResponse> {
    if (
      slug.length > 120 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
      (query.locale !== undefined && !['vi', 'en'].includes(query.locale))
    )
      throw new BadRequestException('Invalid page identity');
    return this.pagesService.findPublicPage(slug, query);
  }
}
