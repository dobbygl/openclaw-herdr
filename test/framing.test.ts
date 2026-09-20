import { describe, expect, it } from "vitest";
import { LineDecoder, encodeRequest } from "../src/herdr/framing.js";

describe("LineDecoder", () => {
  it("splits complete lines and keeps the remainder", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(decoder.pending()).toBe('{"b":');
    expect(decoder.push('2}\r\n\n')).toEqual(['{"b":2}']);
    expect(decoder.pending()).toBe("");
  });
});

describe("encodeRequest", () => {
  it("produces one newline-terminated JSON object with default params", () => {
    expect(encodeRequest("r1", "ping", undefined)).toBe('{"id":"r1","method":"ping","params":{}}\n');
  });
});
