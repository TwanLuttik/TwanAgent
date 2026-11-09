import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bareUrlLabel, linkifyBareUrls } from "../bare-link.ts";

describe("linkifyBareUrls", () => {
  it("wraps a bare domain and path", () => {
    assert.equal(
      linkifyBareUrls("Try quickbooks.intuit.com/ca/free-trial and keep going."),
      "Try <https://quickbooks.intuit.com/ca/free-trial> and keep going.",
    );
  });

  it("leaves the trailing period outside the link", () => {
    assert.equal(linkifyBareUrls("See example.com/docs."), "See <https://example.com/docs>.");
  });

  it("does not linkify filenames, emails, or scheme URLs", () => {
    const input = "Open ChatMarkdown.tsx, mail a@example.com, and https://example.com/docs.";
    assert.equal(linkifyBareUrls(input), input);
  });

  it("skips code, autolinks, and markdown links", () => {
    const input = [
      "See `example.com` and",
      "```",
      "example.com/a",
      "```",
      "plus [docs](https://example.com/docs) and <https://example.com/ok>.",
    ].join("\n");
    assert.equal(linkifyBareUrls(input), input);
  });
});

describe("bareUrlLabel", () => {
  it("drops the scheme when the label is the URL", () => {
    assert.equal(
      bareUrlLabel("https://quickbooks.intuit.com/ca/free-trial", "https://quickbooks.intuit.com/ca/free-trial"),
      "quickbooks.intuit.com/ca/free-trial",
    );
  });

  it("keeps worded link labels", () => {
    assert.equal(bareUrlLabel("https://example.com/docs", "the docs"), null);
  });
});
