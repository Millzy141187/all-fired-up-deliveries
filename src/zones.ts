// Area-based delivery rounds. Each weekday has one zone; a customer's postcode
// district decides which day of the week they can book.

import { weekdayIndex } from "./time";

export interface DeliveryZone {
  id: string;
  name: string;
  dayLabel: string;
  weekdays: number[];
  districts: string[];
  /**
   * Driving distance from the yard (NR19 2LA) to the round's main town
   * centre, measured by road rather than as the crow flies.
   */
  roadMiles: number;
}

function districtRange(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${from + index}`);
}

export const DELIVERY_ZONES: DeliveryZone[] = [
  {
    id: "dereham",
    name: "Dereham & Swaffham",
    dayLabel: "Monday",
    weekdays: [1],
    districts: ["NR17", "NR19", "NR20"],
    roadMiles: 4,
  },
  {
    id: "norwich",
    name: "Norwich",
    dayLabel: "Tuesday",
    weekdays: [2],
    districts: districtRange("NR", 1, 8),
    roadMiles: 20,
  },
  {
    id: "ipswich",
    name: "Ipswich",
    dayLabel: "Wednesday",
    weekdays: [3],
    districts: districtRange("IP", 1, 7),
    roadMiles: 56,
  },
  {
    id: "kings-lynn",
    name: "King's Lynn",
    dayLabel: "Thursday",
    weekdays: [4],
    districts: districtRange("PE", 30, 38),
    roadMiles: 25,
  },
  {
    id: "cambridge",
    name: "Cambridge",
    dayLabel: "Friday",
    weekdays: [5],
    districts: districtRange("CB", 1, 5),
    roadMiles: 57,
  },
];

const ZONE_BY_ID = new Map(DELIVERY_ZONES.map((zone) => [zone.id, zone]));

/** NR19 2LA -> NR19, PE30 1AA -> PE30. */
export function postcodeDistrict(postcode: string): string | null {
  const compact = String(postcode || "").toUpperCase().replace(/\s+/g, "");
  if (compact.length < 5) return null;
  // Split off the inward code first: NR22RN is NR2 + 2RN, not NR22 + RN.
  const outward = compact.slice(0, compact.length - 3);
  const match = outward.match(/^([A-Z]{1,2}\d{1,2})[A-Z]?$/);
  return match ? match[1] : null;
}

export function zoneForPostcode(postcode: string): DeliveryZone | null {
  const district = postcodeDistrict(postcode);
  if (!district) return null;
  return DELIVERY_ZONES.find((zone) => zone.districts.includes(district)) ?? null;
}

export function zoneForDate(date: string): DeliveryZone | null {
  const weekday = weekdayIndex(date);
  return DELIVERY_ZONES.find((zone) => zone.weekdays.includes(weekday)) ?? null;
}

export function zoneById(id: string): DeliveryZone | null {
  return ZONE_BY_ID.get(id) ?? null;
}
