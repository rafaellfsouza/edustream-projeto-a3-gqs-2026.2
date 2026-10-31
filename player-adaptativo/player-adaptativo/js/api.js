/**
 * Origem do backend FastAPI.
 *
 * Vem do config.js. O fallback mantém a página funcionando mesmo sem ele
 * (ex.: testes, ou alguém abrindo um HTML que esqueceu o <script>): quando o
 * player é servido pelo próprio backend (/player/), a API está na mesma
 * origem; senão, assume o uvicorn padrão em localhost:8000.
 */
import { tokenAtual } from "./auth.js";

const API_BASE_URL =
  window.PLAYER_CONFIG?.API_BASE_URL ||
  (window.location.pathname.startsWith("/player")
    ? window.location.origin
    : "http://localhost:8000");

export { API_BASE_URL };

/**
 * Erro de HTTP da API com o status anexado (`error.status`).
 *
 * O número importa para o player decidir o que dizer: 404 = vídeo não existe,
 * 503 = banco sem credenciais, 5xx = backend com problema. Sem ele, tudo
 * viraria a mesma mensagem genérica.
 *
 * `detail` traz a mensagem legível do backend quando o corpo da resposta é um
 * JSON com esse campo (ex.: "E-mail ou senha incorretos." no login) — o front
 * mostra isso em vez do texto genérico.
 */
export class ApiError extends Error {
  constructor(status, caminho) {
    super(`API respondeu com HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.caminho = caminho;
    this.detail = null;
  }
}

async function requestJson(path, options = {}) {
  // Sessão ativa → anexa o Bearer automaticamente (rotas de autenticação,
  // POST /watch e GET /recomendacoes/me usam; as demais ignoram o cabeçalho).
  const token = tokenAtual();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const erro = new ApiError(response.status, path);
    try {
      const corpo = await response.json();
      if (typeof corpo?.detail === "string") erro.detail = corpo.detail;
    } catch {
      // corpo não era JSON: mantém a mensagem genérica
    }
    throw erro;
  }

  return response.json();
}

export async function getVideoStatus(videoId) {
  return requestJson(`/status/${encodeURIComponent(videoId)}`);
}

/**
 * O que existe no disco para o vídeo (master.m3u8, thumbnail, segmentos).
 * O player usa isto para explicar POR QUE não deu play (mídia ausente x
 * ainda transcodificando) em vez de ficar repetindo a mesma tentativa.
 */
export async function getMedia(videoId) {
  return requestJson(`/media/${encodeURIComponent(videoId)}`);
}

export async function getRelatedVideos(videoId) {
  return requestJson(`/videos/${encodeURIComponent(videoId)}/relacionados`);
}

export async function getRecommendations(userId) {
  return requestJson(`/recomendacoes/${encodeURIComponent(userId)}`);
}

export async function getTrending() {
  return requestJson("/trending");
}

/**
 * Catálogo de vídeos concluídos.
 *
 * `somenteProntos` (padrão) pede ao backend só os vídeos cuja mídia HLS já
 * existe no disco (`/catalogo?prontos=1`) — é o que garante que TODO card da
 * home toca de verdade. Passe false para listar também o que ainda está sem
 * master.m3u8 (diagnóstico).
 */
export async function getCatalogo(termo = "", somenteProntos = true) {
  // Ordem dos parâmetros é estável (prontos antes de q) para a URL ser
  // reproduzível em log/teste — daí a concatenação manual em vez de
  // URLSearchParams (que escaparia o "&").
  const partes = [];
  if (somenteProntos) partes.push("prontos=1");
  if (termo) partes.push(`q=${encodeURIComponent(termo)}`);
  return requestJson(`/catalogo${partes.length ? `?${partes.join("&")}` : ""}`);
}

export async function getVideo(videoId) {
  return requestJson(`/catalogo/${encodeURIComponent(videoId)}`);
}

export async function registerWatch(payload) {
  return requestJson("/watch", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

/**
 * Envia um vídeo novo (multipart/form-data) para o POST /upload.
 *
 * Não passa pelo requestJson de propósito: ele fixaria Content-Type
 * application/json e quebraria o boundary do multipart — aqui o próprio
 * navegador define o cabeçalho certo a partir do FormData.
 */
export async function uploadVideo(formData) {
  const response = await fetch(`${API_BASE_URL}/upload`, {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    let detalhe = `API respondeu com HTTP ${response.status}`;
    try {
      const corpo = await response.json();
      if (corpo?.detail) detalhe = corpo.detail;
    } catch (error) {
      // corpo não era JSON: mantém a mensagem genérica
    }
    throw new Error(detalhe);
  }

  return response.json();
}

/**
 * Resolve uma URL de mídia vinda da API para uma URL utilizável no navegador.
 *
 * A API devolve URLs absolutas (http://host:8000/videos/...), mas se vier um
 * caminho relativo de raiz ("/videos/..."), ele precisa ser prefixado com a
 * origem do BACKEND — senão o navegador resolve contra a origem do front
 * (Live Server :5500, por exemplo) e o vídeo dá 404.
 * URLs relativas à página ("./videos/..."), absolutas e data:/blob: passam
 * intactas.
 */
export function resolveMediaUrl(url) {
  if (!url || typeof url !== "string") return url;
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  if (url.startsWith("/")) return `${API_BASE_URL}${url}`;
  return url;
}

// ---------------------------------------------------------------------------
// Autenticação — módulo app/auth do backend (contratos em app/auth/router.py)
// ---------------------------------------------------------------------------

/**
 * POST /auth/registrar — cria conta (tipoUsuario: "aluno" | "professor").
 * Devolve {usuario, token}: a chamada já deixa a sessão pronta para salvar.
 */
export async function registrarUsuario({ nome, email, senha, tipoUsuario = "aluno" }) {
  return requestJson("/auth/registrar", {
    method: "POST",
    body: JSON.stringify({
      nome,
      email,
      senha,
      tipo_usuario: tipoUsuario,
    }),
  });
}

/** POST /auth/login — devolve {usuario, token}. */
export async function fazerLogin({ email, senha }) {
  return requestJson("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, senha }),
  });
}

/** GET /auth/me — valida o token da sessão e devolve {usuario}. */
export async function obterPerfil() {
  return requestJson("/auth/me");
}

/** GET /auth/usuarios — área do professor (o backend barra alunos com 403). */
export async function listarUsuarios() {
  return requestJson("/auth/usuarios");
}
