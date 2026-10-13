import { describe, expect, it } from "bun:test";
import { parseIncome } from "./incomeParser";

describe("parseIncome", () => {
  it("should parse income correctly", () => {
    const income = parseIncome("50");
    expect(income).toBe(50);
  });

  it("should return zero when input is empty", () => {
    const income = parseIncome("");
    expect(income).toBe(0);
  });

  it("should return zero when input is not a number", () => {
    const income = parseIncome("abc");
    expect(income).toBe(0);
  });

  it("should return the proper value when input is negative", () => {
    const income = parseIncome("-50");
    expect(income).toBe(-50);
  });

  it("should return zero when input is null", () => {
    // @ts-expect-error
    const income = parseIncome(null);
    expect(income).toBe(0);
  });

  it("should return zero when input is undefined", () => {
    // @ts-expect-error
    const income = parseIncome(undefined);
    expect(income).toBe(0);
  });

  it("should return zero when input is NaN", () => {
    // @ts-expect-error
    const income = parseIncome(NaN);
    expect(income).toBe(0);
  });

  it("should convert octal to decimal when input is an octal", () => {
    const income = parseIncome("0x8");
    expect(income).toBe(8);
  });
});
