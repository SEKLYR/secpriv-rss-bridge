/**
 * legifrance-jorf.ts — Veille Journal officiel (fonds JORF de Légifrance) pour la sécurité privée.
 *
 * Recherche les derniers textes liés aux activités privées de sécurité (livre VI du code de la
 * sécurité intérieure, CNAPS — Conseil national des activités privées de sécurité), récupère leur
 * contenu intégral, les filtre, les résume avec Gemini (file d'attente compatible plan gratuit)
 * et publie le tout dans un flux RSS.
 *
 * Fichiers produits : legifrance-jorf.cache.json, legifrance-jorf.ignored.json, legifrance-jorf.feed.xml
 *
 * Author: @chteau
 * Date: 3/09/2026
 */
// Dépendances externes
import { Feed } from "https://esm.sh/feed@6.0.0";
import { GoogleGenAI } from "npm:@google/genai@2.20.0";


// Env
const LEGIFRANCE_CLIENT_ID = Deno.env.get("LEGIFRANCE_CLIENT_ID");
const LEGIFRANCE_CLIENT_SECRET = Deno.env.get("LEGIFRANCE_CLIENT_SECRET");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");

// Gemini se désactive avec `--no-gemini` ou GEMINI_ENABLED=false (tests, scrape initial sans consommer de quota).
const GEMINI_ENABLED = !Deno.args.includes("--no-gemini") && Deno.env.get("GEMINI_ENABLED") !== "false";

if (!LEGIFRANCE_CLIENT_ID || !LEGIFRANCE_CLIENT_SECRET || (GEMINI_ENABLED && !GEMINI_API_KEY)) {
  console.error(`Erreur: certains secrets sont manquant. Bien vérifier les variables d'environnement.`)
  Deno.exit(1);
}


// Globals
const LEGIFRANCE_API_BASE = "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app"; // Base de l'API sur PISTE : /dila/legifrance/lf-engine-app/ (sandbox : sandbox-api.piste.gouv.fr)
const SEARCH_PAGE_SIZE = 30;
const SEARCH_SINCE_DAYS = 365; // Fenêtre glissante : on ne remonte pas plus loin qu'un an
const MAX_TEXTS = 15;
const CACHE_FILE = "./legifrance-jorf.cache.json";
const IGNORED_FILE = "./legifrance-jorf.ignored.json"; // Identifiants écartés comme hors périmètre : jamais reconsultés

// Flux RSS
const FEED_FILE = "./legifrance-jorf.feed.xml";
const FEED_MAX_ITEMS = 50;
const FEED_TITLE = "Veille sécurité privée – Journal officiel";
const FEED_DESCRIPTION = "Lois, décrets et arrêtés publiés au JO concernant les activités privées de sécurité (livre VI du code de la sécurité intérieure, CNAPS).";
const FEED_LINK = Deno.env.get("FEED_LINK") ?? "https://www.legifrance.gouv.fr/";
const FEED_URL = Deno.env.get("FEED_URL"); // URL publique du flux (optionnel, pour le lien "self")

