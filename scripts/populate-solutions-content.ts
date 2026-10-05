import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { validateSectionContent } from '../src/sections/validation/section-content.registry';

const prisma = new PrismaClient();
const locales = ['vi', 'en'] as const;
type Locale = (typeof locales)[number];

const heroCopy = {
  vi: {
    eyebrow: 'HỆ SINH THÁI GIẢI PHÁP NEOERP',
    titleLine1: 'Mọi vận hành.',
    titleHighlight: 'Trên một nền tảng.',
    description: 'Kết nối các hoạt động kinh doanh, chuỗi cung ứng, dự án, sản xuất và quản trị trên cùng một nền tảng.',
    primaryLabel: 'Khám phá giải pháp',
    secondaryLabel: 'Đăng ký Demo',
  },
  en: {
    eyebrow: 'NEOERP SOLUTION ECOSYSTEM',
    titleLine1: 'Every operation.',
    titleHighlight: 'On one platform.',
    description: 'Connect business, supply chain, projects, production, and management activities on one platform.',
    primaryLabel: 'Explore solutions',
    secondaryLabel: 'Book a Demo',
  },
} satisfies Record<Locale, Record<string, string>>;

type GroupRow = [string, string, string, string, string, string[]];
type ModuleRow = [string, string, string[], string];

const groups: Record<Locale, GroupRow[]> = {
  vi: [
    ['business', 'KINH DOANH', 'Kết nối khách hàng và hoạt động bán hàng.', 'Quản lý thông tin khách hàng và quy trình bán hàng trên cùng một nền tảng, từ dữ liệu khách hàng đến đơn hàng và chính sách bán hàng.', 'Vị trí hình minh họa nhóm nghiệp vụ kinh doanh', ['crm', 'sales']],
    ['supplyChain', 'CHUỖI CUNG ỨNG', 'Theo dõi dòng chảy hàng hóa xuyên suốt.', 'Liên kết mua hàng, quản lý kho và kho vận để theo dõi hàng hóa qua các hoạt động nhập, xuất, lưu trữ và giao nhận.', 'Vị trí hình minh họa nhóm nghiệp vụ chuỗi cung ứng', ['purchasing', 'warehouse', 'logistics']],
    ['operations', 'DỰ ÁN & SẢN XUẤT', 'Theo dõi công việc, tiến độ và sản xuất.', 'Hỗ trợ lập kế hoạch, phân công và theo dõi tiến độ dự án; đồng thời quản lý các nghiệp vụ và nguồn lực liên quan đến sản xuất.', 'Vị trí hình minh họa nhóm nghiệp vụ vận hành', ['production', 'maintenance', 'projects']],
    ['management', 'QUẢN TRỊ DOANH NGHIỆP', 'Kết nối nhân sự và thông tin tài chính.', 'Tập hợp nghiệp vụ nhân sự, tiền lương và kế toán tài chính để hỗ trợ theo dõi hoạt động và tổng hợp thông tin quản trị.', 'Vị trí hình minh họa nhóm nghiệp vụ quản trị', ['hrPayroll', 'finance', 'forecast']],
  ],
  en: [
    ['business', 'BUSINESS', 'Connect customers and sales activities.', 'Manage customer information and sales processes on one platform, from customer records to orders and sales policies.', 'Placeholder for the business solution visual', ['crm', 'sales']],
    ['supplyChain', 'SUPPLY CHAIN', 'Track the flow of goods end to end.', 'Connect purchasing, warehouse management, and logistics to track goods across receiving, dispatch, storage, and delivery.', 'Placeholder for the supply chain solution visual', ['purchasing', 'warehouse', 'logistics']],
    ['operations', 'PROJECTS & PRODUCTION', 'Track work, progress, and production.', 'Plan, assign, and track project progress while managing processes and resources related to production.', 'Placeholder for the operations solution visual', ['production', 'maintenance', 'projects']],
    ['management', 'BUSINESS MANAGEMENT', 'Connect people and financial information.', 'Bring together HR, payroll, accounting, and financial processes to support operational tracking and management reporting.', 'Placeholder for the enterprise management solution visual', ['hrPayroll', 'finance', 'forecast']],
  ],
};

