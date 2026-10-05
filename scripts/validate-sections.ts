import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import {
  SectionContentValidationError,
  validateSectionContent,
} from '../src/sections/validation/section-content.registry';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const counts: Record<string, number> = {};
  let validated = 0;
  const failures: string[] = [];

  try {
    const translations = await prisma.pageSectionTranslation.findMany({
      select: {
        content: true,
        section: { select: { type: true } },
      },
    });

    for (const translation of translations) {
      try {
        validateSectionContent(translation.section.type, translation.content);
        counts[translation.section.type] = (counts[translation.section.type] ?? 0) + 1;
        validated += 1;
      } catch (error) {
        failures.push(
          `${translation.section.type}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(`Validated section translations: ${validated}`);
    console.log(`Counts by section type: ${JSON.stringify(counts)}`);
    if (failures.length > 0) {
      console.error(`Validation failures: ${failures.length}`);
      failures.forEach((failure) => console.error(`  - ${failure}`));
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof SectionContentValidationError) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
