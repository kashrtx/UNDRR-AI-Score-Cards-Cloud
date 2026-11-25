"use client";

/**
 * Assistant + Scorecard tabs: AI helpers that fill out the UNDRR ARISE
 * Preliminary scorecard, and the live scorecards they fill.
 *
 * Every AI helper picked in Settings gets its own lane (see AgentLane): its own
 * chat and its own copy of the scorecard, shown as a sub-tab on both the
 * Assistant and Scorecard tabs. "Fill it out for me" starts all of them at once,
 * in parallel. This component owns what the helpers share: the place (city or
 * drawn area), notes, attached reference documents, and the saved sessions.
 *   • Each helper streams its output live, can be stopped, and Continues later.
 *   • Saved chat history: switch between scorecards, start new, delete.
 *   • Attach reference documents (shared by every helper).
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import {
  Bot, Sparkles, Loader2, Download, ClipboardCheck, Plus, X, AlertTriangle, History, ChevronDown, Coins,
  Building2, Map as MapIcon, FileArchive,
} from "lucide-react";
import {
  selectedProviders, providerIsReady, PROVIDER_LABEL,
  type AppSettings, type ProviderId,
} from "@/lib/settings/store";
import { uploadScorecard } from "@/lib/client/api";
import { TOTAL_INDICATORS } from "@/lib/scorecard/preliminaryTemplate";
import type { NormalizedScorecard } from "@/lib/scorecard/schema";
import { emptyDraft, filledCount, mergeScorecardIntoDraft, draftToScorecard, type CityInfo } from "@/lib/agent/draft";
import { ModelSuggestion } from "@/components/ModelSuggestion";
import {
  createSession, listSessions, loadSession, saveSession, deleteSession, getActiveId, setActiveId, lanesOf, emptyLane,
  type AssistantSession, type SessionMeta, type ChatItem, type Attachment, type LaneData,
} from "@/lib/agent/sessions";
import { ConfirmModal } from "@/components/ConfirmModal";
import { SessionMenu } from "@/components/SessionMenu";
import { AreaPicker } from "@/components/AreaPicker";
import { shapeOf, type SavedShape } from "@/lib/analysis/library";
import { CostComparison } from "@/components/CostComparison";
import { usePriceCatalog } from "@/components/usePriceCatalog";
import { costOf, formatUsd, formatTokens } from "@/lib/llm/pricing";
import { AgentLane, type LaneHandle, type LaneShared, type LaneStatus, type ConfirmRequest } from "@/components/AgentLane";
import { validateArea, describeArea, formatKm2, makeArea, type AreaSelection, type LonLat } from "@/lib/geo/area";
import { buildAreaShapefile, shapefileName } from "@/lib/geo/shapefile";
import { COUNTRIES, countryByCode, countryCodeFor, regionsOf, findRegion } from "@/lib/geo/countries";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|rtf|html?|xml|yaml|yml)$/i;
const MAX_ATTACH_CHARS = 12000;

// Lazy-load pdf.js from a CDN only when a PDF is actually attached, so we don't
// add a build dependency. Returns extracted text, or throws so the caller can
// fall back to asking the user to paste the text.
let pdfjsPromise: Promise<unknown> | null = null;
function loadPdfJs(): Promise<{ getDocument: (opts: unknown) => { promise: Promise<unknown> } } & Record<string, unknown>> {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const w = window as unknown as Record<string, unknown>;
      if (w.pdfjsLib) return resolve(w.pdfjsLib);
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs";
      s.type = "module";
      // The .mjs build attaches to window as pdfjsLib once evaluated.
      const fallback = document.createElement("script");
      fallback.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      fallback.onload = () => {
        const lib = (window as unknown as Record<string, unknown>).pdfjsLib as Record<string, unknown> | undefined;
        if (lib) {
          (lib as { GlobalWorkerOptions?: { workerSrc?: string } }).GlobalWorkerOptions &&
            ((lib as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
              "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
          resolve(lib);
        } else reject(new Error("pdf.js failed to load"));
      };
      fallback.onerror = () => reject(new Error("pdf.js failed to load"));
      document.head.appendChild(fallback);
    });
  }
  return pdfjsPromise as Promise<{ getDocument: (opts: unknown) => { promise: Promise<unknown> } } & Record<string, unknown>>;
}

async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const doc = (await (pdfjs.getDocument({ data: buf }) as { promise: Promise<unknown> }).promise) as {
    numPages: number;
    getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
  };
  const parts: string[] = [];
  const maxPages = Math.min(doc.numPages, 40);
  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => it.str || "").join(" "));
    if (parts.join(" ").length > MAX_ATTACH_CHARS) break;
  }
  return parts.join("\n").trim();
}


/** An area loaded from a .zip the user uploaded (so it's already a downloadable file). */
function isUploadedZip(a: AreaSelection): boolean {
  return a.source === "file" && /\.zip$/i.test(a.fileName || "");
}

/** The file the AI is told holds the area: the uploaded .zip itself, or the generated Shapefile. */
function areaFileFor(a: AreaSelection, place: string): string {
  return isUploadedZip(a) ? a.fileName! : shapefileName(a, place);
}

/** The place a scorecard is for (the setup fields that pick it). */
interface PlaceFields {
  city: string;
  country: string;
  countryCode: string;
  region: string;
  setupMode: "city" | "area";
  area: AreaSelection | null;
}

const norm = (s?: string | null) => (s || "").trim().toLowerCase();

/** "Tempe, Arizona, United States" (or the area's label when no city is set). */
function placeName(p: PlaceFields): string {
  return [p.city.trim(), p.region.trim(), p.country.trim()].filter(Boolean).join(", ") || p.area?.label || "";
}

/** Same city? Filling in a missing state or country later doesn't make it a different one. */
function samePlace(a: PlaceFields, b: PlaceFields): boolean {
  if ((norm(a.city) || norm(a.area?.label)) !== (norm(b.city) || norm(b.area?.label))) return false;
  const ka = norm(a.countryCode || countryCodeFor(a.country) || a.country);
  const kb = norm(b.countryCode || countryCodeFor(b.country) || b.country);
  if (ka && kb && ka !== kb) return false;
  const ra = norm(a.region), rb = norm(b.region);
  return !ra || !rb || ra === rb;
}

function placeOfSession(s: AssistantSession): PlaceFields {
  return {
    city: s.city || "", country: s.country || "", countryCode: s.countryCode || countryCodeFor(s.country) || "",
    region: s.region || "", setupMode: s.setupMode === "area" ? "area" : "city", area: s.area || null,
  };
}

/** Only answered indicators count: a chat alone isn't worth asking about saving or reloading. */
const laneHasContent = (l?: LaneData) => !!l && filledCount(l.draft || {}) > 0;

/** The most recently saved scorecard for this place that has any answers. */
function findSavedScorecard(p: PlaceFields, exceptId: string, fallbackProvider: string): AssistantSession | null {
  for (const m of listSessions()) {
    if (m.id === exceptId) continue;
    const s = loadSession(m.id);
    if (!s) continue;
    const sp = placeOfSession(s);
    if (placeName(sp) && samePlace(sp, p) && Object.values(lanesOf(s, fallbackProvider)).some(laneHasContent)) return s;
  }
  return null;
}

/** What the Analysis tab needs to know about the Assistant's current scorecard. */
export interface LaneSummary {
  /** Identifies the place (city, or drawn area): analyses made for another place are stale. */
  placeKey: string;
  /** "Tempe, Arizona, United States" or "Area · …". */
  place: string;
  /** Helpers whose scorecard is fully answered and not still being filled. */
  complete: ProviderId[];
  /** The city whatever its outline, and the outline in use (for the saved analyses library). */
  cityKey: string;
  shape: SavedShape;
}

