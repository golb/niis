class CostGuardError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "CostGuardError";
    this.code = options.code ?? "cost_exceeded";
  }
}

function createRunCostGuard({ capUsd = null } = {}) {
  const cap = Number.isFinite(Number(capUsd)) && Number(capUsd) > 0 ? Number(capUsd) : null;
  let accumulated = 0;
  let aborted = false;

  return {
    accumulate(deltaUsd) {
      const delta = Number(deltaUsd) || 0;
      if (delta > 0) {
        accumulated += delta;
      }
      if (cap !== null && accumulated >= cap) {
        aborted = true;
      }
      return accumulated;
    },
    cap() {
      return cap;
    },
    spent() {
      return accumulated;
    },
    shouldAbort() {
      return aborted;
    },
    reset() {
      accumulated = 0;
      aborted = false;
    },
  };
}

function createRoleBudgetGuard({ roleId, monthlyCap = null, currentSpend = 0 }) {
  const cap = Number.isFinite(Number(monthlyCap)) && Number(monthlyCap) > 0 ? Number(monthlyCap) : null;
  let spend = Number(currentSpend) || 0;

  return {
    canDispatch(estimatedDeltaUsd = 0) {
      if (cap === null) return true;
      return spend + (Number(estimatedDeltaUsd) || 0) < cap;
    },
    accumulate(deltaUsd) {
      const delta = Number(deltaUsd) || 0;
      spend += delta;
      return spend;
    },
    cap() {
      return cap;
    },
    spent() {
      return spend;
    },
    roleId() {
      return roleId;
    },
  };
}

function currentMonthBucket(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

export {
  CostGuardError,
  createRoleBudgetGuard,
  createRunCostGuard,
  currentMonthBucket,
};
