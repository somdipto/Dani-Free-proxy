import { afterEach, describe, expect, it } from "bun:test";
import { envHost, envNumber } from "../src/env-number";

const NAMES = ["DANI_FREE_TEST_NUMBER", "DANI_FREE_TEST_HOST"];

afterEach(() => {
  for (const name of NAMES) delete process.env[name];
});

describe("envNumber", () => {
  it("returns the fallback when the variable is unset or blank", () => {
    expect(envNumber("DANI_FREE_TEST_NUMBER", 42, 1, 100)).toBe(42);
    process.env.DANI_FREE_TEST_NUMBER = "   ";
    expect(envNumber("DANI_FREE_TEST_NUMBER", 42, 1, 100)).toBe(42);
  });

  it("parses a valid integer in range", () => {
    process.env.DANI_FREE_TEST_NUMBER = "55";
    expect(envNumber("DANI_FREE_TEST_NUMBER", 42, 1, 100)).toBe(55);
  });

  it("falls back with a warning on non-numeric, fractional, or out-of-range input", () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (message: string) => { logged.push(message); };
    try {
      for (const bad of ["oops", "55.5", "0", "101", "1e3"]) {
        process.env.DANI_FREE_TEST_NUMBER = bad;
        expect(envNumber("DANI_FREE_TEST_NUMBER", 42, 1, 100)).toBe(42);
      }
      expect(logged.length).toBe(5);
      expect(logged[0]).toContain("ignoring invalid DANI_FREE_TEST_NUMBER");
    } finally {
      console.error = original;
    }
  });
});

describe("envHost", () => {
  it("trims the value and falls back on unset or blank", () => {
    expect(envHost("DANI_FREE_TEST_HOST", "127.0.0.1")).toBe("127.0.0.1");
    process.env.DANI_FREE_TEST_HOST = "  0.0.0.0  ";
    expect(envHost("DANI_FREE_TEST_HOST", "127.0.0.1")).toBe("0.0.0.0");
    process.env.DANI_FREE_TEST_HOST = "  ";
    expect(envHost("DANI_FREE_TEST_HOST", "127.0.0.1")).toBe("127.0.0.1");
  });
});
