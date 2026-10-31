import { PrismaClient } from "@prisma/client";
import { prisma } from "./prisma.js";
import { hashPassword } from "../common/crypto.utils.js";

export interface AdminSeedDef {
  email: string;
  password: string;
  displayName: string;
  phone?: string;
  tier?: string;
  roles: string[];
  status?: string;
}

export interface SeededAdminResult {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  emailVerified: boolean;
}

export const SAFFRON_ADMIN_USERS: AdminSeedDef[] = [
  {
    email: "admin@saffronvastra.com",
    password: "SaffronAdmin2026!",
    displayName: "Saffron Vastra Administrator",
    phone: "+91 98765 43210",
    tier: "Atelier VIP",
    roles: ["ADMIN", "CUSTOMER"],
    status: "ACTIVE",
  },
  {
    email: "admin@saffronthreads.com",
    password: "SaffronAdmin2026!",
    displayName: "Saffron Threads Master Admin",
    phone: "+91 98765 43210",
    tier: "Atelier VIP",
    roles: ["ADMIN", "CUSTOMER"],
    status: "ACTIVE",
  },
];

const ROLE_DESCRIPTIONS: Record<string, string> = {
  ADMIN: "Super Administrator / Studio Manager",
  CUSTOMER: "Clientele / Shopper",
  ATELIER_STAFF: "Jaipur Atelier Master Artisan & Fulfillment Staff",
};

/**
 * Ensures prerequisite roles exist in the database.
 */
async function ensureRoles(client: PrismaClient, roleCodes: string[]) {
  const roles: Record<string, string> = {};

  for (const code of roleCodes) {
    const description = ROLE_DESCRIPTIONS[code] || `${code} role`;
    const record = await client.role.upsert({
      where: { code },
      update: {},
      create: {
        code,
        description,
      },
    });
    roles[code] = record.id;
  }

  return roles;
}

/**
 * Idempotently seeds admin users into PostgreSQL using Prisma.
 * Guarantees proper password hashing (Argon2id), active status,
 * verified email timestamp, customer profile, and ADMIN role association.
 */
export async function seedAdminUsers(client: PrismaClient = prisma) {
  console.log("===================================================================");
  console.log("   SEEDING SAFFRON VASTRA ADMIN USERS                              ");
  console.log("===================================================================\n");

  // Collect all distinct roles needed
  const requiredRoleCodes = Array.from(
    new Set(SAFFRON_ADMIN_USERS.flatMap((admin) => admin.roles))
  );

  const roleMap = await ensureRoles(client, requiredRoleCodes);
  console.log(`✓ Verified roles: ${requiredRoleCodes.join(", ")}`);

  const results: SeededAdminResult[] = [];

  for (const adminDef of SAFFRON_ADMIN_USERS) {
    const normalizedEmail = adminDef.email.toLowerCase().trim();
    const hashedPassword = await hashPassword(adminDef.password);

    // 1. Upsert User
    const user = await client.user.upsert({
      where: { email: normalizedEmail },
      update: {
        passwordHash: hashedPassword,
        status: adminDef.status || "ACTIVE",
        emailVerifiedAt: new Date(),
      },
      create: {
        email: normalizedEmail,
        passwordHash: hashedPassword,
        status: adminDef.status || "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });

    // 2. Upsert Profile
    await client.customerProfile.upsert({
      where: { userId: user.id },
      update: {
        displayName: adminDef.displayName,
        phone: adminDef.phone || null,
        tier: adminDef.tier || "Atelier VIP",
      },
      create: {
        userId: user.id,
        displayName: adminDef.displayName,
        phone: adminDef.phone || null,
        tier: adminDef.tier || "Atelier VIP",
      },
    });

    // 3. Upsert UserRole mappings
    const assignedRoles: string[] = [];
    for (const roleCode of adminDef.roles) {
      const roleId = roleMap[roleCode];
      if (roleId) {
        await client.userRole.upsert({
          where: {
            userId_roleId: {
              userId: user.id,
              roleId,
            },
          },
          update: {},
          create: {
            userId: user.id,
            roleId,
          },
        });
        assignedRoles.push(roleCode);
      }
    }

    console.log(`✓ Admin User Seeded:`);
    console.log(`  - Email:    ${user.email}`);
    console.log(`  - ID:       ${user.id}`);
    console.log(`  - Roles:    ${assignedRoles.join(", ")}`);
    console.log(`  - Status:   ${user.status}`);
    console.log(`  - Verified: Yes`);

    results.push({
      id: user.id,
      email: user.email,
      displayName: adminDef.displayName,
      status: user.status,
      roles: assignedRoles,
      emailVerified: Boolean(user.emailVerifiedAt),
    });
  }

  console.log("\n-------------------------------------------------------------------");
  console.log("✓ Saffron Vastra Admin Seeding Complete!");
  console.log(`  - Total Admin Users Seeded: ${results.length}`);
  console.log("-------------------------------------------------------------------\n");

  return {
    seededAdminsCount: results.length,
    admins: results,
  };
}

// Allow direct standalone execution via `tsx src/database/admin.seeder.ts`
const isDirectExecution =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith("admin.seeder.ts") ||
    process.argv[1].endsWith("admin.seeder.js") ||
    process.argv[1].includes("admin.seeder"));

if (isDirectExecution) {
  seedAdminUsers()
    .then(async () => {
      await prisma.$disconnect();
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("Admin user seeding failed:", e);
      await prisma.$disconnect();
      process.exit(1);
    });
}

