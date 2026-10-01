/**
 * When the Assistant fills a scorecard for a drawn AREA rather than a whole
 * city, not every indicator can differ inside that area. Governance, finance
 * and institutional questions (a resilience plan, a ring-fenced budget, an
 * emergency operations centre) belong to the whole jurisdiction. Questions
 * about physical exposure, infrastructure, service loss, shelters, and local
 * communities can genuinely vary from one district to the next.
 *
 * This fixed split keeps the labels predictable: area-specific indicators are
 * scored from the area's own evidence, city-wide ones describe the parent city.
 */

export type IndicatorScope = "area" | "city";

export const AREA_SPECIFIC_CODES: ReadonlySet<string> = new Set([
  "P2.1", // key hazards and their likelihood — exposure differs by location
  "P2.3", // exposure/vulnerability scenarios for this area
  "P3.3", // insurance cover among local households and businesses
  "P4.1", // zoning of this area against its risk scenarios
  "P4.2", // resilience in new development here
  "P4.4", // how well codes are enforced here (e.g. informal building)
  "P5.2", // green/blue infrastructure in local projects
  "P7.1", // grassroots groups in these neighbourhoods
  "P7.2", // training for this area's vulnerable populations
  "P7.3", // business continuity among local businesses
  "P8.2", // protective infrastructure serving this area
  "P8.3", // water/sanitation loss of service here
  "P8.4", // energy loss of service here
  "P8.5", // transport loss of service here
  "P8.6", // communications loss of service here
  "P8.7", // acute healthcare within reach of this area
  "P8.8", // schools at risk here
  "P8.9", // first-responder coverage (stations, equipment) for this area
  "P9.1", // early-warning reach for this area's population
  "P9.5", // food and shelter for this area's population post-event
]);

export function scopeOf(code: string): IndicatorScope {
  return AREA_SPECIFIC_CODES.has(code) ? "area" : "city";
}
