// Countries for shipping addresses: ISO 3166-1 alpha-2 code (what carriers need) and the name shown.
export const COUNTRIES: [code: string, name: string][] = [
  ["US", "United States"], ["CA", "Canada"], ["MX", "Mexico"], ["GB", "United Kingdom"], ["IE", "Ireland"],
  ["AU", "Australia"], ["NZ", "New Zealand"], ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["PT", "Portugal"],
  ["IT", "Italy"], ["NL", "Netherlands"], ["BE", "Belgium"], ["LU", "Luxembourg"], ["CH", "Switzerland"], ["AT", "Austria"],
  ["DK", "Denmark"], ["SE", "Sweden"], ["NO", "Norway"], ["FI", "Finland"], ["IS", "Iceland"], ["PL", "Poland"],
  ["CZ", "Czechia"], ["SK", "Slovakia"], ["HU", "Hungary"], ["RO", "Romania"], ["BG", "Bulgaria"], ["GR", "Greece"],
  ["HR", "Croatia"], ["SI", "Slovenia"], ["EE", "Estonia"], ["LV", "Latvia"], ["LT", "Lithuania"], ["MT", "Malta"],
  ["CY", "Cyprus"], ["UA", "Ukraine"], ["TR", "Türkiye"], ["IL", "Israel"], ["AE", "United Arab Emirates"],
  ["SA", "Saudi Arabia"], ["QA", "Qatar"], ["IN", "India"], ["PK", "Pakistan"], ["SG", "Singapore"], ["MY", "Malaysia"],
  ["TH", "Thailand"], ["VN", "Vietnam"], ["PH", "Philippines"], ["ID", "Indonesia"], ["HK", "Hong Kong"], ["TW", "Taiwan"],
  ["KR", "South Korea"], ["JP", "Japan"], ["CN", "China"], ["BR", "Brazil"], ["AR", "Argentina"], ["CL", "Chile"],
  ["CO", "Colombia"], ["PE", "Peru"], ["CR", "Costa Rica"], ["PA", "Panama"], ["DO", "Dominican Republic"],
  ["PR", "Puerto Rico"], ["JM", "Jamaica"], ["BS", "Bahamas"], ["ZA", "South Africa"], ["NG", "Nigeria"], ["KE", "Kenya"],
  ["GH", "Ghana"], ["EG", "Egypt"], ["MA", "Morocco"],
];

/** The ISO code for a country name or code people typed ("United States", "usa", "US"…), or null. */
export function countryCode(input: string | null | undefined): string | null {
  const t = (input ?? "").trim().toLowerCase();
  if (!t) return null;
  if (["usa", "u.s.", "u.s.a.", "united states of america", "america"].includes(t)) return "US";
  if (["uk", "england", "scotland", "wales", "great britain"].includes(t)) return "GB";
  const hit = COUNTRIES.find(([c, n]) => c.toLowerCase() === t || n.toLowerCase() === t);
  return hit ? hit[0] : null;
}
export const countryName = (code: string) => COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