// Gemini (plan gratuit). Les quotas exacts par modèle sont visibles dans AI Studio > Rate limit.
// Chaîne de modèles, essayés dans l'ordre : un modèle retiré (404) ou à quota épuisé (429) passe la main
// au suivant. Le lite répond sans jetons de « réflexion », les modèles 3.x flash en dépensent avant chaque
// réponse, ce qui pèse sur le quota de jetons/minute. GEMINI_MODEL (un seul) ou GEMINI_MODELS (liste, virgules).
const GEMINI_MODELS = (Deno.env.get("GEMINI_MODEL") ?? Deno.env.get("GEMINI_MODELS") ?? "gemini-3.5-flash-lite,gemini-3.6-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
// Free tier Gemini 3.x Flash (AI Studio) : 10 req/min, 250 000 jetons/min, 1 500 req/jour.
const GEMINI_RPM = Number(Deno.env.get("GEMINI_RPM") ?? 10); // requêtes / minute
const GEMINI_TPM = Number(Deno.env.get("GEMINI_TPM") ?? 250_000); // jetons / minute
const GEMINI_TPM_BUDGET = Math.floor(GEMINI_TPM * 0.85); // marge : on ne vise que 85 % du plafond
const GEMINI_DELAY_MS = Math.ceil(60_000 / GEMINI_RPM) + 500; // marge de 0,5 s sous le plafond
const GEMINI_MAX_PER_RUN = Number(Deno.env.get("GEMINI_MAX_PER_RUN") ?? 100); // le reste attend le prochain passage
const GEMINI_MAX_INPUT_CHARS = 120_000; // ~40 k jetons max par requête, le budget/minute fait le reste
const GEMINI_CHARS_PER_TOKEN = 3; // estimation prudente pour du français juridique (réel ≈ 3,5 à 4)
const GEMINI_QUOTA_WAIT_MS = 65_000; // attente après un 429 avant une unique nouvelle tentative

const CSI_ARTICLE_REF = /\b[LRD]\.\s?6\d{2}-\d+\b/;
const CSI_MENTION = /code de la sécurité intérieure/i;

// Seuils de pertinence (calibrés sur un an de JO) : un texte est retenu si son titre matche,
// s'il cite au moins CSI_MIN_REFS articles du livre VI, ou si les motifs sont assez présents
// ET assez denses dans le corps. La densité écarte les textes-fleuves qui ne citent
// « agent de sécurité » que comme intitulé de métier (ex. grilles d'apprentissage, 270 k caractères).
const CSI_MIN_REFS = 3;
const RELEVANCE_MIN_HITS = 10;
const RELEVANCE_MIN_DENSITY = 1; // occurrences pour 10 000 caractères

const SEARCH_TERMS = [ // Termes recherchés (expression exacte, reliés par OU).
  "sécurité privée",
  "activités privées de sécurité",
  "Conseil national des activités privées de sécurité",
  "CNAPS",
  "livre VI du code de la sécurité intérieure",
];

const EXCLUDED_TITLE_PATTERNS: RegExp[] = [ // Textes administratifs du CNAPS sans intérêt pour les agents
  /portant nomination/i,
  /budget primitif/i,
  /agent comptable/i,
  /contrôle financier/i,
  /intérim des fonctions/i,
];

const RELEVANCE_PATTERNS: RegExp[] = [ // Filtre de pertinence appliqué au texte intégral (titre + visas + articles).
  /sécurité privée/i,
  /activités? privées? de sécurité/i,
  /\bCNAPS\b/,
  /Conseil national des activités privées de sécurité/i,
  /livre VI du code de la sécurité intérieure/i,
  /surveillance et (de )?gardiennage/i,
  /transport de fonds/i,
  /protection physique des personnes/i,
  /agents? cynophiles?/i,
  /agents? de (sécurité|sûreté)/i,
];

const AI_SUMMARY = GEMINI_ENABLED ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null;

// Types
type CacheEntry = {
  cid: string;
  title: string;
  nature?: string;
  nor?: string;
  datePublication?: string;
  url: string;
  content: string; // Texte brut : visas + articles + signataires
  cachedAt: string; // ISO 8601, date de mise en cache
  summary?: string; // Résumé Gemini (absent = en file d'attente)
  summarizedAt?: string; // ISO 8601, date du résumé
  summaryModel?: string; // Modèle ayant produit le résumé
};
type Cache = Record<string, CacheEntry>;
type SearchResult = {
  datePublication?: string | number;
  nature?: string;
  nor?: string;
  titles?: { title?: string; id?: string; cid?: string }[];
};
type JorfArticle = { num?: string; content?: string; etat?: string };
type JorfSection = { title?: string; articles?: JorfArticle[]; sections?: JorfSection[] };
type JorfText = {
  id?: string;
  cid?: string;
  title?: string;
  nor?: string;
  nature?: string;
  dateParution?: string | number;
  signers?: string;
  visa?: string;
  notice?: string;
  articles?: JorfArticle[];
  sections?: JorfSection[];
};


// Fonctions
/**
 * Récupère un jeton d'authentification depuis l'API OAuth2 de Légifrance (PISTE).
 * @returns {Promise<string>} - Le jeton d'authentification.
 */
async function getLegifranceToken(): Promise<string> {
  const res = await fetch("https://oauth.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: LEGIFRANCE_CLIENT_ID!,
      client_secret: LEGIFRANCE_CLIENT_SECRET!,
      scope: "openid",
    }),
  });

  if (!res.ok) throw new Error(`Erreur Auth PISTE (${res.status}): ${await res.text()}`);

  const data = await res.json();
  return data.access_token;
}