export function AssistantTab({
  view,
  onOpenView,
  settings,
  activeLane,
  onActiveLaneChange,
  onLoadIntoAnalyzer,
  onUseProvider,
  onRunningChange,
  busyProviders = [],
  onSessionChange,
  onLaneSummary,
  scorecardSource,
  onClearAll,
  onSessionDeleted,
}: {
  /** Which half to show: the chats ("assistant") or the live scorecards ("scorecard"). */
  view: "assistant" | "scorecard";
  onOpenView?: (v: "assistant" | "scorecard") => void;
  settings: AppSettings;
  /** The helper whose sub-tab is selected (shared with the Analysis tab). */
  activeLane: ProviderId;
  onActiveLaneChange: (p: ProviderId) => void;
  onLoadIntoAnalyzer: (p: ProviderId, sc: NormalizedScorecard) => void;
  onUseProvider?: (p: AppSettings["provider"]) => void;
  /** The helpers currently filling a scorecard. */
  onRunningChange?: (running: ProviderId[]) => void;
  /** Helpers busy elsewhere (their analysis or advisor is running): they can't start a fill. */
  busyProviders?: ProviderId[];
  /** The selected scorecard changed (the Analysis tab shows that scorecard's results). */
  onSessionChange?: (id: string) => void;
  /** The current place, and which helpers have finished their scorecard for it. */
  onLaneSummary?: (s: LaneSummary) => void;
  /** Filled in with a function that builds a helper's current scorecard, for the Analysis tab. */
  scorecardSource?: MutableRefObject<((p: ProviderId) => NormalizedScorecard | null) | null>;
  /** "Clear all Information" was used: the Analysis tab drops this scorecard's results too. */
  onClearAll?: () => void;
  /** A saved scorecard was deleted (its analyses go with it). */
  onSessionDeleted?: (id: string) => void;
}) {
  const selected = selectedProviders(settings);
  const readyLanes = selected.filter(providerIsReady);
  const lane = selected.includes(activeLane) ? activeLane : selected[0];

  // Shared session state
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActive] = useState<string>("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState(""); // country name, as shown and sent to research
  const [countryCode, setCountryCode] = useState(""); // ISO alpha-2 behind the Country dropdown
  const [region, setRegion] = useState(""); // state/province name, when the country has them
  const [info, setInfo] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [setupMode, setSetupMode] = useState<"city" | "area">("city");
  // Upload feedback shown on the Scorecard tab.
  const [uploadNote, setUploadNote] = useState<{ ok: boolean; text: string } | null>(null);
  // "That place doesn't exist" popup, and the check that runs before a fill.
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [checkingPlace, setCheckingPlace] = useState(false);
  // Bumped by "Clear all Information" so the map picker starts over too.
  const [pickerKey, setPickerKey] = useState(0);
  const [area, setArea] = useState<AreaSelection | null>(null);
  const [confirm, setConfirm] = useState<null | ConfirmRequest>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(true);

  // Each helper's lane: its handle, its latest data (saved with the session), and its progress.
  const laneRefs = useRef<Partial<Record<ProviderId, LaneHandle | null>>>({});
  const lanesDataRef = useRef<Record<string, LaneData>>({});
  const [laneStatus, setLaneStatus] = useState<Partial<Record<ProviderId, LaneStatus>>>({});
  const activeMetaRef = useRef<{ id: string; createdAt: number }>({ id: "", createdAt: Date.now() });
  const attachRef = useRef<Attachment[]>(attachments);
  attachRef.current = attachments;
  const templateBufRef = useRef<ArrayBuffer | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);
  const ready = useRef(false);
  const mountedRef = useRef(true);

  // The place this session's scorecards belong to. It follows the setup fields
  // while the scorecards have no answers; once they have some (or a fill is running), choosing a
  // different city asks whether to save them (see checkPlaceChange), and until
  // then the Scorecard tab and the saved session keep the old place.
  const live: PlaceFields = { city, country, countryCode, region, setupMode, area };
  const liveRef = useRef(live);
  liveRef.current = live;
  const [bound, setBound] = useState<PlaceFields | null>(null);
  const boundRef = useRef<PlaceFields | null>(null);
  const bindPlace = useCallback((p: PlaceFields) => {
    const b = boundRef.current;
    if (b && b.city === p.city && b.country === p.country && b.countryCode === p.countryCode &&
        b.region === p.region && b.setupMode === p.setupMode && b.area === p.area) return;
    boundRef.current = p;
    setBound(p);
  }, []);
  // Set when the setup fields are changed together with the scorecards (an uploaded file), so they stay bound.
  const rebindRef = useRef(false);
  const fillingRef = useRef(false);
  const hasContent = useCallback(() => fillingRef.current || Object.values(lanesDataRef.current).some(laneHasContent), []);
  /** A different city is typed in, but the scorecards are still the old city's. */
  const pendingOf = useCallback(() => {
    const b = boundRef.current;
    return !!b && !samePlace(liveRef.current, b) && hasContent();
  }, [hasContent]);
  const pending = pendingOf();
  // What the scorecards (and the saved session) are for right now.
  const sc = pending && bound ? bound : live;
  const [placeSwitch, setPlaceSwitch] = useState<{ from: PlaceFields; to: PlaceFields; filled: number; toSaved: boolean } | null>(null);
  // Asks for checkPlaceChange once the field edits it follows have rendered.
  const [commitTick, setCommitTick] = useState(0);
  const commitPlace = useCallback(() => setCommitTick((t) => t + 1), []);
  // Where the lanes draw their chats and scorecards.
  const [assistantHost, setAssistantHost] = useState<HTMLElement | null>(null);
  const [scorecardHost, setScorecardHost] = useState<HTMLElement | null>(null);

  const running = selected.some((p) => laneStatus[p]?.running);
  const runningLanes = selected.filter((p) => laneStatus[p]?.running);
  fillingRef.current = running;
  const providerReady = readyLanes.length > 0;
  // Every helper that could start is busy with its analysis.
  const externalBusy = providerReady && readyLanes.every((p) => busyProviders.includes(p));
  const areaActive = setupMode === "area";
  const areaProblem = area ? validateArea(area) : "Draw an area on the map or load one from a file.";
  const canStart = areaActive ? !areaProblem : !!city.trim();
  // A new area fills in the City/Country boxes; the user can still edit them.
  const onPlaceResolved = useCallback((p: {
    city: string; country: string; countryCode?: string | null; regionName?: string | null; regionCode?: string | null;
  }) => {
    if (p.city) setCity(p.city);
    const code = countryCodeFor(p.countryCode || "") || countryCodeFor(p.country);
    if (code) {
      setCountryCode(code);
      setCountry(countryByCode(code)?.name || p.country);
      setRegion(findRegion(code, p.regionCode || "")?.name || findRegion(code, p.regionName || "")?.name || "");
    } else if (p.country) {
      setCountryCode("");
      setCountry(p.country);
      setRegion("");
    }
    commitPlace();
  }, [commitPlace]);

  // Country dropdown: keep the name, the code and the (now stale) state in step.
  const selectCountry = useCallback((code: string) => {
    setCountryCode(code);
    setCountry(countryByCode(code)?.name || "");
    setRegion("");
    commitPlace();
  }, [commitPlace]);
  const regionOptions = regionsOf(countryCode);
  const regionCode = findRegion(countryCode, region)?.code;

  // By city name: the typed city's boundary, looked up the same way as a click
  // on that city in "Draw an area", so both routes give the AI the same
  // Shapefile and the same boundary-measured open data.
  //   AreaSelection = found, null = no such place, undefined = lookup failed.
  const typedCityKey = city.trim()
    ? [city.trim().toLowerCase(), countryCode || country.trim().toLowerCase(), regionCode || ""].join("|")
    : "";
  // Looked up from "By city name", and in "Draw an area" while no area is chosen yet.
  const cityKey = areaActive && area ? "" : typedCityKey;
  const [cityLookup, setCityLookup] = useState<{ key: string; area: AreaSelection | null | undefined } | null>(null);
  const cityLookupRef = useRef<{ key: string; promise: Promise<AreaSelection | null | undefined> } | null>(null);
  const lookupCityArea = useCallback((key: string, q: { city: string; country: string; countryCode: string; regionCode?: string }) => {
    if (cityLookupRef.current?.key === key) return cityLookupRef.current.promise;
    const promise = fetch("/api/area", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "cityByName", city: q.city, country: q.country,
        countryCode: q.countryCode || undefined, regionCode: q.regionCode || undefined,
      }),
    })
      .then(async (res): Promise<AreaSelection | null | undefined> => {
        if (!res.ok) return undefined;
        const b = (await res.json()) as {
          found: boolean; ring?: LonLat[]; approximate?: boolean; countryCode?: string | null; lat?: number; lon?: number; cityRef?: string | null;
        };
        if (!b.found) return null;
        if (!b.ring) return undefined;
        const a = makeArea(b.ring, "city");
        if (validateArea(a)) return undefined; // e.g. bigger than any city: fill without a boundary
        return {
          ...a,
          label: q.city,
          approximate: b.approximate || undefined,
          countryCode: b.countryCode || q.countryCode || undefined,
          outsideCityFraction: 0,
          cityAreaKm2: a.areaKm2,
          // The map label it matches, so "Draw an area" highlights it like a click.
          cityRef: b.cityRef || `${q.city}|${b.lat}|${b.lon}`,
        };
      })
      .catch(() => undefined);
    cityLookupRef.current = { key, promise };
    void promise.then((result) => {
      if (cityLookupRef.current?.key !== key) return;
      if (result === undefined) cityLookupRef.current = null; // a failed lookup may be retried
      if (mountedRef.current) setCityLookup({ key, area: result });
    });
    return promise;
  }, []);
  // Look the city up once the user pauses typing or picks a country / state.
  useEffect(() => {
    if (!cityKey || cityLookup?.key === cityKey) return;
    const t = setTimeout(() => {
      void lookupCityArea(cityKey, { city: city.trim(), country: country.trim(), countryCode, regionCode });
    }, 1200);
    return () => clearTimeout(t);
  }, [cityKey, cityLookup?.key, city, country, countryCode, regionCode, lookupCityArea]);
  const cityArea = typedCityKey && cityLookup?.key === typedCityKey ? cityLookup.area : undefined;
  // Switching to "Draw an area" shows the typed city as if it had been clicked
  // on the map. A shape the user drew or loaded themselves is never replaced.
  useEffect(() => {
    if (!areaActive || !cityArea) return;
    setArea((prev) =>
      !prev || (prev.source === "city" && (prev.label || "").toLowerCase() !== (cityArea.label || "").toLowerCase()) ? cityArea : prev
    );
  }, [areaActive, cityArea]);
  const cityLooking = !!cityKey && cityLookup?.key !== cityKey;

  // The area the AI works from (and its generated Shapefile): the drawn/clicked
  // area in "Draw an area", the typed city's boundary in "By city name".
  const activeArea = areaActive ? (areaProblem ? null : area) : cityArea ?? null;
  const areaFileName = activeArea ? areaFileFor(activeArea, city.trim()) : null;
  // An uploaded .zip is already the user's own file: nothing to download.
  const uploadedZip = !!activeArea && isUploadedZip(activeArea);
  const downloadAreaFile = useCallback(() => {
    if (!activeArea) return;
    const { fileName, zip } = buildAreaShapefile(activeArea, city.trim());
    const url = URL.createObjectURL(new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [activeArea, city]);

  // ── Lanes ───────────────────────────────────────────
  const runningKey = runningLanes.join(",");
  useEffect(() => { onRunningChange?.(runningKey ? (runningKey.split(",") as ProviderId[]) : []); }, [runningKey, onRunningChange]);
  const onStatus = useCallback((p: ProviderId, s: LaneStatus) => {
    setLaneStatus((cur) => {
      const old = cur[p];
      return old && old.running === s.running && old.filled === s.filled && old.blank === s.blank && old.continuable === s.continuable && old.fill === s.fill
        ? cur
        : { ...cur, [p]: s };
    });
  }, []);
  const eachLane = useCallback((fn: (h: LaneHandle, p: ProviderId) => void) => {
    for (const p of selectedProviders(settings)) {
      const h = laneRefs.current[p];
      if (h) fn(h, p);
    }
  }, [settings]);
  const noteAll = useCallback((item: ChatItem) => eachLane((h) => h.note(item)), [eachLane]);
  const noteActive = useCallback((item: ChatItem) => laneRefs.current[lane]?.note(item), [lane]);
  const stopAll = useCallback(() => eachLane((h) => h.stop()), [eachLane]);

  // What every lane reads from the shared setup.
  const headerTitle = sc.city.trim() ? [sc.city.trim(), sc.region.trim(), sc.country.trim()].filter(Boolean).join(", ") : "New scorecard";
  const shared: LaneShared = {
    city: sc.city.trim(), country: sc.country.trim(), region: sc.region.trim(),
    area: pending ? null : activeArea, areaActive: sc.setupMode === "area",
    drawnArea: sc.setupMode === "area" ? sc.area : null,
    place: headerTitle, attachments, templateBuf: templateBufRef.current,
  };
  const sharedRef = useRef(shared);
  sharedRef.current = shared;

  // Tell the Analysis tab which place this is and whose scorecards are finished.
  const placeKey = `${sc.setupMode}|${headerTitle}|${sc.setupMode === "area" && sc.area ? sc.area.bbox.join(",") : ""}`.toLowerCase();
  // Finished: every indicator scored or left blank with a reason.
  const completeKey = selected.filter((p) => !laneStatus[p]?.running && (laneStatus[p]?.filled ?? 0) + (laneStatus[p]?.blank ?? 0) >= TOTAL_INDICATORS).join(",");
  const cityIdentity = (sc.city.trim() ? [sc.city.trim(), sc.region.trim(), sc.country.trim()].join("|") : (sc.area?.label || headerTitle)).toLowerCase();
  const shape = shapeOf(activeArea, areaActive);
  const shapeKey = `${shape.kind}|${shape.detail}`;
  useEffect(() => {
    if (!activeId) return;
    const [kind, detail] = shapeKey.split("|");
    onLaneSummary?.({
      placeKey,
      place: sc.setupMode === "area" && sc.area ? `Area · ${sc.area.label || headerTitle}` : headerTitle,
      complete: completeKey ? (completeKey.split(",") as ProviderId[]) : [],
      cityKey: cityIdentity,
      shape: { kind, detail },
    });
  }, [activeId, placeKey, completeKey, headerTitle, sc.setupMode, sc.area, cityIdentity, shapeKey, onLaneSummary]);
  if (scorecardSource) {
    scorecardSource.current = (p: ProviderId) => {
      const l = lanesDataRef.current[p];
      if (!l) return null;
      const prof = l.profile || { name: "", country: "" };
      const sh = sharedRef.current;
      return draftToScorecard(l.draft || {}, { ...prof, name: sh.city || prof.name || "Unknown", country: sh.country || prof.country || "Unknown" });
    };
  }
  const getShared = useCallback(() => sharedRef.current, []);

  // ── Session load/save ───────────────────────────────
  const buildActiveSession = useCallback((): AssistantSession => {
    // While another city is being typed in, the scorecards are still saved under theirs.
    const p = pendingOf() && boundRef.current ? boundRef.current : { city, country, countryCode, region, setupMode, area };
    return {
      id: activeMetaRef.current.id,
      title: "",
      ...p,
      info,
      lanes: { ...lanesDataRef.current },
      attachments: attachRef.current,
      createdAt: activeMetaRef.current.createdAt,
      updatedAt: Date.now(),
    };
  }, [city, country, countryCode, region, info, setupMode, area, pendingOf]);

  // Which session the rendered state currently reflects. loadIntoState sets the
  // id ref at once but the state only on the next render, so saving in between
  // would write a blank session over the stored one.
  const renderedIdRef = useRef("");
  useEffect(() => { renderedIdRef.current = activeId; }, [activeId]);
  const saveActive = useCallback(() => {
    if (!activeMetaRef.current.id || renderedIdRef.current !== activeMetaRef.current.id) return;
    saveSession(buildActiveSession());
    setSessions(listSessions());
  }, [buildActiveSession]);
  const saveActiveRef = useRef(saveActive);
  saveActiveRef.current = saveActive;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback(() => {
    if (!ready.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveActiveRef.current(), 500);
  }, []);
  const onData = useCallback((p: ProviderId, data: LaneData) => {
    lanesDataRef.current[p] = data;
    scheduleSave();
  }, [scheduleSave]);

  const loadIntoState = useCallback((s: AssistantSession) => {
    activeMetaRef.current = { id: s.id, createdAt: s.createdAt };
    bindPlace(placeOfSession(s));
    lanesDataRef.current = { ...lanesOf(s, selectedProviders(settings)[0]) };
    templateBufRef.current = null; // fresh sessions fill the bundled official template
    setActive(s.id);
    setActiveId(s.id);
    setCity(s.city || "");
    setCountry(s.country || "");
    // Sessions saved before the dropdown only have the country's name.
    setCountryCode(s.countryCode || countryCodeFor(s.country) || "");
    setRegion(s.region || "");
    setInfo(s.info || "");
    setAttachments(s.attachments || []);
    setSetupMode(s.setupMode === "area" ? "area" : "city");
    setUploadNote(null);
    setArea(s.area || null);
    setLaneStatus({});
  }, [settings, bindPlace]);

  // First mount: restore or create a session
  useEffect(() => {
    const list = listSessions();
    setSessions(list);
    const wantId = getActiveId();
    const existing = (wantId && loadSession(wantId)) || (list[0] && loadSession(list[0].id));
    if (existing) loadIntoState(existing);
    else {
      const s = createSession();
      saveSession(s);
      setSessions(listSessions());
      loadIntoState(s);
    }
    ready.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (activeId) onSessionChange?.(activeId); }, [activeId, onSessionChange]);

  // Auto-save (debounced) whenever the shared setup changes; lanes save through onData.
  useEffect(() => { scheduleSave(); }, [city, country, countryCode, region, info, attachments, setupMode, area, scheduleSave]);

  // On unmount (e.g. full page navigation), persist.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      try { saveActiveRef.current(); } catch { /* ignore */ }
    };
  }, []);

  // ── Fill it out for me (every helper, in parallel) ──
  const handleStartAutonomous = useCallback(async () => {
    if (!canStart || running || externalBusy || checkingPlace) return;
    // A different city than the scorecards': ask about saving them first.
    if (pendingOf()) { commitPlace(); return; }
    const place = [city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ");
    // Make sure the typed city (in that state and country) is a real place before
    // spending any AI calls on it. If the lookup itself fails, don't block the user.
    // By city name, the same lookup also fetches the city's boundary (reused if
    // it already ran while the user was typing).
    let cityBoundary: AreaSelection | null | undefined;
    if (city.trim()) {
      setCheckingPlace(true);
      let found: boolean | null = null;
      try {
        if (!areaActive) {
          cityBoundary = await lookupCityArea(cityKey, { city: city.trim(), country: country.trim(), countryCode, regionCode });
          found = cityBoundary === undefined ? null : cityBoundary !== null;
        } else {
          const res = await fetch("/api/area", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "checkCity", city: city.trim(), country: country.trim(),
              countryCode: countryCode || undefined, regionCode: regionCode || undefined,
            }),
          });
          if (res.ok) found = ((await res.json()) as { found: boolean }).found;
        }
      } catch {
        found = null;
      } finally {
        setCheckingPlace(false);
      }
      if (found === false) {
        setPlaceError(
          region.trim()
            ? `The city, state or province, country combination "${place}" does not exist. Check the spelling and try again.`
            : country.trim()
            ? `The city, country combination "${place}" does not exist. Check the spelling and try again.`
            : `The city "${city.trim()}" does not exist. Check the spelling and try again.`
        );
        setCity("");
        setCountry("");
        setCountryCode("");
        setRegion("");
        return;
      }
    }
    const cityLine = areaActive && area
      ? `the selected area (${describeArea(area)}${place ? `, in ${place}` : ""}${areaFileName ? `; saved as ${areaFileName}` : ""})`
      : place;
    const runArea = areaActive ? activeArea : cityBoundary ?? null;
    eachLane((h, p) => {
      const label = PROVIDER_LABEL[p];
      if (!providerIsReady(p)) h.note({ kind: "assistant", text: `Add a key for ${label} in Settings, then press "Fill it out for me" again to include ${label}.` });
      else if (busyProviders.includes(p)) h.note({ kind: "assistant", text: `${label}'s analysis is still running on the Analysis tab, so ${label} will sit this one out. Press Continue here once it finishes.` });
      else h.startFill(cityLine, info.trim(), areaActive, runArea);
    });
  }, [canStart, checkingPlace, city, country, countryCode, region, regionCode, info, running, externalBusy, areaActive, area, areaFileName, activeArea, cityKey, lookupCityArea, eachLane, busyProviders, pendingOf, commitPlace]);

  // ── Scorecard upload (start / continue a fill) ──────
  const applyScorecardFile = useCallback(async (file: File, intoNew: boolean) => {
    setUploadNote({ ok: true, text: `Reading ${file.name}…` });
    try {
      const buf = await file.arrayBuffer(); // use their file as the fill base when possible
      const sc = await uploadScorecard(file);
      const knownCity = sc.city?.name && sc.city.name !== "Unknown" ? sc.city.name : "";
      const knownCountry = sc.city?.country && sc.city.country !== "Unknown" ? sc.city.country : "";
      const { loaded } = mergeScorecardIntoDraft(emptyDraft(), sc);
      // Carry the file's City Information over too (only the fields it has).
      const pf = sc.profile || {};
      const fromFile: Partial<CityInfo> = {};
      if (pf.population != null) fromFile.population = pf.population;
      if (pf.incomeUsd != null) fromFile.incomeUsd = pf.incomeUsd;
      if (pf.hazards?.length) fromFile.hazards = pf.hazards;
      if (pf.mostSevere) fromFile.mostSevere = pf.mostSevere;
      if (sc.assessedDate) fromFile.assessedDate = sc.assessedDate;
      if (knownCity) fromFile.name = knownCity;
      if (knownCountry) fromFile.country = knownCountry;
      const guidance = knownCity && loaded >= TOTAL_INDICATORS
        ? `Loaded your completed scorecard for ${knownCity}${knownCountry ? ", " + knownCountry : ""}: all ${TOTAL_INDICATORS} answers are on the Scorecard tab. Press "Run analysis" there to analyze it, or ask me to review any answer first.`
        : knownCity
        ? `Loaded your file for ${knownCity}${knownCountry ? ", " + knownCountry : ""} with ${loaded} of ${TOTAL_INDICATORS} indicators already answered. Press "Fill it out for me" and I'll complete the rest.`
        : loaded > 0
        ? `Loaded ${loaded} of ${TOTAL_INDICATORS} answers, but I couldn't find the city in the file. Which city is this scorecard for? (You can also type it in the City box above.)`
        : `That file doesn't have any answers in it yet. Type your city above and press "Fill it out for me" and I'll take it from there.`;
      const notes: ChatItem[] = [
        { kind: "tool", label: `Parsed ${file.name}`, detail: `${loaded} of ${TOTAL_INDICATORS} answers found` },
        { kind: "assistant", text: guidance },
      ];

      if (intoNew) {
        // A fresh session whose every lane starts from the file's answers.
        saveActive();
        const s = createSession({ city: knownCity, country: knownCountry });
        const lanes: Record<string, LaneData> = {};
        for (const p of selectedProviders(settings)) {
          lanes[p] = { ...emptyLane(), chat: notes, draft: mergeScorecardIntoDraft(emptyDraft(), sc).draft, profile: { name: knownCity, country: knownCountry, ...fromFile } };
        }
        s.lanes = lanes;
        saveSession(s);
        setSessions(listSessions());
        loadIntoState(s);
      } else {
        eachLane((h) => h.loadScorecard(sc, fromFile, notes));
      }
      templateBufRef.current = buf;
      rebindRef.current = true; // the file's answers are for the file's city
      if (knownCity) setCity(knownCity);
      if (knownCountry) {
        const code = countryCodeFor(knownCountry);
        setCountry(code ? countryByCode(code)?.name || knownCountry : knownCountry);
        if (code !== countryCode) setRegion("");
        setCountryCode(code || "");
      }
      setUploadNote({
        ok: true,
        text: `Loaded ${loaded} of ${TOTAL_INDICATORS} answers from ${file.name} into every helper's copy` +
          (loaded < TOTAL_INDICATORS ? `. The helpers can fill in the rest.` : "."),
      });
    } catch (e) {
      const msg = `Could not read that file: ${e instanceof Error ? e.message : String(e)}. Make sure it's an official UNDRR Preliminary scorecard (.xlsm/.xlsx).`;
      setUploadNote({ ok: false, text: msg });
      noteActive({ kind: "assistant", text: msg });
    }
  }, [saveActive, loadIntoState, countryCode, settings, eachLane, noteActive]);

  const onScorecardPicked = useCallback((file: File) => {
    const hasContent = running || Object.values(lanesDataRef.current).some((l) => (l.chat?.length || 0) > 0 || filledCount(l.draft || {}) > 0);
    if (hasContent) {
      setConfirm({
        title: "Start a new chat?",
        body: "You attached a new scorecard while another was in progress. This starts a fresh chat for it. Your current chat stays saved and you can switch back any time.",
        yes: "Start new chat",
        onYes: () => { setConfirm(null); if (running) stopAll(); void applyScorecardFile(file, true); },
      });
    } else {
      void applyScorecardFile(file, false);
    }
  }, [running, stopAll, applyScorecardFile]);

  // ── Reference-document attachments (shared by every helper) ──
  const onDocsPicked = useCallback(async (files: FileList) => {
    const added: Attachment[] = [];
    for (const file of Array.from(files)) {
      // Skip duplicates (same name already attached).
      if (attachRef.current.some((a) => a.name === file.name)) {
        noteActive({ kind: "tool", label: "Already attached", detail: file.name });
        continue;
      }
      const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      if (isPdf) {
        noteActive({ kind: "tool", label: "Reading PDF", detail: file.name });
        try {
          const text = await extractPdfText(file);
          if (text && text.length > 20) {
            added.push({ name: file.name, text: text.slice(0, MAX_ATTACH_CHARS) });
          } else {
            noteActive({ kind: "assistant", text: `I opened "${file.name}" but couldn't pull much text out of it, it may be a scanned image rather than a text PDF. If you paste the key details into the chat, I'll use them.` });
          }
        } catch {
          noteActive({ kind: "assistant", text: `I couldn't read "${file.name}" as a PDF here. If you copy the important text into the chat, I'll work from that.` });
        }
        continue;
      }
      if (!TEXT_EXT.test(file.name) && !file.type.startsWith("text/")) {
        noteActive({ kind: "assistant", text: `I can read PDFs and text documents (txt, md, csv, json, html). "${file.name}" is a ${file.name.split(".").pop()?.toUpperCase() || "binary"} file, so I can't read it directly. If you paste the important text into the chat, I'll use it.` });
        continue;
      }
      try {
        const text = await file.text();
        added.push({ name: file.name, text: text.slice(0, MAX_ATTACH_CHARS) });
      } catch {
        noteActive({ kind: "assistant", text: `Couldn't read "${file.name}".` });
      }
    }
    if (added.length) {
      setAttachments((a) => {
        const next = [...a, ...added];
        attachRef.current = next;
        return next;
      });
      for (const a of added) {
        const words = a.text.split(/\s+/).filter(Boolean).length;
        noteAll({ kind: "tool", label: "Ready to use", detail: `${a.name} (read about ${words.toLocaleString()} words)` });
      }
    }
  }, [noteActive, noteAll]);

  const removeAttachment = useCallback((name: string) => {
    setAttachments((a) => {
      const next = a.filter((x) => x.name !== name);
      attachRef.current = next;
      return next;
    });
    noteAll({ kind: "tool", label: "Removed attachment", detail: name });
  }, [noteAll]);

  // ── Session management ──────────────────────────────
  const switchTo = useCallback((id: string) => {
    if (id === activeId) return;
    stopAll();
    saveActive();
    const s = loadSession(id);
    if (s) loadIntoState(s);
  }, [activeId, stopAll, saveActive, loadIntoState]);

  const newChat = useCallback(() => {
    stopAll();
    saveActive();
    const s = createSession();
    saveSession(s);
    setSessions(listSessions());
    loadIntoState(s);
    setSetupOpen(true); // a fresh scorecard starts with choosing the place
  }, [stopAll, saveActive, loadIntoState]);

  const requestDeleteSession = useCallback((id: string) => {
    const meta = listSessions().find((s) => s.id === id);
    setConfirm({
      title: "Delete this chat?",
      body: `This permanently removes "${meta?.title || "this scorecard"}" and every helper's draft of it. This cannot be undone.`,
      yes: "Delete",
      danger: true,
      onYes: () => {
        setConfirm(null);
        const wasActive = id === activeMetaRef.current.id;
        if (wasActive) stopAll();
        deleteSession(id);
        onSessionDeleted?.(id);
        const list = listSessions();
        setSessions(list);
        if (wasActive) {
          const next = list[0] && loadSession(list[0].id);
          if (next) loadIntoState(next);
          else {
            const s = createSession();
            saveSession(s);
            setSessions(listSessions());
            loadIntoState(s);
          }
        }
      },
    });
  }, [stopAll, loadIntoState, onSessionDeleted]);

  // ── Changing the city ───────────────────────────────
  // Empty scorecards just follow the setup fields; filled ones stay with their city.
  useEffect(() => {
    const b = boundRef.current;
    if (rebindRef.current || !b || samePlace(liveRef.current, b) || !hasContent()) {
      rebindRef.current = false;
      bindPlace(liveRef.current);
    }
  }, [city, country, countryCode, region, setupMode, area, hasContent, bindPlace]);

  // "Reload the scorecard from the last session for <city>?"
  const [reloadAsk, setReloadAsk] = useState<{ place: PlaceFields; saved: AssistantSession } | null>(null);
  // A saved scorecard whose question was closed without an answer (not asked again until another city).
  const reloadDismissedRef = useRef("");
  /** If `to` has a saved scorecard, ask whether to reload it. */
  useEffect(() => { reloadDismissedRef.current = ""; }, [city, countryCode, region]);
  const askReload = useCallback((to: PlaceFields) => {
    const saved = findSavedScorecard(to, activeMetaRef.current.id, selectedProviders(settings)[0]);
    if (saved && reloadDismissedRef.current !== saved.id) setReloadAsk({ place: to, saved });
  }, [settings]);

  /** Start a fresh scorecard for `to`, then ask about any saved one for it. */
  const openScorecardFor = useCallback((to: PlaceFields) => {
    const next = createSession({ ...to });
    saveSession(next);
    setSessions(listSessions());
    loadIntoState(next);
    askReload(to);
  }, [loadIntoState, askReload]);

  const resolveReload = useCallback((choice: "yes" | "no" | "dismiss") => {
    const ask = reloadAsk;
    setReloadAsk(null);
    if (!ask) return;
    if (choice === "dismiss") { reloadDismissedRef.current = ask.saved.id; return; }
    const curId = activeMetaRef.current.id;
    const fallback = selectedProviders(settings)[0];
    if (choice === "no") {
      // Clear everything saved for that city; keep going with the empty scorecard.
      for (let old = findSavedScorecard(ask.place, curId, fallback); old; old = findSavedScorecard(ask.place, curId, fallback)) {
        deleteSession(old.id);
        onSessionDeleted?.(old.id);
      }
      setSessions(listSessions());
      return;
    }
    const saved = loadSession(ask.saved.id);
    if (!saved) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // The current scorecard is empty: drop it unless it holds notes or documents.
    if (!info.trim() && !attachRef.current.length) {
      deleteSession(curId);
      onSessionDeleted?.(curId);
    } else saveActive();
    // Keep the area just chosen on the map (a clicked city, or a shape around it).
    const now = liveRef.current;
    const restored: AssistantSession = now.setupMode === "area" && now.area ? { ...saved, setupMode: "area", area: now.area } : saved;
    saveSession(restored);
    setSessions(listSessions());
    loadIntoState(restored);
  }, [reloadAsk, settings, info, saveActive, loadIntoState, onSessionDeleted]);

  // Runs once the user has settled on a city (left the City box, picked a
  // country or state, or chose a place on the map).
  const checkPlaceChange = useCallback(() => {
    const to = liveRef.current;
    const from = boundRef.current;
    if (!placeName(to)) return;
    if (from && pendingOf()) {
      const filled = Math.max(0, ...Object.values(lanesDataRef.current).map((l) => filledCount(l.draft || {})));
      const toSaved = !!findSavedScorecard(to, activeMetaRef.current.id, selectedProviders(settings)[0]);
      setPlaceSwitch({ from, to, filled, toSaved });
      return;
    }
    if (hasContent()) return; // same city, keep working on it
    // Nothing done here yet: offer this city's saved scorecard, if it has one.
    askReload(to);
  }, [pendingOf, hasContent, settings, askReload]);
  const checkPlaceRef = useRef(checkPlaceChange);
  checkPlaceRef.current = checkPlaceChange;
  useEffect(() => { if (commitTick) checkPlaceRef.current(); }, [commitTick]);

  const resolvePlaceSwitch = useCallback((choice: "save" | "discard" | "cancel") => {
    const ps = placeSwitch;
    setPlaceSwitch(null);
    if (!ps) return;
    if (choice === "cancel") {
      // Put the old city back.
      const f = ps.from;
      setCity(f.city);
      setCountry(f.country);
      setCountryCode(f.countryCode);
      setRegion(f.region);
      setSetupMode(f.setupMode);
      if (f.area !== liveRef.current.area) {
        setArea(f.area);
        setPickerKey((k) => k + 1);
      }
      return;
    }
    stopAll();
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const oldId = activeMetaRef.current.id;
    if (choice === "save") {
      saveSession({ ...buildActiveSession(), ...ps.from });
    } else {
      // Not saved: that city starts fresh next time (older copies of it go too).
      deleteSession(oldId);
      onSessionDeleted?.(oldId);
      for (let old = findSavedScorecard(ps.from, oldId, selectedProviders(settings)[0]); old;
           old = findSavedScorecard(ps.from, oldId, selectedProviders(settings)[0])) {
        deleteSession(old.id);
        onSessionDeleted?.(old.id);
      }
    }
    openScorecardFor(liveRef.current);
    setSetupOpen(true);
  }, [placeSwitch, stopAll, buildActiveSession, onSessionDeleted, openScorecardFor, settings]);

  // ── Clearing ────────────────────────────────────────
  /** Start this scorecard over: place, area, notes, every helper's answers and chat, attachments. */
  const clearEverythingNow = useCallback(() => {
    eachLane((h) => h.clearAll());
    onClearAll?.();
    setCity("");
    setCountry("");
    setCountryCode("");
    setRegion("");
    setInfo("");
    setArea(null);
    setPickerKey((k) => k + 1);
    attachRef.current = [];
    setAttachments([]);
    templateBufRef.current = null;
    setUploadNote(null);
    setSetupOpen(true);
  }, [eachLane, onClearAll]);

  const requestClearEverything = useCallback(() => {
    setConfirm({
      title: "Clear all information?",
      body: "All data for this scorecard will be lost: the city or area, country, state or province, your notes, every helper's scorecard answers and chat, any attached documents, and its analyses on the Analysis tab. This can't be undone.",
      yes: "Proceed",
      danger: true,
      onYes: () => { setConfirm(null); clearEverythingNow(); },
    });
  }, [clearEverythingNow]);

  const requestConfirm = useCallback((c: ConfirmRequest) => {
    setConfirm({ ...c, onYes: () => { setConfirm(null); c.onYes(); } });
  }, []);

  // Once a fill has started, keep the scorecards' progress in view: when the
  // session bar's Scorecard button scrolls up under the app header, a card
  // listing every helper's progress floats at the top right of the chat.
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [floatPos, setFloatPos] = useState<{ top: number; right: number } | null>(null);
  // The Scorecard button stays in view (stationary, top right) once its place in the session bar scrolls away.
  const showFloat = view === "assistant";
  useEffect(() => {
    if (!showFloat) { setFloatPos(null); return; }
    let frame = 0;
    const update = () => {
      frame = 0;
      const chip = chipRef.current, sec = sectionRef.current;
      if (!chip || !sec) return;
      const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
      const s = sec.getBoundingClientRect();
      const next = chip.getBoundingClientRect().top >= headerBottom || s.bottom < headerBottom + 80
        ? null
        : { top: Math.round(headerBottom + 8), right: Math.round(Math.max(8, window.innerWidth - s.right + 12)) };
      setFloatPos((prev) => (prev?.top === next?.top && prev?.right === next?.right ? prev : next));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [showFloat]);

  // The session bar's "Scorecard" button opens the same progress list as a
  // dropdown; a click anywhere outside it closes it again.
  const [progressOpen, setProgressOpen] = useState(false);
  const [costsOpen, setCostsOpen] = useState(false);
  const priceCat = usePriceCatalog();
  const chipWrapRef = useRef<HTMLDivElement | null>(null);
  const floatWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!progressOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chipWrapRef.current?.contains(t) && !floatWrapRef.current?.contains(t)) setProgressOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProgressOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [progressOpen]);

  /** The "Scorecard" button: in the session bar, or floating once that has scrolled away. */
  const scorecardChip = (ref: MutableRefObject<HTMLButtonElement | null> | undefined, live: boolean) => (
    <button ref={ref} onClick={() => setProgressOpen((o) => !o)}
      title="Show every helper's scorecard progress"
      aria-expanded={live && progressOpen}
      aria-haspopup="true"
      tabIndex={live ? 0 : -1}
      className={`flex items-center gap-1.5 text-sm rounded-lg px-2.5 py-1.5 border text-text-primary hover:border-primary-500/40 ${live && progressOpen ? "bg-accent-500/15 border-accent-500/50" : "bg-surface-overlay border-border"}`}>
      <ClipboardCheck size={14} className="text-accent-400" />
      <span className="hidden sm:inline">Scorecard</span>
      {running && <Loader2 size={13} className="animate-spin text-accent-400" aria-label="filling" />}
      <ChevronDown size={13} className={`text-text-secondary transition-transform ${live && progressOpen ? "rotate-180" : ""}`} />
    </button>
  );

  /** Every helper's progress: in the Scorecard dropdown (session bar or floating). */
  const progressList = () => (
    <>
      <span className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        <ClipboardCheck size={13} className="text-accent-400" /> Scorecards
      </span>
      {selected.map((p) => {
        const st = laneStatus[p];
        const n = st?.filled ?? 0;
        return (
          <button key={p} onClick={() => { setProgressOpen(false); onActiveLaneChange(p); onOpenView?.("scorecard"); }}
            title={`Open ${PROVIDER_LABEL[p]}'s scorecard`}
            aria-label={`${PROVIDER_LABEL[p]} scorecard, ${n} of ${TOTAL_INDICATORS} answered${st?.running ? ", filling" : ""}`}
            className="block w-full text-left rounded-lg hover:bg-surface-overlay/60 -mx-1 px-1 py-0.5">
            <span className="flex items-center gap-1.5 text-sm text-text-primary">
              {st?.running ? <Loader2 size={12} className="animate-spin text-accent-400" /> : <Bot size={12} className="text-accent-400" />}
              <span className="truncate">{PROVIDER_LABEL[p]}</span>
              <span className="ml-auto font-semibold tabular-nums">{n}/{TOTAL_INDICATORS}</span>
            </span>
            <span className="mt-1 block h-1.5 rounded-full bg-surface-overlay overflow-hidden">
              <span className="block h-full btn-accent transition-[width] duration-500" style={{ width: `${Math.round((n / TOTAL_INDICATORS) * 100)}%` }} />
            </span>
            <span className="mt-0.5 flex text-[11px] text-text-secondary">
              {st?.running ? "Filling…" : n + (st?.blank ?? 0) >= TOTAL_INDICATORS ? (st?.blank ? `Complete · ${st.blank} left blank` : "Complete") : st?.continuable ? "Paused" : n > 0 ? "Stopped" : "Not started"}
              {st?.fill && st.fill.requests > 0 && (() => {
                const c = costOf(st.fill, p, st.fill.model, priceCat);
                return (
                  <span className="ml-auto tabular-nums" title={`${st.fill.requests} requests · ${formatTokens(st.fill.inputTokens)} in / ${formatTokens(st.fill.outputTokens)} out tokens${c.note ? ` · ${c.note}` : ""}`}>
                    {c.basis === "list" ? "≈ " : ""}{formatUsd(c.usd)}{c.basis === "billed" ? " billed" : c.basis === "local" ? " local" : ""}
                  </span>
                );
              })()}
            </span>
          </button>
        );
      })}
      <button onClick={() => { setProgressOpen(false); setCostsOpen(true); }}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-accent-400 hover:text-accent-300 border-t border-border pt-2">
        <Coins size={12} /> Compare AI costs
      </button>
    </>
  );

  const scorecardName = sc.city.trim() || (sc.setupMode === "area" && sc.area?.label) || "New scorecard";

  /** The helper sub-tabs, on both the Assistant ("Gemini") and Scorecard ("Gemini: Tempe") tabs. */
  const laneTabs = (forScorecard: boolean) => (
    <div role="tablist" aria-label="AI helpers" className="flex flex-wrap gap-1.5 mb-3 shrink-0">
      {selected.map((p) => {
        const st = laneStatus[p];
        const on = p === lane;
        return (
          <button key={p} role="tab" aria-selected={on} onClick={() => onActiveLaneChange(p)}
            title={providerIsReady(p) ? undefined : `${PROVIDER_LABEL[p]} needs a key in Settings`}
            className={`relative overflow-hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition-colors ${on ? "border-accent-500/60 bg-accent-500/15 text-text-primary font-medium" : "border-border bg-surface-overlay text-text-secondary hover:text-text-primary"}`}>
            {st?.running ? <Loader2 size={13} className="animate-spin text-accent-400" /> : <Bot size={13} className={providerIsReady(p) ? "text-accent-400" : "text-warn-400"} />}
            <span className="truncate max-w-[16rem]">{forScorecard ? `${PROVIDER_LABEL[p]}: ${scorecardName}` : PROVIDER_LABEL[p]}</span>
            <span className="text-xs tabular-nums text-text-secondary" title={st?.blank ? `${st.blank} left blank with a reason` : undefined}>
              {st?.filled ?? 0}/{TOTAL_INDICATORS}{st?.blank ? ` · ${st.blank} blank` : ""}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className={view === "scorecard" ? "lg:h-[calc(100vh-11rem)]" : ""}>
      {/* ── Assistant tab: shared setup + the selected helper's chat ───── */}
      <section ref={sectionRef} className={`glass-card p-4 sm:p-5 flex-col min-h-[calc(100vh-11rem)] ${view === "assistant" ? "flex" : "hidden"}`}>
        {/* Session bar */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <Bot size={20} className="text-accent-400 shrink-0" />
          <h2 className="text-base font-semibold text-text-primary shrink-0">Assistant</h2>
          <button
            onClick={() => setMenuOpen(true)}
            title="Chat history"
            className="ml-auto flex items-center gap-1.5 max-w-[55%] text-sm rounded-lg px-2.5 py-1.5 bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40"
          >
            <History size={14} className="shrink-0 text-text-secondary" />
            <span className="truncate">{headerTitle}</span>
            <ChevronDown size={14} className="shrink-0 text-text-secondary" />
          </button>
          <div ref={chipWrapRef} className="relative shrink-0">
            {scorecardChip(chipRef, !floatPos)}
            {progressOpen && !floatPos && (
              <div role="dialog" aria-label="Scorecard progress"
                className="absolute right-0 top-full mt-2 z-30 w-60 rounded-xl border border-border bg-surface-raised/95 backdrop-blur-xl shadow-lg px-3 py-2 space-y-2">
                {progressList()}
              </div>
            )}
          </div>
          <button onClick={newChat} title="New chat" className="shrink-0 p-1.5 rounded-lg bg-surface-overlay border border-border text-text-secondary hover:text-text-primary">
            <Plus size={15} />
          </button>
        </div>

        {floatPos && typeof document !== "undefined" && createPortal(
          <div ref={floatWrapRef} style={{ top: floatPos.top, right: floatPos.right }} className="fixed z-30 flex flex-col items-end">
            <div className="rounded-lg shadow-lg bg-surface-raised">{scorecardChip(undefined, true)}</div>
            {progressOpen && (
              <div role="dialog" aria-label="Scorecard progress"
                className="mt-2 w-60 rounded-xl border border-border bg-surface-raised/95 backdrop-blur-xl shadow-lg px-3 py-2 space-y-2">
                {progressList()}
              </div>
            )}
          </div>,
          document.body
        )}

        {onUseProvider && (
          <ModelSuggestion
            show={selected.length === 1 && selected[0] === "gemini" && !running}
            title="Tip: OpenRouter is smoother for the Assistant"
            body="Gemini's free tier is tightly rate-limited, so filling a whole scorecard can stall partway. OpenRouter's free Nemotron Ultra handles the many quick steps without those limits."
            cta="Use OpenRouter"
            onUse={() => onUseProvider("openrouter")}
            storageKey="undrr-suggest-openrouter-assistant"
          />
        )}

        {/* Setup (collapsible, so the chat has room to breathe) */}
        <div className="shrink-0 rounded-xl border border-border bg-surface-overlay/30 mb-3">
          <button
            onClick={() => setSetupOpen((v) => !v)}
            aria-expanded={setupOpen}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
          >
            <span className="text-sm font-medium text-text-primary truncate">
              {setupOpen
                ? areaActive ? "Area & setup" : "City & setup"
                : areaActive && area
                ? `Area · ${area.label || headerTitle} · ${formatKm2(area.areaKm2)}`
                : city.trim() ? headerTitle : "City & setup"}
            </span>
            <span className="flex items-center gap-1 text-xs text-text-secondary shrink-0">
              {setupOpen ? "Hide" : "Show"}
              <ChevronDown size={15} className={`transition-transform ${setupOpen ? "" : "-rotate-90"}`} />
            </span>
          </button>
          {setupOpen && (
          <div className="space-y-2.5 px-3 pb-3">
          <div className="flex rounded-lg border border-border overflow-hidden text-xs w-full sm:w-fit" role="tablist" aria-label="How to choose the place">
            {([
              ["city", "By city name", <Building2 key="c" size={13} />],
              ["area", "Draw an area", <MapIcon key="a" size={13} />],
            ] as const).map(([m, label, icon]) => (
              <button key={m} role="tab" aria-selected={setupMode === m} disabled={running}
                onClick={() => setSetupMode(m)}
                className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 disabled:opacity-60 ${setupMode === m ? "bg-accent-500/15 text-text-primary font-medium" : "bg-surface-overlay text-text-secondary hover:text-text-primary"}`}>
                {icon}{label}
              </button>
            ))}
          </div>
          {areaActive && (
            <AreaPicker
              key={pickerKey}
              area={area}
              onAreaChange={setArea}
              onPlaceResolved={onPlaceResolved}
              onPlaceNotFound={(q) => setPlaceError(`No place called "${q}" could be found. Check the spelling and try again.`)}
              onClearPlace={() => { setCity(""); setCountry(""); setCountryCode(""); setRegion(""); }}
              disabled={running}
              initialQuery={[city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ")}
            />
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-text-secondary">{areaActive ? "City the area is in" : "City"}</label>
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="e.g. Toronto"
                onBlur={commitPlace} onKeyDown={(e) => { if (e.key === "Enter") commitPlace(); }}
                className="w-full mt-0.5 px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm" />
            </div>
            <div>
              <label htmlFor="assistant-country" className="text-[11px] text-text-secondary">Country</label>
              <select id="assistant-country" value={countryCode || (country ? "__other" : "")}
                onChange={(e) => { if (e.target.value !== "__other") selectCountry(e.target.value); }}
                className={`w-full mt-0.5 px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-sm ${countryCode || country ? "text-text-primary" : "text-text-secondary"}`}>
                <option value="">Select a country</option>
                {!countryCode && country && <option value="__other">{country}</option>}
                {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            {regionOptions.length > 0 && (
              <div className="sm:col-start-1">
                <label htmlFor="assistant-region" className="text-[11px] text-text-secondary">State or Province</label>
                <select id="assistant-region" value={regionCode || ""}
                  onChange={(e) => { setRegion(regionOptions.find((r) => r.code === e.target.value)?.name || ""); commitPlace(); }}
                  className={`w-full mt-0.5 px-2 py-1.5 rounded-lg bg-surface-overlay border border-border text-sm ${regionCode ? "text-text-primary" : "text-text-secondary"}`}>
                  <option value="">Select a state or province (optional)</option>
                  {regionOptions.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}
                </select>
              </div>
            )}
          </div>
          <textarea value={info} onChange={(e) => setInfo(e.target.value)} rows={2}
            placeholder={areaActive
              ? "Anything you already know about this area (optional): e.g. the riverside blocks flood most springs."
              : "Anything you already know (optional): e.g. we have a flood plan but no early-warning system."}
            className="w-full px-2.5 py-1.5 rounded-lg bg-surface-overlay border border-border text-text-primary text-sm resize-none" />
          {!areaActive && cityLooking && city.trim().length > 1 && (
            <p className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin" /> Finding the boundary of {city.trim()}…
            </p>
          )}
          {!areaActive && cityArea === null && (
            <p className="text-xs text-warn-400">
              Couldn&apos;t find {[city.trim(), region.trim(), country.trim()].filter(Boolean).join(", ")}. Check the spelling, country and state.
            </p>
          )}
          {areaFileName && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-overlay/40 px-3 py-2">
              <span className="flex items-center gap-2 min-w-0 text-sm">
                <FileArchive size={15} className="shrink-0 text-accent-400" />
                <span className="truncate font-medium text-text-primary" title={areaFileName}>{areaFileName}</span>
                <span className="hidden sm:inline text-xs text-text-secondary shrink-0">
                  {uploadedZip ? "Your uploaded file" : areaActive ? "Shapefile of the selected area" : activeArea?.approximate ? "Shapefile of the approximate city boundary" : "Shapefile of the city boundary"} · used by the AI
                </span>
              </span>
              {!uploadedZip && (
                <button onClick={downloadAreaFile}
                  title="Download this boundary as a zipped Shapefile (.shp, .shx, .dbf, .prj; WGS84)"
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-surface-overlay border border-border text-text-primary hover:border-primary-500/40">
                  <Download size={13} /> Download Shapefile
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void handleStartAutonomous()} disabled={!canStart || !providerReady || running || externalBusy || checkingPlace}
              title={areaActive && areaProblem ? areaProblem : undefined}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
              {checkingPlace ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              {checkingPlace ? "Checking the place…" : "Fill it out for me"}
            </button>
            <button onClick={requestClearEverything} disabled={running || checkingPlace}
              title={running ? "Stop the Assistant first" : "Reset the place, notes, scorecard and chat for this scorecard"}
              className="ml-auto flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-semibold border border-danger-500/40 bg-danger-500/10 text-danger-400 hover:bg-danger-500/15 disabled:opacity-50 disabled:cursor-not-allowed">
              <X size={16} /> Clear all Information
            </button>
          </div>
          {!providerReady && <p className="text-xs text-warn-400">Choose an AI helper and add its key in Settings first.</p>}
          {providerReady && selected.length > 1 && (
            <p className="text-xs text-text-secondary">
              {readyLanes.length === selected.length
                ? `${selected.map((p) => PROVIDER_LABEL[p]).join(", ")} will each fill their own copy, in parallel.`
                : `${readyLanes.map((p) => PROVIDER_LABEL[p]).join(", ")} will each fill their own copy. ${selected.filter((p) => !readyLanes.includes(p)).map((p) => PROVIDER_LABEL[p]).join(", ")} still need${selected.length - readyLanes.length === 1 ? "s" : ""} a key in Settings.`}
            </p>
          )}
          </div>
          )}
        </div>

        {/* The selected helper's chat (each lane draws itself in here) */}
        {laneTabs(false)}
        <div ref={setAssistantHost} className="flex-1 flex flex-col" />
        <input ref={docRef} type="file" multiple accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.log,.rtf,.html,.htm,.xml,.yaml,.yml,text/*,application/pdf" className="hidden"
          onChange={(e) => { if (e.target.files?.length) void onDocsPicked(e.target.files); e.currentTarget.value = ""; }} />
      </section>

      {/* ── Scorecard tab: the selected helper's copy ──────────────── */}
      <div className={`flex-col h-full max-w-5xl mx-auto ${view === "scorecard" ? "flex" : "hidden"}`}>
        {laneTabs(true)}
        <div ref={setScorecardHost} className="flex-1 min-h-0 flex flex-col" />
      </div>

      {/* One lane per helper. They render into the two slots above. */}
      {activeId && selected.map((p) => (
        <AgentLane
          key={`${activeId}:${p}`}
          ref={(h) => { laneRefs.current[p] = h; }}
          provider={p}
          settings={settings}
          visible={p === lane}
          view={view}
          assistantHost={assistantHost}
          scorecardHost={scorecardHost}
          initial={lanesDataRef.current[p] ?? emptyLane()}
          sessionId={activeId}
          shared={shared}
          getShared={getShared}
          externalBusy={busyProviders.includes(p)}
          uploadNote={uploadNote}
          onDismissUploadNote={() => setUploadNote(null)}
          onData={onData}
          onStatus={onStatus}
          onLoadIntoAnalyzer={onLoadIntoAnalyzer}
          onOpenView={onOpenView}
          onAttachClick={() => docRef.current?.click()}
          onRemoveAttachment={removeAttachment}
          onPickScorecard={onScorecardPicked}
          requestConfirm={requestConfirm}
          onOpenCosts={() => setCostsOpen(true)}
        />
      ))}

      <CostComparison open={costsOpen} onClose={() => setCostsOpen(false)} />

      <SessionMenu
        open={menuOpen}
        sessions={sessions}
        activeId={activeId}
        onSelect={(id) => { setMenuOpen(false); switchTo(id); }}
        onNew={() => { setMenuOpen(false); newChat(); }}
        onDelete={(id) => requestDeleteSession(id)}
        onClose={() => setMenuOpen(false)}
      />

      <ConfirmModal
        open={!!placeError}
        title="Place not found"
        onClose={() => setPlaceError(null)}
        actions={[{ label: "OK", variant: "primary", onClick: () => setPlaceError(null) }]}
      >
        <p className="text-sm text-text-secondary">{placeError}</p>
      </ConfirmModal>

      <ConfirmModal
        open={!!placeSwitch}
        title={placeSwitch ? `Save the scorecard for ${placeName(placeSwitch.from)}?` : ""}
        onClose={() => resolvePlaceSwitch("cancel")}
        actions={[
          { label: "Save scorecard", variant: "primary", onClick: () => resolvePlaceSwitch("save") },
          { label: "Don't save", variant: "danger", onClick: () => resolvePlaceSwitch("discard") },
          { label: "Cancel", variant: "ghost", onClick: () => resolvePlaceSwitch("cancel") },
        ]}
      >
        {placeSwitch && (() => {
          const from = placeSwitch.from.city.trim() || placeName(placeSwitch.from);
          const to = placeSwitch.to.city.trim() || placeName(placeSwitch.to);
          const n = placeSwitch.filled;
          return (
            <div className="space-y-2 text-sm text-text-secondary">
              <p>
                You changed the place to <span className="font-medium text-text-primary">{placeName(placeSwitch.to)}</span>.
                {" "}The scorecard for <span className="font-medium text-text-primary">{placeName(placeSwitch.from)}</span>{" "}
                {n >= TOTAL_INDICATORS ? `is finished (all ${TOTAL_INDICATORS} indicators answered).` : n > 0 ? `has ${n} of ${TOTAL_INDICATORS} indicators answered so far.` : "is still being filled (no answers yet)."}
                {running && " The helpers still filling it will be stopped."}
              </p>
              <p>
                <span className="font-medium text-text-primary">Save scorecard</span> keeps it, and it reloads whenever you come back to {from}.{" "}
                <span className="font-medium text-text-primary">Don&apos;t save</span> discards it, so {from} starts fresh next time.
                {" "}Either way, {placeSwitch.toSaved ? `you'll then be asked whether to reload your saved scorecard for ${to}.` : `${to} gets a new scorecard of its own.`}
              </p>
            </div>
          );
        })()}
      </ConfirmModal>

      <ConfirmModal
        open={!!reloadAsk}
        title={reloadAsk ? `Reload the scorecard from the last session for ${reloadAsk.place.city.trim() || placeName(reloadAsk.place)}?` : ""}
        onClose={() => resolveReload("dismiss")}
        actions={[
          { label: "Yes, reload it", variant: "primary", onClick: () => resolveReload("yes") },
          { label: "No, clear it", variant: "danger", onClick: () => resolveReload("no") },
        ]}
      >
        {reloadAsk && (() => {
          const sp = placeOfSession(reloadAsk.saved);
          const lanes = Object.values(lanesOf(reloadAsk.saved, selectedProviders(settings)[0]));
          const n = Math.max(0, ...lanes.map((l) => filledCount(l.draft || {})));
          const when = new Date(reloadAsk.saved.updatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
          return (
            <div className="space-y-2 text-sm text-text-secondary">
              <p>
                You have a saved scorecard for <span className="font-medium text-text-primary">{placeName(sp)}</span>{" "}
                ({n >= TOTAL_INDICATORS ? `finished, all ${TOTAL_INDICATORS} indicators answered` : `${n} of ${TOTAL_INDICATORS} indicators answered`}; last worked on {when}).
              </p>
              <p>
                <span className="font-medium text-text-primary">Yes</span> reloads its answers and chat.{" "}
                <span className="font-medium text-text-primary">No</span> deletes everything saved for {reloadAsk.place.city.trim() || "this city"} and starts fresh. That can&apos;t be undone.
              </p>
            </div>
          );
        })()}
      </ConfirmModal>

      <ConfirmModal
        open={!!confirm}
        title={confirm?.title || ""}
        onClose={() => setConfirm(null)}
        actions={confirm ? [
          { label: "Cancel", variant: "ghost", onClick: () => setConfirm(null) },
          { label: confirm.yes, variant: confirm.danger ? "danger" : "primary", onClick: confirm.onYes },
        ] : []}
      >
        <p className="text-sm text-text-secondary flex items-start gap-2">
          {confirm?.danger && <AlertTriangle size={16} className="text-danger-400 shrink-0 mt-0.5" />}
          {confirm?.body}
        </p>
      </ConfirmModal>
    </div>
  );
}
