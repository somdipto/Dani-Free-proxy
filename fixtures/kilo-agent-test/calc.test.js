import { test, expect } from "bun:test";
import { add } from "./calc.js";

test("adds numbers", () => {
  expect(add(2, 3)).toBe(5);
});
