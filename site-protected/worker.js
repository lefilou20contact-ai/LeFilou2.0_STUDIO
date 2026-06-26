/**
 * Worker de garde — LeFilou2.0 Studio
 * ------------------------------------------------------------
 * Rôle : empêcher les bots/scrapers de voir le contenu du site
 * tant qu'ils n'ont pas passé la vérification Cloudflare Turnstile.
 *
 * Fonctionnement :
 * 1. Chaque requête entrante est interceptée.
 * 2. Si un cookie de session valide existe -> on sert le vrai site
 *    (dossier /protected, exposé en assets statiques).
 * 3. Sinon -> on sert la page de vérification (/public/verify.html).
 * 4. La page de vérification appelle POST /api/verify-turnstile avec
 *    le token Turnstile ; ce Worker le valide auprès de l'API
 *    Cloudflare siteverify, et si OK, pose un cookie signé (HMAC)
 *    avec une durée de vie limitée.
 *
 * Pourquoi côté serveur et pas juste en JS ?
 * Parce qu'un scraper qui ignore le JavaScript (ce que font la
 * plupart des bots/scrapers simples) ne déclencherait jamais la
 * vérification client. En interceptant TOUTES les requêtes ici,
 * y compris celles qui n'exécutent pas de JS, le contenu réel
 * n'est jamais transmis sans cookie de session valide.
 */

const SESSION_COOKIE_NAME = "lf2_verified";
const SESSION_DURATION_SECONDS = 60 * 60 * 12; // 12h, ajustable

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- Route API : validation du token Turnstile ---
    if (url.pathname === "/api/verify-turnstile" && request.method === "POST") {
      return handleVerify(request, env);
    }

    // --- Toutes les autres requêtes : vérifier le cookie de session ---
    const cookie = request.headers.get("Cookie") || "";
    const sessionValue = getCookieValue(cookie, SESSION_COOKIE_NAME);
    const isVerified = await isValidSession(sessionValue, env);

    if (isVerified) {
      // Session valide -> on sert le vrai site (fichiers dans /protected)
      return serveProtectedAsset(request, env, url);
    }

    // Pas de session valide -> on sert uniquement la page de garde,
    // quelle que soit l'URL demandée (sauf assets nécessaires à cette page).
    if (url.pathname === "/verify.html" || url.pathname === "/") {
      return env.ASSETS.fetch(new Request(new URL("/verify.html", request.url), request));
    }

    // Pour toute autre route demandée sans session, on redirige vers la
    // page de vérification plutôt que de laisser fuiter du contenu.
    return Response.redirect(new URL("/", request.url), 302);
  },
};

/**
 * Sert un fichier du vrai site une fois la session validée.
 * Les fichiers du site réel doivent être déployés sous /protected/
 * dans la config d'assets (voir wrangler.jsonc).
 */
async function serveProtectedAsset(request, env, url) {
  let targetPath = url.pathname === "/" ? "/protected/index.html" : `/protected${url.pathname}`;
  const assetUrl = new URL(targetPath, request.url);
  const assetReq = new Request(assetUrl, request);
  const response = await env.ASSETS.fetch(assetReq);

  if (response.status === 404) {
    // Fallback : si le fichier n'existe pas, retombe sur index.html
    const fallback = new Request(new URL("/protected/index.html", request.url), request);
    return env.ASSETS.fetch(fallback);
  }
  return response;
}

/**
 * Vérifie le token Turnstile envoyé par le client auprès de l'API
 * Cloudflare siteverify, et pose un cookie de session signé si OK.
 */
async function handleVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ success: false, error: "invalid_body" }, 400);
  }

  const token = body.token;
  if (!token) {
    return jsonResponse({ success: false, error: "missing_token" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY, // défini comme secret Worker, jamais en dur
      response: token,
      remoteip: ip,
    }),
  });

  const verifyData = await verifyRes.json();

  if (!verifyData.success) {
    return jsonResponse({ success: false, error: "turnstile_failed", details: verifyData["error-codes"] }, 403);
  }

  // Token valide -> on génère un cookie de session signé.
  const sessionValue = await createSignedSession(env);

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${sessionValue}; Max-Age=${SESSION_DURATION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );

  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}

/**
 * Crée une valeur de session signée : "timestamp.signature"
 * La signature est un HMAC-SHA256 du timestamp avec un secret connu
 * uniquement du Worker, donc impossible à forger côté client.
 */
async function createSignedSession(env) {
  const issuedAt = Date.now().toString();
  const signature = await hmacSign(issuedAt, env.SESSION_SECRET);
  return `${issuedAt}.${signature}`;
}

/**
 * Valide une valeur de cookie de session : vérifie la signature ET
 * que la session n'a pas dépassé sa durée de vie.
 */
async function isValidSession(sessionValue, env) {
  if (!sessionValue) return false;
  const parts = sessionValue.split(".");
  if (parts.length !== 2) return false;

  const [issuedAt, signature] = parts;
  const expectedSignature = await hmacSign(issuedAt, env.SESSION_SECRET);
  if (signature !== expectedSignature) return false;

  const age = Date.now() - Number(issuedAt);
  if (Number.isNaN(age) || age < 0) return false;
  if (age > SESSION_DURATION_SECONDS * 1000) return false;

  return true;
}

async function hmacSign(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookieValue(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
