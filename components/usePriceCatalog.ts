"use client";

import { useEffect, useState } from "react";
import { loadPriceCatalog, type PriceCatalog } from "@/lib/llm/pricing";

/** The model price list (null until loaded, or if it can't be reached). */
export function usePriceCatalog(enabled = true): PriceCatalog | null {
  const [cat, setCat] = useState<PriceCatalog | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadPriceCatalog().then((c) => { if (live) setCat(c); });
    return () => { live = false; };
  }, [enabled]);
  return cat;
}
