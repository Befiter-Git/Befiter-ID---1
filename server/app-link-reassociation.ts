export const APP_USER_REASSOCIATION_TTL_MS = 10 * 60 * 1000;
export const REASSOCIATION_APP_NAME = "befiter_com";

export interface ReassociationAppLink {
  id: string;
  befiterId: string;
  appName: string;
  appUserId: string;
  linkedAt: Date | string | null;
  metadata: Record<string, unknown> | null;
}

export interface ReassociationIdentity {
  id: string;
  email: string;
  currentPhone: string;
  appLinks: ReassociationAppLink[];
  [key: string]: unknown;
}

export interface ReassociationChallenge {
  id: string;
  befiterId: string;
  contactType: "email" | "phone";
  contactValue: string;
  verifiedByApp: string;
  purpose: "app_user_reassociation";
  subjectAppUserId: string;
  reference: string;
  verifiedAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
}

export interface ReassociationAuditRecord {
  id: string;
  befiterId: string;
  appName: string;
  previousAppUserId: string;
  newAppUserId: string;
  idempotencyKey: string;
  attestationReference: string;
  verifiedAt: Date;
  changedAt: Date;
}

export interface ReassociationInput {
  befiterId: string;
  appName: string;
  expectedAppUserId: string;
  newAppUserId: string;
  attestationReference: string;
  idempotencyKey: string;
}

export interface ReassociationTransaction {
  lockKeys(appName: string, idempotencyKey: string, newAppUserId: string): Promise<void>;
  findAuditByIdempotencyKey(appName: string, key: string): Promise<ReassociationAuditRecord | undefined>;
  lockIdentity(befiterId: string): Promise<Pick<ReassociationIdentity, "id" | "email" | "currentPhone"> | undefined>;
  lockChallenge(reference: string): Promise<ReassociationChallenge | undefined>;
  getAppLinks(befiterId: string): Promise<ReassociationAppLink[]>;
  findAppLinkByAppUserId(appName: string, appUserId: string): Promise<ReassociationAppLink | undefined>;
  consumeChallenge(reference: string, consumedAt: Date): Promise<boolean>;
  updateAppUserId(
    appLinkId: string,
    befiterId: string,
    appName: string,
    expectedAppUserId: string,
    newAppUserId: string,
  ): Promise<boolean>;
  insertAudit(
    input: Omit<ReassociationAuditRecord, "id" | "changedAt">,
  ): Promise<ReassociationAuditRecord>;
  getIdentityWithLinks(befiterId: string): Promise<ReassociationIdentity | undefined>;
}

export class ReassociationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ReassociationError";
  }
}

export function isAuthorizedReassociationApp(appName: string | undefined): boolean {
  return appName === REASSOCIATION_APP_NAME;
}

function conflict(message: string, code: string): never {
  throw new ReassociationError(message, 409, code);
}

function auditMatchesRequest(audit: ReassociationAuditRecord, input: ReassociationInput): boolean {
  return audit.befiterId === input.befiterId
    && audit.appName === input.appName
    && audit.previousAppUserId === input.expectedAppUserId
    && audit.newAppUserId === input.newAppUserId
    && audit.attestationReference === input.attestationReference;
}

