import { PageCacheInvalidationService } from './page-cache-invalidation.service';

describe('PageCacheInvalidationService', () => {
  it('deletes only requested locale keys', async () => {
    const cache = { del: jest.fn().mockResolvedValue(undefined) };
    const service = new PageCacheInvalidationService(cache as never);

    await service.invalidatePageLocale('home', 'vi');

    expect(cache.del).toHaveBeenCalledWith('cms:page:home:vi');
  });

  it('continues successfully when Redis deletion fails', async () => {
    const cache = { del: jest.fn().mockRejectedValue(new Error('Redis down')) };
    const service = new PageCacheInvalidationService(cache as never);

    await expect(
      service.invalidatePageLocales('home', ['vi', 'en']),
    ).resolves.toBeUndefined();
    expect(cache.del).toHaveBeenCalledTimes(2);
  });
});
