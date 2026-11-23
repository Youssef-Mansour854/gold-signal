const HIGH_IMPACT_RELEASE_NAMES = [
  /^consumer price index\b/i,
  /^employment situation$/i,
  /^personal income and outlays$/i,
  /^gross domestic product$/i,
  /^producer price index$/i,
  /^advance monthly sales for retail and food services$/i,
  /^employment cost index$/i,
];

export function normalizeFredRelease(release) {
  if (
    !release ||
    !Number.isInteger(Number(release.release_id)) ||
    typeof release.release_name !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(release.date)
  ) {
    return null;
  }

  const date = new Date(`${release.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== release.date) {
    return null;
  }

  const name = release.release_name.trim();
  if (!HIGH_IMPACT_RELEASE_NAMES.some((pattern) => pattern.test(name))) return null;

  const releaseId = Number(release.release_id);
  return {
    id: `${releaseId}:${release.date}`,
    releaseId,
    name,
    date: release.date,
    impact: "high",
    source: "FRED",
  };
}

export function getNewYorkDate(instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isHighImpactReleaseDay(events, date) {
  return events.some((event) => event.date === date && event.impact === "high");
}
