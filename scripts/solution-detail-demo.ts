import 'dotenv/config';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { createSolutionDetail, solutionModules } from '../src/pages/solution-detail';
import { articleText, solutionArticleSchema, solutionDetailHeroSchema } from '../src/sections/validation/solution-detail.schemas';

const db = new PrismaClient();
const args = process.argv.slice(2);
const refresh = args.includes('--refresh-demo');
if (args.length !== (refresh ? 2 : 1) || !['--dry-run', '--apply'].includes(args[0]) || (refresh && args[1] !== '--refresh-demo')) throw new Error('Use --dry-run or --apply, optionally followed by --refresh-demo');
const slug = 'nhan-su-tien-luong', moduleKey = 'hrPayroll';
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Exact original demo fingerprints: a content refresh must not overwrite later editorial changes.
const original = { vi: { hero: '0f82712906f4c741b98ca4fac47be7ec9e34638a24fd6a93b202ed0c0c476242', article: 'ac8ff9bc5b1033c0609fdcbf3b73c0210810e87a3cf724fc3bd6ac92f56a3a71' }, en: { hero: '7ad43eac6c0e8165ca03f460ae62b2fbfe307957648d856557579622b01d8f03', article: '5bd4e9dde2e0f4a293dd45e256af3ebaa3e5da6314a2b7bca595d3d603e309de' } };
function editorialArticle(english: boolean) {
  const copy = (vi: string, en: string) => english ? en : vi;
  const p = (vi: string, en: string) => ({ type: 'paragraph', content: [{ type: 'text', text: copy(vi, en) }] });
  const h = (id: string, vi: string, en: string, level = 2) => ({ type: 'heading', attrs: { level, id }, content: [{ type: 'text', text: copy(vi, en) }] });
  const list = (type: string, items: string[][]) => ({ type, ...(type === 'orderedList' ? { attrs: { start: 1 } } : {}), content: items.map(([vi, en]) => ({ type: 'listItem', content: [p(vi, en)] })) });
  return solutionArticleSchema.parse({ version: 1, doc: { type: 'doc', content: [
    p('Nhân sự và tiền lương kết nối hồ sơ người lao động, thời gian làm việc và chi phí vận hành. Khi mỗi bộ phận giữ một bảng tính riêng, một thay đổi nhỏ có thể đi qua nhiều tệp trước khi được xác nhận. Quy trình quản trị cần bắt đầu từ dữ liệu đáng tin cậy, trách nhiệm rõ ràng và lịch đối soát thống nhất.', 'HR and payroll connect employee records, working time and operating costs. When teams maintain separate spreadsheets, a small change can pass through several files before anyone confirms the correct version. A dependable process starts with reliable information, clear ownership and a consistent review cycle.'),
    p('Trước khi lựa chọn phần mềm, nhân sự, phụ trách tiền lương và tài chính nên thống nhất thông tin cần ghi nhận, người được cập nhật và cách xử lý ngoại lệ. Khung tham khảo dưới đây giúp chuẩn bị cuộc trao đổi về yêu cầu triển khai phù hợp với doanh nghiệp.', 'Before choosing software, HR, payroll and finance teams should agree on what they record, who can change it and how exceptions are resolved. The following framework supports a requirements discussion without assuming that every organisation follows the same rules.'),
    h('overview', 'Xây dựng hồ sơ nhân viên đáng tin cậy', 'Build a dependable employee record'),
    p('Hồ sơ cần có cấu trúc nhất quán: thông tin nhận diện, quá trình làm việc, đơn vị công tác, thời hạn hợp đồng và đào tạo liên quan. Xác định trường bắt buộc và người phụ trách từng nhóm dữ liệu giúp việc chuyển bộ phận hoặc kết thúc công tác được theo dõi rõ ràng.', 'A useful record has a consistent structure: identity, employment history, department, contract dates and relevant training. Define mandatory fields and assign responsibility for each data group. This makes it easier to follow changes when an employee moves between departments or leaves the organisation.'),
    list('bulletList', [
      ['Thống nhất mã nhân viên trong hồ sơ, chấm công và bảng lương.', 'Use a consistent employee identifier across HR, attendance and payroll.'],
      ['Ghi nhận ngày có hiệu lực và người phụ trách thay đổi đã duyệt.', 'Record the effective date and owner of each approved change.'],
      ['Phân biệt quyền cập nhật thông thường với quyền xem dữ liệu nhạy cảm.', 'Separate routine updates from access to sensitive employee information.'],
      ['Theo dõi tuyển dụng, đào tạo trong quá trình làm việc.', 'Follow recruitment and training through the employee lifecycle.'],
    ]),
    { type: 'articleImage', attrs: { id: 'demo-image-one', src: 'https://res.cloudinary.com/drslg1shx/image/upload/v1790051140/train_qadw6j.png', alt: copy('Hình minh họa từ thư viện NeoTek', 'Illustration from the existing NeoTek library'), caption: copy('Minh họa hoạt động phối hợp và đào tạo trong doanh nghiệp.', 'Illustrating coordination and learning within an organisation.'), display: 'wide' } },
    h('scope', 'Thống nhất cách kiểm tra thời gian làm việc', 'Agree how working time is reviewed'),
    p('Dữ liệu chấm công cần được hiểu trong bối cảnh thực tế. Các nhóm có thể làm theo ca, tại địa điểm khác nhau hoặc áp dụng cách phê duyệt khác nhau. Mô tả cách ghi nhận thời gian làm việc, nghỉ và điều chỉnh, rồi thống nhất thời điểm chốt dữ liệu cho mỗi kỳ lương.', 'Attendance data needs context. Teams may work different shifts, at different locations or under different approval arrangements. Document how working time, absence and corrections are recorded. Establish a cut-off for each payroll period so managers know which outstanding items require review.'),
    p('Ngoại lệ cần có người phụ trách, căn cứ và kết quả xử lý, thay vì chỉ trao đổi qua tin nhắn. Kiểm tra trước khi lập bảng lương giúp phân biệt lỗi dữ liệu với quyết định nghiệp vụ đã được phê duyệt.', 'An incomplete entry or late correction needs an owner, supporting information and a clear outcome. Reviewing exceptions before payroll preparation helps distinguish a data issue from an approved business decision, rather than relying on informal messages.'),
    h('payroll', 'Chuẩn bị kỳ lương với các điểm kiểm soát rõ ràng', 'Prepare payroll with clear checkpoints'),
    p('Lập bảng lương cần đầu vào đã thống nhất và cách tính được mô tả cụ thể. Tổng hợp thay đổi nhân sự có hiệu lực cùng thời gian làm việc đã duyệt. Xác định khoản điều chỉnh thuộc kỳ hiện tại và giữ căn cứ giải thích để việc đối soát không chỉ dựa trên số tổng.', 'Payroll preparation depends on agreed inputs and a documented calculation method. Collect effective employee changes and approved working-time records, then identify adjustments belonging to the current period. Keep the explanation for each adjustment available to reviewers, rather than asking them to assess totals alone.'),
    h('payroll-review', 'Đối soát trước khi chốt kỳ', 'Review before closing the period', 3),
    p('So sánh với kỳ trước và rà soát biến động bất thường. Nhân sự kiểm tra hồ sơ, phụ trách tiền lương kiểm tra cách tính, tài chính xác nhận thông tin theo dõi chi phí. Phân định trách nhiệm giúp bàn giao dễ hiểu hơn, đồng thời giữ vai trò đánh giá chuyên môn.', 'Compare the proposed result with the previous period and investigate unusual movements. HR checks employee changes, payroll reviews calculations and finance confirms cost-reporting information. Clear responsibilities make the handover easier to understand while preserving the professional judgement of each team.'),
    { type: 'callout', attrs: { variant: 'info' }, content: [p('Nội dung biên tập minh họa. Cần xác nhận quy tắc tính, quyền truy cập và phạm vi triển khai với bộ phận nhân sự, tài chính trước khi cấu hình hệ thống.', 'Illustrative editorial content. Confirm calculation rules, access permissions and implementation scope with HR and finance before configuring a system.')] },
    h('preparation', 'Kết nối nghiệp vụ với báo cáo quản trị', 'Connect operational data with management reporting'),
    p('Báo cáo có giá trị khi các định nghĩa được hiểu thống nhất. Làm rõ kỳ dữ liệu, cơ cấu tổ chức và trạng thái số liệu của từng góc nhìn. Thông tin nhân sự, chi phí hỗ trợ trao đổi về nguồn lực và ngân sách. Với dữ liệu chưa đầy đủ, cần trình bày giới hạn thay vì coi mọi số liệu là kết quả cuối cùng.', 'Reporting is useful when definitions are clear. Agree which period, organisational structure and data status each view represents. Headcount and personnel-cost information can support staffing and budget discussions. Explain the limitations of incomplete or provisional data instead of presenting every number as a final result.'),
    { type: 'articleImage', attrs: { id: 'demo-image-two', src: 'https://res.cloudinary.com/drslg1shx/image/upload/v1790451496/Bento_Blocks___Analytics_Card_iy6icr.gif', alt: copy('Hình minh họa phân tích dữ liệu của NeoTek', 'Existing NeoTek analytics illustration'), caption: copy('Minh họa báo cáo quản trị; chỉ tiêu sử dụng phụ thuộc nhu cầu doanh nghiệp.', 'Management reporting illustration; measures depend on organisational needs.'), display: 'wide' } },
  ] } });
}
async function main() {
  let changed = false;
  await db.$transaction(async tx => {
    const { section, byLocale } = await solutionModules(tx);
    const items = ['vi', 'en'].map(locale => byLocale[locale]?.find(item => item.key === moduleKey));
    if (items.some(item => !item)) throw new Error('Existing bilingual HR/payroll module is required');
    if (items.some(item => item!.slug && item!.slug !== slug)) throw new Error('Module already has another slug; review instead of overwriting');
    const existing = await tx.page.findUnique({ where: { slug }, include: { sections: { include: { translations: true } } } });
    if (existing && existing.kind !== 'SOLUTION_DETAIL') throw new Error('Slug belongs to another page');
    const links = section.translations.filter(t => ((t.content as { items: Array<{ key: string; slug?: string }> }).items).some(item => item.key === moduleKey && item.slug !== slug));
    const refreshed = existing?.sections.find(s => s.key === 'article')?.translations.every(t => fingerprint(solutionArticleSchema.parse(t.content)) === fingerprint(editorialArticle(t.locale === 'en')));
    const updateDemo = !existing || (refresh && !refreshed);
    if (existing && updateDemo) for (const locale of ['vi', 'en'] as const) for (const key of ['hero', 'article'] as const) {
      const value = existing.sections.find(s => s.key === key)?.translations.find(t => t.locale === locale)?.content;
      if (!value || fingerprint((key === 'hero' ? solutionDetailHeroSchema : solutionArticleSchema).parse(value)) !== original[locale][key]) throw new Error('Demo contains editorial changes; refresh refused to preserve them');
    }
    const changes = [...links.map(t => 'module slug: ' + t.locale), ...(updateDemo ? [existing ? 'refresh original bilingual demo' : 'create bilingual demo page'] : [])];
    console.log(JSON.stringify({ mode: args[0], slug, changes, existingContentPreserved: !!existing && !updateDemo, words: Object.fromEntries(['vi', 'en'].map(locale => [locale, articleText(editorialArticle(locale === 'en').doc).split(/\s+/).length])) }, null, 2));
    if (args[0] !== '--apply' || !changes.length) return;
    for (const translation of links) {
      const content = translation.content as { items: Array<{ key: string; slug?: string }> };
      await tx.pageSectionTranslation.update({ where: { id: translation.id }, data: { content: { ...content, items: content.items.map(item => item.key === moduleKey ? { ...item, slug } : item) } } });
    }
    if (updateDemo) {
      const page = existing || await createSolutionDetail(tx, moduleKey);
      const landing = await tx.page.findUnique({ where: { slug: 'solutions' }, include: { sections: { where: { key: 'hero' }, include: { translations: true } } } });
      const cover = (landing?.sections[0]?.translations[0]?.content as { slides?: Array<{ desktopImage?: string }> })?.slides?.[0]?.desktopImage || '/assets/bg-cta-auth.png';
      for (const [index, locale] of ['vi', 'en'].entries()) {
        const english = locale === 'en', module = items[index]!;
        const title = module.title || (english ? 'HR & payroll' : 'Nhân sự & tiền lương');
        const description = module.description?.replace(/<[^>]*>/g, '') || '';
        const doc = editorialArticle(english);
        const hero = { eyebrow: english ? 'DEMONSTRATION ARTICLE' : 'BÀI VIẾT MINH HỌA', title, description, cover, alt: english ? 'NeoTek product illustration' : 'Hình minh họa sản phẩm NeoTek', cta: { label: '', url: '' }, ogImage: cover };
        solutionArticleSchema.parse(doc); solutionDetailHeroSchema.parse(hero);
        if (!existing) await tx.pageTranslation.update({ where: { pageId_locale: { pageId: page.id, locale } }, data: { seoTitle: `${title} | Neotek`, seoDescription: description || (english ? 'A NeoTek editorial demonstration.' : 'Bài minh họa biên tập NeoTek.') } });
        for (const detailSection of page.sections) {
          if (existing && detailSection.key === 'related') continue;
          const content = detailSection.key === 'hero' ? hero : detailSection.key === 'article' ? doc : { moduleKeys: byLocale.vi.filter(item => item.key !== moduleKey).slice(0, 2).map(item => item.key) };
          await tx.pageSectionTranslation.update({ where: { sectionId_locale: { sectionId: detailSection.id, locale } }, data: { content: content as Prisma.InputJsonValue } });
        }
      }
      await tx.page.update({ where: { id: page.id }, data: existing ? { updatedAt: new Date() } : { status: 'PUBLISHED', publishedAt: new Date() } });
    }
    changed = true;
  }, { isolationLevel: 'Serializable', timeout: 20000 });
  if (changed) {
    const redis = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379', socket: { reconnectStrategy: false } }); redis.on('error', () => {});
    try { await redis.connect(); for (const page of ['solutions', slug]) for (const locale of ['vi', 'en']) await redis.del(`cms:page:${page}:${locale}`); }
    catch { console.warn('Demo saved; CMS cache invalidation will expire by TTL.'); }
    finally { if (redis.isOpen) await redis.quit(); }
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }).finally(() => db.$disconnect());
