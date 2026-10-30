import { describe, expect, it } from "vitest";
import { asciiSkeleton, identityKey, imitates, skeleton, unicodeTrick } from "../src/identity.ts";

describe("skeleton", () => {
  it("folds case, spacing, punctuation and accents", () => {
    expect(skeleton("Bitcoin  USD!")).toBe("bitcoinusd");
    expect(skeleton("Pokémon")).toBe("pokemon");
  });
  it("folds Cyrillic and Greek lookalikes", () => {
    expect(skeleton("UЅDС")).toBe("usdc"); // Cyrillic Ѕ and С
    expect(skeleton("ΒΑSE")).toBe("base"); // Greek capital Beta and Alpha
    expect(asciiSkeleton("Τοshі")).toBe("toshi"); // Greek Τ, ο and Cyrillic і
  });
  it("folds full-width and styled letters", () => {
    expect(skeleton("ＵＳＤＣ")).toBe("usdc");
    expect(skeleton("𝐔𝐒𝐃𝐂")).toBe("usdc");
  });
  it("drops invisible characters", () => {
    expect(skeleton("US​DC")).toBe("usdc");
  });
  it("keeps other scripts so CJK names still group", () => {
    expect(identityKey("一个优秀的前任")).toBe("一个优秀的前任");
    expect(identityKey("USD𖼊")).not.toBe(identityKey("USD"));
  });
});

describe("unicodeTrick", () => {
  it("passes plain names", () => {
    expect(unicodeTrick("Burrito")).toBeUndefined();
    expect(unicodeTrick("一个优秀的前任就像死了一样")).toBeUndefined();
    expect(unicodeTrick("Safu by Virtuals")).toBeUndefined();
  });
  it("catches the USD𖼊 pattern seen on mainnet", () => {
    const t = unicodeTrick("USD𖼊")!;
    expect(t.kind).toBe("mixed-script");
    expect(t.detail).toContain("U+16F0A");
  });
  it("catches lookalikes, styled letters and invisibles", () => {
    expect(unicodeTrick("UЅDС")?.kind).toBe("lookalike");
    expect(unicodeTrick("ＵＳＤＣ")?.kind).toBe("styled");
    expect(unicodeTrick("US​DC")?.kind).toBe("invisible");
    expect(unicodeTrick("US​DC")?.kind).toBe("invisible"); // regex state reset
  });
});

describe("imitates", () => {
  it("matches symbols of well-known assets, however they are disguised", () => {
    expect(imitates("Bitcoin USD", "BTC")?.symbol).toBe("BTC");
    expect(imitates("x", "ＵＳＤＣ")?.symbol).toBe("USDC");
    expect(imitates("x", "U.S.D.C")?.symbol).toBe("USDC");
    expect(imitates("x", "cbbtc")?.symbol).toBe("cbBTC");
    expect(imitates("x", "USD𖼊")?.symbol).toBe("USD");
  });
  it("matches exact names", () => {
    expect(imitates("Coinbase Wrapped BTC", "CWB")?.symbol).toBe("cbBTC");
  });
  it("leaves unrelated tokens alone", () => {
    expect(imitates("Burrito", "BURRITO")).toBeUndefined();
    expect(imitates("GitLab Inc.", "GTLBc")).toBeUndefined();
    expect(imitates("Based", "BASED")).toBeUndefined();
  });
});
