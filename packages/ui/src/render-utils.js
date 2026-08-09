function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  if (!value) {
    return "in progress";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatMaybeList(values, emptyLabel = "none") {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : emptyLabel;
}

function formatDisplayLabel(value, emptyLabel = "Unknown") {
  const normalized = String(value ?? "").trim();
  if (normalized === "") {
    return emptyLabel;
  }

  return normalized
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function truncateText(value, limit = 96) {
  const normalized = String(value ?? "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export {
  escapeHtml,
  formatDisplayLabel,
  formatMaybeList,
  formatTimestamp,
  truncateText,
};