const modules: Record<Locale, Record<string, ModuleRow>> = {
  vi: {
    crm: ['CRM', 'Quản lý quan hệ khách hàng từ khâu tiếp nhận thông tin đến chăm sóc và đánh giá.', ['Lưu trữ hồ sơ khách hàng và cộng tác viên bán hàng.', 'Phân công danh sách khách hàng cho người phụ trách.', 'Lập lịch giao tiếp và tổng kết đánh giá khách hàng.'], 'neotek-user-group-02-stroke-rounded.svg'],
    sales: ['Bán hàng', 'Theo dõi nghiệp vụ bán hàng, đơn hàng và báo cáo theo chính sách của doanh nghiệp.', ['Theo dõi đơn hàng, chính sách bán hàng và nghiệp vụ khuyến mãi.', 'Quản lý chính sách bán hàng, khuyến mãi và tính hoa hồng.', 'Tổng hợp báo cáo bán hàng theo các chiều thông tin quản trị.'], 'neotek-shopping-cart-01-stroke-rounded.svg'],
    purchasing: ['Mua hàng', 'Quản lý đơn hàng mua và thông tin nhà cung cấp.', ['Quản lý đơn hàng mua và thông tin nhà cung cấp.', 'Theo dõi thông tin nhà cung cấp trên đơn hàng mua.', 'Tổng hợp báo cáo mua hàng.'], 'neotek-shopping-basket-03-stroke-rounded.svg'],
    warehouse: ['Quản lý kho', 'Theo dõi mặt hàng, vị trí kho và số liệu tồn kho.', ['Quản lý danh mục mặt hàng.', 'Quản lý kho và vị trí lưu trữ.', 'Theo dõi báo cáo kho.'], 'neotek-package-search-01-stroke-rounded.svg'],
    logistics: ['Kho vận', 'Quản lý hoạt động vận chuyển và giao hàng.', ['Quản lý vận chuyển và giao hàng.', 'Theo dõi nghiệp vụ vận chuyển.'], 'neotek-container-truck-01-stroke-rounded.svg'],
    production: ['Sản xuất', 'Quản lý quy trình, kế hoạch và chi phí sản xuất.', ['Quản lý các bước trong quy trình sản xuất.', 'Tính nhu cầu nguyên vật liệu và lập lịch sản xuất.', 'Tính giá thành sản phẩm và chi phí sản xuất.'], 'neotek-factory-02-stroke-rounded.svg'],
    maintenance: ['Bảo trì', 'Theo dõi nguồn lực, kế hoạch và hoạt động bảo trì.', ['Khai báo nguồn lực, tài sản và phụ tùng bảo trì.', 'Theo dõi bảo trì theo kế hoạch và ngoài kế hoạch.'], 'neotek-system-update-02-stroke-rounded.svg'],
    projects: ['Quản lý dự án', 'Lập kế hoạch và theo dõi tiến độ, giai đoạn và kinh phí dự án.', ['Chia giai đoạn và lập kế hoạch dự án.', 'Quản lý kinh phí dự án.', 'Theo dõi tiến độ thực hiện dự án.'], 'neotek-folder-cog-stroke-rounded.svg'],
    hrPayroll: ['Nhân sự & tiền lương', 'Quản lý các nghiệp vụ nhân sự, chấm công và tiền lương.', ['Quản lý quy trình tuyển dụng và đào tạo.', 'Quản lý hồ sơ nhân viên.', 'Theo dõi chấm công và tiền lương.'], 'neotek-user-account-stroke-rounded.svg'],
    finance: ['Tài chính & kế toán', 'Theo dõi nghiệp vụ kế toán và tổng hợp báo cáo tài chính, quản trị.', ['Theo dõi công nợ phải thu và phải trả.', 'Quản lý thu chi, vốn bằng tiền và nghiệp vụ thuế.', 'Tổng hợp báo cáo kế toán, tài chính và quản trị.'], 'neotek-wallet-01-stroke-rounded.svg'],
    forecast: ['Ngân sách & dự báo', 'Sử dụng dữ liệu lịch sử để lập dự báo và hỗ trợ kiểm soát ngân sách.', ['Dựa trên dữ liệu quá khứ để hỗ trợ dự báo.', 'Lập ngân sách, phê duyệt và theo dõi thực hiện.'], 'neotek-apple-stocks-stroke-rounded.svg'],
  },
  en: {
    crm: ['CRM', 'Manage customer relationships from capturing information through follow-up and review.', ['Maintain customer and sales collaborator records.', 'Assign customer lists to responsible team members.', 'Schedule customer communication and review interactions.'], 'neotek-user-group-02-stroke-rounded.svg'],
    sales: ['Sales', 'Track sales activities, orders, and reports using the business’s sales policies.', ['Track sales orders, sales policies, and promotion processes.', 'Manage sales policies, promotions, and commissions.', 'Review sales reports across management dimensions.'], 'neotek-shopping-cart-01-stroke-rounded.svg'],
    purchasing: ['Purchasing', 'Manage purchase orders and supplier information.', ['Manage purchase orders and supplier information.', 'Track supplier information on purchase orders.', 'Compile purchasing reports.'], 'neotek-shopping-basket-03-stroke-rounded.svg'],
    warehouse: ['Warehouse management', 'Track items, warehouse locations, and inventory.', ['Manage the item catalog.', 'Manage warehouses and storage locations.', 'Review warehouse reports.'], 'neotek-package-search-01-stroke-rounded.svg'],
    logistics: ['Logistics', 'Manage transportation and delivery activities.', ['Manage transportation and delivery.', 'Track transportation activities.'], 'neotek-container-truck-01-stroke-rounded.svg'],
    production: ['Production', 'Manage production processes, plans, and costs.', ['Manage production process steps.', 'Calculate material requirements and schedule production.', 'Calculate product and production costs.'], 'neotek-factory-02-stroke-rounded.svg'],
    maintenance: ['Maintenance', 'Track resources, schedules, and maintenance activities.', ['Register maintenance resources, assets, and spare parts.', 'Track planned and unplanned maintenance.'], 'neotek-system-update-02-stroke-rounded.svg'],
    projects: ['Project management', 'Plan and track project phases, budgets, and progress.', ['Structure projects into phases and plans.', 'Manage project budgets.', 'Track project progress.'], 'neotek-folder-cog-stroke-rounded.svg'],
    hrPayroll: ['HR & payroll', 'Manage HR processes, attendance, and payroll.', ['Manage recruitment and training processes.', 'Manage employee records.', 'Track attendance and payroll.'], 'neotek-user-account-stroke-rounded.svg'],
    finance: ['Finance & accounting', 'Track accounting activities and compile financial and management reports.', ['Track accounts receivable and payable.', 'Manage cash transactions and tax accounting.', 'Compile accounting, financial, and management reports.'], 'neotek-wallet-01-stroke-rounded.svg'],
    forecast: ['Budget & forecast', 'Use historical data to prepare forecasts and support budget control.', ['Use historical data to support forecasting.', 'Prepare budgets, approvals, and execution tracking.'], 'neotek-apple-stocks-stroke-rounded.svg'],
  },
};

