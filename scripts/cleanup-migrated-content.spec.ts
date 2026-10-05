import {
  getAffectedCacheKeys,
  planCleanup,
} from './cleanup-migrated-content';

describe('migrated content cleanup planning', () => {
  it('does not plan a database write for clean content', () => {
    const records = [
      {
        page: 'home',
        locale: 'vi',
        section: 'faq',
        sectionType: 'faq',
        content: { items: [{ answer: '<p>Đáp án</p>' }] },
      },
    ];

    expect(planCleanup(records)).toEqual([]);
  });

  it('targets only changed page and locale cache keys', () => {
    const changes = [
      {
        page: 'home',
        locale: 'vi',
        section: 'faq',
        sectionType: 'faq',
        content: {},
        normalized: {},
        valueCount: 1,
      },
      {
        page: 'home',
        locale: 'vi',
        section: 'cta',
        sectionType: 'cta',
        content: {},
        normalized: {},
        valueCount: 1,
      },
      {
        page: 'solutions',
        locale: 'en',
        section: 'faq',
        sectionType: 'faq',
        content: {},
        normalized: {},
        valueCount: 1,
      },
    ];

    expect(getAffectedCacheKeys(changes)).toEqual([
      'cms:page:home:vi',
      'cms:page:solutions:en',
    ]);
  });
});
