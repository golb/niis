class AuthorityError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthorityError";
  }
}

const TRANSITION_AUTHORITIES = Object.freeze({
  "PENDING->IN_PROGRESS": ["worker", "operator"],
  "PENDING->BLOCKED": ["operator", "validator"],
  "IN_PROGRESS->IN_REVIEW": ["worker", "operator"],
  "IN_PROGRESS->BLOCKED": ["operator", "validator"],
  "IN_REVIEW->DONE": ["reviewer", "validator", "operator"],
  "IN_REVIEW->REJECTED": ["reviewer", "validator", "operator"],
  "REJECTED->IN_PROGRESS": ["worker", "operator"],
});

function getAuthorityOwners(fromStatus, toStatus) {
  return TRANSITION_AUTHORITIES[`${fromStatus}->${toStatus}`] || [];
}

function assertTransitionAuthority({ fromStatus, toStatus, actorRole }) {
  const owners = getAuthorityOwners(fromStatus, toStatus);

  if (owners.length === 0) {
    throw new AuthorityError(`No authority mapping exists for transition ${fromStatus} -> ${toStatus}`);
  }

  if (!owners.includes(actorRole)) {
    throw new AuthorityError(
      `Actor role ${actorRole} is not allowed for transition ${fromStatus} -> ${toStatus}`,
    );
  }

  return true;
}

function createApprovalBlocker(reason) {
  return {
    blocker_class: "MISSING_APPROVAL",
    reason,
    next_action: "Use an allowed authority owner for the requested transition.",
  };
}

export {
  AuthorityError,
  TRANSITION_AUTHORITIES,
  assertTransitionAuthority,
  createApprovalBlocker,
  getAuthorityOwners,
};
