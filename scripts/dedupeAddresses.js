/**
 * dedupeAddresses.js
 *
 * ONE-TIME DATA CLEANUP SCRIPT
 * --------------------------------------------
 * For each user, group their Address rows by identical content
 * (fullName, phone, street, city — trimmed/normalized for comparison).
 *
 * Within each duplicate group, keep ONE row (prefer one with isDefault: true
 * if any exist in the group, otherwise the oldest by createdAt).
 *
 * Before deleting the others in the group, re-point any Orders that reference
 * a row about to be deleted to the kept row's id first (UPDATE, not orphan).
 *
 * Run manually once:
 *   node scripts/dedupeAddresses.js
 *
 * The Prisma schema shows Order.addressId is optional (String?) and has no
 * explicit onDelete cascade or setNull, so MySQL's FK constraint would BLOCK
 * deletion if any Orders still reference the address.  Therefore we MUST
 * re-point those Orders before deleting.
 */

const prisma = require("../config/prisma");

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a single field: trim, lowercase, collapse internal whitespace.
 */
function norm(s) {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a dedup key from the four content fields.
 */
function dedupKey(addr) {
  return [
    norm(addr.fullName),
    norm(addr.phone),
    norm(addr.street),
    norm(addr.city),
  ].join("|");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 Loading addresses...\n");

  // 1. Fetch all addresses with their user and order count
  const addresses = await prisma.address.findMany({
    include: {
      _count: { select: { orders: true } },
    },
    orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
  });

  console.log(`   Total address rows: ${addresses.length}`);

  // 2. Group by user first, then by dedup key
  const byUser = new Map();
  for (const addr of addresses) {
    if (!byUser.has(addr.userId)) byUser.set(addr.userId, []);
    byUser.get(addr.userId).push(addr);
  }

  let totalDuplicateGroups = 0;
  let totalRemoved = 0;
  let totalRepointed = 0;

  for (const [userId, userAddresses] of byUser.entries()) {
    // Group within this user by dedup key
    const groups = new Map();
    for (const addr of userAddresses) {
      const key = dedupKey(addr);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(addr);
    }

    for (const [key, group] of groups.entries()) {
      if (group.length <= 1) continue; // not a duplicate

      totalDuplicateGroups++;
      const [sample] = group;
      console.log(
        `\n📦 User ${userId} — duplicate group: "${key}" (${group.length} rows)`,
      );

      // 3. Pick keeper: prefer isDefault, else oldest (already sorted by createdAt ASC)
      const keeper = group.find((a) => a.isDefault) ?? group[0];
      console.log(
        `   🏆 Keeper: ${keeper.id} (isDefault=${keeper.isDefault}, createdAt=${keeper.createdAt})`,
      );

      const toDelete = group.filter((a) => a.id !== keeper.id);

      for (const dup of toDelete) {
        // 4. Re-point any Orders referencing this duplicate to the keeper
        const ordersUsing = await prisma.order.findMany({
          where: { addressId: dup.id },
          select: { id: true, orderNumber: true },
        });

        if (ordersUsing.length > 0) {
          const ids = ordersUsing.map((o) => o.id);
          await prisma.order.updateMany({
            where: { id: { in: ids } },
            data: { addressId: keeper.id },
          });
          totalRepointed += ordersUsing.length;
          console.log(
            `   🔗 Re-pointed ${ordersUsing.length} order(s) (${ordersUsing.map((o) => o.orderNumber).join(", ")}) → keeper ${keeper.id}`,
          );
        }

        // 5. Now safe to delete
        await prisma.address.delete({ where: { id: dup.id } });
        totalRemoved++;
        console.log(`   🗑️  Deleted duplicate address ${dup.id}`);
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("✅ DEDUPLICATION COMPLETE");
  console.log(`   Duplicate groups found: ${totalDuplicateGroups}`);
  console.log(`   Address rows removed:   ${totalRemoved}`);
  console.log(`   Orders re-pointed:      ${totalRepointed}`);
  console.log("=".repeat(60));
}

main()
  .catch((err) => {
    console.error("❌ Script failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
