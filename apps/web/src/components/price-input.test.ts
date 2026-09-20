import { describe, expect, it } from "vitest";
import { formatEuro, priceFromInput, priceInputValue } from "./price-input";

describe("price input", () => {
  it("keeps an emptied field on the paid path instead of collapsing to free", () => {
    expect(priceFromInput("")).toBe(0);
    expect(priceFromInput("   ")).toBe(0);
    expect(priceInputValue(0)).toBe("");
  });

  it("parses whole and decimal euro amounts", () => {
    expect(priceFromInput("25")).toBe(25);
    expect(priceFromInput("27.50")).toBe(27.5);
    expect(priceInputValue(27.5)).toBe(27.5);
  });

  it("never stores a negative or non-numeric price", () => {
    expect(priceFromInput("-5")).toBe(0);
    expect(priceFromInput("abc")).toBe(0);
  });

  it("formats euro without a currency code", () => {
    expect(formatEuro(25)).toBe("€25");
    expect(formatEuro(27.5)).toBe("€27.50");
  });
});
