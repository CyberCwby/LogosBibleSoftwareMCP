import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("../src/config.js", () => ({
  BIBLIA_API_KEY: "test-key",
  BIBLIA_API_BASE: "https://api.biblia.test/v1/bible",
  DEFAULT_BIBLE: "LEB",
}));

function mockResponse(options: {
  ok: boolean;
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}) {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    ...(options.headers ?? {}),
  });

  return {
    ok: options.ok,
    status: options.status,
    headers,
    json: vi.fn(async () => options.body),
    text: vi.fn(async () => typeof options.body === "string" ? options.body : JSON.stringify(options.body)),
  } as unknown as Response;
}

describe("biblia-api", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns passage text and caches repeated requests", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: "For God so loved the world",
        contentType: "text/plain",
      })
    );

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getBibleText("John 3:16")).resolves.toEqual({
      passage: "John 3:16",
      text: "For God so loved the world",
      bible: "LEB",
    });

    await expect(bibliaApi.getBibleText("John 3:16")).resolves.toEqual({
      passage: "John 3:16",
      text: "For God so loved the world",
      bible: "LEB",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects empty passage responses instead of returning a silent empty success", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: "  \n ",
        contentType: "text/plain",
      })
    );

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getBibleText("John 3:99")).rejects.toMatchObject({
      name: "BibliaApiError",
      code: "unexpected_response",
      message: expect.stringContaining("John 3:99"),
    });
  });

  it("classifies 403 responses as authentication failures", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 403,
        body: "<title>403 - Forbidden</title>",
        contentType: "text/html",
      })
    );

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getBibleText("John 3:16")).rejects.toMatchObject({
      name: "BibliaApiError",
      code: "authentication_failed",
      status: 403,
    });
  });

  it("retries rate-limited requests before succeeding", async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 429,
          body: "Too many requests",
          contentType: "text/plain",
          headers: { "retry-after": "0" },
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          ok: true,
          status: 200,
          body: {
            resultCount: 1,
            results: [{ title: "John 3:16", preview: "For God so loved..." }],
          },
        })
      );

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.searchBible("love")).resolves.toEqual({
      query: "love",
      resultCount: 1,
      results: [{ title: "John 3:16", preview: "For God so loved..." }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid Bible version ids before making a request", async () => {
    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getBibleText("John 3:16", "../search")).rejects.toMatchObject({
      name: "BibliaApiError",
      code: "invalid_request",
    });
    await expect(bibliaApi.searchBible("love", { bible: "LEB?key=x" })).rejects.toMatchObject({
      name: "BibliaApiError",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uppercases valid Bible version ids", async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        ok: true,
        status: 200,
        body: "In the beginning",
        contentType: "text/plain",
      })
    );

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getBibleText("Genesis 1:1", "kjv")).resolves.toMatchObject({
      bible: "KJV",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/content/KJV.txt");
  });

  it("surfaces network failures with an actionable message", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));

    const bibliaApi = await import("../src/services/biblia-api.js");

    await expect(bibliaApi.getAvailableBibles()).rejects.toMatchObject({
      name: "BibliaApiError",
      code: "network_error",
    });
  });
});