import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_USER_REASSOCIATION_TTL_MS,
  isAuthorizedReassociationApp,
  ReassociationError,
  reassociateAppUserInTransaction,
  type ReassociationAppLink,
  type ReassociationAuditRecord,
  type ReassociationChallenge,
  type ReassociationIdentity,
  type ReassociationInput,
  type ReassociationTransaction,
} from "./app-link-reassociation";

const now = new Date("2026-11-06T12:00:00.000Z");

function makeLink(
  id: string,
  appName: string,
  appUserId: string,
  befiterId = "identity-1",
): ReassociationAppLink {
  return {
    id,
    befiterId,
    appName,
    appUserId,
    linkedAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: { preserved: true },
  };
}

function makeChallenge(overrides: Partial<ReassociationChallenge> = {}): ReassociationChallenge {
  return {
    id: "challenge-1",
    befiterId: "identity-1",
    contactType: "email",
    contactValue: "client@example.test",
    verifiedByApp: "befiter_com",
    purpose: "app_user_reassociation",
    subjectAppUserId: "social-new",
    reference: "5f47e3ba-7c1b-45a6-bc5a-bcf5a7d83289",
    verifiedAt: new Date(now.getTime() - 30_000),
    consumedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<ReassociationInput> = {}): ReassociationInput {
  return {
    befiterId: "identity-1",
    appName: "befiter_com",
    expectedAppUserId: "social-old",
    newAppUserId: "social-new",
    attestationReference: "5f47e3ba-7c1b-45a6-bc5a-bcf5a7d83289",
    idempotencyKey: "request-key-1",
    ...overrides,
  };
}

class FakeTransaction implements ReassociationTransaction {
  identity: ReassociationIdentity = {
    id: "identity-1",
    email: "client@example.test",
    currentPhone: "+919876543210",
    fullName: "Synthetic Client",
    appLinks: [
      makeLink("link-com", "befiter_com", "social-old"),
      makeLink("link-store", "befiter_store", "store-user-1"),
    ],
  };
  challenge = makeChallenge();
  audit: ReassociationAuditRecord[] = [];
  otherLinks: ReassociationAppLink[] = [];

  async lockKeys(): Promise<void> {}

  async findAuditByIdempotencyKey(appName: string, key: string) {
    return this.audit.find((row) => row.appName === appName && row.idempotencyKey === key);
  }

  async lockIdentity(befiterId: string) {
    if (this.identity.id !== befiterId) return undefined;
    const { id, email, currentPhone } = this.identity;
    return { id, email, currentPhone };
  }

  async lockChallenge(reference: string) {
    return this.challenge.reference === reference ? this.challenge : undefined;
  }

  async getAppLinks(befiterId: string) {
    return this.identity.appLinks.filter((link) => link.befiterId === befiterId);
  }

  async findAppLinkByAppUserId(appName: string, appUserId: string) {
    return [...this.identity.appLinks, ...this.otherLinks]
      .find((link) => link.appName === appName && link.appUserId === appUserId);
  }

  async consumeChallenge(reference: string, consumedAt: Date) {
    if (this.challenge.reference !== reference || this.challenge.consumedAt || this.challenge.invalidatedAt) {
      return false;
    }
    this.challenge.consumedAt = consumedAt;
    return true;
  }

  async updateAppUserId(
    appLinkId: string,
    befiterId: string,
    appName: string,
    expectedAppUserId: string,
    newAppUserId: string,
  ) {
    const link = this.identity.appLinks.find((item) =>
      item.id === appLinkId
      && item.befiterId === befiterId
      && item.appName === appName
      && item.appUserId === expectedAppUserId);
    if (!link) return false;
    link.appUserId = newAppUserId;
    return true;
  }

  async insertAudit(input: Omit<ReassociationAuditRecord, "id" | "changedAt">) {
    const row: ReassociationAuditRecord = {
      ...input,
      id: `audit-${this.audit.length + 1}`,
      changedAt: now,
    };
    this.audit.push(row);
    return row;
  }

  async getIdentityWithLinks(befiterId: string) {
    if (this.identity.id !== befiterId) return undefined;
    return {
      ...this.identity,
      appLinks: this.identity.appLinks.map((link) => ({ ...link, metadata: { ...link.metadata } })),
    };
  }
}

function assertReassociationError(code: string) {
  return (error: unknown) => error instanceof ReassociationError && error.code === code;
}

test("reassociates only the BeFiter.com link and preserves identity and Store link", async () => {
  const tx = new FakeTransaction();
  const beforeIdentity = { ...tx.identity };
  const beforeStoreLink = { ...tx.identity.appLinks[1] };

  const result = await reassociateAppUserInTransaction(tx, makeInput(), now);

  assert.equal(result.reassociation.changed, true);
  assert.equal(result.reassociation.previousAppUserId, "social-old");
  assert.equal(result.reassociation.newAppUserId, "social-new");
  assert.equal(result.identity.appLinks.find((link) => link.appName === "befiter_com")?.appUserId, "social-new");
  assert.deepEqual(tx.identity.appLinks[1], beforeStoreLink);
  assert.equal(tx.identity.email, beforeIdentity.email);
  assert.equal(tx.identity.currentPhone, beforeIdentity.currentPhone);
  assert.equal(tx.identity.fullName, beforeIdentity.fullName);
  assert.equal(tx.challenge.consumedAt?.toISOString(), now.toISOString());
  assert.equal(tx.audit.length, 1);
});

test("rejects an expired attestation without changing links", async () => {
  const tx = new FakeTransaction();
  tx.challenge.verifiedAt = new Date(now.getTime() - APP_USER_REASSOCIATION_TTL_MS - 1);

  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput(), now),
    assertReassociationError("ATTESTATION_EXPIRED"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  assert.equal(tx.challenge.consumedAt, null);
  assert.equal(tx.audit.length, 0);
});

test("rejects a previously consumed attestation", async () => {
  const tx = new FakeTransaction();
  tx.challenge.consumedAt = new Date(now.getTime() - 1_000);

  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput(), now),
    assertReassociationError("ATTESTATION_ALREADY_USED"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  assert.equal(tx.audit.length, 0);
});

test("rejects a wrong expected old Social user ID", async () => {
  const tx = new FakeTransaction();

  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput({ expectedAppUserId: "wrong-old" }), now),
    assertReassociationError("EXPECTED_APP_USER_MISMATCH"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  assert.equal(tx.challenge.consumedAt, null);
});

test("rejects a new Social ID already associated with another identity", async () => {
  const tx = new FakeTransaction();
  tx.otherLinks.push(makeLink("other-link", "befiter_com", "social-new", "identity-2"));

  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput(), now),
    assertReassociationError("APP_USER_ALREADY_LINKED"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  assert.equal(tx.challenge.consumedAt, null);
});

test("rejects callers other than befiter_com", async () => {
  const tx = new FakeTransaction();

  assert.equal(isAuthorizedReassociationApp("befiter_store"), false);
  assert.equal(isAuthorizedReassociationApp(undefined), false);
  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput({ appName: "befiter_store" }), now),
    assertReassociationError("APP_NOT_ALLOWED"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
});

test("retries with the same idempotency key return success without a second update", async () => {
  const tx = new FakeTransaction();
  const first = await reassociateAppUserInTransaction(tx, makeInput(), now);
  const retry = await reassociateAppUserInTransaction(tx, makeInput(), now);

  assert.equal(first.reassociation.changed, true);
  assert.equal(retry.reassociation.changed, false);
  assert.equal(retry.reassociation.replayed, true);
  assert.equal(tx.identity.appLinks[0].appUserId, "social-new");
  assert.equal(tx.audit.length, 1);
});

test("rejects reuse of an idempotency key for different request values", async () => {
  const tx = new FakeTransaction();
  await reassociateAppUserInTransaction(tx, makeInput(), now);

  await assert.rejects(
    reassociateAppUserInTransaction(tx, makeInput({ newAppUserId: "another-social-id" }), now),
    assertReassociationError("IDEMPOTENCY_KEY_REUSED"),
  );
  assert.equal(tx.identity.appLinks[0].appUserId, "social-new");
  assert.equal(tx.audit.length, 1);
});

test("rejects attestations bound to another Social ID or changed contact", async (t) => {
  await t.test("different subject ID", async () => {
    const tx = new FakeTransaction();
    tx.challenge.subjectAppUserId = "different-social-id";

    await assert.rejects(
      reassociateAppUserInTransaction(tx, makeInput(), now),
      assertReassociationError("ATTESTATION_BINDING_MISMATCH"),
    );
    assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  });

  await t.test("contact no longer matches", async () => {
    const tx = new FakeTransaction();
    tx.challenge.contactValue = "other@example.test";

    await assert.rejects(
      reassociateAppUserInTransaction(tx, makeInput(), now),
      assertReassociationError("CONTACT_MISMATCH"),
    );
    assert.equal(tx.identity.appLinks[0].appUserId, "social-old");
  });
});
