import { describe, expect, test } from "bun:test";
import { LineFramer, classify } from "../src/framing.ts";

describe("classify", () => {
  test("identifies a request", () => {
    const f = classify(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'));
    expect(f.kind).toBe("request");
    expect(f.method).toBe("tools/list");
    expect(f.id).toBe(1);
  });

  test("identifies a notification (no id)", () => {
    const f = classify(Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
    expect(f.kind).toBe("notification");
    expect(f.method).toBe("notifications/initialized");
  });

  test("identifies a successful response", () => {
    const f = classify(Buffer.from('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n'));
    expect(f.kind).toBe("response");
    expect(f.isError).toBe(false);
  });

  test("identifies an error response", () => {
    const f = classify(Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"x"}}\n'));
    expect(f.kind).toBe("response");
    expect(f.isError).toBe(true);
  });

  test("identifies a batch", () => {
    const f = classify(Buffer.from('[{"jsonrpc":"2.0","id":1,"method":"a"}]\n'));
    expect(f.kind).toBe("batch");
  });

  test("marks invalid json as malformed", () => {
    const f = classify(Buffer.from("not json at all\n"));
    expect(f.kind).toBe("malformed");
  });
});

describe("LineFramer", () => {
  test("emits one frame per newline-terminated line", () => {
    const framer = new LineFramer();
    const out = framer.push(
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"a"}\n' +
          '{"jsonrpc":"2.0","id":2,"method":"b"}\n',
      ),
    );
    expect(out.length).toBe(2);
    expect(out[0]?.method).toBe("a");
    expect(out[1]?.method).toBe("b");
  });

  test("handles partial reads across chunks", () => {
    const framer = new LineFramer();
    const r1 = framer.push(Buffer.from('{"jsonrpc":"2.0","id":1,"met'));
    expect(r1.length).toBe(0);
    const r2 = framer.push(Buffer.from('hod":"a"}\n'));
    expect(r2.length).toBe(1);
    expect(r2[0]?.method).toBe("a");
  });

  test("tolerates blank lines between messages", () => {
    const framer = new LineFramer();
    const out = framer.push(Buffer.from('\n{"jsonrpc":"2.0","id":1,"method":"a"}\n\n'));
    expect(out.length).toBe(1);
  });

  test("flush returns any un-terminated bytes", () => {
    const framer = new LineFramer();
    framer.push(Buffer.from('{"partial":'));
    const tail = framer.flush();
    expect(tail).not.toBeNull();
    expect(tail?.kind).toBe("malformed");
  });
});