/**
 * Compte les occurrences d'un motif dans un texte.
 */
function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  return text.match(new RegExp(re.source, flags))?.length ?? 0;
}

/**
 * Vérifie si le texte est pertinent pour les agents de sécurité privée.
 *
 * @param {string} title - Le titre du texte (exclusions, puis motifs forts).
 * @param {string} body - Le corps du texte (visas + articles + signataires).
 * @returns {boolean} - `true` si le texte est pertinent, `false` sinon.
 */
function isRelevant(title: string, body: string): boolean {
  if (EXCLUDED_TITLE_PATTERNS.some((re) => re.test(title))) return false;
  if (RELEVANCE_PATTERNS.some((re) => re.test(title))) return true;

  // Références aux articles L./R./D. 6xx-x, uniquement si le code de la sécurité intérieure est cité
  if (CSI_MENTION.test(body) && countMatches(body, CSI_ARTICLE_REF) >= CSI_MIN_REFS) return true;

  const hits = RELEVANCE_PATTERNS.reduce((n, re) => n + countMatches(body, re), 0);
  const density = (hits * 10_000) / Math.max(body.length, 1);
  return hits >= RELEVANCE_MIN_HITS && density >= RELEVANCE_MIN_DENSITY;
}

/**
 * Recherche dans l'API Legifrance.
 *
 * @param {string} token - Le token d'authentification.
 * @returns {Promise<SearchResult[]>} - Les résultats de la recherche.
 */