function contentFor(locale: Locale) {
  const hero = heroCopy[locale];
  return {
    hero: {
      slides: [{
        key: 'solutions',
        desktopImage: 'https://res.cloudinary.com/drslg1shx/image/upload/v1790869050/SolutionHero_saf7lm.png',
        mobileImage: null,
        imagePosition: 'center',
        mobileImagePosition: 'center',
        overlay: 'dark-left',
        showContent: true,
        contentPosition: 'left',
        eyebrow: hero.eyebrow,
        headline: hero.titleLine1,
        titleLine1: hero.titleLine1,
        titleHighlight: hero.titleHighlight,
        description: hero.description,
        primaryCta: { enabled: true, label: hero.primaryLabel, url: '#solution-clusters' },
        secondaryCta: { enabled: true, label: hero.secondaryLabel, url: '/register' },
      }],
    },
    groups: {
      items: groups[locale].map(([key, eyebrow, title, description, visualLabel, moduleKeys]) => ({
        key, icon: key, modules: moduleKeys, eyebrow, title, description, visualLabel,
      })),
    },
    modules: {
      items: Object.entries(modules[locale]).map(([key, [title, description, bullets, icon]]) => ({
        key, icon, visualSrc: null, title, description, bullets,
      })),
    },
  };
}

function isApplyMode(): boolean {
  return process.argv.includes('--apply');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function invalidateCaches(): Promise<void> {
  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    for (const locale of locales) await redis.del(`cms:page:solutions:${locale}`);
    console.log('Cache keys invalidated: cms:page:solutions:vi, cms:page:solutions:en');
  } finally {
    if (redis.isOpen) await redis.quit();
  }
}

async function main(): Promise<void> {
  const apply = isApplyMode();
  const page = await prisma.page.findUnique({
    where: { slug: 'solutions' },
    include: { sections: { include: { translations: true } } },
  });
  if (!page) throw new Error('Page not found: solutions');

  const changes: Array<{ locale: Locale; section: string; content: Prisma.JsonValue }> = [];
  for (const locale of locales) {
    const data = contentFor(locale);
    for (const [key, content] of Object.entries(data)) {
      const section = page.sections.find((item) => item.key === key);
      if (!section) throw new Error(`Section not found: solutions.${key}`);
      validateSectionContent(section.type, content);
      const translation = section.translations.find((item) => item.locale === locale);
      if (!translation) throw new Error(`Translation not found: solutions.${key}.${locale}`);
      if (stableJson(translation.content) !== stableJson(content)) {
        changes.push({ locale, section: key, content });
      }
    }
  }

  console.log(apply ? 'Solutions content apply' : 'Solutions content dry-run');
  console.log(`Changes: ${changes.length}`);
  changes.forEach((change) => console.log(`  - solutions.${change.section}.${change.locale}`));
  if (!apply || changes.length === 0) return;

  await prisma.$transaction(
    changes.map((change) => {
      const section = page.sections.find((item) => item.key === change.section)!;
      return prisma.pageSectionTranslation.update({
        where: { sectionId_locale: { sectionId: section.id, locale: change.locale } },
        data: { content: change.content as Prisma.InputJsonValue },
      });
    }),
  );
  await invalidateCaches();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
