// A throwing part of the window shows its fallback; "Try again" brings the part back. Exercised through
// React's own error-boundary lifecycle, without a DOM.
import { describe, expect, it, vi } from "vitest";
import { Boundary, type BoundaryProps } from "../../apps/desktop/src/renderer/boundary";

const child = "the thread";
const make = () => {
  const fallback = vi.fn((retry: () => void, error: Error) => ({ retry, message: error.message }));
  // The fallback returns a plain object here, so the test can read what it was given.
  const b = new Boundary({ name: "Today", children: child, fallback: fallback as unknown as BoundaryProps["fallback"] });
  b.setState = (next) => Object.assign(b.state, typeof next === "function" ? next(b.state, b.props) : next); // no renderer to schedule it
  return { b, fallback };
};

describe("Boundary", () => {
  it("renders its children while nothing has thrown", () => {
    expect(make().b.render()).toBe(child);
  });

  it("a thrown query error renders the fallback, logged once with the part's name", () => {
    const { b, fallback } = make();
    const error = new Error("[CONVEX Q(briefs:getReentry)] Server Error: ReturnsValidationError");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    Object.assign(b.state, Boundary.getDerivedStateFromError(error));
    b.componentDidCatch(error);
    expect(b.render()).toMatchObject({ message: error.message });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual(["TARS: Today could not load.", error]);
    log.mockRestore();
  });

  it("Try again clears the error, so the children render (and subscribe) again", () => {
    const { b } = make();
    Object.assign(b.state, Boundary.getDerivedStateFromError("not an Error"));
    const shown = b.render() as unknown as { retry(): void; message: string };
    expect(shown.message).toBe("not an Error");
    shown.retry();
    expect(b.render()).toBe(child);
  });
});