async function searchLegifrance(token: string): Promise<SearchResult[]> {
  const since = new Date(Date.now() - SEARCH_SINCE_DAYS * 86_400_000);
  const res = await fetch(`${LEGIFRANCE_API_BASE}/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fond: "JORF",
      recherche: {
        champs: [
          {
            typeChamp: "ALL",
            operateur: "OU",
            criteres: SEARCH_TERMS.map((valeur) => ({
              typeRecherche: "EXACTE",
              valeur,
              operateur: "OU",
            })),
          },
        ],
        filtres: [{ facette: "DATE_PUBLICATION", dates: { start: isoDate(since), end: isoDate(new Date()) } }],
        pageNumber: 1,
        pageSize: SEARCH_PAGE_SIZE,
        operateur: "ET",
        sort: "PUBLICATION_DATE_DESC", // "DATE_DESC" est accepté mais ignoré par le fonds JORF
        typePagination: "DEFAUT",
      },
    }),
  });

  if (!res.ok) throw new Error(`Erreur Recherche Légifrance (${res.status}): ${await res.text()}`);

  const data = await res.json();
  return data.results || [];
}

/**
 * Consultation d'un texte JORF (contenu intégral des articles)
 *
 * @param {string} token - Jeton d'authentification
 * @param {string} textCid - Identifiant du texte JORF
 * @returns {Promise<JorfText} - Le texte JORF consulté
 */
async function consultJorf(token: string, textCid: string): Promise<JorfText> {
  const res = await fetch(`${LEGIFRANCE_API_BASE}/consult/jorf`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ textCid }),
  });

  if (!res.ok) throw new Error(`Erreur Consultation JORF ${textCid} (${res.status}): ${await res.text()}`);

  return await res.json();
}

/**
 * Collecte récursivement tous les articles d'un noeud JORF (texte ou section)
 *
 * @param {{ articles?: JorfArticle[]; sections?: JorfSection[] }} node - Le noeud JORF à collecter
 * @returns {JorfArticle[]} - La liste des articles collectés
 */
function collectArticles(node: { articles?: JorfArticle[]; sections?: JorfSection[] }): JorfArticle[] {
  const out: JorfArticle[] = [...(node.articles ?? [])];
  for (const section of node.sections ?? []) {
    out.push(...collectArticles(section));
  }

  return out;
}

/**
 * Convertit un HTML en texte brut lisible
 *
 * @param {string} html - Le HTML à convertir en texte
 * @returns {string} - Le texte converti
 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Date au format AAAA-MM-JJ (attendu par les filtres de l'API).
 */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Normalise une date de l'API (timestamp ms ou chaîne) en ISO 8601. `undefined` si absente ou invalide.
 */
function toIso(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Attend `ms` millisecondes.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Génère un résumé d'un texte en utilisant l'API Gemini. Lève une erreur en cas d'échec :
 * on ne stocke jamais le texte brut à la place d'un résumé, l'entrée reste en file d'attente.
 *
 * @param {CacheEntry} entry - Le texte à résumer
 * @param {string} model - Le modèle Gemini à utiliser
 * @returns {Promise<{ summary: string; tokens: number }>} - Le résumé et les jetons réellement consommés
 */
async function generateSummary(entry: CacheEntry, model: string): Promise<{ summary: string; tokens: number }> {
  if (!AI_SUMMARY) throw new Error("Gemini désactivé");

  const content = entry.content.length > GEMINI_MAX_INPUT_CHARS
    ? entry.content.slice(0, GEMINI_MAX_INPUT_CHARS) + "\n\n[texte tronqué]"
    : entry.content;

  const prompt = `Tu es un juriste spécialisé en sécurité privée. Résume ce texte publié au Journal officiel en 2 à 3 phrases simples et claires, à destination des agents de sécurité privée : ce qui change concrètement pour eux. Sois direct, pas d'introduction, pas de mise en forme.

Titre : ${entry.title}

Texte :
${content}`;

  const response = await AI_SUMMARY.models.generateContent({
    model,
    contents: prompt,
  });

  const summary = response.text?.trim();
  if (!summary) throw new Error("Réponse Gemini vide");
  const tokens = response.usageMetadata?.totalTokenCount ?? estimateTokens(prompt);
  return { summary, tokens };
}

/**
 * Estimation prudente du nombre de jetons d'un texte.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / GEMINI_CHARS_PER_TOKEN);
}

/**
 * Budget de jetons glissant sur 60 s : attend tant que la prochaine requête ferait dépasser le plafond.
 * Les consommations réelles (usageMetadata) sont enregistrées après chaque appel.
 */
const tokenLog: { at: number; tokens: number }[] = [];

function recordTokens(tokens: number): void {
  tokenLog.push({ at: Date.now(), tokens });
}

async function waitForTokenBudget(estimate: number): Promise<void> {
  while (true) {
    const cutoff = Date.now() - 60_000;
    while (tokenLog.length > 0 && tokenLog[0].at < cutoff) tokenLog.shift();
    const used = tokenLog.reduce((n, e) => n + e.tokens, 0);
    if (used + estimate <= GEMINI_TPM_BUDGET || tokenLog.length === 0) return;

    const waitMs = Math.max(tokenLog[0].at + 60_000 - Date.now(), 0) + 250;
    console.log(`  ⏳ Budget jetons/minute : ${used} utilisés + ~${estimate} > ${GEMINI_TPM_BUDGET}, attente ${Math.ceil(waitMs / 1000)} s...`);
    await sleep(waitMs);
  }
}

/**
 * Indique si une erreur Gemini correspond à un quota épuisé (HTTP 429).
 */
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

/**
 * Indique si une erreur Gemini correspond à un modèle indisponible (HTTP 404, modèle retiré ou inconnu).
 */
function isModelUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /404|NOT_FOUND|no longer available|not found/i.test(msg);
}

/**
 * File d'attente des résumés : traite les entrées sans résumé, une par une, en respectant la
 * cadence du plan gratuit. Le cache est sauvegardé après chaque résumé, un plantage ne fait
 * rien perdre et le prochain passage reprend là où on s'est arrêté.
 *
 * @param {Cache} data - Le cache
 * @returns {Promise<number>} - Nombre de résumés générés pendant ce passage
 */
async function summarizePending(data: Cache): Promise<number> {
  const pending = Object.values(data)
    .filter((e) => !e.summary)
    .sort((a, b) => (b.datePublication ?? "").localeCompare(a.datePublication ?? ""));

  if (pending.length === 0) {
    console.log("File d'attente Gemini : vide.");
    return 0;
  }

  const batch = pending.slice(0, GEMINI_MAX_PER_RUN);
  console.log(`File d'attente Gemini : ${pending.length} texte(s) en attente, ${batch.length} traité(s) ce passage (${GEMINI_MODELS.join(" > ")}, ${GEMINI_RPM} req/min, ${GEMINI_TPM} jetons/min).`);

  const models = [...GEMINI_MODELS]; // les modèles indisponibles ou à quota épuisé en sont retirés au fil de l'eau
  let quotaPaused = false;
  let done = 0;

  for (const [i, entry] of batch.entries()) {
    const label = `[${i + 1}/${batch.length}] ${entry.title}`;

    while (true) {
      if (models.length === 0) {
        console.log(`  ✗ ${label} — plus aucun modèle disponible, le reste de la file attendra le prochain passage.`);
        return done;
      }
      const model = models[0];

      try {
        await waitForTokenBudget(estimateTokens(entry.content.slice(0, GEMINI_MAX_INPUT_CHARS)) + 300);
        const { summary, tokens } = await generateSummary(entry, model);
        recordTokens(tokens);
        entry.summary = summary;
        entry.summarizedAt = new Date().toISOString();
        entry.summaryModel = model;
        await saveCache(data);
        done++;
        console.log(`  ✓ ${label} (${model}, ${tokens} jetons)`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        if (isModelUnavailableError(err)) {
          console.log(`  ⚠ Modèle ${model} indisponible, bascule sur le suivant.`);
          models.shift();
          continue;
        }
        if (isQuotaError(err)) {
          if (models.length > 1) {
            console.log(`  ⚠ Quota épuisé sur ${model}, bascule sur ${models[1]}.`);
            models.shift();
            continue;
          }
          if (!quotaPaused) {
            quotaPaused = true;
            console.log(`  ⏸ Quota Gemini atteint, pause de ${Math.round(GEMINI_QUOTA_WAIT_MS / 1000)} s avant nouvel essai...`);
            await sleep(GEMINI_QUOTA_WAIT_MS);
            continue;
          }
          console.log(`  ✗ ${label} — quota toujours épuisé, le reste de la file attendra le prochain passage.`);
          return done;
        }
        console.log(`  ✗ ${label} — ${msg} (nouvelle tentative au prochain passage)`);
        break;
      }
    }

    if (i < batch.length - 1) await sleep(GEMINI_DELAY_MS);
  }

  return done;
}

/**
 * Génère le flux RSS depuis le cache. Un texte entre dans le flux une fois résumé
 * (ou immédiatement, avec un extrait, quand Gemini est désactivé).
 *
 * @param {Cache} data - Le cache
 * @returns {Promise<number>} - Nombre d'entrées publiées dans le flux
 */
async function writeFeed(data: Cache): Promise<number> {
  const ready = Object.values(data)
    .filter((e) => e.summary || !GEMINI_ENABLED)
    .sort((a, b) => (b.datePublication ?? "").localeCompare(a.datePublication ?? ""))
    .slice(0, FEED_MAX_ITEMS);

  const feed = new Feed({
    title: FEED_TITLE,
    description: FEED_DESCRIPTION,
    id: FEED_LINK,
    link: FEED_LINK,
    language: "fr",
    copyright: "Textes : Légifrance / DILA (Licence Ouverte 2.0). Résumés : générés par IA, sans valeur juridique.",
    updated: new Date(),
    generator: "secpriv-rss-bridge",
    feedLinks: FEED_URL ? { rss: FEED_URL } : undefined,
  });

  for (const entry of ready) {
    const description = entry.summary ?? `${entry.content.slice(0, 600)}…`;
    feed.addItem({
      title: entry.title,
      id: entry.cid,
      link: entry.url,
      date: entry.datePublication ? new Date(entry.datePublication) : new Date(entry.cachedAt),
      description,
      content: `${description}\n\nTexte intégral : ${entry.url}`,
      category: entry.nature ? [{ name: entry.nature }] : undefined,
    });
  }

  await Deno.writeTextFile(FEED_FILE, feed.rss2());
  return ready.length;
}


// Main
let cache: Cache = {};
let ignored: Record<string, string> = {}; // cid -> titre, pour pouvoir auditer les exclusions

/**
 * Charge la liste des textes écartés. Absente ou illisible = liste vide.
 */
async function loadIgnored(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Deno.readTextFile(IGNORED_FILE));
  } catch {
    return {};
  }
}

