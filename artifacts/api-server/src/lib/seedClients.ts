/**
 * seedClients.ts — Client Tenant Hierarchy Seed Data
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Seeds a realistic multi-tenant client hierarchy for development and demo
 * environments. Creates a staffing agency parent ("NexGen Staffing") with
 * several child client tenants, each with users and recruiter accounts.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * The function checks whether the "nexgen-staffing" slug already exists before
 * inserting anything. Safe to call on every server boot.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   lib/seed.ts  — invoked as part of the full demo data seeding flow
 */
import { db } from "@workspace/db";
import { tenantsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export async function seedClientHierarchy() {
  const existing = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "nexgen-staffing")).limit(1);
  if (existing.length > 0) return;

  const [acme] = await db.select().from(tenantsTable).where(eq(tenantsTable.slug, "acme-corp")).limit(1);
  if (acme) {
    await db.update(tenantsTable).set({
      clientType: "direct",
      industry: "Technology",
      website: "https://acmecorp.com",
      contactEmail: "hiring@acmecorp.com",
      address: "425 Market St, San Francisco, CA 94105",
      candidateDatabaseAccess: true,
      updatedAt: new Date(),
    }).where(eq(tenantsTable.slug, "acme-corp"));
  }

  const [nexgen] = await db.insert(tenantsTable).values({
    name: "NexGen Staffing",
    slug: "nexgen-staffing",
    plan: "enterprise",
    status: "active",
    clientType: "agency",
    industry: "Staffing & Recruitment",
    website: "https://nexgenstaffing.com",
    contactEmail: "ops@nexgenstaffing.com",
    address: "200 Park Ave, New York, NY 10166",
    candidateDatabaseAccess: true,
    primaryColor: "#0EA5E9",
  }).returning();

  await db.insert(usersTable).values([
    { tenantId: nexgen.id, email: "admin@nexgen.com", name: "Jordan Walsh", passwordHash: "demo_hash", role: "tenant_admin" },
    { tenantId: nexgen.id, email: "recruiter1@nexgen.com", name: "Avery Kim", passwordHash: "demo_hash", role: "recruiter" },
    { tenantId: nexgen.id, email: "recruiter2@nexgen.com", name: "Morgan Lee", passwordHash: "demo_hash", role: "recruiter" },
    { tenantId: nexgen.id, email: "hm@nexgen.com", name: "Taylor Brooks", passwordHash: "demo_hash", role: "hiring_manager" },
  ]);

  const [nexgenNY] = await db.insert(tenantsTable).values({
    name: "NexGen Staffing — New York",
    slug: "nexgen-new-york",
    parentId: nexgen.id,
    plan: "enterprise",
    status: "active",
    clientType: "branch",
    industry: "Staffing & Recruitment",
    website: "https://nexgenstaffing.com/ny",
    contactEmail: "ny@nexgenstaffing.com",
    address: "200 Park Ave, New York, NY 10166",
    candidateDatabaseAccess: true,
    primaryColor: "#0EA5E9",
  }).returning();

  const [nexgenLA] = await db.insert(tenantsTable).values({
    name: "NexGen Staffing — Los Angeles",
    slug: "nexgen-los-angeles",
    parentId: nexgen.id,
    plan: "growth",
    status: "active",
    clientType: "branch",
    industry: "Staffing & Recruitment",
    website: "https://nexgenstaffing.com/la",
    contactEmail: "la@nexgenstaffing.com",
    address: "10960 Wilshire Blvd, Los Angeles, CA 90024",
    candidateDatabaseAccess: true,
    primaryColor: "#0EA5E9",
  }).returning();

  const [nexgenCHI] = await db.insert(tenantsTable).values({
    name: "NexGen Staffing — Chicago",
    slug: "nexgen-chicago",
    parentId: nexgen.id,
    plan: "growth",
    status: "active",
    clientType: "branch",
    industry: "Staffing & Recruitment",
    contactEmail: "chicago@nexgenstaffing.com",
    address: "233 S Wacker Dr, Chicago, IL 60606",
    candidateDatabaseAccess: false,
    primaryColor: "#0EA5E9",
  }).returning();

  await db.insert(usersTable).values([
    { tenantId: nexgenNY.id, email: "admin@nexgen-ny.com", name: "Casey Rivera", passwordHash: "demo_hash", role: "tenant_admin" },
    { tenantId: nexgenNY.id, email: "rec@nexgen-ny.com", name: "Sam Torres", passwordHash: "demo_hash", role: "recruiter" },
    { tenantId: nexgenNY.id, email: "hm@nexgen-ny.com", name: "Dana Chen", passwordHash: "demo_hash", role: "hiring_manager" },
  ]);

  await db.insert(usersTable).values([
    { tenantId: nexgenLA.id, email: "admin@nexgen-la.com", name: "Riley Jackson", passwordHash: "demo_hash", role: "tenant_admin" },
    { tenantId: nexgenLA.id, email: "rec@nexgen-la.com", name: "Quinn Patel", passwordHash: "demo_hash", role: "recruiter" },
  ]);

  const [meridian] = await db.insert(tenantsTable).values({
    name: "Meridian Financial",
    slug: "meridian-financial",
    plan: "growth",
    status: "active",
    clientType: "direct",
    industry: "Financial Services",
    website: "https://meridianfinancial.com",
    contactEmail: "talent@meridianfinancial.com",
    address: "1 Financial Center, Boston, MA 02111",
    candidateDatabaseAccess: true,
    primaryColor: "#10B981",
  }).returning();

  await db.insert(usersTable).values([
    { tenantId: meridian.id, email: "admin@meridian.com", name: "Blair Nguyen", passwordHash: "demo_hash", role: "tenant_admin" },
    { tenantId: meridian.id, email: "rec@meridian.com", name: "Reese Murphy", passwordHash: "demo_hash", role: "recruiter" },
    { tenantId: meridian.id, email: "hm@meridian.com", name: "Sydney Park", passwordHash: "demo_hash", role: "hiring_manager" },
  ]);

  const [meridianBoston] = await db.insert(tenantsTable).values({
    name: "Meridian Financial — Boston HQ",
    slug: "meridian-boston",
    parentId: meridian.id,
    plan: "growth",
    status: "active",
    clientType: "branch",
    industry: "Financial Services",
    contactEmail: "boston@meridianfinancial.com",
    address: "1 Financial Center, Boston, MA 02111",
    candidateDatabaseAccess: true,
    primaryColor: "#10B981",
  }).returning();

  const [meridianNYC] = await db.insert(tenantsTable).values({
    name: "Meridian Financial — NYC",
    slug: "meridian-nyc",
    parentId: meridian.id,
    plan: "starter",
    status: "active",
    clientType: "branch",
    industry: "Financial Services",
    contactEmail: "nyc@meridianfinancial.com",
    address: "30 Rockefeller Plaza, New York, NY 10112",
    candidateDatabaseAccess: false,
    primaryColor: "#10B981",
  }).returning();

  const [blaze] = await db.insert(tenantsTable).values({
    name: "Blaze Ventures",
    slug: "blaze-ventures",
    plan: "starter",
    status: "trial",
    clientType: "direct",
    industry: "Venture Capital",
    website: "https://blazeventures.io",
    contactEmail: "team@blazeventures.io",
    address: "3000 Sand Hill Rd, Menlo Park, CA 94025",
    candidateDatabaseAccess: false,
    primaryColor: "#F59E0B",
  }).returning();

  await db.insert(usersTable).values([
    { tenantId: blaze.id, email: "admin@blaze.io", name: "Phoenix Clark", passwordHash: "demo_hash", role: "tenant_admin" },
    { tenantId: blaze.id, email: "rec@blaze.io", name: "Skyler Adams", passwordHash: "demo_hash", role: "recruiter" },
  ]);
}
