// Prices are display-only and always in euro: clients see the amount and settle at the studio.
// The editor keeps a duration's price as a number, so the input has to survive being emptied
// mid-edit without the row collapsing back to "free" the way a truthiness check on 0 would.
export const PRICE_CURRENCY = "EUR";
export const PRICE_SYMBOL = "€";

export function priceFromInput(raw: string): number {
  const parsed = Number(raw.trim());
  return raw.trim() === "" || !Number.isFinite(parsed) || parsed < 0 ? 0 : parsed;
}

export function priceInputValue(price: number | undefined): string | number {
  return price === undefined || price === 0 ? "" : price;
}

export function formatEuro(amount: number): string {
  return `${PRICE_SYMBOL}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
}