/**
 * Persiste la liste des textes écartés (clés triées).
 */
async function saveIgnored(data: Record<string, string>): Promise<void> {
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  await Deno.writeTextFile(IGNORED_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

/**
 * Charge le cache local depuis le disque. Absent ou illisible = cache vide.
 */
async function loadCache(): Promise<Cache> {
  try {
    return JSON.parse(await Deno.readTextFile(CACHE_FILE));
  } catch {
    return {};
  }
}

/**
 * Persiste le cache sur le disque (JSON indenté, clés triées pour des diffs lisibles).
 */
async function saveCache(data: Cache): Promise<void> {
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  await Deno.writeTextFile(CACHE_FILE, JSON.stringify(sorted, null, 2) + "\n");
}

async function run() {
  // 0 - Cache local
  cache = await loadCache();
  ignored = await loadIgnored();
  console.log(`Cache chargé : ${Object.keys(cache).length} texte(s), ${Object.keys(ignored).length} écarté(s) mémorisé(s).${GEMINI_ENABLED ? "" : " Gemini désactivé pour ce passage."}`);

  // 1 - Jeton Légifrance
  const token = await getLegifranceToken();

  // 2 - Recherche des derniers textes
  const results = await searchLegifrance(token);

  // 3 - Filtrage et mise en cache
  let kept = 0;
  let added = 0;
  let alreadyCached = 0;
  let skipped = 0;
  let consulted = 0;

  for (const result of results) {
    if (kept >= MAX_TEXTS) break;

    const title = result.titles?.[0];
    const textCid: string | undefined = title?.cid ?? title?.id;
    if (!textCid) continue;

    // Déjà en cache ou déjà écarté : pas de consultation inutile
    if (cache[textCid]) {
      kept++;
      alreadyCached++;
      continue;
    }
    if (ignored[textCid]) {
      skipped++;
      continue;
    }

    const text = await consultJorf(token, textCid);
    consulted++;
    const articles = collectArticles(text);
    const displayTitle = text.title ?? (title?.title ? htmlToText(title.title) : textCid);

    const body = [
      text.visa ?? "",
      text.notice ?? "",
      ...articles.map((a) => (a.content ? `Article ${a.num ?? ""}\n${a.content}` : "")),
      text.signers ?? "",
    ].filter(Boolean).map(htmlToText).join("\n\n");

    if (!isRelevant(displayTitle, body)) {
      skipped++;
      ignored[textCid] = displayTitle;
      continue;
    }
    kept++;
    added++;
    console.log(`  + ${displayTitle}`);

    cache[textCid] = {
      cid: textCid,
      title: displayTitle,
      nature: text.nature,
      nor: text.nor,
      datePublication: toIso(text.dateParution) ?? toIso(result.datePublication),
      url: `https://www.legifrance.gouv.fr/jorf/id/${textCid}`,
      content: body,
      cachedAt: new Date().toISOString(),
    };
  }

  await saveCache(cache);
  await saveIgnored(ignored);
  console.log(`Nouveaux textes depuis le dernier passage : ${added} (${consulted} consultation(s) API, ${alreadyCached} déjà en cache, ${skipped} hors périmètre).`);

  // 4 - Résumés IA (file d'attente, reprise automatique au passage suivant)
  const summarized = GEMINI_ENABLED ? await summarizePending(cache) : 0;

  // 5 - Flux RSS
  const published = await writeFeed(cache);

  console.log(`Terminé : ${added} ajouté(s) au cache, ${summarized} résumé(s) généré(s), ${published} entrée(s) dans ${FEED_FILE}.`);
}

run().catch((err) => {
  console.error("Erreur d'exécution :", err);
  Deno.exit(1);
});
