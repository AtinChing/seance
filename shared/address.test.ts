import { describe, expect, it } from "vitest";
import {
  addressFor, extractEmail, isAskerAddress, isGhostAddress, localPart,
  newAskerAddress, shortIdFor, shortIdFromAddress,
} from "./address.ts";

describe("address helpers", () => {
  it("builds and parses ghost addresses, ignoring domain", () => {
    expect(addressFor("7f3a1b2c", "x.example")).toBe("s-7f3a1b2c@x.example");
    expect(shortIdFromAddress("s-7f3a1b2c@safe-maple.primitive.email")).toBe("7f3a1b2c");
    expect(shortIdFromAddress("S-7F3A1B2C@other.domain")).toBe("7f3a1b2c");
    expect(shortIdFromAddress("Claude session <s-7f3a1b2c@any.where>")).toBe("7f3a1b2c");
    expect(shortIdFromAddress("s-7f3a1b2@x.y")).toBeNull();
    expect(shortIdFromAddress("s-7f3a1b2cz@x.y")).toBeNull();
    expect(shortIdFromAddress("test@x.y")).toBeNull();
  });
  it("short id is first 8 hex of the uuid", () => {
    expect(shortIdFor("c582ae8f-939d-42fe-94dd-cec74d30d65d")).toBe("c582ae8f");
  });
  it("classifies addresses", () => {
    expect(isGhostAddress("s-deadbeef@a.b")).toBe(true);
    expect(isAskerAddress("ask-abc123@a.b")).toBe(true);
    expect(isAskerAddress("s-deadbeef@a.b")).toBe(false);
    expect(isAskerAddress(newAskerAddress("a.b"))).toBe(true);
  });
  it("extracts emails from display-name forms", () => {
    expect(extractEmail("Atin Kumar Singh <Atin@Gmail.com>")).toBe("atin@gmail.com");
    expect(localPart("a.b@c.d")).toBe("a.b");
  });
});
