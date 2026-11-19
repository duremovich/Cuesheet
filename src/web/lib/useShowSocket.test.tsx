import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "../test/dom";
import { type ShowSocketState, useShowSocket } from "./useShowSocket";

/** Just enough of a browser WebSocket to drive the hook. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send() {}
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    // Browsers fire close asynchronously.
    queueMicrotask(() => this.onclose?.());
  }
  open() {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  receive(msg: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
}

let latest: ShowSocketState | null = null;
function Harness() {
  latest = useShowSocket("show-1");
  return null;
}

beforeEach(() => {
  FakeSocket.all = [];
  latest = null;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const pageEvent = (type: "pagehide" | "pageshow", persisted: boolean) => {
  const e = new Event(type) as Event & { persisted: boolean };
  Object.defineProperty(e, "persisted", { value: persisted });
  return e;
};

describe("useShowSocket", () => {
  it("keeps the people count and the connection count from hello/presence", () => {
    render(<Harness />);
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    ws.receive({ type: "hello", showId: "show-1", clients: 3, people: 1, readOnly: 0 });
    expect(latest).toMatchObject({ status: "connected", clients: 3, people: 1, readOnly: 0 });
    ws.receive({ type: "presence", clients: 4, people: 2, readOnly: 1, users: [] });
    expect(latest).toMatchObject({ clients: 4, people: 2, readOnly: 1 });
  });

  it("closes its socket when the page goes away (reload, navigation) and doesn't reconnect", async () => {
    render(<Harness />);
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    act(() => {
      window.dispatchEvent(pageEvent("pagehide", false));
    });
    // A close frame now, rather than leaving the server to notice the dropped connection.
    expect(ws.closed).toEqual({ code: 1000, reason: "page hidden" });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("reconnects when the page comes back from the back/forward cache", async () => {
    render(<Harness />);
    const ws = FakeSocket.all[0] as FakeSocket;
    ws.open();
    act(() => {
      window.dispatchEvent(pageEvent("pagehide", true));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    act(() => {
      window.dispatchEvent(pageEvent("pageshow", true));
    });
    expect(FakeSocket.all).toHaveLength(2);
    const again = FakeSocket.all[1] as FakeSocket;
    again.open();
    again.receive({ type: "hello", showId: "show-1", clients: 1, people: 1 });
    expect(latest).toMatchObject({ status: "connected", people: 1 });
  });

  it("a normal page load's pageshow doesn't open a second socket", () => {
    render(<Harness />);
    act(() => {
      window.dispatchEvent(pageEvent("pageshow", false));
    });
    expect(FakeSocket.all).toHaveLength(1);
  });
});
