import { Controller, Get, Param, Query } from '@nestjs/common';
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
    return this.pagesService.findPublicPage(slug, query);
  }
}
