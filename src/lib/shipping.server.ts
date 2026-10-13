// Live carrier rates from Shippo (https://goshippo.com). Server only: the API key is the SHIPPO_API_KEY secret.
// One request per quote: POST /shipments with the ship-from address, the winner's address and the prize's box;
// Shippo answers with rates from the carriers on the Shippo account (USPS, UPS, FedEx, DHL…).

export type ShipAddress = {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  zip: string;
  country: string; // ISO 3166-1 alpha-2
  phone?: string;
  email?: string;
};
export type Parcel = { weight_oz: number; length_in: number; width_in: number; height_in: number };
export type ShipRate = { id: string; carrier: string; service: string; days: number | null; usd: string };

export const shippoReady = () => !!process.env["SHIPPO_API_KEY"]?.trim();

const clean = (a: ShipAddress) =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, String(v).trim()]));

/** Carrier rates in US dollars, cheapest first (at most `max`). Throws a player-friendly message on failure. */
export async function shippoRates(from: ShipAddress, to: ShipAddress, parcel: Parcel, max = 8): Promise<ShipRate[]> {
  const key = process.env["SHIPPO_API_KEY"]?.trim();
  if (!key) throw new Error("Shipping prices aren't switched on yet. Choose pick-up, or try again later.");
  let res: Response;
  try {
    res = await fetch("https://api.goshippo.com/shipments/", {
      method: "POST",
      headers: { Authorization: `ShippoToken ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        address_from: clean(from),
        address_to: clean(to),
        parcels: [
          {
            length: String(parcel.length_in),
            width: String(parcel.width_in),
            height: String(parcel.height_in),
            distance_unit: "in",
            weight: String(parcel.weight_oz),
            mass_unit: "oz",
          },
        ],
        async: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("The shipping calculator didn't answer. Try again in a moment.");
  }
  const body = (await res.json().catch(() => null)) as {
    rates?: { object_id: string; amount: string; currency: string; provider: string; servicelevel?: { name?: string }; estimated_days?: number | null }[];
    messages?: { text?: string }[];
    detail?: string;
  } | null;
  if (!res.ok || !body) throw new Error(`The shipping calculator couldn't price this (${body?.detail ?? res.status}).`);
  const rates = (body.rates ?? [])
    .filter((r) => r.currency === "USD" && /^\d+(\.\d+)?$/.test(r.amount))
    .map((r) => ({ id: r.object_id, carrier: r.provider, service: r.servicelevel?.name ?? "Standard", days: r.estimated_days ?? null, usd: Number(r.amount).toFixed(2) }))
    .sort((a, b) => Number(a.usd) - Number(b.usd));
  if (!rates.length) {
    const why = (body.messages ?? []).map((m) => m.text).filter(Boolean).slice(0, 2).join(" ");
    throw new Error(`No carrier can ship to this address${why ? `: ${why}` : ""}. Check the address, or choose pick-up.`);
  }
  // Keep the cheapest few, but make sure every carrier's cheapest option is there too.
  const seen = new Set<string>();
  const pick: ShipRate[] = [];
  for (const r of rates) if (!seen.has(r.carrier)) (seen.add(r.carrier), pick.push(r));
  for (const r of rates) if (pick.length < max && !pick.includes(r)) pick.push(r);
  return pick.sort((a, b) => Number(a.usd) - Number(b.usd)).slice(0, Math.max(max, seen.size));
}
