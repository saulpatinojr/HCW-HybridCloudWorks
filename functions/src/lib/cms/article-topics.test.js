/**
 * Article addresses are `<topic>-<8 id characters>` (#1628). These tests pin
 * the list, how a topic is chosen, and that every address passes the strict
 * lowercase rule the pre-render applies.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ARTICLE_TOPICS,
  ARTICLE_ID_CHARS,
  articleIdPart,
  articleSlugFor,
  isArticleTopic,
  suggestArticleTopic,
} from "./article-topics.js";

const FRONTEND = fileURLToPath(
  new URL("../../../../frontend/src/lib/articleTopics.js", import.meta.url),
);

describe("the topic list", () => {
  it("is lowercase single words, each a valid address start", () => {
    expect(ARTICLE_TOPICS.length).toBe(14);
    for (const topic of ARTICLE_TOPICS) expect(topic).toMatch(/^[a-z]+$/);
    expect(new Set(ARTICLE_TOPICS).size).toBe(ARTICLE_TOPICS.length);
  });

  it("is the same list, in the same order, as the admin dropdown", () => {
    const source = readFileSync(FRONTEND, "utf8");
    const match = source.match(
      /export const ARTICLE_TOPICS = Object\.freeze\(\[([^\]]*)\]\)/,
    );
    expect(
      match,
      "ARTICLE_TOPICS not found in frontend/src/lib/articleTopics.js",
    ).not.toBeNull();
    const words = [...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(words).toEqual([...ARTICLE_TOPICS]);
  });

  it("isArticleTopic accepts only the list", () => {
    expect(isArticleTopic("hybrid")).toBe(true);
    for (const bad of ["Hybrid", "copilot", "", null, undefined, 3])
      expect(isArticleTopic(bad)).toBe(false);
  });
});

describe("suggestArticleTopic", () => {
  it.each([
    ["Ansible + Azure Arc: Use Ansible Modules", "hybrid"],
    [
      "New Microsoft Certified: Azure AI Fundamentals Certification",
      "certification",
    ],
    [
      "NIST vs. Microsoft Zero Trust: Why Cloud Architects Should Care",
      "security",
    ],
    ["Microsoft Sovereign Cloud: Empowering Europe", "sovereignty"],
    [
      "Discover and Assess File Shares for Migration to Azure Files",
      "migration",
    ],
    ["Microsoft Foundry: End-to-End Observability", "ai"],
    ["Enable AI-Powered Discovery of Azure Updates", "governance"],
  ])("%s → %s", (title, topic) => {
    expect(suggestArticleTopic({ title })).toBe(topic);
  });

  it("reads the article title before the source headline, then the key topics and tags", () => {
    expect(
      suggestArticleTopic({
        title: "Sovereign cloud",
        Title: "Generally Available: SQL agent kit",
      }),
    ).toBe("sovereignty");
    expect(
      suggestArticleTopic({
        title: "A quiet week",
        keyTopics: ["Azure Policy"],
      }),
    ).toBe("governance");
    expect(
      suggestArticleTopic({ title: "A quiet week", Tags: ["Kubernetes"] }),
    ).toBe("compute");
  });

  it('matches whole words, so "ai" does not hit inside "maintain" or "said"', () => {
    expect(
      suggestArticleTopic({ title: "How to maintain what was said" }),
    ).toBeNull();
  });
});

describe("articleSlugFor", () => {
  it("uses the stored topic first, then keywords, then the provider", () => {
    const contentId = "LSzyB6gbiLyXtjQUcgGv";
    expect(
      articleSlugFor({
        contentData: { topic: "network", title: "Zero Trust" },
        contentId,
      }),
    ).toBe("network-lszyb6gb");
    expect(
      articleSlugFor({
        contentData: { topic: "copilot", title: "Zero Trust" },
        contentId,
      }),
    ).toBe("security-lszyb6gb");
    expect(
      articleSlugFor({
        contentData: { title: "A quiet week" },
        contentId,
        provider: "Azure",
      }),
    ).toBe("azure-lszyb6gb");
    expect(
      articleSlugFor({ contentData: { title: "A quiet week" }, contentId }),
    ).toBe("article-lszyb6gb");
  });

  it("takes 8 lowercase letters or digits of the id, and gives nothing without an id", () => {
    expect(ARTICLE_ID_CHARS).toBe(8);
    expect(articleIdPart("Ab-C_dEf9XyZ")).toBe("abcdef9x");
    expect(
      articleSlugFor({ contentData: { topic: "ai" }, contentId: "" }),
    ).toBe("");
  });
});