export async function reassociateAppUserInTransaction(
  tx: ReassociationTransaction,
  input: ReassociationInput,
  now = new Date(),
) {
  if (!isAuthorizedReassociationApp(input.appName)) {
    throw new ReassociationError("Only the BeFiter.com application may reassociate its user link", 403, "APP_NOT_ALLOWED");
  }
  if (
    !input.befiterId.trim()
    || !input.expectedAppUserId.trim()
    || !input.newAppUserId.trim()
    || !input.attestationReference.trim()
    || input.attestationReference.length < 32
    || !input.idempotencyKey.trim()
  ) {
    throw new ReassociationError("All reassociation fields are required", 400, "VALIDATION_FAILED");
  }
  if (input.expectedAppUserId === input.newAppUserId) {
    throw new ReassociationError("The new Social user ID must differ from the current ID", 422, "SAME_APP_USER_ID");
  }

  await tx.lockKeys(input.appName, input.idempotencyKey, input.newAppUserId);

  const previousAttempt = await tx.findAuditByIdempotencyKey(input.appName, input.idempotencyKey);
  if (previousAttempt) {
    if (!auditMatchesRequest(previousAttempt, input)) {
      conflict("The idempotency key was already used for a different reassociation", "IDEMPOTENCY_KEY_REUSED");
    }
    if (!await tx.lockIdentity(input.befiterId)) {
      throw new ReassociationError("Identity not found", 404, "IDENTITY_NOT_FOUND");
    }
    const identity = await tx.getIdentityWithLinks(input.befiterId);
    if (!identity) throw new ReassociationError("Identity not found", 404, "IDENTITY_NOT_FOUND");
    const currentComLink = identity.appLinks.find((link) => link.appName === input.appName);
    if (currentComLink?.appUserId !== previousAttempt.newAppUserId) {
      conflict("This reassociation was superseded by a later link change", "REASSOCIATION_SUPERSEDED");
    }
    return {
      identity,
      reassociation: {
        changed: false,
        replayed: true,
        previousAppUserId: previousAttempt.previousAppUserId,
        newAppUserId: previousAttempt.newAppUserId,
        verifiedAt: previousAttempt.verifiedAt,
        changedAt: previousAttempt.changedAt,
        auditId: previousAttempt.id,
      },
    };
  }

  const identity = await tx.lockIdentity(input.befiterId);
  if (!identity) {
    throw new ReassociationError("Identity not found", 404, "IDENTITY_NOT_FOUND");
  }

  const challenge = await tx.lockChallenge(input.attestationReference);
  if (!challenge) {
    throw new ReassociationError("A matching contact verification is required", 403, "ATTESTATION_INVALID");
  }
  if (challenge.consumedAt) {
    conflict("This contact verification has already been used", "ATTESTATION_ALREADY_USED");
  }
  if (challenge.invalidatedAt) {
    conflict("This contact verification is no longer valid", "ATTESTATION_INVALIDATED");
  }
  if (challenge.verifiedByApp !== input.appName
    || challenge.befiterId !== input.befiterId
    || challenge.purpose !== "app_user_reassociation"
    || challenge.subjectAppUserId !== input.newAppUserId) {
    throw new ReassociationError("The contact verification does not match this reassociation", 403, "ATTESTATION_BINDING_MISMATCH");
  }

  const verifiedAt = challenge.verifiedAt.getTime();
  const ageMs = now.getTime() - verifiedAt;
  if (ageMs < 0 || ageMs > APP_USER_REASSOCIATION_TTL_MS) {
    conflict("The contact verification has expired", "ATTESTATION_EXPIRED");
  }

  const attestedContact = challenge.contactType === "email"
    ? challenge.contactValue.trim().toLowerCase()
    : challenge.contactValue;
  const currentContact = challenge.contactType === "email"
    ? identity.email.trim().toLowerCase()
    : identity.currentPhone;
  if (attestedContact !== currentContact) {
    conflict("The verified contact no longer matches the identity", "CONTACT_MISMATCH");
  }

  const links = await tx.getAppLinks(input.befiterId);
  const appLinks = links.filter((link) => link.appName === input.appName);
  if (appLinks.length === 0) {
    throw new ReassociationError("No existing BeFiter.com link was found", 404, "APP_LINK_NOT_FOUND");
  }
  if (appLinks.length !== 1) {
    conflict("The identity has multiple BeFiter.com links and cannot be safely reassociated", "APP_LINK_AMBIGUOUS");
  }
  const currentLink = appLinks[0];
  if (currentLink.appUserId !== input.expectedAppUserId) {
    conflict("The existing BeFiter.com user ID has changed", "EXPECTED_APP_USER_MISMATCH");
  }

  const existingNewUserLink = await tx.findAppLinkByAppUserId(input.appName, input.newAppUserId);
  if (existingNewUserLink) {
    conflict("The new Social user ID is already associated with an identity", "APP_USER_ALREADY_LINKED");
  }

  if (!await tx.consumeChallenge(input.attestationReference, now)) {
    conflict("This contact verification has already been used", "ATTESTATION_ALREADY_USED");
  }
  if (!await tx.updateAppUserId(
    currentLink.id,
    input.befiterId,
    input.appName,
    input.expectedAppUserId,
    input.newAppUserId,
  )) {
    conflict("The existing BeFiter.com link changed during reassociation", "EXPECTED_APP_USER_MISMATCH");
  }

  const audit = await tx.insertAudit({
    befiterId: input.befiterId,
    appName: input.appName,
    previousAppUserId: input.expectedAppUserId,
    newAppUserId: input.newAppUserId,
    idempotencyKey: input.idempotencyKey,
    attestationReference: input.attestationReference,
    verifiedAt: challenge.verifiedAt,
  });
  const updatedIdentity = await tx.getIdentityWithLinks(input.befiterId);
  if (!updatedIdentity) {
    throw new ReassociationError("Identity not found after reassociation", 404, "IDENTITY_NOT_FOUND");
  }

  return {
    identity: updatedIdentity,
    reassociation: {
      changed: true,
      replayed: false,
      previousAppUserId: audit.previousAppUserId,
      newAppUserId: audit.newAppUserId,
      verifiedAt: audit.verifiedAt,
      changedAt: audit.changedAt,
      auditId: audit.id,
    },
  };
}
