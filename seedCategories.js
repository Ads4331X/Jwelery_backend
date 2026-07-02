/**
 * seedCategories.js
 * Run with: node seedCategories.js
 */

const prisma = require("./config/prisma");

const categories = [
  { name: "Necklace", slug: "necklace", sortOrder: 1 },
  { name: "Ring", slug: "ring", sortOrder: 2 },
  { name: "Earring", slug: "earring", sortOrder: 3 },
  { name: "Bracelet", slug: "bracelet", sortOrder: 4 },
  { name: "Bangle", slug: "bangle", sortOrder: 5 },
  { name: "Pendant", slug: "pendant", sortOrder: 6 },
  { name: "Bridal", slug: "bridal", sortOrder: 7 },
  { name: "Other", slug: "other", sortOrder: 8 },
];

async function main() {
  for (const cat of categories) {
    await prisma.category.upsert({
      where: { slug: cat.slug },
      update: {},
      create: { ...cat, isActive: true },
    });
    console.log(`✓ ${cat.name}`);
  }
  console.log("Done.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
