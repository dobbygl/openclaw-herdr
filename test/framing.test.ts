import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_LINE_LENGTH, LineDecoder, LineTooLongError, encodeRequest } from "../src/herdr/framing.js";

describe("LineDecoder", () => {
  it("splits complete lines and keeps the remainder", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"a":1}\n{"b":')).toEqual(['{"a":1}']);
    expect(decoder.pending()).toBe('{"b":');
    expect(decoder.push('2}\r\n\n')).toEqual(['{"b":2}']);
    expect(decoder.pending()).toBe("");
  });

  it("defaults to a 4 MiB line ceiling", () => {
    expect(new LineDecoder().maxLineLength).toBe(DEFAULT_MAX_LINE_LENGTH);
    expect(DEFAULT_MAX_LINE_LENGTH).toBe(4 * 1024 * 1024);
  });

  it("throws and drops the buffer when a peer never sends a newline", () => {
    const decoder = new LineDecoder({ maxLineLength: 16 });
    expect(decoder.push("12345678")).toEqual([]);
    expect(() => decoder.push("123456789")).toThrow(LineTooLongError);
    // Reset, so a misbehaving peer cannot keep growing this buffer.
    expect(decoder.pending()).toBe("");
    expect(decoder.push('{"a":1}\n')).toEqual(['{"a":1}']);
  });

  it("throws on a complete line that is too long", () => {
    const decoder = new LineDecoder({ maxLineLength: 8 });
    let error: unknown;
    try {
      decoder.push("123456789012\n");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(LineTooLongError);
    expect((error as LineTooLongError).limit).toBe(8);
    expect((error as LineTooLongError).length).toBe(12);
    expect(decoder.pending()).toBe("");
  });

  it("accepts a line exactly at the limit", () => {
    const decoder = new LineDecoder({ maxLineLength: 4 });
    expect(decoder.push("abcd\n")).toEqual(["abcd"]);
  });
});

describe("encodeRequest", () => {
  it("produces one newline-terminated JSON object with default params", () => {
    expect(encodeRequest("r1", "ping", undefined)).toBe('{"id":"r1","method":"ping","params":{}}\n');
  });
});
