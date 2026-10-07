import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { createClient } from 'redis';
import { validateSectionContent } from '../src/sections/validation/section-content.registry';

// Verified existing website copy/media; only missing fields are populated.
const defaults = {
  vi: {
    home: {
      solutions: {
        title: 'Giải pháp quản trị toàn diện cho doanh nghiệp',
        items: [
          {
            key: 'business',
            title: 'Kinh doanh',
            description:
              'Xây dựng quy trình bán hàng, chăm sóc khách hàng và theo dõi cơ hội kinh doanh từ đầu đến cuối.',
            image:
              'https://tallemucrm.com/assets/img/live/2023/11/iStock-1049186550.jpg',
            imagePosition: '72% center',
            modules: [
              {
                key: 'sales',
                title: 'Bán hàng',
                icon: 'ShoppingCart',
                url: '',
              },
              {
                key: 'crm',
                title: 'CRM',
                icon: 'Users',
                url: '',
              },
            ],
          },
          {
            key: 'supply-chain',
            title: 'Chuỗi cung ứng',
            description:
              'Kết nối mua hàng, tồn kho, vận chuyển và luồng hàng hóa trên cùng một nền tảng quản lý.',
            image:
              'https://www.airistaflow.com/wp-content/uploads/2024/10/AdobeStock_523184404-scaled.jpeg',
            imagePosition: '80% center',
            modules: [
              {
                key: 'procurement',
                title: 'Mua hàng',
                icon: 'PackageSearch',
                url: '',
              },
              {
                key: 'inventory',
                title: 'Kho vận',
                icon: 'Boxes',
                url: '',
              },
            ],
          },
          {
            key: 'manufacturing',
            title: 'Sản xuất',
            description:
              'Lập kế hoạch, kiểm soát nguyên liệu, quy trình sản xuất và chi phí theo từng công đoạn.',
            image:
              'https://res.cloudinary.com/drslg1shx/image/upload/v1790051630/162_pdpznt.jpg',
            imagePosition: '85% center',
            modules: [
              {
                key: 'production',
                title: 'Sản xuất',
                icon: 'Factory',
                url: '',
              },
              {
                key: 'maintenance',
                title: 'Bảo trì',
                icon: 'Sparkles',
                url: '',
              },
            ],
          },
          {
            key: 'management',
            title: 'Quản trị',
            description:
              'Kết nối nhân sự, dự án, tài chính và thông tin quản trị để hỗ trợ ra quyết định toàn doanh nghiệp.',
            image:
              'https://res.cloudinary.com/drslg1shx/image/upload/v1790051140/train_qadw6j.png',
            imagePosition: '80% center',
            modules: [
              {
                key: 'hr',
                title: 'Nhân sự',
                icon: 'BriefcaseBusiness',
                url: '',
              },
              {
                key: 'project',
                title: 'Dự án',
                icon: 'LandPlot',
                url: '',
              },
              {
                key: 'finance',
                title: 'Tài chính',
                icon: 'BarChart3',
                url: '',
              },
            ],
          },
        ],
      },
      why: {
        title: 'Một nền tảng quản trị tích hợp?',
        titleHighlight: 'Vì sao doanh nghiệp cần',
        description:
          'Kết nối dữ liệu và quy trình trên một hệ thống thống nhất, giúp doanh nghiệp quản lý xuyên suốt và ra quyết định nhất quán.',
      },
      proofMetrics: {
        title: 'Đồng hành cùng doanh nghiệp trên hành trình quản trị',
        description:
          'Kết nối các nghiệp vụ kinh doanh, vận hành và tài chính trên một nền tảng quản trị thống nhất.',
        actions: [
          {
            key: 'trial',
            label: 'Dùng thử miễn phí',
            url: '/demo',
            variant: 'primary',
          },
          {
            key: 'pricing',
            label: 'Báo giá',
            url: null,
            variant: 'secondary',
          },
          {
            key: 'purchase',
            label: 'Mua ngay',
            url: null,
            variant: 'ghost',
          },
        ],
      },
      trustedBy: {
        title: 'Được tin tưởng bởi các doanh nghiệp trong nhiều lĩnh vực',
      },
      testimonials: {
        title: 'Ý kiến khách hàng & đối tác',
      },
      faq: {
        eyebrow: 'GIẢI ĐÁP VỀ NEOERP',
        title: 'Câu hỏi thường gặp',
        description:
          'Giải đáp những câu hỏi thường gặp về NeoERP và cách nền tảng hỗ trợ doanh nghiệp quản trị hiệu quả.',
        ctaLabel: 'Liên hệ với chúng tôi',
        ctaUrl: '#contact',
      },
      solutionClusters: {
        eyebrow: 'HỆ SINH THÁI GIẢI PHÁP',
        title: 'Một nền tảng cho',
        titleHighlight: 'toàn bộ doanh nghiệp.',
        description:
          'Kết nối những hoạt động cốt lõi trong một hệ sinh thái quản trị thống nhất, từ kinh doanh đến chuỗi cung ứng, sản xuất và quản trị.',
        ctaLabel: 'Khám phá giải pháp',
        ctaUrl: '/solutions',
      },
    },
    solutions: {
      groups: {
        eyebrow: 'KHÁM PHÁ GIẢI PHÁP',
        title: 'Từ nghiệp vụ riêng lẻ',
        titleHighlight: 'đến vận hành kết nối.',
        description:
          'Bắt đầu từ nhu cầu quản lý của từng bộ phận. Các phân hệ NeoERP được tổ chức theo nhóm nghiệp vụ để bạn dễ tìm giải pháp phù hợp.',
      },
      faq: {
        eyebrow: 'GIẢI ĐÁP VỀ NEOERP',
        title: 'Câu hỏi thường gặp',
        description:
          'Giải đáp những câu hỏi thường gặp về NeoERP và cách nền tảng hỗ trợ doanh nghiệp quản trị hiệu quả.',
        ctaLabel: 'Liên hệ với chúng tôi',
        ctaUrl: '#contact',
      },
    },
  },
  en: {
    home: {
      solutions: {
        title: 'Comprehensive management solutions for enterprises',
        items: [
          {
            key: 'business',
            title: 'Business',
            description:
              'Build sales, customer care, and opportunity management processes from start to finish.',
            image:
              'https://tallemucrm.com/assets/img/live/2023/11/iStock-1049186550.jpg',
            imagePosition: '72% center',
            modules: [
              {
                key: 'sales',
                title: 'Sales',
                icon: 'ShoppingCart',
                url: '',
              },
              {
                key: 'crm',
                title: 'CRM',
                icon: 'Users',
                url: '',
              },
            ],
          },
          {
            key: 'supply-chain',
            title: 'Supply Chain',
            description:
              'Connect purchasing, inventory, transportation, and goods flows on one management platform.',
            image:
              'https://www.airistaflow.com/wp-content/uploads/2024/10/AdobeStock_523184404-scaled.jpeg',
            imagePosition: '80% center',
            modules: [
              {
                key: 'procurement',
                title: 'Purchasing',
                icon: 'PackageSearch',
                url: '',
              },
              {
                key: 'inventory',
                title: 'Warehouse & logistics',
                icon: 'Boxes',
                url: '',
              },
            ],
          },
          {
            key: 'manufacturing',
            title: 'Manufacturing',
            description:
              'Plan and control materials, production processes, and costs across each stage.',
            image:
              'https://res.cloudinary.com/drslg1shx/image/upload/v1790051630/162_pdpznt.jpg',
            imagePosition: '85% center',
            modules: [
              {
                key: 'production',
                title: 'Production',
                icon: 'Factory',
                url: '',
              },
              {
                key: 'maintenance',
                title: 'Maintenance',
                icon: 'Sparkles',
                url: '',
              },
            ],
          },
          {
            key: 'management',
            title: 'Management',
            description:
              'Connect HR, projects, finance, and management information to support enterprise decisions.',
            image:
              'https://res.cloudinary.com/drslg1shx/image/upload/v1790051140/train_qadw6j.png',
            imagePosition: '80% center',
            modules: [
              {
                key: 'hr',
                title: 'HR',
                icon: 'BriefcaseBusiness',
                url: '',
              },
              {
                key: 'project',
                title: 'Projects',
                icon: 'LandPlot',
                url: '',
              },
              {
                key: 'finance',
                title: 'Finance',
                icon: 'BarChart3',
                url: '',
              },
            ],
          },
        ],
      },
      why: {
        title: 'an integrated management platform?',
        titleHighlight: 'Why do businesses need',
        description:
          'Connect data and processes in one unified system for consistent management and decision-making.',
      },
      proofMetrics: {
        title: 'Partnering with businesses on their management journey',
        description:
          'Connect business, operations, and finance on one unified management platform.',
        actions: [
          {
            key: 'trial',
            label: 'Try for free',
            url: '/demo',
            variant: 'primary',
          },
          {
            key: 'pricing',
            label: 'Pricing',
            url: null,
            variant: 'secondary',
          },
          {
            key: 'purchase',
            label: 'Buy now',
            url: null,
            variant: 'ghost',
          },
        ],
      },
      trustedBy: {
        title: 'Trusted by businesses across industries',
      },
      testimonials: {
        title: 'Customer & partner feedback',
      },
      faq: {
        eyebrow: 'NEOERP FAQ',
        title: 'Your questions, answered',
        description:
          'Get quick answers to common questions about NeoERP and how it helps businesses manage their operations effectively.',
        ctaLabel: 'Contact us',
        ctaUrl: '#contact',
      },
      solutionClusters: {
        eyebrow: 'SOLUTION ECOSYSTEM',
        title: 'One platform for',
        titleHighlight: 'your entire enterprise.',
        description:
          'Connect core business activities in one unified management ecosystem, from business and supply chain to manufacturing and enterprise management.',
        ctaLabel: 'Explore solutions',
        ctaUrl: '/solutions',
      },
    },
    solutions: {
      groups: {
        eyebrow: 'EXPLORE SOLUTIONS',
        title: 'From individual tasks',
        titleHighlight: 'to connected operations.',
        description:
          'Start with the management needs of each department. NeoERP modules are organized by business area to help you find a relevant solution.',
      },
      faq: {
        eyebrow: 'NEOERP FAQ',
        title: 'Your questions, answered',
        description:
          'Get quick answers to common questions about NeoERP and how it helps businesses manage their operations effectively.',
        ctaLabel: 'Contact us',
        ctaUrl: '#contact',
      },
    },
  },
};
const footerDefaults = {
  vi: {
    items: [
      {
        eyebrow: 'NeoERP',
        title: 'Bạn muốn tìm hiểu NeoERP?',
        description:
          'Khám phá nền tảng quản trị tích hợp và cách NeoTek kết nối dữ liệu, quy trình và các phòng ban.',
        primary: {
          label: 'Đăng ký Demo',
          url: '/demo',
        },
        secondary: {
          label: '',
          url: '',
        },
      },
    ],
  },
  en: {
    items: [
      {
        eyebrow: 'NeoERP',
        title: 'Want to learn about NeoERP?',
        description:
          'Explore the integrated management platform and how NeoTek connects data, processes, and departments.',
        primary: {
          label: 'Book a Demo',
          url: '/demo',
        },
        secondary: {
          label: '',
          url: '',
        },
      },
    ],
  },
};
const clusterLabels = {
  vi: {
    business: 'Kinh doanh',
    supplyChain: 'Chuỗi cung ứng',
    manufacturing: 'Sản xuất',
    management: 'Quản trị',
  },
  en: {
    business: 'Business',
    supplyChain: 'Supply Chain',
    manufacturing: 'Manufacturing',
    management: 'Management',
  },
};
const prisma = new PrismaClient();
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
async function main() {
  const apply = process.argv.includes('--apply');
  const additions: Prisma.PageSectionCreateArgs[] = [];
  const additionSlugs = new Set<string>();
  const changes: Array<{
    id: string;
    locale: string;
    content: Prisma.InputJsonValue;
    slug: string;
    key: string;
  }> = [];
  for (const slug of ['home', 'solutions'] as const) {
    const page = await prisma.page.findUnique({
      where: { slug },
      include: { sections: { include: { translations: true } } },
    });
    if (!page) throw new Error('Missing page: ' + slug);
    if (
      slug === 'solutions' &&
      !page.sections.some((section) => section.key === 'trustedBy')
    ) {
      additionSlugs.add(slug);
      const translations = (['vi', 'en'] as const).map((locale) => ({
        locale,
        content: { title: defaults[locale].home.trustedBy.title, items: [] },
      }));
      translations.forEach((item) =>
        validateSectionContent('trustedLogos', item.content),
      );
      additions.push({
        data: {
          pageId: page.id,
          key: 'trustedBy',
          type: 'trustedLogos',
          enabled: true,
          sortOrder: 15,
          translations: { create: translations },
        },
      });
    }
    if (
      slug === 'home' &&
      !page.sections.some((section) => section.key === 'footerCta')
    ) {
      additionSlugs.add(slug);
      for (const locale of ['vi', 'en'] as const)
        validateSectionContent('cta', footerDefaults[locale]);
      additions.push({
        data: {
          pageId: page.id,
          key: 'footerCta',
          type: 'cta',
          enabled: true,
          sortOrder:
            Math.max(...page.sections.map((section) => section.sortOrder)) + 10,
          translations: {
            create: ['vi', 'en'].map((locale) => ({
              locale,
              content: footerDefaults[locale as 'vi' | 'en'],
            })),
          },
        },
      });
    }
    for (const locale of ['vi', 'en'] as const) {
      for (const [key, fields] of Object.entries(defaults[locale][slug])) {
        const section = page.sections.find((item) => item.key === key);
        if (!section)
          throw new Error('Missing existing section: ' + slug + '.' + key);
        const translation = section.translations.find(
          (item) => item.locale === locale,
        );
        const content =
          (translation?.content as Record<string, Prisma.InputJsonValue>) || {};
        const next: Record<string, Prisma.InputJsonValue> = {
          ...fields,
          ...content,
        };
        if (key === 'solutionClusters' && Array.isArray(next.items)) {
          next.items = next.items.map((item) => {
            const entry = item as Record<string, Prisma.InputJsonValue>;
            const label =
              clusterLabels[locale][entry.key as keyof typeof clusterLabels.vi];
            return label && !entry.label ? { ...entry, label } : entry;
          });
        }
        validateSectionContent(section.type, next);
        if (stableJson(content) !== stableJson(next))
          changes.push({
            id: section.id,
            locale,
            content: next as Prisma.InputJsonValue,
            slug,
            key,
          });
      }
    }
  }
  console.log(apply ? 'Apply CMS copy' : 'Dry run CMS copy');
  changes.forEach((item) =>
    console.log(item.slug + '.' + item.key + '.' + item.locale),
  );
  additions.forEach((item) =>
    console.log(
      `${item.data.key}.vi + en (new section, existing ${item.data.type} type)`,
    ),
  );
  if (!apply || (!changes.length && !additions.length)) return;
  const redis = createClient({ url: process.env.REDIS_URL });
  try {
    await redis.connect();
    await prisma.$transaction([
      ...additions.map((item) => prisma.pageSection.create(item)),
      ...changes.map((item) =>
        prisma.pageSectionTranslation.upsert({
          where: {
            sectionId_locale: { sectionId: item.id, locale: item.locale },
          },
          create: {
            sectionId: item.id,
            locale: item.locale,
            content: item.content,
          },
          update: { content: item.content },
        }),
      ),
    ]);
    await Promise.all(
      [
        ...new Set([
          ...changes.map((item) => 'cms:page:' + item.slug + ':' + item.locale),
          ...[...additionSlugs].flatMap((slug) =>
            ['vi', 'en'].map((locale) => `cms:page:${slug}:${locale}`),
          ),
        ]),
      ].map((key) => redis.del(key)),
    );
  } finally {
    if (redis.isOpen) await redis.quit();
  }
}
main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'Content population failed',
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
