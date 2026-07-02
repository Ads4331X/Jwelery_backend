/**
 * Seed script: creates the initial SUPER_ADMIN account.
 *
 * Usage:
 *   node prisma/seed.js
 *
 * Environment variables (optional overrides):
 *   SUPER_ADMIN_EMAIL    — default: superadmin@anand.com
 *   SUPER_ADMIN_PASSWORD — default: SuperAdmin123!
 */

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL || "superadmin@gmail.com";
  const password = process.env.SUPER_ADMIN_PASSWORD || "Admin@123";
  const username = "superadmin";

  // Check if super admin already exists
  const existing = await prisma.admin.findUnique({ where: { email } });

  if (existing) {
    console.log(`✓ Super admin already exists: ${email}`);
    return;
  }

  const hashed = await bcrypt.hash(password, 10);

  const admin = await prisma.admin.create({
    data: {
      email,
      password: hashed,
      username,
      role: "SUPER_ADMIN",
    },
  });

  console.log(`✓ Super admin created successfully!`);
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log(`  ID:       ${admin.id}`);
  console.log(`\n⚠ Change this password after first login!`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
